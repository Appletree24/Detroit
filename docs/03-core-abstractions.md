# 03 核心抽象

> 本文保留 Go 内核的 Task / Subject / Variant / Episode 语义。基础结构已在 internal/core 中实现；下文离线评分、具身配置等仍有目标内容。新增版本与执行身份见 §5，实际可用能力以 [README](../README.md) 为准。

本文定义 Detroit 的核心契约与扩展方向。所有垂类通过这些抽象与内核交互；代码片段是接口说明，不代表每个类型及其调用链均已落地。

## 1. 类型关系

```
RunSpec ──展开──▶ []Episode
  │                  │
  ├─ SubjectRef      ├─ Task ── Variant ── InitState
  ├─ TaskSet         └─ seed, repeat_idx
  ├─ ScorerSpec
  └─ StatsSpec
                  Episode ──执行──▶ Trajectory ──评分──▶ EpisodeResult ──归因──▶ []Label
                                                                │
                                         []EpisodeResult ──聚合──▶ Aggregate ──▶ Report
```

## 2. 定义

### Task
一个可判定成败的目标。由垂类定义。

```go
type Task struct {
    ID          string            // "libero_spatial/0003" 或 "refund-policy/017"
    Suite       string            // 用于分组聚合
    Instruction string            // 自然语言指令（两类都有）
    MaxSteps    int
    Meta        map[string]string // 能力标签：如 "skill=pick", "domain=refund"
}
```

### Variant
对任务的受控扰动。`Variant{ID:"base"}` 表示无扰动。

```go
type Variant struct {
    ID     string            // "camera_shift_15deg", "instruction_paraphrase_2", "tool_latency_2s"
    Axis   string            // 扰动维度："camera" | "lighting" | "layout" | "language" | "tool_fault" …
    Params map[string]any
}
```

### InitState
环境的确定性初始条件。具身垂类对应 LIBERO 的固定初始状态编号；Agent 垂类对应沙箱快照 ID。

### Subject（被测对象）
```go
type SubjectRef struct {
    Adapter  string // "openai-compatible" | "openpi" | "lerobot" …
    Endpoint string
    Digest   string // 模型/镜像的不可变标识，写入 manifest
    Params   map[string]any // 温度、replan_steps 等
}
```

### Episode
```go
type Episode struct {
    Key         string // 幂等键，见 02 §3.2
    RunID       string
    TaskID      string
    VariantID   string
    InitStateID string
    Seed        int64
    RepeatIdx   int
}
```

### Trajectory
逐步记录，存为制品 `trajectory.jsonl`：

```go
type Step struct {
    T         int
    ObsDigest string        // 观测摘要（图像存哈希/帧号，文本存原文）
    Action    json.RawMessage
    Info      map[string]any // 环境返回的附加信息：子目标谓词、工具错误…
    LatencyMs int
}
```

### Scorer
分为两类：

- **OnlineScorer**：在 Worker 内运行，需要访问环境内部状态（如仿真器中物体位姿、沙箱中数据库内容）。产出成败与子目标进度。
- **OfflineScorer**：在内核侧运行，只读制品（如 LLM Judge 读对话、VLM Judge 读视频）。可以随时重跑。

```go
type OnlineScore struct {
    Success   bool
    Progress  float64          // 0..1，子目标完成比例，用于部分得分
    Subgoals  []SubgoalStatus  // {Name, Achieved, AtStep}
}

type OfflineScorer interface {
    Name() string
    Version() string                       // 写入 labels，评分器升级后可区分
    Score(ctx context.Context, ep EpisodeResult, art ArtifactReader) ([]Label, error)
}
```

### EpisodeResult
```go
type EpisodeResult struct {
    Key        string
    Outcome    Outcome     // Success | Failure | Unknown（评分依据不足，见 10 §7.4）
    Status     Status      // Done | InfraError
    ErrorKind  string      // 仅 InfraError：sandbox_boot | sim_crash | subject_timeout …
    Score      OnlineScore
    Steps      int
    DurationMs int64
    Cost       Cost        // Agent：tokens / 金额；具身：推理调用次数
    Artifacts  string      // 制品根 URI
}
```

### Label（失败归因标签）
```go
type Label struct {
    EpisodeKey string
    Labeler    string  // "rule:subgoal" | "judge:vlm@v3" | "human:alice"
    Label      string  // 来自垂类定义的失败分类体系，见 05 / 06
    Confidence float64
    Rationale  string
}
```

### Aggregate
```go
type Aggregate struct {
    GroupBy     []string // e.g. ["suite","variant"]
    N           int      // 有效 episode 数（不含 InfraError 和 Unknown）
    Successes   int
    Rate        float64
    CI95        [2]float64 // Wilson 区间
    InfraErrors int
    Unknowns    int      // Outcome 为 Unknown 的 episode 数，单列展示
    LabelDist   map[string]int
}
```

## 3. 垂类需要实现的扩展点

