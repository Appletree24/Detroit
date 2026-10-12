// Package taskset 维护 TaskSet Loader 注册表。垂类的 Loader（libero、用户评测集…）在这里注册；
// 内置的 synthetic 来源不依赖任何外部数据，供 mock Worker 和测试使用。
package taskset

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/Appletree24/Detroit/internal/core"
)

var (
	mu      sync.RWMutex
	loaders = map[string]core.TaskSetLoader{}
)

// Register 注册一个 Loader；同名重复注册会 panic。
func Register(l core.TaskSetLoader) {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := loaders[l.Name()]; ok {
		panic("taskset: duplicate loader " + l.Name())
	}
	loaders[l.Name()] = l
}

// Get 按名称查找 Loader。
func Get(name string) (core.TaskSetLoader, error) {
	mu.RLock()
	defer mu.RUnlock()
	l, ok := loaders[name]
	if !ok {
		names := make([]string, 0, len(loaders))
		for n := range loaders {
			names = append(names, n)
		}
		sort.Strings(names)
		return nil, fmt.Errorf("taskset: unknown source %q (registered: %v)", name, names)
	}
	return l, nil
}

// Load 用 spec.Source 对应的 Loader 加载任务，并检查任务 ID 唯一、每个任务至少有一个初始状态。
func Load(ctx context.Context, spec core.TaskSetSpec) ([]core.TaskEntry, error) {
	l, err := Get(spec.Source)
	if err != nil {
		return nil, err
	}
	entries, err := l.Load(ctx, spec)
	if err != nil {
		return nil, fmt.Errorf("taskset %s: %w", spec.Source, err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Task.ID == "" {
			return nil, fmt.Errorf("taskset %s: task with empty id", spec.Source)
		}
		if seen[e.Task.ID] {
			return nil, fmt.Errorf("taskset %s: duplicate task id %q", spec.Source, e.Task.ID)
		}
		seen[e.Task.ID] = true
		if len(e.InitStates) == 0 {
			return nil, fmt.Errorf("taskset %s: task %q has no init states", spec.Source, e.Task.ID)
		}
	}
	return entries, nil
}

func init() { Register(Synthetic{}) }
