/**
 * Verrou d’exécution : sans Redis, exécute fn() immédiatement (pas de lock distribué).
 */

export async function withExecutionLock<T>(_ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  return fn();
}

export async function getLogEntries(_limit: number = 100): Promise<Record<string, unknown>[]> {
  return [];
}
