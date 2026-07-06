import { useSyncExternalStore } from "react";
import {
  CLUSTER_NODES,
  fetchNodeInfo,
  probeNode,
  startWorker,
  stopWorker,
  type ClusterNode,
} from "./api";

export interface ClusterNodeState extends ClusterNode {
  online: boolean;
  busy: boolean;
}

interface Store {
  nodes: ClusterNodeState[];
  customEpochMs: number;
  totalGenerated: number;
  scanning: boolean;
  pollingPaused: boolean;
}

const DEFAULT_EPOCH_MS = Date.UTC(2026, 0, 1); // fallback until a live node reports the real CUSTOM_EPOCH

const state: Store = {
  nodes: CLUSTER_NODES.map((n) => ({ ...n, online: false, busy: false })),
  customEpochMs: DEFAULT_EPOCH_MS,
  totalGenerated: 0,
  scanning: false,
  pollingPaused: false,
};

const listeners = new Set<() => void>();
let snapshot: Store = cloneState();

function cloneState(): Store {
  return { ...state, nodes: state.nodes.map((n) => ({ ...n })) };
}

function emit() {
  snapshot = cloneState();
  listeners.forEach((l) => l());
}

export const clusterStore = {
  get: () => snapshot,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  getOnlineNodes(): ClusterNodeState[] {
    return state.nodes.filter((n) => n.online && !n.busy);
  },

  getNode(workerId: number): ClusterNodeState | undefined {
    return state.nodes.find((n) => n.workerId === workerId);
  },

  addGenerated(n: number) {
    state.totalGenerated += n;
    emit();
  },

  /** Lets a heavy client-side load test (Firehose) tell the background cluster
   * poller to back off — its own /api/info probes would otherwise share the
   * same saturated JS thread as the test and can time out, falsely marking
   * healthy nodes as offline. */
  setPollingPaused(paused: boolean) {
    state.pollingPaused = paused;
    emit();
  },

  /** Probes every node's /api/info in parallel; also picks up the real custom epoch. */
  async scan() {
    state.scanning = true;
    emit();

    const results = await Promise.all(
      CLUSTER_NODES.map(async (node) => {
        try {
          const info = await fetchNodeInfo(node.url);
          return {
            workerId: node.workerId,
            online: true,
            epochMs: new Date(info.custom_epoch).getTime(),
          };
        } catch {
          return { workerId: node.workerId, online: false, epochMs: null as number | null };
        }
      }),
    );

    for (const r of results) {
      const node = state.nodes.find((n) => n.workerId === r.workerId);
      if (node) node.online = r.online;
      if (r.epochMs !== null) state.customEpochMs = r.epochMs;
    }

    state.scanning = false;
    emit();
  },

  /** Turns a worker on/off via the real Docker-management API, routed through
   * a different online node so a node is never asked to stop itself. */
  async toggle(workerId: number) {
    const node = state.nodes.find((n) => n.workerId === workerId);
    if (!node || node.busy) return;

    const turningOff = node.online;
    node.busy = true;
    emit();

    const controlNode = state.nodes.find((n) => n.online && !n.busy && n.workerId !== workerId);
    const controlUrl = controlNode ? controlNode.url : node.url;

    try {
      if (turningOff) {
        await stopWorker(controlUrl, workerId);
      } else {
        await startWorker(controlUrl, workerId, node.port);
      }
    } catch (err) {
      node.busy = false;
      emit();
      throw err;
    }

    // Docker start/stop is async; poll briefly for the real state to settle.
    const expectedOnline = !turningOff;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      node.online = await probeNode(node.url, 1500);
      if (node.online === expectedOnline) break;
    }

    node.busy = false;
    emit();
  },
};

export function useClusterStore() {
  return useSyncExternalStore(clusterStore.subscribe, clusterStore.get, clusterStore.get);
}
