import { setTimeout as wait } from 'node:timers/promises';

export interface SearchInput { query: string; limit: number; site?: string; time?: 'day' | 'week' | 'month' | 'year' }
interface SearchResult {
  error?: string;
  retry_seconds?: number;
  upstream_failure?: boolean;
  retryable?: boolean;
  results?: unknown[];
}

const RETRY_DELAYS_MS = [500, 1500];

export function createSearchRouter(braveFallback: boolean,
  lookup: (mode: 'search' | 'mwmbl' | 'brave', input: SearchInput, signal?: AbortSignal) => Promise<SearchResult>,
  now = () => performance.now(),
  pause: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => wait(ms, undefined, { signal }),
  mwmblFallback = false) {
  let cooldownUntil = 0;
  let mwmblCooldownUntil = 0;
  return async (input: SearchInput, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('Search aborted.');
    if (!input.query.trim()) throw new Error('Enter a public search query.');
    let failure = 'DuckDuckGo is cooling down';
    for (let attempt = 0; now() >= cooldownUntil; attempt++) {
      if (signal?.aborted) throw new Error('Search aborted.');
      const result = await lookup('search', input, signal);
      if (!result.error) return { provider: 'DuckDuckGo', results: result.results ?? [], fallback: false, notes: [] as string[] };
      const delay = result.retry_seconds;
      if (typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 1) {
        cooldownUntil = Math.max(cooldownUntil, now() + delay * 1000);
        failure = 'DuckDuckGo is cooling down';
        break;
      }
      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (result.upstream_failure === true && result.retryable === true && retryDelay !== undefined) {
        await pause(retryDelay, signal);
        continue;
      }
      if (result.upstream_failure !== true) throw new Error(result.error);
      failure = result.error.replace(/\.$/, '');
      break;
    }
    const remaining = () => Math.max(1, Math.ceil((cooldownUntil - now()) / 1000));
    const notes: string[] = [];
    if (mwmblFallback && input.time) {
      // Mwmbl has no time filter; returning undated results for a time-filtered query would mislead.
      failure += '; Mwmbl skipped (no time filter)';
      notes.push('Mwmbl skipped: it cannot filter by time');
    } else if (mwmblFallback) {
      if (signal?.aborted) throw new Error('Search aborted.');
      if (now() >= mwmblCooldownUntil) {
        // This public API is a best-effort fallback, not a bulk search backend.
        mwmblCooldownUntil = now() + 2000;
        const result = await lookup('mwmbl', input, signal);
        const delay = result.retry_seconds;
        if (typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 1) {
          mwmblCooldownUntil = Math.max(mwmblCooldownUntil, now() + delay * 1000);
        }
        if (!result.error && result.results?.length) {
          return { provider: 'Mwmbl', results: result.results, fallback: true, notes };
        }
        failure += result.error ? `; ${result.error.replace(/\.$/, '')}` : '; Mwmbl returned no usable results';
      } else {
        failure += '; Mwmbl is cooling down';
      }
    }
    if (!braveFallback) {
      const advice = now() < cooldownUntil ? `Try in ${remaining()} seconds, or fetch` : 'Try again later, or fetch';
      throw new Error(`${failure}. ${advice} a known public URL.`);
    }
    if (signal?.aborted) throw new Error('Search aborted.');
    const result = await lookup('brave', input, signal);
    if (result.error) throw new Error(`${failure}; ${result.error}`);
    return { provider: 'Brave', results: result.results ?? [], fallback: true, notes };
  };
}
