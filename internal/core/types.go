// Package core 定义 Detroit 的核心类型（docs/03）。所有垂类只能通过这些抽象与内核交互。
package core

import (
	"encoding/json"
)

// Task 是一个可判定成败的目标，由垂类定义。
type Task struct {
	ID          string            `json:"id"`    // "libero_spatial/0003" 或 "refund-policy/017"
	Suite       string            `json:"suite"` // 用于分组聚合
	Instruction string            `json:"instruction"`
	MaxSteps    int               `json:"max_steps"`
	Meta        map[string]string `json:"meta,omitempty"` // 能力标签：如 "skill=pick"
}

// Variant 是对任务的受控扰动。Variant{ID: "base"} 表示无扰动。
type Variant struct {
	ID     string         `json:"id"`
	Axis   string         `json:"axis,omitempty"` // "camera" | "lighting" | "layout" | "language" | "tool_fault" …
	Params map[string]any `json:"params,omitempty"`
}

// BaseVariant 是无扰动变体的 ID。
const BaseVariant = "base"

// InitState 是环境的确定性初始条件：具身对应 LIBERO 的固定初始状态编号，Agent 对应沙箱快照 ID。
type InitState struct {
	ID string `json:"id"`
}

// SubjectRef 指向一个被测对象服务。
type SubjectRef struct {
	Adapter  string         `json:"adapter" yaml:"adapter"` // "openai-compatible" | "openpi" | "lerobot" …
	Endpoint string         `json:"endpoint" yaml:"endpoint"`
	Digest   string         `json:"digest" yaml:"digest"` // 模型/镜像的不可变标识，写入 manifest
	Params   map[string]any `json:"params,omitempty" yaml:"params"`
}

// Episode 是调度的最小单位。Key 是幂等键，见 EpisodeKey。
type Episode struct {
	Key         string `json:"key"`
	RunID       string `json:"run_id"`
	TaskID      string `json:"task_id"`
	VariantID   string `json:"variant_id"`
	InitStateID string `json:"init_state_id"`
	Seed        int64  `json:"seed"`
	RepeatIdx   int    `json:"repeat_idx"`
}

// Step 是轨迹中的一步，存为制品 trajectory.jsonl。
type Step struct {
	T         int             `json:"t"`
	ObsDigest string          `json:"obs_digest"`
	Action    json.RawMessage `json:"action"`
	Info      map[string]any  `json:"info,omitempty"`
	LatencyMs int             `json:"latency_ms"`
}

// SubgoalStatus 记录一个子目标是否达成。
type SubgoalStatus struct {
	Name     string `json:"name"`
	Achieved bool   `json:"achieved"`
	AtStep   int    `json:"at_step"`
}

// OnlineScore 由 Worker 内的 OnlineScorer 产出。
type OnlineScore struct {
	Success  bool            `json:"success"`
	Progress float64         `json:"progress"` // 0..1，子目标完成比例
	Subgoals []SubgoalStatus `json:"subgoals,omitempty"`
}

// Outcome 是任务判定结果。
type Outcome string

const (
	OutcomeSuccess Outcome = "success"
	OutcomeFailure Outcome = "failure"
	OutcomeUnknown Outcome = "unknown" // 评分依据不足（docs/10 §7.4），不计入成功率分母
)

// Status 是 episode 执行状态，与 Outcome 正交。
type Status string

const (
	StatusDone       Status = "done"
	StatusInfraError Status = "infra_error" // 不计入成功率分母，报告中单列
)

// 控制面自己产生的 ErrorKind。其余（sandbox_boot、sim_crash、subject_timeout…）由 Worker 上报。
const ErrorKindLeaseExhausted = "lease_exhausted"

// Cost 记录资源消耗：Agent 为 tokens / 金额，具身为推理调用次数。
type Cost struct {
	InputTokens  int64   `json:"input_tokens,omitempty"`
	OutputTokens int64   `json:"output_tokens,omitempty"`
	USD          float64 `json:"usd,omitempty"`
	Inferences   int64   `json:"inferences,omitempty"`
}

// EpisodeResult 是 Worker 上报的单个 episode 结果。
type EpisodeResult struct {
	Key        string      `json:"key"`
	Outcome    Outcome     `json:"outcome,omitempty"`
	Status     Status      `json:"status"`
	ErrorKind  string      `json:"error_kind,omitempty"` // 仅 InfraError
	Score      OnlineScore `json:"score"`
	Steps      int         `json:"steps"`
	DurationMs int64       `json:"duration_ms"`
	Cost       Cost        `json:"cost"`
	Artifacts  string      `json:"artifacts,omitempty"` // 制品根 URI
}

// Label 是失败归因标签。
type Label struct {
	EpisodeKey string  `json:"episode_key"`
	Labeler    string  `json:"labeler"` // "rule:subgoal" | "judge:vlm@v3" | "human:alice"
	Label      string  `json:"label"`
	Confidence float64 `json:"confidence"`
	Rationale  string  `json:"rationale"`
}

// Aggregate 是按分组聚合的统计结果。
type Aggregate struct {
	GroupBy     []string       `json:"group_by"`
	N           int            `json:"n"` // 有效 episode 数（不含 InfraError 和 Unknown）
	Successes   int            `json:"successes"`
	Rate        float64        `json:"rate"`
	CI95        [2]float64     `json:"ci95"` // Wilson 区间
	InfraErrors int            `json:"infra_errors"`
	Unknowns    int            `json:"unknowns"`
	LabelDist   map[string]int `json:"label_dist,omitempty"`
}
