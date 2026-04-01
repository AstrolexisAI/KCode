// Lazy Loader — Defers module imports until first access.
// Cache ensures each module is loaded only once.

const moduleCache = new Map<string, unknown>();

/**
 * Creates a lazy import function that defers `require()` until first call.
 * Result is cached so subsequent calls are instant.
 *
 * Usage:
 *   const getDb = lazyRequire<typeof import('./db')>('./db');
 *   // ... later, when actually needed:
 *   const db = getDb();
 */
export function lazyRequire<T>(modulePath: string): () => T {
  return () => {
    if (!moduleCache.has(modulePath)) {
      moduleCache.set(modulePath, require(modulePath));
    }
    return moduleCache.get(modulePath) as T;
  };
}

/**
 * Creates an async lazy import that defers `import()` until first call.
 * Result is cached. Ideal for heavy modules not needed at startup.
 *
 * Usage:
 *   const getLsp = lazyImport(() => import('./lsp'));
 *   // ... later:
 *   const lsp = await getLsp();
 */
export function lazyImport<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: T | undefined;
  let pending: Promise<T> | undefined;

  return () => {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;
    pending = factory().then((m) => {
      cached = m;
      pending = undefined;
      return m;
    });
    return pending;
  };
}

/** Clear cache (for testing) */
export function _resetLazyCache(): void {
  moduleCache.clear();
}
