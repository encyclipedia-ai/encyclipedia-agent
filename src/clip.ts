import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import * as api from "./api.js";
import { AgentApiError } from "./api.js";
import { putFile } from "./upload.js";
import { downloadSource, dumpVideoInfo } from "./ytdlp.js";

const TERMINAL = new Set(["done", "error", "cancelled"]);

export async function ingestSource(
  cfg: AgentConfig,
  url: string,
): Promise<{
  video: api.VideoInfo;
  source: { bucket: string; objectKey: string; subtitleKey?: string };
}> {
  console.log("Resolving video metadata with local yt-dlp…");
  const video = await dumpVideoInfo(url);
  console.log(`  ${video.title} (${video.id})`);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "encyclipedia-agent-"));
  try {
    console.log("Downloading source + captions on this machine…");
    const { videoPath, captionsPath } = await downloadSource(url, workDir);
    console.log(`  video: ${videoPath}`);
    if (captionsPath) console.log(`  captions: ${captionsPath}`);
    else console.warn("  no captions file — cloud render will try YouTube captions as fallback");

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

    return {
      video,
      source: {
        bucket: videoTarget.bucket,
        objectKey: videoTarget.objectKey,
        subtitleKey,
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForWorker(cfg: AgentConfig, jobId: string): Promise<void> {
  console.log("Waiting for cloud worker (render / autocrop)…");
  while (true) {
    const job = await api.getJob(cfg, jobId);
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
}

export async function runClip(
  cfg: AgentConfig,
  url: string,
  clipLength: "short" | "medium",
): Promise<void> {
  const { video, source } = await ingestSource(cfg, url);
  console.log("Submitting job to encyclipedia…");
  const submitted = await api.submitJob(cfg, {
    url,
    clipLength,
    video,
    source,
  });
  console.log(
    submitted.deduped
      ? `Reusing in-flight job ${submitted.jobId}`
      : `Job ${submitted.jobId} queued`,
  );
  await waitForWorker(cfg, submitted.jobId);
}

export async function fulfillRemoteJob(
  cfg: AgentConfig,
  claim: api.ClaimedJob,
): Promise<void> {
  try {
    const { video, source } = await ingestSource(cfg, claim.youtubeUrl);
    console.log(`Completing job ${claim.jobId}…`);
    await api.completeJob(cfg, claim.jobId, { video, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof AgentApiError && err.status === 409)) {
      await api.failJob(cfg, claim.jobId, message).catch(() => {});
    }
    throw err;
  }
  await waitForWorker(cfg, claim.jobId);
}
