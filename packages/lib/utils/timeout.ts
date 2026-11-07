/**
 * Race a promise against a timeout. Returns `null` if the timeout
 * fires before the promise settles.
 */
export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) =>
  await Promise.race<T | null>([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);

/**
 * Wrapper around `fetch` that aborts the request after `timeoutMs`.
 * Throws with a descriptive message when the headers do not arrive in time.
 *
 * The deadline covers the whole exchange, body included (DEV-18278): the
 * timer is not cleared when the headers arrive, so a server that stalls
 * mid-body makes the caller's `response.text()` / `.json()` reject instead
 * of hanging. Aborting after the body has been read is a no-op, and the
 * timer is unref'd so it never holds the process open.
 */
export const fetchWithTimeout = async (input: string | URL | Request, init: RequestInit & { timeoutMs: number }) => {
  const { timeoutMs, ...fetchInit } = init;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  timeout.unref?.();

  try {
    return await fetch(input, { ...fetchInit, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }
};
