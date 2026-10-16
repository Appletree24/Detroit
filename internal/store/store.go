// Package store 是控制面的元数据存储（docs/02 §4.1）。SQLite 起步；所有写入在短事务内完成，
// episode_key 是幂等键：结果只入库一次，重复提交同一个 RunSpec 只补齐缺失的 episode。
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Appletree24/Detroit/internal/core"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// Run 状态。
const (
	RunPending   = "pending"
	RunRunning   = "running"
	RunDone      = "done"
	RunCancelled = "cancelled"
)

// Episode 状态（另有 core.StatusDone、core.StatusInfraError 两个终态）。
const (
	EpisodePending = "pending"
	EpisodeLeased  = "leased"
)

var ErrNotFound = errors.New("not found")

type Store struct{ db *sql.DB }

// Open 打开（必要时创建）数据库文件。
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// 控制面是唯一写入方；单连接让事务天然串行，避免 SQLITE_BUSY。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// SubmitResult 说明提交是新建 run 还是续跑已有 run。
type SubmitResult struct {
	RunID    string `json:"run_id"`
	Existing bool   `json:"existing"`
	Added    int    `json:"added"` // 本次新写入的 episode 数
	Total    int    `json:"total"`
}

// Submit 写入 run 和它的 episode。run_id 由 RunSpec 决定，所以重新提交同一个 RunSpec 等价于续跑：
// 已有 episode 保持原状，被取消的 run 重新开放。
func (s *Store) Submit(ctx context.Context, spec *core.RunSpec, specYAML []byte, manifest any, eps []core.Episode, now time.Time) (SubmitResult, error) {
	runID := spec.RunID()
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return SubmitResult{}, err
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return SubmitResult{}, err
	}
	res := SubmitResult{RunID: runID, Total: len(eps)}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		var status string
		switch err := tx.QueryRowContext(ctx, `SELECT status FROM runs WHERE run_id = ?`, runID).Scan(&status); {
		case errors.Is(err, sql.ErrNoRows):
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO runs(run_id, name, vertical, spec_yaml, spec_json, manifest_json, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
				runID, spec.Name, spec.TaskSet.Vertical, string(specYAML), string(specJSON), string(manifestJSON), RunPending, now.UnixMilli()); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			res.Existing = true
		}
		stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO episodes
			(episode_key, run_id, task_id, variant_id, init_state_id, seed, repeat_idx, status, attempt)
			VALUES (?,?,?,?,?,?,?,?,0)`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, ep := range eps {
			r, err := stmt.ExecContext(ctx, ep.Key, runID, ep.TaskID, ep.VariantID, ep.InitStateID, ep.Seed, ep.RepeatIdx, EpisodePending)
			if err != nil {
				return err
			}
			n, _ := r.RowsAffected()
			res.Added += int(n)
		}
		if res.Existing && status == RunCancelled {
			if _, err := tx.ExecContext(ctx, `UPDATE runs SET status = ? WHERE run_id = ?`, RunRunning, runID); err != nil {
				return err
			}
		}
		return finishIfComplete(ctx, tx, runID)
	})
	return res, err
}

// Lease 是一次分配给 Worker 的 episode。
type Lease struct {
	Episode     core.Episode
	RunSpecJSON []byte
	ExpireAt    time.Time
}

// Lease 为 Worker 分配最多 max 个待调度 episode，只从该垂类、未取消的 run 中挑选，按 run 提交顺序。
func (s *Store) Lease(ctx context.Context, workerID, vertical string, max int, now time.Time, ttl time.Duration) ([]Lease, error) {
	return s.LeaseForAdapter(ctx, workerID, vertical, "", max, now, ttl)
}

// LeaseForAdapter prevents mock Workers from consuming real-model runs.
// Empty adapter preserves the unfiltered storage API for existing callers.
func (s *Store) LeaseForAdapter(ctx context.Context, workerID, vertical, adapter string, max int, now time.Time, ttl time.Duration) ([]Lease, error) {
	if max <= 0 {
		return nil, nil
	}
	expire := now.Add(ttl)
	var out []Lease
	err := s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT e.episode_key, e.run_id, e.task_id, e.variant_id, e.init_state_id, e.seed, e.repeat_idx, r.spec_json
			FROM episodes e JOIN runs r ON r.run_id = e.run_id
			WHERE e.status = ? AND r.status IN (?, ?) AND r.vertical = ?
 AND (? = '' OR json_extract(r.spec_json, '$.subject.adapter') = ?)
			ORDER BY r.created_at, r.run_id, e.rowid
			LIMIT ?`, EpisodePending, RunPending, RunRunning, vertical, adapter, adapter, max)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l Lease
			var spec string
			if err := rows.Scan(&l.Episode.Key, &l.Episode.RunID, &l.Episode.TaskID, &l.Episode.VariantID,
				&l.Episode.InitStateID, &l.Episode.Seed, &l.Episode.RepeatIdx, &spec); err != nil {
				rows.Close()
				return err
			}
			l.RunSpecJSON = []byte(spec)
			l.ExpireAt = expire
			out = append(out, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		runs := map[string]bool{}
		for _, l := range out {
			if _, err := tx.ExecContext(ctx,
				`UPDATE episodes SET status = ?, lease_owner = ?, lease_expire_at = ? WHERE episode_key = ?`,
				EpisodeLeased, workerID, expire.UnixMilli(), l.Episode.Key); err != nil {
				return err
			}
			runs[l.Episode.RunID] = true
		}
		for runID := range runs {
			if _, err := tx.ExecContext(ctx, `UPDATE runs SET status = ? WHERE run_id = ? AND status = ?`, RunRunning, runID, RunPending); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// Heartbeat 为该 Worker 仍持有的租约续期，返回所属 run 已被取消的 episode。
// 已过期并被回收的租约不会续期；Worker 仍可完成并上报，控制面接受先到的结果。
func (s *Store) Heartbeat(ctx context.Context, workerID string, keys []string, now time.Time, ttl time.Duration) (cancelled []string, extendTo time.Time, err error) {
	extendTo = now.Add(ttl)
	if len(keys) == 0 {
		return nil, extendTo, nil
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		in, args := inClause(keys)
		if _, err := tx.ExecContext(ctx,
			`UPDATE episodes SET lease_expire_at = ? WHERE status = ? AND lease_owner = ? AND episode_key IN `+in,
			append([]any{extendTo.UnixMilli(), EpisodeLeased, workerID}, args...)...); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT e.episode_key FROM episodes e JOIN runs r ON r.run_id = e.run_id WHERE r.status = ? AND e.episode_key IN `+in,
			append([]any{RunCancelled}, args...)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			cancelled = append(cancelled, k)
		}
		return rows.Err()
	})
	return cancelled, extendTo, err
}

// ReportOutcome 说明一次上报是否被接受。
type ReportOutcome struct {
	Accepted  bool
	Duplicate bool
}

// Report 写入 episode 结果。同一 episode_key 只接受第一个到达的结果，之后的上报返回 Duplicate。
func (s *Store) Report(ctx context.Context, res core.EpisodeResult, artifactURI string, now time.Time) (ReportOutcome, error) {
	if err := res.Validate(); err != nil {
		return ReportOutcome{}, err
	}
	var out ReportOutcome
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var runID string
		if err := tx.QueryRowContext(ctx, `SELECT run_id FROM episodes WHERE episode_key = ?`, res.Key).Scan(&runID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("episode %s: %w", res.Key, ErrNotFound)
			}
			return err
		}
		inserted, err := insertResult(ctx, tx, res, artifactURI, now)
		if err != nil {
			return err
		}
		if !inserted {
			out = ReportOutcome{Duplicate: true}
			return nil
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE episodes SET status = ?, lease_owner = NULL, lease_expire_at = NULL WHERE episode_key = ?`,
			string(res.Status), res.Key); err != nil {
			return err
		}
		out = ReportOutcome{Accepted: true}
		return finishIfComplete(ctx, tx, runID)
	})
	return out, err
}

