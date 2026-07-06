import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClusterStore } from "@/lib/store";
import { decodeOrderNumber, type DecodedOrderNumber } from "@/lib/snowflake";
import { CheckCircle2, XCircle, ScanLine, Camera, CameraOff, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/scan")({
  head: () => ({ meta: [{ title: "Quét & Giải mã · Order Number Generator" }] }),
  component: ScanPage,
});

const READER_ELEMENT_ID = "qr-camera-reader";
const FILE_SCAN_ELEMENT_ID = "qr-file-scan-area";

function ScanPage() {
  const { customEpochMs } = useClusterStore();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<DecodedOrderNumber | null | undefined>(undefined);
  // "wanted" drives the DOM (unhides the reader div) so it has real layout
  // *before* html5-qrcode measures it to size its <video>. "active" reflects
  // whether the scanner has actually finished starting.
  const [cameraWanted, setCameraWanted] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  // html5-qrcode instances are not React-managed; keep them in refs.
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const decodeValue = (value: string) => {
    const trimmed = value.trim();
    if (!/^\d{14}$/.test(trimmed)) {
      setResult(null);
      return;
    }
    setResult(decodeOrderNumber(trimmed, customEpochMs));
  };

  const decode = () => decodeValue(input);

  const onScanSuccess = (decodedText: string) => {
    setInput(decodedText);
    decodeValue(decodedText);
    toast.success("Đã quét được mã, xem kết quả bên dưới");
    setCameraWanted(false);
  };

  // Starts/stops the actual scanner in response to cameraWanted, only after
  // the reader div has been unhidden and painted (so html5-qrcode measures a
  // real width/height instead of the 0x0 it gets from a display:none parent).
  useEffect(() => {
    let cancelled = false;

    if (cameraWanted) {
      (async () => {
        try {
          const { Html5Qrcode } = await import("html5-qrcode");
          if (cancelled) return;
          const scanner = new Html5Qrcode(READER_ELEMENT_ID);
          scannerRef.current = scanner;
          await scanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => onScanSuccess(decodedText),
            () => {
              /* per-frame scan failure — expected while no code is in view, ignore */
            },
          );
          if (cancelled) {
            await scanner.stop();
            scanner.clear();
            return;
          }
          setCameraActive(true);
        } catch (err) {
          if (!cancelled) {
            toast.error(`Không thể mở camera: ${(err as Error).message}`);
            setCameraWanted(false);
          }
        }
      })();
    } else {
      setCameraActive(false);
    }

    return () => {
      cancelled = true;
      // Runs both when cameraWanted flips to false and on unmount (e.g.
      // navigating away mid-scan) — either way, stop whatever is running.
      const scanner = scannerRef.current;
      if (scanner) {
        scanner
          .stop()
          .catch(() => {})
          .finally(() => scanner.clear());
        scannerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraWanted]);

  const toggleCamera = () => setCameraWanted((v) => !v);

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode(FILE_SCAN_ELEMENT_ID);
      const decodedText = await scanner.scanFile(file, false);
      onScanSuccess(decodedText);
    } catch (err) {
      toast.error("Không thể đọc mã từ ảnh. Hãy đảm bảo ảnh chứa QR code hoặc Barcode rõ ràng.");
      console.error("Image scan error:", err);
    }
  };

  return (
    <Shell
      title="Quét & Giải mã đơn hàng"
      subtitle="Nhập tay, quét camera, hoặc tải ảnh QR/Barcode — giải mã 43-bit + xác thực Luhn hoàn toàn phía client."
    >
      <div className="max-w-2xl space-y-5">
        <div className="rounded-xl border border-border bg-card/70 backdrop-blur p-5">
          <label className="text-xs uppercase tracking-wider text-muted-foreground">
            Mã đơn hàng (14 chữ số)
          </label>
          <div className="flex gap-3 mt-1.5">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && decode()}
              placeholder="VD: 02017702039043"
              className="font-mono"
              maxLength={14}
            />
            <Button onClick={decode} className="gap-2 shrink-0">
              <ScanLine className="w-4 h-4" /> Giải mã
            </Button>
          </div>

          <div className="flex gap-3 mt-4">
            <Button
              variant="secondary"
              onClick={toggleCamera}
              disabled={cameraWanted && !cameraActive}
              className="flex-1 gap-2"
            >
              {cameraWanted ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
              {cameraActive ? "Tắt Camera" : cameraWanted ? "Đang mở..." : "Mở Camera Quét QR"}
            </Button>
            <Button variant="secondary" onClick={handleUploadClick} className="flex-1 gap-2">
              <Upload className="w-4 h-4" /> Tải Ảnh Lên
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileSelected}
            />
          </div>

          <div
            id={READER_ELEMENT_ID}
            className={cn("mt-4 rounded-lg overflow-hidden bg-black", !cameraWanted && "hidden")}
          />
          <div id={FILE_SCAN_ELEMENT_ID} className="hidden" />
        </div>

        {result === null && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 flex items-start gap-3">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-destructive">Lỗi cấu trúc</div>
              <div className="text-sm text-muted-foreground mt-1">
                Mã đơn hàng phải đúng 14 ký tự số.
              </div>
            </div>
          </div>
        )}

        {result && (
          <div
            className={cn(
              "rounded-xl border p-5",
              result.luhnValid
                ? "border-primary/30 bg-primary/10"
                : "border-destructive/30 bg-destructive/10",
            )}
          >
            <div className="flex items-center gap-3">
              {result.luhnValid ? (
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-destructive shrink-0" />
              )}
              <div
                className={cn(
                  "font-semibold",
                  result.luhnValid ? "text-primary" : "text-destructive",
                )}
              >
                {result.luhnValid
                  ? "Quét hợp lệ (Luhn Check OK)"
                  : "Mã không hợp lệ (sai Luhn checksum)"}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
              <div className="rounded-md bg-secondary/50 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase">Time Ticks</div>
                <div className="font-mono text-primary text-base">{result.ticks}</div>
              </div>
              <div className="rounded-md bg-secondary/50 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase">Worker ID</div>
                <div className="font-mono text-accent text-base">{result.workerId}</div>
              </div>
              <div className="rounded-md bg-secondary/50 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase">Sequence</div>
                <div className="font-mono text-base">{result.sequence}</div>
              </div>
              <div className="rounded-md bg-secondary/50 px-3 py-2">
                <div className="text-[11px] text-muted-foreground uppercase">Luhn Digit</div>
                <div className="font-mono text-base">{result.luhnDigit}</div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground mt-3">
              Thời gian sinh mã (suy ra từ epoch của cluster hiện tại):{" "}
              {result.date.toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </Shell>
  );
}
