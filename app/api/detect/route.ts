import { NextRequest, NextResponse } from "next/server";
import { interpret } from "@/lib/interpret";
import { rateLimit } from "@/lib/rate-limit";
import {
  ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, REQUEST_TIMEOUT_MS, VELMA_BATCH_URL,
  extensionOf, type VelmaResponse,
} from "@/lib/velma";

export const maxDuration = 60;

type ErrorCode =
  | "missing_key" | "rate_limited" | "no_file" | "bad_type" | "too_large" | "too_short"
  | "empty" | "unauthorized" | "forbidden" | "quota" | "busy" | "timeout" | "upstream";

function fail(code: ErrorCode, message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const rl = rateLimit(ip);
  if (!rl.ok) {
    return fail("rate_limited", `Too many requests. Try again in ${rl.retryAfterSec} seconds.`, 429,
      { "Retry-After": String(rl.retryAfterSec) });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("no_file", "Send the audio as multipart form data in a field named \"file\".", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("no_file", "No audio file was received.", 400);
  if (file.size === 0) return fail("empty", "That file is empty.", 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail("too_large", `File is too large. The demo accepts up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, 413);
  }
  const ext = extensionOf(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail("bad_type", `.${ext || "unknown"} is not supported. Use ${ALLOWED_EXTENSIONS.join(", ")}.`, 415);
  }

  const key = process.env.VELMA_API_KEY;
  if (!key) {
    return fail("missing_key", "The server has no VELMA_API_KEY set. Add it to .env.local or your Vercel project settings.", 500);
  }

  // Browser recordings (webm or ogg) are accepted by Velma as they are, so there is no transcoding step.
  const upstream = new FormData();
  upstream.append("upload_file", file, file.name);

  let res: Response;
  try {
    res = await fetch(VELMA_BATCH_URL, {
      method: "POST",
      headers: { "X-API-Key": key },
      body: upstream,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return timedOut
      ? fail("timeout", "Velma took too long to respond. Try a shorter clip.", 504)
      : fail("upstream", "Could not reach Velma. Check your connection and try again.", 502);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch { /* non-JSON error body */ }
    switch (res.status) {
      case 401: return fail("unauthorized", "Velma rejected the API key (401). Check VELMA_API_KEY.", 502);
      case 403: return fail("forbidden", "Velma says this key is not permitted for this model (403).", 502);
      case 413: return fail("too_large", "Velma says the file is too large.", 413);
      case 422: return fail("too_short", detail || "The clip is too short. Velma needs at least 0.5 seconds of audio.", 422);
      case 400: return fail("bad_type", detail || "Velma could not decode that audio.", 400);
      case 429:
        return /credit|monthly/i.test(detail)
          ? fail("quota", detail, 502)
          : fail("busy", "Velma is at its concurrency limit. Try again in a moment.", 429);
      case 504: return fail("timeout", "Velma did not finish in time. Try a shorter clip.", 504);
      default: return fail("upstream", `Velma returned an error (${res.status}).`, 502);
    }
  }

  const data = (await res.json()) as VelmaResponse;
  if (!Array.isArray(data?.frames)) return fail("upstream", "Velma returned an unexpected response.", 502);

  return NextResponse.json({
    filename: data.filename,
    durationMs: data.duration_ms,
    frames: data.frames,
    summary: interpret(data.frames, data.duration_ms),
  });
}
