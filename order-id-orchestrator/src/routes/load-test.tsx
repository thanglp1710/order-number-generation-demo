import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Shell, Stat } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clusterStore, useClusterStore } from "@/lib/store";
import { verifyLuhn } from "@/lib/snowflake";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { Gauge, Play, Square } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/load-test")({
  head: () => ({ meta: [{ title: "Firehose Stress Test · Order Number Generator" }] }),
  component: LoadTestPage,
});

const PER_NODE_MAX = 800; // documented, real per-node design cap (16 IDs / 20ms)
const WINDOW_MS = 2000;

interface Sample {
  t: number;
  rps: number;
  avgLatencyMs: number;
  totalGenerated: number;
}
interface LatencyPoint {
  val: number;
  ts: number;
}

function LoadTestPage() {
  const { nodes } = useClusterStore();
  const onlineNodes = nodes.filter((n) => n.online);

  const [concurrency, setConcurrency] = useState(50);
  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [live, setLive] = useState({ rps: 0, avg: 0, p95: 0, total: 0, errors: 0, luhnOk: 0 });
  const [warning, setWarning] = useState<string | null>(null);
  // Node count actually being hammered by the running test, captured at Start.
  // The live `onlineNodes` count is NOT safe to read while a heavy test is
  // running: the background cluster-health poll (Shell.tsx, every 5s) shares
  // this same saturated JS thread, so its /api/info probes can time out and
  // falsely report nodes as offline — even though this test's own requests to
  // those same nodes are succeeding fine. Using a frozen count avoids the
  // "% Giới hạn lý thuyết" and "node online" display flickering to 0 as a
  // side effect of that unrelated false alarm.
  const [activeNodeCount, setActiveNodeCount] = useState<number | null>(null);

  const runningRef = useRef(false);
  const startRef = useRef(0);
  const totalRef = useRef(0);
  const errorsRef = useRef(0);
  const luhnOkRef = useRef(0);
  const latenciesRef = useRef<LatencyPoint[]>([]);
  const uiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      runningRef.current = false;
      if (uiTimerRef.current) clearInterval(uiTimerRef.current);
      clusterStore.setPollingPaused(false); // in case the user navigates away mid-test
    },
    [],
  );

  function tickUI() {
    const now = performance.now();
    latenciesRef.current = latenciesRef.current.filter((l) => l.ts > now - WINDOW_MS);
    const recent = latenciesRef.current;
    const rps = recent.length / (WINDOW_MS / 1000);

    let avg = 0;
    let p95 = 0;
    if (recent.length > 0) {
      const sorted = recent.map((l) => l.val).sort((a, b) => a - b);
      avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    }

    setLive({
      rps,
      avg,
      p95,
      total: totalRef.current,
      errors: errorsRef.current,
      luhnOk: luhnOkRef.current,
    });
    setSamples((prev) =>
      [
        ...prev,
        {
          t: Math.round((now - startRef.current) / 100) / 10,
          rps,
          avgLatencyMs: avg,
          totalGenerated: totalRef.current,
        },
      ].slice(-300),
    );
  }

  async function fireOne(nodes: typeof onlineNodes, nodeIndexRef: { i: number }) {
    if (!runningRef.current) return;
    const node = nodes[nodeIndexRef.i % nodes.length];
    nodeIndexRef.i++;

    const t0 = performance.now();
    try {
      const res = await fetch(`${node.url}/generate`, { method: "POST" });
      const latency = performance.now() - t0;
      if (!runningRef.current) return;
      totalRef.current++;
      latenciesRef.current.push({ val: latency, ts: performance.now() });
      if (res.ok) {
        const data = await res.json();
        if (verifyLuhn(data.order_number)) luhnOkRef.current++;
      } else {
        errorsRef.current++;
      }
    } catch {
      if (!runningRef.current) return;
      totalRef.current++;
      errorsRef.current++;
      latenciesRef.current.push({ val: performance.now() - t0, ts: performance.now() });
    }

    fireOne(nodes, nodeIndexRef);
  }

  const start = () => {
    if (!onlineNodes.length) return toast.error("Cần ít nhất 1 Worker Online");
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      setWarning(`LỖI: concurrency phải là số nguyên >= 1.`);
      return;
    }

    if (concurrency > PER_NODE_MAX) {
      setWarning(
        `⚠ CẢNH BÁO: concurrency ${concurrency} vượt trần thiết kế ${PER_NODE_MAX} req/s/node — RPS/Latency dưới đây phản ánh ` +
          `nghẽn luồng JS của trình duyệt, không phải giới hạn thật của Backend. Dùng k6 để đo tải vượt ngưỡng 1 trình duyệt.`,
      );
    } else {
      setWarning(null);
    }

    runningRef.current = true;
    setRunning(true);
    setActiveNodeCount(onlineNodes.length);
    clusterStore.setPollingPaused(true);
    startRef.current = performance.now();
    totalRef.current = 0;
    errorsRef.current = 0;
    luhnOkRef.current = 0;
    latenciesRef.current = [];
    setSamples([]);
    setLive({ rps: 0, avg: 0, p95: 0, total: 0, errors: 0, luhnOk: 0 });

    const nodeIndexRef = { i: 0 };
    const totalConcurrency = onlineNodes.length * concurrency;
    for (let i = 0; i < totalConcurrency; i++) fireOne(onlineNodes, nodeIndexRef);

    uiTimerRef.current = setInterval(tickUI, 500);
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setActiveNodeCount(null);
    clusterStore.setPollingPaused(false);
    if (uiTimerRef.current) {
      clearInterval(uiTimerRef.current);
      uiTimerRef.current = null;
    }
    clusterStore.addGenerated(totalRef.current);
    toast.success(
      `Đã dừng. Tổng: ${totalRef.current.toLocaleString()} mã · Lỗi: ${errorsRef.current}`,
    );
  };

  const displayedNodeCount =
    running && activeNodeCount !== null ? activeNodeCount : onlineNodes.length;
  const theoreticalMax = displayedNodeCount * PER_NODE_MAX;
  const pct = theoreticalMax > 0 ? Math.min(100, (live.rps / theoreticalMax) * 100) : 0;

  return (
    <Shell
      title="Firehose Stress Test"
      subtitle="Đổ tải HTTP thật liên tục vào các Worker đang Online, đo throughput/latency trực tiếp."
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-1 rounded-xl border border-border bg-card/70 backdrop-blur p-5 space-y-5">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Concurrency / node (khuyến nghị ≤ {PER_NODE_MAX})
            </label>
            <Input
              type="number"
              min={1}
              value={concurrency}
              onChange={(e) => {
                setConcurrency(Number(e.target.value));
                setWarning(null);
              }}
              className="mt-1.5 font-mono"
              disabled={running}
            />
          </div>
          <div className="text-xs text-muted-foreground border-t border-border pt-3">
            {displayedNodeCount} node {running ? "đang bắn tải" : "online"} · trần lý thuyết{" "}
            {theoreticalMax.toLocaleString()} req/s
            {running && (
              <span className="block mt-1 text-[11px] opacity-70">
                (chốt tại thời điểm bắt đầu — không đọc theo trạng thái quét nền để tránh nhiễu)
              </span>
            )}
          </div>
          {warning && (
            <div className="text-xs rounded-md border border-[oklch(0.80_0.16_75)]/30 bg-[oklch(0.80_0.16_75)]/10 text-[oklch(0.80_0.16_75)] p-3">
              {warning}
            </div>
          )}
          {!running ? (
            <Button onClick={start} disabled={!onlineNodes.length} className="w-full gap-2">
              <Play className="w-4 h-4" />
              Bắt đầu Firehose
            </Button>
          ) : (
            <Button onClick={stop} variant="destructive" className="w-full gap-2">
              <Square className="w-4 h-4" />
              Dừng
            </Button>
          )}
        </div>

        <div className="lg:col-span-2 grid grid-cols-2 gap-4 content-start">
          <Stat label="RPS" value={Math.round(live.rps).toLocaleString()} tone="primary" />
          <Stat
            label="% Giới hạn lý thuyết"
            value={`${pct.toFixed(0)}%`}
            tone={pct >= 80 ? "warning" : "accent"}
          />
          <Stat label="Avg Latency" value={`${live.avg.toFixed(1)} ms`} />
          <Stat label="p95 Latency" value={`${live.p95.toFixed(1)} ms`} tone="warning" />
          <Stat label="Tổng đã sinh" value={live.total.toLocaleString()} tone="accent" />
          <Stat label="Lỗi" value={live.errors} tone={live.errors ? undefined : "accent"} />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card/70 backdrop-blur p-5">
        <div className="flex items-center gap-2 mb-4">
          <Gauge className="w-4 h-4 text-primary" />
          <span className="font-semibold">
            RPS, Latency &amp; Tổng mã sinh ra theo thời gian (cửa sổ sống 2s)
          </span>
          {running && (
            <span className="ml-auto text-xs text-primary animate-pulse">● đang chạy</span>
          )}
        </div>
        <div className="h-72">
          {samples.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={samples} margin={{ right: 8 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  stroke="var(--color-muted-foreground)"
                  fontSize={11}
                  tickFormatter={(v) => `${v}s`}
                />
                <YAxis
                  yAxisId="rate"
                  stroke="var(--color-muted-foreground)"
                  fontSize={11}
                  label={{
                    value: "RPS / ms",
                    angle: -90,
                    position: "insideLeft",
                    fontSize: 11,
                    fill: "var(--color-muted-foreground)",
                  }}
                />
                <YAxis
                  yAxisId="cumulative"
                  orientation="right"
                  stroke="var(--color-muted-foreground)"
                  fontSize={11}
                  tickFormatter={(v) => v.toLocaleString()}
                  label={{
                    value: "Tổng mã sinh ra",
                    angle: 90,
                    position: "insideRight",
                    fontSize: 11,
                    fill: "var(--color-muted-foreground)",
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v: number, k: string) => {
                    if (k === "rps") return [`${v.toFixed(0)}/s`, "RPS"];
                    if (k === "avgLatencyMs") return [`${v.toFixed(1)} ms`, "Avg Latency"];
                    return [v.toLocaleString(), "Tổng mã sinh ra"];
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(k: string) =>
                    k === "rps" ? "RPS" : k === "avgLatencyMs" ? "Avg Latency" : "Tổng mã sinh ra"
                  }
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="rps"
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="avgLatencyMs"
                  stroke="var(--color-accent)"
                  strokeWidth={1.5}
                  dot={false}
                />
                <Line
                  yAxisId="cumulative"
                  type="monotone"
                  dataKey="totalGenerated"
                  stroke="oklch(0.80 0.16 75)"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full grid place-items-center text-muted-foreground text-sm">
              Chưa có dữ liệu — bắt đầu Firehose để xem biểu đồ
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
