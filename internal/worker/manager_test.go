package worker

import (
	"os"
	"testing"
)

func TestGetWorkerID_EnvVar(t *testing.T) {
	os.Setenv("WORKER_ID", "12")
	defer os.Unsetenv("WORKER_ID")

	id, err := GetWorkerID()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if id != 12 {
		t.Errorf("expected worker ID 12, got %d", id)
	}
}

func TestGetWorkerID_EnvVarInvalid(t *testing.T) {
	os.Setenv("WORKER_ID", "20")
	defer os.Unsetenv("WORKER_ID")

	_, err := GetWorkerID()
	if err == nil {
		t.Error("expected error for WORKER_ID > 15, got nil")
	}
}

func TestGetWorkerID_EnvVarNegative(t *testing.T) {
	os.Setenv("WORKER_ID", "-1")
	defer os.Unsetenv("WORKER_ID")

	_, err := GetWorkerID()
	if err == nil {
		t.Error("expected error for negative WORKER_ID, got nil")
	}
}
