// In-memory sliding window. Fine for a starter and a single instance.
// On serverless hosts each instance keeps its own counter, so treat it as a
// courtesy limit and swap in Redis or Upstash for production.
const WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_WINDOW = 6;

const hits = new Map<string, number[]>();

export function rateLimit(ip: string, now = Date.now()) {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    hits.set(ip, recent);
    return { ok: false as const, retryAfterSec: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return { ok: true as const };
}
