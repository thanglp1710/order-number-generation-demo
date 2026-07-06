package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// GeneratedIDsTotal counts the total number of IDs generated.
	GeneratedIDsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "order_number_generated_total",
			Help: "The total number of generated order numbers",
		},
		[]string{"method"}, // "single" or "batch"
	)

	// GenerationLatency measures latency of generation in seconds.
	GenerationLatency = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "order_number_generation_latency_seconds",
			Help:    "Latency of order number generation in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method"},
	)

	// WorkerIDGauge exposes the worker ID assigned to this instance.
	WorkerIDGauge = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "order_number_worker_id",
			Help: "The worker ID assigned to this generator instance",
		},
	)

	// SequenceOverflowsTotal counts sequence overflows where the engine had to wait.
	SequenceOverflowsTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "order_number_sequence_overflows_total",
			Help: "The total number of sequence overflows causing millisecond waits",
		},
	)
)
