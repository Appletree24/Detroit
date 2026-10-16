// Package scheduler 负责把 RunSpec 切分为 episode，并通过租约把 episode 分配给 Worker（docs/02 §3.2–3.3）。
package scheduler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/taskset"
)

// PlanResult 是展开结果。TaskSetHash 是加载到的任务内容（含初始状态）的 SHA-256，写入 manifest。
type PlanResult struct {
	Episodes    []core.Episode
	TaskSetHash string
}

// Plan 把 RunSpec 展开为 episode 列表：tasks × variants × init_states × seeds × repeats。
// 顺序确定，同一个 RunSpec 总是得到同样的列表和同样的 episode key。
func Plan(ctx context.Context, spec *core.RunSpec) (*PlanResult, error) {
	entries, err := taskset.LoadRun(ctx, spec)
	if err != nil {
		return nil, err
	}
	if spec.Subject.Adapter == "openai-compatible" {
		if err := agentio.ValidateRun(spec, entries); err != nil {
			return nil, err
		}
	}
	b, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	runID := spec.RunID()
	var eps []core.Episode
	for _, e := range entries {
		states, err := spec.TaskSet.InitStates.Pick(e.InitStates)
		if err != nil {
			return nil, fmt.Errorf("task %s: %w", e.Task.ID, err)
		}
		for _, variant := range spec.TaskSet.Variants {
			for _, st := range states {
				for _, seed := range spec.TaskSet.Seeds {
					for r := range spec.TaskSet.Repeats {
						ep := core.Episode{
							RunID:       runID,
							TaskID:      e.Task.ID,
							VariantID:   variant,
							InitStateID: st.ID,
							Seed:        seed,
							RepeatIdx:   r,
						}
						ep.Key = core.EpisodeKey(ep, spec.Subject.Digest, spec.TaskSet.EnvDigest)
						eps = append(eps, ep)
					}
				}
			}
		}
	}
	if len(eps) == 0 {
		return nil, fmt.Errorf("runspec %s expands to zero episodes", spec.Name)
	}
	return &PlanResult{Episodes: eps, TaskSetHash: hex.EncodeToString(sum[:])}, nil
}
