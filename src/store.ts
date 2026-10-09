import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evaluation, ExperimentSpec, RunResult } from "./contracts";
import { digest } from "./evidence";

export type TrialRow = {
  id: string;
  experiment_id: string;
  case_id: string;
  variant_id: string;
  repeat_index: number;
  ordinal: number;
};
export type AttemptRow = {
  id: string;
  trial_id: string;
  status: string;
  directory: string;
  result_json: string | null;
  error: string | null;
  cleanup: string;
};
export type EvaluationRow = {
  id: number;
  attempt_id: string;
  evidence_digest: string;
  spec_digest: string;
  result_json: string;
  created_at: string;
};
export class Store {
  readonly db: Database;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new Database(join(root, "index.sqlite"), { create: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_json TEXT NOT NULL, spec_digest TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trials (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), case_id TEXT NOT NULL, variant_id TEXT NOT NULL, repeat_index INTEGER NOT NULL, ordinal INTEGER NOT NULL, UNIQUE(experiment_id,case_id,variant_id,repeat_index));
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, trial_id TEXT NOT NULL REFERENCES trials(id), status TEXT NOT NULL, directory TEXT NOT NULL, result_json TEXT, error TEXT, cleanup TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS evaluations (id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), evidence_digest TEXT NOT NULL, spec_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  close() {
    this.db.close();
  }
  freeze(id: string, spec: ExperimentSpec, snapshot: unknown, trials: TrialRow[]) {
    const json = JSON.stringify(snapshot);
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO experiments VALUES (?,?,?,?,?)")
        .run(id, spec.name, json, digest(json), new Date().toISOString());
      for (const trial of trials)
        this.db
          .query("INSERT INTO trials VALUES (?,?,?,?,?,?)")
          .run(
            trial.id,
            trial.experiment_id,
            trial.case_id,
            trial.variant_id,
            trial.repeat_index,
            trial.ordinal,
          );
    })();
  }
  experiment(id: string) {
    const row = this.db.query("SELECT * FROM experiments WHERE id=?").get(id) as {
      id: string;
      name: string;
      spec_json: string;
      spec_digest: string;
      created_at: string;
    } | null;
    if (!row) throw new Error(`Unknown experiment: ${id}`);
    if (digest(row.spec_json) !== row.spec_digest)
      throw new Error("Frozen specification digest mismatch");
    return row;
  }
  trials(id: string) {
    return this.db
      .query("SELECT * FROM trials WHERE experiment_id=? ORDER BY ordinal")
      .all(id) as TrialRow[];
  }
  experimentForTrial(id: string) {
    const row = this.db.query("SELECT experiment_id FROM trials WHERE id=?").get(id) as {
      experiment_id: string;
    } | null;
    if (!row) throw new Error(`Unknown trial: ${id}`);
    return this.experiment(row.experiment_id);
  }
  attempts(trialId: string) {
    return this.db
      .query("SELECT * FROM attempts WHERE trial_id=? ORDER BY rowid")
      .all(trialId) as AttemptRow[];
  }
  active() {
    return this.db
      .query("SELECT * FROM attempts WHERE status='running' OR cleanup!='done'")
      .all() as AttemptRow[];
  }
  start(id: string, trialId: string, directory: string) {
    this.db
      .query("INSERT INTO attempts (id,trial_id,status,directory) VALUES (?,?,'running',?)")
      .run(id, trialId, directory);
  }
  finish(
    id: string,
    status: string,
    result: RunResult | null,
    error: string | null,
    cleanup: string,
  ) {
    const changed = this.db
      .query(
        "UPDATE attempts SET status=?,result_json=?,error=?,cleanup=? WHERE id=? AND status='running'",
      )
      .run(status, result ? JSON.stringify(result) : null, error, cleanup, id);
    if (changed.changes !== 1) throw new Error(`Attempt already terminal: ${id}`);
  }
  markClean(id: string) {
    this.db.query("UPDATE attempts SET cleanup='done' WHERE id=?").run(id);
  }
  markPending(id: string) {
    this.db.query("UPDATE attempts SET cleanup='pending' WHERE id=?").run(id);
  }
  score(id: string, evidenceDigest: string, specDigest: string, result: Evaluation) {
    const json = JSON.stringify(result);
    const existing = this.db
      .query(
        "SELECT result_json FROM evaluations WHERE attempt_id=? AND evidence_digest=? AND spec_digest=? ORDER BY id DESC LIMIT 1",
      )
      .get(id, evidenceDigest, specDigest) as { result_json: string } | null;
    if (existing && JSON.parse(existing.result_json).status !== "evaluation_error") {
      if (existing.result_json !== json) throw new Error("Non-deterministic evaluation conflict");
      return;
    }
    this.db
      .query(
        "INSERT INTO evaluations (attempt_id,evidence_digest,spec_digest,result_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, evidenceDigest, specDigest, json, new Date().toISOString());
  }
  evaluations(id: string) {
    return this.db
      .query("SELECT * FROM evaluations WHERE attempt_id=? ORDER BY id")
      .all(id) as EvaluationRow[];
  }
}

export function acquireLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const path = join(root, "writer.lock");
  if (existsSync(path)) {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error(`Another coordinator holds the data directory (pid ${owner.pid})`);
    rmSync(path);
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return () => rmSync(path, { force: true });
}
