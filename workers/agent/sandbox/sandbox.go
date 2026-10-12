// Package sandbox 是 Agent 垂类的沙箱（docs/05 §2）：从快照启动、执行命令、导出终态、销毁。
//
// Spec 的字段对应评测集协议中的 task.environment（docs/10 §6.3）。Provider 是可替换的后端，
// 目前实现了 Docker（L1，配置 Runtime: "runsc" 即 gVisor，L2）。
//
// 错误分两类：
//   - 基础设施故障返回 *workerkit.InfraError（Kind 为 sandbox_boot / sandbox_setup / sandbox_error），
//     由 Worker 上报为 infra_error，不计入成功率分母；
//   - 资源超限不是错误，记录在 ExecResult.Exhausted 和 Usage.Exhausted 中，由评分判为 Agent 失败
//     （resource_exhausted）：资源失控是 Agent 行为的一部分。
package sandbox

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
)

// 基础设施故障的 ErrorKind。
const (
	KindBoot  = "sandbox_boot"  // 拉取镜像、创建或启动容器、写入种子数据失败
	KindSetup = "sandbox_setup" // setup 命令失败：环境无法进入初始状态
	KindError = "sandbox_error" // 运行中沙箱后端本身出错（容器消失、守护进程不可用）
)

// 资源超限的种类。
const (
	ResourceWallClock = "wall_clock"
	ResourceMemory    = "memory"
	ResourcePIDs      = "pids"
	ResourceDisk      = "disk"
)

// Network 对应 task.environment.network。
type Network string

const (
	NetworkNone Network = "none" // 默认：无网络
	NetworkHost Network = "host" // 可访问外网（Docker 默认 bridge 网络，不是 --network host）
	// "allowlist" 需要出口代理，尚未实现。
)

// Spec 描述一个沙箱快照（= InitState）及其资源限制。
type Spec struct {
	// Image 必须按 digest 固定（name@sha256:…），否则同一个快照在不同时间可能指向不同内容。
	Image         string
	AllowUnpinned bool // 仅用于开发调试

	Workspaces []Workspace // 可写目录；默认一个 /workspace
	Setup      []string    // 进入初始状态前在第一个工作区内执行的 shell 命令，不计入墙钟时间
	Network    Network
	Resources  Resources
	Env        map[string]string

	// ExportCommands 在导出终态时执行，stdout 保存为同名制品，如 {"db.sql": "pg_dump app"}。
	ExportCommands map[string]string

	Runtime      string            // 容器运行时；"" 为默认（runc），"runsc" 为 gVisor
	WritableRoot bool              // 默认只读根文件系统
	Labels       map[string]string // 附加到容器上，便于排查（如 episode key）
	SetupTimeout time.Duration     // 默认 10 分钟
}

// Workspace 是一个可写目录。镜像中该路径下已有的内容会被带入；SeedDir（宿主机目录）的内容随后复制进去。
type Workspace struct {
	ID      string
	Path    string
	SeedDir string
}

// Resources 对应 task.environment.resources。零值表示用默认值。
type Resources struct {
	CPU      float64       // 核数，默认 1
	MemoryMB int64         // 默认 2048，禁用 swap
	DiskMB   int64         // 工作区总大小上限，默认 4096；/tmp 是同样大小上限的 tmpfs
	PIDs     int64         // 默认 512
	Timeout  time.Duration // episode 墙钟时间，默认 30 分钟；从 setup 完成开始计
}

func (s *Spec) applyDefaults() {
	if len(s.Workspaces) == 0 {
		s.Workspaces = []Workspace{{ID: "workspace", Path: "/workspace"}}
	}
	if s.Network == "" {
		s.Network = NetworkNone
	}
	r := &s.Resources
	if r.CPU == 0 {
		r.CPU = 1
	}
	if r.MemoryMB == 0 {
		r.MemoryMB = 2048
	}
	if r.DiskMB == 0 {
		r.DiskMB = 4096
	}
	if r.PIDs == 0 {
		r.PIDs = 512
	}
	if r.Timeout == 0 {
		r.Timeout = 30 * time.Minute
	}
	if s.SetupTimeout == 0 {
		s.SetupTimeout = 10 * time.Minute
	}
}

// Validate 检查 Spec。调用前应先补默认值。
func (s *Spec) validate() error {
	var errs []error
	if s.Image == "" {
		errs = append(errs, errors.New("image is required"))
	} else if !s.AllowUnpinned && !strings.Contains(s.Image, "@sha256:") {
		errs = append(errs, fmt.Errorf("image %q must be pinned by digest (name@sha256:…)", s.Image))
	}
	switch s.Network {
	case NetworkNone, NetworkHost:
	default:
		errs = append(errs, fmt.Errorf("network %q is not supported (none | host)", s.Network))
	}
	ids, paths := map[string]bool{}, map[string]bool{}
	for _, w := range s.Workspaces {
		clean := path.Clean(w.Path)
		switch {
		case w.ID == "" || strings.ContainsAny(w.ID, "/\\") || w.ID == "." || w.ID == "..":
			errs = append(errs, fmt.Errorf("workspace id %q is invalid", w.ID))
		case ids[w.ID]:
			errs = append(errs, fmt.Errorf("duplicate workspace id %q", w.ID))
		}
		switch {
		case !path.IsAbs(w.Path) || clean == "/" || clean != w.Path:
			errs = append(errs, fmt.Errorf("workspace path %q must be a clean absolute path other than /", w.Path))
		case clean == "/tmp" || strings.HasPrefix(clean, "/tmp/"):
			errs = append(errs, fmt.Errorf("workspace path %q must not be under /tmp", w.Path))
		case paths[clean]:
			errs = append(errs, fmt.Errorf("duplicate workspace path %q", w.Path))
		}
		ids[w.ID], paths[clean] = true, true
	}
	r := s.Resources
	if r.CPU < 0 || r.MemoryMB < 0 || r.DiskMB < 0 || r.PIDs < 0 || r.Timeout < 0 {
		errs = append(errs, errors.New("resources must not be negative"))
	}
	for name := range s.ExportCommands {
		if name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
			errs = append(errs, fmt.Errorf("export name %q is invalid", name))
		}
	}
	return errors.Join(errs...)
}

