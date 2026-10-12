package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// EpisodeKey 是 episode 的幂等键：
// sha256(run_id, task_id, variant_id, init_state_id, seed, repeat_idx, subject_digest, env_digest)（docs/02 §3.2）。
// 字段按 JSON 数组编码后哈希，避免简单拼接带来的歧义。
func EpisodeKey(ep Episode, subjectDigest, envDigest string) string {
	b, err := json.Marshal([]any{ep.RunID, ep.TaskID, ep.VariantID, ep.InitStateID, ep.Seed, ep.RepeatIdx, subjectDigest, envDigest})
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// TaskEntry 是 TaskSet Loader 产出的一项：任务和它的全部固定初始状态。
type TaskEntry struct {
	Task       Task        `json:"task"`
	InitStates []InitState `json:"init_states"`
}

// TaskSetLoader 从 benchmark 或用户数据加载任务（docs/03 §3 扩展点）。
// 控制面用它展开 episode；Worker 用同一个 Loader 根据 task_id 取回任务内容。
type TaskSetLoader interface {
	Name() string
	Load(ctx context.Context, spec TaskSetSpec) ([]TaskEntry, error)
}

// Validate 检查 Worker 上报的结果是否自洽。
func (r *EpisodeResult) Validate() error {
	switch r.Status {
	case StatusDone:
		switch r.Outcome {
		case OutcomeSuccess, OutcomeFailure, OutcomeUnknown:
		default:
			return fmt.Errorf("result %s: status done requires outcome success|failure|unknown, got %q", r.Key, r.Outcome)
		}
		if r.ErrorKind != "" {
			return fmt.Errorf("result %s: error_kind is only allowed for infra_error", r.Key)
		}
	case StatusInfraError:
		if r.ErrorKind == "" {
			return fmt.Errorf("result %s: infra_error requires error_kind", r.Key)
		}
		if r.Outcome != "" {
			return fmt.Errorf("result %s: infra_error must not carry an outcome", r.Key)
		}
	default:
		return fmt.Errorf("result %s: unknown status %q", r.Key, r.Status)
	}
	if r.Score.Progress < 0 || r.Score.Progress > 1 {
		return errors.New("score.progress must be within [0, 1]")
	}
	return nil
}
