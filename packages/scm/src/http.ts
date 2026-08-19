/**
 * A tiny fetch wrapper shared by every driver. Not a generic HTTP client — just the two things
 * every provider call needs: throw a typed `ScmProviderError` on a non-2xx response (so a
 * caller never has to remember to check `res.ok`), and never let the token leak into the error
 * message.
 */
import { type ScmProvider, ScmProviderError } from "./types.js";

export async function scmFetch(
  provider: ScmProvider,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // The body sometimes carries a useful reason ("Not Found", "401 Unauthorized"); the request
    // headers (which hold the token) never do, because they are never included here.
    const body = await res.text().catch(() => "");
    throw new ScmProviderError(
      provider,
      `${provider} request to ${url} failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}
