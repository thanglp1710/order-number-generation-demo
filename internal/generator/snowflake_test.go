package generator

import (
	"sync"
	"testing"
	"time"
)

// TestSnowflake_TimestampEncoding tests that timestamps are encoded and shifted properly.
func TestSnowflake_TimestampEncoding(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 5)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	// Mock time provider to return specific elapsed time (100 ms after epoch)
	// 100 ms / 20 ms resolution = 5 ticks
	gen.timeProvider = func() time.Time {
		return epoch.Add(100 * time.Millisecond)
	}

	rawID, err := gen.GenerateRaw()
	if err != nil {
		t.Fatalf("GenerateRaw failed: %v", err)
	}

	// Decoding the raw ID
	// Bits 0-3: Sequence (should be 0 since it's the first call at this tick)
	// Bits 4-7: Worker ID (should be 5)
	// Bits 8-42: Timestamp Ticks (should be 5)
	seq := rawID & MaxSequence
	worker := (rawID >> WorkerIDShift) & MaxWorkerID
	ticks := (rawID >> TimestampShift) & MaxTimestamp

	if seq != 0 {
		t.Errorf("expected sequence 0, got %d", seq)
	}
	if worker != 5 {
		t.Errorf("expected worker ID 5, got %d", worker)
	}
	if ticks != 5 {
		t.Errorf("expected timestamp ticks 5, got %d", ticks)
	}
}

// TestSnowflake_SequenceIncrement tests that sequence increments correctly for same-tick requests
// and resets when the tick changes.
func TestSnowflake_SequenceIncrement(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 1)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	tickTime := epoch.Add(200 * time.Millisecond)
	gen.timeProvider = func() time.Time {
		return tickTime
	}

	// Call 1
	id1, err := gen.GenerateRaw()
	if err != nil {
		t.Fatalf("call 1 failed: %v", err)
	}
	if id1&MaxSequence != 0 {
		t.Errorf("expected seq 0, got %d", id1&MaxSequence)
	}

	// Call 2
	id2, err := gen.GenerateRaw()
	if err != nil {
		t.Fatalf("call 2 failed: %v", err)
	}
	if id2&MaxSequence != 1 {
		t.Errorf("expected seq 1, got %d", id2&MaxSequence)
	}

	// Advance time to next tick (20ms later)
	tickTime = tickTime.Add(20 * time.Millisecond)
	id3, err := gen.GenerateRaw()
	if err != nil {
		t.Fatalf("call 3 failed: %v", err)
	}
	if id3&MaxSequence != 0 {
		t.Errorf("expected seq reset to 0, got %d", id3&MaxSequence)
	}
}

// TestSnowflake_ConcurrentGeneration checks thread safety and guarantees no duplicates.
func TestSnowflake_ConcurrentGeneration(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 10)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	const goroutines = 50
	const iterations = 100
	var wg sync.WaitGroup
	var mu sync.Mutex

	generatedIDs := make(map[string]bool)

	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				id, err := gen.Generate()
				if err != nil {
					t.Errorf("failed to generate ID: %v", err)
					return
				}

				mu.Lock()
				if _, exists := generatedIDs[id]; exists {
					t.Errorf("duplicate ID found: %s", id)
				}
				generatedIDs[id] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	expectedCount := goroutines * iterations
	if len(generatedIDs) != expectedCount {
		t.Errorf("expected %d unique IDs, got %d", expectedCount, len(generatedIDs))
	}
}

// TestSnowflake_SequenceOverflow verifies the limit of 16 IDs per 20ms tick per worker.
// When more than MaxSequence+1 (16) requests land in the same tick, the generator must
// spin-wait for the next tick instead of reusing a sequence value, so no two IDs collide.
func TestSnowflake_SequenceOverflow(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 3)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	// Fixed tick that only advances after we've issued more than 16 IDs.
	tick := int64(0)
	callCount := 0
	gen.timeProvider = func() time.Time {
		callCount++
		// After the 17th read (i.e. once we've consumed sequence 0..15 already),
		// advance to the next 20ms tick so the spin-wait can exit.
		if callCount > 17 {
			tick = 1
		}
		return epoch.Add(time.Duration(tick) * 20 * time.Millisecond)
	}

	const requests = 20 // > MaxSequence+1 (16) to force overflow into the next tick
	seen := make(map[int64]bool)
	for i := 0; i < requests; i++ {
		id, err := gen.GenerateRaw()
		if err != nil {
			t.Fatalf("request %d failed: %v", i, err)
		}
		if seen[id] {
			t.Fatalf("duplicate raw ID on request %d: %d", i, id)
		}
		seen[id] = true

		seq := id & MaxSequence
		if seq > MaxSequence {
			t.Fatalf("sequence %d exceeds MaxSequence %d", seq, MaxSequence)
		}
	}

	if len(seen) != requests {
		t.Errorf("expected %d unique IDs, got %d", requests, len(seen))
	}
}

