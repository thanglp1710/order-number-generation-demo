// Client for the order-number-generator-demo backend (Go/Gin).
// The backend is a cluster of up to 16 independent nodes, each a separate
// process/container listening on its own port (8080..8095), each holding a
// fixed Worker ID (0..15). This module never generates IDs itself — every ID
// comes from a real HTTP call to one of those nodes.

export const CLUSTER_SIZE = 16;
export const BASE_PORT = 8080;

export interface ClusterNode {
  workerId: number;
  port: number;
  url: string;
}

export function nodeUrl(workerId: number): string {
  return `http://localhost:${BASE_PORT + workerId}`;
}

export const CLUSTER_NODES: ClusterNode[] = Array.from({ length: CLUSTER_SIZE }, (_, workerId) => ({
  workerId,
  port: BASE_PORT + workerId,
  url: nodeUrl(workerId),
}));

export interface NodeInfo {
  worker_id: number;
  custom_epoch: string;
}

export async function fetchNodeInfo(url: string, timeoutMs = 2000): Promise<NodeInfo> {
  const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function probeNode(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface GenerateResponse {
  order_number: string;
}

export async function generateOne(url: string): Promise<string> {
  const res = await fetch(`${url}/generate`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: GenerateResponse = await res.json();
  return data.order_number;
}

export interface BatchResponse {
  order_numbers: string[];
}

export async function generateBatchReal(url: string, count: number): Promise<string[]> {
  const res = await fetch(`${url}/generate/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const data: BatchResponse = await res.json();
  return data.order_numbers;
}

// Docker-management endpoints — real container start/stop, gracefully resuming
// an existing container by worker ID instead of recreating it.
export async function startWorker(
  controlUrl: string,
  workerId: number,
  port: number,
): Promise<void> {
  const res = await fetch(`${controlUrl}/api/docker/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worker_id: workerId, port }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}

export async function stopWorker(controlUrl: string, workerId: number): Promise<void> {
  const res = await fetch(`${controlUrl}/api/docker/instances?worker_id=${workerId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}
