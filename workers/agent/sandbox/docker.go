package sandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Appletree24/Detroit/internal/workerkit"
)

// 容器标签：所有沙箱都带 labelSandbox，labelOwner 标识创建它的 Worker，用于清理残留容器。
const (
	labelSandbox = "detroit.sandbox"
	labelOwner   = "detroit.owner"
)

// 在 drop 掉全部 capability 后补回的最小集合：以 root 运行的镜像安装依赖、改文件属主、结束自己的进程时需要。
var defaultCaps = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID"}

// pid 1 由 --init（tini）担任，负责回收孤儿进程；它的子进程只是保持容器存活。
const keepalive = `trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done`

// execWrapper 记录命令的 pid 后 exec 成该命令，超时时据此终止整棵进程树。
// docker exec 的客户端被结束时，容器内的进程不会随之结束，所以必须这样做。
const execWrapper = `mkdir -p /tmp/.detroit && echo $$ > "/tmp/.detroit/$1.pid" && shift && exec "$@"`

// killTree 先暂停目标进程以免它继续派生，再递归结束它的所有后代。
// 已经脱离父进程的守护进程不在树内，它们在 Destroy 时随容器一起结束。
const killTree = `
kill_tree() (
  for s in /proc/[0-9]*/status; do
    p=${s#/proc/}; p=${p%/status}
    pp=$(sed -n 's/^PPid:[[:space:]]*//p' "$s" 2>/dev/null)
    [ "$pp" = "$1" ] && kill_tree "$p"
  done
  kill -KILL "$1" 2>/dev/null
)
pid=$(cat "/tmp/.detroit/$1.pid" 2>/dev/null) || exit 0
kill -STOP "$pid" 2>/dev/null
kill_tree "$pid"
rm -f "/tmp/.detroit/$1.pid"`

// Docker 通过 docker CLI 管理沙箱。Binary 可以换成 podman。
type Docker struct {
	Binary string // 默认 "docker"
	Owner  string // 写入 detroit.owner 标签，Cleanup 按它清理
}

func (d *Docker) Name() string { return "docker" }

func (d *Docker) bin() string {
	if d.Binary == "" {
		return "docker"
	}
	return d.Binary
}

// Start 创建并启动容器，写入种子数据，执行 setup，记录初始状态。任何一步失败都会销毁已创建的容器。
func (d *Docker) Start(ctx context.Context, spec Spec) (Sandbox, error) {
	spec.applyDefaults()
	if err := spec.validate(); err != nil {
		return nil, fmt.Errorf("sandbox spec: %w", err)
	}
	server, err := d.cli(ctx, nil, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return nil, infra(KindBoot, fmt.Errorf("docker unavailable: %w", err))
	}
	imageID, err := d.ensureImage(ctx, spec.Image)
	if err != nil {
		return nil, infra(KindBoot, err)
	}
	name := "detroit-" + randomHex(6)
	id, err := d.cli(ctx, nil, d.createArgs(spec, name)...)
	if err != nil {
		return nil, infra(KindBoot, fmt.Errorf("create container: %w", err))
	}
	s := &dockerSandbox{d: d, spec: spec, id: strings.TrimSpace(id), baseline: map[string]map[string]string{}}
	s.info = Info{
		Provider: d.Name(), ServerVersion: strings.TrimSpace(server), Runtime: spec.Runtime,
		Image: spec.Image, ImageID: imageID, ContainerID: s.id, Network: spec.Network, Resources: spec.Resources,
	}
	if err := s.init(ctx); err != nil {
		destroyCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = s.Destroy(destroyCtx)
		return nil, err
	}
	return s, nil
}

func (d *Docker) ensureImage(ctx context.Context, image string) (string, error) {
	if id, err := d.cli(ctx, nil, "image", "inspect", "--format", "{{.Id}}", image); err == nil {
		return strings.TrimSpace(id), nil
	}
	if _, err := d.cli(ctx, nil, "pull", "--quiet", image); err != nil {
		return "", fmt.Errorf("pull %s: %w", image, err)
	}
	id, err := d.cli(ctx, nil, "image", "inspect", "--format", "{{.Id}}", image)
	if err != nil {
		return "", fmt.Errorf("inspect %s: %w", image, err)
	}
	return strings.TrimSpace(id), nil
}

