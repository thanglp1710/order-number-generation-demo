# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o server cmd/server/main.go

# Production stage
FROM alpine:3.20

RUN apk --no-cache add ca-certificates docker-cli

WORKDIR /root/

COPY --from=builder /app/server .

EXPOSE 8080

ENTRYPOINT ["./server"]
