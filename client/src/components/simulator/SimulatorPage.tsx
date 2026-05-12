import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { createSimulation, getEdges, getModels, getRoadnet, openSimulationStream } from "@/lib/simApi";
import { ReplayPanel } from "@/components/simulator/ReplayPanel";
import { RoadCanvas, buildTransform, mapPoint, type Roadnet, type VehicleFrame } from "@/components/simulator/RoadCanvas";
import { SparkChart } from "@/components/simulator/SparkChart";

const DEFAULT_ROADNET = "roadnet_cross.json";
const DEFAULT_FOCUS_INTERSECTION = "intersection_center";

type MetricFrame = {
  step?: number;
  queue_length?: number;
  throughput?: number;
  reward?: number;
  epsilon?: number;
  mean_wait_s?: number;
  phase_index?: number;
  intersection_id?: string | null;
  vehicles?: VehicleFrame[];
};

type DemandEntry = { edge: string; rate: number };

type DemandAnchor = {
  edge: string;
  left: number;
  top: number;
};

export function SimulatorPage() {
  const [edges, setEdges] = useState<string[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [roadnet, setRoadnet] = useState<Roadnet | null>(null);
  const [demandMap, setDemandMap] = useState<Record<string, number>>({});
  const [controllerType, setControllerType] = useState("rl");
  const [modelId, setModelId] = useState("dqn");
  const [fixedTime, setFixedTime] = useState(30);
  const [duration, setDuration] = useState(300);
  const [seed, setSeed] = useState(42);
  const [status, setStatus] = useState("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricFrame[]>([]);
  const [vehicles, setVehicles] = useState<VehicleFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [demandSize, setDemandSize] = useState({ width: 900, height: 320 });
  const [replayMode, setReplayMode] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const handleReplayFrame = useCallback((frame: MetricFrame, cursor: number) => {
    if (status === "starting" || status === "running") return;
    if (!replayMode) setReplayMode(true);
    setStatus("replaying");
    setJobId(null);
    setMetrics((prev) => {
      if (cursor === 0) return [frame];
      return prev.length === cursor ? [...prev, frame] : prev.slice(0, cursor).concat(frame);
    });
    if (Array.isArray(frame.vehicles)) setVehicles(frame.vehicles);
  }, [replayMode, status]);

  const handleReplayFullMetrics = useCallback((allFrames: MetricFrame[]) => {
    setReplayMode(true);
    setMetrics([]);
    setVehicles([]);
    setError(null);
    if (!allFrames.length) {
      setStatus("idle");
    }
  }, []);

  useEffect(() => {
    getEdges(DEFAULT_ROADNET).then((data) => setEdges(data.edges || []));
    getModels().then((data) => {
      const items = data.models || [];
      setModels(items);
      if (items.length && !items.find((model: any) => model.id === modelId)) {
        setModelId(items[0].id);
      }
    });
    getRoadnet(DEFAULT_ROADNET).then((data) => setRoadnet(data));
  }, [modelId]);

  const edgeOptions = useMemo(() => edges.filter(Boolean), [edges]);
  const roadMap = useMemo(() => {
    const map: Record<string, any> = {};
    (roadnet?.roads || []).forEach((road) => {
      map[road.id] = road;
    });
    return map;
  }, [roadnet]);

  const demandAnchors = useMemo(() => {
    if (!roadnet || !demandSize.width || !demandSize.height) return [];
    const transform = buildTransform(roadnet, demandSize.width, demandSize.height);
    if (!transform) return [];
    return edgeOptions
      .map((edge) => {
        const road = roadMap[edge];
        if (!road || !road.points?.length) return null;
        const first = road.points[0];
        const next = road.points[1] || road.points[road.points.length - 1];
        const mappedFirst = mapPoint(first, transform);
        const mappedNext = mapPoint(next, transform);
        const dx = mappedNext.x - mappedFirst.x;
        const dy = mappedNext.y - mappedFirst.y;
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length;
        const ny = dx / length;
        const offset = 28;
        const along = 18;
        const mapped = {
          x: mappedFirst.x + (dx / length) * along + nx * offset,
          y: mappedFirst.y + (dy / length) * along + ny * offset,
        };
        return { edge, left: mapped.x, top: mapped.y } satisfies DemandAnchor;
      })
      .filter(Boolean) as DemandAnchor[];
  }, [edgeOptions, roadMap, roadnet, demandSize]);

  useEffect(() => {
    if (!edgeOptions.length) return;
    setDemandMap((prev) => {
      if (Object.keys(prev).length) return prev;
      const initial: Record<string, number> = {};
      edgeOptions.forEach((edge) => {
        initial[edge] = 8;
      });
      return initial;
    });
  }, [edgeOptions]);

  const adjustRate = (edge: string, delta: number) => {
    setDemandMap((prev) => {
      const next = { ...prev };
      const current = next[edge] ?? 0;
      next[edge] = Math.max(0, Math.min(60, current + delta));
      return next;
    });
  };

  const chartData = useMemo(() => {
    const steps = metrics.filter((m) => m.step !== undefined);
    return {
      queue: steps.map((m) => m.queue_length ?? 0),
      throughput: steps.map((m) => m.throughput ?? 0),
      reward: steps.map((m) => m.reward ?? 0),
      epsilon: steps.map((m) => m.epsilon ?? 0),
      wait: steps.map((m) => m.mean_wait_s ?? 0),
    };
  }, [metrics]);

  const latestMetric = metrics.length ? metrics[metrics.length - 1] : null;
  const isReplaying = replayMode && status === "replaying";

  const startSimulation = async () => {
    setReplayMode(false);
    setError(null);
    setMetrics([]);
    setVehicles([]);
    setStatus("starting");

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const payload = {
      roadnet_id: DEFAULT_ROADNET,
      demand: {
        entries: Object.entries(demandMap)
          .filter(([, rate]) => rate > 0)
          .map(([edge, rate]) => ({ edge, rate } as DemandEntry)),
      },
      controller: {
        type: controllerType,
        model_id: controllerType === "rl" ? modelId : null,
        fixed_time_s: fixedTime,
      },
      duration_s: duration,
      seed: seed,
    };

    if (!payload.demand.entries.length) {
      setError("Set demand on at least one ingress road before starting.");
      setStatus("idle");
      return;
    }

    try {
      const result = await createSimulation(payload);
      setJobId(result.id);
      setStatus("running");
      const ws = openSimulationStream(result.id);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "done") {
          setStatus(data.status === "error" ? "error" : "completed");
          if (data.detail) setError(data.detail);
          ws.close();
          wsRef.current = null;
          return;
        }
        setMetrics((prev) => [...prev, data]);
        if (Array.isArray(data.vehicles)) {
          setVehicles(data.vehicles);
        }
      };
      ws.onerror = () => {
        setError("Stream error");
        setStatus("error");
      };
      ws.onclose = () => {
        setStatus((prev) => (prev === "running" ? "completed" : prev));
      };
    } catch (err: any) {
      setError(err.message || "Failed to start simulation");
      setStatus("idle");
    }
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-surface-bright/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-4 sm:h-[72px]">
          <div className="flex items-center gap-4">
            <p className="font-heading text-lg font-semibold tracking-tight text-primary sm:text-xl">
              TrafficSense RL
            </p>
            <div className="flex items-center gap-2 rounded-full border border-border/50 bg-surface-container-low px-3 py-1 shadow-sm">
              <span className={`h-2 w-2 rounded-full ${status === "running" ? "bg-secondary" : "bg-muted-foreground"}`} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                {status === "running" ? "Stream Active" : "Idle"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              className="rounded-full bg-foreground text-sm font-semibold text-background shadow-sm transition hover:bg-foreground/90"
              onClick={startSimulation}
              disabled={status === "running" || status === "starting"}
            >
              {status === "running" ? "Running…" : "Deploy Agent"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] space-y-12 px-4 py-10 sm:space-y-14">
        <section className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-heading text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
              Live Simulation
            </h2>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-2 rounded-full border border-border/50 bg-secondary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground shadow-sm">
                <span className="h-2 w-2 rounded-full bg-secondary" />
                {status === "running" ? "Learning" : isReplaying ? "Replaying" : "Idle"}
              </span>
              {latestMetric?.step !== undefined && (
                <span className="text-xs font-semibold uppercase tracking-[0.25em] text-foreground/70">
                  Step: {latestMetric.step}
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="relative min-h-[360px] overflow-hidden rounded-[24px] border-border/60 bg-surface-container-low font-sans shadow-[0_16px_40px_rgba(24,21,18,0.08)]">
              <div className="absolute inset-0 bg-[linear-gradient(135deg,_rgba(96,78,58,0.45),_rgba(223,216,210,0.15)),linear-gradient(120deg,_rgba(255,255,255,0.4),_transparent_60%)]" />
              <div
                className="absolute inset-0 opacity-80"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg,rgba(255,255,255,0.05) 1px,transparent 1px),linear-gradient(rgba(255,255,255,0.05) 1px,transparent 1px)",
                  backgroundSize: "28px 28px",
                }}
              />
              <div className="relative h-full min-h-[360px] p-6 sm:p-7">
                {roadnet ? (
                  <div className="relative h-full min-h-[300px] overflow-hidden rounded-2xl border border-border/60 bg-surface-bright">
                    <RoadCanvas
                      roadnet={roadnet}
                      vehicles={vehicles}
                      phaseIndex={latestMetric?.phase_index ?? 0}
                      focusIntersectionId={latestMetric?.intersection_id || DEFAULT_FOCUS_INTERSECTION}
                    />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading roadnet…
                  </div>
                )}
              </div>
            </Card>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
                  <CardHeader className="space-y-2">
                    <CardDescription className="text-[11px] font-semibold uppercase tracking-[0.2em]">
                      Average Reward
                    </CardDescription>
                    <CardTitle className="text-2xl font-semibold tracking-tight">
                      {latestMetric ? latestMetric.reward?.toFixed(1) ?? "0.0" : "0.0"}
                    </CardTitle>
                    <span className="text-xs font-medium text-muted-foreground">Live metric</span>
                  </CardHeader>
                </Card>
                <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
                  <CardHeader className="space-y-2">
                    <CardDescription className="text-[11px] font-semibold uppercase tracking-[0.2em]">
                      Throughput
                    </CardDescription>
                    <CardTitle className="text-2xl font-semibold tracking-tight">
                      {latestMetric ? latestMetric.throughput ?? 0 : 0} v/h
                    </CardTitle>
                  </CardHeader>
                </Card>
              </div>

              <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
                <CardHeader className="space-y-2">
                  <CardDescription className="text-[11px] font-semibold uppercase tracking-[0.2em]">
                    Avg Queue Length
                  </CardDescription>
                  <CardTitle className="text-2xl font-semibold tracking-tight">
                    {latestMetric ? latestMetric.queue_length ?? 0 : 0} m
                  </CardTitle>
                </CardHeader>
              </Card>

              <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Learning Curves
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {chartData.reward.length > 1 ? (
                    <SparkChart data={chartData.reward} label="Reward" color="#6a4dba" />
                  ) : (
                    <div className="rounded-xl border border-border/60 bg-surface-bright p-4 text-xs text-muted-foreground">
                      Run a simulation to populate learning curves.
                    </div>
                  )}
                  {chartData.epsilon.some((v) => v > 0) && (
                    <SparkChart data={chartData.epsilon} label="Epsilon" color="#2a7aaf" />
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <div className="h-px w-full bg-border/70" />

        <section className="space-y-6">
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
            Demand Builder
          </h2>
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="relative min-h-[360px] overflow-hidden rounded-[24px] border-border/60 bg-surface-container-low font-sans shadow-[0_16px_40px_rgba(24,21,18,0.08)]">
              <div className="absolute inset-0 bg-[linear-gradient(135deg,_rgba(194,188,184,0.8),_rgba(150,143,138,0.5))]" />
              <div
                className="absolute inset-0 opacity-70"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg,rgba(255,255,255,0.12) 1px,transparent 1px),linear-gradient(rgba(255,255,255,0.12) 1px,transparent 1px)",
                  backgroundSize: "30px 30px",
                }}
              />
              <div className="relative h-full min-h-[360px] p-6 sm:p-7">
                <div className="relative h-full min-h-[300px] overflow-hidden rounded-2xl border border-border/60 bg-surface-bright">
                  {roadnet ? (
                    <>
                      <RoadCanvas
                        roadnet={roadnet}
                        vehicles={[]}
                        onResize={setDemandSize}
                        focusIntersectionId={DEFAULT_FOCUS_INTERSECTION}
                      />
                      {demandAnchors.map((anchor) => (
                        <div
                          key={anchor.edge}
                          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border/60 bg-surface-bright/95 px-2 py-1 text-[10px] shadow-sm"
                          style={{ left: anchor.left, top: anchor.top }}
                        >
                          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                            {anchor.edge}
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              className="h-5 w-5 rounded-full border border-border/60 text-xs"
                              onClick={() => adjustRate(anchor.edge, -2)}
                            >
                              -
                            </button>
                            <span className="text-xs font-semibold text-foreground">
                              {demandMap[anchor.edge] || 0}
                            </span>
                            <button
                              className="h-5 w-5 rounded-full border border-border/60 text-xs"
                              onClick={() => adjustRate(anchor.edge, 2)}
                            >
                              +
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading roadnet…
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em]">
                  Active Demand
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {edgeOptions.slice(0, 6).map((edge) => (
                  <div
                    key={edge}
                    className="flex items-center justify-between rounded-lg border border-border/60 bg-surface-bright px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-foreground">{edge}</span>
                    <span className="rounded-full border border-border/50 bg-secondary/10 px-2 py-1 text-[10px] font-semibold uppercase text-secondary">
                      {demandMap[edge] || 0} veh/min
                    </span>
                  </div>
                ))}
                <div className="text-xs text-muted-foreground">
                  {edgeOptions.length > 6 ? "Showing top 6 edges" : ""}
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="h-px w-full bg-border/70" />

        <section className="space-y-6">
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
            Configuration Management
          </h2>
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em]">
                  Controller Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Strategy
                  </label>
                  <select
                    value={controllerType}
                    onChange={(e) => setControllerType(e.target.value)}
                    className="h-10 rounded-full border border-border/60 bg-surface-bright px-3 text-sm"
                  >
                    <option value="rl">RL Agent (online learning)</option>
                    <option value="fixed_time">Fixed time</option>
                    <option value="random">Random</option>
                  </select>
                </div>

                {controllerType === "rl" && (
                  <div className="grid gap-2">
                    <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Agent Type
                    </label>
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="h-10 rounded-full border border-border/60 bg-surface-bright px-3 text-sm"
                    >
                      {models.map((model: any) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {controllerType === "fixed_time" && (
                  <div className="grid gap-2">
                    <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Phase Duration (s)
                    </label>
                    <input
                      type="number"
                      min="5"
                      value={fixedTime}
                      onChange={(e) => setFixedTime(Number(e.target.value))}
                      className="h-10 rounded-full border border-border/60 bg-surface-bright px-3 text-sm"
                    />
                  </div>
                )}

                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Duration (steps)
                  </label>
                  <input
                    type="number"
                    min="50"
                    max="3600"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className="h-10 rounded-full border border-border/60 bg-surface-bright px-3 text-sm"
                  />
                </div>

                <div className="grid gap-2">
                  <label className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Seed
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                    className="h-10 rounded-full border border-border/60 bg-surface-bright px-3 text-sm"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em]">
                  Agent Hyperparameters
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Learning Rate (alpha)</span>
                    <span className="font-mono text-xs">0.0003</span>
                  </div>
                  <Slider defaultValue={[30]} max={100} step={1} />
                  <div className="h-10 rounded-xl border border-border/60 bg-surface-bright shadow-sm" />
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Discount Factor (gamma)</span>
                    <span className="font-mono text-xs">0.99</span>
                  </div>
                  <Slider defaultValue={[99]} max={100} step={1} />
                  <div className="h-10 rounded-xl border border-border/60 bg-surface-bright shadow-sm" />
                </div>
                <div className="space-y-3">
                  <label className="text-sm font-medium">Batch Size</label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-between rounded-full font-semibold"
                      >
                        64
                        <span className="text-xs text-muted-foreground">▾</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem>32</DropdownMenuItem>
                      <DropdownMenuItem>64</DropdownMenuItem>
                      <DropdownMenuItem>128</DropdownMenuItem>
                      <DropdownMenuItem>256</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button variant="outline" className="w-full rounded-full font-semibold">
                  Save Configuration
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="h-px w-full bg-border/70" />

        <section className="space-y-6 pb-8">
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
            Replay & Metrics
          </h2>
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="rounded-[20px] border-border/60 bg-surface-container-low font-sans shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em]">
                  KPI Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                {[
                  { label: "Queue", value: latestMetric?.queue_length ?? 0 },
                  { label: "Throughput", value: latestMetric?.throughput ?? 0 },
                  { label: "Avg Wait", value: latestMetric?.mean_wait_s?.toFixed(1) ?? "0.0" },
                  { label: "Reward", value: latestMetric?.reward?.toFixed(1) ?? "0.0" },
                  { label: "Epsilon", value: latestMetric?.epsilon?.toFixed(3) ?? "0.000" },
                  { label: "Phase", value: latestMetric?.phase_index ?? 0 },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-lg border border-border/60 bg-surface-bright px-3 py-2 text-sm"
                  >
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      {item.label}
                    </div>
                    <div className="text-lg font-semibold text-foreground">{item.value}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <ReplayPanel onFrame={handleReplayFrame} onFullMetrics={handleReplayFullMetrics} />
          </div>

          {chartData.queue.length > 1 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <SparkChart data={chartData.queue} label="Queue Length" color="#b2462e" />
              <SparkChart data={chartData.throughput} label="Throughput" color="#3a7d5e" />
              <SparkChart data={chartData.reward} label="Reward" color="#6a4dba" />
              <SparkChart data={chartData.wait} label="Avg Wait" color="#c08830" unit="s" />
              {chartData.epsilon.some((v) => v > 0) && (
                <SparkChart data={chartData.epsilon} label="Epsilon" color="#2a7aaf" />
              )}
            </div>
          )}

          {metrics.length > 0 && (
            <div className="grid gap-2 rounded-2xl border border-border/60 bg-surface-bright p-4 text-xs text-muted-foreground">
              {metrics.slice(-12).map((m) => (
                <div key={`live-${m.step}`} className="grid grid-cols-5 gap-2">
                  <span>t={m.step}</span>
                  <span>queue {m.queue_length}</span>
                  <span>reward {m.reward?.toFixed(1) ?? "-"}</span>
                  <span>ε {m.epsilon?.toFixed(3) ?? "-"}</span>
                  <span>wait {m.mean_wait_s?.toFixed(1) ?? "-"}s</span>
                </div>
              ))}
            </div>
          )}

          {!metrics.length && (
            <div className="rounded-2xl border border-dashed border-border/60 bg-surface-bright p-4 text-sm text-muted-foreground">
              No data yet. Start a run to begin online learning.
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-destructive/60 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}
          {jobId && (
            <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Active job: {jobId}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