// TestSnowflake_GenerateBatch verifies batch generation returns the requested count of
// unique, well-formed 14-digit order numbers, and rejects invalid counts.
func TestSnowflake_GenerateBatch(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 7)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	const count = 500
	batch, err := gen.GenerateBatch(count)
	if err != nil {
		t.Fatalf("GenerateBatch failed: %v", err)
	}
	if len(batch) != count {
		t.Fatalf("expected %d order numbers, got %d", count, len(batch))
	}

	seen := make(map[string]bool, count)
	for _, orderNumber := range batch {
		if len(orderNumber) != 14 {
			t.Errorf("expected 14-digit order number, got %q (len %d)", orderNumber, len(orderNumber))
		}
		if !VerifyLuhn(orderNumber) {
			t.Errorf("order number %q failed Luhn verification", orderNumber)
		}
		if seen[orderNumber] {
			t.Errorf("duplicate order number in batch: %s", orderNumber)
		}
		seen[orderNumber] = true
	}

	if _, err := gen.GenerateBatch(0); err == nil {
		t.Error("expected error for count = 0, got nil")
	}
	if _, err := gen.GenerateBatch(-5); err == nil {
		t.Error("expected error for negative count, got nil")
	}
}

// TestSnowflake_MultiWorkerUniqueness verifies that all 16 possible workers (the full
// 4-bit Worker ID space) generating concurrently at the same instant never collide,
// proving cross-node uniqueness requires no network coordination.
func TestSnowflake_MultiWorkerUniqueness(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const numWorkers = MaxWorkerID + 1 // 16
	const perWorker = 200

	generators := make([]*SnowflakeGenerator, numWorkers)
	for w := 0; w < numWorkers; w++ {
		gen, err := NewSnowflakeGenerator(epoch, w)
		if err != nil {
			t.Fatalf("failed to create generator for worker %d: %v", w, err)
		}
		generators[w] = gen
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	generatedIDs := make(map[string]bool)

	wg.Add(numWorkers)
	for w := 0; w < numWorkers; w++ {
		gen := generators[w]
		go func() {
			defer wg.Done()
			for j := 0; j < perWorker; j++ {
				id, err := gen.Generate()
				if err != nil {
					t.Errorf("worker generate failed: %v", err)
					return
				}
				mu.Lock()
				if generatedIDs[id] {
					t.Errorf("duplicate ID across workers: %s", id)
				}
				generatedIDs[id] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	expected := numWorkers * perWorker
	if len(generatedIDs) != expected {
		t.Errorf("expected %d unique IDs across %d workers, got %d", expected, numWorkers, len(generatedIDs))
	}
}

// TestSnowflake_TimestampExhaustion verifies that once the 35-bit timestamp budget is
// exceeded, GenerateRaw returns an error instead of silently wrapping/corrupting IDs.
func TestSnowflake_TimestampExhaustion(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 1)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	// Beyond MaxTimestamp ticks * 20ms resolution.
	beyond := time.Duration(MaxTimestamp+1) * 20 * time.Millisecond
	gen.timeProvider = func() time.Time {
		return epoch.Add(beyond)
	}

	if _, err := gen.GenerateRaw(); err == nil {
		t.Error("expected error when timestamp exceeds 35-bit budget, got nil")
	}
}

// TestSnowflake_ClockRollback checks clock rollback handling.
func TestSnowflake_ClockRollback(t *testing.T) {
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gen, err := NewSnowflakeGenerator(epoch, 1)
	if err != nil {
		t.Fatalf("failed to create generator: %v", err)
	}

	currentTime := epoch.Add(1000 * time.Millisecond)
	gen.timeProvider = func() time.Time {
		return currentTime
	}

	// Generate normal ID
	_, err = gen.GenerateRaw()
	if err != nil {
		t.Fatalf("failed to generate: %v", err)
	}

	// Move clock back by 40ms (2 ticks)
	currentTime = currentTime.Add(-40 * time.Millisecond)
	_, err = gen.GenerateRaw()
	if err == nil {
		t.Error("expected error due to clock rollback, got nil")
	}
}
