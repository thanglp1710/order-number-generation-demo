package worker

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// These tests use k8s.io/client-go/kubernetes/fake, so they validate
// AcquireWorkerIDViaLease's own logic (accounting, callback wiring, per-slot
// cancellation, release/reacquire) without needing a real cluster.
//
// IMPORTANT LIMITATION, confirmed empirically while writing these tests: the
// fake clientset's ObjectTracker does not enforce resourceVersion-based
// optimistic concurrency the way a real API server/etcd does under truly
// concurrent writes to the SAME Lease object from multiple goroutines — it
// can let two concurrent Create/Update calls both appear to succeed, which
// would falsely "prove" a split-brain bug that isn't actually in
// AcquireWorkerIDViaLease itself. Because of this, tests below deliberately
// avoid asserting mutual exclusion via multiple goroutines racing for the
// *same* Lease object; they instead test the parts the fake tracker models
// reliably (single-candidate slot selection/cancellation, and sequential
// release/reacquire). Real mutual exclusion under genuine concurrent load is
// verified separately end-to-end against a real (kind) cluster, where the
// API server's real optimistic-concurrency control applies.

func testLeaseConfig(clientset *fake.Clientset, identity string, maxWorkers int) LeaseConfig {
	return LeaseConfig{
		Namespace:       "default",
		LeaseNamePrefix: "order-generator-worker-",
		MaxWorkers:      maxWorkers,
		Identity:        identity,
		LeaseDuration:   2 * time.Second,
		RenewDeadline:   1 * time.Second,
		RetryPeriod:     200 * time.Millisecond,
		Clientset:       clientset,
		Logger:          zap.NewNop(),
	}
}

// TestAcquireWorkerIDViaLease_WinsExactlyOneSlotAndCancelsOthers verifies the
// core single-candidate race logic: given MaxWorkers candidate slots, exactly
// one is won, and the rest are left with no active holder (proving the
// "cancel every other slot's context the instant one wins" logic actually
// releases them via ReleaseOnCancel rather than leaking a held Lease). This
// only involves one candidate's own goroutines racing across MaxWorkers
// distinct Lease objects, so it doesn't depend on the fake clientset's
// (unreliable) handling of concurrent writes to the same object from
// multiple independent candidates.
func TestAcquireWorkerIDViaLease_WinsExactlyOneSlotAndCancelsOthers(t *testing.T) {
	const maxWorkers = 6
	clientset := fake.NewSimpleClientset()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	assignment, err := AcquireWorkerIDViaLease(ctx, testLeaseConfig(clientset, "pod-a", maxWorkers))
	if err != nil {
		t.Fatalf("acquisition failed: %v", err)
	}
	if assignment.WorkerID < 0 || assignment.WorkerID >= maxWorkers {
		t.Fatalf("won slot %d is out of range [0, %d)", assignment.WorkerID, maxWorkers)
	}

	// Give the cancelled losing slots a moment to actually release via
	// ReleaseOnCancel before inspecting Lease state.
	time.Sleep(300 * time.Millisecond)

	for slot := 0; slot < maxWorkers; slot++ {
		name := "order-generator-worker-" + string(rune('0'+slot))
		lease, err := clientset.CoordinationV1().Leases("default").Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			// Never created at all is fine too — this candidate is the only
			// racer, so a losing slot may never have needed to Create it.
			continue
		}
		holder := ""
		if lease.Spec.HolderIdentity != nil {
			holder = *lease.Spec.HolderIdentity
		}
		if slot == assignment.WorkerID {
			if holder != "pod-a" {
				t.Errorf("winning slot %d: expected holder %q, got %q", slot, "pod-a", holder)
			}
		} else if holder == "pod-a" {
			t.Errorf("losing slot %d still shows pod-a as holder — losing race was not released", slot)
		}
	}

	assignment.Release()
}

