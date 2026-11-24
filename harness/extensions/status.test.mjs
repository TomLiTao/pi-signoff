import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStatusLine, shortCheckpointId, updateProtectedStatus } from './status.ts';

test('status line formats mode, short checkpoint, jobs, rejected count, context %, and web state concisely', () => {
  assert.equal(shortCheckpointId('refs/pi-protected-checkpoints/20261122-120000-deadbeef'), 'deadbeef');
  assert.equal(shortCheckpointId(undefined), undefined);

  assert.equal(
    formatStatusLine({
      mode: 'PLAN',
      checkpointRef: 'refs/pi-protected-checkpoints/20261122-120000-deadbeef',
      activeJobs: 2,
      contextPercent: 42.4,
      webEnabled: false,
      fetchEnabled: false,
    }),
    'PLAN · ckpt deadbeef · 2 jobs · ctx 42% · web off',
  );

  assert.equal(
    formatStatusLine({
      mode: 'WORKFLOW',
      checkpointRef: 'refs/pi-protected-checkpoints/20261122-120000-deadbeef',
      activeJobs: 0,
      rejectedCount: 3,
      contextPercent: 18.2,
      webEnabled: true,
      fetchEnabled: true,
    }),
    'WORKFLOW · ckpt deadbeef · rej:3 · ctx 18%',
  );

  assert.equal(
    formatStatusLine({
      mode: 'READ-ONLY',
      checkpointRef: undefined,
      activeJobs: 0,
      rejectedCount: 0,
      contextPercent: null,
      webEnabled: true,
      fetchEnabled: true,
    }),
    'READ-ONLY · no ckpt',
  );

  let recordedKey;
  let recordedText;
  updateProtectedStatus(
    {
      hasUI: true,
      getContextUsage: () => ({ tokens: 12000, contextWindow: 100000, percent: 12 }),
      ui: { setStatus: (k, v) => { recordedKey = k; recordedText = v; } },
    },
    {
      mode: 'WRITE',
      checkpointRef: 'refs/pi-protected-checkpoints/20261122-120000-1234abcd',
      activeJobs: 1,
      webEnabled: true,
      fetchEnabled: false,
    },
  );
  assert.equal(recordedKey, 'pi-protected');
  assert.equal(recordedText, 'WRITE · ckpt 1234abcd · 1 job · ctx 12% · fetch off');
});
