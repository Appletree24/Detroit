package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"gopkg.in/yaml.v3"
)

// RunSpec 描述一次评测（docs/03 §4）。
type RunSpec struct {
	Name    string      `json:"name" yaml:"name"`
	Subject SubjectRef  `json:"subject" yaml:"subject"`
	TaskSet TaskSetSpec `json:"taskset" yaml:"taskset"`
	Scorers ScorerSpec  `json:"scorers" yaml:"scorers"`
	Stats   StatsSpec   `json:"stats" yaml:"stats"`
}

// TaskSetSpec 选择要评测的任务及其展开方式。
type TaskSetSpec struct {
	Vertical   string            `json:"vertical" yaml:"vertical"` // "agent" | "embodied"
	Source     string            `json:"source" yaml:"source"`     // TaskSet Loader 名称，如 "libero"
	Suites     []string          `json:"suites,omitempty" yaml:"suites"`
	Variants   []string          `json:"variants" yaml:"variants"`
	InitStates InitStateSelector `json:"init_states" yaml:"init_states"`
	Seeds      []int64           `json:"seeds" yaml:"seeds"`
	Repeats    int               `json:"repeats" yaml:"repeats"`
	EnvDigest  string            `json:"env_digest,omitempty" yaml:"env_digest"` // 环境的不可变标识（镜像 digest、benchmark 版本），参与幂等键
	Options    map[string]any    `json:"options,omitempty" yaml:"options"`       // 交给 Loader 的来源特定参数
}

// ScorerSpec 选择离线评分器以及题目挂多份评分时用哪份（docs/10 §8）。
type ScorerSpec struct {
	Offline []string `json:"offline,omitempty" yaml:"offline"`
	Select  string   `json:"select" yaml:"select"` // "all" 或某个 label
}

// StatsSpec 配置统计口径。
type StatsSpec struct {
	Confidence float64 `json:"confidence" yaml:"confidence"`
	CompareTo  string  `json:"compare_to,omitempty" yaml:"compare_to"`
}

// InitStateSelector 取值为 "all"、一个正整数（每个任务的前 N 个）或一组 ID。
type InitStateSelector struct {
	All   bool
	Count int
	IDs   []string
}

func (s InitStateSelector) MarshalJSON() ([]byte, error) {
	switch {
	case s.All:
		return json.Marshal("all")
	case s.Count > 0:
		return json.Marshal(s.Count)
	default:
		return json.Marshal(s.IDs)
	}
}

func (s *InitStateSelector) UnmarshalJSON(b []byte) error {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	return s.set(v)
}

func (s *InitStateSelector) UnmarshalYAML(n *yaml.Node) error {
	var v any
	if err := n.Decode(&v); err != nil {
		return err
	}
	return s.set(v)
}

func (s *InitStateSelector) set(v any) error {
	*s = InitStateSelector{}
	switch x := v.(type) {
	case nil:
		s.All = true
	case string:
		if x == "all" {
			s.All = true
			return nil
		}
		n, err := strconv.Atoi(x)
		if err != nil || n <= 0 {
			return fmt.Errorf("init_states: want \"all\", a positive integer or a list of IDs, got %q", x)
		}
		s.Count = n
	case int:
		s.Count = x
	case float64:
		s.Count = int(x)
		if float64(s.Count) != x {
			return fmt.Errorf("init_states: %v is not an integer", x)
		}
	case []any:
		for _, item := range x {
			id, ok := item.(string)
			if !ok || id == "" {
				return fmt.Errorf("init_states: list items must be non-empty strings")
			}
			s.IDs = append(s.IDs, id)
		}
		if len(s.IDs) == 0 {
			return errors.New("init_states: empty list")
		}
	default:
		return fmt.Errorf("init_states: unsupported value %v", v)
	}
	if !s.All && s.Count <= 0 && len(s.IDs) == 0 {
		return errors.New("init_states: count must be positive")
	}
	return nil
}

