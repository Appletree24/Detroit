// Package workerkit 是 Go Worker 的运行时：注册、拉取 episode、心跳续租、幂等上报（docs/04 §1）。
// 垂类 Worker 只需实现 Executor。Python Worker 按同一协议另行实现。
package workerkit

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/core"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Job 是交给 Executor 的一个 episode。
type Job struct {
	Episode core.Episode
	Spec    core.RunSpec
}

// Executor 执行一个 episode：重置环境、与 Subject 交互、在线评分、录制制品。
// ctx 在 run 被取消或 Worker 退出时结束。
type Executor interface {
	Execute(ctx context.Context, job Job) (core.EpisodeResult, error)
}

// InfraError 表示基础设施故障（沙箱启动失败、仿真器崩溃、Subject 超时…），上报为 infra_error。
// Executor 返回的其他错误按 ErrorKind "worker_error" 上报。
type InfraError struct {
	Kind string
	Err  error
}

func (e *InfraError) Error() string { return e.Kind + ": " + e.Err.Error() }
func (e *InfraError) Unwrap() error { return e.Err }

// ErrAbandon 让运行时放弃该 episode：不上报、不再续租，模拟 Worker 中途崩溃。只用于测试与故障演练。
var ErrAbandon = errors.New("workerkit: abandon episode")

type Config struct {
	WorkerID     string
	Vertical     string
	Slots        int
	Labels       map[string]string
	PollInterval time.Duration // 没有可领取的 episode 时的等待间隔
}

type runtime struct {
	client workerv1.SchedulerClient
	cfg    Config
	exec   Executor

	mu        sync.Mutex
	active    map[string]context.CancelFunc
	cancelled map[string]bool
	ttl       time.Duration
	wg        sync.WaitGroup
	freed     chan struct{} // 有 episode 结束、槽位空出时收到信号
}

// Run 持续领取并执行 episode，直到 ctx 结束。退出时取消正在执行的 episode，它们的租约到期后由控制面重新调度。
func Run(ctx context.Context, client workerv1.SchedulerClient, cfg Config, exec Executor) error {
	if cfg.Slots <= 0 {
		cfg.Slots = 1
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = 500 * time.Millisecond
	}
	r := &runtime{client: client, cfg: cfg, exec: exec, active: map[string]context.CancelFunc{}, cancelled: map[string]bool{}, freed: make(chan struct{}, 1)}
	if err := r.register(ctx); err != nil {
		return err
	}
	jobsCtx, cancelJobs := context.WithCancel(ctx)
	defer func() {
		cancelJobs()
		r.wg.Wait()
	}()
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		r.heartbeatLoop(ctx)
	}()
	defer func() { <-hbDone }()

	for {
		if ctx.Err() != nil {
			return nil
		}
		free := r.cfg.Slots - r.activeCount()
		got := 0
		if free > 0 {
			resp, err := r.client.Lease(ctx, &workerv1.LeaseReq{WorkerId: cfg.WorkerID, Max: int32(free)})
			switch {
			case err == nil:
				for _, l := range resp.GetLeases() {
					r.start(jobsCtx, l)
				}
				got = len(resp.GetLeases())
			case status.Code(err) == codes.FailedPrecondition:
				if err := r.register(ctx); err != nil {
					return err
				}
				continue
			case ctx.Err() == nil:
				slog.Warn("lease failed", "err", err)
			}
		}
		switch {
		case free <= 0:
			// 槽位已满：等到有 episode 结束再拉取。
			select {
			case <-ctx.Done():
				return nil
			case <-r.freed:
			}
		case got == 0:
			// 暂无可领取的 episode：等待一个拉取间隔，期间有槽位空出也不必提前醒。
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(cfg.PollInterval):
			}
		}
	}
}

