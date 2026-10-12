package scheduler

import (
	"context"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/store"
	"github.com/Appletree24/Detroit/internal/workerkit"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

const smokeSpec = `
name: smoke
subject: {adapter: mock, digest: mock@1}
taskset:
  vertical: agent
  source: synthetic
  suites: [a, b]
  variants: [base, tool_latency_2s]
  init_states: 2
  seeds: [0, 1]
  repeats: 2
  options: {tasks_per_suite: 3, init_states_per_task: 4}
`

func TestPlanExpansion(t *testing.T) {
	spec, err := core.ParseRunSpec([]byte(smokeSpec))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Plan(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	// 2 suites × 3 tasks × 2 variants × 2 init_states × 2 seeds × 2 repeats
	if want := 2 * 3 * 2 * 2 * 2 * 2; len(p.Episodes) != want {
		t.Fatalf("episodes: got %d want %d", len(p.Episodes), want)
	}
	keys := map[string]bool{}
	for _, ep := range p.Episodes {
		if keys[ep.Key] {
			t.Fatalf("duplicate key for %+v", ep)
		}
		keys[ep.Key] = true
	}
	again, _ := Plan(context.Background(), spec)
	for i := range p.Episodes {
		if p.Episodes[i] != again.Episodes[i] {
			t.Fatal("plan must be deterministic")
		}
	}
	if p.TaskSetHash == "" || p.TaskSetHash != again.TaskSetHash {
		t.Fatal("taskset hash must be stable")
	}

	bad, _ := core.ParseRunSpec([]byte("name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: synthetic, init_states: 5}\n"))
	if _, err := Plan(context.Background(), bad); err == nil {
		t.Fatal("asking for more init states than available must fail")
	}
	missing, _ := core.ParseRunSpec([]byte("name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: nope}\n"))
	if _, err := Plan(context.Background(), missing); err == nil {
		t.Fatal("unknown source must fail")
	}
}

type harness struct {
	store  *store.Store
	client workerv1.SchedulerClient
}

func start(t *testing.T, cfg Config) *harness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "d.db"))
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(st, cfg)
	lis := bufconn.Listen(1 << 20)
	gs := grpc.NewServer()
	workerv1.RegisterSchedulerServer(gs, svc)
	go gs.Serve(lis)
	ctx, cancel := context.WithCancel(context.Background())
	go svc.Reap(ctx)
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		conn.Close()
		gs.Stop()
		st.Close()
	})
	return &harness{store: st, client: workerv1.NewSchedulerClient(conn)}
}

