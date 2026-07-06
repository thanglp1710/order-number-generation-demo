# Order Number Generator Service

Dịch vụ sinh mã đơn hàng trung tâm (Order Number Generator Service) của SuperShip — một microservice độc lập, không trạng thái (stateless), hiệu năng cao, độ trễ thấp, chịu tải kiểu Flash Sale, dựa trên thuật toán **Custom Snowflake** kết hợp checksum **Luhn**.

Mỗi mã đơn hàng là một chuỗi **14 chữ số duy nhất**, có thể giải mã ngược ra thời gian sinh và Worker ID mà không cần truy vấn cơ sở dữ liệu.

---

## Mục lục

1. [Kiến trúc hệ thống](#1-kiến-trúc-hệ-thống)
2. [Thuật toán Custom Snowflake](#2-thuật-toán-custom-snowflake)
3. [Cấu trúc thư mục](#3-cấu-trúc-thư-mục)
4. [Chạy cục bộ](#4-chạy-cục-bộ)
5. [Triển khai Docker Compose (cụm nhiều node)](#5-triển-khai-docker-compose-cụm-nhiều-node)
6. [Triển khai Kubernetes (Worker ID qua Lease)](#6-triển-khai-kubernetes-worker-id-qua-lease)
7. [Cấu hình (biến môi trường)](#7-cấu-hình-biến-môi-trường)
8. [Đặc tả API](#8-đặc-tả-api)
9. [Giám sát (Prometheus & Grafana)](#9-giám-sát-prometheus--grafana)
10. [Kiểm thử](#10-kiểm-thử)
11. [Tài liệu chi tiết](#11-tài-liệu-chi-tiết)

---

## 1. Kiến trúc hệ thống

Mỗi instance (node) chạy độc lập, không cần biết tới các node khác, không cần đồng bộ mạng để đảm bảo tính duy nhất — chỉ cần mỗi node giữ một **Worker ID** riêng biệt (0–15).

```
                  16 instance độc lập (generator-0 .. generator-15)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        generator-0     generator-1     ...  generator-15
        Worker ID=0     Worker ID=1          Worker ID=15
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                   Custom Snowflake Engine
         (35-bit Timestamp @20ms − 4-bit Worker − 4-bit Sequence)
                              ▼
                   13 chữ số Snowflake ID
                              ▼
                    + 1 chữ số Luhn checksum
                              ▼
                  14 chữ số Order Number
```

Worker ID được gán bằng 1 trong 3 chiến lược (xem [mục 7](#7-cấu-hình-biến-môi-trường)):

| Chiến lược | Môi trường phù hợp | Cơ chế |
|---|---|---|
| `env` | Docker Compose, chạy tay | Đọc biến môi trường `WORKER_ID` |
| `hostname` | Kubernetes StatefulSet | Suy ra từ ordinal trong tên Pod (`generator-3` → 3) |
| `lease` | Kubernetes Deployment (scale đàn hồi) | Tự động giành 1 trong 16 slot qua `coordination.k8s.io/v1` Lease, không cần định danh Pod cố định |

---

## 2. Thuật toán Custom Snowflake

ID lõi sử dụng **43 bit**:

| Trường | Số bit | Ý nghĩa |
|---|---|---|
| Timestamp | 35 bit | Độ phân giải 20ms, tính từ `CUSTOM_EPOCH` — tuổi thọ ~21,8 năm |
| Worker ID | 4 bit | Tối đa 16 node chạy song song (0–15) |
| Sequence | 4 bit | Tối đa 16 ID/20ms/node (≈ 800 ID/giây/node); vượt quá sẽ spin-wait sang chu kỳ kế tiếp thay vì cấp trùng |

```
Order Number (14 chữ số) = Snowflake ID (13 chữ số) + Luhn Check Digit (1 chữ số)
```

Bảo đảm:
- **Không trùng lặp** giữa các node — không cần điều phối mạng khi chạy, chỉ cần Worker ID không trùng.
- **Không tràn số âm thầm** — vượt ngân sách 35-bit timestamp hoặc phát hiện đồng hồ hệ thống chạy lùi (clock rollback) đều trả lỗi tường minh thay vì sinh ID sai.

Chi tiết đầy đủ: `docs/snowflake.md`, `docs/id_generation_flow.md`, `docs/work_id_assignment.md` (không nằm trong git, xem trực tiếp trên máy).

---

## 3. Cấu trúc thư mục

```
order-number-generator/
├── cmd/server/main.go            # Entry point, chọn chiến lược Worker ID, khởi động HTTP server
├── internal/
│   ├── generator/                # Snowflake engine + Luhn checksum
│   │   ├── generator.go          # Interface IDGenerator
│   │   ├── snowflake.go          # Logic sinh ID
│   │   └── encoder.go            # CalculateLuhn / VerifyLuhn
│   ├── worker/                   # Gán Worker ID
│   │   ├── manager.go            # Chiến lược env / hostname ordinal
│   │   └── lease.go              # Chiến lược Kubernetes Lease (giành slot động)
│   ├── api/handler.go            # REST API (Gin)
│   ├── config/config.go          # Nạp cấu hình bằng Viper
│   ├── metrics/metrics.go        # Chỉ số Prometheus
│   └── benchmark/benchmark_test.go
├── stress/                       # Kịch bản kiểm thử tải bằng k6 + script node-failure
├── deployments/
│   ├── Dockerfile
│   ├── docker-compose.yml        # 2 node demo
│   ├── docker-compose-16.yml     # Cụm 16 node đầy đủ
│   ├── prometheus.yml
│   ├── grafana/                  # Dashboard giám sát cụm trực tiếp
│   └── k8s/                      # ServiceAccount/Role/RoleBinding/Deployment cho chiến lược Lease
├── go.mod / go.sum
└── Makefile
```

---

## 4. Chạy cục bộ

**Yêu cầu:** Go 1.24+

```bash
go mod tidy

# PowerShell
$env:PORT="8080"; $env:WORKER_ID="2"; $env:CUSTOM_EPOCH="2026-01-01T00:00:00Z"
go run cmd/server/main.go
```

Hoặc dùng Makefile:
```bash
make run     # go run cmd/server/main.go
make build   # build ra bin/server
```

---

## 5. Triển khai Docker Compose (cụm nhiều node)

```bash
cd deployments

# Cụm đầy đủ: 16 node + Prometheus + Grafana
docker compose up --build -d

# Biến thể: chỉ 16 node generator, không kèm Prometheus/Grafana
docker compose -f docker-compose-16.yml up --build -d
```

- Instance `generator-N` chạy tại cổng `808N` (ví dụ `generator-0` → `http://localhost:8080`, `generator-15` → `http://localhost:8095`)
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3030` (dashboard "Bộ Sinh Mã Đơn Hàng — Giám Sát Cụm Trực Tiếp", tự provision)

---

## 6. Triển khai Kubernetes (Worker ID qua Lease)

Dùng khi cần scale đàn hồi bằng `Deployment` thường (không cần `StatefulSet`/định danh Pod ổn định) — mỗi Pod tự giành 1 trong 16 Worker ID slot qua Kubernetes Lease API, tự động bàn giao khi Pod bị xóa/restart.

```bash
kubectl apply -f deployments/k8s/
```

Bao gồm: `ServiceAccount`, `Role` (chỉ `get/list/watch/create/update` trên `leases.coordination.k8s.io`, không có `delete`), `RoleBinding`, và `Deployment` (mặc định 20 replicas — dư 4 so với 16 slot để minh họa khả năng scale đàn hồi an toàn: 16 Pod nhanh nhất giành được slot và chạy; 4 Pod còn lại crash-restart có backoff cho tới khi có slot trống, đây là hành vi mong đợi, không phải lỗi).

Đặt `WORKER_ID_STRATEGY=lease` để bật chiến lược này (xem mục 7).

---

## 7. Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8080` | Cổng HTTP |
| `CUSTOM_EPOCH` | `2026-01-01T00:00:00Z` | Epoch gốc cho Snowflake timestamp (RFC3339) |
| `LOG_LEVEL` | `info` | `debug` để bật Gin debug mode |
| `WORKER_ID_STRATEGY` | `auto` | `auto` \| `env` \| `hostname` \| `lease` |
| `WORKER_ID` | _(rỗng)_ | Worker ID tường minh (0–15), dùng cho chiến lược `env`/`auto` |
| `K8S_NAMESPACE` | `default` | Namespace chứa các Lease object (chiến lược `lease`) |
| `MAX_WORKERS` | `16` | Số slot Worker ID được race (chiến lược `lease`); không vượt quá 16 |
| `LEASE_NAME_PREFIX` | `order-generator-worker-` | Tiền tố tên Lease object mỗi slot |
| `LEASE_DURATION` | `15s` | Thời gian giữ Lease trước khi hết hạn nếu không renew |
| `LEASE_RENEW_DEADLINE` | `10s` | Thời hạn renew trước khi coi là mất Lease |
| `LEASE_RETRY_PERIOD` | `2s` | Chu kỳ thử renew/giành Lease |

> **Lưu ý PowerShell:** khi chạy `go test`/`go run` trực tiếp (không qua Makefile) với regex chứa `^`/`$`, hãy bọc trong dấu nháy đơn (`-run='^$'`), nếu không PowerShell sẽ nuốt ký tự `$`.

---

## 8. Đặc tả API

### `POST /generate` — sinh 1 mã đơn hàng
```json
{ "order_number": "00000003276825" }
```

### `POST /generate/batch` — sinh hàng loạt (tối đa 10.000/lần)
Request:
```json
{ "count": 5 }
```
Response:
```json
{ "order_numbers": ["00000003277329", "00000003277346", "00000003277363", "00000003277380", "00000003277397"] }
```

### `GET /health` — health check
```json
{ "status": "OK" }
```

### `GET /api/info` — thông tin instance
```json
{ "worker_id": 2, "custom_epoch": "2026-01-01T00:00:00Z" }
```

### `GET /metrics` — Prometheus metrics

### Nhóm API quản trị/demo (dashboard nội bộ — **không nên public**)
| Endpoint | Mô tả |
|---|---|
| `GET /api/generators` | Danh sách Worker ID đang có generator trong bộ nhớ tiến trình |
| `POST /api/generators` | Đăng ký thêm 1 generator in-process cho Worker ID khác (mô phỏng đa-worker trong 1 process, phục vụ dashboard demo) |
| `GET /api/docker/status` | Kiểm tra Docker daemon có sẵn sàng không |
| `GET /api/docker/instances` | Liệt kê container/tiến trình generator đang chạy |
| `POST /api/docker/instances` | Khởi động 1 container/tiến trình generator mới |
| `DELETE /api/docker/instances?worker_id=N` | Dừng container/tiến trình theo Worker ID |

⚠️ Nhóm endpoint quản trị Docker có thể khởi động/dừng container trên host — không expose ra ngoài mạng nội bộ tin cậy.

---

## 9. Giám sát (Prometheus & Grafana)

Mỗi instance expose `/metrics` (Prometheus). Dashboard Grafana có sẵn (`deployments/grafana/`) hiển thị: số node online, RPS toàn cụm & theo từng node, tổng mã đã sinh, số lần tràn sequence, độ trễ p50/p95/p99, và % so với trần lý thuyết (800 req/s × số node online).

```bash
cd deployments && docker compose up -d
# Grafana: http://localhost:3030
```

---

## 10. Kiểm thử

```bash
# Unit test (Snowflake, Luhn, Worker ID, Lease allocator)
go test -v ./...

# Benchmark in-process
go test -v ./internal/benchmark -bench=. -run='^$' -benchmem
# hoặc: make benchmark

# Stress test qua HTTP thật (cần cụm 16 node đang chạy — xem mục 5)
k6 run stress/limit_test.js        # trần thông lượng 1 node
k6 run stress/flash_sale.js        # mô phỏng Flash Sale toàn cụm
k6 run stress/spike_test.js        # tải tăng đột ngột + hồi phục
k6 run stress/breaking_point.js    # tìm điểm gãy khi vượt xa trần thiết kế
bash stress/node_failure_test.sh   # 1 node chết giữa lúc tải cao
```

Toàn bộ kịch bản, phương pháp luận và kết quả thực đo được ghi lại đầy đủ trong tài liệu nội bộ ở mục 11.

---

## 11. Tài liệu chi tiết

Các tài liệu sau nằm trong `docs/` (không đưa vào git, chỉ có trên máy phát triển):

- `docs/BENCHMARK_REPORT.md` — Chương kiểm thử & benchmark đầy đủ: unit test, benchmark, 5 kịch bản k6, kết quả thực đo.
- `docs/K6_STRESS_TEST_GUIDE.md` — k6 là gì, dùng ra sao, vì sao chọn k6 thay vì UI demo.
- `docs/TEST_REPORT.md` — Danh mục toàn bộ kịch bản kiểm thử kèm expected output.
- `docs/snowflake.md`, `docs/id_generation_flow.md`, `docs/work_id_assignment.md`, `docs/folder_structure.md` — Thiết kế chi tiết thuật toán và luồng xử lý.
- `docs/DESIGN_DEMO_REPORT.md` — Báo cáo thiết kế & demo tổng quan.
