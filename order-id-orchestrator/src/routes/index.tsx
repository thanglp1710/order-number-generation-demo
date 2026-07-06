import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell, Stat } from "@/components/Shell";
import { useClusterStore } from "@/lib/store";
import { Cpu, Hash, Layers, Gauge, ScanLine, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Order Number Generator — Dashboard" },
      {
        name: "description",
        content:
          "Bảng điều khiển sinh mã đơn hàng: quản lý Worker thật, sinh mã, test tải hệ thống.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { nodes, totalGenerated } = useClusterStore();
  const onlineCount = nodes.filter((n) => n.online).length;

  const cards = [
    {
      to: "/workers",
      title: "Quản lý Worker",
      desc: "Bật/tắt container thật, giám sát 16 node.",
      icon: Cpu,
    },
    {
      to: "/generate",
      title: "Sinh mã đơn hàng",
      desc: "Sinh 1 hoặc nhiều mã thật trên 1 Worker.",
      icon: Hash,
    },
    {
      to: "/multi",
      title: "Sinh hàng loạt đa Worker",
      desc: "Bắn song song thật, kiểm chứng không trùng lặp.",
      icon: Layers,
    },
    {
      to: "/load-test",
      title: "Firehose Stress Test",
      desc: "Đo throughput/latency thật dưới tải cao.",
      icon: Gauge,
    },
    {
      to: "/scan",
      title: "Quét & Giải mã",
      desc: "Giải mã và xác thực Luhn của 1 mã đơn hàng.",
      icon: ScanLine,
    },
  ] as const;

  return (
    <Shell
      title="Tổng quan hệ thống"
      subtitle="Custom Snowflake · 43-bit + Luhn checksum · 14 chữ số · epoch cấu hình được"
    >
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat
          label="Worker Online"
          value={`${onlineCount}/${nodes.length}`}
          tone="primary"
          hint="Cụm cố định 16 node"
        />
        <Stat
          label="Tổng ID đã sinh"
          value={totalGenerated.toLocaleString()}
          tone="accent"
          hint="Trong phiên UI này"
        />
        <Stat label="Sequence / 20ms / worker" value="16" hint="Giới hạn thiết kế" />
        <Stat
          label="Throughput / worker"
          value="~800/s"
          tone="warning"
          hint="16 ID × 50 chu kỳ/giây"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
        {cards.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="group rounded-xl border border-border bg-card/60 backdrop-blur p-6 hover:border-primary/40 hover:bg-card transition-all"
          >
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-lg bg-primary/10 border border-primary/25 grid place-items-center text-primary">
                <c.icon className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{c.title}</h3>
                  <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                </div>
                <p className="text-sm text-muted-foreground mt-1">{c.desc}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card/60 backdrop-blur p-6">
        <h3 className="font-semibold mb-3">Cấu trúc mã đơn hàng (14 chữ số)</h3>
        <div className="flex rounded-md overflow-hidden font-mono text-xs">
          <div className="px-3 py-3 bg-primary/20 text-primary flex-[35]">
            35 bits · timestamp (chu kỳ 20ms)
          </div>
          <div className="px-3 py-3 bg-accent/20 text-accent flex-[4]">4b · worker</div>
          <div className="px-3 py-3 bg-[oklch(0.80_0.16_75)]/20 text-[oklch(0.80_0.16_75)] flex-[4]">
            4b · seq
          </div>
          <div className="px-3 py-3 bg-muted text-muted-foreground flex-[6]">Luhn check digit</div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          13 chữ số Snowflake (từ 43-bit) + 1 chữ số kiểm tra Luhn = 14 chữ số. Mọi mã hiển thị
          trong UI này đều là mã thật do backend{" "}
          <span className="font-mono text-foreground">order-number-generator-demo</span> sinh ra qua
          HTTP.
        </p>
      </div>
    </Shell>
  );
}
