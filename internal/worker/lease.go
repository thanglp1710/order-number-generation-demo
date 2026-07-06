package worker

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// LeaseConfig carries the tunables needed to run the Worker ID lease race.
type LeaseConfig struct {
	// Namespace is the Kubernetes namespace the Lease objects live in.
	Namespace string
	// LeaseNamePrefix names each candidate slot's Lease object as
	// "<prefix><slot>" for slot in [0, MaxWorkers). It must be identical
	// across every pod racing for the same pool of slots.
	LeaseNamePrefix string
	// MaxWorkers is the number of candidate slots (0..MaxWorkers-1) raced for.
	MaxWorkers int
	// Identity uniquely identifies this pod as a Lease holder (e.g. pod name).
	Identity string

	LeaseDuration time.Duration
	RenewDeadline time.Duration
	RetryPeriod   time.Duration

	Clientset kubernetes.Interface
	Logger    *zap.Logger
}

// Assignment represents a Worker ID slot won via the Lease race.
type Assignment struct {
	WorkerID int
	// Lost is closed exactly once, the instant this pod's ownership of
	// WorkerID ends (renewal failure, or Release() was called). Callers MUST
	// treat a close on this channel as fatal and stop minting IDs
	// immediately: continuing to serve requests after losing the lease risks
	// two pods sharing the same Worker ID and colliding order numbers.
	Lost <-chan struct{}
	// Release cancels this pod's participation. Because the underlying
	// election runs with ReleaseOnCancel, this also releases the Lease
	// immediately instead of waiting out LeaseDuration, allowing the next
	// candidate to take over the slot quickly during a graceful shutdown.
	Release func()
}

// BuildInClusterClientset builds a Kubernetes clientset from the in-cluster
// ServiceAccount credentials. It only succeeds when running inside a real
// Kubernetes Pod (a mounted ServiceAccount token + CA is required) — there is
// no fallback, by design: a caller configured for the "lease" Worker ID
// strategy has no other legitimate identity source.
func BuildInClusterClientset() (kubernetes.Interface, error) {
	restCfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load in-cluster Kubernetes config: %w", err)
	}
	clientset, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to build Kubernetes clientset: %w", err)
	}
	return clientset, nil
}

// winnerSignal is sent on the shared "won" channel the instant any one slot's
// election succeeds.
type winnerSignal struct {
	slot int
	lost chan struct{}
}

// AcquireWorkerIDViaLease races this pod, concurrently, for ownership of one
// of [0, cfg.MaxWorkers) Worker ID slots, each backed by its own
// coordination.k8s.io/v1 Lease object named "<prefix><slot>". It returns as
// soon as any one slot is won; every other in-flight race started by this
// call is cancelled at that point. If ctx is cancelled/times out before any
// slot is won (e.g. all slots are already held elsewhere), it returns
// ctx.Err() wrapped with context.
//
// Only ctx cancellation and the eventual Release() on a returned Assignment
// ever stop the winning slot's underlying election/renewal loop — cancelling
// the *other* losing slots never touches the winner's own context, which
// must keep renewing for the life of the process.
func AcquireWorkerIDViaLease(ctx context.Context, cfg LeaseConfig) (*Assignment, error) {
	if cfg.MaxWorkers <= 0 {
		return nil, fmt.Errorf("MaxWorkers must be > 0, got %d", cfg.MaxWorkers)
	}
	if cfg.Clientset == nil {
		return nil, fmt.Errorf("Clientset must not be nil")
	}

	// Slot contexts are deliberately derived from a fresh, independent
	// lifecycle context — NOT directly from the caller's ctx. The caller's
	// ctx typically carries a bounded "how long to wait for a winner"
	// deadline/cancel (e.g. context.WithTimeout(..., 30*time.Second) in
	// main.go, whose defer cancel() fires the moment this function
	// returns). If slot contexts were children of that ctx, the winning
	// slot's own renewal loop would be cancelled the instant this function
	// returns successfully — losing the lease it just won before the caller
	// ever gets to use it. lifecycle is only ever cancelled here, either by
	// the caller giving up (ctx.Done() below, before anyone has won) or by
	// the eventual winner's own Assignment.Release().
	lifecycle, cancelLifecycle := context.WithCancel(context.Background())
	slotCtx := make([]context.Context, cfg.MaxWorkers)
	slotCancel := make([]context.CancelFunc, cfg.MaxWorkers)
	for i := 0; i < cfg.MaxWorkers; i++ {
		slotCtx[i], slotCancel[i] = context.WithCancel(lifecycle)
	}
	// cancelAllExcept stops every slot's race except the given winner, so the
	// winner's own election+renewal loop is left completely untouched.
	cancelAllExcept := func(winner int) {
		for i, cancel := range slotCancel {
			if i != winner {
				cancel()
			}
		}
	}

	won := make(chan winnerSignal, 1)

	for slot := 0; slot < cfg.MaxWorkers; slot++ {
		slot := slot
		leaseLock := &resourcelock.LeaseLock{
			LeaseMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("%s%d", cfg.LeaseNamePrefix, slot),
				Namespace: cfg.Namespace,
			},
			Client: cfg.Clientset.CoordinationV1(),
			LockConfig: resourcelock.ResourceLockConfig{
				Identity: cfg.Identity,
			},
		}

		lost := make(chan struct{})
		le, err := leaderelection.NewLeaderElector(leaderelection.LeaderElectionConfig{
			Lock:            leaseLock,
			LeaseDuration:   cfg.LeaseDuration,
			RenewDeadline:   cfg.RenewDeadline,
			RetryPeriod:     cfg.RetryPeriod,
			ReleaseOnCancel: true,
			Callbacks: leaderelection.LeaderCallbacks{
				OnStartedLeading: func(_ context.Context) {
					// First-write-wins: only one slot's signal is ever
					// consumed (see the select below), so a spurious
					// second send (should not happen in practice) must
					// not block this callback goroutine forever.
					select {
					case won <- winnerSignal{slot: slot, lost: lost}:
					default:
					}
				},
				OnStoppedLeading: func() {
					close(lost)
				},
			},
		})
		if err != nil {
			// A construction failure for one slot must not take down the
			// whole race; log and drop just this slot.
			if cfg.Logger != nil {
				cfg.Logger.Warn("failed to build LeaderElector for Worker ID slot",
					zap.Int("slot", slot), zap.Error(err))
			}
			slotCancel[slot]()
			continue
		}

		go le.Run(slotCtx[slot])
	}

	select {
	case w := <-won:
		cancelAllExcept(w.slot)
		// Release tears down this whole acquisition's lifecycle (which, by
		// this point, only the winning slot is still using) rather than
		// just the winning slot's own context, so cancelLifecycle is always
		// invoked on every return path from this function.
		release := func() { cancelLifecycle() }
		return &Assignment{WorkerID: w.slot, Lost: w.lost, Release: release}, nil
	case <-ctx.Done():
		// Nobody won within the caller's deadline: abandon the whole race.
		cancelLifecycle()
		return nil, fmt.Errorf("failed to acquire any Worker ID lease slot (all %d in use): %w", cfg.MaxWorkers, ctx.Err())
	}
}
