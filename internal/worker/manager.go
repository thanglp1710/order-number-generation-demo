package worker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// workerIDPattern extracts the worker ID from a container name regardless of how it
// was created: a bare "docker run --name generator-worker-N", or a docker-compose
// managed container (which prefixes the Compose project name and suffixes a replica
// index, e.g. "deployments-generator-3-1").
var workerIDPattern = regexp.MustCompile(`generator(?:-worker)?-(\d+)`)

// parseWorkerIDFromName extracts the worker ID embedded in a container name.
func parseWorkerIDFromName(name string) (int, bool) {
	m := workerIDPattern.FindStringSubmatch(name)
	if m == nil {
		return 0, false
	}
	id, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return id, true
}

// Global state for locally spawned background Go processes (fallback)
var (
	localProcesses   = make(map[int]*exec.Cmd) // key: workerID
	localPorts       = make(map[int]int)       // key: workerID -> port
	localProcessesMu sync.Mutex
)

// Instance represents a running generator node.
type Instance struct {
	WorkerID int    `json:"worker_id"`
	Port     int    `json:"port"`
	Type     string `json:"type"`   // "docker" or "process"
	Status   string `json:"status"` // "running" or "exited"
}

// GetWorkerID retrieves the worker ID (0-15) using the Kubernetes StatefulSet Pod Ordinal strategy
// or falling back to the WORKER_ID Environment Variable.
func GetWorkerID() (int, error) {
	// 1. Check Env Variable (local development priority)
	envVal := os.Getenv("WORKER_ID")
	if envVal != "" {
		val, err := strconv.Atoi(envVal)
		if err == nil {
			if val >= 0 && val <= 15 {
				return val, nil
			}
			return -1, fmt.Errorf("WORKER_ID env var out of range [0, 15]: %d", val)
		}
	}

	// 2. StatefulSet Pod Name Strategy (e.g. generator-0, generator-1)
	hostname, err := os.Hostname()
	if err == nil && hostname != "" {
		parts := strings.Split(hostname, "-")
		if len(parts) > 0 {
			lastPart := parts[len(parts)-1]
			val, err := strconv.Atoi(lastPart)
			if err == nil {
				if val >= 0 && val <= 15 {
					return val, nil
				}
				return -1, fmt.Errorf("parsed worker ID from hostname %q is out of range [0, 15]: %d", hostname, val)
			}
		}
	}

	return -1, fmt.Errorf("failed to retrieve a valid Worker ID (0-15) from environment variable or StatefulSet hostname")
}

// TryStaticWorkerID attempts to resolve a Worker ID via the static strategies
// (WORKER_ID env var or StatefulSet hostname ordinal) without treating
// failure as fatal, so a caller can fall through to a dynamic strategy (e.g.
// the Kubernetes Lease allocator in lease.go) instead.
func TryStaticWorkerID() (int, bool) {
	id, err := GetWorkerID()
	if err != nil {
		return 0, false
	}
	return id, true
}

// IsDockerAvailable checks if the Docker daemon is accessible.
func IsDockerAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", "ps")
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

// ListInstances queries both Docker containers and locally spawned Go processes.
func ListInstances() ([]Instance, error) {
	var list []Instance

	// 1. Get Docker containers if available
	if IsDockerAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		// Query containers named generator- or generator-worker- (including Compose-managed ones)
		cmd := exec.CommandContext(ctx, "docker", "ps", "-a", "--filter", "name=generator", "--format", "{{.Names}}//{{.Status}}//{{.Ports}}")
		output, err := cmd.Output()
		if err == nil {
			lines := strings.Split(strings.TrimSpace(string(output)), "\n")
			for _, line := range lines {
				if line == "" {
					continue
				}
				parts := strings.Split(line, "//")
				if len(parts) >= 2 {
					name := parts[0]
					status := "exited"
					if strings.Contains(strings.ToLower(parts[1]), "up") {
						status = "running"
					}
					wID, ok := parseWorkerIDFromName(name)
					if ok {
						// Parse port from Ports string: e.g. "0.0.0.0:8083->8080/tcp" -> 8083
						port := 8080
						if len(parts) >= 3 && strings.Contains(parts[2], "->") {
							// Find port before ->
							portPart := parts[2]
							if colonIdx := strings.LastIndex(portPart, ":"); colonIdx != -1 {
								arrowIdx := strings.Index(portPart, "->")
								if arrowIdx > colonIdx {
									pVal, err := strconv.Atoi(portPart[colonIdx+1 : arrowIdx])
									if err == nil {
										port = pVal
									}
								}
							}
						}
						list = append(list, Instance{
							WorkerID: wID,
							Port:     port,
							Type:     "docker",
							Status:   status,
						})
					}
				}
			}
		}
	}

	// 2. Get local processes
	localProcessesMu.Lock()
	defer localProcessesMu.Unlock()
	for wID, cmd := range localProcesses {
		status := "running"
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			status = "exited"
		}
		list = append(list, Instance{
			WorkerID: wID,
			Port:     localPorts[wID],
			Type:     "process",
			Status:   status,
		})
	}

	return list, nil
}