// createArgs 构造 docker create 的参数（L1：docs/05 §2.1）。
func (d *Docker) createArgs(spec Spec, name string) []string {
	r := spec.Resources
	args := []string{"create", "--name", name, "--init",
		"--label", labelSandbox + "=1",
		"--network", map[Network]string{NetworkNone: "none", NetworkHost: "bridge"}[spec.Network],
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", strconv.FormatInt(r.PIDs, 10),
		"--memory", strconv.FormatInt(r.MemoryMB, 10) + "m",
		"--memory-swap", strconv.FormatInt(r.MemoryMB, 10) + "m",
		"--cpus", strconv.FormatFloat(r.CPU, 'f', -1, 64),
		"--tmpfs", fmt.Sprintf("/tmp:rw,exec,size=%dm", r.DiskMB),
	}
	if d.Owner != "" {
		args = append(args, "--label", labelOwner+"="+d.Owner)
	}
	for _, c := range defaultCaps {
		args = append(args, "--cap-add", c)
	}
	if !spec.WritableRoot {
		args = append(args, "--read-only")
	}
	if spec.Runtime != "" {
		args = append(args, "--runtime", spec.Runtime)
	}
	// 匿名卷：Docker 会把镜像中该路径下已有的内容复制进去，Destroy 时随容器删除。
	for _, w := range spec.Workspaces {
		args = append(args, "--volume", w.Path)
	}
	for _, k := range slices.Sorted(maps.Keys(spec.Labels)) {
		args = append(args, "--label", k+"="+spec.Labels[k])
	}
	for _, k := range slices.Sorted(maps.Keys(spec.Env)) {
		args = append(args, "--env", k+"="+spec.Env[k])
	}
	return append(args, "--entrypoint", "sh", spec.Image, "-c", keepalive)
}

// Cleanup 删除该 Owner 留下的所有沙箱容器（例如 Worker 崩溃后重启时）。返回删除的数量。
func (d *Docker) Cleanup(ctx context.Context) (int, error) {
	if d.Owner == "" {
		return 0, errors.New("cleanup requires Owner")
	}
	out, err := d.cli(ctx, nil, "ps", "-aq", "--filter", "label="+labelSandbox, "--filter", "label="+labelOwner+"="+d.Owner)
	if err != nil {
		return 0, err
	}
	ids := strings.Fields(out)
	if len(ids) == 0 {
		return 0, nil
	}
	_, err = d.cli(ctx, nil, append([]string{"rm", "-f", "-v"}, ids...)...)
	return len(ids), err
}

// cli 执行一条 docker 命令，返回 stdout；失败时错误中带上 stderr。
func (d *Docker) cli(ctx context.Context, stdin []byte, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, d.bin(), args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s: %w: %s", d.bin(), args[0], err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

type dockerSandbox struct {
	d    *Docker
	spec Spec
	id   string
	info Info

	baseline map[string]map[string]string // 工作区 ID → 相对路径 → sha256

	mu        sync.Mutex
	deadline  time.Time
	exhausted bool // 墙钟时间已耗尽
	destroyed bool
}

func (s *dockerSandbox) Info() Info { return s.info }

func (s *dockerSandbox) init(ctx context.Context) error {
	if _, err := s.d.cli(ctx, nil, "start", s.id); err != nil {
		return infra(KindBoot, fmt.Errorf("start container: %w", err))
	}
	for _, w := range s.spec.Workspaces {
		if w.SeedDir == "" {
			continue
		}
		if _, err := os.Stat(w.SeedDir); err != nil {
			return infra(KindBoot, fmt.Errorf("workspace %s seed: %w", w.ID, err))
		}
		if _, err := s.d.cli(ctx, nil, "cp", filepath.Clean(w.SeedDir)+string(filepath.Separator)+".", s.id+":"+w.Path); err != nil {
			return infra(KindBoot, fmt.Errorf("workspace %s seed: %w", w.ID, err))
		}
	}
	setupCtx, cancel := context.WithTimeout(ctx, s.spec.SetupTimeout)
	defer cancel()
	for i, cmd := range s.spec.Setup {
		res, err := s.run(setupCtx, ExecRequest{Argv: Shell(cmd)}, time.Time{})
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return infra(KindSetup, fmt.Errorf("setup[%d]: %w", i, err))
		}
		if res.TimedOut || res.ExitCode != 0 {
			return infra(KindSetup, fmt.Errorf("setup[%d] %q exited %d (timed_out=%v): %s",
				i, cmd, res.ExitCode, res.TimedOut, tail(res.Stderr, 2000)))
		}
	}
	for _, w := range s.spec.Workspaces {
		m, err := s.manifest(ctx, w)
		if err != nil {
			return infra(KindBoot, fmt.Errorf("workspace %s baseline: %w", w.ID, err))
		}
		s.baseline[w.ID] = m
	}
	now := time.Now()
	s.mu.Lock()
	s.deadline = now.Add(s.spec.Resources.Timeout)
	s.mu.Unlock()
	s.info.StartedAt = now.UTC()
	return nil
}

