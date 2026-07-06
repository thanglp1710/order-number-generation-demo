import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Shell, Stat } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clusterStore, useClusterStore } from "@/lib/store";
import { generateOne } from "@/lib/api";
import { decodeOrderNumber } from "@/lib/snowflake";
import { toast } from "sonner";
import { Layers, Play } from "lucide-react";

export const Route = createFileRoute("/multi")({
  head: () => ({ meta: [{ title: "Sinh hàng loạt đa Worker · Order Number Generator" }] }),
  component: MultiPage,
});

interface Result {
  workerId: number;
  count: number;
  elapsedMs: number;
  sample: string[];
}

function MultiPage() {
  const { nodes, customEpochMs } = useClusterStore();
  const onlineNodes = nodes.filter((n) => n.online);
  const [perWorker, setPerWorker] = useState(50);
  const [results, setResults] = useState<Result[]>([]);
  const [duplicates, setDuplicates] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!onlineNodes.length) return toast.error("Cần ít nhất 1 Worker Online");
    if (perWorker < 1 || perWorker > 500)
      return toast.error("Số lượng 1–500 mỗi Worker (gọi từng request thật qua HTTP)");
    setRunning(true);
    setResults([]);
    setDuplicates(null);

    const t0 = performance.now();
    // Real concurrent HTTP calls — every ID below came from an actual backend node.
    const perNodeResults = await Promise.all(
      onlineNodes.map(async (n) => {
        const s = performance.now();
        const ids: string[] = [];
        await Promise.all(
          Array.from({ length: perWorker }, () =>
            generateOne(n.url)
              .then((id) => ids.push(id))
              .catch(() => {}),
          ),
        );
        const e = performance.now();
        return {
          workerId: n.workerId,
          count: ids.length,
          elapsedMs: e - s,
          sample: ids.slice(-3),
          ids,
        };
      }),
    );
    const t1 = performance.now();

    const allIds = perNodeResults.flatMap((r) => r.ids);
    const uniqueCount = new Set(allIds).size;
    const dupCount = allIds.length - uniqueCount;

    clusterStore.addGenerated(allIds.length);
    setResults(perNodeResults.map(({ ids: _ids, ...rest }) => rest));
    setDuplicates(dupCount);
    setRunning(false);

    if (dupCount === 0) {
      toast.success(
        `Sinh đồng thời ${allIds.length.toLocaleString()} mã thật từ ${onlineNodes.length} node trong ${(t1 - t0).toFixed(0)}ms. Không có trùng lặp!`,
      );
    } else {
      toast.error(`CẢNH BÁO: phát hiện ${dupCount} mã trùng lặp!`);
    }
  };

  const total = results.reduce((s, r) => s + r.count, 0);
  const maxElapsed = results.reduce((m, r) => Math.max(m, r.elapsedMs), 0);
  const throughput = total && maxElapsed ? Math.round(total / (maxElapsed / 1000)) : 0;

  return (
    <Shell
      title="Sinh hàng loạt trên nhiều Worker"
      subtitle="Bắn song song request thật tới toàn bộ Worker đang Online, kiểm chứng tính duy nhất giữa các node."
    >
      <div className="rounded-xl border border-border bg-card/70 backdrop-blur p-5 mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Số request / worker (1–500)
            </label>
            <Input
              type="number"
              value={perWorker}
              onChange={(e) => setPerWorker(Number(e.target.value))}
              className="mt-1.5 font-mono"
            />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Tổng cộng dự kiến ({onlineNodes.length} node online)
            </label>
            <div className="mt-1.5 h-9 px-3 flex items-center rounded-md border border-border bg-secondary/40 font-mono text-accent">
              {(perWorker * onlineNodes.length).toLocaleString()} mã
            </div>
          </div>
          <Button onClick={run} disabled={running || !onlineNodes.length} className="gap-2">
            <Play className="w-4 h-4" /> {running ? "Đang chạy..." : "Chạy phân phối thật"}
          </Button>
        </div>
      </div>

      {!!results.length && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Stat label="Tổng ID" value={total.toLocaleString()} tone="accent" />
          <Stat label="Thời gian (max)" value={`${maxElapsed.toFixed(0)} ms`} tone="primary" />
          <Stat
            label="Throughput tổng"
            value={`${throughput.toLocaleString()} /s`}
            tone="warning"
          />
          <Stat
            label="Trùng lặp"
            value={duplicates ?? 0}
            tone={duplicates ? undefined : "accent"}
          />
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/70 backdrop-blur overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary" />
          <span className="font-semibold">Kết quả theo Worker (dữ liệu thật)</span>
        </div>
        {!results.length ? (
          <div className="text-center text-muted-foreground py-16 text-sm">Chưa chạy phân phối</div>
        ) : (
          <div className="divide-y divide-border">
            {results.map((r) => {
              const tps = Math.round(r.count / (r.elapsedMs / 1000));
              const barPct = Math.min(100, (r.elapsedMs / maxElapsed) * 100);
              return (
                <div key={r.workerId} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-sm">
                      Worker <span className="text-primary">#{r.workerId}</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {r.count.toLocaleString()} mã · {r.elapsedMs.toFixed(0)}ms ·{" "}
                      <span className="text-accent">{tps.toLocaleString()}/s</span>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-secondary/70 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] font-mono text-muted-foreground truncate">
                    sample:{" "}
                    {r.sample
                      .map((id) => {
                        const p = decodeOrderNumber(id, customEpochMs);
                        return p ? `${id}${p.luhnValid ? "" : "⚠"}` : id;
                      })
                      .join(", ")}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}
