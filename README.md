# Dịch Vụ Sinh Mã Đơn Hàng Trung Tâm (Order Number Generator Service)

Dự án này triển khai dịch vụ sinh mã đơn hàng trung tâm (Order Number Generator Service) của SuperShip. Đây là một microservice độc lập, có hiệu năng cực cao, độ trễ cực thấp và khả năng chịu tải Flash Sale vượt trội dựa trên thuật toán **Custom Snowflake** và thuật toán kiểm tra số dư **Luhn**.

---

## 1. Mục lục
- [1. Giới thiệu](#1-giới-thiệu)
- [2. Kiến trúc Hệ thống](#2-kiến-trúc-hệ-thống)
- [3. Cấu trúc Thư mục](#3-cấu-trúc-thư-mục)
- [4. Thuật toán Custom Snowflake](#4-thuật-toán-custom-snowflake)
- [5. Hướng dẫn Chạy Cục bộ](#5-hướng-dẫn-chạy-cục-bộ)
- [6. Triển khai Docker & Compose](#6-triển-khai-docker--compose)
- [7. Đặc tả API](#7-đặc-tả-api)
- [8. Đánh giá Hiệu năng (Benchmark)](#8-đánh-giá-hiệu-năng-benchmark)
- [9. Kiểm thử Tải (k6 Stress Test)](#9-kiểm-thử-tải-k6-stress-test)
- [10. Ví dụ Kết quả Đầu ra](#10-ví-dụ-kết-quả-đầu-ra)

---

## 2. Kiến trúc Hệ thống

Hệ thống sinh mã đơn hàng được tách biệt hoàn toàn khỏi logic nghiệp vụ của Order Service. Hệ thống hoạt động theo mô hình phi tập trung không trạng thái (stateless):

```
                Kubernetes StatefulSet
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
   generator-0     generator-1     generator-2
        │               │               │
     Worker=0        Worker=1        Worker=2
        │               │               │
        └───────────────┼───────────────┘
                        ▼
             Custom Snowflake Engine
        (35 Timestamp - 20ms - 4 Worker - 4 Seq)
                        │
                        ▼
              13-digit Snowflake ID
                        │
                        ▼
              Luhn Check Digit
                        │
                        ▼
             14-digit Order Number
```

---

## 3. Cấu trúc Thư mục

Cấu trúc dự án tuân thủ nghiêm ngặt mô hình thiết kế của SuperShip:

```
order-number-generator/
│
├── cmd/
│   └── server/
│       └── main.go                 # Entry point khởi chạy dịch vụ
│
├── internal/
│   ├── generator/
│   │   ├── generator.go            # Interface cốt lõi của ID Generator
│   │   ├── snowflake.go            # Logic sinh ID Custom Snowflake
│   │   └── encoder.go              # Mã hóa Luhn Check Digit
│   │
│   ├── worker/
│   │   └── manager.go              # Quản lý Worker ID từ Pod Ordinal hoặc Env
│   │
│   ├── api/
│   │   └── handler.go              # REST API sử dụng Gin
│   │
│   ├── config/
│   │   └── config.go               # Nạp cấu hình hệ thống bằng Viper
│   │
│   ├── metrics/
│   │   └── metrics.go              # Chỉ số Prometheus
│   │
│   └── benchmark/
│       └── benchmark_test.go       # Go Benchmark đo thông lượng & latency
│
├── stress/
│   └── flash_sale.js               # Kịch bản k6 kiểm thử tải Flash Sale
│
├── deployments/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── prometheus.yml
│
├── docs/
│   ├── folder_structure.md
│   ├── snowflake.md
│   ├── work_id_assignment.md
│   └── id_generation_engine_design.md
│
├── go.mod
├── Makefile
└── README.md
```

---

## 4. Thuật toán Custom Snowflake

Mã định danh nội bộ sử dụng **43 bit** dữ liệu (không tính sign bit) với phân bổ bit:
*   **Sign Bit (1 bit)**: Luôn bằng `0`.
*   **Timestamp (35 bit)**: Độ phân giải **20 mili-giây** (20ms Resolution), sử dụng Custom Epoch. Cung cấp tuổi thọ hoạt động lên tới **~21.8 năm**.
*   **Worker ID (4 bit)**: Tối đa 16 instance generator chạy song song (định dạng `0` đến `15`).
*   **Sequence (4 bit)**: Bộ đếm giới hạn **16 ID** trong mỗi block 20ms trên mỗi Worker node.

### Công thức sinh mã Order Number 14 chữ số:
$$\text{Order Number (14 chữ số)} = \text{Snowflake ID (13 chữ số)} + \text{Luhn Check Digit (1 chữ số)}$$

---

## 5. Hướng dẫn Chạy Cục bộ

### Yêu cầu hệ thống:
*   Go 1.24+

### Các bước cài đặt và chạy thử:
1.  **Tải các dependency của Go**:
    ```bash
    go mod tidy
    ```
2.  **Khởi chạy Server ở local**:
    ```bash
    # Đặt PORT và WORKER_ID trong môi trường local
    $env:PORT="8080"
    $env:WORKER_ID="2"
    $env:CUSTOM_EPOCH="2026-01-01T00:00:00Z"
    go run cmd/server/main.go
    ```
    Hoặc sử dụng `Makefile`:
    ```bash
    make run
    ```

---

## 6. Triển khai Docker & Compose

Dự án cung cấp sẵn cấu hình Triển khai multi-instance kèm giám sát Prometheus:

```bash
# Di chuyển tới thư mục deployments
cd deployments

# Khởi chạy các container generator-0, generator-1 và prometheus
docker-compose up --build -d
```

*   **Instance 0** chạy tại cổng: `http://localhost:8080`
*   **Instance 1** chạy tại cổng: `http://localhost:8081`
*   **Prometheus** chạy tại cổng: `http://localhost:9090`

---

## 7. Đặc tả API

### 1. Sinh một mã đơn hàng duy nhất
*   **Endpoint**: `POST /generate`
*   **Response (200 OK)**:
    ```json
    {
      "order_number": "00000003276825"
    }
    ```

### 2. Sinh hàng loạt mã đơn hàng (Batch Generate)
*   **Endpoint**: `POST /generate/batch`
*   **Request Body**:
    ```json
    {
      "count": 5
    }
    ```
*   **Response (200 OK)**:
    ```json
    {
      "order_numbers": [
        "00000003277329",
        "00000003277346",
        "00000003277363",
        "00000003277380",
        "00000003277397"
      ]
    }
    ```

### 3. Kiểm tra sức khỏe (Health Check)
*   **Endpoint**: `GET /health`
*   **Response (200 OK)**:
    ```json
    {
      "status": "OK"
    }
    ```

### 4. Prometheus Metrics
*   **Endpoint**: `GET /metrics`

---

## 8. Đánh giá Hiệu năng (Benchmark)

Để đo đạc thông lượng, độ trễ và số lần phân bổ bộ nhớ:

```bash
go test -v "-bench=." -run=NONE -benchmem ./internal/benchmark
```

### Kết quả đo đạc:
*   **BenchmarkGenerate** (Đơn luồng): Thực thi dưới mức cực kỳ tối ưu, giới hạn duy nhất là thời gian ngủ ngắn tự động (spin wait) khi số lượng request sinh mã trong cùng một block 20ms vượt quá 16 mã.
*   **BenchmarkParallel** (Đa luồng đồng thời): Đảm bảo an toàn luồng tuyệt đối thông qua cơ chế khóa Mutex nội bộ mà không xảy ra xung đột hay rò rỉ dữ liệu.

---

## 9. Kiểm thử Tải (k6 Stress Test)

Kịch bản tải giả lập Flash Sale nằm tại `stress/flash_sale.js`, tự động nâng tải từ 100 VUs lên 500 VUs và 1000 VUs, đồng thời chạy kiểm tra tính hợp lệ của mã đơn hàng bằng thuật toán Luhn ngay tại client.

### Chạy stress test:
```bash
k6 run stress/flash_sale.js
```

---

## 10. Ví dụ Kết quả Đầu ra

Dưới đây là một mẫu log ghi nhận từ hệ thống khi sinh mã:

```log
2026-06-30T17:35:10.123+07:00	INFO	Worker ID successfully resolved and validated	{"worker_id": 2}
2026-06-30T17:35:10.124+07:00	INFO	Starting HTTP Server	{"port": "8080"}
2026-06-30T17:35:15.556+07:00	INFO	HTTP Request	{"status": 200, "method": "POST", "path": "/generate", "query": "", "latency": "53.2µs", "ip": "::1"}
2026-06-30T17:35:18.991+07:00	INFO	HTTP Request	{"status": 200, "method": "POST", "path": "/generate/batch", "query": "", "latency": "1.23ms", "ip": "::1"}
```
