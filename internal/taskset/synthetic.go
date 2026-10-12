package taskset

import (
	"context"
	"fmt"

	"github.com/Appletree24/Detroit/internal/core"
)

// Synthetic 按参数生成占位任务，不读取任何外部数据。
//
//	taskset:
//	  source: synthetic
//	  suites: [smoke]                # 默认 [synthetic]
//	  options:
//	    tasks_per_suite: 10          # 默认 10
//	    init_states_per_task: 1      # 默认 1
type Synthetic struct{}

func (Synthetic) Name() string { return "synthetic" }

func (Synthetic) Load(_ context.Context, spec core.TaskSetSpec) ([]core.TaskEntry, error) {
	tasks, err := intOption(spec.Options, "tasks_per_suite", 10)
	if err != nil {
		return nil, err
	}
	states, err := intOption(spec.Options, "init_states_per_task", 1)
	if err != nil {
		return nil, err
	}
	suites := spec.Suites
	if len(suites) == 0 {
		suites = []string{"synthetic"}
	}
	var out []core.TaskEntry
	for _, suite := range suites {
		for i := range tasks {
			e := core.TaskEntry{Task: core.Task{
				ID:          fmt.Sprintf("%s/%04d", suite, i),
				Suite:       suite,
				Instruction: fmt.Sprintf("synthetic task %d of suite %s", i, suite),
				MaxSteps:    10,
			}}
			for j := range states {
				e.InitStates = append(e.InitStates, core.InitState{ID: fmt.Sprintf("%d", j)})
			}
			out = append(out, e)
		}
	}
	return out, nil
}

func intOption(opts map[string]any, key string, def int) (int, error) {
	v, ok := opts[key]
	if !ok {
		return def, nil
	}
	var n int
	switch x := v.(type) {
	case int:
		n = x
	case int64:
		n = int(x)
	case float64:
		n = int(x)
		if float64(n) != x {
			return 0, fmt.Errorf("options.%s: %v is not an integer", key, x)
		}
	default:
		return 0, fmt.Errorf("options.%s: want integer, got %T", key, v)
	}
	if n < 1 {
		return 0, fmt.Errorf("options.%s must be >= 1", key)
	}
	return n, nil
}