func (s *dockerSandbox) Exec(ctx context.Context, req ExecRequest) (ExecResult, error) {
	s.mu.Lock()
	deadline, exhausted, destroyed := s.deadline, s.exhausted, s.destroyed
	s.mu.Unlock()
	if destroyed {
		return ExecResult{}, infra(KindError, errors.New("sandbox already destroyed"))
	}
	if exhausted || !time.Now().Before(deadline) {
		s.markExhausted()
		return ExecResult{ExitCode: 137, Exhausted: ResourceWallClock}, nil
	}
	res, err := s.run(ctx, req, deadline)
	if res.Exhausted != "" {
		s.markExhausted()
	}
	return res, err
}

func (s *dockerSandbox) markExhausted() {
	s.mu.Lock()
	s.exhausted = true
	s.mu.Unlock()
}

// run 执行命令。deadline 为零值时不受墙钟时间限制（setup 与导出用）。
func (s *dockerSandbox) run(ctx context.Context, req ExecRequest, deadline time.Time) (ExecResult, error) {
	if len(req.Argv) == 0 {
		return ExecResult{}, errors.New("exec: empty argv")
	}
	maxOut := req.MaxOutput
	if maxOut <= 0 {
		maxOut = 1 << 20
	}
	dir := req.Dir
	if dir == "" {
		dir = s.spec.Workspaces[0].Path
	}
	execID := randomHex(8)
	args := []string{"exec", "--workdir", dir}
	if req.Stdin != nil {
		args = append(args, "--interactive")
	}
	for _, k := range slices.Sorted(maps.Keys(req.Env)) {
		args = append(args, "--env", k+"="+req.Env[k])
	}
	args = append(args, s.id, "sh", "-c", execWrapper, "detroit-exec", execID)
	args = append(args, req.Argv...)

	// 不用 CommandContext：结束 docker 客户端并不会结束容器内的进程，要先在容器内终止进程树。
	cmd := exec.Command(s.d.bin(), args...)
	stdout, stderr := &capped{max: maxOut}, &capped{max: maxOut}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if req.Stdin != nil {
		cmd.Stdin = bytes.NewReader(req.Stdin)
	}
	start := time.Now()
	if err := cmd.Start(); err != nil {
		return ExecResult{}, infra(KindError, fmt.Errorf("exec: %w", err))
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var timer <-chan time.Time
	reason := ""
	limit := time.Duration(0)
	if req.Timeout > 0 {
		limit, reason = req.Timeout, "timeout"
	}
	if !deadline.IsZero() {
		if left := time.Until(deadline); limit == 0 || left <= limit {
			limit, reason = max0(left), ResourceWallClock
		}
	}
	if limit > 0 || reason != "" {
		t := time.NewTimer(limit)
		defer t.Stop()
		timer = t.C
	}

	var waitErr error
	stopped := ""
	select {
	case waitErr = <-done:
	case <-timer:
		stopped = reason
	case <-ctx.Done():
		stopped = "cancelled"
	}
	if stopped != "" {
		killCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		_, _ = s.d.cli(killCtx, nil, "exec", s.id, "sh", "-c", killTree, "detroit-kill", execID)
		cancel()
		select {
		case waitErr = <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			waitErr = <-done
		}
	}

	res := ExecResult{
		Stdout: stdout.buf.Bytes(), Stderr: stderr.buf.Bytes(),
		StdoutTruncated: stdout.truncated, StderrTruncated: stderr.truncated,
		Duration: time.Since(start),
	}
	switch stopped {
	case "cancelled":
		return res, ctx.Err()
	case "timeout":
		res.TimedOut, res.ExitCode = true, 137
		return res, nil
	case ResourceWallClock:
		res.Exhausted, res.ExitCode = ResourceWallClock, 137
		return res, nil
	}
	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
		return res, nil
	case errors.As(waitErr, &exitErr):
		res.ExitCode = exitErr.ExitCode()
		// docker exec 自身失败（容器已不存在、守护进程不可用）时退出码为 125–127 且 stderr 来自 docker。
		if res.ExitCode >= 125 && isDaemonError(res.Stderr) {
			return res, infra(KindError, fmt.Errorf("exec: %s", tail(res.Stderr, 500)))
		}
		return res, nil
	default:
		return res, infra(KindError, fmt.Errorf("exec: %w", waitErr))
	}
}

