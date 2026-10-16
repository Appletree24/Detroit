package dataset

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const inlineExample = "../../examples/datasets/v2/casepick-inline"
const bundleExample = "../../examples/datasets/v2/swe-bench-bundle"

func fixture(t *testing.T, path string) Bundle {
	t.Helper()
	s, err := readSource(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return s.bundle
}
func writeDoc(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
func writeBundle(t *testing.T, b Bundle) string {
	t.Helper()
	dir := t.TempDir()
	if b.Dataset != nil {
		writeDoc(t, filepath.Join(dir, "dataset.json"), b.Dataset)
	}
	for i, c := range b.Cases {
		writeDoc(t, filepath.Join(dir, "cases", string(rune('a'+i))+".json"), c)
	}
	for i, s := range b.Scorings {
		writeDoc(t, filepath.Join(dir, "scorings", string(rune('a'+i))+".json"), s)
	}
	return dir
}
func rehash(t *testing.T, b *Bundle) {
	t.Helper()
	for _, c := range b.Cases {
		d, err := digest(c["task"])
		if err != nil {
			t.Fatal(err)
		}
		object(c["digests"])["task"] = d
		if c["scoring"] != nil {
			d, _ = scoringDigest(c["scoring"])
			object(c["digests"])["scoring"] = d
		}
	}
	for _, s := range b.Scorings {
		d, _ := scoringDigest(s)
		object(s["digests"])["scoring"] = d
	}
	if b.Dataset != nil {
		d, _ := datasetDigest(b.Dataset)
		object(b.Dataset["digests"])["dataset"] = d
	}
}
func imported(t *testing.T, b Bundle) (*ImportResult, error) {
	t.Helper()
	return Import(context.Background(), writeBundle(t, b), Options{Store: t.TempDir()})
}

func TestImportExamplesFrozenAndSeparated(t *testing.T) {
	for _, example := range []string{inlineExample, bundleExample} {
		t.Run(filepath.Base(example), func(t *testing.T) {
			store := t.TempDir()
			ctx := context.Background()
			r, err := Import(ctx, example, Options{Store: store})
			if err != nil {
				t.Fatal(err)
			}
			if r.Cases != 1 || len(r.RejectedScorings) != 0 {
				t.Fatalf("%+v", r)
			}
			again, err := Import(ctx, example, Options{Store: store})
			if err != nil || r.Path != again.Path || r.Snapshot != again.Snapshot {
				t.Fatalf("unstable reimport: %+v %v", again, err)
			}
			b, err := Open(ctx, r.Path, r.Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			original := fixture(t, example)
			if field(original.Cases[0], "digests", "task") != field(b.Cases[0], "digests", "task") {
				t.Fatal("task digest changed")
			}
			entries, err := Load(ctx, r.Path, r.Snapshot, "all")
			if err != nil {
				t.Fatal(err)
			}
			var input Document
			if err = json.Unmarshal(entries[0].Input, &input); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"scoring", "diagnostic", "provenance"} {
				if input[key] != nil {
					t.Fatalf("leaked %s", key)
				}
			}
			if len(entries[0].Scorings) == 0 {
				t.Fatal("scoring lost")
			}
			data, err := os.ReadFile(filepath.Join(r.Path, "snapshot.json"))
			if err != nil {
				t.Fatal(err)
			}
			data = append([]byte(nil), data...)
			data = []byte(strings.Replace(string(data), `"title":`, `"changed":`, 1))
			if err = os.WriteFile(filepath.Join(r.Path, "snapshot.json"), data, 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err = Load(ctx, r.Path, r.Snapshot, "all"); err == nil {
				t.Fatal("accepted modified snapshot")
			}
		})
	}
}

func TestImportRejectsBadData(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Bundle)
	}{
		{"unknown field", func(b *Bundle) { object(field(b.Cases[0], "task"))["secret"] = true }},
		{"nested unknown field", func(b *Bundle) { object(field(b.Cases[0], "scoring", "combine"))["typo"] = true }},
		{"task digest", func(b *Bundle) { object(field(b.Cases[0], "task"))["instruction"] = "changed" }},
		{"scoring digest", func(b *Bundle) { object(field(b.Cases[0], "scoring", "combine"))["threshold"] = 0.5 }},
		{"source quote", func(b *Bundle) {
			object(field(array(field(b.Cases[0], "scoring", "requirements"))[0], "source"))["quote"] = "not in source"
			rehash(t, b)
		}},
		{"source index overflow", func(b *Bundle) {
			object(field(array(field(b.Cases[0], "scoring", "requirements"))[0], "source"))["message"] = 1e30
			rehash(t, b)
		}},
		{"observed example", func(b *Bundle) {
			object(array(field(array(field(b.Cases[0], "scoring", "requirements"))[0], "rubric", "examples"))[0])["text"] = "invented"
			rehash(t, b)
		}},
		{"tool pairing", func(b *Bundle) {
			object(array(field(b.Cases[0], "task", "messages"))[2])["tool_call_id"] = "wrong"
			rehash(t, b)
		}},
		{"assistant last", func(b *Bundle) {
			task := object(b.Cases[0]["task"])
			task["messages"] = append(array(task["messages"]), Document{"role": "assistant", "content": "done"})
			rehash(t, b)
		}},
		{"missing case", func(b *Bundle) {
			object(field(array(b.Dataset["entries"])[0], "case"))["revision"] = float64(99)
			rehash(t, b)
		}},
		{"missing scoring", func(b *Bundle) {
			object(array(field(array(b.Dataset["entries"])[0], "scoring"))[1])["revision"] = float64(99)
			rehash(t, b)
		}},
		{"duplicate case", func(b *Bundle) { b.Cases = append(b.Cases, b.Cases[0]) }},
		{"max_steps overflow", func(b *Bundle) {
			b.Cases[0]["task"] = Document{"kind": "agent", "horizon": "episode", "start": "original", "instruction": "task", "max_steps": 1e30}
			delete(b.Cases[0], "scoring")
			delete(object(b.Cases[0]["digests"]), "scoring")
			rehash(t, b)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := fixture(t, inlineExample)
			tt.mutate(&b)
			if _, err := imported(t, b); err == nil {
				t.Fatal("accepted invalid input")
			}
		})
	}
}

func TestScoringRejectionPreservesCase(t *testing.T) {
	for _, typ := range []string{"target", "horizon"} {
		t.Run(typ, func(t *testing.T) {
			b := fixture(t, inlineExample)
			if typ == "target" {
				object(b.Scorings[0]["target"])["task_digest"] = "sha256:" + strings.Repeat("0", 64)
			} else {
				object(array(b.Scorings[0]["requirements"])[0])["checks"] = []any{Document{"type": "command", "run": "exit 0"}}
			}
			rehash(t, &b)
			r, err := imported(t, b)
			if err != nil {
				t.Fatal(err)
			}
			if r.Cases != 1 || len(r.RejectedScorings) != 1 {
				t.Fatalf("%+v", r)
			}
			entries, err := Load(context.Background(), r.Path, r.Snapshot, "all")
			if err != nil || len(entries[0].Scorings) != 1 {
				t.Fatalf("%+v %v", entries, err)
			}
		})
	}
}

func TestUnknownChecksUnscoredAndIndependentScoring(t *testing.T) {
	b := fixture(t, inlineExample)
	b.Dataset = nil
	b.Scorings = nil
	object(array(field(b.Cases[0], "scoring", "requirements"))[0])["checks"] = []any{Document{"type": "future_check", "arbitrary": true}}
	rehash(t, &b)
	r, err := imported(t, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Warnings) != 1 || r.Warnings[0].Code != "unknown_check" {
		t.Fatalf("%+v", r)
	}
	b = fixture(t, inlineExample)
	b.Dataset = nil
	b.Scorings = nil
	delete(b.Cases[0], "scoring")
	delete(object(b.Cases[0]["digests"]), "scoring")
	r, err = imported(t, b)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := Load(context.Background(), r.Path, r.Snapshot, "all")
	if err != nil || len(entries[0].Scorings) != 0 {
		t.Fatalf("%+v %v", entries, err)
	}
	score := fixture(t, inlineExample).Scorings[0]
	file := filepath.Join(t.TempDir(), "scoring.json")
	writeDoc(t, file, score)
	updated, err := Import(context.Background(), file, Options{Store: t.TempDir(), Base: r.Path})
	if err != nil {
		t.Fatal(err)
	}
	entries, err = Load(context.Background(), updated.Path, updated.Snapshot, "lenient")
	if err != nil || len(entries[0].Scorings) != 1 {
		t.Fatalf("%+v %v", entries, err)
	}
	if _, err = Load(context.Background(), updated.Path, updated.Snapshot, "absent"); err == nil {
		t.Fatal("accepted absent label")
	}
}

func TestBlobsAndEvidence(t *testing.T) {
	b := fixture(t, inlineExample)
	b.Dataset = nil
	b.Scorings = nil
	content := []byte("blob source quote")
	sum := sha256.Sum256(content)
	hexDigest := hex.EncodeToString(sum[:])
	ref := Document{"sha256": hexDigest, "bytes": float64(len(content))}
	object(b.Cases[0]["task"])["materials"] = []any{Document{"path": "readme.txt", "blob": ref}}
	object(array(field(b.Cases[0], "scoring", "requirements"))[0])["source"] = Document{"material": "readme.txt", "quote": "source quote"}
	rehash(t, &b)
	dir := writeBundle(t, b)
	blob := blobPath(dir, hexDigest)
	if err := os.MkdirAll(filepath.Dir(blob), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blob, content, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := Import(context.Background(), dir, Options{Store: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(blob, []byte("broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(context.Background(), r.Path, r.Snapshot, "all"); err != nil {
		t.Fatal("source mutation affected frozen data:", err)
	}
	if _, err = Import(context.Background(), dir, Options{Store: t.TempDir()}); err == nil {
		t.Fatal("accepted corrupt blob")
	}
	if err = os.WriteFile(blobPath(r.Path, hexDigest), []byte("broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(context.Background(), r.Path, r.Snapshot, "all"); err == nil {
		t.Fatal("accepted corrupt snapshot blob")
	}
}

func TestValidationConflictsRequireConfirmation(t *testing.T) {
	ctx := context.Background()
	store := t.TempDir()
	base := fixture(t, inlineExample)
	if _, err := Import(ctx, writeBundle(t, base), Options{Store: store}); err != nil {
		t.Fatal(err)
	}
	b := fixture(t, inlineExample)
	b.Dataset["purpose"] = "validation"
	object(b.Cases[0]["provenance"])["purpose"] = "validation"
	rehash(t, &b)
	dir := writeBundle(t, b)
	r, err := Import(ctx, dir, Options{Store: store})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.ValidationConflicts) != 1 {
		t.Fatalf("%+v", r)
	}
	if _, err = Load(ctx, r.Path, r.Snapshot, "all"); err == nil {
		t.Fatal("ran without confirmation")
	}
	confirmed, err := Import(ctx, dir, Options{Store: store, ConfirmValidationConflicts: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Load(ctx, confirmed.Path, confirmed.Snapshot, "all"); err != nil {
		t.Fatal(err)
	}
}
