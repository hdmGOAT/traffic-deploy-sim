import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSimulation, getEdges, getModels, getRoadnet, openSimulationStream } from "./api.js";
import ReplayPanel from "./ReplayPanel.jsx";

const DEFAULT_ROADNET = "roadnet_cross.json";
const DEFAULT_FOCUS_INTERSECTION = "intersection_center";
const CANVAS_PADDING = 36;
// Visual constants inspired by CityFlow frontend
const LANE_COLOR = "#c9b6a4"; // road surface base
const LANE_BORDER_COLOR = "#e5cfba"; // outer border
const LANE_INNER_COLOR = "#f7efe4"; // inner lane ribbon
const LANE_DASH = 8; // px dash for lane separator
const LANE_GAP = 10;
const TRAFFIC_LIGHT_WIDTH = 6;
const CAR_LENGTH_M = 7.0; // meters (world units)
const CAR_WIDTH_M = 2.8; // meters
const CAR_COLORS = ["#f2bfd7", "#b7ebe4", "#dbebb7", "#f5ddb5", "#d4b5f5"];
const TELEPORT_DISTANCE_M = 80; // true reset-sized jump only

function buildTransform(roadnet, width, height, focusIntersectionId = null) {
  const points = [];
  const focusId = focusIntersectionId || null;
  const roadsToUse = focusId
    ? (roadnet?.roads || []).filter(
        (road) => road.startIntersection === focusId || road.endIntersection === focusId
      )
    : (roadnet?.roads || []);

  roadsToUse.forEach((road) => {
    (road.points || []).forEach((point) => points.push(point));
  });

  // Fallback to full map bounds if focused roads are unavailable.
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
  return { minX, maxY, scale, offsetX, offsetY };
}

function mapPoint(point, transform) {
  return {
    x: (point.x - transform.minX) * transform.scale + transform.offsetX,
    y: (transform.maxY - point.y) * transform.scale + transform.offsetY
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function snapToRightAngle(angleRad) {
  const step = Math.PI / 2;
  return Math.round(angleRad / step) * step;
}

function getTrafficLightDisplay(phaseIndex) {
  // Phase layout: 0=EW green(30s), 1=yellow(5s), 2=NS green(30s), 3=yellow(5s)
  const phases = [
    { direction: "← →", type: "green", duration: 30 },
    { direction: "◼", type: "yellow", duration: 5 },
    { direction: "↑ ↓", type: "green", duration: 30 },
    { direction: "◼", type: "yellow", duration: 5 },
  ];
  return phases[phaseIndex % phases.length] || phases[0];
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length, length };
}

function offsetPoint(point, normal, offset) {
  return {
    x: point.x + normal.x * offset,
    y: point.y + normal.y * offset
  };
}

function cubicBezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

function cubicBezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x =
    3 * u * u * (p1.x - p0.x) +
    6 * u * t * (p2.x - p1.x) +
    3 * t * t * (p3.x - p2.x);
  const y =
    3 * u * u * (p1.y - p0.y) +
    6 * u * t * (p2.y - p1.y) +
    3 * t * t * (p3.y - p2.y);
  return normalizeVector(x, y);
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
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

function laneIndexFromVehicle(vehicle) {
  const source = vehicle?.drivable || "";
  const match = /_(\d+)$/u.exec(String(source));
  return match ? Number(match[1]) : 0;
}

function toVehicleMap(vehicles) {
  const map = new Map();
  (vehicles || []).forEach((vehicle) => {
    if (vehicle && vehicle.id != null) {
      map.set(String(vehicle.id), vehicle);
    }
  });
  return map;
}

function buildRoadMetaMap(roadnet) {
  const map = new Map();
  (roadnet?.roads || []).forEach((road) => {
    const points = road.points || [];
    if (points.length < 2) {
      return;
    }
    const start = points[0];
    const end = points[points.length - 1];
    const direction = normalizeVector(end.x - start.x, end.y - start.y);
    const perp = { x: -direction.y, y: direction.x };
    const laneWidth = road.lanes?.[0]?.width || 4;
    const laneCount = Math.max(1, road.lanes?.length || 1);
    // precompute segment lengths for distance -> point mapping
    const segLengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const l = Math.hypot(dx, dy);
      segLengths.push(l);
      total += l;
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
      totalLength: total
    });
  });
  return map;
}

