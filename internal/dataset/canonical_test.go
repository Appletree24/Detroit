package dataset

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalRFC8785(t *testing.T) {
	tests := []struct{ input, want string }{
		{`{"numbers":[333333333.33333329,1E30,4.50,2e-3,1e-27,-0],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`, `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\u000f\nA'B\"\\\\\"/"}`},
		{`{"\ufffd":1,"\ud83d\ude00":2,"\r":3,"1":4,"\u0080":5,"ö":6,"€":7}`, "{\"\\r\":3,\"1\":4,\"\u0080\":5,\"ö\":6,\"€\":7,\"😀\":2,\"�\":1}"},
		{`["\u2028","\u2029","<>&","\\u2028"]`, "[\"\u2028\",\"\u2029\",\"<>&\",\"\\\\u2028\"]"},
	}
	for _, tt := range tests {
		v, err := decodeJSON([]byte(tt.input))
		if err != nil {
			t.Fatal(err)
		}
		b, err := canonical(v)
		if err != nil || string(b) != tt.want {
			t.Fatalf("canonical(%s) = %s (%v), want %s", tt.input, b, err, tt.want)
		}
	}
	if _, err := canonical(math.Inf(1)); err == nil {
		t.Fatal("accepted infinity")
	}
}

func TestStrictJSON(t *testing.T) {
	for _, s := range []string{`{"a":1,"a":2}`, `{"a":1,"\u0061":2}`, `"\ud800"`, `"\udfff"`, `"\ud800\u0041"`, `{} {}`, `[1,]`, "\"\xff\"", `1e999`} {
		if _, err := decodeJSON([]byte(s)); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
	if _, err := decodeJSON([]byte(`"\ud83d\ude00"`)); err != nil {
		t.Fatal(err)
	}
}

func TestExampleProtocolDigests(t *testing.T) {
	paths, err := filepath.Glob("../../examples/datasets/v2/*/*.json*")
	if err != nil {
		t.Fatal(err)
	}
	nested, err := filepath.Glob("../../examples/datasets/v2/*/*/*.json")
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, nested...)
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		docs := [][]byte{data}
		if strings.HasSuffix(path, ".jsonl") {
			docs = nil
			for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				docs = append(docs, []byte(line))
			}
		}
		for _, data := range docs {
			v, err := decodeJSON(data)
			if err != nil {
				t.Fatal(err)
			}
			var got, want string
			switch field(v, "schema") {
			case "detroit.case/v2":
				got, err = digest(field(v, "task"))
				want = str(field(v, "digests", "task"))
				if field(v, "scoring") != nil {
					score, e := scoringDigest(field(v, "scoring"))
					if e != nil || score != field(v, "digests", "scoring") {
						t.Fatalf("%s inline scoring digest: %s (%v)", path, score, e)
					}
				}
			case "detroit.scoring/v2":
				got, err = scoringDigest(v)
				want = str(field(v, "digests", "scoring"))
			case "detroit.dataset/v2":
				got, err = digest(map[string]any{"entries": field(v, "entries"), "purpose": field(v, "purpose")})
				want = str(field(v, "digests", "dataset"))
			}
			if err != nil || got != want {
				t.Fatalf("%s: digest=%s want %s (%v)", path, got, want, err)
			}
		}
	}
}
