import React, { useEffect, useRef } from "react";

type RoadPoint = { x: number; y: number };

type RoadLane = { width?: number };

type Road = {
  id: string;
  points?: RoadPoint[];
  lanes?: RoadLane[];
  startIntersection?: string;
  endIntersection?: string;
};

type Intersection = {
  id: string;
  point?: RoadPoint;
  virtual?: boolean;
  roadLinks?: Array<{ startRoad?: string }>;
  trafficLight?: { lightphases?: Array<{ availableRoadLinks?: number[] }> };
};

export type Roadnet = {
  roads?: Road[];
  intersections?: Intersection[];
};

export type VehicleFrame = {
  id: string | number;
  road?: string;
  drivable?: string;
  x: number;
  y: number;
  speed?: number;
  heading?: number;
  laneIndex?: number;
  distance?: number;
  alpha?: number;
  flying?: boolean;
  flightT?: number;
};

type RoadMeta = {
  road: Road;
  points: RoadPoint[];
  direction: { x: number; y: number };
  perp: { x: number; y: number };
  laneWidth: number;
  laneCount: number;
  roadWidth: number;
  segLengths: number[];
  totalLength: number;
};

type Transform = {
  minX: number;
  maxY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};

const CANVAS_PADDING = 36;
const LANE_COLOR = "#c9b6a4";
const LANE_BORDER_COLOR = "#e5cfba";
const LANE_DASH = 8;
const LANE_GAP = 10;
const CAR_LENGTH_M = 7.0;
const CAR_WIDTH_M = 2.8;
const CAR_COLORS = ["#f2bfd7", "#b7ebe4", "#dbebb7", "#f5ddb5", "#d4b5f5"];
const TELEPORT_DISTANCE_M = 80;