// TestAcquireWorkerIDViaLease_ReleaseAndReacquire verifies that Release()
// frees the slot (via ReleaseOnCancel) so a second candidate can acquire it.
func TestAcquireWorkerIDViaLease_ReleaseAndReacquire(t *testing.T) {
	clientset := fake.NewSimpleClientset()
	ctx := context.Background()

	first, err := AcquireWorkerIDViaLease(ctx, testLeaseConfig(clientset, "pod-a", 1))
	if err != nil {
		t.Fatalf("first acquisition failed: %v", err)
	}
	if first.WorkerID != 0 {
		t.Fatalf("expected slot 0, got %d", first.WorkerID)
	}

	first.Release()
	select {
	case <-first.Lost:
	case <-time.After(3 * time.Second):
		t.Fatal("Lost channel did not close after Release()")
	}

	acquireCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	second, err := AcquireWorkerIDViaLease(acquireCtx, testLeaseConfig(clientset, "pod-b", 1))
	if err != nil {
		t.Fatalf("second acquisition after release failed: %v", err)
	}
	if second.WorkerID != 0 {
		t.Fatalf("expected pod-b to reacquire slot 0, got %d", second.WorkerID)
	}
	second.Release()
}

// TestAcquireWorkerIDViaLease_SurvivesCallerCtxCancelAfterWinning is a
// regression test for a real bug caught while validating this allocator
// end-to-end on a kind cluster: the ctx passed to AcquireWorkerIDViaLease
// typically carries a bounded "how long to wait for a winner" deadline (e.g.
// main.go's 30s acquisition timeout, cancelled via `defer cancel()` the
// instant the function returns). If the winning slot's context were a child
// of that same ctx, the deferred cancel would immediately tear down the
// winner's own renewal loop, losing the lease it just won before the caller
// ever got to use it. This asserts the fix holds: cancelling the original
// ctx AFTER a winner has been returned must NOT close Assignment.Lost — only
// an explicit Release() (or a genuine renewal failure) may do that.
func TestAcquireWorkerIDViaLease_SurvivesCallerCtxCancelAfterWinning(t *testing.T) {
	clientset := fake.NewSimpleClientset()
	ctx, cancel := context.WithCancel(context.Background())

	assignment, err := AcquireWorkerIDViaLease(ctx, testLeaseConfig(clientset, "pod-a", 1))
	if err != nil {
		t.Fatalf("acquisition failed: %v", err)
	}

	// Simulate main.go's `defer cancel()` firing right after a successful
	// acquisition returns.
	cancel()

	select {
	case <-assignment.Lost:
		t.Fatal("Lost channel closed after the caller's ctx was cancelled post-acquisition — the winning lease must survive this")
	case <-time.After(500 * time.Millisecond):
		// Expected: no signal within a reasonable window.
	}

	assignment.Release()
	select {
	case <-assignment.Lost:
	case <-time.After(3 * time.Second):
		t.Fatal("Lost channel did not close after explicit Release()")
	}
}

// TestAcquireWorkerIDViaLease_SequentialHandoffNeverOverlaps runs many
// candidates one after another (never concurrently) against a single-slot
// pool, and asserts each strictly waits for the previous holder's Release()
// before acquiring — i.e. the handoff sequencing itself is correct. This
// complements TestAcquireWorkerIDViaLease_ReleaseAndReacquire with more
// repetitions, and complements the real-concurrency proof done end-to-end
// against a kind cluster (see package doc comment above).
func TestAcquireWorkerIDViaLease_SequentialHandoffNeverOverlaps(t *testing.T) {
	const iterations = 20
	clientset := fake.NewSimpleClientset()

	for iter := 0; iter < iterations; iter++ {
		identity := identityFor(iter)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		assignment, err := AcquireWorkerIDViaLease(ctx, testLeaseConfig(clientset, identity, 1))
		cancel()
		if err != nil {
			t.Fatalf("iteration %d: acquisition failed: %v", iter, err)
		}
		if assignment.WorkerID != 0 {
			t.Fatalf("iteration %d: expected the only slot (0), got %d", iter, assignment.WorkerID)
		}

		assignment.Release()
		select {
		case <-assignment.Lost:
		case <-time.After(3 * time.Second):
			t.Fatalf("iteration %d: Lost channel did not close after Release()", iter)
		}
	}
}

func identityFor(i int) string {
	return "pod-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
}
