package generator

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Custom Snowflake constant bit widths
const (
	TimestampBits = 35
	WorkerIDBits  = 4
	SequenceBits  = 4

	// Max values
	MaxTimestamp = (1 << TimestampBits) - 1 // 34,359,738,367
	MaxWorkerID  = (1 << WorkerIDBits) - 1  // 15
	MaxSequence  = (1 << SequenceBits) - 1  // 15

	// Shifts
	WorkerIDShift  = SequenceBits
	TimestampShift = SequenceBits + WorkerIDBits // 8
)

// SnowflakeGenerator implements the IDGenerator interface using custom Snowflake.
type SnowflakeGenerator struct {
	mu           sync.Mutex
	epoch        time.Time
	workerID     int64
	lastTicks    int64
	sequence     int64
	timeProvider func() time.Time // pluggable for unit testing
}

// NewSnowflakeGenerator creates a thread-safe custom Snowflake generator.
func NewSnowflakeGenerator(epoch time.Time, workerID int) (*SnowflakeGenerator, error) {
	if workerID < 0 || workerID > MaxWorkerID {
		return nil, fmt.Errorf("worker ID must be between 0 and %d, got %d", MaxWorkerID, workerID)
	}

	return &SnowflakeGenerator{
		epoch:        epoch,
		workerID:     int64(workerID),
		lastTicks:    -1,
		sequence:     0,
		timeProvider: time.Now,
	}, nil
}

// GenerateRaw generates a raw 43-bit unique integer.
func (g *SnowflakeGenerator) GenerateRaw() (int64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := g.timeProvider()
	elapsed := now.Sub(g.epoch)
	if elapsed < 0 {
		return 0, fmt.Errorf("system clock is before custom epoch")
	}

	// 20ms resolution ticks
	ticks := int64(elapsed / (20 * time.Millisecond))

	if ticks < g.lastTicks {
		// Clock rollback detected
		return 0, fmt.Errorf("clock rollback detected: clock moved backwards by %d ticks", g.lastTicks-ticks)
	}

	if ticks == g.lastTicks {
		g.sequence = (g.sequence + 1) & MaxSequence
		if g.sequence == 0 {
			// Sequence overflow in the current 20ms tick.
			// Spin-wait until the clock moves forward.
			for ticks <= g.lastTicks {
				now = g.timeProvider()
				elapsed = now.Sub(g.epoch)
				ticks = int64(elapsed / (20 * time.Millisecond))
			}
			g.sequence = 0
		}
	} else {
		g.sequence = 0
	}

	if ticks > MaxTimestamp {
		return 0, errors.New("timestamp limit exceeded (exhausted 35 bits)")
	}

	g.lastTicks = ticks

	// Bit assembly: 35 bits timestamp | 4 bits worker | 4 bits sequence
	id := (ticks << TimestampShift) | (g.workerID << WorkerIDShift) | g.sequence
	return id, nil
}

// Generate generates the 14-digit order number (13 digits Snowflake decimal + 1 Luhn check digit).
func (g *SnowflakeGenerator) Generate() (string, error) {
	rawID, err := g.GenerateRaw()
	if err != nil {
		return "", err
	}

	// Format as 13-digit decimal string, left-padded with zeroes if necessary.
	// Since 2^43 - 1 is 8,796,093,022,207 (13 digits), this is guaranteed to fit in 13 digits.
	snowflakeStr := fmt.Sprintf("%013d", rawID)

	// Calculate and append the Luhn check digit
	checkDigit := CalculateLuhn(snowflakeStr)
	return fmt.Sprintf("%s%d", snowflakeStr, checkDigit), nil
}

// GenerateBatch generates a slice of unique 14-digit order numbers.
func (g *SnowflakeGenerator) GenerateBatch(count int) ([]string, error) {
	if count <= 0 {
		return nil, errors.New("batch count must be greater than zero")
	}

	results := make([]string, count)
	for i := 0; i < count; i++ {
		val, err := g.Generate()
		if err != nil {
			return nil, err
		}
		results[i] = val
	}
	return results, nil
}
