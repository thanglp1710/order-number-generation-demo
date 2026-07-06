package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"order-number-generator/internal/api"
	"order-number-generator/internal/config"
	"order-number-generator/internal/generator"
	"order-number-generator/internal/metrics"
	"order-number-generator/internal/worker"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func main() {
	// Initialize structured logging (Zap)
	logConfig := zap.NewProductionConfig()
	logConfig.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	logger, err := logConfig.Build()
	if err != nil {
		panic("failed to initialize zap logger: " + err.Error())
	}
	defer logger.Sync()

	logger.Info("Starting Order Number Generator Service...")

	// Phase 2: Configuration Loader
	cfg, err := config.Load()
	if err != nil {
		logger.Fatal("failed to load configuration", zap.Error(err))
	}

	// Set Gin mode
	if cfg.LogLevel == "debug" {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	// Phase 4: Worker Assignment
	workerID, assignment, err := resolveWorkerID(cfg, logger)
	if err != nil {
		logger.Fatal("Worker ID resolution failed. Application exiting immediately.", zap.Error(err))
	}
	logger.Info("Worker ID successfully resolved and validated",
		zap.Int("worker_id", workerID), zap.String("strategy", cfg.WorkerIDStrategy))

	// If the Worker ID came from a Kubernetes Lease, losing it at any point
	// (renewal failure, or another pod somehow taking it over) must stop
	// this process from minting IDs immediately — continuing even briefly
	// risks two pods sharing the same Worker ID and colliding order numbers.
	// This is deliberately NOT routed through the graceful HTTP shutdown
	// path below: correctness here outweighs a clean drain.
	if assignment != nil {
		go func() {
			<-assignment.Lost
			logger.Fatal("Worker ID Lease lost — exiting immediately to avoid a duplicate Worker ID assignment",
				zap.Int("worker_id", workerID))
		}()
	}

	// Register worker ID to Prometheus metric
	metrics.WorkerIDGauge.Set(float64(workerID))

	// Phase 3: Snowflake Engine Initialization
	snowflakeGen, err := generator.NewSnowflakeGenerator(cfg.CustomEpoch, workerID)
	if err != nil {
		logger.Fatal("failed to create Snowflake generator", zap.Error(err))
	}

	// Set up Gin Router
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS middleware to allow multi-instance dashboard integrations
	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, DELETE")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// Custom logging middleware using Zap
	r.Use(func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		logger.Info("HTTP Request",
			zap.Int("status", status),
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.String("query", query),
			zap.Duration("latency", latency),
			zap.String("ip", c.ClientIP()),
		)
	})

	// Setup API handlers
	handler := api.NewHandler(snowflakeGen, logger, workerID, cfg.CustomEpoch)

	r.POST("/generate", handler.Generate)
	r.POST("/generate/batch", handler.GenerateBatch)
	r.GET("/health", handler.Health)
	r.GET("/api/info", handler.Info)
	r.GET("/api/generators", handler.ListGenerators)
	r.POST("/api/generators", handler.CreateGenerator)
	r.GET("/api/docker/status", handler.DockerStatus)
	r.GET("/api/docker/instances", handler.ListDockerInstances)
	r.POST("/api/docker/instances", handler.CreateDockerInstance)
	r.DELETE("/api/docker/instances", handler.DeleteDockerInstance)
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	// Graceful Shutdown
	go func() {
		logger.Info("Starting HTTP Server", zap.String("port", cfg.Port))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal("ListenAndServe failed", zap.Error(err))
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server with a timeout of 5 seconds.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("Shutting down HTTP Server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Fatal("Server forced to shutdown", zap.Error(err))
	}

	// Release the Worker ID Lease (if one was acquired) immediately rather
	// than waiting out LeaseDuration, so the next pod can take over the slot
	// quickly — this is what makes scale-down/rolling-update handoff fast.
	if assignment != nil {
		assignment.Release()
	}

	logger.Info("Server exited gracefully.")
}

// resolveWorkerID resolves this process's Worker ID according to
// cfg.WorkerIDStrategy:
//
//   - "env"/"hostname": worker.GetWorkerID() only, fatal (returned as an
//     error here) if it can't resolve — no fallback.
//   - "lease": Kubernetes Lease allocator only, no static fallback.
//   - "auto" (default): try the static strategies first (preserves today's
//     exact behavior for Docker Compose / local runs, which never set
//     WORKER_ID_STRATEGY), falling through to the Lease allocator only if
//     neither WORKER_ID nor a StatefulSet hostname ordinal resolved.
//
// The returned *worker.Assignment is non-nil only when the Lease path was
// used; callers must watch its Lost channel and call Release() on shutdown.
func resolveWorkerID(cfg *config.Config, logger *zap.Logger) (int, *worker.Assignment, error) {
	acquireLease := func() (int, *worker.Assignment, error) {
		if cfg.MaxWorkers <= 0 || cfg.MaxWorkers > generator.MaxWorkerID+1 {
			return 0, nil, fmt.Errorf("MAX_WORKERS (%d) must be between 1 and %d", cfg.MaxWorkers, generator.MaxWorkerID+1)
		}
		clientset, err := worker.BuildInClusterClientset()
		if err != nil {
			return 0, nil, fmt.Errorf("lease strategy requires running inside Kubernetes: %w", err)
		}
		identity, err := os.Hostname()
		if err != nil || identity == "" {
			return 0, nil, fmt.Errorf("failed to determine pod identity for lease acquisition: %w", err)
		}

		acquireCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		assignment, err := worker.AcquireWorkerIDViaLease(acquireCtx, worker.LeaseConfig{
			Namespace:       cfg.K8sNamespace,
			LeaseNamePrefix: cfg.LeaseNamePrefix,
			MaxWorkers:      cfg.MaxWorkers,
			Identity:        identity,
			LeaseDuration:   cfg.LeaseDuration,
			RenewDeadline:   cfg.LeaseRenewDeadline,
			RetryPeriod:     cfg.LeaseRetryPeriod,
			Clientset:       clientset,
			Logger:          logger,
		})
		if err != nil {
			return 0, nil, err
		}
		return assignment.WorkerID, assignment, nil
	}

	switch cfg.WorkerIDStrategy {
	case "env", "hostname":
		id, err := worker.GetWorkerID()
		if err != nil {
			return 0, nil, err
		}
		return id, nil, nil
	case "lease":
		return acquireLease()
	case "auto", "":
		if id, ok := worker.TryStaticWorkerID(); ok {
			return id, nil, nil
		}
		return acquireLease()
	default:
		return 0, nil, fmt.Errorf("unknown WORKER_ID_STRATEGY %q (must be one of: auto, env, hostname, lease)", cfg.WorkerIDStrategy)
	}
}
