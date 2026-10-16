package e2e

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Appletree24/Detroit/internal/store"
)

// This runs the actual CLI/controller/Subject/Worker processes against a local
// HTTP test provider. Its scores validate integration, not a model's ability.
func TestModelDatasetEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("builds binaries and runs real processes")
	}
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if r.URL.Path != "/v1/chat/completions" || r.Method != "POST" {
			t.Error("wrong completion URL/method")
		}
		if strings.Contains(string(body), "好的，以下是整理结果") || strings.Contains(string(body), "requirements") {
			t.Error("diagnostic/scoring information reached model")
		}
		var request map[string]any
		if err = json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		if request["model"] != "test-model" || request["temperature"] != 0.2 {
			t.Errorf("request: %+v", request)
		}
		output := `{"上海":2,"北京":1}`
		if n%3 == 0 {
			output = "not JSON"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "e2e-response", "model": "provider-version-1", "choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": output}, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 5}})
	}))
	defer upstream.Close()
	dir := t.TempDir()
	controllerBin, cliBin := build(t, dir)
	grpcAddr, httpAddr, subjectAddr := freePort(t), freePort(t), freePort(t)
	_ = spawn(t, controllerBin, "-db", filepath.Join(dir, "detroit.db"), "-grpc", grpcAddr, "-http", httpAddr)
	waitFor(t, 10*time.Second, "controller", func() bool {
		conn, err := net.Dial("tcp", httpAddr)
		if err == nil {
			conn.Close()
		}
		return err == nil
	})
	_ = spawn(t, cliBin, "subject", "openai-compatible", "--listen", subjectAddr, "--base-url", upstream.URL+"/v1", "--model", "test-model", "--digest", "test@1", "--api-key-env", "")
	waitFor(t, 10*time.Second, "Subject", func() bool {
		conn, err := net.Dial("tcp", subjectAddr)
		if err == nil {
			conn.Close()
		}
		return err == nil
	})
	output := cli(t, cliBin, httpAddr, "dataset", "import", "-f", "../../examples/datasets/v2/casepick-inline", "--store", filepath.Join(dir, "datasets"))
	var imported struct {
		Path     string `json:"path"`
		Snapshot string `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(output), &imported); err != nil {
		t.Fatal(err)
	}
	spec := map[string]any{"name": "model-e2e", "subject": map[string]any{"adapter": "openai-compatible", "endpoint": subjectAddr, "digest": "test@1", "params": map[string]any{"temperature": 0.2}}, "taskset": map[string]any{"vertical": "agent", "source": "detroit-v2", "seeds": []int{0, 1}, "repeats": 3, "options": map[string]any{"path": imported.Path, "snapshot": imported.Snapshot}}, "scorers": map[string]any{"select": "default"}}
	body, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "model.json")
	if err = os.WriteFile(file, body, 0o644); err != nil {
		t.Fatal(err)
	}
	output = cli(t, cliBin, httpAddr, "run", "submit", "-f", file)
	runID := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(output, "submitted "))[0], ":")
	// Both Workers share vertical agent; only the real Worker may lease this run.
	_ = spawn(t, cliBin, "worker", "mock", "--controller", grpcAddr, "--slots", "8", "--success-rate", "1")
	_ = spawn(t, cliBin, "worker", "agent", "--controller", grpcAddr, "--slots", "2", "--artifacts", filepath.Join(dir, "artifacts"))
	waitFor(t, 20*time.Second, "real evaluation", func() bool { s, ok := summary(t, cliBin, httpAddr, runID); return ok && s.Status == store.RunDone })
	summary, ok := summary(t, cliBin, httpAddr, runID)
	if !ok || summary.Overall.N != 6 || summary.Overall.Successes != 4 || calls.Load() != 6 {
		t.Fatalf("summary=%+v calls=%d", summary, calls.Load())
	}
	output = cli(t, cliBin, httpAddr, "run", "results", runID, "--json")
	var records []store.ResultRecord
	if err = json.Unmarshal([]byte(output), &records); err != nil {
		t.Fatal(err)
	}
	if len(records) != 6 {
		t.Fatalf("results: %d", len(records))
	}
	for _, rec := range records {
		if rec.Result.Cost.InputTokens != 20 || rec.Result.Cost.OutputTokens != 5 || rec.Result.Artifacts == "" {
			t.Fatalf("missing real cost/artifacts: %+v", rec)
		}
		for _, name := range []string{"request.json", "response.json", "output.json", "scoring.json", "result.json"} {
			if _, err = os.Stat(filepath.Join(rec.Result.Artifacts, name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if output = cli(t, cliBin, httpAddr, "run", "submit", "-f", file); !strings.HasPrefix(output, "resumed "+runID) {
		t.Fatal(output)
	}
	if calls.Load() != 6 {
		t.Fatalf("resume called the model again: %d", calls.Load())
	}
}
