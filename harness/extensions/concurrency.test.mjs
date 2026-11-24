import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolGate } from './concurrency.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('three parallel reads finish in well under 1.5x single read and cap at 4 readers', async () => {
  const gate = createToolGate(4);
  const t1 = performance.now();
  await gate.runRead(() => sleep(60));
  const single = performance.now() - t1;

  let concurrent = 0;
  let peak = 0;
  const t3 = performance.now();
  await Promise.all([1, 2, 3].map(() => gate.runRead(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    assert.ok(gate.pendingCount() >= 1);
    await sleep(60);
    concurrent--;
  })));
  const three = performance.now() - t3;
  assert.equal(peak, 3);
  assert.ok(three < single * 1.5, `Expected 3 parallel reads (${three.toFixed(1)}ms) < 1.5x single (${single.toFixed(1)}ms)`);

  // Verify cap at 4 when 7 reads run together
  peak = 0;
  await Promise.all(Array.from({ length: 7 }, () => gate.runRead(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await sleep(25);
    concurrent--;
  })));
  assert.equal(peak, 4);
  assert.equal(gate.pendingCount(), 0);
});

test('read-after-write and write-after-read preserve strict ordering without overlap', async () => {
  const gate = createToolGate(4);
  const log = [];
  let value = 'initial';

  const r1 = gate.runRead(async () => {
    log.push('r1:start');
    await sleep(30);
    log.push(`r1:end:${value}`);
    return value;
  });
  const r2 = gate.runRead(async () => {
    log.push('r2:start');
    await sleep(20);
    log.push(`r2:end:${value}`);
    return value;
  });
  const w1 = gate.runWrite(async () => {
    assert.equal(gate.activeReaders(), 0);
    log.push('w1:start');
    await sleep(20);
    value = 'updated';
    log.push('w1:end');
  });
  const r3 = gate.runRead(async () => {
    assert.equal(gate.isWriting(), false);
    log.push(`r3:${value}`);
    return value;
  });

  assert.equal(gate.pendingCount(), 4);
  const results = await Promise.all([r1, r2, w1, r3]);
  assert.equal(results[0], 'initial');
  assert.equal(results[1], 'initial');
  assert.equal(results[3], 'updated');
  assert.equal(log.indexOf('w1:start') > log.indexOf('r1:end:initial'), true);
  assert.equal(log.indexOf('w1:start') > log.indexOf('r2:end:initial'), true);
  assert.equal(log.indexOf('r3:updated') > log.indexOf('w1:end'), true);
  assert.equal(gate.pendingCount(), 0);
});