// ExpireLeases 回收过期租约：attempt + 1，未超过上限的回到待调度状态，超过上限的记为
// infra_error（lease_exhausted），不计入成功率分母。返回回收的 episode 数。
func (s *Store) ExpireLeases(ctx context.Context, now time.Time, maxAttempts int) (requeued, exhausted int, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT episode_key, run_id, attempt FROM episodes WHERE status = ? AND lease_expire_at < ?`,
			EpisodeLeased, now.UnixMilli())
		if err != nil {
			return err
		}
		type expired struct {
			key, runID string
			attempt    int
		}
		var list []expired
		for rows.Next() {
			var e expired
			if err := rows.Scan(&e.key, &e.runID, &e.attempt); err != nil {
				rows.Close()
				return err
			}
			list = append(list, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		runs := map[string]bool{}
		for _, e := range list {
			attempt := e.attempt + 1
			if attempt < maxAttempts {
				if _, err := tx.ExecContext(ctx,
					`UPDATE episodes SET status = ?, attempt = ?, lease_owner = NULL, lease_expire_at = NULL WHERE episode_key = ?`,
					EpisodePending, attempt, e.key); err != nil {
					return err
				}
				requeued++
				continue
			}
			res := core.EpisodeResult{Key: e.key, Status: core.StatusInfraError, ErrorKind: core.ErrorKindLeaseExhausted}
			if _, err := insertResult(ctx, tx, res, "", now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE episodes SET status = ?, attempt = ?, lease_owner = NULL, lease_expire_at = NULL WHERE episode_key = ?`,
				string(core.StatusInfraError), attempt, e.key); err != nil {
				return err
			}
			exhausted++
			runs[e.runID] = true
		}
		for runID := range runs {
			if err := finishIfComplete(ctx, tx, runID); err != nil {
				return err
			}
		}
		return nil
	})
	return requeued, exhausted, err
}

