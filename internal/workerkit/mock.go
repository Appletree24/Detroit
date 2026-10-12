package workerkit

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/taskset"
)

// Mock 是一个不依赖任何环境和模型的 Executor，用来验证调度、存储、续跑与统计。
// 结果由 episode key 决定（同一个 episode 重跑结果相同）；崩溃按 CrashRate 随机发生。
// RunSpec 的 subject.params.success_rate 会覆盖 SuccessRate，便于用两个"模型"演示对比。
type Mock struct {
	SuccessRate float64       // 有效结果中成功的比例
	UnknownRate float64       // 判为 unknown（评分依据不足）的比例
	CrashRate   float64       // 每次执行放弃 episode（模拟 Worker 崩溃）的概率
	Delay       time.Duration // 每个 episode 的执行时长

	once  sync.Once
	rngMu sync.Mutex
	rng   *rand.Rand
}

func (m *Mock) Execute(ctx context.Context, job Job) (core.EpisodeResult, error) {
	m.once.Do(func() { m.rng = rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64())) })
	task, err := findTask(ctx, job)
	if err != nil {
		return core.EpisodeResult{}, &InfraError{Kind: "task_not_found", Err: err}
	}
	select {
	case <-ctx.Done():
		return core.EpisodeResult{}, ctx.Err()
	case <-time.After(m.Delay):
	}
	m.rngMu.Lock()
	crash := m.rng.Float64() < m.CrashRate
	m.rngMu.Unlock()
	if crash {
		return core.EpisodeResult{}, ErrAbandon
	}

	rate := m.SuccessRate
	if v, ok := job.Spec.Subject.Params["success_rate"].(float64); ok {
		rate = v
	}
	u := unitHash(job.Episode.Key)
	res := core.EpisodeResult{Status: core.StatusDone, Steps: min(task.MaxSteps, 1+int(u*float64(task.MaxSteps)))}
	switch {
	case u < m.UnknownRate:
		res.Outcome = core.OutcomeUnknown
	case unitHash("outcome:"+job.Episode.Key) < rate:
		res.Outcome = core.OutcomeSuccess
		res.Score = core.OnlineScore{Success: true, Progress: 1}
	default:
		res.Outcome = core.OutcomeFailure
		res.Score = core.OnlineScore{Progress: u}
	}
	res.Cost = core.Cost{Inferences: int64(res.Steps)}
	return res, nil
}

// findTask 用与控制面相同的 Loader 取回任务内容。真实 Worker 会缓存加载结果。
func findTask(ctx context.Context, job Job) (core.Task, error) {
	entries, err := taskset.Load(ctx, job.Spec.TaskSet)
	if err != nil {
		return core.Task{}, err
	}
	for _, e := range entries {
		if e.Task.ID == job.Episode.TaskID {
			return e.Task, nil
		}
	}
	return core.Task{}, fmt.Errorf("task %q not in taskset %s", job.Episode.TaskID, job.Spec.TaskSet.Source)
}

// unitHash 把字符串确定性地映射到 [0, 1)。
func unitHash(s string) float64 {
	sum := sha256.Sum256([]byte(s))
	return float64(binary.BigEndian.Uint64(sum[:8])>>11) / (1 << 53)
}
