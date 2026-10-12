package sandbox

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Appletree24/Detroit/internal/workerkit"
)

// 集成测试使用本地已有的镜像，不会拉取。镜像需要 sh、find、sha256sum、du、sed（busybox 即可）。
// 用 DETROIT_TEST_IMAGE 指定，默认 redis:7-alpine。
func testImage(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("needs docker")
	}
	img := os.Getenv("DETROIT_TEST_IMAGE")
	if img == "" {
		img = "redis:7-alpine"
	}
	out, err := exec.Command("docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", img).Output()
	if err != nil {
		t.Skipf("docker or image %s unavailable: %v", img, err)
	}
	return strings.TrimSpace(string(out)) // 按 digest 固定
}

func start(t *testing.T, d *Docker, spec Spec) Sandbox {
	t.Helper()
	sb, err := d.Start(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sb.Destroy(context.Background()) })
	return sb
}

func sh(t *testing.T, sb Sandbox, cmd string) ExecResult {
	t.Helper()
	res, err := sb.Exec(context.Background(), ExecRequest{Argv: Shell(cmd)})
	if err != nil {
		t.Fatalf("%q: %v", cmd, err)
	}
	return res
}

func containerExists(t *testing.T, id string) bool {
	t.Helper()
	return exec.Command("docker", "container", "inspect", id).Run() == nil
}

func TestDockerLifecycle(t *testing.T) {
	img := testImage(t)
	seed := t.TempDir()
	os.WriteFile(filepath.Join(seed, "keep.txt"), []byte("keep\n"), 0o644)
	os.WriteFile(filepath.Join(seed, "edit.txt"), []byte("v1\n"), 0o644)
	os.WriteFile(filepath.Join(seed, "drop.txt"), []byte("x\n"), 0o644)

	d := &Docker{Owner: "test-lifecycle"}
	sb := start(t, d, Spec{
		Image:          img,
		Workspaces:     []Workspace{{ID: "repo", Path: "/repo", SeedDir: seed}},
		Setup:          []string{"echo from-setup > setup.txt"},
		Env:            map[string]string{"GREETING": "hello"},
		ExportCommands: map[string]string{"listing.txt": "ls /repo", "fails.txt": "echo oops >&2; exit 3"},
		Labels:         map[string]string{"detroit.episode": "ep-1"},
	})
	info := sb.Info()
	if info.ImageID == "" || info.ServerVersion == "" || info.StartedAt.IsZero() {
		t.Fatalf("info: %+v", info)
	}

	if res := sh(t, sb, "cat keep.txt setup.txt; echo $GREETING; pwd"); res.ExitCode != 0 ||
		string(res.Stdout) != "keep\nfrom-setup\nhello\n/repo\n" {
		t.Fatalf("seed/setup/env/workdir: %+v %q", res, res.Stdout)
	}
	if res := sh(t, sb, "touch /etc/evil"); res.ExitCode == 0 {
		t.Fatal("root filesystem must be read-only")
	}
	if res := sh(t, sb, "wget -q -T 2 -O /dev/null http://1.1.1.1 || nc -z -w 2 1.1.1.1 80"); res.ExitCode == 0 {
		t.Fatal("network must be disabled")
	}
	res, err := sb.Exec(context.Background(), ExecRequest{Argv: []string{"cat"}, Stdin: []byte("piped")})
	if err != nil || string(res.Stdout) != "piped" {
		t.Fatalf("stdin: %v %q", err, res.Stdout)
	}
	if res := sh(t, sb, "exit 7"); res.ExitCode != 7 {
		t.Fatalf("exit code: %d", res.ExitCode)
	}
	res, _ = sb.Exec(context.Background(), ExecRequest{Argv: Shell("head -c 5000 /dev/zero"), MaxOutput: 100})
	if len(res.Stdout) != 100 || !res.StdoutTruncated {
		t.Fatalf("truncation: %d %v", len(res.Stdout), res.StdoutTruncated)
	}

	sh(t, sb, "echo v2 > edit.txt; rm drop.txt; mkdir -p new && echo n > new/file.txt")
	dir := t.TempDir()
	exp, err := sb.Export(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	ws := exp.Workspaces["repo"]
	if !slices.Equal(ws.Diff.Added, []string{"new/file.txt"}) || !slices.Equal(ws.Diff.Modified, []string{"edit.txt"}) ||
		!slices.Equal(ws.Diff.Deleted, []string{"drop.txt"}) {
		t.Fatalf("diff (setup.txt is part of the initial state): %+v", ws.Diff)
	}
	if got := tarFile(t, filepath.Join(dir, ws.Tar), "repo/edit.txt"); got != "v2\n" {
		t.Fatalf("tar content: %q", got)
	}
	if c := exp.Commands["listing.txt"]; c.ExitCode != 0 {
		t.Fatalf("export command: %+v", c)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "exports", "listing.txt")); !strings.Contains(string(b), "edit.txt") {
		t.Fatalf("export output: %q", b)
	}
	if c := exp.Commands["fails.txt"]; c.ExitCode != 3 || c.Stderr != "oops" {
		t.Fatalf("failing export command: %+v", c)
	}
	if _, err := os.Stat(filepath.Join(dir, "sandbox.json")); err != nil {
		t.Fatal(err)
	}
	if !exp.Usage.CgroupKnown || len(exp.Usage.Exhausted) != 0 || exp.Usage.DiskBytes["repo"] == 0 {
		t.Fatalf("usage: %+v", exp.Usage)
	}

	if err := sb.Destroy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if containerExists(t, info.ContainerID) {
		t.Fatal("container must be removed")
	}
	if err := sb.Destroy(context.Background()); err != nil {
		t.Fatalf("destroy must be idempotent: %v", err)
	}
	if _, err := sb.Exec(context.Background(), ExecRequest{Argv: Shell("true")}); err == nil {
		t.Fatal("exec after destroy must fail")
	}
}

