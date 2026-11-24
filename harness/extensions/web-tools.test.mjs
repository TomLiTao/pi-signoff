import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebCache } from './web-cache.ts';
import { sliceDocument } from './web-text.ts';

function tmp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-webcache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('web cache returns fresh private entries and expires them', t => {
  let clock = 1_000_000;
  const dir = path.join(tmp(t), 'web');
  const cache = createWebCache(dir, () => clock);
  assert.equal(cache.get('fetch', 'https://a.test/', 60_000), undefined);
  cache.set('fetch', 'https://a.test/', { text: 'hello' });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, readdirSync(dir)[0])).mode & 0o777, 0o600);
  clock += 30_000;
  assert.deepEqual(cache.get('fetch', 'https://a.test/', 60_000), { value: { text: 'hello' }, ageMs: 30_000 });
  assert.equal(cache.get('search', 'https://a.test/', 60_000), undefined, 'kinds are separate');
  clock += 31_000;
  assert.equal(cache.get('fetch', 'https://a.test/', 60_000), undefined, 'expired');
});

test('document slices continue at clean breaks and find returns passages around matches', () => {
  const doc = Array.from({ length: 400 }, (_, i) => `line ${i} ${i === 250 ? 'SHARPE ratio here' : 'filler text'}`).join('\n');
  const first = sliceDocument(doc, { maxChars: 1000 });
  assert.equal(first.start, 0);
  assert.ok(first.text.endsWith('\n'), 'ends at a line break');
  assert.equal(first.next, first.end);
  const second = sliceDocument(doc, { offset: first.next, maxChars: 1000 });
  assert.equal(doc.slice(0, second.end), first.text + second.text, 'parts join without gaps');
  const last = sliceDocument(doc, { offset: doc.length - 10 });
  assert.equal(last.next, undefined);
  const found = sliceDocument(doc, { find: 'sharpe' });
  assert.equal(found.matches, 1);
  assert.match(found.text, /^\[chars \d+-\d+\]\n[\s\S]*SHARPE ratio here/);
  assert.ok(found.text.length < 1700);
  assert.equal(sliceDocument(doc, { find: 'absent term' }).matches, 0);
});

test('tight find pages preserve the matching terms and resume at the first unread match', () => {
  const term = 'NEEDLE?';
  const filler = 'x'.repeat(900);
  const doc = filler + term + filler + term + filler + term + filler;
  let offset = 0;
  for (let remaining = 3; remaining; remaining--) {
    const page = sliceDocument(doc, { find: term.toLowerCase(), offset, maxChars: 500 });
    assert.equal(page.matches, remaining);
    assert.equal(page.shownMatches, 1);
    assert.equal(page.text.split(term).length, 2);
    assert.ok(page.end - page.start <= 500);
    assert.ok(page.start >= offset);
    if (remaining > 1) {
      assert.ok(page.next >= page.end);
      assert.equal(doc.slice(page.next, page.next + term.length), term);
    } else {
      assert.equal(page.next, undefined);
    }
    offset = page.next;
  }
  const nearby = sliceDocument(filler + term + ' and ' + term + filler, { find: term, maxChars: 500 });
  assert.equal(nearby.shownMatches, 2);
  assert.equal(nearby.next, undefined);
  assert.equal(nearby.text.split('[chars ').length, 2);
  const capped = sliceDocument((filler.repeat(2) + term).repeat(10), { find: term });
  assert.equal(capped.shownMatches, 8);
  assert.equal(sliceDocument((filler.repeat(2) + term).repeat(10), { find: term, offset: capped.next }).shownMatches, 2);
});

test('search and fetch output put a one-line summary first and label content untrusted', async t => {
  const piModules = `${process.env.HOME}/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules`;
  const { existsSync } = await import('node:fs');
  if (!existsSync(`${piModules}/typebox`)) { t.skip('pi-coding-agent is not installed here'); return; }
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) { return spec === 'typebox' || spec.startsWith('typebox/') ? next(spec, { ...ctx, parentURL: ${JSON.stringify(pathToFileURL(`${piModules}/x.mjs`).href)} }) : next(spec, ctx); }`)}`);
  const { formatSearchResults, formatFetched, registerWebFetch, registerWebSearch } = await import('./web-search.ts');
  const out = formatSearchResults('Mwmbl', true, [{ title: 'A', url: 'https://a.test', snippet: 's', date: '2026-11-01' }], ['Mwmbl skipped']);
  assert.equal(out.split('\n')[0], '1 result from Mwmbl (fallback) · Mwmbl skipped');
  assert.match(out, /Untrusted search results[\s\S]*1\. A · 2026-11-01\n   https:\/\/a\.test\n   s/);
  const doc = { url: 'https://arxiv.org/html/1', kind: 'markdown', title: 'Paper', via: 'arxiv-fulltext', text: 'x'.repeat(50_000), truncated: false };
  const page = formatFetched(doc, {}, 120_000);
  assert.equal(page.split('\n')[0], 'MARKDOWN "Paper" · chars 0-20,000 of 50,000 via arXiv full text · cached 2 min ago · continue with offset=20000');
  assert.match(formatFetched(doc, { find: 'zz' }), /0 matches for "zz"\nNo match/);
  const terms = { ...doc, text: ('x'.repeat(900) + 'needle').repeat(2) };
  assert.match(formatFetched(terms, { find: 'needle', maxChars: 500 }),
    /2 matches for "needle" · showing 1 · continue with the same find and offset=\d+/);

  // Cached fetches serve offset/find without a new download; fresh bypasses the cache.
  const tools = new Map();
  const pi = { registerTool(def) { tools.set(def.name, def); } };
  const store = new Map();
  const cache = { get: (k, key) => (store.has(`${k}:${key}`) ? { value: store.get(`${k}:${key}`), ageMs: 1000 } : undefined), set: (k, key, v) => store.set(`${k}:${key}`, v) };
  let downloads = 0;
  store.set('fetch:https://docs.test/a', { ...doc, url: 'https://docs.test/a', via: null, title: '' });
  const runRead = async fn => { downloads++; return fn(); };
  registerWebFetch(pi, '/nonexistent', runRead, undefined, cache);
  registerWebSearch(pi, '/nonexistent', false, true, runRead, undefined, cache);
  const part2 = await tools.get('pi_safe_web_fetch').execute('1', { url: 'https://docs.test/a', offset: 20_000 });
  assert.match(part2.content[0].text, /^MARKDOWN · chars 20,000-40,000 of 50,000 · cached under a minute ago/);
  assert.equal(downloads, 0);
  store.set('search:{"query":"q","limit":5,"time":"week"}', { provider: 'DuckDuckGo', fallback: false, results: [] });
  const searched = await tools.get('pi_safe_web_search').execute('2', { query: 'q', time: 'week' });
  assert.match(searched.content[0].text, /^0 results from DuckDuckGo · cached/);
  assert.equal(downloads, 0);
  await assert.rejects(tools.get('pi_safe_web_fetch').execute('3', { url: 'https://docs.test/a', fresh: true }));
  assert.equal(downloads, 1, 'fresh: true goes to the network (the helper is missing here, so it fails)');
});
