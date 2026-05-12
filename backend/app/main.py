import asyncio
import json
import math
import random
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .models import SimulationRequest, SimulationStatus, SimulationMetrics
from .registry import load_registry, get_model_by_id

try:
    import cityflow
except ImportError:
    cityflow = None

try:
    from traffic_rl.agents.factory import build_agent
    from traffic_rl.config import AppConfig, EnvironmentConfig, TrainingConfig
    from traffic_rl.envs.cityflow_env import CityFlowTrafficEnv
except ImportError:
    build_agent = None
    AppConfig = None
    EnvironmentConfig = None
    TrainingConfig = None
    CityFlowTrafficEnv = None

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # app/main.py -> app -> backend -> traffic-deploy-sim
DATA_DIR = PROJECT_ROOT / "data"
GENERATED_DIR = DATA_DIR / "generated"

app = FastAPI(title="Traffic Deploy Sim")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, job_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.setdefault(job_id, []).append(websocket)

    def disconnect(self, job_id: str, websocket: WebSocket) -> None:
        if job_id not in self._connections:
            return
        self._connections[job_id] = [ws for ws in self._connections[job_id] if ws != websocket]
        if not self._connections[job_id]:
            del self._connections[job_id]

    async def broadcast(self, job_id: str, message: dict) -> None:
        if job_id not in self._connections:
            return
        stale = []
        for ws in self._connections[job_id]:
            try:
                await ws.send_json(message)
            except WebSocketDisconnect:
                stale.append(ws)
        for ws in stale:
            self.disconnect(job_id, ws)


manager = ConnectionManager()

jobs: Dict[str, dict] = {}


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _resolve_roadnet(path_value: str) -> Path:
    candidate = Path(path_value)
    if candidate.is_absolute():
        return candidate
    return DATA_DIR / path_value


def _load_roadnet(path_value: str) -> dict:
    path = _resolve_roadnet(path_value)
    return json.loads(path.read_text())


def _write_engine_config(job_id: str, config: dict) -> Path:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    path = GENERATED_DIR / f"engine_{job_id}.json"
    path.write_text(json.dumps(config, indent=2))
    return path


def _build_engine_config(job_id: str, request: SimulationRequest, flow_path: Path) -> dict:
    roadnet_path = _resolve_roadnet(request.roadnet_id)

    return {
        "interval": 1.0,
        "seed": request.seed or 0,
        "dir": "",
        "roadnetFile": str(roadnet_path.resolve()),
        "flowFile": str(flow_path.resolve()),
        "rlTrafficLight": request.controller.type in ("rl", "random"),
        "saveReplay": False,
    }


def _ingress_edges(roadnet: dict, target_intersection_id: str | None = None) -> List[str]:
    intersections = {i["id"]: i for i in roadnet.get("intersections", [])}
    virtual_ids = {i_id for i_id, i in intersections.items() if i.get("virtual")}
    edges = []
    for road in roadnet.get("roads", []):
        if road.get("startIntersection") in virtual_ids and road.get("endIntersection") not in virtual_ids:
            if target_intersection_id and road.get("endIntersection") != target_intersection_id:
                continue
            edges.append(road["id"])
    return edges


def _signal_intersections(roadnet: dict) -> List[dict]:
    intersections = []
    for inter in roadnet.get("intersections", []):
        if inter.get("virtual"):
            continue
        if not inter.get("trafficLight"):
            continue
        intersections.append(inter)
    return intersections


def _pick_intersection(roadnet: dict) -> dict | None:
    intersections = _signal_intersections(roadnet)
    return intersections[0] if intersections else None


def _incoming_lane_count(roadnet: dict, intersection_id: str) -> int:
    lanes = 0
    for road in roadnet.get("roads", []):
        if road.get("endIntersection") == intersection_id:
            lanes += len(road.get("lanes", []))
    return max(1, lanes)


def _phase_count(intersection: dict | None) -> int:
    if not intersection:
        return 1
    phases = intersection.get("trafficLight", {}).get("lightphases", [])
    return max(1, len(phases))


