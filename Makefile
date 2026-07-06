.PHONY: build run test benchmark stress clean

build:
	go build -o bin/server cmd/server/main.go

run:
	go run cmd/server/main.go

test:
	go test -v ./...

benchmark:
	go test -v ./internal/benchmark -bench=. -run=^$$ -benchmem

stress:
	k6 run stress/flash_sale.js

clean:
	rm -rf bin/
