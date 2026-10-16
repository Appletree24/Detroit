package openaicompat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	subjectv1 "github.com/Appletree24/Detroit/gen/detroit/subject/v1"
	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/vmihailenco/msgpack/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func observation(t *testing.T, params map[string]any) []byte {
	t.Helper()
	b, err := msgpack.Marshal(agentio.Observation{Messages: []map[string]any{{"role": "user", "content": "hi"}}, Params: params, Seed: 42})
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestAdapterMapsRequestAndPreservesResponse(t *testing.T) {
	raw := `{"id":"r1","model":"actual-version","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2},"system_fingerprint":"fp-test"}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("wrong HTTP request")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != "test-model" || body["seed"] != float64(42) || body["temperature"] != 0.2 || body["n"] != float64(1) || body["stream"] != false {
			t.Errorf("request: %+v", body)
		}
		if _, ok := body["send_seed"]; ok {
			t.Error("adapter-only parameter sent upstream")
		}
		w.Header().Set("x-request-id", "req-1")
		_, _ = w.Write([]byte(raw))
	}))
	defer upstream.Close()
	adapter, err := New(Config{BaseURL: upstream.URL + "/v1", Model: "test-model", Digest: "test@1", APIKey: "test-secret"})
	if err != nil {
		t.Fatal(err)
	}
	res, err := adapter.Act(context.Background(), &subjectv1.ActReq{Observation: observation(t, map[string]any{"temperature": 0.2, "send_seed": true})})
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Actions) != raw || res.Debug["request_id"] != "req-1" || strings.Contains(string(res.Actions), "test-secret") {
		t.Fatalf("%+v", res)
	}
	info, _ := adapter.Describe(context.Background(), &subjectv1.Empty{})
	if info.Digest != "test@1" || info.Stateful || info.Name != "test-model" {
		t.Fatalf("%+v", info)
	}
}

func TestAdapterErrorAndCancellation(t *testing.T) {
	for _, tt := range []struct {
		name string
		code int
		body string
		want codes.Code
	}{{"auth", 401, `{"error":{"message":"test-secret"}}`, codes.Unavailable}, {"invalid envelope", 200, `{"choices":[]}`, codes.DataLoss}, {"malformed action is preserved", 200, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"function":{"arguments":"invalid"}}]}}]}`, codes.OK}} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tt.code); _, _ = w.Write([]byte(tt.body)) }))
			defer server.Close()
			adapter, err := New(Config{BaseURL: server.URL, Model: "m", Digest: "d"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = adapter.Act(context.Background(), &subjectv1.ActReq{Observation: observation(t, nil)})
			if status.Code(err) != tt.want {
				t.Fatalf("%v", err)
			}
			if err != nil && strings.Contains(err.Error(), "test-secret") {
				t.Fatal("provider error body leaked")
			}
		})
	}
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
		close(stopped)
	}))
	defer server.Close()
	adapter, _ := New(Config{BaseURL: server.URL, Model: "m", Digest: "d"})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := adapter.Act(ctx, &subjectv1.ActReq{Observation: observation(t, nil)})
	if status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("%v", err)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("HTTP request outlived cancellation")
	}
}
