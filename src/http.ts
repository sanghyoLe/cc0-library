import type { FetchLike } from "./types.js";

/**
 * Poly Haven's API terms require a User-Agent that names the calling app.
 * Openverse also asks clients to identify themselves.
 */
export const USER_AGENT = "cc0-library-mcp/0.2.10 (+https://github.com/sanghyoLe/cc0-library)";

const TIMEOUT_MS = 15_000;

export class UpstreamError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    url: string,
  ) {
    super(`${provider} returned HTTP ${status} for ${url}`);
  }
}

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init?.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

/** Gateway errors that upstreams (notably Openverse) return transiently under load. */
const RETRYABLE = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 500;

/** GETs JSON. Retries once on a gateway error; any other non-2xx status throws UpstreamError. */
export async function getJson<T>(fetchImpl: FetchLike, provider: string, url: string, headers?: Record<string, string>): Promise<T> {
  const init = headers ? { headers } : undefined;
  let res = await fetchImpl(url, init);
  if (RETRYABLE.has(res.status)) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await fetchImpl(url, init);
  }
  if (!res.ok) throw new UpstreamError(provider, res.status, url);
  return (await res.json()) as T;
}
