import React, { useEffect, useRef } from "react";

type SparkChartProps = {
  data: number[];
  label: string;
  color?: string;
  height?: number;
  unit?: string;
};

export function SparkChart({ data, label, color = "#b2462e", height = 90, unit = "" }: SparkChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    const lastX = pad.left + plotW;
    ctx.lineTo(lastX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

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

    const latest = data[data.length - 1];
    ctx.fillStyle = "#5a4a3d";
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${latest.toFixed(1)}${unit}`, w - pad.right, h - 4);

    ctx.fillStyle = "#7c6a59";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, pad.left, h - 4);
  }, [data, color, height, label, unit]);

  return (
    <div ref={containerRef} className="h-[90px] w-full overflow-hidden rounded-xl border border-border/60 bg-surface-bright p-2 shadow-sm">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