def _other_signal_intersections(roadnet: dict, controlled_intersection_id: str) -> List[dict]:
    return [
        inter
        for inter in _signal_intersections(roadnet)
        if inter.get("id") != controlled_intersection_id
    ]


def _road_index(roadnet: dict) -> Dict[str, dict]:
    roads = {}
    for road in roadnet.get("roads", []):
        points = road.get("points", [])
        segments = []
        total = 0.0
        for idx in range(len(points) - 1):
            dx = points[idx + 1]["x"] - points[idx]["x"]
            dy = points[idx + 1]["y"] - points[idx]["y"]
            seg_len = math.hypot(dx, dy)
            segments.append(seg_len)
            total += seg_len
        roads[road["id"]] = {"points": points, "segments": segments, "length": total}
    return roads


def _road_position(road_data: dict, distance: float) -> tuple[float, float]:
    points = road_data.get("points", [])
    segments = road_data.get("segments", [])
    if not points:
        return 0.0, 0.0
    remaining = max(0.0, distance)
    for idx, seg_len in enumerate(segments):
        if seg_len <= 0:
            continue
        if remaining <= seg_len:
            start = points[idx]
            end = points[idx + 1]
            ratio = remaining / seg_len
            x = start["x"] + (end["x"] - start["x"]) * ratio
            y = start["y"] + (end["y"] - start["y"]) * ratio
            return x, y
        remaining -= seg_len
    return points[-1]["x"], points[-1]["y"]


def _polyline_index(points: List[dict]) -> dict:
    segments: List[float] = []
    total = 0.0
    for idx in range(len(points) - 1):
        dx = points[idx + 1]["x"] - points[idx]["x"]
        dy = points[idx + 1]["y"] - points[idx]["y"]
        seg_len = math.hypot(dx, dy)
        segments.append(seg_len)
        total += seg_len
    return {"points": points, "segments": segments, "length": total}


def _drivable_index(roadnet: dict) -> Dict[str, dict]:
    """Build geometry lookup for lane drivable IDs and lane-link drivable IDs."""
    index: Dict[str, dict] = {}

    # Road lane drivable IDs: <road_id>_<lane_idx>
    for road in roadnet.get("roads", []):
        road_points = road.get("points", [])
        if len(road_points) < 2:
            continue
        lane_count = len(road.get("lanes", []))
        for lane_idx in range(lane_count):
            drivable_id = f"{road['id']}_{lane_idx}"
            index[drivable_id] = {
                "kind": "lane",
                "road": road["id"],
                **_polyline_index(road_points),
            }

    # Lane-link drivable IDs: <startRoad>_<startLane>_TO_<endRoad>_<endLane>
    for intersection in roadnet.get("intersections", []):
        for road_link in intersection.get("roadLinks", []):
            start_road = road_link.get("startRoad")
            end_road = road_link.get("endRoad")
            for lane_link in road_link.get("laneLinks", []):
                s_lane = lane_link.get("startLaneIndex")
                e_lane = lane_link.get("endLaneIndex")
                points = lane_link.get("points", [])
                if (
                    start_road is None
                    or end_road is None
                    or s_lane is None
                    or e_lane is None
                    or len(points) < 2
                ):
                    continue
                drivable_id = f"{start_road}_{s_lane}_TO_{end_road}_{e_lane}"
                index[drivable_id] = {
                    "kind": "lane_link",
                    "road": None,
                    **_polyline_index(points),
                }

    return index


def _drivable_position(drivable_data: dict, distance: float) -> tuple[float, float]:
    return _road_position(drivable_data, distance)


def _duration_steps_to_seconds(duration_steps: int, decision_interval: int = 5) -> int:
    """Convert UI duration (decision steps) to CityFlow simulation seconds."""
    return max(1, int(duration_steps)) * max(1, int(decision_interval))