export function buildTransform(
  roadnet: Roadnet | null,
  width: number,
  height: number,
  focusIntersectionId: string | null = null
) {
  const points: RoadPoint[] = [];
  const focusId = focusIntersectionId || null;
  const roadsToUse = focusId
    ? (roadnet?.roads || []).filter(
        (road) => road.startIntersection === focusId || road.endIntersection === focusId
      )
    : (roadnet?.roads || []);

  roadsToUse.forEach((road) => {
    (road.points || []).forEach((point) => points.push(point));
  });

  if (!points.length) {
    (roadnet?.roads || []).forEach((road) => {
      (road.points || []).forEach((point) => points.push(point));
    });
  }
  if (!points.length) {
    return null;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(
    (width - CANVAS_PADDING * 2) / spanX,
    (height - CANVAS_PADDING * 2) / spanY
  );
  const offsetX = CANVAS_PADDING + (width - CANVAS_PADDING * 2 - spanX * scale) / 2;
  const offsetY = CANVAS_PADDING + (height - CANVAS_PADDING * 2 - spanY * scale) / 2;
  return { minX, maxY, scale, offsetX, offsetY } satisfies Transform;
}

export function mapPoint(point: RoadPoint, transform: Transform) {
  return {
    x: (point.x - transform.minX) * transform.scale + transform.offsetX,
    y: (transform.maxY - point.y) * transform.scale + transform.offsetY,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function snapToRightAngle(angleRad: number) {
  const step = Math.PI / 2;
  return Math.round(angleRad / step) * step;
}

function normalizeVector(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length, length };
}

function offsetPoint(point: RoadPoint, normal: { x: number; y: number }, offset: number) {
  return {
    x: point.x + normal.x * offset,
    y: point.y + normal.y * offset,
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function laneIndexFromVehicle(vehicle: VehicleFrame) {
  const source = vehicle?.drivable || "";
  const match = /_(\d+)$/u.exec(String(source));
  return match ? Number(match[1]) : 0;
}

function buildRoadMetaMap(roadnet: Roadnet | null) {
  const map = new Map<string, RoadMeta>();
  (roadnet?.roads || []).forEach((road) => {
    const points = road.points || [];
    if (points.length < 2) return;
    const start = points[0];
    const end = points[points.length - 1];
    const direction = normalizeVector(end.x - start.x, end.y - start.y);
    const perp = { x: -direction.y, y: direction.x };
    const laneWidth = road.lanes?.[0]?.width || 4;
    const laneCount = Math.max(1, road.lanes?.length || 1);

    const segLengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const length = Math.hypot(dx, dy);
      segLengths.push(length);
      total += length;
    }

    map.set(road.id, {
      road,
      points,
      direction,
      perp,
      laneWidth,
      laneCount,
      roadWidth: laneWidth * laneCount,
      segLengths,
      totalLength: total,
    });
  });
  return map;
}

function samplePointOnRoad(meta: RoadMeta, distance: number) {
  const d = clamp(distance, 0, meta.totalLength || 0);
  let acc = 0;
  for (let i = 0; i < meta.segLengths.length; i += 1) {
    const seg = meta.segLengths[i];
    if (d <= acc + seg || i === meta.segLengths.length - 1) {
      const t = seg <= 0 ? 0 : (d - acc) / seg;
      const a = meta.points[i];
      const b = meta.points[i + 1];
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
      };
    }
    acc += seg;
  }
  const last = meta.points[meta.points.length - 1];
  return { x: last.x, y: last.y };
}

function sampleRoadTangent(meta: RoadMeta, distance: number, delta = 1e-3) {
  const d0 = clamp(distance - delta, 0, meta.totalLength || 0);
  const d1 = clamp(distance + delta, 0, meta.totalLength || 0);
  const p0 = samplePointOnRoad(meta, d0);
  const p1 = samplePointOnRoad(meta, d1);
  return normalizeVector(p1.x - p0.x, p1.y - p0.y);
}

function drawRoadSurface(ctx: CanvasRenderingContext2D, road: Road, transform: Transform, meta: RoadMeta) {
  const points = road.points || [];
  if (points.length < 2) return;

  const halfWidth = meta.roadWidth / 2;
  const outerA = points.map((point) => mapPoint(offsetPoint(point, meta.perp, halfWidth), transform));
  const outerB = points
    .slice()
    .reverse()
    .map((point) => mapPoint(offsetPoint(point, meta.perp, -halfWidth), transform));

  ctx.beginPath();
  ctx.moveTo(outerA[0].x, outerA[0].y);
  outerA.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  outerB.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
  ctx.fillStyle = LANE_COLOR;
  ctx.fill();

  ctx.strokeStyle = LANE_BORDER_COLOR;
  ctx.lineWidth = Math.max(1, 1.5);
  ctx.stroke();

  ctx.save();
  ctx.lineWidth = Math.max(1, 1.0);
  ctx.setLineDash([LANE_DASH, LANE_GAP]);
  for (let laneIndex = 0; laneIndex < meta.laneCount; laneIndex += 1) {
    const innerOffset = -halfWidth + meta.laneWidth * laneIndex + meta.laneWidth / 2;
    const lanePts = points.map((point) => mapPoint(offsetPoint(point, meta.perp, innerOffset), transform));
    if (laneIndex < meta.laneCount - 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.moveTo(lanePts[0].x, lanePts[0].y);
      lanePts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function getTrafficLightDisplay(phaseIndex: number) {
  const phases = [
    { direction: "← →", type: "green" },
    { direction: "◼", type: "yellow" },
    { direction: "↑ ↓", type: "green" },
    { direction: "◼", type: "yellow" },
  ];
  return phases[phaseIndex % phases.length] || phases[0];
}

function drawTrafficLight(ctx: CanvasRenderingContext2D, roadnet: Roadnet | null, phaseIndex: number, transform: Transform) {
  const centerInt = roadnet?.intersections?.find((item) => !item.virtual);
  if (!centerInt || !centerInt.point) return;

  const tl = getTrafficLightDisplay(phaseIndex);
  const mapped = mapPoint(centerInt.point, transform);

  const radius = 38;
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(mapped.x, mapped.y, radius, 0, Math.PI * 2);
  ctx.fill();

  const lightColor = tl.type === "green" ? "#00dd44" : tl.type === "yellow" ? "#ffdd00" : "#dd0000";
  const lightGlow = tl.type === "green" ? "#00ff66" : tl.type === "yellow" ? "#ffff00" : "#ff3333";

  ctx.fillStyle = lightColor;
  ctx.shadowColor = lightGlow;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(mapped.x, mapped.y, radius - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tl.direction, mapped.x, mapped.y - 6);

  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tl.type.toUpperCase(), mapped.x, mapped.y + 8);
}

function drawVehicles(
  ctx: CanvasRenderingContext2D,
  vehicles: VehicleFrame[] | undefined,
  roadMetaMap: Map<string, RoadMeta>,
  transform: Transform
) {
  (vehicles || []).forEach((vehicle) => {
    const meta = vehicle.road ? roadMetaMap.get(vehicle.road) : null;
    const laneIndex = clamp(
      Number.isFinite(vehicle.laneIndex) ? Number(vehicle.laneIndex) : laneIndexFromVehicle(vehicle),
      0,
      Math.max(0, (meta?.laneCount || 1) - 1)
    );
    const rawHeading = vehicle.heading ?? Math.atan2(meta?.direction.y || 0, meta?.direction.x || 1);
    const heading = snapToRightAngle(rawHeading);
    const alpha = vehicle.alpha ?? 1;

    const laneOffset = meta && !vehicle.flying
      ? (-meta.roadWidth / 2) + meta.laneWidth * (laneIndex + 0.5)
      : 0;
    const normal = meta && !vehicle.flying ? meta.perp : { x: 0, y: 0 };
    const renderedPoint = meta
      ? offsetPoint({ x: vehicle.x, y: vehicle.y }, normal, laneOffset)
      : { x: vehicle.x, y: vehicle.y };
    const mapped = mapPoint(renderedPoint, transform);
    const colorIndex = Math.abs(String(vehicle.id).split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)) % CAR_COLORS.length;
    const carColor = CAR_COLORS[colorIndex];

    const scale = transform.scale || 1;
    const carLength = Math.max(10, CAR_LENGTH_M * scale);
    const carWidth = Math.max(5, CAR_WIDTH_M * scale);
    const flightLift = vehicle.flying ? Math.sin(Math.PI * clamp(vehicle.flightT ?? 0, 0, 1)) * 8 : 0;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(mapped.x, mapped.y - flightLift);
    ctx.rotate(heading);

    ctx.fillStyle = vehicle.flying ? "rgba(36, 29, 24, 0.30)" : "rgba(36, 29, 24, 0.18)";
    drawRoundedRect(ctx, -carLength / 2 - 1.5, -carWidth / 2 - 1.5, carLength + 3, carWidth + 3, carWidth / 2);
    ctx.fill();

    ctx.fillStyle = carColor;
    drawRoundedRect(ctx, -carLength / 2, -carWidth / 2, carLength, carWidth, carWidth / 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff66";
    ctx.beginPath();
    ctx.arc(carLength / 2 - Math.max(2, 1.2 * scale), 0, Math.max(1.6, 0.7 * scale), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
}

export type RoadCanvasProps = {
  roadnet: Roadnet | null;
  vehicles: VehicleFrame[];
  onResize?: (size: { width: number; height: number }) => void;
  phaseIndex?: number;
  intersectionId?: string | null;
  animated?: boolean;
  focusIntersectionId?: string | null;
};

export function RoadCanvas({
  roadnet,
  vehicles,
  onResize,
  phaseIndex = 0,
  focusIntersectionId = null,
}: RoadCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!onResize) return;
    const updateSize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        onResize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [onResize]);

  useEffect(() => {
    if (!roadnet || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const transform = buildTransform(roadnet, width, height, focusIntersectionId);
    if (!transform) return;

    const roadMetaMap = buildRoadMetaMap(roadnet);

    ctx.clearRect(0, 0, width, height);
    (roadnet.roads || []).forEach((road) => {
      const meta = roadMetaMap.get(road.id);
      if (meta) {
        drawRoadSurface(ctx, road, transform, meta);
      }
    });
    drawTrafficLight(ctx, roadnet, phaseIndex, transform);
    drawVehicles(ctx, vehicles, roadMetaMap, transform);
  }, [roadnet, vehicles, phaseIndex, focusIntersectionId]);

  return (
    <div className="absolute inset-0" ref={containerRef}>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