// Cancel 取消一个 run：不再分配它的 episode，持有租约的 Worker 在下次心跳时收到取消指令。
// 已完成的结果保留；重新提交同一个 RunSpec 会重新开放它。已结束的 run 不受影响。返回取消后的 run 状态。
func (s *Store) Cancel(ctx context.Context, runID string) (string, error) {
	var status string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE runs SET status = ? WHERE run_id = ? AND status IN (?, ?)`,
			RunCancelled, runID, RunPending, RunRunning); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, `SELECT status FROM runs WHERE run_id = ?`, runID).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("run %s: %w", runID, ErrNotFound)
		}
		return err
	})
	return status, err
}

func insertResult(ctx context.Context, tx *sql.Tx, res core.EpisodeResult, artifactURI string, now time.Time) (bool, error) {
	cost, err := json.Marshal(res.Cost)
	if err != nil {
		return false, err
	}
	subgoals, err := json.Marshal(res.Score.Subgoals)
	if err != nil {
		return false, err
	}
	if artifactURI == "" {
		artifactURI = res.Artifacts
	}
	var outcome, errorKind any
	if res.Outcome != "" {
		outcome = string(res.Outcome)
	}
	if res.ErrorKind != "" {
		errorKind = res.ErrorKind
	}
	r, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO results
		(episode_key, outcome, score, steps, duration_ms, cost_json, subgoals_json, artifact_uri, error_kind, finished_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		res.Key, outcome, res.Score.Progress, res.Steps, res.DurationMs, string(cost), string(subgoals), artifactURI, errorKind, now.UnixMilli())
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

// finishIfComplete 在 run 的所有 episode 都进入终态后把它标记为 done。
func finishIfComplete(ctx context.Context, tx *sql.Tx, runID string) error {
	_, err := tx.ExecContext(ctx, `UPDATE runs SET status = ? WHERE run_id = ? AND status IN (?, ?)
		AND NOT EXISTS (SELECT 1 FROM episodes WHERE run_id = ? AND status IN (?, ?))`,
		RunDone, runID, RunPending, RunRunning, runID, EpisodePending, EpisodeLeased)
	return err
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func inClause(keys []string) (string, []any) {
	args := make([]any, len(keys))
	for i, k := range keys {
		args[i] = k
	}
	return "(" + strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",") + ")", args
}
