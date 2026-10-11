import { ModelConnectionError } from "./types.js";

export type ModelFetch = typeof fetch;
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Bound the complete body as well as headers; never return remote error bodies. */
export async function modelRequest(
  url: string,
  init: RequestInit = {},
  fetcher: ModelFetch = fetch,
  limit = 4 * 1024 * 1024,
): Promise<{ response: Response; text: string }> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelConnectionError(
        response.status === 401
          ? "MODEL_AUTH_REQUIRED"
          : response.status === 403
            ? "MODEL_PERMISSION_DENIED"
            : response.status === 429
              ? "MODEL_QUOTA_EXCEEDED"
              : "MODEL_SOURCE_UNAVAILABLE",
        response.status === 429 ? 429 : 502,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return { response, text: "" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit)
          throw new ModelConnectionError("MODEL_RESPONSE_TOO_LARGE", 502);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    if (error instanceof ModelConnectionError) throw error;
    throw new ModelConnectionError("MODEL_SOURCE_UNAVAILABLE", 502);
  }
}
export function parseObject(text: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(text);
    if (record(data)) return data;
  } catch {
    /* Invalid upstream JSON. */
  }
  throw new ModelConnectionError("MODEL_INVALID_RESPONSE", 502);
}
