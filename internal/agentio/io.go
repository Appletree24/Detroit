// Package agentio defines the next_message observation shared by Agent Workers
// and Subject adapters. Only task-visible fields enter an observation.
package agentio

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/Appletree24/Detroit/internal/core"
)

const MaxPayload = 16 << 20
const ObservationSchema = "detroit.agent.observation/v1"
const ActionSchema = "openai.chat.completion/v1"

type Observation struct {
	Messages []map[string]any `msgpack:"messages" json:"messages"`
	Tools    []map[string]any `msgpack:"tools,omitempty" json:"tools,omitempty"`
	Params   map[string]any   `msgpack:"params,omitempty" json:"params,omitempty"`
	Seed     int64            `msgpack:"seed" json:"seed"`
}

type TaskInput struct {
	Kind        string           `json:"kind"`
	Horizon     string           `json:"horizon"`
	Instruction string           `json:"instruction"`
	Messages    []map[string]any `json:"messages"`
	System      *struct {
		Content *string `json:"content"`
	} `json:"system"`
	Tools struct {
		Definitions []map[string]any `json:"definitions"`
	} `json:"tools"`
	Materials []struct {
		Path    string  `json:"path"`
		Content *string `json:"content"`
		Blob    *struct {
			SHA256 string `json:"sha256"`
		} `json:"blob"`
	} `json:"materials"`
}

func ValidateParams(params map[string]any) error {
	for _, key := range []string{"model", "messages", "tools", "stream", "stream_options", "n", "seed", "api_key", "authorization", "headers"} {
		if _, ok := params[key]; ok {
			return fmt.Errorf("subject.params.%s is reserved; model/key belong to the Subject service, seed comes from the episode", key)
		}
	}
	if v, ok := params["send_seed"]; ok {
		if _, ok = v.(bool); !ok {
			return fmt.Errorf("subject.params.send_seed must be boolean")
		}
	}
	return nil
}

// ValidateRun runs before model requests, both at submission and at execution.
func ValidateRun(spec *core.RunSpec, entries []core.TaskEntry) error {
	if spec.Subject.Adapter != "openai-compatible" {
		return fmt.Errorf("Agent Worker requires subject.adapter openai-compatible")
	}
	if spec.Subject.Endpoint == "" {
		return fmt.Errorf("subject.endpoint is required (Subject gRPC address)")
	}
	if spec.TaskSet.Source != "detroit-v2" || spec.TaskSet.Vertical != "agent" {
		return fmt.Errorf("real model evaluation requires an agent detroit-v2 taskset")
	}
	if err := ValidateParams(spec.Subject.Params); err != nil {
		return err
	}
	if len(spec.Scorers.Offline) > 0 {
		return fmt.Errorf("named offline scorers are not implemented; use the dataset's deterministic scoring")
	}
	for _, variant := range spec.TaskSet.Variants {
		if variant != core.BaseVariant {
			return fmt.Errorf("Agent Worker currently supports variant base only")
		}
	}
	for _, entry := range entries {
		var input TaskInput
		if err := json.Unmarshal(entry.Task.Input, &input); err != nil {
			return err
		}
		if input.Kind != "agent" || input.Horizon != "next_message" {
			return fmt.Errorf("task %s: Agent Worker currently supports horizon next_message only", entry.Task.ID)
		}
		if len(input.Messages) == 0 {
			return fmt.Errorf("task %s: messages are required", entry.Task.ID)
		}
		if entry.Evaluation != nil && len(entry.Evaluation.Scorings) > 1 {
			return fmt.Errorf("task %s selects multiple scorings; set scorers.select to one label", entry.Task.ID)
		}
	}
	return nil
}

