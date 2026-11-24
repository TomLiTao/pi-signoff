import assert from 'node:assert/strict';
import test from 'node:test';
import {
  askUserToolName,
  formatAskUserSummary,
  normalizeAskUserQuestions,
  registerAskUser,
  runAskUserQuestionnaire,
} from './ask-user.ts';

test('normalizeAskUserQuestions validates counts, strips control characters, and rejects duplicate labels', () => {
  const normalized = normalizeAskUserQuestions([
    {
      question: 'Which auth strategy should we use?\n\x07',
      header: 'Auth\tStrategy',
      context: 'Determines session storage and revocation.',
      options: [
        { label: 'HttpOnly cookie (Recommended)', description: 'Stateless CSRF-safe cookie' },
        { label: 'Bearer JWT', description: 'Header-based token' },
      ],
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].question, 'Which auth strategy should we use?');
  assert.equal(normalized[0].header, 'Auth Strategy');
  assert.equal(normalized[0].multiSelect, false);
  assert.equal(normalized[0].options.length, 2);

  assert.throws(() => normalizeAskUserQuestions([]), /1 to 4 questions/);
  assert.throws(
    () =>
      normalizeAskUserQuestions([
        {
          question: 'Pick one',
          options: [{ label: 'Same' }, { label: 'same' }],
        },
      ]),
    /duplicate option label/i,
  );
  assert.throws(
    () =>
      normalizeAskUserQuestions([
        {
          question: 'Only one option',
          options: [{ label: 'One' }],
        },
      ]),
    /2 to 6 options/,
  );
});

test('runAskUserQuestionnaire supports single-select, custom answers, multi-select toggling, and cancellation', async () => {
  const questions = normalizeAskUserQuestions([
    {
      header: 'Runtime',
      question: 'Which target environment?',
      options: [
        { label: 'Node 24 (Recommended)', description: 'Current LTS' },
        { label: 'Bun' },
      ],
    },
    {
      header: 'Features',
      question: 'Which features should be enabled?',
      multiSelect: true,
      options: [
        { label: 'Audit log' },
        { label: 'Spec export' },
        { label: 'Bell notify' },
      ],
    },
    {
      header: 'Custom',
      question: 'Where should reports go?',
      options: [
        { label: 'Default state dir' },
        { label: 'Docs folder' },
      ],
    },
  ]);

  const selectQueue = [
    // Q1: pick recommended option
    'Node 24 (Recommended) — Current LTS',
    // Q2: toggle Audit log on, toggle Spec export on, toggle Audit log off, add custom, then Done
    '[ ] Audit log',
    '[ ] Spec export',
    '[x] Audit log',
    'Other (add custom answer…)',
    '✓ Done (2 selected)',
    // Q3: pick custom single answer
    'Other (type custom answer…)',
  ];
  const inputQueue = ['Custom webhook sink', '/var/tmp/reports'];

  const ctx = {
    hasUI: true,
    signal: undefined,
    ui: {
      select: async () => selectQueue.shift(),
      input: async () => inputQueue.shift(),
    },
  };

  const result = await runAskUserQuestionnaire(ctx, questions);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.answers, [
    {
      header: 'Runtime',
      question: 'Which target environment?',
      selected: ['Node 24 (Recommended)'],
    },
    {
      header: 'Features',
      question: 'Which features should be enabled?',
      selected: ['Spec export', 'Custom webhook sink'],
      custom: true,
    },
    {
      header: 'Custom',
      question: 'Where should reports go?',
      selected: ['/var/tmp/reports'],
      custom: true,
    },
  ]);

  const summary = formatAskUserSummary(result);
  assert.match(summary, /\[Runtime\] Which target environment\?/);
  assert.match(summary, /Answer: Spec export, Custom webhook sink/);
  assert.match(summary, /Answer: \/var\/tmp\/reports/);
});

test('registerAskUser fails closed without UI and records audit events', async () => {
  let registeredTool;
  const audits = [];
  const fakePi = {
    registerTool(def) {
      registeredTool = def;
    },
  };
  registerAskUser(fakePi, { onAudit: entry => audits.push(entry) });
  assert.equal(registeredTool.name, askUserToolName);
  assert.equal(registeredTool.exposure, 'model-only');

  const noUiRes = await registeredTool.execute(
    'tc1',
    {
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
    undefined,
    undefined,
    { hasUI: false, signal: undefined, ui: {} },
  );
  assert.match(noUiRes.content[0].text, /requires an interactive UI session/);
  assert.equal(audits.at(-1).rule, 'no-ui-block');
  assert.equal(audits.at(-1).decision, 'block');
});

test('an over-long option description is shortened, not rejected by the schema', () => {
  const tools = [];
  registerAskUser({ registerTool: t => tools.push(t), on() {}, registerCommand() {} }, {});
  const schema = tools.find(t => t.name === askUserToolName).parameters;
  const optionProps = schema.properties.questions.items.properties.options.items.properties;
  assert.equal(optionProps.description.maxLength, undefined, 'the schema does not reject long descriptions');
  assert.equal(optionProps.label.maxLength, 120, 'labels keep their limit');
  const long = 'x'.repeat(400);
  const [q] = normalizeAskUserQuestions([{ question: 'Pick one?', options: [{ label: 'A', description: long }, { label: 'B' }] }]);
  assert.equal(q.options[0].description.length, 240);
  assert.ok(q.options[0].description.endsWith('…'));
});