function samplePointOnRoad(meta, distance) {
  if (!meta || !meta.points || !meta.segLengths) return null;
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
        y: lerp(a.y, b.y, t)
      };
    }
    acc += seg;
  }
  // fallback to last point
  const last = meta.points[meta.points.length - 1];
  return { x: last.x, y: last.y };
}

function sampleRoadTangent(meta, distance, delta = 1e-3) {
  if (!meta) return { x: 1, y: 0 };
  const d0 = clamp(distance - delta, 0, meta.totalLength || 0);
  const d1 = clamp(distance + delta, 0, meta.totalLength || 0);
  const p0 = samplePointOnRoad(meta, d0) || { x: 0, y: 0 };
  const p1 = samplePointOnRoad(meta, d1) || { x: 1, y: 0 };
  return normalizeVector(p1.x - p0.x, p1.y - p0.y);
}

function buildSignalState(roadnet, phaseIndex, intersectionId = null) {
  const candidates = (roadnet?.intersections || []).filter(
    (item) => !item.virtual && item.trafficLight?.lightphases?.length && (item.roadLinks || []).length
  );
  const intersection = intersectionId
    ? candidates.find((item) => item.id === intersectionId) || candidates[0]
    : candidates[0];
  if (!intersection) {
    return null;
  }
  const phases = intersection.trafficLight?.lightphases || [];
  if (!phases.length) {
    return null;
  }
  const safePhase = ((Number(phaseIndex) % phases.length) + phases.length) % phases.length;
  const activePhase = phases[safePhase] || phases[0];
  const greenRoads = new Set();
  (activePhase.availableRoadLinks || []).forEach((linkIndex) => {
    const link = intersection.roadLinks?.[linkIndex];
    if (link?.startRoad) {
      greenRoads.add(link.startRoad);
    }
  });
  return { intersection, greenRoads };
}

function interpolateVehicle(start, end, t, roadMetaMap) {
  const startMeta = start.road ? roadMetaMap.get(start.road) : null;
  const endMeta = end.road ? roadMetaMap.get(end.road) : null;
  const laneSnap = t < 0.5 ? laneIndexFromVehicle(start) : laneIndexFromVehicle(end);
  // Use backend positions directly. Backend already resolves lane-link geometry,
  // so this avoids stitching artifacts that looked like hopping.
  const startPos = { x: Number(start.x || 0), y: Number(start.y || 0) };
  const endPos = { x: Number(end.x || 0), y: Number(end.y || 0) };
  const dx = endPos.x - startPos.x;
  const dy = endPos.y - startPos.y;
  const defaultDir = startMeta?.direction || endMeta?.direction || { x: 1, y: 0 };
  const heading = Math.hypot(dx, dy) > 1e-5 ? Math.atan2(dy, dx) : Math.atan2(defaultDir.y, defaultDir.x);
  return {
    x: lerp(startPos.x, endPos.x, t),
    y: lerp(startPos.y, endPos.y, t),
    road: t < 0.5 ? start.road : end.road,
    distance: undefined,
    heading,
    laneIndex: laneSnap,
    alpha: 1
  };
}

