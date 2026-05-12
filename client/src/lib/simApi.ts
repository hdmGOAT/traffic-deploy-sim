export const API_BASE = import.meta.env.VITE_API_BASE || "/api";

function buildUrl(path: string) {
  if (API_BASE.endsWith("/") && path.startsWith("/")) {
    return API_BASE.slice(0, -1) + path;
  }
  if (!API_BASE.endsWith("/") && !path.startsWith("/")) {
    return `${API_BASE}/${path}`;
  }
  return API_BASE + path;
}

function resolveWsBase() {
  if (API_BASE.startsWith("http")) {
    return API_BASE.replace(/^http/, "ws");
  }
  if (typeof window === "undefined") {
    return "";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${API_BASE.startsWith("/") ? "" : "/"}${API_BASE}`;
}

export type ModelInfo = { id: string; name: string; description?: string };
export type EdgeListResponse = { edges: string[] };
export type ModelsResponse = { models: ModelInfo[] };
export type SimulationSummary = {
  id: string;
  status: string;
  controller_type?: string;
  model_id?: string;
  steps?: number;
};
export type SimulationsResponse = { simulations: SimulationSummary[] };

export async function getModels() {
  const res = await fetch(buildUrl("/models"), { cache: "no-store" });
  return res.json() as Promise<ModelsResponse>;
}

export async function getEdges(roadnetId: string) {
  const res = await fetch(
    buildUrl(`/roadnet/edges?roadnet_id=${encodeURIComponent(roadnetId)}`),
    { cache: "no-store" }
  );
  return res.json() as Promise<EdgeListResponse>;
}

export async function getRoadnet(roadnetId: string) {
  const res = await fetch(
    buildUrl(`/roadnet?roadnet_id=${encodeURIComponent(roadnetId)}`),
    { cache: "no-store" }
  );
  return res.json();
}

export async function createSimulation(payload: unknown) {
  const res = await fetch(buildUrl("/simulations"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json();
    throw new Error(detail.detail || "Failed to start simulation");
  }
  return res.json();
}

export async function listSimulations() {
  const res = await fetch(buildUrl("/simulations"), { cache: "no-store" });
  return res.json() as Promise<SimulationsResponse>;
}

export async function getSimulationMetrics(jobId: string) {
  const res = await fetch(buildUrl(`/simulations/${jobId}/metrics`), { cache: "no-store" });
  return res.json();
}

export function openSimulationStream(jobId: string) {
  const wsBase = resolveWsBase();
  if (!wsBase) {
    throw new Error("WebSocket base unavailable in server context");
  }
  return new WebSocket(`${wsBase.replace(/\/$/, "")}/simulations/${jobId}/stream`);
}

export async function cancelSimulation(jobId: string) {
  const res = await fetch(buildUrl(`/simulations/${jobId}`), { method: "DELETE" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.detail || "Failed to cancel simulation");
  }
  return res.json().catch(() => ({}));
}
