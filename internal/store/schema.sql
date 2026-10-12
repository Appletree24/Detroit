-- docs/02 §4.1。时间均为 Unix 毫秒。
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  vertical      TEXT NOT NULL,           -- Lease 时按 Worker 的垂类过滤
  spec_yaml     TEXT NOT NULL,           -- 用户提交的原文
  spec_json     TEXT NOT NULL,           -- 补全默认值后的规范化 RunSpec，下发给 Worker
  manifest_json TEXT NOT NULL,
  status        TEXT NOT NULL,           -- pending | running | done | cancelled
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  episode_key     TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  task_id         TEXT NOT NULL,
  variant_id      TEXT NOT NULL,
  init_state_id   TEXT NOT NULL,
  seed            INTEGER NOT NULL,
  repeat_idx      INTEGER NOT NULL,
  status          TEXT NOT NULL,         -- pending | leased | done | infra_error
  attempt         INTEGER NOT NULL DEFAULT 0, -- 租约过期次数
  lease_owner     TEXT,
  lease_expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS episodes_run_status ON episodes(run_id, status);
CREATE INDEX IF NOT EXISTS episodes_status_expire ON episodes(status, lease_expire_at);

CREATE TABLE IF NOT EXISTS results (
  episode_key   TEXT PRIMARY KEY REFERENCES episodes(episode_key),
  outcome       TEXT,                    -- success | failure | unknown；infra_error 时为空
  score         REAL NOT NULL,           -- OnlineScore.Progress
  steps         INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  cost_json     TEXT NOT NULL,
  subgoals_json TEXT NOT NULL,
  artifact_uri  TEXT NOT NULL,
  error_kind    TEXT,
  finished_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (     -- 失败归因
  episode_key TEXT NOT NULL REFERENCES episodes(episode_key),
  labeler     TEXT NOT NULL,
  label       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  rationale   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
