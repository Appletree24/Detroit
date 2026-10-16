// Package agent implements the next_message Worker. It never executes tool calls.
package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	subjectv1 "github.com/Appletree24/Detroit/gen/detroit/subject/v1"
	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/scoring"
	"github.com/Appletree24/Detroit/internal/taskset"
	"github.com/Appletree24/Detroit/internal/workerkit"
	"github.com/vmihailenco/msgpack/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

type Executor struct {
	Artifacts      string
	SubjectTimeout time.Duration
}

type attempt struct {
	Number     int    `json:"number"`
	DurationMs int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

func (e *Executor) Execute(ctx context.Context, job workerkit.Job) (core.EpisodeResult, error) {
	started := time.Now()
	if err := job.Spec.Validate(); err != nil {
		return core.EpisodeResult{}, err
	}
	if job.Episode.RunID != job.Spec.RunID() || job.Episode.Key != core.EpisodeKey(job.Episode, job.Spec.Subject.Digest, job.Spec.TaskSet.EnvDigest) {
		return core.EpisodeResult{}, fmt.Errorf("episode does not match its RunSpec")
	}
	entries, err := taskset.LoadRun(ctx, &job.Spec)
	if err != nil {
		return core.EpisodeResult{}, &workerkit.InfraError{Kind: "task_not_found", Err: err}
	}
	if err = agentio.ValidateRun(&job.Spec, entries); err != nil {
		return core.EpisodeResult{}, &workerkit.InfraError{Kind: "unsupported_task", Err: err}
	}
	var entry *core.TaskEntry
	for i := range entries {
		if entries[i].Task.ID == job.Episode.TaskID {
			entry = &entries[i]
			break
		}
	}
	if entry == nil || entry.InitStates[0].ID != job.Episode.InitStateID || job.Episode.VariantID != core.BaseVariant {
		return core.EpisodeResult{}, fmt.Errorf("episode task/initial state/variant mismatch")
	}
	snapshot, _ := job.Spec.TaskSet.Options["path"].(string)
	obs, err := agentio.Prepare(*entry, snapshot, job.Spec.Subject.Params, job.Episode.Seed)
	if err != nil {
		return core.EpisodeResult{}, &workerkit.InfraError{Kind: "task_input", Err: err}
	}
	payload, err := msgpack.Marshal(obs)
	if err != nil {
		return core.EpisodeResult{}, err
	}
	if len(payload) > agentio.MaxPayload {
		return core.EpisodeResult{}, fmt.Errorf("observation exceeds 16 MiB")
	}
	root := e.Artifacts
	if root == "" {
		root = ".detroit/artifacts"
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return core.EpisodeResult{}, err
	}
	parent := filepath.Join(root, job.Episode.RunID, job.Episode.Key)
	if err = os.MkdirAll(parent, 0o700); err != nil {
		return core.EpisodeResult{}, err
	}
	dir, err := os.MkdirTemp(parent, "attempt-")
	if err != nil {
		return core.EpisodeResult{}, err
	}
	res := core.EpisodeResult{Key: job.Episode.Key, Artifacts: dir}
	write := func(name string, v any) error {
		data, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, name), append(data, '\n'), 0o600)
	}
	finish := func(kind string, cause error) (core.EpisodeResult, error) {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		if kind != "" {
			res.Status = core.StatusInfraError
			res.Outcome = ""
			res.ErrorKind = kind
			if err := write("error.json", map[string]string{"kind": kind, "error": cause.Error()}); err != nil {
				return res, err
			}
		}
		res.DurationMs = time.Since(started).Milliseconds()
		if err := write("result.json", res); err != nil {
			return res, err
		}
		return res, nil
	}
	timeout := e.SubjectTimeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	if err = write("episode.json", map[string]any{"episode": job.Episode, "subject": job.Spec.Subject, "scorer_version": scoring.Version, "subject_timeout_ms": timeout.Milliseconds(), "task_digest": entry.Evaluation.TaskDigest, "dataset_digest": entry.Evaluation.DatasetDigest}); err != nil {
		return res, err
	}
	conn, err := grpc.NewClient(job.Spec.Subject.Endpoint, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.MaxCallSendMsgSize(agentio.MaxPayload+1<<20), grpc.MaxCallRecvMsgSize(agentio.MaxPayload+1<<20)))
	if err != nil {
		return finish("subject_connect", err)
	}
	defer conn.Close()
	client := subjectv1.NewSubjectClient(conn)
	describeCtx, cancel := context.WithTimeout(ctx, timeout)
	info, err := client.Describe(describeCtx, &subjectv1.Empty{})
	cancel()
	if err != nil {
		return finish("subject_connect", err)
	}
	if info.GetDigest() != job.Spec.Subject.Digest || info.GetObsSchema() != agentio.ObservationSchema || info.GetActionSchema() != agentio.ActionSchema || info.GetStateful() {
		return finish("subject_mismatch", fmt.Errorf("Subject digest/schema/statefulness differs from the run configuration"))
	}
	if err = write("subject.json", info); err != nil {
		return res, err
	}
	request, err := agentio.Request(obs, info.GetName())
	if err != nil {
		return finish("subject_config", err)
	}
	requestBytes, err := json.Marshal(request)
	if err != nil {
		return res, err
	}
	if len(requestBytes) > agentio.MaxPayload {
		return finish("task_input", fmt.Errorf("model request exceeds 16 MiB"))
	}
	if err = write("request.json", request); err != nil {
		return res, err
	}
	resetCtx, cancel := context.WithTimeout(ctx, timeout)
	_, err = client.Reset(resetCtx, &subjectv1.ResetReq{SessionId: job.Episode.Key, TaskId: job.Episode.TaskID, Seed: job.Episode.Seed})
	cancel()
	if err != nil {
		return finish("subject_reset", err)
	}
	var reply *subjectv1.ActResp
	attempts := []attempt{}
	for i := 1; i <= 2; i++ {
		callStarted := time.Now()
		callCtx, cancel := context.WithTimeout(ctx, timeout)
		reply, err = client.Act(callCtx, &subjectv1.ActReq{SessionId: job.Episode.Key, Observation: payload})
		cancel()
		a := attempt{Number: i, DurationMs: time.Since(callStarted).Milliseconds()}
		if err != nil {
			a.Error = err.Error()
		}
		attempts = append(attempts, a)
		if writeErr := write("attempts.json", attempts); writeErr != nil {
			return res, writeErr
		}
		if err == nil || ctx.Err() != nil || status.Code(err) != codes.DeadlineExceeded {
			break
		}
	}
	res.Cost.Inferences = int64(len(attempts))
	if err != nil {
		kind := "subject_error"
		if status.Code(err) == codes.DeadlineExceeded {
			kind = "subject_timeout"
		}
		return finish(kind, err)
	}
	if !json.Valid(reply.GetActions()) {
		return finish("subject_protocol", fmt.Errorf("Subject returned invalid JSON actions"))
	}
	if err = os.WriteFile(filepath.Join(dir, "response.json"), reply.GetActions(), 0o600); err != nil {
		return res, err
	}
	if err = write("response_metadata.json", reply.GetDebug()); err != nil {
		return res, err
	}
	var completion agentio.Completion
	if err = json.Unmarshal(reply.GetActions(), &completion); err != nil || len(completion.Choices) != 1 {
		return finish("subject_protocol", fmt.Errorf("Subject returned an invalid completion envelope"))
	}
	if completion.Usage != nil {
		if n := completion.Usage.InputTokens; n != nil && *n >= 0 {
			res.Cost.InputTokens = *n
		}
		if n := completion.Usage.OutputTokens; n != nil && *n >= 0 {
			res.Cost.OutputTokens = *n
		}
	}
	res.Status = core.StatusDone
	res.Steps = 1
	if err = os.WriteFile(filepath.Join(dir, "output.json"), completion.Choices[0].Message, 0o600); err != nil {
		return res, err
	}
	obsHash := sha256.Sum256(payload)
	step := core.Step{T: 0, ObsDigest: "sha256:" + hex.EncodeToString(obsHash[:]), Action: completion.Choices[0].Message, LatencyMs: int(time.Since(started).Milliseconds()), Info: map[string]any{"model": completion.Model, "finish_reason": completion.Choices[0].FinishReason, "attempts": len(attempts)}}
	stepBytes, err := json.Marshal(step)
	if err != nil {
		return res, err
	}
	if err = os.WriteFile(filepath.Join(dir, "trajectory.jsonl"), append(stepBytes, '\n'), 0o600); err != nil {
		return res, err
	}
	message, malformed := agentio.ParseMessage(completion.Choices[0].Message)
	if malformed != nil {
		res.Outcome = core.OutcomeFailure
		if err = write("scoring.json", map[string]any{"version": scoring.Version, "outcome": res.Outcome, "reason": "malformed_action"}); err != nil {
			return res, err
		}
		return finish("", nil)
	}
	var definition json.RawMessage
	if len(entry.Evaluation.Scorings) == 1 {
		definition = entry.Evaluation.Scorings[0]
	}
	report, scoreErr := scoring.Evaluate(definition, message)
	if err = write("scoring.json", report); err != nil {
		return res, err
	}
	if scoreErr != nil {
		return finish("scorer_error", scoreErr)
	}
	res.Outcome = report.Outcome
	res.Score = core.OnlineScore{Success: report.Outcome == core.OutcomeSuccess, Progress: report.Progress}
	for _, r := range report.Requirements {
		res.Score.Subgoals = append(res.Score.Subgoals, core.SubgoalStatus{Name: r.ID, Achieved: r.Verdict == scoring.Pass, AtStep: 0})
	}
	return finish("", nil)
}
