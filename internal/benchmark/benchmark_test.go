package benchmark

import (
	"sync/atomic"
	"testing"
	"time"

	"order-number-generator/internal/generator"
)

func BenchmarkGenerate(b *testing.B) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := generator.NewSnowflakeGenerator(epoch, 1)
	if err != nil {
		b.Fatalf("failed to create generator: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = gen.Generate()
	}
}

func BenchmarkParallel(b *testing.B) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := generator.NewSnowflakeGenerator(epoch, 2)
	if err != nil {
		b.Fatalf("failed to create generator: %v", err)
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _ = gen.Generate()
		}
	})
}

// BenchmarkGenerateBatch measures batch generation throughput (1000 IDs/call) on a single generator.
func BenchmarkGenerateBatch(b *testing.B) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := generator.NewSnowflakeGenerator(epoch, 3)
	if err != nil {
		b.Fatalf("failed to create generator: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = gen.GenerateBatch(1000)
	}
}

// BenchmarkMultiWorkerParallel simulates the full 16-node cluster generating concurrently
// from a single process, to measure the aggregate in-memory throughput ceiling of the design.
func BenchmarkMultiWorkerParallel(b *testing.B) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const numWorkers = 16
	generators := make([]*generator.SnowflakeGenerator, numWorkers)
	for w := 0; w < numWorkers; w++ {
		gen, err := generator.NewSnowflakeGenerator(epoch, w)
		if err != nil {
			b.Fatalf("failed to create generator %d: %v", w, err)
		}
		generators[w] = gen
	}

	b.ResetTimer()
	var counter int64
	b.RunParallel(func(pb *testing.PB) {
		i := atomic.AddInt64(&counter, 1) % numWorkers
		gen := generators[i]
		for pb.Next() {
			_, _ = gen.Generate()
		}
	})
}
