package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config represents the application configuration.
type Config struct {
	Port        string    `mapstructure:"PORT"`
	WorkerID    int       `mapstructure:"WORKER_ID"`
	CustomEpoch time.Time `mapstructure:"CUSTOM_EPOCH"`
	LogLevel    string    `mapstructure:"LOG_LEVEL"`

	// WorkerIDStrategy selects how the Worker ID is resolved at startup:
	//   "auto"     - try WORKER_ID env var / StatefulSet hostname ordinal first,
	//                fall through to the Kubernetes Lease allocator if neither resolves.
	//   "env"      - WORKER_ID env var only (fatal if unset/invalid).
	//   "hostname" - StatefulSet hostname ordinal only (fatal if unset/invalid).
	//   "lease"    - Kubernetes Lease allocator only, no static fallback.
	WorkerIDStrategy string `mapstructure:"WORKER_ID_STRATEGY"`
	// K8sNamespace is the namespace the Worker ID Lease objects live in.
	K8sNamespace string `mapstructure:"K8S_NAMESPACE"`
	// MaxWorkers is the number of Worker ID slots (0..MaxWorkers-1) the Lease
	// allocator races over; must not exceed generator.MaxWorkerID+1.
	MaxWorkers int `mapstructure:"MAX_WORKERS"`
	// LeaseNamePrefix names each candidate slot's Lease object as "<prefix><slot>".
	LeaseNamePrefix string `mapstructure:"LEASE_NAME_PREFIX"`

	LeaseDuration      time.Duration `mapstructure:"LEASE_DURATION"`
	LeaseRenewDeadline time.Duration `mapstructure:"LEASE_RENEW_DEADLINE"`
	LeaseRetryPeriod   time.Duration `mapstructure:"LEASE_RETRY_PERIOD"`
}

// Load loads the configuration from environment variables and optional .env file.
func Load() (*Config, error) {
	viper.AutomaticEnv()
	// Set defaults
	viper.SetDefault("PORT", "8080")
	viper.SetDefault("WORKER_ID", "-1") // -1 indicates unset/unvalidated
	viper.SetDefault("CUSTOM_EPOCH", "2026-01-01T00:00:00Z")
	viper.SetDefault("LOG_LEVEL", "info")

	// Worker ID assignment strategy. Default "auto" preserves today's exact
	// env-var/hostname-ordinal behavior for Docker Compose and local runs,
	// since those never set WORKER_ID_STRATEGY at all; only Kubernetes
	// Deployments that explicitly opt into "lease" invoke client-go.
	viper.SetDefault("WORKER_ID_STRATEGY", "auto")
	viper.SetDefault("K8S_NAMESPACE", "default")
	viper.SetDefault("MAX_WORKERS", 16)
	viper.SetDefault("LEASE_NAME_PREFIX", "order-generator-worker-")
	// Mirrors kube-scheduler/controller-manager's own leader-election defaults.
	viper.SetDefault("LEASE_DURATION", "15s")
	viper.SetDefault("LEASE_RENEW_DEADLINE", "10s")
	viper.SetDefault("LEASE_RETRY_PERIOD", "2s")

	// Allow reading from env variables
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	var rawEpoch = viper.GetString("CUSTOM_EPOCH")
	epochTime, err := time.Parse(time.RFC3339, rawEpoch)
	if err != nil {
		return nil, fmt.Errorf("invalid CUSTOM_EPOCH format (must be RFC3339): %w", err)
	}

	cfg := &Config{
		Port:        viper.GetString("PORT"),
		WorkerID:    viper.GetInt("WORKER_ID"),
		CustomEpoch: epochTime,
		LogLevel:    viper.GetString("LOG_LEVEL"),

		WorkerIDStrategy:   viper.GetString("WORKER_ID_STRATEGY"),
		K8sNamespace:       viper.GetString("K8S_NAMESPACE"),
		MaxWorkers:         viper.GetInt("MAX_WORKERS"),
		LeaseNamePrefix:    viper.GetString("LEASE_NAME_PREFIX"),
		LeaseDuration:      viper.GetDuration("LEASE_DURATION"),
		LeaseRenewDeadline: viper.GetDuration("LEASE_RENEW_DEADLINE"),
		LeaseRetryPeriod:   viper.GetDuration("LEASE_RETRY_PERIOD"),
	}

	return cfg, nil
}
