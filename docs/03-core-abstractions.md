# 03 核心抽象

本文定义 Detroit 的全部核心类型。所有垂类只能通过这些抽象与内核交互。

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

| 扩展点 | 位置 | 说明 |
|---|---|---|
| Env Worker | `workers/<vertical>/` | 实现 Worker 协议：重置、步进、在线评分、录制 |
| Subject Adapter | `subjects/<name>/` | 把具体模型封装成 Subject 协议 |
| TaskSet Loader | `verticals/<vertical>/tasks` | 从 benchmark 或用户数据加载 Task / Variant / InitState |
| Failure Taxonomy | `verticals/<vertical>/taxonomy.yaml` | 该垂类的失败分类体系 |
| Offline Scorers | `verticals/<vertical>/scorers` | Judge 提示词与解析逻辑 |

## 4. RunSpec 示例

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
  init_states: all          # 每个任务的全部固定初始状态
  repeats: 1
scorers:
  offline: [vlm_failure_judge@v1]
  select: all               # 题目挂了多份评分时用哪份：all 或某个 label（10 §8）
stats:
  confidence: 0.95
  compare_to: run_2026_10_20_baseline   # 可选：与基线配对比较
```