def _build_rl_config(
    request: SimulationRequest,
    intersection_id: str,
    num_lanes: int,
    num_phases: int,
    engine_config_path: Path,
    agent_type: str,
) -> Any:
    decision_interval = 5
    env_cfg = EnvironmentConfig(
        backend="cityflow",
        intersection_id=intersection_id,
        num_lanes=num_lanes,
        num_phases=num_phases,
        min_green_time=5,
        decision_interval=decision_interval,
        episode_horizon_seconds=_duration_steps_to_seconds(request.duration_s, decision_interval),
        cityflow_config_path=str(engine_config_path),
        cityflow_thread_num=1,
    )
    training_cfg = TrainingConfig(
        agent_type=agent_type,
        gamma=request.gamma,
        learning_rate=request.learning_rate,
        epsilon_start=request.epsilon_start,
        epsilon_end=request.epsilon_end,
        epsilon_decay=request.epsilon_decay,
        batch_size=request.batch_size,
        hidden_dim=request.hidden_dim,
        replay_capacity=request.replay_capacity,
        learning_starts=request.learning_starts,
        target_update_interval=request.target_update_interval,
        train_frequency=request.train_frequency,
    )
    return AppConfig(
        seed=request.seed or 7,
        output_dir=str(PROJECT_ROOT / "outputs"),
        env=env_cfg,
        training=training_cfg,
    )


def _exit_roads(roadnet: dict) -> Dict[str, List[str]]:
    """For each ingress road, find the roads it can exit through the intersection.

    CityFlow routes need at least [ingress_road, exit_road] to be valid.
    An ingress road ends at intersection X; we collect all roads that START
    at X (excluding the reverse of the ingress road) as candidate exits.
    """
    exits: Dict[str, List[str]] = {}
    for road in roadnet.get("roads", []):
        end_intersection = road.get("endIntersection", "")
        road_id = road["id"]
        candidates = [
            r["id"]
            for r in roadnet.get("roads", [])
            if r.get("startIntersection") == end_intersection and r["id"] != road_id
        ]
        if candidates:
            exits[road_id] = candidates
    return exits


def _flow_from_demand(request: SimulationRequest, roadnet: dict) -> List[dict]:
    vehicle = {
        "length": 5.0,
        "width": 2.0,
        "maxPosAcc": 2.0,
        "maxNegAcc": 4.5,
        "usualPosAcc": 2.0,
        "usualNegAcc": 4.5,
        "minGap": 2.5,
        "maxSpeed": 16.67,
        "headwayTime": 1.5,
    }
    roads_by_id = {r["id"]: r for r in roadnet.get("roads", [])}
    intersections = {i["id"]: i for i in roadnet.get("intersections", [])}

    # Build legal transitions from roadLinks only (startRoad -> endRoad).
    # This guarantees route segments can actually be traversed in CityFlow.
    next_roads: Dict[str, List[str]] = {}
    for inter in roadnet.get("intersections", []):
        for link in inter.get("roadLinks", []):
            start = link.get("startRoad")
            end = link.get("endRoad")
            if not start or not end:
                continue
            next_roads.setdefault(start, [])
            if end not in next_roads[start]:
                next_roads[start].append(end)

    def build_route(entry_road_id: str) -> List[str]:
        """Build a valid route from legal road-link transitions.

        For 1x2 roadnets this will usually be exactly 2 roads (ingress -> exit),
        which is correct because boundary intersections are virtual endpoints.
        """
        if entry_road_id not in roads_by_id:
            return []

        exits = next_roads.get(entry_road_id, [])
        if not exits:
            return [entry_road_id]

        # In single-intersection mode prefer exits that go directly to virtual boundaries
        # so traffic is centered around one controlled junction.
        virtual_exits = [
            r_id
            for r_id in exits
            if intersections.get(roads_by_id.get(r_id, {}).get("endIntersection", ""), {}).get("virtual", False)
        ]
        chosen_exit = rng.choice(virtual_exits or exits)
        route = [entry_road_id, chosen_exit]

        # Optional one extra legal hop if the exit road also has explicit legal links.
        # This is safe for larger roadnets and no-op for boundary exits.
        next_hops = next_roads.get(chosen_exit, [])
        if next_hops:
            route.append(rng.choice(next_hops))

        return route

    rng = random.Random(request.seed or 0)
    flows = []
    for entry in request.demand.entries:
        route = build_route(entry.edge)
        if len(route) < 2:
            continue  # Skip edges with no valid exit — CityFlow would reject them.
        interval = max(0.1, 60.0 / entry.rate)
        flows.append(
            {
                "vehicle": vehicle,
                "route": route,
                "interval": interval,
                "startTime": 0,
                "endTime": _duration_steps_to_seconds(request.duration_s),
            }
        )
    return flows


