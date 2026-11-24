import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRewindTargets, checkpointEntryType, registerCheckpoints } from './checkpoints.ts';

test('buildRewindTargets maps user turns to pre-mutation checkpoints and surfaces safety checkpoints', () => {
  const launch = 'refs/pi-protected-checkpoints/20261122-100000-0000aaaa';
  const r1 = 'refs/pi-protected-checkpoints/20261122-100100-0001bbbb';
  const r3 = 'refs/pi-protected-checkpoints/20261122-100300-0003cccc';
  const safety = 'refs/pi-protected-checkpoints/20261122-100400-0004dddd';

  const branch = [
    { id: 'u1', type: 'message', message: { role: 'user', content: 'Edit config' } },
    { id: 'c1', type: 'custom', customType: checkpointEntryType, data: { entryId: 'u1', ref: r1, kind: 'turn' } },
    { id: 'a1', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
    // Turn 2 is read-only (no checkpoint of its own; state before Turn 2 == state before Turn 3 == r3)
    { id: 'u2', type: 'message', message: { role: 'user', content: 'Read README' } },
    { id: 'a2', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Read it' }] } },
    { id: 'u3', type: 'message', message: { role: 'user', content: 'Run migration' } },
    { id: 'c3', type: 'custom', customType: checkpointEntryType, data: { entryId: 'u3', ref: r3, kind: 'turn' } },
    { id: 'cs', type: 'custom', customType: checkpointEntryType, data: { entryId: null, ref: safety, kind: 'safety' } },
  ];

  const targets = buildRewindTargets(branch, launch);
  assert.equal(targets[0].ref, safety);
  assert.match(targets[0].label, /Undo previous rewind/);
  assert.equal(targets[1].entryId, 'u3');
  assert.equal(targets[1].ref, r3);
  assert.equal(targets[2].entryId, 'u2');
  assert.equal(targets[2].ref, r3);
  assert.equal(targets[3].entryId, 'u1');
  assert.equal(targets[3].ref, r1);
  assert.equal(targets[4].ref, launch);
});

test('per-turn checkpoint runs once per turn, falls back to read-only on failure, and /rewind supports files/conv/both', async () => {
  const cwd = process.cwd();
  const commands = new Map();
  const hooks = new Map();
  const appended = [];
  const calls = [];
  let failCreate = false;

  const mgr = registerCheckpoints(
    {
      registerCommand: (name, cmd) => commands.set(name, cmd.handler),
      on: (name, fn) => hooks.set(name, fn),
      appendEntry: (type, data) => appended.push({ type, data }),
    },
    {
      dir: cwd,
      launchRef: 'refs/pi-protected-checkpoints/20261122-100000-00001111',
      writeRoot: cwd,
      isPlanning: () => false,
      hasPendingWork: () => false,
      onCheckpointChange() {},
      onFilesRestored() {},
      async execCheckpoint(args) {
        calls.push(args);
        if (args[0] === 'create' && failCreate) throw new Error('disk full');
        if (args[0] === 'create') return 'refs/pi-protected-checkpoints/20261122-100100-00012222';
        if (args[0] === 'restore') return 'refs/pi-protected-checkpoints/20261122-100200-00023333';
        return '';
      },
    },
  );

  const branch = [
    { id: 'u1', type: 'message', message: { role: 'user', content: 'First prompt' } },
  ];
  const notes = [];
  const navigated = [];
  let choices = [];
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch, getLeafId: () => 'u1' },
    navigateTree: async id => { navigated.push(id); return { cancelled: false }; },
    fork: async () => ({ cancelled: false }),
    ui: {
      notify: msg => notes.push(msg),
      select: async () => choices.shift(),
    },
  };

  // First mutation in turn creates 1 checkpoint; second mutation in same turn reuses it
  assert.equal(await mgr.ensureMutationCheckpoint(ctx, 'turn'), true);
  assert.equal(await mgr.ensureMutationCheckpoint(ctx, 'turn'), true);
  assert.equal(calls.length, 1);
  assert.equal(appended.length, 1);
  branch.push({ id: 'c1', type: 'custom', customType: checkpointEntryType, data: appended[0].data });

  // Next turn fails checkpoint -> falls back to read-only for the turn
  await hooks.get('before_agent_start')();
  failCreate = true;
  assert.equal(await mgr.ensureMutationCheckpoint(ctx, 'turn'), false);
  assert.equal(mgr.isTurnReadOnlyFallback(), true);
  assert.match(notes.at(-1), /read-only/);

  // Test /rewind "Both (files and conversation)"
  const targets = buildRewindTargets(branch, 'refs/pi-protected-checkpoints/20261122-100000-00001111');
  choices = [targets[0].label, 'Both (files and conversation)'];
  await commands.get('rewind')('', ctx);
  assert.deepEqual(calls.at(-1), ['restore', cwd, 'refs/pi-protected-checkpoints/20261122-100100-00012222']);
  assert.deepEqual(navigated, ['u1']);
  assert.equal(appended.at(-1).data.kind, 'safety');
  assert.match(notes.at(-1), /Rewind complete/);
});

test('numstat output parses into a sanitized change summary', async () => {
  const { parseNumstat } = await import('./checkpoints.ts');
  assert.deepEqual(parseNumstat('{"files":[{"path":"a\\u001b.py","added":2,"removed":1,"binary":false},{"bad":1}],"total":2}'),
    { files: [{ path: 'a?.py', added: 2, removed: 1, binary: false }], total: 2 });
  assert.equal(parseNumstat('not json'), undefined);
});
