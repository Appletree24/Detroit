package dataset

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Import accepts a JSON/JSONL file or a protocol directory. No input commands
// are executed. Rejected scoring definitions are reported separately from cases.
func Import(ctx context.Context, path string, opts Options) (*ImportResult, error) {
	src, err := readSource(ctx, path)
	if err != nil {
		return nil, err
	}
	b := src.bundle
	roots := []string{src.root}
	if opts.Base != "" {
		base, err := Open(ctx, opts.Base, "")
		if err != nil {
			return nil, fmt.Errorf("base: %w", err)
		}
		// A scoring-only delivery derives a dataset using all matching scoring versions.
		// Existing case/scoring revisions may not be silently replaced.
		b.Cases = append(base.Cases, b.Cases...)
		b.Scorings = append(base.Scorings, b.Scorings...)
		roots = append(roots, opts.Base)
	}
	if len(b.Cases) == 0 {
		return nil, fmt.Errorf("no cases; use --base to import separate scoring")
	}
	result := &ImportResult{Warnings: []Notice{}, RejectedScorings: []Notice{}, ValidationConflicts: []Notice{}}
	for _, docs := range [][]Document{b.Cases, b.Scorings} {
		for _, d := range docs {
			if err := validateDocument(d); err != nil {
				return nil, fmt.Errorf("%s: %w", docKey(d), err)
			}
		}
	}
	if b.Dataset != nil {
		if err := validateDocument(b.Dataset); err != nil {
			return nil, err
		}
		got, err := datasetDigest(b.Dataset)
		if err != nil {
			return nil, err
		}
		if got != str(field(b.Dataset, "digests", "dataset")) {
			return nil, fmt.Errorf("dataset digest mismatch")
		}
	}
	stableOrder(&b)
	cases := map[string]Document{}
	caseKeys := map[string]bool{}
	for _, c := range b.Cases {
		if caseKeys[docKey(c)] {
			return nil, fmt.Errorf("duplicate case %s", docKey(c))
		}
		caseKeys[docKey(c)] = true
		if err := validateCase(c); err != nil {
			return nil, err
		}
		cases[str(c["id"])+":"+str(field(c, "digests", "task"))] = c
		if field(c, "task", "environment", "kind") == "unavailable" {
			result.Warnings = append(result.Warnings, Notice{"environment_unavailable", docKey(c), "environment cannot be restored; tool execution is unavailable"})
		}
	}
	// Verify all blob references, including rejected evaluator input, before accepting any data.
	seenBlobs := map[string]any{}
	total := src.bytes
	for _, ref := range blobRefs(b) {
		hex := str(ref["sha256"])
		if size, ok := seenBlobs[hex]; ok {
			if size != ref["bytes"] {
				return nil, fmt.Errorf("conflicting blob sizes for %s", hex)
			}
			continue
		}
		seenBlobs[hex] = ref["bytes"]
		root := findBlobRoot(roots, hex)
		n, err := verifyBlob(ctx, root, ref, "")
		if err != nil {
			return nil, err
		}
		total += n
		if total > MaxBundleBytes {
			return nil, fmt.Errorf("bundle exceeds 4 GiB")
		}
	}
	blobText := func(ref Document) (string, error) {
		data, err := readLimited(blobPath(findBlobRoot(roots, str(ref["sha256"])), str(ref["sha256"])), MaxBlobBytes)
		return string(data), err
	}
	rejected := map[string]bool{}
	noticeFor := func(key string) func(string, string) {
		return func(code, msg string) { result.Warnings = append(result.Warnings, Notice{code, key, msg}) }
	}
	for _, c := range b.Cases {
		if s := object(c["scoring"]); s != nil {
			reject, err := validateScoring(c, s, noticeFor(docKey(c)), blobText)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", docKey(c), err)
			}
			if reject {
				rejected[docKey(c)+":inline"] = true
				result.RejectedScorings = append(result.RejectedScorings, Notice{"horizon_conflict", docKey(c), "inline scoring requires an episode environment"})
				delete(c, "scoring")
				delete(object(c["digests"]), "scoring")
			}
		}
	}
	scoreKeys := map[string]bool{}
	accepted := []Document{}
	for _, s := range b.Scorings {
		key := docKey(s)
		if scoreKeys[key] {
			return nil, fmt.Errorf("duplicate scoring %s", key)
		}
		scoreKeys[key] = true
		got, err := scoringDigest(s)
		if err != nil {
			return nil, err
		}
		if got != str(field(s, "digests", "scoring")) {
			return nil, fmt.Errorf("%s: scoring digest mismatch", key)
		}
		c := cases[str(field(s, "target", "case_id"))+":"+str(field(s, "target", "task_digest"))]
		code, msg := "target_mismatch", "scoring target does not match an imported case version"
		reject := c == nil
		if !reject {
			reject, err = validateScoring(c, s, noticeFor(key), blobText)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
			code, msg = "horizon_conflict", "scoring requires an episode environment"
		}
		if reject {
			rejected[key] = true
			result.RejectedScorings = append(result.RejectedScorings, Notice{code, key, msg})
		} else {
			accepted = append(accepted, s)
		}
	}
	b.Scorings = accepted
	if b.Dataset == nil {
		b.Dataset = generateDataset(b)
	} else {
		changed := false
		for _, entry := range array(b.Dataset["entries"]) {
			refs := []any{}
			for _, ref := range array(field(entry, "scoring")) {
				key := docKey(ref)
				if field(ref, "id") == nil {
					key = docKey(field(entry, "case")) + ":inline"
				}
				if rejected[key] {
					changed = true
					continue
				}
				refs = append(refs, ref)
			}
			object(entry)["scoring"] = refs
		}
		if changed {
			d, _ := datasetDigest(b.Dataset)
			object(b.Dataset["digests"])["dataset"] = d
			result.Warnings = append(result.Warnings, Notice{"dataset_derived", docKey(b.Dataset), "rejected scoring references removed; effective dataset has a new digest"})
		}
	}
	if err := validateDocument(b.Dataset); err != nil {
		return nil, fmt.Errorf("effective dataset: %w", err)
	}
	if err := validateReferences(b); err != nil {
		return nil, err
	}
	if err := validationConflicts(ctx, b, opts.Store, result); err != nil {
		return nil, err
	}
	confirmed := opts.ConfirmValidationConflicts
	// Persist conflicting imports for inspection; Load requires confirmation
	// before those snapshots can run.
	path, sum, err := save(ctx, snapshot{b, confirmed}, opts.Store, roots)
	if err != nil {
		return nil, err
	}
	result.Path, result.Snapshot, result.Cases = path, sum, len(b.Cases)
	result.DatasetDigest = str(field(b.Dataset, "digests", "dataset"))
	return result, nil
}

