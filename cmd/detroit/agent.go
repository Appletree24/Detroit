package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	subjectv1 "github.com/Appletree24/Detroit/gen/detroit/subject/v1"
	workerv1 "github.com/Appletree24/Detroit/gen/detroit/worker/v1"
	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/Appletree24/Detroit/internal/workerkit"
	"github.com/Appletree24/Detroit/subjects/openaicompat"
	"github.com/Appletree24/Detroit/workers/agent"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func subjectOpenAI(args []string) error {
	fs := flag.NewFlagSet("subject openai-compatible", flag.ContinueOnError)
	addr := fs.String("listen", "127.0.0.1:7080", "Subject gRPC 监听地址")
	base := fs.String("base-url", "https://api.openai.com/v1", "Chat Completions API 基础地址（含 /v1，不含 /chat/completions）")
	model := fs.String("model", "", "API 模型名称")
	digest := fs.String("digest", "", "模型版本标识，与 RunSpec subject.digest 一致")
	keyEnv := fs.String("api-key-env", "OPENAI_API_KEY", "API Key 的环境变量名；空字符串表示不发送认证头")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	key := ""
	if *keyEnv != "" {
		key = os.Getenv(*keyEnv)
		if key == "" {
			return fmt.Errorf("API key environment variable %s is empty", *keyEnv)
		}
	}
	adapter, err := openaicompat.New(openaicompat.Config{BaseURL: *base, Model: *model, Digest: *digest, APIKey: key})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	gs := grpc.NewServer(grpc.MaxRecvMsgSize(agentio.MaxPayload+(1<<20)), grpc.MaxSendMsgSize(agentio.MaxPayload+(1<<20)))
	subjectv1.RegisterSubjectServer(gs, adapter)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- gs.Serve(listener) }()
	fmt.Fprintf(os.Stderr, "Subject openai-compatible listening at %s (model=%s digest=%s)\n", listener.Addr(), *model, *digest)
	select {
	case <-ctx.Done():
		gs.Stop()
		return nil
	case err := <-done:
		return err
	}
}

func workerAgent(args []string) error {
	fs := flag.NewFlagSet("worker agent", flag.ContinueOnError)
	controller := fs.String("controller", "127.0.0.1:7070", "控制面 gRPC 地址")
	id := fs.String("id", "", "Worker ID")
	slots := fs.Int("slots", 1, "并发模型调用槽位")
	artifacts := fs.String("artifacts", ".detroit/artifacts", "本地制品目录")
	timeout := fs.Duration("subject-timeout", 120*time.Second, "每次 Subject 请求的超时；Act 超时重试一次")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 0 || *slots <= 0 || *timeout <= 0 {
		return fmt.Errorf("slots and subject-timeout must be positive; no positional arguments accepted")
	}
	if *id == "" {
		host, _ := os.Hostname()
		*id = fmt.Sprintf("agent-%s-%d", host, os.Getpid())
	}
	conn, err := grpc.NewClient(*controller, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Fprintf(os.Stderr, "Agent Worker %s → %s (slots=%d)\n", *id, *controller, *slots)
	return workerkit.Run(ctx, workerv1.NewSchedulerClient(conn), workerkit.Config{WorkerID: *id, Vertical: "agent", Slots: *slots, Labels: map[string]string{"executor": "agent-next-message", "subject_adapter": "openai-compatible"}}, &agent.Executor{Artifacts: *artifacts, SubjectTimeout: *timeout})
}
