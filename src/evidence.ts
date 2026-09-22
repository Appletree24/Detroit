import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type EvidenceEvent, eventSchema } from "./contracts";

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export class Evidence {
  private seq = 0;
  readonly objects: string;
  readonly journal: string;
  constructor(
    readonly root: string,
    readonly attemptId: string,
  ) {
    this.objects = join(root, "objects");
    this.journal = join(root, "events.jsonl");
    mkdirSync(this.objects, { recursive: true });
    if (existsSync(this.journal)) this.seq = this.events().length;
  }
  put(value: unknown): string {
    return this.putText(JSON.stringify(value));
  }
  putText(text: string): string {
    const hash = digest(text);
    const path = join(this.objects, hash);
    if (!existsSync(path)) {
      const temp = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
    }
    return hash;
  }
  read(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid evidence reference");
    const text = readFileSync(join(this.objects, hash), "utf8");
    if (digest(text) !== hash) throw new Error(`Evidence digest mismatch: ${hash}`);
    return text;
  }
  emit(type: string, payload: unknown): EvidenceEvent {
    const event: EvidenceEvent = {
      schema_version: 1,
      attempt_id: this.attemptId,
      source_id: "reference",
      source_seq: ++this.seq,
      event_type: type,
      observed_at: new Date().toISOString(),
      raw_ref: this.put(payload),
    };
    appendFileSync(this.journal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    const fd = openSync(this.journal, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return event;
  }
  events(): EvidenceEvent[] {
    if (!existsSync(this.journal)) return [];
    const text = readFileSync(this.journal, "utf8");
    if (text && !text.endsWith("\n")) throw new Error("Incomplete journal tail");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        const e = eventSchema.parse(JSON.parse(line));
        if (e.attempt_id !== this.attemptId || e.source_seq !== index + 1)
          throw new Error("Journal identity/sequence conflict");
        this.read(e.raw_ref);
        return e;
      });
  }
}
