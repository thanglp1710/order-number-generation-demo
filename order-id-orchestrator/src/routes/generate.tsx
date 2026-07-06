import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clusterStore, useClusterStore } from "@/lib/store";
import { generateOne, generateBatchReal } from "@/lib/api";
import { decodeOrderNumber } from "@/lib/snowflake";
import { toast } from "sonner";
import { Copy, Hash, Zap } from "lucide-react";

export const Route = createFileRoute("/generate")({
  head: () => ({ meta: [{ title: "Sinh mã đơn hàng · Order Number Generator" }] }),
  component: GeneratePage,
});

/** Renders a barcode + QR code for a single order number using the real
 * generated string — matches the old dashboard's visual, ported to React. */
function OrderCodeVisual({ orderNumber }: { orderNumber: string }) {
  const barcodeRef = useRef<SVGSVGElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;

    if (barcodeRef.current) {
      import("jsbarcode").then(({ default: JsBarcode }) => {
        if (cancelled || !barcodeRef.current) return;
        JsBarcode(barcodeRef.current, orderNumber, {
          format: "CODE128",
          width: 2,
          height: 60,
          displayValue: true,
          background: "#ffffff",
          lineColor: "#000000",
        });
      });
    }

    if (qrCanvasRef.current) {
      import("qrcode").then(({ default: QRCode }) => {
        if (cancelled || !qrCanvasRef.current) return;
        QRCode.toCanvas(qrCanvasRef.current, orderNumber, {
          width: 96,
          margin: 1,
          color: { dark: "#000000", light: "#ffffff" },
        });
      });
    }

    return () => {
      cancelled = true;
    };
  }, [orderNumber]);

  return (
    <div className="flex items-center justify-center gap-6 bg-white rounded-lg p-5 mt-4">
      <svg ref={barcodeRef} />
      <canvas ref={qrCanvasRef} />
    </div>
  );
}

function GeneratePage() {
  const { nodes, customEpochMs } = useClusterStore();
  const onlineNodes = nodes.filter((n) => n.online);
  const [selected, setSelected] = useState<string>("");
  const [count, setCount] = useState(100);
  const [ids, setIds] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastSingleId, setLastSingleId] = useState<string | null>(null);

  const workerId = Number(selected || onlineNodes[0]?.workerId);
  const node = clusterStore.getNode(workerId);

  const one = async () => {
    if (!node?.online) return toast.error("Chọn 1 Worker đang Online trước");
    setBusy(true);
    try {
      const id = await generateOne(node.url);
      clusterStore.addGenerated(1);
      setIds((prev) => [id, ...prev].slice(0, 500));
      setLastSingleId(id);
      setElapsed(null);
    } catch (err) {
      toast.error(`Sinh mã thất bại: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const batch = async () => {
    if (!node?.online) return toast.error("Chọn 1 Worker đang Online trước");
    if (count < 1 || count > 10000) return toast.error("Số lượng 1–10,000 (giới hạn của backend)");
    setBusy(true);
    const t0 = performance.now();
    try {
      const out = await generateBatchReal(node.url, count);
      const t1 = performance.now();
      clusterStore.addGenerated(count);
      setElapsed(t1 - t0);
      setIds(out.slice(0, 500));
      toast.success(`Đã sinh ${count.toLocaleString()} mã thật trong ${(t1 - t0).toFixed(1)}ms`);
    } catch (err) {
      toast.error(`Sinh hàng loạt thất bại: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copyAll = () => {
    navigator.clipboard.writeText(ids.join("\n"));
    toast.success("Đã copy");
  };

  return (
    <Shell
      title="Sinh mã đơn hàng"
      subtitle="Gọi thật /generate và /generate/batch trên Worker đã chọn."
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border bg-card/70 backdrop-blur p-5 space-y-4">
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                Worker (chỉ hiện node Online)
              </label>
              <Select
                value={selected || onlineNodes[0]?.workerId.toString() || ""}
                onValueChange={setSelected}
              >
                <SelectTrigger className="mt-1.5 font-mono">
                  <SelectValue placeholder="Chọn worker" />
                </SelectTrigger>
                <SelectContent>
                  {onlineNodes.map((n) => (
                    <SelectItem
                      key={n.workerId}
                      value={n.workerId.toString()}
                      className="font-mono"
                    >
                      Worker #{n.workerId} (Port {n.port})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!onlineNodes.length && (
                <p className="text-xs text-destructive mt-1.5">
                  Không có Worker nào Online — vào trang Quản lý Worker để bật.
                </p>
              )}
            </div>
            <Button
              onClick={one}
              disabled={busy || !node?.online}
              className="w-full gap-2"
              variant="secondary"
            >
              <Hash className="w-4 h-4" /> Sinh 1 mã
            </Button>
            {lastSingleId && (
              <div>
                <div className="text-center font-mono text-sm text-primary">{lastSingleId}</div>
                <OrderCodeVisual orderNumber={lastSingleId} />
              </div>
            )}
            <div className="pt-2 border-t border-border">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                Số lượng batch (max 10,000)
              </label>
              <Input
                type="number"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="mt-1.5 font-mono"
              />
              <Button
                onClick={batch}
                disabled={busy || !node?.online}
                className="w-full gap-2 mt-3"
              >
                <Zap className="w-4 h-4" /> Sinh hàng loạt
              </Button>
            </div>
            {elapsed !== null && (
              <div className="rounded-md bg-primary/10 border border-primary/25 p-3 text-sm">
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span>Thời gian (RTT)</span>
                  <span className="text-primary font-mono">{elapsed.toFixed(1)} ms</span>
                </div>
                <div className="flex justify-between text-muted-foreground text-xs mt-1">
                  <span>Throughput</span>
                  <span className="text-accent font-mono">
                    {Math.round(count / (elapsed / 1000)).toLocaleString()} /s
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border bg-card/70 backdrop-blur">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <div className="font-semibold">Kết quả (mã thật từ Backend)</div>
                <div className="text-xs text-muted-foreground">Hiển thị tối đa 500 mã gần nhất</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={copyAll}
                disabled={!ids.length}
                className="gap-2"
              >
                <Copy className="w-3.5 h-3.5" /> Copy tất cả
              </Button>
            </div>
            <div className="max-h-[560px] overflow-auto p-2 font-mono text-xs">
              {!ids.length && (
                <div className="text-center text-muted-foreground py-16">Chưa có mã nào</div>
              )}
              {ids.map((id, i) => {
                const p = decodeOrderNumber(id, customEpochMs);
                return (
                  <div
                    key={i}
                    className="px-3 py-1.5 rounded hover:bg-secondary/60 flex items-center gap-3"
                  >
                    <span className="text-muted-foreground w-10 text-right">{i + 1}</span>
                    <span className="text-primary flex-1">{id}</span>
                    {p && (
                      <span
                        className={
                          p.luhnValid ? "text-accent text-[11px]" : "text-destructive text-[11px]"
                        }
                      >
                        w{p.workerId} · seq{p.sequence} · {p.luhnValid ? "Luhn OK" : "Luhn FAIL"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
