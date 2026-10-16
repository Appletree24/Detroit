package dataset

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

func validateCase(c Document) error {
	want, err := digest(c["task"])
	if err != nil {
		return err
	}
	if want != str(field(c, "digests", "task")) {
		return fmt.Errorf("%s: task digest mismatch", docKey(c))
	}
	if _, err := time.Parse(time.RFC3339, str(field(c, "provenance", "created_at"))); err != nil {
		return fmt.Errorf("%s: invalid created_at: %w", docKey(c), err)
	}
	task := object(c["task"])
	if steps, ok := task["max_steps"].(float64); ok && steps >= math.Ldexp(1, strconv.IntSize-1) {
		return fmt.Errorf("%s: max_steps exceeds the runtime integer range", docKey(c))
	}
	msgs := array(task["messages"])
	if str(task["horizon"]) == "next_message" && (len(msgs) == 0 || str(field(msgs[len(msgs)-1], "role")) == "assistant") {
		return fmt.Errorf("%s: next_message requires messages ending with user or tool", docKey(c))
	}
	pending := map[string]bool{}
	seen := map[string]bool{}
	for _, msg := range msgs {
		role := str(field(msg, "role"))
		if len(pending) > 0 && role != "tool" {
			return fmt.Errorf("%s: tool calls must be followed by matching results", docKey(c))
		}
		if role == "tool" {
			id := str(field(msg, "tool_call_id"))
			if !pending[id] {
				return fmt.Errorf("%s: orphan or duplicate tool result %q", docKey(c), id)
			}
			delete(pending, id)
		}
		for _, call := range array(field(msg, "tool_calls")) {
			id := str(field(call, "id"))
			if seen[id] {
				return fmt.Errorf("%s: duplicate tool call %q", docKey(c), id)
			}
			seen[id] = true
			pending[id] = true
		}
	}
	if len(pending) > 0 {
		return fmt.Errorf("%s: missing tool results", docKey(c))
	}
	if field(c, "task", "environment", "kind") == "unavailable" && task["horizon"] != "next_message" {
		return fmt.Errorf("%s: unavailable environment only supports next_message", docKey(c))
	}
	if c["scoring"] != nil {
		got, err := scoringDigest(c["scoring"])
		if err != nil {
			return err
		}
		if got != str(field(c, "digests", "scoring")) {
			return fmt.Errorf("%s: inline scoring digest mismatch", docKey(c))
		}
	} else if field(c, "digests", "scoring") != nil {
		return fmt.Errorf("%s: scoring digest without inline scoring", docKey(c))
	}
	return nil
}

// validateScoring returns reject=true only for a valid scoring document that
// cannot apply to this task. Malformed quotes remain import errors (§10).
func validateScoring(c Document, s Document, notice func(string, string), blobText func(Document) (string, error)) (reject bool, err error) {
	ids := map[string]bool{}
	for _, r := range array(s["requirements"]) {
		id := str(field(r, "id"))
		if ids[id] {
			return false, fmt.Errorf("duplicate requirement %q", id)
		}
		ids[id] = true
		src := object(field(r, "source"))
		quote := str(src["quote"])
		if index, ok := src["message"].(float64); ok {
			msgs := array(field(c, "task", "messages"))
			if index < 0 || index >= float64(len(msgs)) {
				return false, fmt.Errorf("requirement %s: source message index %g is out of range", id, index)
			}
			if !strings.Contains(str(field(msgs[int(index)], "content")), quote) {
				return false, fmt.Errorf("requirement %s: source quote absent from message %g", id, index)
			}
		}
		if path := str(src["material"]); path != "" {
			found := false
			for _, m := range array(field(c, "task", "materials")) {
				if field(m, "path") == path && strings.Contains(str(field(m, "content")), quote) {
					found = true
				}
			}
			for _, m := range array(field(c, "task", "materials")) {
				if field(m, "path") == path && field(m, "blob") != nil {
					content, err := blobText(object(field(m, "blob")))
					if err != nil {
						return false, err
					}
					if strings.Contains(content, quote) {
						found = true
					}
				}
			}
			if !found {
				return false, fmt.Errorf("requirement %s: source quote absent from material %q", id, path)
			}
		}
		observed := field(c, "diagnostic", "observed")
		if observed != nil {
			observedString := observedText(observed)
			if ref := object(field(observed, "trajectory")); ref != nil {
				var err error
				observedString, err = blobText(ref)
				if err != nil {
					return false, err
				}
			}
			for _, ex := range array(field(r, "rubric", "examples")) {
				if field(ex, "origin") == "observed" && !strings.Contains(observedString, str(field(ex, "text"))) {
					return false, fmt.Errorf("requirement %s: observed example absent from diagnostic", id)
				}
			}
		}
		for _, check := range array(field(r, "checks")) {
			typ := str(field(check, "type"))
			switch typ {
			case "file_exists", "file_contains", "command", "tests":
				if field(c, "task", "horizon") == "next_message" {
					return true, nil
				}
			case "json_only", "json_schema", "contains", "not_contains", "regex", "not_regex", "tool_called", "tool_not_called":
			default:
				notice("unknown_check", fmt.Sprintf("requirement %s: unknown check %q; runtime verdict must be unknown", id, typ))
			}
		}
	}
	return false, nil
}

func observedText(v any) string {
	// Source evidence may contain serialized tool arguments as well as prose.
	text := str(field(v, "content"))
	for _, call := range array(field(v, "tool_calls")) {
		text += "\n" + str(field(call, "function", "arguments"))
	}
	return text
}

func datasetDigest(d Document) (string, error) {
	return digest(Document{"entries": d["entries"], "purpose": d["purpose"]})
}

func validateReferences(b Bundle) error {
	cases := map[string]Document{}
	scores := map[string]Document{}
	for _, c := range b.Cases {
		k := docKey(c)
		if cases[k] != nil {
			return fmt.Errorf("duplicate case %s", k)
		}
		cases[k] = c
	}
	for _, s := range b.Scorings {
		k := docKey(s)
		if scores[k] != nil {
			return fmt.Errorf("duplicate scoring %s", k)
		}
		scores[k] = s
	}
	seen := map[string]bool{}
	for _, entry := range array(b.Dataset["entries"]) {
		ref := object(field(entry, "case"))
		key := docKey(ref)
		if seen[key] {
			return fmt.Errorf("duplicate dataset entry %s", key)
		}
		seen[key] = true
		c := cases[key]
		if c == nil {
			return fmt.Errorf("dataset references missing case %s", key)
		}
		if field(ref, "task_digest") != field(c, "digests", "task") {
			return fmt.Errorf("dataset task digest mismatch for %s", key)
		}
		for _, sr := range array(field(entry, "scoring")) {
			if field(sr, "id") == nil {
				if field(sr, "digest") != field(c, "digests", "scoring") {
					return fmt.Errorf("missing inline scoring for %s", key)
				}
				continue
			}
			s := scores[docKey(sr)]
			if s == nil || field(sr, "digest") != field(s, "digests", "scoring") {
				return fmt.Errorf("dataset references missing scoring %s", docKey(sr))
			}
			if field(s, "target", "case_id") != c["id"] || field(s, "target", "task_digest") != field(c, "digests", "task") {
				return fmt.Errorf("scoring target mismatch for %s", docKey(sr))
			}
		}
	}
	return nil
}