function interpolateFrame(startVehicles, endVehicles, t, roadMetaMap) {
  const startMap = toVehicleMap(startVehicles);
  const endMap = toVehicleMap(endVehicles);
  const ids = new Set([...startMap.keys(), ...endMap.keys()]);
  const frame = [];

  ids.forEach((id) => {
    const start = startMap.get(id);
    const end = endMap.get(id);
    if (start && end) {
      const dx = Number(end.x || 0) - Number(start.x || 0);
      const dy = Number(end.y || 0) - Number(start.y || 0);
      const displacement = Math.hypot(dx, dy);
      let vehicle;

      // Only use flying reset for truly large jumps where road context is missing.
      const looksLikeReset = displacement > TELEPORT_DISTANCE_M && (!start.road || !end.road);
      if (looksLikeReset) {
        const s = smoothstep(t);
        vehicle = {
          x: lerp(Number(start.x || 0), Number(end.x || 0), s),
          y: lerp(Number(start.y || 0), Number(end.y || 0), s),
          road: undefined,
          distance: undefined,
          heading: Math.atan2(dy, dx || 1),
          laneIndex: 0,
          alpha: 1,
          flying: true,
          flightT: s
        };
      } else {
        vehicle = interpolateVehicle(start, end, t, roadMetaMap);
      }

      vehicle.id = id;
      vehicle.speed = lerp(Number(start.speed || 0), Number(end.speed || 0), t);
      frame.push(vehicle);
      return;
    }

    if (end) {
      const meta = end.road ? roadMetaMap.get(end.road) : null;
      const pos = (meta && typeof end.distance === "number") ? samplePointOnRoad(meta, Number(end.distance)) : { x: end.x, y: end.y };
      const tan = (meta && typeof end.distance === "number") ? sampleRoadTangent(meta, Number(end.distance)) : (meta ? meta.direction : { x: 1, y: 0 });
      frame.push({
        id,
        x: pos.x,
        y: pos.y,
        road: meta ? end.road : undefined,
        distance: meta && typeof end.distance === "number" ? Number(end.distance) : undefined,
        heading: Math.atan2(tan.y || 0, tan.x || 1),
        laneIndex: laneIndexFromVehicle(end),
        alpha: clamp(0.25 + t * 0.75, 0, 1),
        speed: Number(end.speed || 0)
      });
      return;
    }

    if (start) {
      const meta = start.road ? roadMetaMap.get(start.road) : null;
      const pos = (meta && typeof start.distance === "number") ? samplePointOnRoad(meta, Number(start.distance)) : { x: start.x, y: start.y };
      const tan = (meta && typeof start.distance === "number") ? sampleRoadTangent(meta, Number(start.distance)) : (meta ? meta.direction : { x: 1, y: 0 });
      frame.push({
        id,
        x: pos.x,
        y: pos.y,
        road: meta ? start.road : undefined,
        distance: meta && typeof start.distance === "number" ? Number(start.distance) : undefined,
        heading: Math.atan2(tan.y || 0, tan.x || 1),
        laneIndex: laneIndexFromVehicle(start),
        alpha: clamp(1 - t, 0, 1),
        speed: Number(start.speed || 0)
      });
    }
  });

  return frame;
}

