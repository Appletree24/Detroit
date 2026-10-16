package agent_test

import (
	"context"
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

	subjectv1 "github.com/Appletree24/Detroit/gen/detroit/subject/v1"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/dataset"
	"github.com/Appletree24/Detroit/internal/scheduler"
	"github.com/Appletree24/Detroit/internal/workerkit"
	"github.com/Appletree24/Detroit/subjects/openaicompat"
	"github.com/Appletree24/Detroit/workers/agent"
	"google.golang.org/grpc"
)

func newJob(t *testing.T, handler http.HandlerFunc, selectScoring string) (*agent.Executor, workerkit.Job) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	adapter, err := openaicompat.New(openaicompat.Config{BaseURL: upstream.URL + "/v1", Model: "test-model", Digest: "test@1", APIKey: "test-secret"})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	subjectv1.RegisterSubjectServer(server, adapter)
	go server.Serve(listener)
	t.Cleanup(func() { server.Stop(); listener.Close() })
	imported, err := dataset.Import(context.Background(), "../../examples/datasets/v2/casepick-inline", dataset.Options{Store: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := core.ParseRunSpec([]byte("name: model-test\nsubject: {adapter: openai-compatible, endpoint: " + listener.Addr().String() + ", digest: test@1, params: {temperature: 0.2, send_seed: true}}\ntaskset: {vertical: agent, source: detroit-v2}\nscorers: {select: " + selectScoring + "}\n"))
	if err != nil {
		t.Fatal(err)
	}
	spec.TaskSet.Options = map[string]any{"path": imported.Path, "snapshot": imported.Snapshot}
	plan, err := scheduler.Plan(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	return &agent.Executor{Artifacts: t.TempDir(), SubjectTimeout: time.Second}, workerkit.Job{Spec: *spec, Episode: plan.Episodes[0]}
}

func respond(w http.ResponseWriter, message any) {
	_ = json.NewEncoder(w).Encode(map[string]any{"id": "completion-1", "model": "provider-version-1", "choices": []any{map[string]any{"message": message, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 12, "completion_tokens": 3}})
}

func TestRealHTTPAndGRPCEvaluationArtifacts(t *testing.T) {
	var calls atomic.Int64
	exec, job := newJob(t, func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("missing authentication")
		}
		if strings.Contains(string(body), "好的，以下是整理结果") || strings.Contains(string(body), "requirements") || strings.Contains(string(body), "diagnostic") {
			t.Error("evaluator data leaked into prompt")
		}
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		if request["model"] != "test-model" || request["temperature"] != 0.2 || request["seed"] != float64(jobSeed()) {
			t.Errorf("request: %+v", request)
		}
		content := `{"上海":2,"北京":1}`
		if call > 1 {
			content = "not JSON"
		}
		respond(w, map[string]any{"role": "assistant", "content": content})
	}, "default")
	result, err := exec.Execute(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != core.OutcomeSuccess || result.Status != core.StatusDone || result.Cost.InputTokens != 12 || result.Cost.OutputTokens != 3 || result.Steps != 1 {
		t.Fatalf("%+v", result)
	}
	for _, name := range []string{"episode.json", "subject.json", "request.json", "response.json", "output.json", "response_metadata.json", "scoring.json", "trajectory.jsonl", "result.json", "attempts.json"} {
		data, err := os.ReadFile(filepath.Join(result.Artifacts, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "test-secret") {
			t.Fatalf("API key in %s", name)
		}
	}
	before, err := os.ReadFile(filepath.Join(result.Artifacts, "output.json"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := exec.Execute(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	if again.Outcome != core.OutcomeFailure || again.Artifacts == result.Artifacts || calls.Load() != 2 {
		t.Fatalf("%+v calls=%d", again, calls.Load())
	}
	after, err := os.ReadFile(filepath.Join(result.Artifacts, "output.json"))
	if err != nil || string(before) != string(after) {
		t.Fatal("retry overwrote previous artifacts")
	}
}
func jobSeed() int64 { return 0 }

func TestTimeoutRetriesOnlyOnce(t *testing.T) {
	var calls atomic.Int64
	exec, job := newJob(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Add(1) == 1 {
			<-r.Context().Done()
			return
		}
		respond(w, map[string]any{"role": "assistant", "content": "{}"})
	}, "default")
	exec.SubjectTimeout = 150 * time.Millisecond
	result, err := exec.Execute(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != core.OutcomeSuccess || calls.Load() != 2 || result.Cost.Inferences != 2 {
		t.Fatalf("%+v calls=%d", result, calls.Load())
	}
	var attempts []map[string]any
	raw, _ := os.ReadFile(filepath.Join(result.Artifacts, "attempts.json"))
	_ = json.Unmarshal(raw, &attempts)
	if len(attempts) != 2 || attempts[0]["error"] == nil {
		t.Fatalf("%s", raw)
	}
}

func TestErrorsUnknownAndMalformedActions(t *testing.T) {
	for _, tt := range []struct {
		name, selection string
		httpStatus      int
		message         any
		outcome         core.Outcome
		kind            string
	}{
		{"rubric stays unknown", "lenient", 200, map[string]any{"role": "assistant", "content": "{}"}, core.OutcomeUnknown, ""},
		{"invalid tool arguments", "default", 200, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "c", "type": "function", "function": map[string]any{"name": "read", "arguments": "not JSON"}}}}, core.OutcomeFailure, ""},
		{"authentication error", "default", 401, nil, "", "subject_error"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var calls atomic.Int64
			exec, job := newJob(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tt.httpStatus)
				if tt.httpStatus == 200 {
					respond(w, tt.message)
				}
			}, tt.selection)
			result, err := exec.Execute(context.Background(), job)
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != tt.outcome || result.ErrorKind != tt.kind || calls.Load() != 1 {
				t.Fatalf("%+v calls=%d", result, calls.Load())
			}
			if tt.kind != "" && (result.Status != core.StatusInfraError || result.Artifacts == "") {
				t.Fatalf("lost infrastructure error artifacts: %+v", result)
			}
		})
	}
}

func TestUnsupportedRunsFailBeforeModelCalls(t *testing.T) {
	var calls atomic.Int64
	_, job := newJob(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }, "default")
	job.Spec.Scorers.Select = "all"
	if _, err := scheduler.Plan(context.Background(), &job.Spec); err == nil {
		t.Fatal("accepted ambiguous multiple scorings")
	}
	job.Spec.Scorers.Select = "default"
	job.Spec.TaskSet.Variants = []string{"tool_fault"}
	if _, err := scheduler.Plan(context.Background(), &job.Spec); err == nil {
		t.Fatal("accepted unsupported variant")
	}
	if calls.Load() != 0 {
		t.Fatal("unsupported run called the model")
	}
	mock := &workerkit.Mock{SuccessRate: 1}
	if _, err := mock.Execute(context.Background(), job); err == nil {
		t.Fatal("mock produced a real-model result")
	}
}
