import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { UploadTarget } from "./api.js";

export async function putFile(target: UploadTarget, filePath: string): Promise<void> {
  const nodeStream = createReadStream(filePath);
  const res = await fetch(target.uploadUrl, {
    method: target.method,
    headers: target.headers,
    body: Readable.toWeb(nodeStream) as unknown as BodyInit,
    // Node fetch requires duplex when sending a stream body.
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed ${res.status}: ${text.slice(0, 300)}`);
  }
}
