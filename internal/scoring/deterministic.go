// Package scoring evaluates the deterministic output checks in Detroit v2.
// Missing rubric judgments and unsupported checks remain unknown.
package scoring

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/google/jsonschema-go/jsonschema"
)

const Version = "deterministic@1"
const (
	Pass    = "pass"
	Fail    = "fail"
	Unknown = "unknown"
)

type CheckResult struct {
	Type    string `json:"type"`
	Verdict string `json:"verdict"`
	Reason  string `json:"reason,omitempty"`
}
type RequirementResult struct {
	ID       string        `json:"id"`
	Required bool          `json:"required"`
	Weight   float64       `json:"weight"`
	Verdict  string        `json:"verdict"`
	Checks   []CheckResult `json:"checks"`
	Reason   string        `json:"reason,omitempty"`
}
type Report struct {
	Version       string              `json:"version"`
	Label         string              `json:"label,omitempty"`
	Outcome       core.Outcome        `json:"outcome"`
	Progress      float64             `json:"progress"`
	BonusCoverage float64             `json:"bonus_coverage"`
	Requirements  []RequirementResult `json:"requirements"`
	Error         string              `json:"error,omitempty"`
}

type definition struct {
	Label   string `json:"label"`
	Combine struct {
		Rule      string   `json:"rule"`
		Threshold *float64 `json:"threshold"`
	} `json:"combine"`
	Requirements []struct {
		ID       string           `json:"id"`
		Required bool             `json:"required"`
		Weight   *float64         `json:"weight"`
		Checks   []map[string]any `json:"checks"`
	} `json:"requirements"`
}

func Evaluate(raw json.RawMessage, output agentio.Message) (report Report, err error) {
	report = Report{Version: Version, Outcome: core.OutcomeUnknown, Requirements: []RequirementResult{}}
	if len(raw) == 0 {
		return report, nil
	}
	var d definition
	if err = json.Unmarshal(raw, &d); err != nil {
		return report, fmt.Errorf("decode scoring: %w", err)
	}
	report.Label = d.Label
	if d.Combine.Rule != "required_then_threshold" || len(d.Requirements) == 0 {
		return report, fmt.Errorf("invalid scoring definition")
	}
	requiredFailed, requiredUnknown := false, false
	bonusCount, passed := 0, 0
	knownWeight, totalWeight, weightedPass := 0.0, 0.0, 0.0
	for _, r := range d.Requirements {
		weight := 1.0
		if r.Weight != nil {
			weight = *r.Weight
		}
		result := RequirementResult{ID: r.ID, Required: r.Required, Weight: weight, Verdict: Pass, Checks: []CheckResult{}}
		if len(r.Checks) == 0 {
			result.Verdict = Unknown
			result.Reason = "rubric requires a Judge or human; no deterministic checks"
		}
		for _, check := range r.Checks {
			cr, e := evaluateCheck(check, output)
			result.Checks = append(result.Checks, cr)
			if e != nil {
				result.Verdict = Unknown
				report.Requirements = append(report.Requirements, result)
				report.Error = e.Error()
				return report, e
			}
			if cr.Verdict == Fail {
				result.Verdict = Fail
			} else if cr.Verdict == Unknown && result.Verdict != Fail {
				result.Verdict = Unknown
			}
		}
		if result.Verdict == Pass {
			passed++
		}
		if r.Required {
			requiredFailed = requiredFailed || result.Verdict == Fail
			requiredUnknown = requiredUnknown || result.Verdict == Unknown
		} else {
			bonusCount++
			totalWeight += weight
			if result.Verdict != Unknown {
				knownWeight += weight
				if result.Verdict == Pass {
					weightedPass += weight
				}
			}
		}
		report.Requirements = append(report.Requirements, result)
	}
	report.Progress = float64(passed) / float64(len(d.Requirements))
	if totalWeight > 0 {
		report.BonusCoverage = knownWeight / totalWeight
	} else if bonusCount == 0 {
		report.BonusCoverage = 1
	}
	switch {
	case requiredFailed:
		report.Outcome = core.OutcomeFailure
	case requiredUnknown:
	case bonusCount == 0 || d.Combine.Threshold == nil:
		report.Outcome = core.OutcomeSuccess
	case knownWeight > 0 && weightedPass/knownWeight >= *d.Combine.Threshold:
		report.Outcome = core.OutcomeSuccess
	}
	return report, nil
}

func evaluateCheck(check map[string]any, output agentio.Message) (CheckResult, error) {
	typ, _ := check["type"].(string)
	result := CheckResult{Type: typ, Verdict: Unknown}
	text := ""
	if output.Content != nil {
		text = *output.Content
	}
	if output.Content == nil && output.Refusal != nil {
		text = *output.Refusal
	}
	if check["scope"] == "tool_calls" {
		data, _ := json.Marshal(output.ToolCalls)
		text = string(data)
	}
	switch typ {
	case "json_only", "json_schema":
		var value any
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			result.Verdict = Fail
			return result, nil
		}
		if typ == "json_only" {
			result.Verdict = Pass
			return result, nil
		}
		data, err := json.Marshal(check["schema"])
		if err != nil {
			return result, err
		}
		var schema jsonschema.Schema
		if err = json.Unmarshal(data, &schema); err != nil {
			return result, fmt.Errorf("invalid json_schema check: %w", err)
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			return result, fmt.Errorf("resolve json_schema check: %w", err)
		}
		result.Verdict = verdict(resolved.Validate(value) == nil)
	case "contains", "not_contains":
		needle, ok := check["text"].(string)
		if !ok {
			return result, fmt.Errorf("%s check requires text", typ)
		}
		if check["ignore_case"] == true {
			text, needle = strings.ToLower(text), strings.ToLower(needle)
		}
		match := strings.Contains(text, needle)
		if typ == "not_contains" {
			match = !match
		}
		result.Verdict = verdict(match)
	case "tool_called", "tool_not_called":
		name, _ := check["name"].(string)
		match := false
		for _, call := range output.ToolCalls {
			if call.Function.Name != name {
				continue
			}
			if expected, ok := check["args_match"]; ok {
				var args any
				dec := json.NewDecoder(bytes.NewBufferString(call.Function.Arguments))
				if err := dec.Decode(&args); err != nil {
					continue
				}
				if !subset(expected, args) {
					continue
				}
			}
			match = true
		}
		if typ == "tool_not_called" {
			match = !match
		}
		result.Verdict = verdict(match)
	default:
		result.Reason = "check is not implemented by this Worker"
	}
	return result, nil
}
func verdict(pass bool) string {
	if pass {
		return Pass
	}
	return Fail
}
func subset(expected, actual any) bool {
	if want, ok := expected.(map[string]any); ok {
		got, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range want {
			value, ok := got[k]
			if !ok || !subset(v, value) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(expected, actual)
}
