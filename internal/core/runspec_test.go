package core

import (
	"strings"
	"testing"
)

const docExample = `
name: pi05-libero-spatial-camera
subject:
  adapter: openpi
  endpoint: ws://gpu-0:8000
  digest: pi05_libero@sha256:abc
  params: { replan_steps: 5 }
taskset:
  vertical: embodied
  source: libero
  suites: [libero_spatial]
  variants: [base, camera_shift_15deg]
  init_states: all
  repeats: 1
scorers:
  offline: [vlm_failure_judge@v1]
  select: all
stats:
  confidence: 0.95
  compare_to: run_2026_10_20_baseline
`

func TestParseRunSpecDocExample(t *testing.T) {
	spec, err := ParseRunSpec([]byte(docExample))
	if err != nil {
		t.Fatal(err)
	}
	if !spec.TaskSet.InitStates.All {
		t.Errorf("init_states: want all")
	}
	if got := spec.TaskSet.Seeds; len(got) != 1 || got[0] != 0 {
		t.Errorf("seeds default: got %v", got)
	}
	if spec.Subject.Params["replan_steps"] != 5 {
		t.Errorf("params: got %v", spec.Subject.Params)
	}
	if !strings.HasPrefix(spec.RunID(), "pi05-libero-spatial-camera-") {
		t.Errorf("run id: %s", spec.RunID())
	}
}

func TestParseRunSpecDefaultsAndInitStates(t *testing.T) {
	base := "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: synthetic%s}\n"
	cases := []struct {
		extra string
		check func(InitStateSelector) bool
	}{
		{"", func(s InitStateSelector) bool { return s.All }},
		{", init_states: 3", func(s InitStateSelector) bool { return s.Count == 3 }},
		{", init_states: [a, b]", func(s InitStateSelector) bool { return len(s.IDs) == 2 }},
	}
	for _, c := range cases {
		spec, err := ParseRunSpec([]byte(strings.Replace(base, "%s", c.extra, 1)))
		if err != nil {
			t.Fatalf("%q: %v", c.extra, err)
		}
		if !c.check(spec.TaskSet.InitStates) {
			t.Errorf("%q: got %+v", c.extra, spec.TaskSet.InitStates)
		}
		if spec.TaskSet.Variants[0] != BaseVariant || spec.TaskSet.Repeats != 1 || spec.Scorers.Select != "all" || spec.Stats.Confidence != 0.95 {
			t.Errorf("%q: defaults not applied: %+v", c.extra, spec)
		}
	}
}

func TestParseRunSpecRejects(t *testing.T) {
	cases := map[string]string{
		"unknown field":    "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s}\nbogus: 1\n",
		"missing digest":   "name: x\nsubject: {adapter: a}\ntaskset: {vertical: agent, source: s}\n",
		"bad vertical":     "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: robot, source: s}\n",
		"bad name":         "name: X Y\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s}\n",
		"zero init_states": "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s, init_states: 0}\n",
		"dup variant":      "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s, variants: [base, base]}\n",
		"bad confidence":   "name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s}\nstats: {confidence: 1.5}\n",
	}
	for name, in := range cases {
		if _, err := ParseRunSpec([]byte(in)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestRunIDStableAcrossFormatting(t *testing.T) {
	a, err := ParseRunSpec([]byte("name: x\nsubject: {adapter: a, digest: d}\ntaskset: {vertical: agent, source: s}\n"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseRunSpec([]byte("# comment\nname: x\ntaskset:\n  source: s\n  vertical: agent\n  repeats: 1\nsubject:\n  digest: d\n  adapter: a\n"))
	if err != nil {
		t.Fatal(err)
	}
	if a.RunID() != b.RunID() {
		t.Errorf("equivalent specs got different run ids: %s vs %s", a.RunID(), b.RunID())
	}
	c, _ := ParseRunSpec([]byte("name: x\nsubject: {adapter: a, digest: d2}\ntaskset: {vertical: agent, source: s}\n"))
	if a.RunID() == c.RunID() {
		t.Error("different subject digest must change run id")
	}
}

func TestEpisodeKey(t *testing.T) {
	ep := Episode{RunID: "r", TaskID: "t", VariantID: "base", InitStateID: "0", Seed: 1, RepeatIdx: 0}
	k := EpisodeKey(ep, "sd", "ed")
	if k != EpisodeKey(ep, "sd", "ed") {
		t.Fatal("key not deterministic")
	}
	variants := []Episode{ep, ep, ep, ep}
	variants[0].Seed = 2
	variants[1].RepeatIdx = 1
	variants[2].TaskID = "t2"
	variants[3].InitStateID = "1"
	for i, v := range variants {
		if EpisodeKey(v, "sd", "ed") == k {
			t.Errorf("variant %d: key collision", i)
		}
	}
	if EpisodeKey(ep, "sd2", "ed") == k || EpisodeKey(ep, "sd", "ed2") == k {
		t.Error("digests must affect key")
	}
	// 拼接歧义："a"+"bc" 与 "ab"+"c" 不能相同。
	x := Episode{RunID: "a", TaskID: "bc"}
	y := Episode{RunID: "ab", TaskID: "c"}
	if EpisodeKey(x, "", "") == EpisodeKey(y, "", "") {
		t.Error("ambiguous concatenation")
	}
}

func TestResultValidate(t *testing.T) {
	ok := []EpisodeResult{
		{Key: "k", Status: StatusDone, Outcome: OutcomeSuccess},
		{Key: "k", Status: StatusDone, Outcome: OutcomeUnknown},
		{Key: "k", Status: StatusInfraError, ErrorKind: "sandbox_boot"},
	}
	for _, r := range ok {
		if err := r.Validate(); err != nil {
			t.Errorf("%+v: %v", r, err)
		}
	}
	bad := []EpisodeResult{
		{Key: "k", Status: StatusDone},
		{Key: "k", Status: StatusInfraError},
		{Key: "k", Status: StatusInfraError, ErrorKind: "x", Outcome: OutcomeFailure},
		{Key: "k", Status: StatusDone, Outcome: OutcomeSuccess, ErrorKind: "x"},
		{Key: "k", Status: "weird", Outcome: OutcomeSuccess},
		{Key: "k", Status: StatusDone, Outcome: OutcomeSuccess, Score: OnlineScore{Progress: 2}},
	}
	for _, r := range bad {
		if err := r.Validate(); err == nil {
			t.Errorf("%+v: expected error", r)
		}
	}
}
