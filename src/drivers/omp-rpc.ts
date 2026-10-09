// OMP v18.8.3 docs/rpc.md and modes/rpc/rpc-frame.ts transport contract.
export type OmpFrame = Record<string, unknown> & { type: string; id?: string };
export class OmpFrameDecoder {
  maxFrameBytes = 1_048_576;
  maxReassembledFrameBytes = 67_108_864;
  private pending: {
    id: string;
    count: number;
    size: number;
    index: number;
    bytes: number;
    buffer: Buffer;
  } | null = null;
  negotiate(ready: OmpFrame) {
    for (const name of ["maxFrameBytes", "maxReassembledFrameBytes"] as const) {
      const value = ready[name];
      if (!Number.isSafeInteger(value) || (value as number) <= 0)
        throw new Error(`Invalid OMP ${name}`);
      this[name] = Math.min(this[name], value as number);
    }
    if (
      !Array.isArray(ready.supportedProtocolVersions) ||
      !ready.supportedProtocolVersions.includes(2)
    )
      throw new Error("OMP lossless RPC v2 required");
  }
  push(value: unknown): OmpFrame | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("OMP frame must be an object");
    const f = value as OmpFrame;
    if (f.type !== "rpc_chunk") {
      if (this.pending) throw new Error("OMP chunk sequence interrupted");
      if (typeof f.type !== "string") throw new Error("OMP frame type missing");
      return f;
    }
    const { chunkId, index, count, byteLength, data } = f;
    if (
      typeof chunkId !== "string" ||
      !chunkId.length ||
      chunkId.length > 128 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (index as number) < 0 ||
      (count as number) < 2 ||
      (count as number) > 256 ||
      (index as number) >= (count as number) ||
      (byteLength as number) < this.maxFrameBytes ||
      (byteLength as number) > this.maxReassembledFrameBytes ||
      typeof data !== "string" ||
      !data.length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    )
      throw new Error("Invalid OMP chunk metadata/data");
    const part = Buffer.from(data, "base64");
    if (part.length > 262_144 || part.toString("base64") !== data)
      throw new Error("Invalid OMP chunk payload");
    if (!this.pending) {
      if (index !== 0) throw new Error("OMP chunks must start at zero");
      this.pending = {
        id: chunkId,
        count: count as number,
        size: byteLength as number,
        index: 0,
        bytes: 0,
        buffer: Buffer.allocUnsafe(byteLength as number),
      };
    }
    const p = this.pending;
    if (p.id !== chunkId || p.count !== count || p.size !== byteLength || p.index !== index)
      throw new Error("OMP chunk sequence mismatch");
    if (p.bytes + part.length > p.size) throw new Error("OMP chunk size exceeded");
    part.copy(p.buffer, p.bytes);
    p.bytes += part.length;
    p.index++;
    if (p.index < p.count) return;
    if (p.bytes !== p.size) throw new Error("OMP chunk size mismatch");
    this.pending = null;
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(p.buffer));
    if (decoded?.type === "rpc_chunk") throw new Error("Nested OMP chunks forbidden");
    return this.push(decoded);
  }
  finish() {
    if (this.pending) throw new Error("Incomplete OMP chunks");
  }
}
export async function* ompFrames(
  stream: ReadableStream<Uint8Array>,
  decoder: OmpFrameDecoder,
): AsyncGenerator<OmpFrame> {
  const reader = stream.getReader();
  const buffer = Buffer.allocUnsafe(decoder.maxFrameBytes);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value;
      let offset = 0;
      while (offset < bytes.length) {
        const nl = bytes.indexOf(10, offset);
        const end = nl < 0 ? bytes.length : nl;
        const length = end - offset;
        if (used + length + 1 > decoder.maxFrameBytes)
          throw new Error("OMP physical frame limit exceeded");
        let line: Uint8Array;
        if (used || nl < 0) {
          buffer.set(bytes.subarray(offset, end), used);
          used += length;
          line = buffer.subarray(0, used);
        } else line = bytes.subarray(offset, end);
        offset = nl < 0 ? end : end + 1;
        if (nl < 0) break;
        used = 0;
        if (!line.length) continue;
        const frame = decoder.push(JSON.parse(utf8.decode(line)));
        if (frame) yield frame;
      }
    }
    if (used) throw new Error("Incomplete OMP JSONL frame");
    decoder.finish();
  } finally {
    reader.releaseLock();
  }
}
