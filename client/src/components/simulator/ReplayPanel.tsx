import React, { useCallback, useEffect, useRef, useState } from "react";
import { getSimulationMetrics, listSimulations } from "@/lib/simApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8];

type ReplayPanelProps = {
  onFrame: (frame: any, cursor: number, total: number) => void;
  onFullMetrics?: (frames: any[]) => void;
  onReplayConfig?: (config: any, demand: any) => void;
};

export function ReplayPanel({ onFrame, onFullMetrics, onReplayConfig }: ReplayPanelProps) {
  const [history, setHistory] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [allFrames, setAllFrames] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    listSimulations().then((data) => {
      const completed = (data.simulations || []).filter(
        (s) => s.status === "completed" && (s.steps || 0) > 0
      );
      setHistory(completed.reverse());
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadReplay = useCallback(
    async (id: string) => {
      setPlaying(false);
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      setActiveId(id);
      setCursor(0);
      const data = await getSimulationMetrics(id);
      const frames = data.metrics || [];
      setAllFrames(frames);
      onFullMetrics?.(frames);
      if (frames.length) onFrame(frames[0], 0, frames.length);
      if (data.config && data.demand && typeof onReplayConfig === 'function') {
        onReplayConfig(data.config, data.demand);
      }
    },
    [onFrame, onFullMetrics, onReplayConfig]
  );

  useEffect(() => {
    if (!playing || !allFrames.length) return;
    const interval = 80 / speed;
    timerRef.current = window.setInterval(() => {
      setCursor((prev) => {
        const next = prev + 1;
        if (next >= allFrames.length) {
          setPlaying(false);
          if (timerRef.current) window.clearInterval(timerRef.current);
          return prev;
        }
        onFrame(allFrames[next], next, allFrames.length);
        return next;
      });
    }, interval);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [playing, speed, allFrames, onFrame]);

  const scrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const pos = Number(e.target.value);
    setCursor(pos);
    if (allFrames[pos]) onFrame(allFrames[pos], pos, allFrames.length);
  };

  const togglePlay = () => {
    if (cursor >= allFrames.length - 1) {
      setCursor(0);
      if (allFrames[0]) onFrame(allFrames[0], 0, allFrames.length);
    }
    setPlaying((p) => !p);
  };

  return (
    <Card className="rounded-[20px] border-border/60 bg-surface-container-low shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Replay
        </CardTitle>
        <Button variant="outline" className="h-8 rounded-full text-xs font-semibold" onClick={refresh}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!history.length && (
          <div className="rounded-xl border border-dashed border-border/60 bg-surface-bright p-4 text-sm text-muted-foreground">
            No completed simulations yet. Run one first.
          </div>
        )}

        {history.length > 0 && (
          <div className="grid max-h-48 gap-2 overflow-y-auto pr-1">
            {history.map((sim) => (
              <button
                key={sim.id}
                onClick={() => loadReplay(sim.id)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                  activeId === sim.id
                    ? "border-primary/60 bg-surface-container-high"
                    : "border-border/60 bg-surface-bright hover:border-border"
                }`}
              >
                <span className="font-medium text-foreground">{sim.id}</span>
                <span className="text-muted-foreground">
                  {sim.controller_type === "rl" ? sim.model_id || "rl" : sim.controller_type}
                  {" · "}{sim.steps} steps
                </span>
              </button>
            ))}
          </div>
        )}

        {activeId && allFrames.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-surface-bright px-3 py-3">
            <Button variant="outline" className="h-8 w-8 rounded-full" onClick={togglePlay}>
              {playing ? "⏸" : "▶"}
            </Button>
            <input
              className="h-2 flex-1 accent-primary"
              type="range"
              min={0}
              max={allFrames.length - 1}
              value={cursor}
              onChange={scrub}
            />
            <span className="min-w-[60px] text-xs text-muted-foreground">
              {cursor + 1}/{allFrames.length}
            </span>
            <select
              className="rounded-full border border-border/60 bg-surface-container-low px-2 py-1 text-xs"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
