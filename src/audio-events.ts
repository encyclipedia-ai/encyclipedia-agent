/**
 * Heuristic audio markers for the transcript scout.
 *
 * Librarian runs ffmpeg over local mp3 (no ML). Peaks and silence are
 * downsampled so the analyze prompt stays small, then sent as audioEvents.
 */
import { spawn } from "node:child_process";
import { toolPaths } from "./tools.js";

export type AudioEventKind = "loud_peak" | "energy_rise" | "silence";

export interface AudioEvent {
  start: number;
  end: number;
  kind: AudioEventKind;
  intensity?: number;
}

/** One RMS sample from a ~1s ffmpeg astats window (dB, typically negative). */
export interface RmsSample {
  atSec: number;
  rmsDb: number;
}

export interface SilenceSpan {
  start: number;
  end: number;
}

const ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;
/** Keep the strongest peaks per hour of audio. */
const MAX_PEAKS_PER_HOUR = 24;
const MAX_RISES_PER_HOUR = 16;
const MAX_SILENCES_PER_HOUR = 12;
/** Awkward beat, not dead air. */
const MIN_SILENCE_SEC = 0.45;
const MAX_SILENCE_SEC = 6;
/** Rise of this many dB vs the previous second counts as energy_rise. */
const ENERGY_RISE_DB = 8;
/** Loud peaks must sit this many dB above the stream median. */
const LOUD_PEAK_ABOVE_MEDIAN_DB = 10;

function requireFfmpeg(): string {
  const ffmpeg = toolPaths().ffmpeg;
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg is not available. Restart Librarian so it can download media tools.",
    );
  }
  return ffmpeg;
}

function runFfmpegAnalysis(args: string[]): Promise<string> {
  const ffmpeg = requireFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg audio analysis timed out."));
    }, ANALYSIS_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // silencedetect / astats write to stderr; a non-zero code with useful
      // output still happens on some builds when null mux finishes.
      if (code !== 0 && !/RMS_level|silence_start|silence_end/.test(stderr)) {
        reject(new Error(`ffmpeg audio analysis failed (exit ${code ?? 1}).`));
        return;
      }
      resolve(stderr);
    });
  });
}

/** Parse sequential 1s RMS windows from ametadata / astats stderr. */
export function parseRmsSamples(stderr: string): RmsSample[] {
  const lines = stderr.split(/\r?\n/);
  const samples: RmsSample[] = [];
  let pendingPts: number | null = null;
  let windowIndex = 0;
  for (const line of lines) {
    const ptsMatch = line.match(/pts_time:(-?\d+(?:\.\d+)?)/);
    if (ptsMatch) {
      pendingPts = Number(ptsMatch[1]);
      continue;
    }
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/);
    if (!rmsMatch) continue;
    const rmsDb = Number(rmsMatch[1]);
    if (!Number.isFinite(rmsDb) || rmsDb === Number.NEGATIVE_INFINITY) {
      pendingPts = null;
      windowIndex += 1;
      continue;
    }
    const atSec = pendingPts != null && Number.isFinite(pendingPts) ? pendingPts : windowIndex;
    samples.push({ atSec, rmsDb });
    pendingPts = null;
    windowIndex += 1;
  }
  return samples;
}

/** Parse ffmpeg silencedetect lines into absolute spans. */
export function parseSilenceSpans(stderr: string): SilenceSpan[] {
  const starts: number[] = [];
  const spans: SilenceSpan[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) {
      starts.push(Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(
      /silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(-?\d+(?:\.\d+)?)/,
    );
    if (!endMatch) continue;
    const end = Number(endMatch[1]);
    const duration = Number(endMatch[2]);
    const start =
      starts.length > 0
        ? starts.pop()!
        : Number.isFinite(duration)
          ? end - duration
          : end;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      spans.push({ start, end });
    }
  }
  return spans;
}

