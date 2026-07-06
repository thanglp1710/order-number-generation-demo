package api

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"order-number-generator/internal/generator"
	"order-number-generator/internal/metrics"
	"order-number-generator/internal/worker"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Handler handles HTTP requests for order number generation.
type Handler struct {
	gen         generator.IDGenerator
	logger      *zap.Logger
	workerID    int
	customEpoch time.Time

	generators   map[int]generator.IDGenerator
	generatorsMu sync.RWMutex
}

// NewHandler creates a new API Handler instance.
func NewHandler(gen generator.IDGenerator, logger *zap.Logger, workerID int, customEpoch time.Time) *Handler {
	gens := make(map[int]generator.IDGenerator)
	gens[workerID] = gen

	return &Handler{
		gen:         gen,
		logger:      logger,
		workerID:    workerID,
		customEpoch: customEpoch,
		generators:  gens,
	}
}

// GenerateResponse represents the response for a single ID generation request.
type GenerateResponse struct {
	OrderNumber string `json:"order_number"`
}

// BatchRequest represents the request body for batch ID generation.
type BatchRequest struct {
	Count int `json:"count" binding:"required,min=1,max=10000"`
}

// BatchResponse represents the response for a batch ID generation request.
type BatchResponse struct {
	OrderNumbers []string `json:"order_numbers"`
}

func (h *Handler) getGenerator(c *gin.Context) generator.IDGenerator {
	workerIDStr := c.Query("worker_id")
	if workerIDStr == "" {
		return h.gen
	}
	workerID, err := strconv.Atoi(workerIDStr)
	if err != nil {
		return h.gen
	}

	h.generatorsMu.RLock()
	g, exists := h.generators[workerID]
	h.generatorsMu.RUnlock()

	if exists {
		return g
	}
	return h.gen
}

// Generate handles POST /generate.
func (h *Handler) Generate(c *gin.Context) {
	start := time.Now()
	gen := h.getGenerator(c)
	orderNumber, err := gen.Generate()
	if err != nil {
		h.logger.Error("failed to generate order number", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal Server Error"})
		return
	}

	duration := time.Since(start).Seconds()
	metrics.GeneratedIDsTotal.WithLabelValues("single").Inc()
	metrics.GenerationLatency.WithLabelValues("single").Observe(duration)

	c.JSON(http.StatusOK, GenerateResponse{
		OrderNumber: orderNumber,
	})
}

// GenerateBatch handles POST /generate/batch.
func (h *Handler) GenerateBatch(c *gin.Context) {
	start := time.Now()
	var req BatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body or count out of range (1-10000)"})
		return
	}

	gen := h.getGenerator(c)
	orderNumbers, err := gen.GenerateBatch(req.Count)
	if err != nil {
		h.logger.Error("failed to generate batch of order numbers", zap.Int("count", req.Count), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal Server Error"})
		return
	}

	duration := time.Since(start).Seconds()
	metrics.GeneratedIDsTotal.WithLabelValues("batch").Add(float64(req.Count))
	metrics.GenerationLatency.WithLabelValues("batch").Observe(duration)

	c.JSON(http.StatusOK, BatchResponse{
		OrderNumbers: orderNumbers,
	})
}

// Health handles GET /health.
func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "OK"})
}

// Info handles GET /api/info.
func (h *Handler) Info(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"worker_id":    h.workerID,
		"custom_epoch": h.customEpoch.Format(time.RFC3339),
	})
}

// DockerStatus handles GET /api/docker/status.
func (h *Handler) DockerStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"available": worker.IsDockerAvailable(),
	})
}

// ListDockerInstances handles GET /api/docker/instances.
func (h *Handler) ListDockerInstances(c *gin.Context) {
	list, err := worker.ListInstances()
	if err != nil {
		h.logger.Error("failed to list instances", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, list)
}

type CreateInstanceRequest struct {
	WorkerID int `json:"worker_id" binding:"min=0,max=15"`
	Port     int `json:"port" binding:"required,min=1024,max=65535"`
}

// CreateDockerInstance handles POST /api/docker/instances.
func (h *Handler) CreateDockerInstance(c *gin.Context) {
	var req CreateInstanceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid worker ID (0-15) or Port (1024-65535)"})
		return
	}

	mode, err := worker.StartInstance(req.WorkerID, req.Port)
	if err != nil {
		h.logger.Error("failed to start instance", zap.Int("worker_id", req.WorkerID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "Instance successfully started",
		"mode":      mode, // "docker" or "process"
		"worker_id": req.WorkerID,
		"port":      req.Port,
	})
}

// DeleteDockerInstance handles DELETE /api/docker/instances.
func (h *Handler) DeleteDockerInstance(c *gin.Context) {
	workerIDStr := c.Query("worker_id")
	workerID, err := strconv.Atoi(workerIDStr)
	if err != nil || workerID < 0 || workerID > 15 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid or missing worker_id query parameter"})
		return
	}

	err = worker.StopInstance(workerID)
	if err != nil {
		h.logger.Error("failed to stop instance", zap.Int("worker_id", workerID), zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "Instance successfully stopped",
		"worker_id": workerID,
	})
}

// ListGenerators handles GET /api/generators.
func (h *Handler) ListGenerators(c *gin.Context) {
	h.generatorsMu.RLock()
	ids := make([]int, 0, len(h.generators))
	for id := range h.generators {
		ids = append(ids, id)
	}
	h.generatorsMu.RUnlock()
	c.JSON(http.StatusOK, ids)
}

type CreateGeneratorRequest struct {
	WorkerID int `json:"worker_id" binding:"required,min=0,max=15"`
}

// CreateGenerator handles POST /api/generators.
func (h *Handler) CreateGenerator(c *gin.Context) {
	var req CreateGeneratorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid worker_id (must be 0-15)"})
		return
	}

	h.generatorsMu.Lock()
	defer h.generatorsMu.Unlock()

	if _, exists := h.generators[req.WorkerID]; exists {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("Generator with worker ID %d already exists in memory", req.WorkerID)})
		return
	}

	newGen, err := generator.NewSnowflakeGenerator(h.customEpoch, req.WorkerID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.generators[req.WorkerID] = newGen
	h.logger.Info("dynamic in-memory generator created successfully", zap.Int("worker_id", req.WorkerID))

	c.JSON(http.StatusOK, gin.H{
		"message":   "Generator successfully registered in memory",
		"worker_id": req.WorkerID,
	})
}
