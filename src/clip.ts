import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { putFile } from "./upload.js";
import { downloadSource, dumpVideoInfo } from "./ytdlp.js";

const TERMINAL = new Set(["done", "error", "cancelled"]);

export async function runClip(
  cfg: AgentConfig,
  url: string,
  clipLength: "short" | "medium",
): Promise<void> {
  console.log("Resolving video metadata with local yt-dlp…");
  const video = await dumpVideoInfo(url);
  console.log(`  ${video.title} (${video.id})`);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    console.log("Downloading source + captions on this machine…");
    const { videoPath, captionsPath } = await downloadSource(url, workDir);
    console.log(`  video: ${videoPath}`);
    if (captionsPath) console.log(`  captions: ${captionsPath}`);
    else console.warn("  no captions file — worker will try YouTube captions as fallback");

    console.log("Requesting upload URLs…");
    const videoTarget = await api.requestUploadUrl(cfg, video.id, "video", "video/mp4");
    console.log("Uploading video…");
    await putFile(videoTarget, videoPath);

    let subtitleKey: string | undefined;
    if (captionsPath) {
      const capTarget = await api.requestUploadUrl(
        cfg,
        video.id,
        "captions",
        "application/json",
      );
      console.log("Uploading captions…");
      await putFile(capTarget, captionsPath);
      subtitleKey = capTarget.objectKey;
    }

    console.log("Submitting job to encyclipedia…");
    const submitted = await api.submitJob(cfg, {
      url,
      clipLength,
      video,
      source: {
        bucket: videoTarget.bucket,
        objectKey: videoTarget.objectKey,
        subtitleKey,
      },
    });
    console.log(
      submitted.deduped
        ? `Reusing in-flight job ${submitted.jobId}`
        : `Job ${submitted.jobId} queued`,
    );

    console.log("Waiting for cloud worker (render / autocrop)…");
    while (true) {
      const job = await api.getJob(cfg, submitted.jobId);
      process.stdout.write(`  ${job.status}: ${job.progress}\r`);
      if (TERMINAL.has(job.status)) {
        process.stdout.write("\n");
        if (job.status === "done") {
          console.log("Done. Clips are in the encyclipedia dashboard.");
        } else {
          console.error(`Job ${job.status}${job.error ? `: ${job.error}` : ""}`);
          process.exitCode = 1;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