func tarFile(t *testing.T, path, name string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if err != nil {
			t.Fatalf("%s not in tar: %v", name, err)
		}
		if h.Name == name {
			b, _ := io.ReadAll(tr)
			return string(b)
		}
	}
}

func countProcs(t *testing.T, sb Sandbox, pattern string) int {
	t.Helper()
	res := sh(t, sb, "ps -o args | grep -c '^"+pattern+"' || true")
	n, err := strconv.Atoi(strings.TrimSpace(string(res.Stdout)))
	if err != nil {
		t.Fatalf("count %q: %v", res.Stdout, err)
	}
	return n
}

func TestDockerCommandTimeoutKillsTree(t *testing.T) {
	sb := start(t, &Docker{}, Spec{Image: testImage(t)})
	res, err := sb.Exec(context.Background(), ExecRequest{Argv: Shell("sleep 1000 & sleep 1001 & wait"), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut || res.ExitCode != 137 || res.Exhausted != "" || res.Duration > 10*time.Second {
		t.Fatalf("timeout: %+v", res)
	}
	if n := countProcs(t, sb, "sleep 100"); n != 0 {
		t.Fatalf("%d child processes survived the timeout", n)
	}
	if res := sh(t, sb, "echo still-usable"); res.ExitCode != 0 {
		t.Fatal("sandbox must stay usable after a command timeout")
	}
}

func TestDockerCancelKillsCommand(t *testing.T) {
	sb := start(t, &Docker{}, Spec{Image: testImage(t)})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := sb.Exec(ctx, ExecRequest{Argv: Shell("sleep 1002")}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want ctx error, got %v", err)
	}
	if n := countProcs(t, sb, "sleep 1002"); n != 0 {
		t.Fatal("cancelled command must be killed")
	}
}

func TestDockerWallClock(t *testing.T) {
	sb := start(t, &Docker{}, Spec{Image: testImage(t), Resources: Resources{Timeout: 2 * time.Second}})
	res := sh(t, sb, "sleep 30")
	if res.Exhausted != ResourceWallClock || res.Duration > 15*time.Second {
		t.Fatalf("wall clock: %+v", res)
	}
	if res := sh(t, sb, "echo too-late"); res.Exhausted != ResourceWallClock || len(res.Stdout) != 0 {
		t.Fatalf("exec after exhaustion must not run: %+v", res)
	}
	exp, err := sb.Export(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("export must work after exhaustion: %v", err)
	}
	if !slices.Contains(exp.Usage.Exhausted, ResourceWallClock) {
		t.Fatalf("usage: %+v", exp.Usage)
	}
}

func TestDockerResourceLimits(t *testing.T) {
	img := testImage(t)
	t.Run("memory", func(t *testing.T) {
		sb := start(t, &Docker{}, Spec{Image: img, Resources: Resources{MemoryMB: 64}})
		res := sh(t, sb, `x=$(head -c 300000000 /dev/zero | tr "\0" a); echo ${#x}`)
		u, err := sb.Usage(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if res.ExitCode == 0 || u.OOMKills == 0 || !slices.Contains(u.Exhausted, ResourceMemory) || u.MemoryPeakBytes == 0 {
			t.Fatalf("exit %d usage %+v", res.ExitCode, u)
		}
	})
	t.Run("pids", func(t *testing.T) {
		sb := start(t, &Docker{}, Spec{Image: img, Resources: Resources{PIDs: 32}})
		// 进程一直占着上限：平台仍要能读出计数并导出终态。
		sh(t, sb, "for i in $(seq 64); do sleep 60 & done 2>/dev/null; true")
		exp, err := sb.Export(context.Background(), t.TempDir())
		if err != nil {
			t.Fatalf("export with saturated pids: %v", err)
		}
		if u := exp.Usage; u.PIDsLimitHits == 0 || !slices.Contains(u.Exhausted, ResourcePIDs) {
			t.Fatalf("usage %+v", u)
		}
		out, _ := exec.Command("docker", "inspect", "--format", "{{.HostConfig.PidsLimit}}", sb.Info().ContainerID).Output()
		if strings.TrimSpace(string(out)) != "32" {
			t.Fatalf("pids limit must be restored, got %s", out)
		}
	})
	t.Run("disk", func(t *testing.T) {
		sb := start(t, &Docker{}, Spec{Image: img, Resources: Resources{DiskMB: 4}})
		sh(t, sb, "head -c 6000000 /dev/zero > big.bin")
		u, err := sb.Usage(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(u.Exhausted, ResourceDisk) {
			t.Fatalf("usage %+v", u)
		}
	})
}

func TestDockerBootFailures(t *testing.T) {
	img := testImage(t)
	d := &Docker{Owner: "test-boot-" + randomHex(4)}
	ctx := context.Background()

	_, err := d.Start(ctx, Spec{Image: img, Setup: []string{"echo broken >&2; exit 4"}})
	var ie *workerkit.InfraError
	if !errors.As(err, &ie) || ie.Kind != KindSetup || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("setup failure: %v", err)
	}
	if _, err := d.Start(ctx, Spec{Image: "detroit-missing-image@sha256:" + strings.Repeat("0", 64)}); !errors.As(err, &ie) || ie.Kind != KindBoot {
		t.Fatalf("missing image: %v", err)
	}
	if _, err := d.Start(ctx, Spec{Image: img, Workspaces: []Workspace{{ID: "w", Path: "/w", SeedDir: "/nonexistent"}}}); !errors.As(err, &ie) || ie.Kind != KindBoot {
		t.Fatalf("missing seed: %v", err)
	}
	if _, err := d.Start(ctx, Spec{Image: "redis:7-alpine"}); err == nil || errors.As(err, &ie) {
		t.Fatalf("unpinned image must be a spec error, got %v", err)
	}
	// 失败的启动不能留下容器。
	if n, err := d.Cleanup(ctx); err != nil || n != 0 {
		t.Fatalf("failed starts left %d containers (%v)", n, err)
	}
}

func TestDockerCleanup(t *testing.T) {
	img := testImage(t)
	d := &Docker{Owner: "test-cleanup-" + randomHex(4)}
	a, err := d.Start(context.Background(), Spec{Image: img})
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.Start(context.Background(), Spec{Image: img})
	if err != nil {
		t.Fatal(err)
	}
	other := start(t, &Docker{Owner: "someone-else"}, Spec{Image: img})
	if n, err := d.Cleanup(context.Background()); err != nil || n != 2 {
		t.Fatalf("cleanup: %d %v", n, err)
	}
	if containerExists(t, a.Info().ContainerID) || containerExists(t, b.Info().ContainerID) {
		t.Fatal("owned containers must be removed")
	}
	if !containerExists(t, other.Info().ContainerID) {
		t.Fatal("other owners' containers must be kept")
	}
}