// findContainerByWorkerID looks up the real container name for a worker ID, regardless
// of whether it was created by `docker run` (generator-worker-N) or by docker-compose
// (e.g. "deployments-generator-3-1"). Returns ok=false if no container matches.
func findContainerByWorkerID(ctx context.Context, workerID int) (name string, ok bool) {
	cmd := exec.CommandContext(ctx, "docker", "ps", "-a", "--filter", "name=generator", "--format", "{{.Names}}")
	output, err := cmd.Output()
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		if wID, matched := parseWorkerIDFromName(line); matched && wID == workerID {
			return line, true
		}
	}
	return "", false
}

// StartInstance brings a generator worker instance up on the given port.
// If a container for this worker ID already exists (created earlier by this
// function, or by docker-compose), it is resumed in-place via `docker start` so its
// original config/network/volumes are preserved. Only when no such container exists
// does it fall back to creating a brand-new one (or a local Go process, if Docker is
// unavailable).
func StartInstance(workerID int, port int) (string, error) {
	if workerID < 0 || workerID > 15 {
		return "", fmt.Errorf("worker ID must be between 0 and 15")
	}

	// 1. Try Docker if available
	if IsDockerAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if name, ok := findContainerByWorkerID(ctx, workerID); ok {
			if err := exec.CommandContext(ctx, "docker", "start", name).Run(); err == nil {
				return "docker", nil
			}
			// If resuming the existing container fails, fall through and try creating a new one.
		}

		// No existing container for this worker: create one from scratch.
		containerName := fmt.Sprintf("generator-worker-%d", workerID)
		cmd := exec.CommandContext(ctx, "docker", "run", "-d",
			"--name", containerName,
			"-e", fmt.Sprintf("WORKER_ID=%d", workerID),
			"-e", "PORT=8080",
			"-p", fmt.Sprintf("%d:8080", port),
			"order-number-generator:latest",
		)
		if err := cmd.Run(); err == nil {
			return "docker", nil
		}
		// If Docker fails (e.g. image not built), fall back to process execution
	}

	// 2. Local process fallback
	localProcessesMu.Lock()
	defer localProcessesMu.Unlock()

	// If already running locally, kill it first
	if oldCmd, exists := localProcesses[workerID]; exists {
		if oldCmd.Process != nil {
			_ = oldCmd.Process.Kill()
		}
		delete(localProcesses, workerID)
	}

	// Run background process: go run cmd/server/main.go
	cmd := exec.Command("go", "run", "cmd/server/main.go")
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("PORT=%d", port),
		fmt.Sprintf("WORKER_ID=%d", workerID),
		"LOG_LEVEL=info",
	)

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start Go process fallback: %w", err)
	}

	localProcesses[workerID] = cmd
	localPorts[workerID] = port

	// Wait briefly to check if it exits immediately (e.g. port already in use)
	go func() {
		_ = cmd.Wait()
	}()

	return "process", nil
}

// StopInstance gracefully stops a worker instance by worker ID, preserving the
// container (via `docker stop`) so it can be resumed later by StartInstance instead
// of being destroyed and recreated.
func StopInstance(workerID int) error {
	// 1. Stop Docker container if running
	if IsDockerAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if name, ok := findContainerByWorkerID(ctx, workerID); ok {
			_ = exec.CommandContext(ctx, "docker", "stop", name).Run()
		}
	}

	// 2. Stop local process if running
	localProcessesMu.Lock()
	defer localProcessesMu.Unlock()
	if cmd, exists := localProcesses[workerID]; exists {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		delete(localProcesses, workerID)
		delete(localPorts, workerID)
	}

	return nil
}