func (h *harness) submit(t *testing.T, yaml string) string {
	t.Helper()
	spec, err := core.ParseRunSpec([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Plan(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Submit(context.Background(), spec, []byte(yaml), nil, p.Episodes, time.Now()); err != nil {
		t.Fatal(err)
	}
	return spec.RunID()
}

func (h *harness) waitDone(t *testing.T, runID string, timeout time.Duration) *store.RunSummary {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		sum, err := h.store.Summary(context.Background(), runID)
		if err != nil {
			t.Fatal(err)
		}
		if sum.Status == store.RunDone {
			return sum
		}
		if time.Now().After(deadline) {
			t.Fatalf("run not done after %s: %+v", timeout, sum.Episodes)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 模拟 Worker 随机崩溃：所有 episode 最终完成或进入 infra_error，每个 episode 恰好一条结果（docs/08 M1 验收）。
func TestRandomWorkerCrashesConverge(t *testing.T) {
	h := start(t, Config{LeaseTTL: 300 * time.Millisecond, MaxAttempts: 4, ReapInterval: 50 * time.Millisecond})
	runID := h.submit(t, smokeSpec)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	for i, w := range []struct {
		id    string
		crash float64
	}{{"w0", 0.3}, {"w1", 0.3}, {"w2", 0}} {
		wctx := ctx
		if i == 0 {
			// w0 在中途整体退出：它持有的租约必须过期并被其他 Worker 接手。
			var stop context.CancelFunc
			wctx, stop = context.WithTimeout(ctx, 400*time.Millisecond)
			defer stop()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			workerkit.Run(wctx, h.client, workerkit.Config{WorkerID: w.id, Vertical: "agent", Slots: 4, PollInterval: 20 * time.Millisecond},
				&workerkit.Mock{SuccessRate: 0.6, UnknownRate: 0.1, CrashRate: w.crash, Delay: 10 * time.Millisecond})
		}()
	}
	sum := h.waitDone(t, runID, 30*time.Second)
	cancel()
	wg.Wait()

	total := sum.Episodes[string(core.StatusDone)] + sum.Episodes[string(core.StatusInfraError)]
	if total != 96 || sum.Episodes[store.EpisodePending]+sum.Episodes[store.EpisodeLeased] != 0 {
		t.Fatalf("episodes not all terminal: %+v", sum.Episodes)
	}
	n, _ := h.store.ResultCount(context.Background(), runID)
	if n != 96 {
		t.Fatalf("want exactly one result per episode, got %d", n)
	}
	if sum.Overall.N+sum.Overall.Unknowns+sum.Overall.InfraErrors != 96 {
		t.Fatalf("aggregate does not add up: %+v", sum.Overall)
	}
	t.Logf("overall %+v error_kinds %v", sum.Overall, sum.ErrorKinds)
}

// 确定性结果：同一个 RunSpec 无论跑几次、经过多少次崩溃，有效结果都相同。
func TestResultsIndependentOfCrashes(t *testing.T) {
	run := func(crash float64) core.Aggregate {
		h := start(t, Config{LeaseTTL: 200 * time.Millisecond, MaxAttempts: 100, ReapInterval: 20 * time.Millisecond})
		runID := h.submit(t, smokeSpec)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			workerkit.Run(ctx, h.client, workerkit.Config{WorkerID: "w", Vertical: "agent", Slots: 8, PollInterval: 10 * time.Millisecond},
				&workerkit.Mock{SuccessRate: 0.5, CrashRate: crash})
		}()
		sum := h.waitDone(t, runID, 30*time.Second)
		cancel()
		<-done
		return sum.Overall
	}
	clean, crashy := run(0), run(0.4)
	if clean.InfraErrors != 0 || crashy.InfraErrors != 0 {
		t.Fatalf("with 100 attempts nothing should exhaust: %+v %+v", clean, crashy)
	}
	if clean.Successes != crashy.Successes || clean.N != crashy.N {
		t.Fatalf("results changed under crashes: clean %+v crashy %+v", clean, crashy)
	}
}

func TestCancelStopsWorkers(t *testing.T) {
	h := start(t, Config{LeaseTTL: 300 * time.Millisecond, MaxAttempts: 3, ReapInterval: 50 * time.Millisecond})
	runID := h.submit(t, smokeSpec)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	exec := &workerkit.Mock{SuccessRate: 1, Delay: time.Hour} // 永远不会自己结束
	go workerkit.Run(ctx, h.client, workerkit.Config{WorkerID: "w", Vertical: "agent", Slots: 4, PollInterval: 20 * time.Millisecond}, exec)

	deadline := time.Now().Add(5 * time.Second)
	for {
		sum, _ := h.store.Summary(context.Background(), runID)
		if sum.Episodes[store.EpisodeLeased] == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("worker never leased: %+v", sum.Episodes)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := h.store.Cancel(context.Background(), runID); err != nil {
		t.Fatal(err)
	}
	// 心跳收到取消后 Worker 停止续租，租约过期回到 pending，且不会再被租出。
	deadline = time.Now().Add(5 * time.Second)
	for {
		sum, _ := h.store.Summary(context.Background(), runID)
		if sum.Episodes[store.EpisodeLeased] == 0 {
			if sum.Episodes[string(core.StatusDone)] != 0 {
				t.Fatalf("cancelled episodes must not report: %+v", sum.Episodes)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("leases not released after cancel: %+v", sum.Episodes)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestProtocolErrors(t *testing.T) {
	h := start(t, Config{})
	ctx := context.Background()
	if _, err := h.client.Lease(ctx, &workerv1.LeaseReq{WorkerId: "ghost", Max: 1}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("unregistered lease: %v", err)
	}
	if _, err := h.client.Register(ctx, &workerv1.RegisterReq{WorkerId: "w", Vertical: "robot", Slots: 1}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("bad vertical: %v", err)
	}
	if _, err := h.client.Report(ctx, &workerv1.EpisodeReport{EpisodeKey: "a", ResultJson: []byte(`{"key":"b","status":"done","outcome":"success"}`)}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("key mismatch: %v", err)
	}
	if _, err := h.client.Report(ctx, &workerv1.EpisodeReport{EpisodeKey: "a", ResultJson: []byte(`{"key":"a","status":"done","outcome":"success"}`)}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown episode: %v", err)
	}
}
