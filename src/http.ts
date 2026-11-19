import type { FetchLike } from "./types.js";

/**
 * Poly Haven's API terms require a User-Agent that names the calling app.
 * Openverse also asks clients to identify themselves.
 */
export const USER_AGENT = "cc0-library-mcp/0.1.0 (+https://github.com/sanghyoLe/cc0-library)";

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

export async function getJson<T>(fetchImpl: FetchLike, provider: string, url: string): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new UpstreamError(provider, res.status, url);
  return (await res.json()) as T;
}