// Prepare renders text materials as a leading user context message. Existing
// conversation messages and captured/approximate system content remain intact.
func Prepare(entry core.TaskEntry, snapshot string, params map[string]any, seed int64) (Observation, error) {
	var task TaskInput
	if err := json.Unmarshal(entry.Task.Input, &task); err != nil {
		return Observation{}, err
	}
	obs := Observation{Tools: task.Tools.Definitions, Params: params, Seed: seed}
	if task.System != nil && task.System.Content != nil {
		obs.Messages = append(obs.Messages, map[string]any{"role": "system", "content": *task.System.Content})
	}
	if len(task.Materials) > 0 {
		materials := []map[string]string{}
		total := 0
		for _, m := range task.Materials {
			var content string
			if m.Content != nil {
				content = *m.Content
			} else if m.Blob != nil {
				hex := m.Blob.SHA256
				if len(hex) != 64 || strings.Trim(hex, "0123456789abcdef") != "" {
					return Observation{}, fmt.Errorf("invalid material blob digest")
				}
				path := filepath.Join(snapshot, "blobs", "sha256", hex)
				info, err := os.Stat(path)
				if err != nil {
					return Observation{}, err
				}
				if info.Size() > MaxPayload {
					return Observation{}, fmt.Errorf("material %s exceeds model request limit", m.Path)
				}
				b, err := os.ReadFile(path)
				if err != nil {
					return Observation{}, err
				}
				if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 {
					return Observation{}, fmt.Errorf("material %s is not UTF-8 text; this Worker supports text materials only", m.Path)
				}
				content = string(b)
			}
			total += len(content)
			if total > MaxPayload {
				return Observation{}, fmt.Errorf("materials exceed model request limit")
			}
			materials = append(materials, map[string]string{"path": m.Path, "content": content})
		}
		data, err := json.Marshal(map[string]any{"materials": materials})
		if err != nil {
			return Observation{}, err
		}
		obs.Messages = append(obs.Messages, map[string]any{"role": "user", "content": "Task materials (paths and UTF-8 contents):\n" + string(data)})
	}
	obs.Messages = append(obs.Messages, task.Messages...)
	return obs, nil
}

// Request fixes one completion per episode. Seed forwarding is opt-in because
// compatible providers differ in seed support; the effective request is saved.
func Request(obs Observation, model string) (map[string]any, error) {
	if err := ValidateParams(obs.Params); err != nil {
		return nil, err
	}
	if len(obs.Messages) == 0 {
		return nil, fmt.Errorf("messages are required")
	}
	request := map[string]any{"model": model, "messages": obs.Messages, "stream": false, "n": 1}
	for k, v := range obs.Params {
		if k != "send_seed" {
			request[k] = v
		}
	}
	if obs.Params["send_seed"] == true {
		request["seed"] = obs.Seed
	}
	if len(obs.Tools) > 0 {
		request["tools"] = obs.Tools
	}
	return request, nil
}

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role      string     `json:"role"`
	Content   *string    `json:"content"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	Refusal   *string    `json:"refusal,omitempty"`
}

type Completion struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Message      json.RawMessage `json:"message"`
		FinishReason string          `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		InputTokens  *int64 `json:"prompt_tokens"`
		OutputTokens *int64 `json:"completion_tokens"`
	} `json:"usage"`
}

// ParseMessage distinguishes malformed actions from transport/protocol faults.
func ParseMessage(raw json.RawMessage) (Message, error) {
	var m Message
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, fmt.Errorf("malformed_action: invalid assistant message")
	}
	if m.Role != "assistant" || (m.Content == nil && len(m.ToolCalls) == 0 && m.Refusal == nil) {
		return m, fmt.Errorf("malformed_action: missing assistant output")
	}
	ids := map[string]bool{}
	for _, call := range m.ToolCalls {
		var args map[string]any
		if call.ID == "" || ids[call.ID] || call.Type != "function" || call.Function.Name == "" || json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || args == nil {
			return m, fmt.Errorf("malformed_action: invalid function tool call")
		}
		ids[call.ID] = true
	}
	return m, nil
}