function drawRoadSurface(ctx, road, transform, meta) {
  const points = road.points || [];
  if (points.length < 2) {
    return;
  }

  const halfWidth = meta.roadWidth / 2;
  const outerA = points.map((point) => mapPoint(offsetPoint(point, meta.perp, halfWidth), transform));
  const outerB = points
    .slice()
    .reverse()
    .map((point) => mapPoint(offsetPoint(point, meta.perp, -halfWidth), transform));

  // Draw lane ribbon (outer shape)
  ctx.beginPath();
  ctx.moveTo(outerA[0].x, outerA[0].y);
  outerA.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  outerB.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
  ctx.fillStyle = LANE_COLOR;
  ctx.fill();

  // Outer border
  ctx.strokeStyle = LANE_BORDER_COLOR;
  ctx.lineWidth = Math.max(1, 1.5);
  ctx.stroke();

  // Per-lane separators and inner fill
  ctx.save();
  ctx.lineWidth = Math.max(1, 1.0);
  ctx.setLineDash([LANE_DASH, LANE_GAP]);
  for (let laneIndex = 0; laneIndex < meta.laneCount; laneIndex += 1) {
    // draw inner lane ribbon lightly
    const innerOffset = -halfWidth + meta.laneWidth * laneIndex + meta.laneWidth / 2;
    const lanePts = points.map((point) => mapPoint(offsetPoint(point, meta.perp, innerOffset), transform));
    // draw a subtle dashed centerline for each lane except the last
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

function drawSignals(ctx, roadnet, roadMetaMap, transform, phaseIndex, intersectionId) {
  const signalState = buildSignalState(roadnet, phaseIndex, intersectionId);
  if (!signalState) {
    return;
  }

  const center = signalState.intersection.point || { x: 0, y: 0 };
  const centerPx = mapPoint(center, transform);
  const incoming = (roadnet.roads || []).filter((road) => road.endIntersection === signalState.intersection.id);

  const verticalRoads = [];
  const horizontalRoads = [];
  incoming.forEach((road) => {
    const meta = roadMetaMap.get(road.id);
    if (!meta) return;
    const axisVertical = Math.abs(meta.direction.y) >= Math.abs(meta.direction.x);
    if (axisVertical) verticalRoads.push(road.id);
    else horizontalRoads.push(road.id);
  });

  const verticalGreen = verticalRoads.some((id) => signalState.greenRoads.has(id));
  const horizontalGreen = horizontalRoads.some((id) => signalState.greenRoads.has(id));

  const drawHead = (x, y, isGreen) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(40,30,20,0.92)";
    drawRoundedRect(ctx, -9, -11, 18, 22, 4);
    ctx.fill();
    ctx.fillStyle = isGreen ? "#2d7d4f" : "#a33d35";
    ctx.beginPath();
    ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Two visible lights (EW and NS) near the intersection center.
  drawHead(centerPx.x - 14, centerPx.y, horizontalGreen);
  drawHead(centerPx.x + 14, centerPx.y, verticalGreen);
}

function drawTrafficLight(ctx, roadnet, phaseIndex, transform) {
  const centerInt = roadnet?.intersections?.find((i) => !i.virtual);
  if (!centerInt || !centerInt.point) {
    return;
  }
  
  const tl = getTrafficLightDisplay(phaseIndex);
  const mapped = mapPoint(centerInt.point, transform);
  
  // Draw semi-transparent background circle
  const radius = 38;
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.arc(mapped.x, mapped.y, radius, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw colored indicator based on phase
  const lightColor = tl.type === 'green' ? '#00dd44' : tl.type === 'yellow' ? '#ffdd00' : '#dd0000';
  const lightGlow = tl.type === 'green' ? '#00ff66' : tl.type === 'yellow' ? '#ffff00' : '#ff3333';
  
  ctx.fillStyle = lightColor;
  ctx.shadowColor = lightGlow;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(mapped.x, mapped.y, radius - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  
  // Draw direction text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tl.direction, mapped.x, mapped.y - 6);
  
  // Draw phase type text
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tl.type.toUpperCase(), mapped.x, mapped.y + 8);
}

function drawVehicles(ctx, vehicles, roadMetaMap, transform) {
  (vehicles || []).forEach((vehicle) => {
    const meta = vehicle.road ? roadMetaMap.get(vehicle.road) : null;
    const laneIndex = clamp(Number.isFinite(vehicle.laneIndex) ? vehicle.laneIndex : laneIndexFromVehicle(vehicle), 0, Math.max(0, (meta?.laneCount || 1) - 1));
    const rawHeading = vehicle.heading ?? Math.atan2(meta?.direction.y || 0, meta?.direction.x || 1);
    const heading = snapToRightAngle(rawHeading);
    const alpha = vehicle.alpha ?? 1;

    const laneOffset = (meta && !vehicle.flying)
      ? (-meta.roadWidth / 2) + meta.laneWidth * (laneIndex + 0.5)
      : 0;
    const normal = (meta && !vehicle.flying) ? meta.perp : { x: 0, y: 0 };
    const renderedPoint = meta
      ? offsetPoint({ x: vehicle.x, y: vehicle.y }, normal, laneOffset)
      : { x: vehicle.x, y: vehicle.y };
    const mapped = mapPoint(renderedPoint, transform);
    // Choose color by id hash to be stable
    const colorIndex = Math.abs(String(vehicle.id).split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)) % CAR_COLORS.length;
    const carColor = CAR_COLORS[colorIndex];

    // Scale vehicle dimensions by world-to-screen scale
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

    // nose marker
    ctx.fillStyle = "#ffffff66";
    ctx.beginPath();
    ctx.arc(carLength / 2 - Math.max(2, 1.2 * scale), 0, Math.max(1.6, 0.7 * scale), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  });
}

/* ---------- Mini sparkline chart (pure canvas) ---------- */

function SparkChart({ data, label, color = "#b2462e", height = 90, unit = "" }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !data.length) return;

    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const pad = { top: 8, bottom: 22, left: 4, right: 4 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const minV = Math.min(...data);
    const maxV = Math.max(...data);
    const range = Math.max(1e-6, maxV - minV);

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    gradient.addColorStop(0, color + "44");
    gradient.addColorStop(1, color + "05");

    ctx.beginPath();
    data.forEach((val, i) => {
      const x = pad.left + (i / Math.max(1, data.length - 1)) * plotW;
      const y = pad.top + plotH - ((val - minV) / range) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    // Fill under curve
    const lastX = pad.left + plotW;
    ctx.lineTo(lastX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    data.forEach((val, i) => {
      const x = pad.left + (i / Math.max(1, data.length - 1)) * plotW;
      const y = pad.top + plotH - ((val - minV) / range) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Current value label
    const latest = data[data.length - 1];
    ctx.fillStyle = "#5a4a3d";
    ctx.font = "600 11px Georgia, serif";
    ctx.textAlign = "right";
    ctx.fillText(`${latest.toFixed(1)}${unit}`, w - pad.right, h - 4);

    // Label
    ctx.fillStyle = "#7c6a59";
    ctx.font = "11px Georgia, serif";
    ctx.textAlign = "left";
    ctx.fillText(label, pad.left, h - 4);
  }, [data, color, height, label, unit]);

  return (
    <div className="spark-chart" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ---------- Road network canvas ---------- */

function RoadCanvas({ roadnet, vehicles, onResize, phaseIndex = 0, intersectionId = null, animated = true, focusIntersectionId = null }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const frameRef = useRef({ vehicles: [], phaseIndex: 0 });
  const renderTokenRef = useRef(0);

  useEffect(() => {
    if (!onResize) {
      return;
    }
    const updateSize = () => {
      if (!containerRef.current) {
        return;
      }
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
    if (!roadnet || !canvasRef.current || !containerRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const transform = buildTransform(roadnet, width, height, focusIntersectionId);
    if (!transform) {
      return;
    }

    const roadMetaMap = buildRoadMetaMap(roadnet);
    const nextFrame = {
      vehicles: (vehicles || []).map((vehicle) => ({ ...vehicle })),
      phaseIndex
    };
    const drawFrame = (frameVehicles, framePhaseIndex) => {
      ctx.clearRect(0, 0, width, height);
      (roadnet.roads || []).forEach((road) => {
        const meta = roadMetaMap.get(road.id);
        if (meta) {
          drawRoadSurface(ctx, road, transform, meta);
        }
      });
      drawTrafficLight(ctx, roadnet, framePhaseIndex, transform);
      drawVehicles(ctx, frameVehicles, roadMetaMap, transform);
    };
    frameRef.current = nextFrame;
    drawFrame(nextFrame.vehicles, nextFrame.phaseIndex);
    return undefined;
  }, [roadnet, vehicles, phaseIndex, intersectionId, animated, focusIntersectionId]);

  return (
    <div className="road-map" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ---------- Main application ---------- */

export default function App() {
  const [edges, setEdges] = useState([]);
  const [models, setModels] = useState([]);
  const [roadnet, setRoadnet] = useState(null);
  const [demandMap, setDemandMap] = useState({});
  const [controllerType, setControllerType] = useState("rl");
  const [modelId, setModelId] = useState("dqn");
  const [fixedTime, setFixedTime] = useState(30);
  const [duration, setDuration] = useState(300);
  const [seed, setSeed] = useState(42);
  const [status, setStatus] = useState("idle");
  const [jobId, setJobId] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [error, setError] = useState(null);
  const [demandSize, setDemandSize] = useState({ width: 900, height: 320 });
  const [replayMode, setReplayMode] = useState(false);
  const wsRef = useRef(null);

  // Called by ReplayPanel on each frame tick
  const handleReplayFrame = useCallback((frame, cursor, total) => {
    // Ignore replay ticks while a live run is starting/running.
    if (status === "starting" || status === "running") {
      return;
    }

    if (!replayMode) setReplayMode(true);
    setStatus("replaying");
    setJobId(null);
    setMetrics((prev) => {
      // Restart chart at replay head so graphs reset when play begins.
      if (cursor === 0) {
        return [frame];
      }
      return prev.length === cursor ? [...prev, frame] : prev.slice(0, cursor).concat(frame);
    });
    if (Array.isArray(frame.vehicles)) setVehicles(frame.vehicles);
  }, [replayMode, status]);

  // Called by ReplayPanel with all frames so charts render fully
  const handleReplayFullMetrics = useCallback((allFrames) => {
    setReplayMode(true);
    // Do not pre-fill full history; let playback build the chart from cursor.
    setMetrics([]);
    setVehicles([]);
    setError(null);
  }, []);

  useEffect(() => {
    getEdges(DEFAULT_ROADNET).then((data) => setEdges(data.edges || []));
    getModels().then((data) => {
      const items = data.models || [];
      setModels(items);
      if (items.length && !items.find((model) => model.id === modelId)) {
        setModelId(items[0].id);
      }
    });
    getRoadnet(DEFAULT_ROADNET).then((data) => setRoadnet(data));
  }, []);

  const edgeOptions = useMemo(() => edges.filter(Boolean), [edges]);
  const roadMap = useMemo(() => {
    const map = {};
    (roadnet?.roads || []).forEach((road) => {
      map[road.id] = road;
    });
    return map;
  }, [roadnet]);

  const demandAnchors = useMemo(() => {
    if (!roadnet || !demandSize.width || !demandSize.height) {
      return [];
    }
    const transform = buildTransform(roadnet, demandSize.width, demandSize.height);
    if (!transform) {
      return [];
    }
    return edgeOptions
      .map((edge) => {
        const road = roadMap[edge];
        if (!road || !road.points?.length) {
          return null;
        }
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
          y: mappedFirst.y + (dy / length) * along + ny * offset
        };
        return {
          edge,
          left: mapped.x,
          top: mapped.y
        };
      })
      .filter(Boolean);
  }, [edgeOptions, roadMap, roadnet, demandSize]);

  useEffect(() => {
    if (!edgeOptions.length) {
      return;
    }
    setDemandMap((prev) => {
      if (Object.keys(prev).length) {
        return prev;
      }
      const initial = {};
      edgeOptions.forEach((edge) => {
        initial[edge] = 8;
      });
      return initial;
    });
  }, [edgeOptions]);

  const adjustRate = (edge, delta) => {
    setDemandMap((prev) => {
      const next = { ...prev };
      const current = next[edge] ?? 0;
      next[edge] = Math.max(0, Math.min(60, current + delta));
      return next;
    });
  };

  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId),
    [models, modelId]
  );

  // Extract time-series data from metrics for charts
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

    // Close any existing WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const payload = {
      roadnet_id: DEFAULT_ROADNET,
      demand: {
        entries: Object.entries(demandMap)
          .filter(([, rate]) => rate > 0)
          .map(([edge, rate]) => ({ edge, rate }))
      },
      controller: {
        type: controllerType,
        model_id: controllerType === "rl" ? modelId : null,
        fixed_time_s: fixedTime
      },
      duration_s: duration,
      seed: seed
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
        // Handle completion/error signals
        if (data.type === "done") {
          setStatus(data.status === "error" ? "error" : "completed");
          if (data.detail) {
            setError(data.detail);
          }
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
        // If status is still "running" when WS closes, mark completed
        setStatus((prev) => (prev === "running" ? "completed" : prev));
      };
    } catch (err) {
      setError(err.message);
      setStatus("idle");
    }
  };

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="kicker">Traffic Deploy Simulator</p>
          <h1>Watch RL agents learn to control traffic — live.</h1>
          <p className="subtext">
            Configure demand, pick an agent type, and watch it learn online as
            vehicles flow through the intersection.
          </p>
        </div>
        <div className="status-card">
          <div className="status-title">Run Status</div>
          <div className={`status-pill status-${status}`}>{status}</div>
          {jobId && <div className="status-meta">Job: {jobId}</div>}
          {latestMetric && status === "running" && (
            <div className="status-meta">
              Step {latestMetric.step} / {duration}
            </div>
          )}
          {error && <div className="status-error">{error}</div>}
        </div>
      </header>

      <section className="panel">
        <h2>Demand Builder</h2>
        <div className="demand-map">
          {roadnet ? (
            <>
              <RoadCanvas
                roadnet={roadnet}
                vehicles={[]}
                onResize={setDemandSize}
                animated={false}
                focusIntersectionId={DEFAULT_FOCUS_INTERSECTION}
              />
              <div className="demand-overlay">
                {demandAnchors.map((anchor) => (
                  <div
                    className="edge-control"
                    key={anchor.edge}
                    style={{ left: anchor.left, top: anchor.top }}
                  >
                    <div className="edge-label">{anchor.edge}</div>
                    <div className="edge-rate">{demandMap[anchor.edge] || 0}</div>
                    <div className="edge-buttons">
                      <button className="ghost" onClick={() => adjustRate(anchor.edge, -2)}>
                        -
                      </button>
                      <button className="ghost" onClick={() => adjustRate(anchor.edge, 2)}>
                        +
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">Loading roadnet...</div>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Controller</h2>
        <div className="controller-grid">
          <label>
            Strategy
            <select value={controllerType} onChange={(e) => setControllerType(e.target.value)}>
              <option value="rl">RL Agent (online learning)</option>
              <option value="fixed_time">Fixed time</option>
              <option value="random">Random</option>
            </select>
          </label>
          {controllerType === "rl" && (
            <label>
              Agent Type
              <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              {selectedModel?.description && (
                <span className="field-hint">{selectedModel.description}</span>
              )}
            </label>
          )}
          {controllerType === "fixed_time" && (
            <label>
              Phase duration (s)
              <input
                type="number"
                min="5"
                value={fixedTime}
                onChange={(e) => setFixedTime(Number(e.target.value))}
              />
            </label>
          )}
          <label>
            Duration (steps)
            <input
              type="number"
              min="50"
              max="3600"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
          <label>
            Seed
            <input
              type="number"
              min="0"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="live-header">
          <h2>{isReplaying ? "Replay" : "Live Simulation"}</h2>
          <div className={`live-indicator ${status === "running" ? "live-on" : status === "replaying" ? "live-replay" : status === "completed" ? "live-done" : "live-off"}`}>
            <span className="live-dot" />
            {status === "running" ? "Learning" : status === "replaying" ? "Replaying" : status === "completed" ? "Done" : "Idle"}
          </div>
        </div>
        <div className="live-map">
          {roadnet ? (
            <RoadCanvas
              roadnet={roadnet}
              vehicles={vehicles}
              phaseIndex={latestMetric?.phase_index ?? 0}
              intersectionId={latestMetric?.intersection_id ?? null}
              focusIntersectionId={latestMetric?.intersection_id || DEFAULT_FOCUS_INTERSECTION}
            />
          ) : (
            <div className="empty">Loading roadnet...</div>
          )}
        </div>

        {/* KPI summary row */}
        {latestMetric && (
          <div className="kpi-row">
            <div className="kpi">
              <div className="kpi-label">Queue</div>
              <div className="kpi-value">{latestMetric.queue_length}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Throughput</div>
              <div className="kpi-value">{latestMetric.throughput}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Avg Wait</div>
              <div className="kpi-value">{latestMetric.mean_wait_s.toFixed(1)}s</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Reward</div>
              <div className="kpi-value">{latestMetric.reward.toFixed(1)}</div>
            </div>
            {latestMetric.epsilon != null && (
              <div className="kpi">
                <div className="kpi-label">ε (explore)</div>
                <div className="kpi-value">{latestMetric.epsilon.toFixed(3)}</div>
              </div>
            )}
            <div className="kpi">
              <div className="kpi-label">Phase</div>
              <div className="kpi-value">{latestMetric.phase_index}</div>
            </div>
          </div>
        )}

        {/* Learning curves */}
        {chartData.queue.length > 1 && (
          <div className="charts-grid">
            <SparkChart data={chartData.queue} label="Queue Length" color="#b2462e" />
            <SparkChart data={chartData.throughput} label="Throughput" color="#3a7d5e" />
            <SparkChart data={chartData.reward} label="Reward" color="#6a4dba" />
            <SparkChart data={chartData.wait} label="Avg Wait" color="#c08830" unit="s" />
            {chartData.epsilon.some((v) => v > 0) && (
              <SparkChart data={chartData.epsilon} label="Epsilon" color="#2a7aaf" />
            )}
          </div>
        )}

        {/* Live feed */}
        {metrics.length > 0 && (
          <div className="live-feed">
            {metrics.slice(-12).map((m) => (
              <div className="live-row" key={`live-${m.step}`}>
                <span>t={m.step}</span>
                <span>queue {m.queue_length}</span>
                <span>reward {m.reward?.toFixed(1) ?? "-"}</span>
                <span>ε {m.epsilon?.toFixed(3) ?? "-"}</span>
                <span>wait {m.mean_wait_s.toFixed(1)}s</span>
              </div>
            ))}
          </div>
        )}
        {!metrics.length && <div className="empty">No data yet. Start a run to begin online learning.</div>}
      </section>

      <ReplayPanel
        roadnet={roadnet}
        onFrame={handleReplayFrame}
        onFullMetrics={handleReplayFullMetrics}
      />

      <footer className="actions">
        <button
          className="primary"
          onClick={startSimulation}
          disabled={status === "running" || status === "starting"}
        >
          {status === "running" ? "Running…" : "Start Simulation"}
        </button>
        <button
          className="ghost"
          onClick={() => {
            // Inject some test vehicles around the central intersection to verify rendering
            if (!roadnet) return;
            const center = roadnet.intersections.find((i) => i.point && i.roadLinks && !i.virtual);
            if (!center) return;
            const cx = center.point.x;
            const cy = center.point.y;
            const sample = [
              { id: 'debug_1', road: 'road_0_1_0', drivable: 'road_0_1_0_0', x: cx - 40, y: cy, speed: 6 },
              { id: 'debug_2', road: 'road_1_1_0', drivable: 'road_1_1_0_1', x: cx + 40, y: cy, speed: 6 },
              { id: 'debug_3', road: 'road_1_0_1', drivable: 'road_1_0_1_1', x: cx, y: cy - 40, speed: 6 },
              { id: 'debug_4', road: 'road_1_1_1', drivable: 'road_1_1_1_2', x: cx, y: cy + 40, speed: 6 }
            ];
            setVehicles(sample);
          }}
        >
          Inject Test Vehicles
        </button>
      </footer>
    </div>
  );
}
