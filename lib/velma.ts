// Everything here follows Modulate's published Deepfake Detection batch reference:
// https://docs.modulate.ai/api-reference/svd/batch
// https://docs.modulate.ai/get-started/deepfake

export const VELMA_BATCH_URL =
  "https://platform.modulate.ai/api/velma-2-synthetic-voice-detection-batch";

export type Verdict = "synthetic" | "non-synthetic" | "no-content";

export interface VelmaFrame {
  start_time_ms: number;
  end_time_ms: number;
  verdict: Verdict;
  /** Confidence in the verdict given, not the probability that the audio is synthetic. */
  confidence: number;
}

export interface VelmaResponse {
  filename: string | null;
  duration_ms: number;
  frames: VelmaFrame[];
}

/** Batch endpoint accepts many extensions; this is the common subset the demo allows. */
export const ALLOWED_EXTENSIONS = [
  "wav", "mp3", "flac", "m4a", "mp4", "ogg", "opus", "webm", "aac", "aiff",
] as const;

/**
 * Vercel serverless functions reject request bodies above 4.5 MB, so the demo caps
 * uploads at 4 MB. Velma itself accepts up to 100 MB.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 45_000;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}
