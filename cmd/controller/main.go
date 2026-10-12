// controller 是 Detroit 控制面：gRPC 上提供 Worker 协议，HTTP 上提供 API Server。
// 所有状态都在数据库中，进程可随时重启；重启后 Worker 自动重新注册，未完成的 episode 继续执行。
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/api"
	"github.com/Appletree24/Detroit/internal/scheduler"
	"github.com/Appletree24/Detroit/internal/store"
	"google.golang.org/grpc"
)

func main() {
	db := flag.String("db", "detroit.db", "SQLite 数据库路径")
	grpcAddr := flag.String("grpc", "127.0.0.1:7070", "Worker 协议监听地址")
	httpAddr := flag.String("http", "127.0.0.1:7071", "API 监听地址")
	leaseTTL := flag.Duration("lease-ttl", 30*time.Second, "租约时长")
	maxAttempts := flag.Int("max-attempts", 3, "每个 episode 最多被租出的次数")
	flag.Parse()

	if err := run(*db, *grpcAddr, *httpAddr, scheduler.Config{LeaseTTL: *leaseTTL, MaxAttempts: *maxAttempts}); err != nil {
		slog.Error("controller exited", "err", err)
		os.Exit(1)
	}
}

func run(dbPath, grpcAddr, httpAddr string, cfg scheduler.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(dbPath)
	if err != nil {
		return err
	}
	defer st.Close()

	svc := scheduler.NewService(st, cfg)
	gs := grpc.NewServer()
	workerv1.RegisterSchedulerServer(gs, svc)
	lis, err := net.Listen("tcp", grpcAddr)
	if err != nil {
		return err
	}
	hs := &http.Server{Addr: httpAddr, Handler: api.New(st, nil).Handler(), ReadHeaderTimeout: 10 * time.Second}

	errc := make(chan error, 2)
	go func() { errc <- gs.Serve(lis) }()
	go func() {
		if err := hs.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	go svc.Reap(ctx)
	slog.Info("controller started", "grpc", lis.Addr().String(), "http", httpAddr, "db", dbPath)

	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hs.Shutdown(shutdown)
	gs.GracefulStop()
	return err
}
