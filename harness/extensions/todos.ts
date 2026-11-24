import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { PlanMode, PlanStep } from './pi-plan/src/types.ts';

export const todoToolName = 'pi_safe_todo';
export const todoEntryType = 'pi-todos';
export const sharedWidgetKey = 'pi-plan-todos';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 240);
}

export interface TodosHandle {
  updatePlanWidget(ctx: ExtensionContext, planMode: PlanMode, planSteps: PlanStep[]): void;
  items(): TodoItem[];
}

export function registerTodos(pi: ExtensionAPI, registerTool: boolean): TodosHandle {
  let items: TodoItem[] = [];
  let currentPlanMode: PlanMode = 'normal';
  let currentPlanSteps: PlanStep[] = [];

  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    // When pi-plan is actively executing steps, its steps drive the shared widget.
    if (currentPlanMode === 'execute' && currentPlanSteps.length > 0) {
      const lines = currentPlanSteps.map(step =>
        step.completed
          ? theme.fg('success', '☑ ') + theme.fg('muted', theme.strikethrough(step.text))
          : `${theme.fg('muted', '☐ ')}${step.text}`,
      );
      ctx.ui.setWidget(sharedWidgetKey, lines);
      return;
    }
    if (items.length === 0) {
      ctx.ui.setWidget(sharedWidgetKey, undefined);
      return;
    }
    const lines = items.map(item => {
      if (item.status === 'completed') {
        return theme.fg('success', '☑ ') + theme.fg('muted', theme.strikethrough(item.content));
      }
      if (item.status === 'in_progress') {
        return theme.fg('accent', '▶ ') + item.content;
      }
      return theme.fg('muted', '☐ ') + item.content;
    });
    ctx.ui.setWidget(sharedWidgetKey, lines);
  }

  function restoreFromBranch(ctx: ExtensionContext) {
    let latest: TodoItem[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && (entry as { customType?: string }).customType === todoEntryType) {
        const raw = (entry as { data?: { items?: unknown } }).data?.items;
        if (Array.isArray(raw)) {
          latest = raw
            .filter((x): x is TodoItem =>
              Boolean(
                x &&
                typeof x === 'object' &&
                typeof (x as TodoItem).content === 'string' &&
                ((x as TodoItem).status === 'pending' ||
                  (x as TodoItem).status === 'in_progress' ||
                  (x as TodoItem).status === 'completed'),
              ))
            .map(x => ({ content: sanitizeLine(x.content), status: x.status }))
            .filter(x => x.content.length > 0);
        }
      }
    }
    items = latest;
    renderWidget(ctx);
  }

  if (registerTool) {
    pi.registerTool({
      name: todoToolName,
      label: 'Update Todo List',
      promptSnippet: 'Update the visible session todo checklist for multi-step tasks',
      description: 'Replace the current session todo list to track multi-step progress visibly above the editor. Pass an empty items array when all tasks are complete and no longer needed.',
      parameters: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            maxItems: 40,
            items: {
              type: 'object',
              required: ['content', 'status'],
              properties: {
                content: { type: 'string', minLength: 1, maxLength: 240 },
                status: {
                  anyOf: (['pending', 'in_progress', 'completed'] as const).map(v => ({ type: 'string', const: v })),
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as unknown as TSchema,
      executionMode: 'parallel',
      async execute(_id, rawParams, _signal, _onUpdate, ctx) {
        const params = rawParams as { items: TodoItem[] };
        items = (params.items ?? [])
          .map(item => ({ content: sanitizeLine(item.content), status: item.status }))
          .filter(item => item.content.length > 0)
          .slice(0, 40);
        pi.appendEntry(todoEntryType, { items });
        renderWidget(ctx);
        const completed = items.filter(i => i.status === 'completed').length;
        const text = items.length === 0
          ? 'Todo list cleared.'
          : `Updated todo list (${completed}/${items.length} completed).`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      },
    });
  }

  pi.registerCommand('todos', {
    description: 'View or clear the current session todo list: /todos [clear]',
    async handler(raw, ctx) {
      if (raw.trim() === 'clear') {
        items = [];
        pi.appendEntry(todoEntryType, { items: [] });
        renderWidget(ctx);
        ctx.ui.notify('Todo list cleared.', 'info');
        return;
      }
      if (items.length === 0) {
        ctx.ui.notify('No active todos.', 'info');
        return;
      }
      const lines = items.map((item, idx) => {
        const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]';
        return `${idx + 1}. ${mark} ${item.content}`;
      });
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.on('session_start', (_event, ctx) => restoreFromBranch(ctx));
  pi.on('session_tree', (_event, ctx) => restoreFromBranch(ctx));

  return {
    updatePlanWidget(ctx, planMode, planSteps) {
      currentPlanMode = planMode;
      currentPlanSteps = planSteps;
      renderWidget(ctx);
    },
    items: () => items.map(i => ({ ...i })),
  };
}
