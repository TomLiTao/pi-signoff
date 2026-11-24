import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchRouter } from './search-router.ts';

const input = { query: 'public information', limit: 3 };
const throttled = { error: 'challenge', retry_seconds: 30 };

test('DuckDuckGo cooldown does not send a query to Brave when fallback is disabled', async () => {
  const calls = [];
  let time = 1000;
  const search = createSearchRouter(false, async mode => {
    calls.push(mode);
    return calls.length === 1 ? throttled : { results: [] };
  }, () => time);
  await assert.rejects(search(input), /Try in 30 seconds/);
  time += 10_000;
  await assert.rejects(search(input), /Try in 20 seconds/);
  time += 20_000;
  assert.equal((await search(input)).provider, 'DuckDuckGo');
  assert.deepEqual(calls, ['search', 'search']);
});

test('fallback skips Brave on success or local errors and uses it during challenges or cooldown', async () => {
  const calls = [];
  let time = 1000;
  const search = createSearchRouter(true, async (mode, request) => {
    assert.equal(request, input);
    calls.push(mode);
    if (mode === 'brave') return { results: ['example'] };
    if (calls.length === 1) return { results: [] };
    if (calls.length === 2) return { error: 'invalid request' };
    return throttled;
  }, () => time);
  assert.equal((await search(input)).provider, 'DuckDuckGo');
  await assert.rejects(search(input), /invalid request/);
  assert.deepEqual(await search(input), { provider: 'Brave', results: ['example'], fallback: true, notes: [] });
  assert.equal((await search(input)).provider, 'Brave');
  await assert.rejects(search(input, AbortSignal.abort()), /aborted/);
  assert.deepEqual(calls, ['search', 'search', 'search', 'brave', 'brave']);
  time += 30_000;
  await search(input);
  assert.deepEqual(calls.slice(-2), ['search', 'brave']);
});

test('a non-retryable upstream failure falls back once and does not start a cooldown', async () => {
  const calls = [];
  const search = createSearchRouter(true, async mode => {
    calls.push(mode);
    if (calls.length === 1) return { error: 'DuckDuckGo search failed (HTTP 404).', upstream_failure: true };
    if (mode === 'brave') return { results: ['example'] };
    return { results: [] };
  });
  assert.equal((await search(input)).provider, 'Brave');
  assert.equal((await search(input)).provider, 'DuckDuckGo');
  assert.deepEqual(calls, ['search', 'brave', 'search']);
});

const transient = { error: 'DuckDuckGo timed out', upstream_failure: true, retryable: true };

for (const [label, fallback, final, expected] of [
  ['recovers before Brave', true, { results: ['recovered'] }, ['search', 'search', 'search']],
  ['falls back only after exhausting retries', true, transient, ['search', 'search', 'search', 'brave']],
  ['retries even with Brave disabled', false, transient, ['search', 'search', 'search']],
]) {
  test(`transient DuckDuckGo failure ${label}`, async () => {
    const calls = [];
    const delays = [];
    const search = createSearchRouter(fallback, async mode => {
      calls.push(mode);
      if (mode === 'brave') return { results: ['fallback'] };
      return calls.length < 3 ? transient : final;
    }, () => 1000, async ms => { delays.push(ms); });
    if (!fallback) await assert.rejects(search(input), /timed out/);
    else assert.equal((await search(input)).provider, expected.at(-1) === 'brave' ? 'Brave' : 'DuckDuckGo');
    assert.deepEqual(calls, expected);
    assert.deepEqual(delays, [500, 1500]);
  });
}

test('a challenge during retries skips further DuckDuckGo attempts', async () => {
  const calls = [];
  const search = createSearchRouter(true, async mode => {
    calls.push(mode);
    if (mode === 'brave') return { results: [] };
    return calls.length === 1 ? transient : throttled;
  }, () => 1000, async () => {});
  assert.equal((await search(input)).provider, 'Brave');
  assert.deepEqual(calls, ['search', 'search', 'brave']);
});

test('cancelling a retry delay does not contact either provider again', async () => {
  const controller = new AbortController();
  const calls = [];
  const search = createSearchRouter(true, async mode => {
    calls.push(mode);
    setImmediate(() => controller.abort());
    return transient;
  });
  await assert.rejects(search(input, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, ['search']);
});

test('Mwmbl follows DuckDuckGo retries and usable results prevent a Brave lookup', async () => {
  const calls = [];
  const search = createSearchRouter(true, async (mode, request) => {
    assert.equal(request, input);
    calls.push(mode);
    return mode === 'search' ? transient : { results: ['useful'] };
  }, () => 1000, async () => {}, true);
  assert.deepEqual(await search(input), { provider: 'Mwmbl', results: ['useful'], fallback: true, notes: [] });
  assert.deepEqual(calls, ['search', 'search', 'search', 'mwmbl']);
});

for (const intermediate of [{ results: [] }, { error: 'Mwmbl unavailable' }]) {
  test(`Mwmbl ${intermediate.error ? 'failure' : 'empty result'} falls through to budget-gated Brave`, async () => {
    const calls = [];
    const search = createSearchRouter(true, async mode => {
      calls.push(mode);
      return mode === 'search' ? throttled : mode === 'mwmbl' ? intermediate : { error: 'Brave free-usage cap reached' };
    }, () => 1000, undefined, true);
    await assert.rejects(search(input), /Brave free-usage cap reached/);
    assert.deepEqual(calls, ['search', 'mwmbl', 'brave']);
  });
}

test('Mwmbl has an independent cooldown and works with Brave disabled', async () => {
  const calls = [];
  let time = 1000;
  const search = createSearchRouter(false, async mode => {
    calls.push(mode);
    if (mode === 'search') return throttled;
    return calls.length === 2 ? { error: 'Mwmbl asked Pi to back off', retry_seconds: 10 } : { results: ['ok'] };
  }, () => time, undefined, true);
  await assert.rejects(search(input), /Mwmbl asked Pi to back off/);
  time += 9000;
  await assert.rejects(search(input), /Mwmbl is cooling down/);
  time += 1000;
  assert.equal((await search(input)).provider, 'Mwmbl');
  await assert.rejects(search(input), /Mwmbl is cooling down/);
  assert.deepEqual(calls, ['search', 'mwmbl', 'mwmbl']);
});

test('Mwmbl opt-in does not change the behavior of an empty DuckDuckGo success', async () => {
  const calls = [];
  const search = createSearchRouter(true, async mode => {
    calls.push(mode);
    return { results: [] };
  }, undefined, undefined, true);
  assert.equal((await search(input)).provider, 'DuckDuckGo');
  assert.deepEqual(calls, ['search']);
});

test('cancelling a Mwmbl lookup does not proceed to Brave', async () => {
  const controller = new AbortController();
  const calls = [];
  const search = createSearchRouter(true, async mode => {
    calls.push(mode);
    if (mode === 'search') return throttled;
    controller.abort();
    return { results: [] };
  }, undefined, undefined, true);
  await assert.rejects(search(input, controller.signal), /aborted/);
  assert.deepEqual(calls, ['search', 'mwmbl']);
});
