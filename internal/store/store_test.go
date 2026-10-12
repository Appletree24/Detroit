package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
)

var t0 = time.UnixMilli(1_760_000_000_000)

func testSpec(t *testing.T) *core.RunSpec {
	t.Helper()
	spec, err := core.ParseRunSpec([]byte("name: s\nsubject: {adapter: mock, digest: m1}\ntaskset: {vertical: agent, source: synthetic}\n"))
	if err != nil {
		t.Fatal(err)
	}
	return spec
}

func episodes(spec *core.RunSpec, n int) []core.Episode {
	var eps []core.Episode
	for i := range n {
		ep := core.Episode{RunID: spec.RunID(), TaskID: "t", VariantID: "base", InitStateID: "0", RepeatIdx: i}
		ep.Key = core.EpisodeKey(ep, spec.Subject.Digest, "")
		eps = append(eps, ep)
	}
	return eps
}

func open(t *testing.T, path string) *Store {
	t.Helper()
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func done(key string, o core.Outcome) core.EpisodeResult {
	return core.EpisodeResult{Key: key, Status: core.StatusDone, Outcome: o}
}

func TestLeaseReportIdempotent(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "d.db"))
	spec := testSpec(t)
	eps := episodes(spec, 3)
	if _, err := st.Submit(ctx, spec, nil, map[string]string{}, eps, t0); err != nil {
		t.Fatal(err)
	}

	if ls, _ := st.Lease(ctx, "w", "embodied", 10, t0, time.Minute); len(ls) != 0 {
		t.Fatalf("other vertical must not lease agent episodes, got %d", len(ls))
	}
	ls, err := st.Lease(ctx, "w", "agent", 2, t0, time.Minute)
	if err != nil || len(ls) != 2 {
		t.Fatalf("lease: %v %d", err, len(ls))
	}
	out, err := st.Report(ctx, done(ls[0].Episode.Key, core.OutcomeSuccess), "", t0)
	if err != nil || !out.Accepted {
		t.Fatalf("first report: %+v %v", out, err)
	}
	out, err = st.Report(ctx, done(ls[0].Episode.Key, core.OutcomeFailure), "", t0)
	if err != nil || !out.Duplicate {
		t.Fatalf("second report must be duplicate: %+v %v", out, err)
	}
	if _, err := st.Report(ctx, done("nope", core.OutcomeSuccess), "", t0); err == nil {
		t.Fatal("unknown key must fail")
	}
	sum, _ := st.Summary(ctx, spec.RunID())
	if sum.Overall.Successes != 1 || sum.Overall.N != 1 || sum.Status != RunRunning {
		t.Fatalf("summary: %+v", sum)
	}
}

func TestExpireRequeuesThenExhausts(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "d.db"))
	spec := testSpec(t)
	eps := episodes(spec, 1)
	if _, err := st.Submit(ctx, spec, nil, nil, eps, t0); err != nil {
		t.Fatal(err)
	}
	now := t0
	for attempt := 1; attempt <= 3; attempt++ {
		ls, err := st.Lease(ctx, "w", "agent", 1, now, time.Second)
		if err != nil || len(ls) != 1 {
			t.Fatalf("attempt %d: lease %v %d", attempt, err, len(ls))
		}
		// 心跳续期后，原到期时间不会触发回收。
		if _, _, err := st.Heartbeat(ctx, "w", []string{ls[0].Episode.Key}, now.Add(900*time.Millisecond), time.Second); err != nil {
			t.Fatal(err)
		}
		if r, e, _ := st.ExpireLeases(ctx, now.Add(1500*time.Millisecond), 3); r+e != 0 {
			t.Fatalf("attempt %d: extended lease must not expire", attempt)
		}
		now = now.Add(3 * time.Second)
		r, e, err := st.ExpireLeases(ctx, now, 3)
		if err != nil {
			t.Fatal(err)
		}
		if attempt < 3 && (r != 1 || e != 0) {
			t.Fatalf("attempt %d: want requeue, got r=%d e=%d", attempt, r, e)
		}
		if attempt == 3 && (r != 0 || e != 1) {
			t.Fatalf("attempt 3: want exhausted, got r=%d e=%d", r, e)
		}
	}
	sum, _ := st.Summary(ctx, spec.RunID())
	if sum.Status != RunDone || sum.Overall.InfraErrors != 1 || sum.Overall.N != 0 || sum.ErrorKinds[core.ErrorKindLeaseExhausted] != 1 {
		t.Fatalf("summary: %+v", sum)
	}
	// 租约耗尽后到达的"僵尸完成"只会是 duplicate。
	out, _ := st.Report(ctx, done(eps[0].Key, core.OutcomeSuccess), "", now)
	if !out.Duplicate {
		t.Fatalf("zombie after exhaustion: %+v", out)
	}
}

