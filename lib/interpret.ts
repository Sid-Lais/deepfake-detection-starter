import type { VelmaFrame } from "./velma";

/**
 * Modulate does not publish a clip-level threshold. Their docs say to drop
 * `no-content` frames, and to "set the threshold against your own labelled
 * recordings". The two cut-offs below are demo defaults chosen by this repo,
 * NOT values from Modulate. Change them to suit your own data.
 */
export const LIKELY_REAL_MIN = 0.75;
export const LIKELY_SYNTHETIC_MAX = 0.25;

export type Label = "real" | "synthetic" | "unsure" | "no-speech";

export interface Interpretation {
  label: Label;
  /** Share of speech time Velma judged non-synthetic, 0 to 1. Null when there is no speech. */
  naturalShare: number | null;
  speechMs: number;
  totalMs: number;
  frameCount: number;
  speechFrameCount: number;
  /** Time-weighted mean confidence across speech frames. */
  meanConfidence: number | null;
}

export function interpret(frames: VelmaFrame[], durationMs: number): Interpretation {
  const speech = frames.filter((f) => f.verdict !== "no-content");
  const weight = (f: VelmaFrame) => Math.max(0, f.end_time_ms - f.start_time_ms);
  const speechMs = speech.reduce((s, f) => s + weight(f), 0);

  if (speech.length === 0 || speechMs === 0) {
    return {
      label: "no-speech", naturalShare: null, speechMs: 0, totalMs: durationMs,
      frameCount: frames.length, speechFrameCount: 0, meanConfidence: null,
    };
  }
  const natural = speech.filter((f) => f.verdict === "non-synthetic").reduce((s, f) => s + weight(f), 0);
  const conf = speech.reduce((s, f) => s + f.confidence * weight(f), 0);
  const naturalShare = natural / speechMs;
  const label: Label =
    naturalShare >= LIKELY_REAL_MIN ? "real" : naturalShare <= LIKELY_SYNTHETIC_MAX ? "synthetic" : "unsure";

  return {
    label, naturalShare, speechMs, totalMs: durationMs,
    frameCount: frames.length, speechFrameCount: speech.length, meanConfidence: conf / speechMs,
  };
}
