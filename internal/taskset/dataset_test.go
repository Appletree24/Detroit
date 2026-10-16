package taskset_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/dataset"
	"github.com/Appletree24/Detroit/internal/scheduler"
	"github.com/Appletree24/Detroit/internal/taskset"
	"github.com/Appletree24/Detroit/internal/workerkit"
)

func TestDatasetLoaderPlanAndMockExecution(t *testing.T) {
	ctx := context.Background()
	r, err := dataset.Import(ctx, "../../examples/datasets/v2/casepick-inline", dataset.Options{Store: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	spec := &core.RunSpec{Name: "dataset-smoke", Subject: core.SubjectRef{Adapter: "mock", Digest: "mock@1"}, TaskSet: core.TaskSetSpec{Vertical: "agent", Source: "detroit-v2", Variants: []string{"base"}, InitStates: core.InitStateSelector{All: true}, Seeds: []int64{0, 1}, Repeats: 2, Options: map[string]any{"path": r.Path, "snapshot": r.Snapshot}}, Scorers: core.ScorerSpec{Select: "lenient"}, Stats: core.StatsSpec{Confidence: 0.95}}
	entries, err := taskset.LoadRun(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || len(entries[0].Evaluation.Scorings) != 1 {
		t.Fatalf("%+v", entries)
	}
	var score map[string]any
	if err = json.Unmarshal(entries[0].Evaluation.Scorings[0], &score); err != nil {
		t.Fatal(err)
	}
	if score["label"] != "lenient" {
		t.Fatal("wrong scoring")
	}
	p, err := scheduler.Plan(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Episodes) != 4 {
		t.Fatalf("episodes: %d", len(p.Episodes))
	}
	again, err := scheduler.Plan(ctx, spec)
	if err != nil || p.TaskSetHash != again.TaskSetHash || p.Episodes[0].Key != again.Episodes[0].Key {
		t.Fatalf("unstable plan: %v", err)
	}
	mock := &workerkit.Mock{SuccessRate: 1}
	res, err := mock.Execute(ctx, workerkit.Job{Episode: p.Episodes[0], Spec: *spec})
	if err != nil || res.Outcome != core.OutcomeSuccess {
		t.Fatalf("%+v %v", res, err)
	}
	spec.TaskSet.Suites = []string{"absent"}
	if _, err = scheduler.Plan(ctx, spec); err == nil {
		t.Fatal("accepted empty suite selection")
	}
	spec.TaskSet.Suites = nil
	spec.Scorers.Select = "absent"
	if _, err = scheduler.Plan(ctx, spec); err == nil {
		t.Fatal("accepted absent scoring")
	}
	spec.Scorers.Select = "all"
	spec.TaskSet.Options["snapshot"] = "sha256:incorrect"
	if _, err = scheduler.Plan(ctx, spec); err == nil {
		t.Fatal("accepted incorrect pinned snapshot")
	}
}
