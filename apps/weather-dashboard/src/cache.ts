/**
 * TTL cache with stale-on-error semantics.
 *
 * Upstream free tiers are rate limited and some of them go down. Serving a
 * ten-minute-old forecast is always better than serving an error page, so an
 * entry stays retrievable well past its TTL and is only handed out stale when
 * a refresh actually fails.
 */

type Entry<T> = {
  value: T;
  storedAt: number;
  expiresAt: number;
};

export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #ttlMs: number;
  readonly #staleMs: number;
  readonly #maxEntries: number;
  #inFlight = new Map<string, Promise<T>>();

  constructor(options: {
    ttlMs: number;
    /** How long past expiry an entry may still be served on error. */
    staleMs?: number;
    maxEntries?: number;
  }) {
    this.#ttlMs = options.ttlMs;
    this.#staleMs = options.staleMs ?? options.ttlMs * 12;
    this.#maxEntries = options.maxEntries ?? 200;
  }

  get(key: string): { value: T; stale: boolean; ageMs: number } | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (now > entry.expiresAt + this.#staleMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return {
      value: entry.value,
      stale: now > entry.expiresAt,
      ageMs: now - entry.storedAt,
    };
  }

  set(key: string, value: T): void {
    if (this.#entries.size >= this.#maxEntries) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    const now = Date.now();
    this.#entries.set(key, {
      value,
      storedAt: now,
      expiresAt: now + this.#ttlMs,
    });
  }

  /**
   * Fetch through the cache. Concurrent callers for the same key share one
   * upstream request, so a page refresh storm cannot multiply API usage.
   */
  async resolve(key: string, load: () => Promise<T>): Promise<{
    value: T;
    fromCache: boolean;
    stale: boolean;
  }> {
    const hit = this.get(key);
    if (hit && !hit.stale) {
      return { value: hit.value, fromCache: true, stale: false };
    }

    const existing = this.#inFlight.get(key);
    if (existing) {
      return { value: await existing, fromCache: true, stale: false };
    }

    const promise = load();
    this.#inFlight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, fromCache: false, stale: false };
    } catch (error) {
      if (hit) return { value: hit.value, fromCache: true, stale: true };
      throw error;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#inFlight.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
