import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMaskCache } from './mask-cache.ts';

test('mask cache reuses validated snapshot, coalesces concurrent reads, and invalidates on new .env or explicit drop', async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-mask-cache-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const policyDir = path.join(base, 'policy');
  const work = path.join(base, 'work');
  mkdirSync(policyDir);
  mkdirSync(path.join(work, 'sub'), { recursive: true });
  writeFileSync(path.join(policyDir, 'write-guard.json'), JSON.stringify({ secretPaths: ['.env', '.env.*'] }));
  writeFileSync(path.join(work, 'sub/a.txt'), 'hello\n');

  let scans = 0;
  const cache = createMaskCache(policyDir, async root => {
    scans++;
    await new Promise(r => setTimeout(r, 15));
    return { root, masks: [['.env', false]], collapsed: [] };
  });

  // 4 concurrent calls coalesce into 1 scan
  const batch = await Promise.all([cache.get(work), cache.get(work), cache.get(work), cache.get(work)]);
  assert.equal(scans, 1);
  assert.equal(batch[0].root, work);

  // Subsequent call with unchanged directories hits cache without rescanning
  await cache.get(work);
  assert.equal(scans, 1);

  // Creating a new .env inside sub/ updates sub's mtimeNs and forces a rescan
  await new Promise(r => setTimeout(r, 5));
  writeFileSync(path.join(work, 'sub/.env.local'), 'SECRET=1\n');
  await cache.get(work);
  assert.equal(scans, 2);

  // Creating a hardlink inside sub/ also updates sub's mtimeNs and forces a rescan
  await new Promise(r => setTimeout(r, 5));
  linkSync(path.join(work, 'sub/a.txt'), path.join(work, 'sub/b.txt'));
  await cache.get(work);
  assert.equal(scans, 3);

  // Explicit invalidate() forces rescan even with no directory change
  cache.invalidate();
  await cache.get(work);
  assert.equal(scans, 4);
});
