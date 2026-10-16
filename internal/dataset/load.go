package dataset

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
)

// Load resolves only entries in the frozen dataset. Scoring and diagnostics are
// never included in Input. Scorings remain evaluator-only raw protocol objects.
func Load(ctx context.Context, path, expected, selectScoring string) ([]LoadedCase, error) {
	return LoadSuites(ctx, path, expected, selectScoring, nil)
}

// LoadSuites filters suites before resolving a scoring label.
func LoadSuites(ctx context.Context, path, expected, selectScoring string, suites []string) ([]LoadedCase, error) {
	if expected == "" {
		return nil, fmt.Errorf("dataset snapshot digest is required")
	}
	snap, err := openSnapshot(ctx, path, expected)
	if err != nil {
		return nil, err
	}
	b := snap.Bundle
	if !snap.ValidationConfirmed {
		conflicts := &ImportResult{}
		if err := validationConflicts(ctx, b, filepath.Dir(filepath.Clean(path)), conflicts); err != nil {
			return nil, err
		}
		if len(conflicts.ValidationConflicts) > 0 {
			return nil, fmt.Errorf("validation conflicts require explicit confirmation at import")
		}
	}
	cases := map[string]Document{}
	scores := map[string]Document{}
	for _, c := range b.Cases {
		cases[docKey(c)] = c
	}
	for _, s := range b.Scorings {
		scores[docKey(s)] = s
	}
	var out []LoadedCase
	for _, entry := range array(b.Dataset["entries"]) {
		c := cases[docKey(field(entry, "case"))]
		if c == nil {
			return nil, fmt.Errorf("missing case")
		}
		loaded := LoadedCase{ID: str(c["id"]), Suite: str(c["suite"]), MaxSteps: 1, Meta: map[string]string{}, Input: jsonBytes(c["task"]), TaskDigest: str(field(c, "digests", "task")), DatasetDigest: str(field(b.Dataset, "digests", "dataset")), Weight: 1, GroupKey: str(field(c, "provenance", "source", "group_key")), Purpose: str(b.Dataset["purpose"]), Scorings: []json.RawMessage{}}
		if loaded.Suite == "" {
			loaded.Suite = str(b.Dataset["id"])
		}
		if suite := str(field(entry, "suite")); suite != "" {
			loaded.Suite = suite
		}
		if len(suites) > 0 && !slices.Contains(suites, loaded.Suite) {
			continue
		}
		for k, v := range object(c["meta"]) {
			loaded.Meta[k] = str(v)
		}
		if n, ok := field(c, "task", "max_steps").(float64); ok {
			loaded.MaxSteps = int(n)
		}
		if w, ok := field(entry, "weight").(float64); ok {
			loaded.Weight = w
		}
		matched := false
		for _, ref := range array(field(entry, "scoring")) {
			s := object(c["scoring"])
			if field(ref, "id") != nil {
				s = scores[docKey(ref)]
			}
			if s == nil {
				return nil, fmt.Errorf("missing scoring for %s", loaded.ID)
			}
			if selectScoring == "" || selectScoring == "all" || s["label"] == selectScoring {
				loaded.Scorings = append(loaded.Scorings, jsonBytes(s))
				matched = true
			}
		}
		if selectScoring != "" && selectScoring != "all" && !matched {
			return nil, fmt.Errorf("case %s has no scoring labelled %q", loaded.ID, selectScoring)
		}
		out = append(out, loaded)
	}
	return out, nil
}
