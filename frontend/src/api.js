const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export async function getModels() {
  const res = await fetch(`${API_BASE}/models`, { cache: "no-store" });
  return res.json();
}

export async function getEdges(roadnetId) {
  const res = await fetch(`${API_BASE}/roadnet/edges?roadnet_id=${encodeURIComponent(roadnetId)}`, { cache: "no-store" });
  return res.json();
}

export async function getRoadnet(roadnetId) {
  const res = await fetch(`${API_BASE}/roadnet?roadnet_id=${encodeURIComponent(roadnetId)}`, { cache: "no-store" });
  return res.json();
}

export async function createSimulation(payload) {
  const res = await fetch(`${API_BASE}/simulations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.json();
    throw new Error(detail.detail || "Failed to start simulation");
  }
  return res.json();
}

export async function listSimulations() {
  const res = await fetch(`${API_BASE}/simulations`, { cache: "no-store" });
  return res.json();
}

export async function getSimulationMetrics(jobId) {
  const res = await fetch(`${API_BASE}/simulations/${jobId}/metrics`, { cache: "no-store" });
  return res.json();
}

export function openSimulationStream(jobId) {
  const wsBase = API_BASE.replace("http", "ws");
  return new WebSocket(`${wsBase}/simulations/${jobId}/stream`);
}