func (r *runtime) register(ctx context.Context) error {
	backoff := 100 * time.Millisecond
	for {
		resp, err := r.client.Register(ctx, &workerv1.RegisterReq{
			WorkerId: r.cfg.WorkerID, Vertical: r.cfg.Vertical, Slots: int32(r.cfg.Slots), Labels: r.cfg.Labels,
		})
		if err == nil {
			r.mu.Lock()
			r.ttl = time.Duration(resp.GetLeaseTtlMs()) * time.Millisecond
			r.mu.Unlock()
			return nil
		}
		if c := status.Code(err); c == codes.InvalidArgument {
			return err
		}
		slog.Warn("register failed, retrying", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

func (r *runtime) start(ctx context.Context, l *workerv1.EpisodeLease) {
	var job Job
	if err := json.Unmarshal(l.GetEpisodeJson(), &job.Episode); err != nil {
		slog.Error("bad episode payload", "key", l.GetEpisodeKey(), "err", err)
		return
	}
	if err := json.Unmarshal(l.GetRunSpecJson(), &job.Spec); err != nil {
		slog.Error("bad runspec payload", "key", l.GetEpisodeKey(), "err", err)
		return
	}
	jobCtx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	r.active[job.Episode.Key] = cancel
	r.mu.Unlock()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer cancel()
		r.runJob(ctx, jobCtx, job)
	}()
}

func (r *runtime) runJob(workerCtx, jobCtx context.Context, job Job) {
	key := job.Episode.Key
	started := time.Now()
	res, err := r.exec.Execute(jobCtx, job)
	r.mu.Lock()
	delete(r.active, key)
	wasCancelled := r.cancelled[key]
	delete(r.cancelled, key)
	r.mu.Unlock()
	select {
	case r.freed <- struct{}{}:
	default:
	}

	if errors.Is(err, ErrAbandon) || wasCancelled || workerCtx.Err() != nil {
		return
	}
	if err != nil {
		kind := "worker_error"
		var ie *InfraError
		if errors.As(err, &ie) {
			kind = ie.Kind
		}
		slog.Warn("episode infra error", "key", key, "kind", kind, "err", err)
		res = core.EpisodeResult{Status: core.StatusInfraError, ErrorKind: kind}
	}
	res.Key = key
	if res.DurationMs == 0 {
		res.DurationMs = time.Since(started).Milliseconds()
	}
	r.report(workerCtx, res)
}

// report 重试直到控制面确认；Report 是幂等的，重复上报只会得到 duplicate。
func (r *runtime) report(ctx context.Context, res core.EpisodeResult) {
	body, err := json.Marshal(res)
	if err != nil {
		slog.Error("encode result", "key", res.Key, "err", err)
		return
	}
	backoff := 100 * time.Millisecond
	for {
		ack, err := r.client.Report(ctx, &workerv1.EpisodeReport{EpisodeKey: res.Key, ResultJson: body, ArtifactUri: res.Artifacts})
		if err == nil {
			if ack.GetDuplicate() {
				slog.Info("result already recorded", "key", res.Key)
			}
			return
		}
		switch status.Code(err) {
		case codes.InvalidArgument, codes.NotFound:
			slog.Error("result rejected", "key", res.Key, "err", err)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

func (r *runtime) heartbeatLoop(ctx context.Context) {
	for {
		r.mu.Lock()
		interval := r.ttl / 3
		r.mu.Unlock()
		if interval <= 0 {
			interval = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		keys := r.activeKeys()
		if len(keys) == 0 {
			continue
		}
		resp, err := r.client.Heartbeat(ctx, &workerv1.HeartbeatReq{WorkerId: r.cfg.WorkerID, EpisodeKeys: keys})
		if status.Code(err) == codes.FailedPrecondition {
			if err := r.register(ctx); err != nil {
				return
			}
			continue
		}
		if err != nil {
			if ctx.Err() == nil {
				slog.Warn("heartbeat failed", "err", err)
			}
			continue
		}
		r.mu.Lock()
		for _, k := range resp.GetCancelled() {
			if cancel, ok := r.active[k]; ok {
				r.cancelled[k] = true
				cancel()
			}
		}
		r.mu.Unlock()
	}
}

func (r *runtime) activeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

func (r *runtime) activeKeys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]string, 0, len(r.active))
	for k := range r.active {
		keys = append(keys, k)
	}
	return keys
}
