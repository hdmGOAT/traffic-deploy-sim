import React, { useCallback, useEffect, useRef, useState } from "react";
import { listSimulations, getSimulationMetrics } from "./api.js";

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8];

export default function ReplayPanel({ roadnet, onFrame, onFullMetrics }) {
  const [history, setHistory] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [allFrames, setAllFrames] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timerRef = useRef(null);

  // Fetch history list
  const refresh = useCallback(() => {
    listSimulations().then((data) => {
      const completed = (data.simulations || []).filter(
        (s) => s.status === "completed" && s.steps > 0
      );
      setHistory(completed.reverse());
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Load metrics for a selected sim
  const loadReplay = useCallback(async (id) => {
    setPlaying(false);
    clearInterval(timerRef.current);
    setActiveId(id);
    setCursor(0);
    const data = await getSimulationMetrics(id);
    const frames = data.metrics || [];
    setAllFrames(frames);
    if (onFullMetrics) onFullMetrics(frames);
    if (frames.length) onFrame(frames[0], 0, frames.length);
  }, [onFrame, onFullMetrics]);

  // Playback tick
  useEffect(() => {
    if (!playing || !allFrames.length) return;
    const interval = 80 / speed;
    timerRef.current = setInterval(() => {
      setCursor((prev) => {
        const next = prev + 1;
        if (next >= allFrames.length) {
          setPlaying(false);
          clearInterval(timerRef.current);
          return prev;
        }
        onFrame(allFrames[next], next, allFrames.length);
        return next;
      });
    }, interval);
    return () => clearInterval(timerRef.current);
  }, [playing, speed, allFrames, onFrame]);

  // Scrub to position
  const scrub = (e) => {
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

  if (!history.length) {
    return (
      <div className="panel replay-panel">
        <h2>Replay</h2>
        <div className="empty">No completed simulations yet. Run one first.</div>
        <button className="ghost replay-refresh" onClick={refresh}>Refresh</button>
      </div>
    );
  }

  return (
    <div className="panel replay-panel">
      <div className="replay-header">
        <h2>Replay</h2>
        <button className="ghost replay-refresh" onClick={refresh}>↻</button>
      </div>

      {/* History list */}
      <div className="replay-list">
        {history.map((sim) => (
          <button
            key={sim.id}
            className={`replay-item ${activeId === sim.id ? "replay-active" : ""}`}
            onClick={() => loadReplay(sim.id)}
          >
            <span className="replay-item-id">{sim.id}</span>
            <span className="replay-item-meta">
              {sim.controller_type === "rl" ? sim.model_id || "rl" : sim.controller_type}
              {" · "}
              {sim.steps} steps
            </span>
          </button>
        ))}
      </div>

      {/* Playback controls */}
      {activeId && allFrames.length > 0 && (
        <div className="replay-controls">
          <button className="ghost replay-play" onClick={togglePlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <input
            className="replay-scrubber"
            type="range"
            min={0}
            max={allFrames.length - 1}
            value={cursor}
            onChange={scrub}
          />
          <span className="replay-pos">
            {cursor + 1}/{allFrames.length}
          </span>
          <select
            className="replay-speed"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
