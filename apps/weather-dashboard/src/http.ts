/** Small fetch wrapper: timeouts, one retry on transient failure, and errors
 * that say which upstream broke and how. No dependencies. */

export class UpstreamError extends Error {
  readonly status: number | undefined;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.url = url;
    this.status = status;
  }
}

export type FetchJsonOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retry once on network error / 429 / 5xx. Defaults to true. */
  retry?: boolean;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 12_000;

const isRetryable = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchOnce = async (
  url: string,
  options: FetchJsonOptions,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("timeout")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  // Caller-supplied cancellation must also tear down our timer.
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await fetch(url, {
      headers: { accept: "application/json", ...options.headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
};

const requestText = async (
  url: string,
  options: FetchJsonOptions,
): Promise<string> => {
  const attempts = options.retry === false ? 1 : 2;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const response = await fetchOnce(url, options);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new UpstreamError(
          `HTTP ${response.status} ${response.statusText}${
            body ? `: ${body.slice(0, 200)}` : ""
          }`,
          url,
          response.status,
        );
        if (attempt + 1 < attempts && isRetryable(response.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }
      return await response.text();
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      lastError = error;
      if (attempt + 1 >= attempts) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new UpstreamError(`network failure: ${reason}`, url);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new UpstreamError(`request failed: ${reason}`, url);
};

export const fetchJson = async <T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> => {
  const text = await requestText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(
      `response was not JSON (starts with ${JSON.stringify(text.slice(0, 60))})`,
      url,
    );
  }
};

export const fetchText = (
  url: string,
  options: FetchJsonOptions = {},
): Promise<string> =>
  requestText(url, { ...options, headers: { accept: "*/*", ...options.headers } });

/** Build a query string, dropping undefined/null so adapters can stay terse. */
export const buildUrl = (
  base: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};
