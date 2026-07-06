import { Link } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { LayoutDashboard, Cpu, Hash, Layers, Gauge, ScanLine, Snowflake } from "lucide-react";
import { cn } from "@/lib/utils";
import { clusterStore, useClusterStore } from "@/lib/store";

// Poll the real cluster's online/offline state every 5s so any page that
// renders inside Shell (i.e. every page) stays in sync without each route
// having to remember to do it itself. Skips a tick while paused (see
// clusterStore.setPollingPaused) — a heavy client-side load test shares this
// tab's JS thread, so these background probes can otherwise time out and
// falsely report healthy nodes as offline.
function useClusterPolling() {
  useEffect(() => {
    clusterStore.scan();
    const id = setInterval(() => {
      if (!clusterStore.get().pollingPaused) clusterStore.scan();
    }, 5000);
    return () => clearInterval(id);
  }, []);
}

const nav = [
  { to: "/", label: "Tổng quan", icon: LayoutDashboard },
  { to: "/workers", label: "Quản lý Worker", icon: Cpu },
  { to: "/generate", label: "Sinh mã đơn", icon: Hash },
  { to: "/multi", label: "Đa Worker", icon: Layers },
  { to: "/load-test", label: "Test tải hệ thống", icon: Gauge },
  { to: "/scan", label: "Quét & Giải mã", icon: ScanLine },
] as const;

export function Shell({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  useClusterPolling();
  const { nodes, totalGenerated } = useClusterStore();
  const onlineCount = nodes.filter((n) => n.online).length;
  return (
    <div className="min-h-screen flex">
      <aside className="w-64 shrink-0 border-r border-border bg-card/60 backdrop-blur-xl flex flex-col">
        <div className="p-5 flex items-center gap-2.5 border-b border-border">
          <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/30 grid place-items-center text-primary">
            <Snowflake className="w-5 h-5" />
          </div>
          <div>
            <div className="font-semibold tracking-tight">Snowflake</div>
            <div className="text-[11px] text-muted-foreground -mt-0.5">ID Generation Console</div>
          </div>
        </div>
        <nav className="p-3 flex-1 space-y-1">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              className="group flex items-center gap-3 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors"
              activeProps={{
                className: cn(
                  "group flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  "bg-primary/10 text-primary border border-primary/25",
                ),
              }}
            >
              <n.icon className="w-4 h-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-border text-xs text-muted-foreground space-y-1.5">
          <div className="flex justify-between">
            <span>Node online</span>
            <span className="text-foreground font-mono">
              {onlineCount}/{nodes.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Tổng ID</span>
            <span className="text-accent font-mono">{totalGenerated.toLocaleString()}</span>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <header className="sticky top-0 z-10 border-b border-border bg-background/70 backdrop-blur-xl px-8 py-5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </header>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "primary" | "accent" | "warning";
}) {
  const toneCls =
    tone === "primary"
      ? "text-primary"
      : tone === "accent"
        ? "text-accent"
        : tone === "warning"
          ? "text-[oklch(0.80_0.16_75)]"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card/70 backdrop-blur p-5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-3xl font-semibold font-mono mt-2", toneCls)}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