def _write_generated_flow(job_id: str, flows: List[dict]) -> Path:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    path = GENERATED_DIR / f"flow_{job_id}.json"
    path.write_text(json.dumps(flows, indent=2))
    return path


def _choose_phase_index(rng: random.Random, phases: int, controller: str, step: int, fixed_time_s: int) -> int:
    if phases <= 0:
        return 0
    if controller == "fixed_time":
        return (step // max(1, fixed_time_s)) % phases
    if controller == "random":
        return rng.randrange(phases)
    return (step // max(1, fixed_time_s)) % phases


async def _run_simulation(job_id: str, request: SimulationRequest) -> None:
    if cityflow is None or CityFlowTrafficEnv is None or AppConfig is None:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = (
            f"Missing runtime dependency: cityflow={cityflow is not None}, "
            f"CityFlowTrafficEnv={CityFlowTrafficEnv is not None}, AppConfig={AppConfig is not None}"
        )
        jobs[job_id]["updated_at"] = _now_iso()
        return

    rng = random.Random(request.seed)
    roadnet = _load_roadnet(request.roadnet_id)
    roads = _road_index(roadnet)
    drivables = _drivable_index(roadnet)
    intersections = _signal_intersections(roadnet)
    target_intersection = _pick_intersection(roadnet)
    if not target_intersection:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = "No signalized intersection found in roadnet"
        jobs[job_id]["updated_at"] = _now_iso()
        return
    intersection_id = target_intersection["id"]
    num_phases = _phase_count(target_intersection)
    num_lanes = _incoming_lane_count(roadnet, intersection_id)
    other_intersections = _other_signal_intersections(roadnet, intersection_id)
    other_phase_counts = {
        inter["id"]: _phase_count(inter)
        for inter in other_intersections
    }
    flows = _flow_from_demand(request, roadnet)
    flow_path = _write_generated_flow(job_id, flows)
    config = _build_engine_config(job_id, request, flow_path)
    config_path = _write_engine_config(job_id, config)

    agent_type = "fixed_time" if request.controller.type == "fixed_time" else "dqn"
    if request.controller.type == "rl":
        model = get_model_by_id(request.controller.model_id or "")
        if not model:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["updated_at"] = _now_iso()
            return
        agent_type = str(model.get("agent_type", "dqn"))

    try:
        cfg = _build_rl_config(
            request,
            intersection_id=intersection_id,
            num_lanes=num_lanes,
            num_phases=num_phases,
            engine_config_path=config_path,
            agent_type=agent_type,
        )
        env = CityFlowTrafficEnv(cfg.env, seed=cfg.seed)
        if request.controller.type == "fixed_time":
            agent = None
        elif request.controller.type == "random":
            agent = None
        else:
            agent = build_agent(cfg, env.action_size)

        obs = env.reset()
        state = obs.as_vector()
        train_cutoff_step = min(300, request.duration_s)
        training_actions: list[int] = []
        frozen_policy_template: list[int] = []
        policy_cycle_steps = max(
            1,
            min(
                request.duration_s,
                max(1, env.action_size)
                * max(1, int(request.controller.fixed_time_s / max(1, cfg.env.decision_interval))),
            ),
        )

        for step in range(request.duration_s):
            policy_mode = "idle"
            if request.controller.type == "random":
                policy_mode = "random"
                action = rng.randrange(env.action_size)
            elif request.controller.type == "fixed_time":
                policy_mode = "fixed_time"
                action = _choose_phase_index(
                    rng,
                    env.action_size,
                    "fixed_time",
                    step,
                    request.controller.fixed_time_s,
                )
            else:
                if step < train_cutoff_step:
                    policy_mode = "learning"
                    action = agent.act(state, train=True)
                    training_actions.append(action)
                else:
                    policy_mode = "frozen"
                    if not frozen_policy_template and training_actions:
                        frozen_policy_template = training_actions[-policy_cycle_steps:]
                        # If warmup collapsed to one phase, fall back to a deterministic
                        # round-robin so post-training control still cycles.
                        if len(set(frozen_policy_template)) == 1 and env.action_size > 1:
                            base = frozen_policy_template[0]
                            frozen_policy_template = [
                                (base + offset) % env.action_size for offset in range(env.action_size)
                            ]

                    if frozen_policy_template:
                        action = frozen_policy_template[(step - train_cutoff_step) % len(frozen_policy_template)]
                    else:
                        action = agent.act(state, train=False)

            next_obs, reward, done, info = env.step(action)
            next_state = next_obs.as_vector()

            # Keep non-controlled intersections moving with a deterministic
            # fixed-time cycle so they do not appear permanently stuck.
            if hasattr(env.handles.engine, "set_tl_phase"):
                cycle = max(1, int(request.controller.fixed_time_s))
                for other_id in other_phase_counts:
                    phases_other = max(1, int(other_phase_counts[other_id]))
                    other_phase = (step // cycle) % phases_other
                    try:
                        env.handles.engine.set_tl_phase(other_id, int(other_phase))
                    except Exception:
                        # If an intersection cannot be set, skip it without failing the run.
                        pass

            if agent is not None and request.controller.type == "rl" and step < train_cutoff_step:
                # Only train on the early part of the rollout so later traffic patterns
                # do not overwrite the policy after it has settled.
                agent.observe(state, action, reward, next_state, done)

            state = next_state

            vehicles_payload = []
            vehicle_ids = env.handles.engine.get_vehicles()
            for vid in vehicle_ids:
                info_v = env.handles.engine.get_vehicle_info(vid)
                road_id = info_v.get("road")
                try:
                    distance = float(info_v.get("distance", "0"))
                except ValueError:
                    distance = 0.0

                # Prefer explicit road geometry; fall back to drivable geometry (lane-link in intersections).
                x = 0.0
                y = 0.0
                geometry_found = False
                if road_id and road_id in roads:
                    x, y = _road_position(roads[road_id], distance)
                    geometry_found = True
                else:
                    drivable_id = info_v.get("drivable")
                    if drivable_id and drivable_id in drivables:
                        x, y = _drivable_position(drivables[drivable_id], distance)
                        geometry_found = True

                if not geometry_found:
                    continue
                try:
                    speed = float(info_v.get("speed", "0"))
                except ValueError:
                    speed = 0.0
                vehicles_payload.append(
                    {
                        "id": vid,
                        "drivable": info_v.get("drivable"),
                        "road": road_id,
                        "distance": distance,
                        "x": x,
                        "y": y,
                        "speed": speed,
                    }
                )

            queue_length = int(float(next_obs.queue_lengths.sum()))
            throughput = int(float(info.get("throughput", 0.0)))
            mean_wait = float(info.get("avg_travel_time", 0.0))

            # Extract epsilon for RL agents so the frontend can show exploration rate.
            epsilon = None
            if agent is not None and hasattr(agent, "epsilon"):
                epsilon = float(agent.epsilon)

            # Prefer authoritative phase directly from CityFlow engine.
            phase_index = int(next_obs.current_phase)
            try:
                if hasattr(env.handles.engine, "get_tl_phase"):
                    phase_index = int(env.handles.engine.get_tl_phase(intersection_id))
            except Exception:
                phase_index = int(next_obs.current_phase)

            payload = SimulationMetrics(
                step=step,
                queue_length=queue_length,
                throughput=throughput,
                mean_wait_s=mean_wait,
                reward=float(reward) if request.controller.type != "random" else 0.0,
                epsilon=epsilon,
                policy_mode=policy_mode,
                controller=request.controller.type,
                intersection_id=intersection_id,
                phase_index=phase_index,
                vehicles=vehicles_payload,
            ).model_dump()
            jobs[job_id]["metrics"].append(payload)
            jobs[job_id]["updated_at"] = _now_iso()
            await manager.broadcast(job_id, payload)
            await asyncio.sleep(0.05)

            # Keep streaming until requested duration steps are completed.
            # "done" from the env may be based on seconds and should not truncate the UI run.

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["updated_at"] = _now_iso()
        await manager.broadcast(job_id, {"type": "done", "status": "completed"})
    except Exception as exc:
        import traceback
        error_detail = traceback.format_exc()
        print(error_detail, flush=True)
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)
        jobs[job_id]["updated_at"] = _now_iso()
        await manager.broadcast(job_id, {"type": "done", "status": "error", "detail": str(exc)})


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/models")
async def list_models() -> dict:
    return load_registry()


@app.get("/roadnet/edges")
async def list_edges(roadnet_id: str) -> dict:
    roadnet = _load_roadnet(roadnet_id)
    target = _pick_intersection(roadnet)
    target_id = target["id"] if target else None
    return {"edges": _ingress_edges(roadnet, target_id)}


@app.get("/roadnet")
async def get_roadnet(roadnet_id: str) -> dict:
    return _load_roadnet(roadnet_id)


@app.post("/simulations")
async def start_simulation(request: SimulationRequest) -> SimulationStatus:
    if not request.demand.entries:
        return JSONResponse(status_code=400, content={"detail": "At least one demand entry with rate > 0 is required"})

    if request.controller.type == "rl":
        if not request.controller.model_id:
            return JSONResponse(status_code=400, content={"detail": "model_id required for rl"})
        if not get_model_by_id(request.controller.model_id):
            return JSONResponse(status_code=404, content={"detail": "model_id not found"})

    # Use unique IDs so restarts do not reuse sim_1/sim_2 and accidentally
    # collide with browser-cached resources or stale UI selections.
    job_id = f"sim_{uuid.uuid4().hex[:8]}"
    now = _now_iso()
    jobs[job_id] = {
        "id": job_id,
        "status": "running",
        "created_at": now,
        "updated_at": now,
        "request": request.model_dump(),
        "metrics": [],
    }
    asyncio.create_task(_run_simulation(job_id, request))
    return SimulationStatus(id=job_id, status="running", created_at=now, updated_at=now)


@app.get("/simulations")
async def list_simulations() -> dict:
    summaries = []
    for job in jobs.values():
        req = job.get("request", {})
        ctrl = req.get("controller", {})
        summaries.append({
            "id": job["id"],
            "status": job["status"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "controller_type": ctrl.get("type", ""),
            "model_id": ctrl.get("model_id", ""),
            "duration_s": req.get("duration_s", 0),
            "steps": len(job.get("metrics", [])),
        })
    return {"simulations": summaries}


@app.get("/simulations/{job_id}")
async def get_simulation(job_id: str) -> dict:
    if job_id not in jobs:
        return JSONResponse(status_code=404, content={"detail": "job not found"})
    job = jobs[job_id]
    return {
        "id": job["id"],
        "status": job["status"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "error": job.get("error"),
    }


@app.get("/simulations/{job_id}/metrics")
async def get_metrics(job_id: str) -> dict:
    if job_id not in jobs:
        return JSONResponse(status_code=404, content={"detail": "job not found"})
    return {"metrics": jobs[job_id]["metrics"]}


@app.websocket("/simulations/{job_id}/stream")
async def simulation_stream(websocket: WebSocket, job_id: str) -> None:
    await manager.connect(job_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(job_id, websocket)