func isDaemonError(stderr []byte) bool {
	s := string(stderr)
	return strings.Contains(s, "Error response from daemon") || strings.Contains(s, "No such container") ||
		strings.Contains(s, "Cannot connect to the Docker daemon") || strings.Contains(s, "is not running")
}

// internal 执行平台自己的命令（读计数器、算哈希），不受墙钟时间限制。
// Agent 可能已经占满进程数上限，此时平台自己的命令也无法派生进程：先临时放宽上限再重试，结束后恢复。
// 放宽期间 Agent 也能多派生进程，但超限已经记录在 pids.events 里，不影响判定。
func (s *dockerSandbox) internal(ctx context.Context, script string, args ...string) (string, error) {
	out, err := s.internalOnce(ctx, script, args...)
	if err == nil || ctx.Err() != nil {
		return out, err
	}
	limit := s.spec.Resources.PIDs
	if _, uerr := s.d.cli(ctx, nil, "update", "--pids-limit", strconv.FormatInt(limit+internalPIDs, 10), s.id); uerr != nil {
		return "", err
	}
	defer func() {
		restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		_, _ = s.d.cli(restoreCtx, nil, "update", "--pids-limit", strconv.FormatInt(limit, 10), s.id)
	}()
	return s.internalOnce(ctx, script, args...)
}

// internalPIDs 是平台内部命令需要的进程数余量。
const internalPIDs = 64

func (s *dockerSandbox) internalOnce(ctx context.Context, script string, args ...string) (string, error) {
	res, err := s.run(ctx, ExecRequest{Argv: append([]string{"sh", "-c", script, "detroit"}, args...), Dir: "/", MaxOutput: 64 << 20}, time.Time{})
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("exit %d: %s", res.ExitCode, tail(res.Stderr, 500))
	}
	if res.StdoutTruncated {
		return "", errors.New("output too large")
	}
	return string(res.Stdout), nil
}

const usageScript = `
for f in memory.events pids.events memory.peak; do
  echo "== $f"; cat "/sys/fs/cgroup/$f" 2>/dev/null
done
for p in "$@"; do echo "== du"; du -sk "$p" 2>/dev/null | cut -f1; done`

func (s *dockerSandbox) Usage(ctx context.Context) (Usage, error) {
	paths := make([]string, len(s.spec.Workspaces))
	for i, w := range s.spec.Workspaces {
		paths[i] = w.Path
	}
	out, err := s.internal(ctx, usageScript, paths...)
	if err != nil {
		return Usage{}, infra(KindError, fmt.Errorf("usage: %w", err))
	}
	u := Usage{DiskBytes: map[string]int64{}}
	s.mu.Lock()
	if !s.deadline.IsZero() {
		u.Elapsed = time.Since(s.deadline.Add(-s.spec.Resources.Timeout))
	}
	wallClock := s.exhausted
	s.mu.Unlock()

	section, du := "", 0
	seenMemEvents, seenPIDEvents := false, false
	for _, line := range strings.Split(out, "\n") {
		if name, ok := strings.CutPrefix(line, "== "); ok {
			section = name
			if section == "du" {
				du++
			}
			continue
		}
		fields := strings.Fields(line)
		switch {
		case section == "memory.events" && len(fields) == 2:
			seenMemEvents = true
			if fields[0] == "oom_kill" {
				u.OOMKills, _ = strconv.ParseInt(fields[1], 10, 64)
			}
		case section == "pids.events" && len(fields) == 2:
			seenPIDEvents = true
			if fields[0] == "max" {
				u.PIDsLimitHits, _ = strconv.ParseInt(fields[1], 10, 64)
			}
		case section == "memory.peak" && len(fields) == 1:
			u.MemoryPeakBytes, _ = strconv.ParseInt(fields[0], 10, 64)
		case section == "du" && len(fields) == 1 && du <= len(s.spec.Workspaces):
			kb, _ := strconv.ParseInt(fields[0], 10, 64)
			u.DiskBytes[s.spec.Workspaces[du-1].ID] = kb * 1024
		}
	}
	u.CgroupKnown = seenMemEvents && seenPIDEvents

	if wallClock {
		u.Exhausted = append(u.Exhausted, ResourceWallClock)
	}
	if u.OOMKills > 0 {
		u.Exhausted = append(u.Exhausted, ResourceMemory)
	}
	if u.PIDsLimitHits > 0 {
		u.Exhausted = append(u.Exhausted, ResourcePIDs)
	}
	var disk int64
	for _, b := range u.DiskBytes {
		disk += b
	}
	if disk > s.spec.Resources.DiskMB<<20 {
		u.Exhausted = append(u.Exhausted, ResourceDisk)
	}
	return u, nil
}

