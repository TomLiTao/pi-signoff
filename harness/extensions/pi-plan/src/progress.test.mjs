import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanStepText, extractPlanSteps } from './planner.ts';
import { isPlanPausedText, markCompletedSteps, settledPlanOutcome, transformDoneMarkers } from './progress.ts';

const step = { step: 1, text: 'Run the tests', completed: false };
const reply = (text, stopReason = 'stop') => ({ stopReason, text });

test('a settled execution closes even when the last reply omits DONE markers', () => {
  assert.equal(settledPlanOutcome([step], reply('The test suite passed.')), 'ended');
  assert.equal(step.completed, false);
});

test('all confirmed steps produce a completion result', () => {
  assert.equal(settledPlanOutcome([{ ...step, completed: true }], reply('The tests passed.')), 'complete');
});

test('paused, interrupted, and unfinished executions stay active', () => {
  for (const lastReply of [undefined, reply(''), reply('Waiting.\n[PLAN:PAUSED]'),
    reply('Failed.', 'error'), reply('Stopped.', 'aborted'), reply('Checking.', 'toolUse')]) {
    assert.equal(settledPlanOutcome([step], lastReply), undefined);
  }
});

test('isPlanPausedText matches standalone [PLAN:PAUSED] lines and ignores inline prose mentions', () => {
  assert.equal(isPlanPausedText('Blocker explained.\n  [plan:paused]  \n'), true);
  assert.equal(isPlanPausedText('Do not emit [PLAN:PAUSED] unless blocked.'), false);
});

test('plan state and rendering both ignore fenced examples and inline code', () => {
  const examples = [
    '````md', '```', '[DONE:1]', '[PLAN:PAUSED]', '````',
    '~~~text', '[DONE:1]', '[PLAN:PAUSED]', '~~~',
    'Say `[DONE:1]` or ```[DONE:1]``` inline.',
    'A code span `across', '[PLAN:PAUSED]', 'lines`.',
  ].join('\n');
  const steps = [{ ...step }];
  assert.equal(transformDoneMarkers(examples), examples);
  assert.equal(markCompletedSteps(examples, steps), 0);
  assert.equal(isPlanPausedText(examples), false);
  assert.equal(settledPlanOutcome(steps, reply(examples)), 'ended');
  assert.equal(markCompletedSteps(examples + '\nChecked [done:1].', steps), 1);
  assert.equal(isPlanPausedText(examples + '\n  [plan:paused]\r\n'), true);
  assert.equal(settledPlanOutcome(steps, reply(examples)), 'complete');
});

test('transformDoneMarkers renders [DONE:n] and standalone [PLAN:PAUSED] badges outside fenced code blocks', () => {
  const md = 'Step done [DONE:1]\n  [PLAN:PAUSED]  \n```md\n[DONE:2]\n[PLAN:PAUSED]\n```';
  assert.equal(
    transformDoneMarkers(md),
    'Step done `✓ step 1`\n  `⏸ plan paused`\n```md\n[DONE:2]\n[PLAN:PAUSED]\n```',
  );
});

test('cleanStepText and extractPlanSteps preserve up to 240 chars before truncating', () => {
  const step160 = 'Verify daily memo validator and repository checks across all active fixtures; record verification details and report any remaining sandbox evidence gaps clearly';
  assert.equal(step160.length, 160);
  assert.equal(cleanStepText(step160), step160);
  const extracted = extractPlanSteps(`Plan:\n1. ${step160}\n`);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].text, step160);

  const over240 = `R${'x'.repeat(260)}`;
  const truncated = cleanStepText(over240);
  assert.equal(truncated.length, 240);
  assert.ok(truncated.endsWith('...'));
});