func TestZombieCompletionFirstWins(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "d.db"))
	spec := testSpec(t)
	eps := episodes(spec, 1)
	st.Submit(ctx, spec, nil, nil, eps, t0)
	st.Lease(ctx, "w1", "agent", 1, t0, time.Second)
	st.ExpireLeases(ctx, t0.Add(2*time.Second), 3)
	ls, _ := st.Lease(ctx, "w2", "agent", 1, t0.Add(2*time.Second), time.Second)
	if len(ls) != 1 {
		t.Fatal("requeued episode must be leasable")
	}
	// w1 的心跳不能为已转给 w2 的租约续期：到期时间仍是 w2 的。
	st.Heartbeat(ctx, "w1", []string{eps[0].Key}, t0.Add(2500*time.Millisecond), time.Hour)
	if r, _, _ := st.ExpireLeases(ctx, t0.Add(3500*time.Millisecond), 3); r != 1 {
		t.Fatal("w1 heartbeat must not extend w2's lease")
	}
	// w1 的租约早已过期，但它先完成：接受。
	if out, _ := st.Report(ctx, done(eps[0].Key, core.OutcomeFailure), "", t0.Add(4*time.Second)); !out.Accepted {
		t.Fatal("zombie completion arriving first must be accepted")
	}
	// w2 后到的结果只是 duplicate。
	if out, _ := st.Report(ctx, done(eps[0].Key, core.OutcomeSuccess), "", t0.Add(5*time.Second)); !out.Duplicate {
		t.Fatal("later report must be duplicate")
	}
	sum, _ := st.Summary(ctx, spec.RunID())
	if sum.Overall.Successes != 0 || sum.Overall.N != 1 {
		t.Fatalf("first result must win: %+v", sum.Overall)
	}
}

func TestCancelAndResubmitAfterReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "d.db")
	spec := testSpec(t)
	eps := episodes(spec, 4)

	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if res, _ := st.Submit(ctx, spec, nil, nil, eps, t0); res.Existing || res.Added != 4 {
		t.Fatalf("first submit: %+v", res)
	}
	ls, _ := st.Lease(ctx, "w", "agent", 2, t0, time.Minute)
	st.Report(ctx, done(ls[0].Episode.Key, core.OutcomeSuccess), "", t0)
	if status, err := st.Cancel(ctx, spec.RunID()); err != nil || status != RunCancelled {
		t.Fatalf("cancel: %s %v", status, err)
	}
	cancelled, _, _ := st.Heartbeat(ctx, "w", []string{ls[1].Episode.Key}, t0, time.Minute)
	if len(cancelled) != 1 {
		t.Fatalf("heartbeat must report cancellation, got %v", cancelled)
	}
	if more, _ := st.Lease(ctx, "w", "agent", 10, t0, time.Minute); len(more) != 0 {
		t.Fatal("cancelled run must not be leased")
	}
	if _, err := st.Cancel(ctx, "missing"); err == nil {
		t.Fatal("cancel of unknown run must fail")
	}
	st.Close()

	// 重新打开（模拟控制面重启）并重新提交同一个 RunSpec：续跑，不重复写入。
	st = open(t, path)
	res, err := st.Submit(ctx, spec, nil, nil, eps, t0.Add(time.Hour))
	if err != nil || !res.Existing || res.Added != 0 {
		t.Fatalf("resubmit: %+v %v", res, err)
	}
	sum, _ := st.Summary(ctx, spec.RunID())
	if sum.Status != RunRunning || sum.Overall.Successes != 1 {
		t.Fatalf("after resubmit: %+v", sum)
	}
	// 被取消时持有的租约过期后回到待调度。
	st.ExpireLeases(ctx, t0.Add(2*time.Hour), 3)
	rest, _ := st.Lease(ctx, "w", "agent", 10, t0.Add(2*time.Hour), time.Minute)
	if len(rest) != 3 {
		t.Fatalf("want 3 remaining episodes, got %d", len(rest))
	}
	for _, l := range rest {
		st.Report(ctx, done(l.Episode.Key, core.OutcomeFailure), "", t0.Add(2*time.Hour))
	}
	sum, _ = st.Summary(ctx, spec.RunID())
	if sum.Status != RunDone || sum.Overall.N != 4 {
		t.Fatalf("final: %+v", sum)
	}
	if status, _ := st.Cancel(ctx, spec.RunID()); status != RunDone {
		t.Fatalf("cancelling a finished run must leave it done, got %s", status)
	}
}

func TestSummaryExcludesUnknownAndInfraErrors(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "d.db"))
	spec := testSpec(t)
	eps := episodes(spec, 4)
	st.Submit(ctx, spec, nil, nil, eps, t0)
	st.Lease(ctx, "w", "agent", 4, t0, time.Minute)
	st.Report(ctx, done(eps[0].Key, core.OutcomeSuccess), "", t0)
	st.Report(ctx, done(eps[1].Key, core.OutcomeFailure), "", t0)
	st.Report(ctx, done(eps[2].Key, core.OutcomeUnknown), "", t0)
	st.Report(ctx, core.EpisodeResult{Key: eps[3].Key, Status: core.StatusInfraError, ErrorKind: "sandbox_boot"}, "", t0)
	sum, err := st.Summary(ctx, spec.RunID())
	if err != nil {
		t.Fatal(err)
	}
	o := sum.Overall
	if o.N != 2 || o.Successes != 1 || o.Unknowns != 1 || o.InfraErrors != 1 || o.Rate != 0.5 {
		t.Fatalf("overall: %+v", o)
	}
	if o.CI95[0] <= 0 || o.CI95[1] >= 1 {
		t.Fatalf("ci: %v", o.CI95)
	}
	if len(sum.ByVariant) != 1 || sum.ByVariant[0].N != 2 {
		t.Fatalf("by variant: %+v", sum.ByVariant)
	}
}
