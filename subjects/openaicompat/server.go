// Package openaicompat serves the stateless Subject gRPC protocol over a
// configurable OpenAI-compatible Chat Completions endpoint.
package openaicompat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	subjectv1 "github.com/Appletree24/Detroit/gen/detroit/subject/v1"
	"github.com/Appletree24/Detroit/internal/agentio"
	"github.com/vmihailenco/msgpack/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Config struct {
	BaseURL string
	Model   string
	Digest  string
	APIKey  string
	Client  *http.Client
}

type Server struct {
	subjectv1.UnimplementedSubjectServer
	cfg      Config
	endpoint string
}

func New(cfg Config) (*Server, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("base-url must be an HTTP(S) API base URL without credentials, query or fragment")
	}
	if cfg.Model == "" || cfg.Digest == "" {
		return nil, fmt.Errorf("model and digest are required")
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Server{cfg: cfg, endpoint: strings.TrimRight(cfg.BaseURL, "/") + "/chat/completions"}, nil
}

func (s *Server) Describe(context.Context, *subjectv1.Empty) (*subjectv1.SubjectInfo, error) {
	return &subjectv1.SubjectInfo{Name: s.cfg.Model, Digest: s.cfg.Digest, ObsSchema: agentio.ObservationSchema, ActionSchema: agentio.ActionSchema, ActionHorizon: 1, Stateful: false}, nil
}
func (s *Server) Reset(context.Context, *subjectv1.ResetReq) (*subjectv1.Empty, error) {
	return &subjectv1.Empty{}, nil
}

func (s *Server) Act(ctx context.Context, req *subjectv1.ActReq) (*subjectv1.ActResp, error) {
	if len(req.GetObservation()) > agentio.MaxPayload {
		return nil, status.Error(codes.ResourceExhausted, "observation exceeds 16 MiB")
	}
	var obs agentio.Observation
	if err := msgpack.Unmarshal(req.GetObservation(), &obs); err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid msgpack observation")
	}
	body, err := agentio.Request(obs, s.cfg.Model)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "request is not JSON serializable")
	}
	if len(data) > agentio.MaxPayload {
		return nil, status.Error(codes.ResourceExhausted, "request exceeds 16 MiB")
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, status.Error(codes.Internal, "construct completion request")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if s.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+s.cfg.APIKey)
	}
	resp, err := s.cfg.Client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, status.Error(codes.DeadlineExceeded, "completion request timed out")
		}
		return nil, status.Error(codes.Unavailable, "completion transport error")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, status.Errorf(codes.Unavailable, "chat completion returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, agentio.MaxPayload+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Error(codes.Unavailable, "read completion response")
	}
	if len(raw) > agentio.MaxPayload {
		return nil, status.Error(codes.ResourceExhausted, "completion response exceeds 16 MiB")
	}
	var completion agentio.Completion
	if err = json.Unmarshal(raw, &completion); err != nil || len(completion.Choices) != 1 || len(completion.Choices[0].Message) == 0 {
		return nil, status.Error(codes.DataLoss, "invalid chat completion envelope")
	}
	// The Worker judges malformed model actions. Never retry or repair their content.
	return &subjectv1.ActResp{Actions: raw, Debug: map[string]string{"model": s.cfg.Model, "base_url": s.cfg.BaseURL, "request_id": resp.Header.Get("x-request-id")}}, nil
}

func (s *Server) ActBatch(ctx context.Context, req *subjectv1.ActBatchReq) (*subjectv1.ActBatchResp, error) {
	out := &subjectv1.ActBatchResp{}
	for _, item := range req.GetItems() {
		res, err := s.Act(ctx, item)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, res)
	}
	return out, nil
}
