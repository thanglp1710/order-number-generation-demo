import { createFileRoute } from "@tanstack/react-router";
import { Shell, Stat } from "@/components/Shell";
import { clusterStore, useClusterStore } from "@/lib/store";
import { toast } from "sonner";
import { Cpu, Power, PowerOff, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workers")({
  head: () => ({ meta: [{ title: "Quản lý Worker · Order Number Generator" }] }),
  component: WorkersPage,
});

function WorkersPage() {
  const { nodes, scanning } = useClusterStore();
  const onlineCount = nodes.filter((n) => n.online).length;

  const toggle = async (workerId: number) => {
    const node = clusterStore.getNode(workerId);
    const wasOnline = node?.online;
    try {
      await clusterStore.toggle(workerId);
      toast.success(`Worker ${workerId} đã ${wasOnline ? "TẮT" : "BẬT"} thành công`);
    } catch (err) {
      toast.error(
        `Không thể ${wasOnline ? "tắt" : "bật"} Worker ${workerId}: ${(err as Error).message}. ` +
          `Cần Docker socket được mount vào container, hoặc chạy backend native trên host.`,
      );
    }
  };

  return (
    <Shell
      title="Quản lý Worker"
      subtitle="Cụm cố định 16 Worker (0–15), mỗi Worker gắn với 1 container Docker thật."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Stat label="Node online" value={`${onlineCount}/${nodes.length}`} tone="primary" />
        <Stat label="Cổng" value="8080–8095" />
        <Stat
          label="Trạng thái quét"
          value={scanning ? "Đang quét..." : "Đã cập nhật"}
          hint="Tự động quét mỗi 5 giây"
        />
      </div>

      <div className="flex justify-end mb-4">
        <button
          onClick={() => clusterStore.scan()}
          disabled={scanning}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", scanning && "animate-spin")} />
          Quét lại ngay
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {nodes.map((n) => (
          <div
            key={n.workerId}
            className="rounded-xl border border-border bg-card/70 backdrop-blur p-5"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "w-10 h-10 rounded-lg border grid place-items-center",
                    n.online
                      ? "bg-primary/15 border-primary/25 text-primary"
                      : "bg-destructive/10 border-destructive/25 text-destructive",
                  )}
                >
                  <Cpu className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold">Worker #{n.workerId}</div>
                  <div className="text-xs text-muted-foreground font-mono">Port {n.port}</div>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span
                className={cn(
                  "text-xs px-2 py-1 rounded-full font-medium",
                  n.online ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
                )}
              >
                {n.busy ? "..." : n.online ? "Online" : "Offline"}
              </span>
              <button
                onClick={() => toggle(n.workerId)}
                disabled={n.busy}
                className={cn(
                  "text-xs px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50",
                  n.online
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "bg-primary/10 text-primary hover:bg-primary/20",
                )}
              >
                {n.online ? (
                  <PowerOff className="w-3.5 h-3.5" />
                ) : (
                  <Power className="w-3.5 h-3.5" />
                )}
                {n.online ? "OFF" : "ON"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
