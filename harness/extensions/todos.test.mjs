import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTodos, sharedWidgetKey, todoToolName } from './todos.ts';

test('pi_safe_todo persists via appendEntry, restores from branch, and shares widget cleanly with pi-plan', async () => {
  let tool = null;
  const hooks = new Map();
  const entries = [];
  const widgets = [];

  const handle = registerTodos(
    {
      registerTool: t => { tool = t; },
      registerCommand: () => {},
      appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
      on: (e, h) => hooks.set(e, h),
    },
    true,
  );

  assert.equal(tool.name, todoToolName);

  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: {
        fg: (_c, t) => t,
        strikethrough: t => `~${t}~`,
      },
      setWidget: (key, lines) => widgets.push({ key, lines }),
      notify() {},
    },
  };

  await tool.execute(
    '1',
    {
      items: [
        { content: 'Read codebase', status: 'completed' },
        { content: 'Implement fix', status: 'in_progress' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(entries.length, 1);
  assert.equal(widgets.at(-1).key, sharedWidgetKey);
  assert.deepEqual(widgets.at(-1).lines, ['☑ ~Read codebase~', '▶ Implement fix']);

  // While pi-plan is in execute mode, plan steps feed the shared widget
  handle.updatePlanWidget(ctx, 'execute', [
    { step: 1, text: 'Plan step 1', completed: true },
    { step: 2, text: 'Plan step 2', completed: false },
  ]);
  assert.deepEqual(widgets.at(-1).lines, ['☑ ~Plan step 1~', '☐ Plan step 2']);

  // When pi-plan returns to normal mode, active pi_safe_todo items remain visible instead of being wiped!
  handle.updatePlanWidget(ctx, 'normal', []);
  assert.deepEqual(widgets.at(-1).lines, ['☑ ~Read codebase~', '▶ Implement fix']);
});
