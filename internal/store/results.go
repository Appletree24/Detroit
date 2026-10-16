package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/Appletree24/Detroit/internal/core"
)

type ResultRecord struct {
	TaskID string             `json:"task_id"`
	Result core.EpisodeResult `json:"result"`
}

// Results exposes the accepted result's artifact path. Concurrent/retried
// executions have distinct directories; only the winning path is returned.
func (s *Store) Results(ctx context.Context, runID string) ([]ResultRecord, error) {
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM runs WHERE run_id=?`, runID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("run %s: %w", runID, ErrNotFound)
		}
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT e.task_id,r.episode_key,e.status,COALESCE(r.outcome,''),COALESCE(r.error_kind,''),r.score,r.steps,r.duration_ms,r.cost_json,r.subgoals_json,r.artifact_uri FROM results r JOIN episodes e ON e.episode_key=r.episode_key WHERE e.run_id=? ORDER BY e.task_id,e.repeat_idx,e.seed`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []ResultRecord{}
	for rows.Next() {
		var rec ResultRecord
		var cost, subgoals string
		if err = rows.Scan(&rec.TaskID, &rec.Result.Key, &rec.Result.Status, &rec.Result.Outcome, &rec.Result.ErrorKind, &rec.Result.Score.Progress, &rec.Result.Steps, &rec.Result.DurationMs, &cost, &subgoals, &rec.Result.Artifacts); err != nil {
			return nil, err
		}
		rec.Result.Score.Success = rec.Result.Outcome == core.OutcomeSuccess
		if err = json.Unmarshal([]byte(cost), &rec.Result.Cost); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(subgoals), &rec.Result.Score.Subgoals); err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	return records, rows.Err()
}
