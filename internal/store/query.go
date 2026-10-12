package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
	"github.com/Appletree24/Detroit/internal/stats"
)

// RunSummary 是 run 的进度与结果汇总。
type RunSummary struct {
	RunID     string           `json:"run_id"`
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	Episodes  map[string]int   `json:"episodes"` // 按 episode 状态计数
	Manifest  json.RawMessage  `json:"manifest"`
	Overall   core.Aggregate   `json:"overall"`
	ByVariant []core.Aggregate `json:"by_variant"`
	// ErrorKinds 统计 infra_error 的原因，报告中单列。
	ErrorKinds map[string]int `json:"error_kinds,omitempty"`
}

// Summary 汇总一个 run。成功率只用有效 episode（done 且 outcome 不是 unknown）作分母。
func (s *Store) Summary(ctx context.Context, runID string) (*RunSummary, error) {
	sum := &RunSummary{RunID: runID, Episodes: map[string]int{}, ErrorKinds: map[string]int{}}
	var created int64
	var manifest string
	var confidence float64
	var specJSON string
	err := s.db.QueryRowContext(ctx, `SELECT name, status, created_at, manifest_json, spec_json FROM runs WHERE run_id = ?`, runID).
		Scan(&sum.Name, &sum.Status, &created, &manifest, &specJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("run %s: %w", runID, ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	sum.CreatedAt = time.UnixMilli(created).UTC()
	sum.Manifest = json.RawMessage(manifest)
	var spec core.RunSpec
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		return nil, fmt.Errorf("run %s: decode spec: %w", runID, err)
	}
	confidence = spec.Stats.Confidence

	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM episodes WHERE run_id = ? GROUP BY status`, runID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			rows.Close()
			return nil, err
		}
		sum.Episodes[st] = n
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `
		SELECT e.variant_id, e.status, COALESCE(r.outcome, ''), COALESCE(r.error_kind, ''), COUNT(*)
		FROM episodes e JOIN results r ON r.episode_key = e.episode_key
		WHERE e.run_id = ? GROUP BY 1, 2, 3, 4 ORDER BY 1`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sum.Overall.GroupBy = []string{}
	byVariant := map[string]*core.Aggregate{}
	var order []string
	for rows.Next() {
		var variant, status, outcome, kind string
		var n int
		if err := rows.Scan(&variant, &status, &outcome, &kind, &n); err != nil {
			return nil, err
		}
		agg, ok := byVariant[variant]
		if !ok {
			agg = &core.Aggregate{GroupBy: []string{"variant=" + variant}}
			byVariant[variant] = agg
			order = append(order, variant)
		}
		for _, a := range []*core.Aggregate{&sum.Overall, agg} {
			switch {
			case status == string(core.StatusInfraError):
				a.InfraErrors += n
			case outcome == string(core.OutcomeUnknown):
				a.Unknowns += n
			case outcome == string(core.OutcomeSuccess):
				a.N += n
				a.Successes += n
			default:
				a.N += n
			}
		}
		if kind != "" {
			sum.ErrorKinds[kind] += n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := finalize(&sum.Overall, confidence); err != nil {
		return nil, err
	}
	for _, v := range order {
		if err := finalize(byVariant[v], confidence); err != nil {
			return nil, err
		}
		sum.ByVariant = append(sum.ByVariant, *byVariant[v])
	}
	return sum, nil
}

func finalize(a *core.Aggregate, confidence float64) error {
	if a.N > 0 {
		a.Rate = float64(a.Successes) / float64(a.N)
	}
	ci, err := stats.Wilson(a.Successes, a.N, confidence)
	a.CI95 = ci
	return err
}

// ListRuns 按提交时间倒序列出 run。
func (s *Store) ListRuns(ctx context.Context) ([]RunSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT run_id, name, status, created_at FROM runs ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunSummary
	for rows.Next() {
		var r RunSummary
		var created int64
		if err := rows.Scan(&r.RunID, &r.Name, &r.Status, &created); err != nil {
			return nil, err
		}
		r.CreatedAt = time.UnixMilli(created).UTC()
		out = append(out, r)
	}
	return out, rows.Err()
}

// ResultCount 返回 results 表里某个 run 的结果行数，测试用来核对"不重复、不丢失"。
func (s *Store) ResultCount(ctx context.Context, runID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM results r JOIN episodes e ON e.episode_key = r.episode_key WHERE e.run_id = ?`, runID).Scan(&n)
	return n, err
}
