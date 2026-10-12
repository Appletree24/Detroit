// Package e2e 用真实进程验证 M1 验收标准：controller 和 Worker 被 kill -9 后重启，
// run 最终完成，每个 episode 恰好一条结果（不重复、不丢失）。
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Appletree24/Detroit/internal/store"
)

func build(t *testing.T, dir string) (controller, cli string) {
	t.Helper()
	controller, cli = filepath.Join(dir, "controller"), filepath.Join(dir, "detroit")
	for out, pkg := range map[string]string{controller: "../../cmd/controller", cli: "../../cmd/detroit"} {
		if b, err := exec.Command("go", "build", "-o", out, pkg).CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", pkg, err, b)
		}
	}
	return
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

type proc struct {
	cmd *exec.Cmd
	out *bytes.Buffer
}

func spawn(t *testing.T, name string, args ...string) *proc {
	t.Helper()
	p := &proc{cmd: exec.Command(name, args...), out: &bytes.Buffer{}}
	p.cmd.Stdout, p.cmd.Stderr = p.out, p.out
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.kill() })
	return p
}

func (p *proc) kill() {
	if p.cmd.ProcessState == nil {
		p.cmd.Process.Signal(syscall.SIGKILL)
		p.cmd.Wait()
	}
}

func cli(t *testing.T, bin, api string, args ...string) string {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), "DETROIT_API=http://"+api)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("detroit %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func summary(t *testing.T, bin, api, runID string) (*store.RunSummary, bool) {
	cmd := exec.Command(bin, "run", "status", runID, "--json")
	cmd.Env = append(os.Environ(), "DETROIT_API=http://"+api)
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	var s store.RunSummary
	if err := json.Unmarshal(out, &s); err != nil {
		t.Fatalf("decode status: %v\n%s", err, out)
	}
	return &s, true
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestKillNineResume(t *testing.T) {
	if testing.Short() {
		t.Skip("builds binaries and runs real processes")
	}
	dir := t.TempDir()
	controllerBin, cliBin := build(t, dir)
	db := filepath.Join(dir, "detroit.db")
	grpcAddr, httpAddr := freePort(t), freePort(t)
	startController := func() *proc {
		p := spawn(t, controllerBin, "-db", db, "-grpc", grpcAddr, "-http", httpAddr, "-lease-ttl", "600ms", "-max-attempts", "50")
		waitFor(t, 10*time.Second, "controller", func() bool {
			c, err := net.Dial("tcp", httpAddr)
			if err == nil {
				c.Close()
			}
			return err == nil
		})
		return p
	}
	startWorker := func(id string) *proc {
		return spawn(t, cliBin, "worker", "mock", "--controller", grpcAddr, "--id", id, "--slots", "4", "--delay", "200ms", "--crash-rate", "0.1")
	}

	spec := filepath.Join(dir, "spec.yaml")
	os.WriteFile(spec, []byte(`
name: e2e
subject: {adapter: mock, digest: mock@1, params: {success_rate: 0.6}}
taskset:
  vertical: agent
  source: synthetic
  suites: [smoke]
  variants: [base, tool_fault]
  repeats: 3
  options: {tasks_per_suite: 20}
`), 0o644)
	const total = 20 * 2 * 3

	ctrl := startController()
	out := cli(t, cliBin, httpAddr, "run", "submit", "-f", spec)
	runID := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(out, "submitted "))[0], ":")
	w1, w2 := startWorker("w1"), startWorker("w2")

	progress := func() int {
		s, ok := summary(t, cliBin, httpAddr, runID)
		if !ok {
			return -1
		}
		return s.Episodes["done"] + s.Episodes["infra_error"]
	}
	waitFor(t, 30*time.Second, "first third", func() bool { return progress() >= total/3 })

	// kill -9 控制面和一个 Worker，然后重启控制面；Worker 自动重新注册。
	if p := progress(); p >= total {
		t.Fatalf("run finished before the first kill (%d/%d); slow the mock down", p, total)
	}
	ctrl.kill()
	w1.kill()
	ctrl = startController()
	waitFor(t, 30*time.Second, "two thirds", func() bool { return progress() >= 2*total/3 })

	// 再 kill -9 一次控制面，并重新提交同一个 RunSpec：必须是续跑。
	if p := progress(); p >= total {
		t.Fatalf("run finished before the second kill (%d/%d)", p, total)
	}
	ctrl.kill()
	ctrl = startController()
	if out := cli(t, cliBin, httpAddr, "run", "submit", "-f", spec); !strings.HasPrefix(out, "resumed "+runID) {
		t.Fatalf("resubmit must resume, got %q", out)
	}
	_ = startWorker("w3")

	var final *store.RunSummary
	waitFor(t, 60*time.Second, "run done", func() bool {
		s, ok := summary(t, cliBin, httpAddr, runID)
		final = s
		return ok && s.Status == store.RunDone
	})
	if got := final.Episodes["done"] + final.Episodes["infra_error"]; got != total {
		t.Fatalf("terminal episodes: got %d want %d (%v)", got, total, final.Episodes)
	}
	if final.Overall.N+final.Overall.Unknowns+final.Overall.InfraErrors != total {
		t.Fatalf("aggregate: %+v", final.Overall)
	}

	ctrl.kill()
	w2.kill()
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	n, err := st.ResultCount(context.Background(), runID)
	if err != nil || n != total {
		t.Fatalf("results: got %d want %d (%v)", n, total, err)
	}
}
