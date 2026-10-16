// Package api 是控制面的 API Server（docs/02 §3.1）：接收 RunSpec、查询进度、取消 run。
//
//	POST /v1/runs               body 为 RunSpec（YAML 或 JSON），返回 SubmitResult
//	GET  /v1/runs               列出 run
//	GET  /v1/runs/{id}          进度与结果汇总
//	POST /v1/runs/{id}/cancel   取消
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/scheduler"
	"github.com/Appletree24/Detroit/internal/scoring"
	"github.com/Appletree24/Detroit/internal/store"
	"github.com/Appletree24/Detroit/internal/version"
)

const maxSpecBytes = 1 << 20

// Manifest 锁定一次 run 的配置（docs/07 §5.1）。硬件信息由 Worker 侧采集，尚未写入。
type Manifest struct {
	DeterministicScorer string          `json:"deterministic_scorer,omitempty"`
	DetroitVersion      string          `json:"detroit_version"`
	Subject             core.SubjectRef `json:"subject"`
	Env                 ManifestEnv     `json:"env"`
	TaskSetHash         string          `json:"taskset_hash"`
	Seeds               []int64         `json:"seeds"`
	Scorers             []string        `json:"scorers"`
	SpecHash            string          `json:"spec_hash"`
}

type ManifestEnv struct {
	Vertical string `json:"vertical"`
	Source   string `json:"source"`
	Digest   string `json:"digest,omitempty"`
}

type Server struct {
	store *store.Store
	now   func() time.Time
}

func New(st *store.Store, now func() time.Time) *Server {
	if now == nil {
		now = time.Now
	}
	return &Server{store: st, now: now}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runs", s.submit)
	mux.HandleFunc("GET /v1/runs", s.list)
	mux.HandleFunc("GET /v1/runs/{id}", s.get)
	mux.HandleFunc("GET /v1/runs/{id}/results", s.results)
	mux.HandleFunc("POST /v1/runs/{id}/cancel", s.cancel)
	return mux
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxSpecBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(body) > maxSpecBytes {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("runspec exceeds 1 MiB"))
		return
	}
	spec, err := core.ParseRunSpec(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	plan, err := scheduler.Plan(r.Context(), spec)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	manifest := Manifest{
		DetroitVersion: version.String(),
		Subject:        spec.Subject,
		Env:            ManifestEnv{Vertical: spec.TaskSet.Vertical, Source: spec.TaskSet.Source, Digest: spec.TaskSet.EnvDigest},
		TaskSetHash:    plan.TaskSetHash,
		Seeds:          spec.TaskSet.Seeds,
		Scorers:        spec.Scorers.Offline,
		SpecHash:       spec.Hash(),
	}
	if spec.Subject.Adapter == "openai-compatible" {
		manifest.DeterministicScorer = scoring.Version
	}
	res, err := s.store.Submit(r.Context(), spec, body, manifest, plan.Episodes, s.now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	slog.Info("run submitted", "run", res.RunID, "existing", res.Existing, "added", res.Added, "total", res.Total)
	code := http.StatusCreated
	if res.Existing {
		code = http.StatusOK
	}
	writeJSON(w, code, res)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	runs, err := s.store.ListRuns(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	sum, err := s.store.Summary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	status, err := s.store.Cancel(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"run_id": r.PathValue("id"), "status": status})
}

func statusOf(err error) int {
	if errors.Is(err, store.ErrNotFound) {
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func (s *Server) results(w http.ResponseWriter, r *http.Request) {
	records, err := s.store.Results(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, statusOf(err), err)
		return
	}
	writeJSON(w, http.StatusOK, records)
}