function median(values: number[]): number {
  if (values.length === 0) return -60;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function hoursCovered(samples: RmsSample[], silences: SilenceSpan[]): number {
  let maxSec = 0;
  for (const s of samples) maxSec = Math.max(maxSec, s.atSec);
  for (const s of silences) maxSec = Math.max(maxSec, s.end);
  return Math.max(1, Math.ceil(maxSec / 3600));
}

function takeTopPerHour(
  events: AudioEvent[],
  maxPerHour: number,
  hours: number,
  score: (e: AudioEvent) => number,
): AudioEvent[] {
  const budget = Math.max(maxPerHour, maxPerHour * hours);
  return [...events]
    .sort((a, b) => score(b) - score(a) || a.start - b.start)
    .slice(0, budget)
    .sort((a, b) => a.start - b.start);
}

/**
 * Turn RMS windows + silence spans into a bounded AudioEvent list.
 * Exported for unit tests with fixture stderr / synthetic samples.
 */
export function buildAudioEvents(
  samples: RmsSample[],
  silences: SilenceSpan[],
): AudioEvent[] {
  const hours = hoursCovered(samples, silences);
  const finiteDb = samples.map((s) => s.rmsDb).filter((v) => Number.isFinite(v));
  const med = median(finiteDb);
  const peakThreshold = med + LOUD_PEAK_ABOVE_MEDIAN_DB;

  const loudPeaks: AudioEvent[] = [];
  const rises: AudioEvent[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const nextAt = samples[i + 1]?.atSec ?? sample.atSec + 1;
    const end = Math.max(sample.atSec + 0.25, Math.min(nextAt, sample.atSec + 1.25));
    const intensity = Math.min(
      1,
      Math.max(0, (sample.rmsDb - med) / Math.max(LOUD_PEAK_ABOVE_MEDIAN_DB * 2, 1)),
    );
    if (sample.rmsDb >= peakThreshold) {
      loudPeaks.push({
        start: sample.atSec,
        end,
        kind: "loud_peak",
        intensity: Number(intensity.toFixed(2)),
      });
    }
    if (i > 0) {
      const prev = samples[i - 1]!;
      const rise = sample.rmsDb - prev.rmsDb;
      if (rise >= ENERGY_RISE_DB) {
        rises.push({
          start: sample.atSec,
          end,
          kind: "energy_rise",
          intensity: Number(Math.min(1, rise / (ENERGY_RISE_DB * 2)).toFixed(2)),
        });
      }
    }
  }

  const silenceEvents: AudioEvent[] = silences
    .filter((s) => {
      const dur = s.end - s.start;
      return dur >= MIN_SILENCE_SEC && dur <= MAX_SILENCE_SEC;
    })
    .map((s) => ({
      start: s.start,
      end: s.end,
      kind: "silence" as const,
      intensity: Number(Math.min(1, (s.end - s.start) / MAX_SILENCE_SEC).toFixed(2)),
    }));

  const selected = [
    ...takeTopPerHour(loudPeaks, MAX_PEAKS_PER_HOUR, hours, (e) => e.intensity ?? 0),
    ...takeTopPerHour(rises, MAX_RISES_PER_HOUR, hours, (e) => e.intensity ?? 0),
    ...takeTopPerHour(silenceEvents, MAX_SILENCES_PER_HOUR, hours, (e) => e.end - e.start),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  return selected;
}

async function analyzeRms(audioPath: string): Promise<RmsSample[]> {
  // ~1s windows at 8 kHz mono. Audio-only; much faster than realtime.
  const stderr = await runFfmpegAnalysis([
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-vn",
    "-af",
    "aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
    "-f",
    "null",
    "-",
  ]);
  return parseRmsSamples(stderr);
}

async function analyzeSilence(audioPath: string): Promise<SilenceSpan[]> {
  const stderr = await runFfmpegAnalysis([
    "-hide_banner",
    "-nostats",
    "-i",
    audioPath,
    "-vn",
    "-af",
    "silencedetect=noise=-32dB:d=0.45",
    "-f",
    "null",
    "-",
  ]);
  return parseSilenceSpans(stderr);
}

/**
 * Run ffmpeg over a local audio file and return downsampled events.
 * Throws on tool/ffmpeg failure; callers may catch and continue transcript-only.
 */
export async function extractAudioEvents(audioPath: string): Promise<AudioEvent[]> {
  const [samples, silences] = await Promise.all([
    analyzeRms(audioPath),
    analyzeSilence(audioPath),
  ]);
  return buildAudioEvents(samples, silences);
}