func findBlobRoot(roots []string, hex string) string {
	for _, root := range roots {
		if _, err := os.Lstat(blobPath(root, hex)); err == nil {
			return root
		}
	}
	return roots[0]
}

func generateDataset(b Bundle) Document {
	entries := []any{}
	purpose := "validation"
	for _, c := range b.Cases {
		if field(c, "provenance", "purpose") == "improvement" {
			purpose = "improvement"
		}
		refs := []any{}
		if d := field(c, "digests", "scoring"); d != nil {
			refs = append(refs, Document{"digest": d})
		}
		for _, s := range b.Scorings {
			if field(s, "target", "case_id") == c["id"] && field(s, "target", "task_digest") == field(c, "digests", "task") {
				refs = append(refs, Document{"id": s["id"], "revision": s["revision"], "digest": field(s, "digests", "scoring")})
			}
		}
		entries = append(entries, Document{"case": Document{"id": c["id"], "revision": c["revision"], "task_digest": field(c, "digests", "task")}, "scoring": refs})
	}
	d := Document{"schema": "detroit.dataset/v2", "id": "detroit:import", "revision": float64(1), "name": "Imported dataset", "purpose": purpose, "entries": entries}
	sum, _ := datasetDigest(d)
	d["digests"] = Document{"dataset": sum}
	return d
}

func validationConflicts(ctx context.Context, b Bundle, store string, result *ImportResult) error {
	if b.Dataset["purpose"] != "validation" {
		return nil
	}
	groups := map[string]bool{}
	improvementGroups := map[string]bool{}
	for _, c := range b.Cases {
		g := str(field(c, "provenance", "source", "group_key"))
		if field(c, "provenance", "purpose") == "improvement" && g != "" {
			improvementGroups[g] = true
		}
	}
	if store == "" {
		store = ".detroit/datasets"
	}
	paths, err := os.ReadDir(store)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, p := range paths {
		if !p.IsDir() || len(p.Name()) != 64 {
			continue
		}
		old, err := Open(ctx, filepath.Join(store, p.Name()), "")
		if err != nil {
			return fmt.Errorf("inspect existing dataset: %w", err)
		}
		active := map[string]bool{}
		for _, e := range array(old.Dataset["entries"]) {
			active[docKey(field(e, "case"))] = true
		}
		for _, c := range old.Cases {
			if active[docKey(c)] && (old.Dataset["purpose"] == "improvement" || field(c, "provenance", "purpose") == "improvement") {
				g := str(field(c, "provenance", "source", "group_key"))
				if g != "" {
					improvementGroups[g] = true
				}
			}
		}
	}
	selected := map[string]bool{}
	for _, e := range array(b.Dataset["entries"]) {
		selected[docKey(field(e, "case"))] = true
	}
	for _, c := range b.Cases {
		if !selected[docKey(c)] {
			continue
		}
		g := str(field(c, "provenance", "source", "group_key"))
		if field(c, "provenance", "purpose") == "improvement" {
			result.ValidationConflicts = append(result.ValidationConflicts, Notice{"improvement_source", docKey(c), "validation dataset contains an improvement case"})
		}
		if g != "" && improvementGroups[g] && !groups[g] {
			groups[g] = true
			result.ValidationConflicts = append(result.ValidationConflicts, Notice{"shared_group", docKey(c), "validation dataset shares improvement group " + g})
		}
	}
	return nil
}

func jsonBytes(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