下表是目标组织方式；当前已存在 workers/agent/sandbox 与 internal/taskset，Subject、taxonomy 和真实评分模块仍待实现。

| 扩展点 | 位置 | 说明 |
|---|---|---|
| Env Worker | `workers/<vertical>/` | 实现 Worker 协议：重置、步进、在线评分、录制 |
| Subject Adapter | `subjects/<name>/` | 把具体模型封装成 Subject 协议 |
| TaskSet Loader | `internal/taskset/` 及各来源实现 | 从 benchmark 或用户数据加载并冻结 Task / Variant / InitState |
| Failure Taxonomy | 各垂类的版本化配置 | 该垂类的失败分类体系，不强制新增统一 verticals 目录 |
| Offline Scorers | 独立评分模块及垂类适配 | Judge 提示词与解析逻辑，共享机制与领域配置分离 |

TaskSet Loader 的接口是 `Load(ctx, TaskSetSpec) → []TaskEntry`，每项是一个 `Task` 和它的全部 `InitState`。当前控制面用它展开 episode，Mock Worker 再运行同一 Loader 按 `task_id` 取内容。这不能保证可变来源内容相同；目标在控制面冻结任务和初态摘要，租约携带冻结引用，Worker 取包并校验，不再次解析可变来源。内置一个 `synthetic` 来源，按参数生成占位任务，供 mock Worker 和测试使用。

## 4. RunSpec 示例

以下展示目标配置语义；当前注册表没有 libero/openpi 实现，scorers.offline、select 和 stats.compare_to 的可解析性也不表示已经执行评分选择或比较。

展开规则：`episodes = tasks × variants × init_states × seeds × repeats`，顺序确定。字段的默认值：`variants: [base]`、`init_states: all`、`seeds: [0]`、`repeats: 1`、`scorers.select: all`、`stats.confidence: 0.95`。未知字段一律拒绝。

```yaml
name: pi05-libero-spatial-camera
subject:
  adapter: openpi
  endpoint: ws://gpu-0:8000
  digest: pi05_libero@sha256:...
  params: { replan_steps: 5 }
taskset:
  vertical: embodied
  source: libero
  suites: [libero_spatial]
  variants: [base, camera_shift_15deg]
  init_states: all          # 每个任务的全部固定初始状态；也可以写正整数 N（前 N 个）或一组 ID
  seeds: [0]                # 默认 [0]
  repeats: 1
  env_digest: sha256:<resolved-environment-digest>  # 示意占位，须替换为冻结环境内容摘要
  options: {}               # 交给 TaskSet Loader 的来源特定参数
scorers:
  offline: [vlm_failure_judge@v1]
  select: all               # 题目挂了多份评分时用哪份：all 或某个 label（10 §8）
stats:
  confidence: 0.95
  compare_to: run_2026_10_20_baseline   # 可选：与基线配对比较
```

## 5. 身份、版本与结果的目标演进

| 对象 | 身份及不变量 |
| --- | --- |
| FrozenTask / InitState | 保存实际内容及摘要、loader 和来源版本；不能仅凭 ID 重取最新内容 |
| ExecutionPlan | 固定任务清单、Subject、Variant、初态、seeds、采样、环境与预算；包含加载后的内容摘要 |
| Run | 一次实验实例；submission_key 的幂等重传、新实验、显式继续分别定义 |
| Episode | 计划中的一次逻辑样本；独立重复由 repeat_idx 表达 |
| Attempt | 一次真实执行及租约代次，保存 worker incarnation、开始/停止/清理状态、成本和迟到原因 |
| ExecutionResult | 不可变执行证据与产物引用，不能被较晚或较快的结果覆盖 |
| Evaluation | 按 task_digest、scoring_digest、证据与评分器版本关联的一次评分 |
| ReportSpec | 固定样本选择、每题评分映射、条件成功率口径、权重、阈值与统计方法 |

上述目标结构尚未写入当前 proto / SQLite。当前 episodes.attempt 是租约过期计数，results 按 episode_key 唯一；不得称为已有完整 Attempt 历史。

Outcome 与执行 Status 继续正交，但目标允许对停止后的有效产物独立评分。评分器运行错误、unknown 判定和任务失败分别保留；scorers.select: all 展开 Evaluation，不增加 Episode 数。请求参数、生效参数与实际观测分开，费用未知不能用数值零代替。

Aggregate 目标补充 planned / pending / judged / unknown / infra_error / validity，以及带 method / confidence / defined 的 interval。当前 ci95 字段名不能表达任意 StatsSpec.Confidence，迁移时需明确旧字段兼容；N=0 时目标 rate 为未定义。完整统计约定见 [07](07-methodology.md)。

Variant 仅表示受控扰动；不同模型或 Harness 由 Subject 配置及跨 Run 的 ComparisonSpec 对齐，不能沿用旧 TS 分支的 variant=model 语义。
