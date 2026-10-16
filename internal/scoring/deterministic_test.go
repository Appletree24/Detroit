package scoring

import (
	"encoding/json"
	"testing"

	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/Appletree24/Detroit/internal/core"
)

func score(t *testing.T, definition string, text string) Report {
	t.Helper()
	report, err := Evaluate(json.RawMessage(definition), agentio.Message{Role: "assistant", Content: &text})
	if err != nil {
		t.Fatal(err)
	}
	return report
}
func TestDeterministicChecksAndCombination(t *testing.T) {
	tests := []struct {
		name, requirements, text string
		want                     core.Outcome
	}{
		{"json", `[{"id":"r","required":true,"checks":[{"type":"json_only"}]}]`, `{"ok":true}`, core.OutcomeSuccess},
		{"bad json", `[{"id":"r","required":true,"checks":[{"type":"json_only"}]}]`, `Here is JSON: {}`, core.OutcomeFailure},
		{"json schema", `[{"id":"r","required":true,"checks":[{"type":"json_schema","schema":{"type":"object","required":["ok"],"properties":{"ok":{"const":true}}}}]}]`, `{"ok":true}`, core.OutcomeSuccess},
		{"schema rejects", `[{"id":"r","required":true,"checks":[{"type":"json_schema","schema":{"required":["ok"]}}]}]`, `{}`, core.OutcomeFailure},
		{"contains", `[{"id":"r","required":true,"checks":[{"type":"contains","text":"hello","ignore_case":true},{"type":"not_contains","text":"bad"}]}]`, `HELLO world`, core.OutcomeSuccess},
		{"rubric only", `[{"id":"r","required":true,"rubric":{"question":"correct?"}}]`, `good`, core.OutcomeUnknown},
		{"unknown check", `[{"id":"r","required":true,"checks":[{"type":"future_check"}]}]`, `good`, core.OutcomeUnknown},
		{"unsupported regex", `[{"id":"r","required":true,"checks":[{"type":"regex","pattern":"(?<=a)b"}]}]`, `ab`, core.OutcomeUnknown},
		{"failure wins", `[{"id":"r","required":true,"checks":[{"type":"contains","text":"absent"},{"type":"future_check"}]}]`, `text`, core.OutcomeFailure},
		{"required unknown", `[{"id":"r","required":true,"checks":[{"type":"future_check"}]},{"id":"b","required":false,"checks":[{"type":"contains","text":"ok"}]}]`, `ok`, core.OutcomeUnknown},
		{"weighted known bonus", `[{"id":"b1","required":false,"weight":1,"checks":[{"type":"contains","text":"ok"}]},{"id":"b2","required":false,"weight":3,"checks":[{"type":"future_check"}]}]`, `ok`, core.OutcomeSuccess},
		{"bonus threshold unmet", `[{"id":"b","required":false,"checks":[{"type":"contains","text":"ok"}]}]`, `bad`, core.OutcomeUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := score(t, `{"combine":{"rule":"required_then_threshold","threshold":0.6},"requirements":`+tt.requirements+`}`, tt.text)
			if r.Outcome != tt.want {
				t.Fatalf("%+v", r)
			}
			if tt.name == "weighted known bonus" && r.BonusCoverage != 0.25 {
				t.Fatalf("unknown bonus was counted as zero: %+v", r)
			}
		})
	}
	r, err := Evaluate(nil, agentio.Message{})
	if err != nil || r.Outcome != core.OutcomeUnknown {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestToolArgumentSubset(t *testing.T) {
	var message agentio.Message
	if err := json.Unmarshal([]byte(`{"role":"assistant","tool_calls":[{"id":"c","type":"function","function":{"name":"read","arguments":"{\"path\":\"data.csv\",\"options\":{\"limit\":10,\"encoding\":\"utf8\"}}"}}]}`), &message); err != nil {
		t.Fatal(err)
	}
	definition := json.RawMessage(`{"combine":{"rule":"required_then_threshold"},"requirements":[{"id":"r","required":true,"checks":[{"type":"tool_called","name":"read","args_match":{"path":"data.csv","options":{"limit":10}}},{"type":"tool_not_called","name":"write"}]}]}`)
	report, err := Evaluate(definition, message)
	if err != nil || report.Outcome != core.OutcomeSuccess {
		t.Fatalf("%+v %v", report, err)
	}
	message.ToolCalls[0].Function.Arguments = `{"path":"wrong"}`
	report, err = Evaluate(definition, message)
	if err != nil || report.Outcome != core.OutcomeFailure {
		t.Fatalf("%+v %v", report, err)
	}
}

func TestBrokenScorerIsAnError(t *testing.T) {
	raw := json.RawMessage(`{"combine":{"rule":"required_then_threshold"},"requirements":[{"id":"r","required":true,"checks":[{"type":"json_schema","schema":{"$ref":"https://invalid.example/schema"}}]}]}`)
	text := `{}`
	r, err := Evaluate(raw, agentio.Message{Role: "assistant", Content: &text})
	if err == nil || r.Error == "" {
		t.Fatalf("fault was hidden: %+v %v", r, err)
	}
}