// Pick 按选择器从任务的全部初始状态中挑出要评测的部分。
func (s InitStateSelector) Pick(available []InitState) ([]InitState, error) {
	switch {
	case s.All:
		return available, nil
	case s.Count > 0:
		if s.Count > len(available) {
			return nil, fmt.Errorf("init_states: want %d, task has %d", s.Count, len(available))
		}
		return available[:s.Count], nil
	default:
		byID := make(map[string]InitState, len(available))
		for _, st := range available {
			byID[st.ID] = st
		}
		out := make([]InitState, 0, len(s.IDs))
		for _, id := range s.IDs {
			st, ok := byID[id]
			if !ok {
				return nil, fmt.Errorf("init_states: unknown id %q", id)
			}
			out = append(out, st)
		}
		return out, nil
	}
}

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ParseRunSpec 解析 YAML（或 JSON）格式的 RunSpec，拒绝未知字段，补默认值并校验。
func ParseRunSpec(data []byte) (*RunSpec, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	var spec RunSpec
	if err := dec.Decode(&spec); err != nil {
		return nil, fmt.Errorf("parse runspec: %w", err)
	}
	spec.applyDefaults()
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	return &spec, nil
}

func (s *RunSpec) applyDefaults() {
	if len(s.TaskSet.Variants) == 0 {
		s.TaskSet.Variants = []string{BaseVariant}
	}
	if !s.TaskSet.InitStates.All && s.TaskSet.InitStates.Count == 0 && len(s.TaskSet.InitStates.IDs) == 0 {
		s.TaskSet.InitStates.All = true
	}
	if len(s.TaskSet.Seeds) == 0 {
		s.TaskSet.Seeds = []int64{0}
	}
	if s.TaskSet.Repeats == 0 {
		s.TaskSet.Repeats = 1
	}
	if s.Scorers.Select == "" {
		s.Scorers.Select = "all"
	}
	if s.Stats.Confidence == 0 {
		s.Stats.Confidence = 0.95
	}
}

// Validate 检查 RunSpec 的必填项与取值范围。
func (s *RunSpec) Validate() error {
	var errs []error
	if !namePattern.MatchString(s.Name) {
		errs = append(errs, fmt.Errorf("name %q must match %s", s.Name, namePattern))
	}
	if s.Subject.Adapter == "" {
		errs = append(errs, errors.New("subject.adapter is required"))
	}
	if s.Subject.Digest == "" {
		errs = append(errs, errors.New("subject.digest is required: it identifies the model in the episode key and manifest"))
	}
	switch s.TaskSet.Vertical {
	case "agent", "embodied":
	default:
		errs = append(errs, fmt.Errorf("taskset.vertical %q must be agent or embodied", s.TaskSet.Vertical))
	}
	if s.TaskSet.Source == "" {
		errs = append(errs, errors.New("taskset.source is required"))
	}
	if s.TaskSet.Repeats < 1 {
		errs = append(errs, errors.New("taskset.repeats must be >= 1"))
	}
	if dup := firstDuplicate(s.TaskSet.Variants); dup != "" {
		errs = append(errs, fmt.Errorf("taskset.variants: duplicate %q", dup))
	}
	seen := map[int64]bool{}
	for _, seed := range s.TaskSet.Seeds {
		if seen[seed] {
			errs = append(errs, fmt.Errorf("taskset.seeds: duplicate %d", seed))
		}
		seen[seed] = true
	}
	if s.Stats.Confidence <= 0 || s.Stats.Confidence >= 1 {
		errs = append(errs, fmt.Errorf("stats.confidence %v must be in (0, 1)", s.Stats.Confidence))
	}
	return errors.Join(errs...)
}

// Hash 是规范化后 RunSpec 的 SHA-256（十六进制）。encoding/json 对结构体字段顺序固定、对 map 键排序，结果是确定的。
func (s *RunSpec) Hash() string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(fmt.Sprintf("runspec is not JSON-serializable: %v", err))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// RunID 由名称和规范化 RunSpec 的哈希决定：重新提交同一个 RunSpec 得到同一个 run，从而跳过已完成的 episode（docs/02 §3.2）。
func (s *RunSpec) RunID() string {
	return s.Name + "-" + s.Hash()[:12]
}

func firstDuplicate(xs []string) string {
	seen := map[string]bool{}
	for _, x := range xs {
		if seen[x] {
			return x
		}
		seen[x] = true
	}
	return ""
}
