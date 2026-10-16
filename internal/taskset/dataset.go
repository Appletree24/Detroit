package taskset

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/dataset"
)

// Dataset loads an imported, content-addressed local snapshot. All processes
// participating in a run must be able to read the same snapshot path.
type Dataset struct{}

func (Dataset) Name() string { return "detroit-v2" }
func (Dataset) Load(ctx context.Context, spec core.TaskSetSpec) ([]core.TaskEntry, error) {
	return loadDataset(ctx, spec, "all")
}
func loadDataset(ctx context.Context, spec core.TaskSetSpec, selectScoring string) ([]core.TaskEntry, error) {
	if spec.Vertical != "agent" {
		return nil, fmt.Errorf("detroit-v2 currently supports vertical agent only")
	}
	for k := range spec.Options {
		if k != "path" && k != "snapshot" {
			return nil, fmt.Errorf("unknown detroit-v2 option %q", k)
		}
	}
	path, ok := spec.Options["path"].(string)
	if !ok || path == "" {
		return nil, fmt.Errorf("detroit-v2 requires options.path")
	}
	sum, ok := spec.Options["snapshot"].(string)
	if !ok || sum == "" {
		return nil, fmt.Errorf("detroit-v2 requires options.snapshot")
	}
	loaded, err := dataset.LoadSuites(ctx, path, sum, selectScoring, spec.Suites)
	if err != nil {
		return nil, err
	}
	var entries []core.TaskEntry
	for _, c := range loaded {
		entries = append(entries, core.TaskEntry{Task: core.Task{ID: c.ID, Suite: c.Suite, Instruction: instruction(c.Input), MaxSteps: c.MaxSteps, Meta: c.Meta, Input: c.Input}, InitStates: []core.InitState{{ID: c.TaskDigest}}, Evaluation: &core.EvaluationInput{DatasetDigest: c.DatasetDigest, TaskDigest: c.TaskDigest, Weight: c.Weight, GroupKey: c.GroupKey, Purpose: c.Purpose, Scorings: c.Scorings}})
	}
	return entries, nil
}

// LoadRun applies the run's scoring selection as well as its taskset selection.
func LoadRun(ctx context.Context, spec *core.RunSpec) ([]core.TaskEntry, error) {
	if spec.TaskSet.Source != "detroit-v2" {
		return Load(ctx, spec.TaskSet)
	}
	entries, err := loadDataset(ctx, spec.TaskSet, spec.Scorers.Select)
	if err != nil {
		return nil, err
	}
	return validateEntries(spec.TaskSet, entries)
}

func instruction(input json.RawMessage) string {
	var task struct {
		Instruction string `json:"instruction"`
	}
	_ = json.Unmarshal(input, &task)
	return task.Instruction
}
func init() { Register(Dataset{}) }