// manifestScript 输出工作区内每个普通文件的 sha256 与相对路径。
const manifestScript = `cd "$1" && find . -type f -exec sha256sum {} +`

func (s *dockerSandbox) manifest(ctx context.Context, w Workspace) (map[string]string, error) {
	out, err := s.internal(ctx, manifestScript, w.Path)
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		hash, file, ok := strings.Cut(line, "  ")
		if !ok {
			continue
		}
		m[strings.TrimPrefix(file, "./")] = hash
	}
	return m, nil
}

func diff(before, after map[string]string) Diff {
	d := Diff{Added: []string{}, Modified: []string{}, Deleted: []string{}}
	for f, h := range after {
		switch old, ok := before[f]; {
		case !ok:
			d.Added = append(d.Added, f)
		case old != h:
			d.Modified = append(d.Modified, f)
		}
	}
	for f := range before {
		if _, ok := after[f]; !ok {
			d.Deleted = append(d.Deleted, f)
		}
	}
	slices.Sort(d.Added)
	slices.Sort(d.Modified)
	slices.Sort(d.Deleted)
	return d
}

func (s *dockerSandbox) Export(ctx context.Context, dir string) (*Export, error) {
	if err := os.MkdirAll(filepath.Join(dir, "workspaces"), 0o755); err != nil {
		return nil, err
	}
	usage, err := s.Usage(ctx)
	if err != nil {
		return nil, err
	}
	exp := &Export{Info: s.info, Usage: usage, Workspaces: map[string]WorkspaceExport{}}
	for _, w := range s.spec.Workspaces {
		after, err := s.manifest(ctx, w)
		if err != nil {
			return nil, infra(KindError, fmt.Errorf("workspace %s manifest: %w", w.ID, err))
		}
		rel := filepath.Join("workspaces", w.ID+".tar")
		if err := s.copyOut(ctx, w.Path, filepath.Join(dir, rel)); err != nil {
			return nil, infra(KindError, fmt.Errorf("workspace %s: %w", w.ID, err))
		}
		exp.Workspaces[w.ID] = WorkspaceExport{Tar: rel, Diff: diff(s.baseline[w.ID], after)}
	}
	if len(s.spec.ExportCommands) > 0 {
		if err := os.MkdirAll(filepath.Join(dir, "exports"), 0o755); err != nil {
			return nil, err
		}
		exp.Commands = map[string]CommandExport{}
		for _, name := range slices.Sorted(maps.Keys(s.spec.ExportCommands)) {
			res, err := s.run(ctx, ExecRequest{Argv: Shell(s.spec.ExportCommands[name]), MaxOutput: 256 << 20}, time.Time{})
			if err != nil {
				return nil, err
			}
			rel := filepath.Join("exports", name)
			if err := os.WriteFile(filepath.Join(dir, rel), res.Stdout, 0o644); err != nil {
				return nil, err
			}
			exp.Commands[name] = CommandExport{File: rel, ExitCode: res.ExitCode, Stderr: tail(res.Stderr, 4000)}
		}
	}
	b, err := json.MarshalIndent(exp, "", "  ")
	if err != nil {
		return nil, err
	}
	return exp, os.WriteFile(filepath.Join(dir, "sandbox.json"), b, 0o644)
}

func (s *dockerSandbox) copyOut(ctx context.Context, src, dst string) error {
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, s.d.bin(), "cp", s.id+":"+src, "-")
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = f, &stderr
	runErr := cmd.Run()
	closeErr := f.Close()
	if runErr != nil {
		return fmt.Errorf("docker cp: %w: %s", runErr, strings.TrimSpace(stderr.String()))
	}
	return closeErr
}

func (s *dockerSandbox) Destroy(ctx context.Context) error {
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		return nil
	}
	s.destroyed = true
	s.mu.Unlock()
	if _, err := s.d.cli(ctx, nil, "rm", "-f", "-v", s.id); err != nil && !strings.Contains(err.Error(), "No such container") {
		return fmt.Errorf("destroy %s: %w", s.id, err)
	}
	return nil
}

// capped 只保留前 max 个字节，其余丢弃但继续读取，避免阻塞被执行的命令。
type capped struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *capped) Write(p []byte) (int, error) {
	room := c.max - c.buf.Len()
	if len(p) > room {
		c.truncated = true
	}
	if room > 0 {
		c.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func infra(kind string, err error) error { return &workerkit.InfraError{Kind: kind, Err: err} }

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func tail(b []byte, n int) string {
	if len(b) > n {
		b = b[len(b)-n:]
	}
	return strings.TrimSpace(string(b))
}

func max0(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}
