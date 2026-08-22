import { createReadStream, statSync } from "node:fs";
import { Transform } from "node:stream";
import { Readable } from "node:stream";
import type { UploadTarget } from "./api.js";

export type UploadProgressFn = (percent: number, sent: number, total: number) => void;

export async function putFile(
  target: UploadTarget,
  filePath: string,
  onProgress?: UploadProgressFn,
): Promise<void> {
  const total = statSync(filePath).size;
  let sent = 0;
  let lastEmit = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      const now = Date.now();
      if (onProgress && (now - lastEmit >= 150 || sent >= total)) {
        lastEmit = now;
        const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
        onProgress(percent, sent, total);
      }
      cb(null, chunk);
    },
  });
  const nodeStream = createReadStream(filePath).pipe(meter);
  const res = await fetch(target.uploadUrl, {
    method: target.method,
    headers: target.headers,
    body: Readable.toWeb(nodeStream) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed ${res.status}: ${text.slice(0, 300)}`);
  }
  onProgress?.(100, total, total);
}
