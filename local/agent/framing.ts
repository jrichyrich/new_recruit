import { LOCAL_AGENT_MAX_FRAME_BYTES } from "./contracts";

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > LOCAL_AGENT_MAX_FRAME_BYTES) {
    throw new Error("Local-agent payload exceeds the maximum frame size.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > LOCAL_AGENT_MAX_FRAME_BYTES) {
        throw new Error("Local-agent frame exceeds the maximum size.");
      }
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      values.push(JSON.parse(payload.toString("utf8")));
    }
    return values;
  }
}
