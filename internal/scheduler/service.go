package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/store"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Config 是调度参数。
type Config struct {
	LeaseTTL     time.Duration    // 租约时长；Worker 每 TTL/3 心跳一次
	MaxAttempts  int              // 每个 episode 最多被租出的次数，用尽后记为 infra_error
	ReapInterval time.Duration    // 回收过期租约的间隔
	Now          func() time.Time // 测试时可替换
}

func (c *Config) defaults() {
	if c.LeaseTTL == 0 {
		c.LeaseTTL = 30 * time.Second
	}
	if c.MaxAttempts == 0 {
		c.MaxAttempts = 3
	}
	if c.ReapInterval == 0 {
		c.ReapInterval = c.LeaseTTL / 3
	}
	if c.Now == nil {
		c.Now = time.Now
	}
}

type worker struct {
	vertical string
	slots    int
}

// Service 实现 Worker 协议的控制面一侧（docs/04 §1）。拉模式：Worker 主动 Lease，控制面不感知 Worker 负载。
// 已注册的 Worker 只保存在内存里；控制面重启后 Worker 收到 FailedPrecondition 会重新注册，
// episode 状态全部在数据库中，重启不影响正在执行的 episode。
type Service struct {
	workerv1.UnimplementedSchedulerServer
	store *store.Store
	cfg   Config

	mu      sync.Mutex
	workers map[string]worker
}

func NewService(st *store.Store, cfg Config) *Service {
	cfg.defaults()
	return &Service{store: st, cfg: cfg, workers: map[string]worker{}}
}

func (s *Service) Register(_ context.Context, req *workerv1.RegisterReq) (*workerv1.RegisterResp, error) {
	if req.GetWorkerId() == "" {
		return nil, status.Error(codes.InvalidArgument, "worker_id is required")
	}
	switch req.GetVertical() {
	case "agent", "embodied":
	default:
		return nil, status.Errorf(codes.InvalidArgument, "vertical %q must be agent or embodied", req.GetVertical())
	}
	if req.GetSlots() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "slots must be positive")
	}
	s.mu.Lock()
	s.workers[req.GetWorkerId()] = worker{vertical: req.GetVertical(), slots: int(req.GetSlots())}
	s.mu.Unlock()
	slog.Info("worker registered", "worker", req.GetWorkerId(), "vertical", req.GetVertical(), "slots", req.GetSlots(), "labels", req.GetLabels())
	return &workerv1.RegisterResp{LeaseTtlMs: s.cfg.LeaseTTL.Milliseconds()}, nil
}

func (s *Service) Lease(ctx context.Context, req *workerv1.LeaseReq) (*workerv1.LeaseResp, error) {
	w, err := s.worker(req.GetWorkerId())
	if err != nil {
		return nil, err
	}
	max := min(int(req.GetMax()), w.slots)
	leases, err := s.store.Lease(ctx, req.GetWorkerId(), w.vertical, max, s.cfg.Now(), s.cfg.LeaseTTL)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "lease: %v", err)
	}
	resp := &workerv1.LeaseResp{}
	for _, l := range leases {
		ep, err := json.Marshal(l.Episode)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "encode episode: %v", err)
		}
		resp.Leases = append(resp.Leases, &workerv1.EpisodeLease{
			EpisodeKey:   l.Episode.Key,
			EpisodeJson:  ep,
			RunSpecJson:  l.RunSpecJSON,
			ExpireUnixMs: l.ExpireAt.UnixMilli(),
		})
	}
	return resp, nil
}

func (s *Service) Heartbeat(ctx context.Context, req *workerv1.HeartbeatReq) (*workerv1.HeartbeatResp, error) {
	if _, err := s.worker(req.GetWorkerId()); err != nil {
		return nil, err
	}
	cancelled, extendTo, err := s.store.Heartbeat(ctx, req.GetWorkerId(), req.GetEpisodeKeys(), s.cfg.Now(), s.cfg.LeaseTTL)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "heartbeat: %v", err)
	}
	return &workerv1.HeartbeatResp{Cancelled: cancelled, ExtendToUnixMs: extendTo.UnixMilli()}, nil
}

// Report 不要求 Worker 已注册：租约过期后的"僵尸完成"和控制面重启前的结果都应被接受。
func (s *Service) Report(ctx context.Context, req *workerv1.EpisodeReport) (*workerv1.ReportAck, error) {
	var res core.EpisodeResult
	if err := json.Unmarshal(req.GetResultJson(), &res); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "decode result: %v", err)
	}
	if res.Key != req.GetEpisodeKey() {
		return nil, status.Errorf(codes.InvalidArgument, "result key %q does not match episode_key %q", res.Key, req.GetEpisodeKey())
	}
	if err := res.Validate(); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	out, err := s.store.Report(ctx, res, req.GetArtifactUri(), s.cfg.Now())
	if errors.Is(err, store.ErrNotFound) {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	if err != nil {
		return nil, status.Errorf(codes.Internal, "report: %v", err)
	}
	return &workerv1.ReportAck{Accepted: out.Accepted, Duplicate: out.Duplicate}, nil
}

// Reap 周期性回收过期租约，直到 ctx 结束。
func (s *Service) Reap(ctx context.Context) {
	t := time.NewTicker(s.cfg.ReapInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			requeued, exhausted, err := s.store.ExpireLeases(ctx, s.cfg.Now(), s.cfg.MaxAttempts)
			if err != nil {
				if ctx.Err() == nil {
					slog.Error("expire leases", "err", err)
				}
				continue
			}
			if requeued+exhausted > 0 {
				slog.Info("leases expired", "requeued", requeued, "infra_error", exhausted)
			}
		}
	}
}

func (s *Service) worker(id string) (worker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.workers[id]
	if !ok {
		return worker{}, status.Errorf(codes.FailedPrecondition, "worker %q is not registered", id)
	}
	return w, nil
}