// Provider 创建沙箱。
type Provider interface {
	Name() string
	Start(ctx context.Context, spec Spec) (Sandbox, error)
}

// Sandbox 是一个已进入初始状态的沙箱。
type Sandbox interface {
	Info() Info
	// Exec 在沙箱内执行命令。命令超时、墙钟时间耗尽都不是错误，反映在结果字段里；
	// ctx 被取消时返回 ctx.Err()，命令会被终止。
	Exec(ctx context.Context, req ExecRequest) (ExecResult, error)
	// Usage 读取当前资源使用情况与超限记录。
	Usage(ctx context.Context) (Usage, error)
	// Export 把终态写入宿主机目录 dir：各工作区的 tar 包与相对初始状态的文件差异、ExportCommands 的输出、
	// 资源使用情况。不受墙钟时间限制，超限后仍可导出。
	Export(ctx context.Context, dir string) (*Export, error)
	// Destroy 销毁沙箱及其工作区，可重复调用。
	Destroy(ctx context.Context) error
}

// Info 写入 manifest，说明这次执行用的是什么沙箱。
type Info struct {
	Provider      string    `json:"provider"`
	ServerVersion string    `json:"server_version"`
	Runtime       string    `json:"runtime"`
	Image         string    `json:"image"`
	ImageID       string    `json:"image_id"`
	ContainerID   string    `json:"container_id"`
	Network       Network   `json:"network"`
	Resources     Resources `json:"resources"`
	StartedAt     time.Time `json:"started_at"` // setup 完成、开始计墙钟时间的时刻
}

// ExecRequest 是一次命令执行。
type ExecRequest struct {
	Argv      []string          // 命令及参数；用 Shell() 构造 shell 命令
	Dir       string            // 默认第一个工作区
	Env       map[string]string // 追加的环境变量
	Stdin     []byte
	Timeout   time.Duration // 单条命令超时；0 表示只受墙钟时间限制
	MaxOutput int           // stdout、stderr 各自保留的最大字节数，默认 1 MiB
}

// Shell 构造一条通过 sh -c 执行的命令。
func Shell(cmd string) []string { return []string{"sh", "-c", cmd} }

// ExecResult 是命令执行结果。被终止的命令 ExitCode 为 137。
type ExecResult struct {
	ExitCode        int           `json:"exit_code"`
	Stdout          []byte        `json:"stdout"`
	Stderr          []byte        `json:"stderr"`
	StdoutTruncated bool          `json:"stdout_truncated,omitempty"`
	StderrTruncated bool          `json:"stderr_truncated,omitempty"`
	Duration        time.Duration `json:"duration"`
	TimedOut        bool          `json:"timed_out,omitempty"` // 单条命令超时
	Exhausted       string        `json:"exhausted,omitempty"` // 非空表示墙钟时间耗尽（ResourceWallClock）
}

// Usage 是资源使用情况。计数器读自容器内的 cgroup v2；读不到（cgroup v1、部分 gVisor 配置）时
// CgroupKnown 为 false，内存与进程数是否超限未知，不按未超限处理。
type Usage struct {
	Elapsed         time.Duration    `json:"elapsed"`
	CgroupKnown     bool             `json:"cgroup_known"`
	OOMKills        int64            `json:"oom_kills"`
	PIDsLimitHits   int64            `json:"pids_limit_hits"`
	MemoryPeakBytes int64            `json:"memory_peak_bytes,omitempty"` // 0 表示内核不提供
	DiskBytes       map[string]int64 `json:"disk_bytes"`                  // 按工作区 ID
	Exhausted       []string         `json:"exhausted,omitempty"`         // 已超限的资源
}

// Export 描述导出的终态。路径都相对于导出目录。
type Export struct {
	Info       Info                       `json:"info"`
	Usage      Usage                      `json:"usage"`
	Workspaces map[string]WorkspaceExport `json:"workspaces"`
	Commands   map[string]CommandExport   `json:"commands,omitempty"`
}

type WorkspaceExport struct {
	Tar  string `json:"tar"`
	Diff Diff   `json:"diff"`
}

type CommandExport struct {
	File     string `json:"file"`
	ExitCode int    `json:"exit_code"`
	Stderr   string `json:"stderr,omitempty"`
}

// Diff 是工作区相对初始状态（setup 完成时）的文件变化，路径相对于工作区根目录。
type Diff struct {
	Added    []string `json:"added"`
	Modified []string `json:"modified"`
	Deleted  []string `json:"deleted"`
}
