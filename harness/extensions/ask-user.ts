import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { AuditEvent } from './audit.ts';

export const askUserToolName = 'pi_safe_ask_user';

export interface AskUserOptionInput {
  label: string;
  description?: string;
}

export interface AskUserQuestionInput {
  question: string;
  header?: string;
  context?: string;
  multiSelect?: boolean;
  options: AskUserOptionInput[];
}

export interface NormalizedAskUserOption {
  label: string;
  description?: string;
}

export interface NormalizedAskUserQuestion {
  question: string;
  header?: string;
  context?: string;
  multiSelect: boolean;
  options: NormalizedAskUserOption[];
}

export interface AskUserAnswer {
  question: string;
  header?: string;
  selected: string[];
  custom?: boolean;
}

export interface AskUserQuestionnaireResult {
  cancelled: boolean;
  answers: AskUserAnswer[];
}

export interface RegisterAskUserOptions {
  onAudit?: (event: AuditEvent) => void;
}

const OTHER_SINGLE_LABEL = 'Other (type custom answer…)';
const OTHER_MULTI_LABEL = 'Other (add custom answer…)';
const CANCEL_LABEL = 'Skip / cancel questionnaire';

function cleanText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return '';
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}

export function normalizeAskUserQuestions(rawQuestions: unknown): NormalizedAskUserQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0 || rawQuestions.length > 4) {
    throw new Error(`${askUserToolName} requires 1 to 4 questions.`);
  }
  const out: NormalizedAskUserQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const item = rawQuestions[i] as Partial<AskUserQuestionInput> | null | undefined;
    if (!item || typeof item !== 'object') {
      throw new Error(`Question ${i + 1} must be an object.`);
    }
    const question = cleanText(item.question, 500);
    if (question.length < 3) {
      throw new Error(`Question ${i + 1} text must be at least 3 characters.`);
    }
    const header = cleanText(item.header, 40) || undefined;
    const context = cleanText(item.context, 600) || undefined;
    const multiSelect = item.multiSelect === true;

    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) {
      throw new Error(`Question ${i + 1} must provide 2 to 6 options.`);
    }
    const seenLabels = new Set<string>();
    const options: NormalizedAskUserOption[] = [];
    for (let j = 0; j < item.options.length; j++) {
      const opt = item.options[j] as Partial<AskUserOptionInput> | null | undefined;
      if (!opt || typeof opt !== 'object') {
        throw new Error(`Question ${i + 1}, option ${j + 1} must be an object.`);
      }
      const label = cleanText(opt.label, 120);
      if (!label) {
        throw new Error(`Question ${i + 1}, option ${j + 1} requires a non-empty label.`);
      }
      const lower = label.toLowerCase();
      if (seenLabels.has(lower)) {
        throw new Error(`Question ${i + 1} has duplicate option label "${label}".`);
      }
      seenLabels.add(lower);
      const description = cleanText(opt.description, 240) || undefined;
      options.push({ label, ...(description ? { description } : {}) });
    }

    out.push({
      question,
      ...(header ? { header } : {}),
      ...(context ? { context } : {}),
      multiSelect,
      options,
    });
  }
  return out;
}

function formatQuestionPrompt(
  q: NormalizedAskUserQuestion,
  index: number,
  total: number,
): string {
  const prefix = total > 1 ? `[Question ${index + 1}/${total}${q.header ? ` · ${q.header}` : ''}]` : (q.header ? `[${q.header}]` : 'Clarifying question');
  const lines = [`${prefix} ${q.question}`];
  if (q.context) {
    lines.push(q.context);
  }
  if (q.multiSelect) {
    lines.push('(Multi-select: toggle choices, then choose Done to submit.)');
  }
  return lines.join('\n');
}

function formatOptionChoice(opt: NormalizedAskUserOption): string {
  return opt.description ? `${opt.label} — ${opt.description}` : opt.label;
}

export async function runAskUserQuestionnaire(
  ctx: Pick<ExtensionContext, 'hasUI' | 'signal' | 'ui'>,
  questions: readonly NormalizedAskUserQuestion[],
  signal?: AbortSignal,
): Promise<AskUserQuestionnaireResult> {
  const isAborted = () => Boolean(signal?.aborted || ctx.signal?.aborted);
  if (!ctx.hasUI || isAborted()) {
    return { cancelled: true, answers: [] };
  }

  const answers: AskUserAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const promptTitle = formatQuestionPrompt(q, i, questions.length);

    if (!q.multiSelect) {
      let answered = false;
      while (!answered) {
        if (isAborted()) return { cancelled: true, answers };
        const renderedOptions = q.options.map(formatOptionChoice);
        const choices = [...renderedOptions, OTHER_SINGLE_LABEL, CANCEL_LABEL];
        const picked = await ctx.ui.select(promptTitle, choices, { timeout: 120_000, signal: signal ?? ctx.signal });
        if (isAborted() || !picked || picked === CANCEL_LABEL) {
          return { cancelled: true, answers };
        }
        if (picked === OTHER_SINGLE_LABEL) {
          const customRaw = await ctx.ui.input(
            `${q.header ? `[${q.header}] ` : ''}${q.question}`,
            'Type your custom answer…',
            { timeout: 120_000, signal: signal ?? ctx.signal },
          );
          if (isAborted()) return { cancelled: true, answers };
          const custom = cleanText(customRaw, 500);
          if (!custom) {
            continue;
          }
          answers.push({
            question: q.question,
            ...(q.header ? { header: q.header } : {}),
            selected: [custom],
            custom: true,
          });
          answered = true;
          continue;
        }
        const matchedIdx = renderedOptions.indexOf(picked);
        const label = matchedIdx >= 0 ? q.options[matchedIdx].label : picked;
        answers.push({
          question: q.question,
          ...(q.header ? { header: q.header } : {}),
          selected: [label],
        });
        answered = true;
      }
    } else {
      const selectedIndices = new Set<number>();
      const customAnswers: string[] = [];
      while (true) {
        if (isAborted()) return { cancelled: true, answers };
        const totalSelected = selectedIndices.size + customAnswers.length;
        const doneLabel = totalSelected > 0
          ? `✓ Done (${totalSelected} selected)`
          : '✓ Done (none selected)';
        const toggleChoices = q.options.map((opt, idx) => {
          const mark = selectedIndices.has(idx) ? '[x]' : '[ ]';
          return `${mark} ${formatOptionChoice(opt)}`;
        });
        const customChoices = customAnswers.map((ans, idx) => `[x] Custom #${idx + 1}: ${ans}`);
        const choices = [
          doneLabel,
          ...toggleChoices,
          ...customChoices,
          OTHER_MULTI_LABEL,
          CANCEL_LABEL,
        ];
        const picked = await ctx.ui.select(promptTitle, choices, { timeout: 120_000, signal: signal ?? ctx.signal });
        if (isAborted() || !picked || picked === CANCEL_LABEL) {
          return { cancelled: true, answers };
        }
        if (picked === doneLabel) {
          const selectedLabels = [
            ...[...selectedIndices].sort((a, b) => a - b).map(idx => q.options[idx].label),
            ...customAnswers,
          ];
          answers.push({
            question: q.question,
            ...(q.header ? { header: q.header } : {}),
            selected: selectedLabels,
            ...(customAnswers.length > 0 ? { custom: true } : {}),
          });
          break;
        }
        if (picked === OTHER_MULTI_LABEL) {
          const customRaw = await ctx.ui.input(
            `${q.header ? `[${q.header}] ` : ''}${q.question}`,
            'Add a custom answer…',
            { timeout: 120_000, signal: signal ?? ctx.signal },
          );
          if (isAborted()) return { cancelled: true, answers };
          const custom = cleanText(customRaw, 500);
          if (custom && !customAnswers.includes(custom) && customAnswers.length < 6) {
            customAnswers.push(custom);
          }
          continue;
        }
        const optIdx = toggleChoices.indexOf(picked);
        if (optIdx >= 0) {
          if (selectedIndices.has(optIdx)) selectedIndices.delete(optIdx);
          else selectedIndices.add(optIdx);
          continue;
        }
        const customIdx = customChoices.indexOf(picked);
        if (customIdx >= 0) {
          customAnswers.splice(customIdx, 1);
        }
      }
    }
  }

  return { cancelled: false, answers };
}

export function formatAskUserSummary(result: AskUserQuestionnaireResult): string {
  if (result.cancelled) {
    if (result.answers.length === 0) {
      return 'User skipped or cancelled the questionnaire without submitting answers. Proceed conservatively or ask how they prefer to continue.';
    }
    const partial = result.answers
      .map((a, idx) => `${idx + 1}. ${a.header ? `[${a.header}] ` : ''}${a.question}\n   Answer: ${a.selected.length ? a.selected.join(', ') : '(none)'}`)
      .join('\n');
    return `Questionnaire cancelled after ${result.answers.length} answer(s):\n${partial}`;
  }
  const formatted = result.answers
    .map((a, idx) => {
      const answerStr = a.selected.length > 0 ? a.selected.join(', ') : '(none selected)';
      return `${idx + 1}. ${a.header ? `[${a.header}] ` : ''}${a.question}\n   Answer: ${answerStr}`;
    })
    .join('\n');
  return `User responses:\n${formatted}`;
}

export function registerAskUser(pi: ExtensionAPI, options: RegisterAskUserOptions = {}): void {
  pi.registerTool({
    name: askUserToolName,
    label: 'Ask Clarifying Questions',
    exposure: 'model-only',
    promptSnippet: 'Ask the user 1–4 structured multiple-choice clarifying questions before planning or coding when requirements are ambiguous',
    promptGuidelines: [
      `When requirements are ambiguous or several approaches have meaningful trade-offs, call ${askUserToolName} with 1–4 focused multiple-choice questions instead of asking plain-text questions.`,
      'List your recommended option first and end its label with "(Recommended)" when one option is clearly strongest.',
    ],
    description:
      'Present 1 to 4 structured multiple-choice questions to the user and collect their answers interactively. Supports single-select, multi-select, option descriptions, and custom user-typed answers.',
    parameters: {
      type: 'object',
      required: ['questions'],
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: '1 to 4 focused clarifying questions to ask in order.',
          items: {
            type: 'object',
            required: ['question', 'options'],
            additionalProperties: false,
            properties: {
              question: {
                type: 'string',
                minLength: 3,
                maxLength: 500,
                description: 'Self-contained question to ask the user.',
              },
              header: {
                type: 'string',
                minLength: 1,
                maxLength: 40,
                description: 'Short topic label (for example "Auth", "Database", or "Scope").',
              },
              context: {
                type: 'string',
                minLength: 1,
                maxLength: 600,
                description: 'Brief 1–3 sentence explanation of why this choice matters and what it affects.',
              },
              multiSelect: {
                type: 'boolean',
                description: 'True when the user may select multiple options ("select all that apply"). Defaults to false.',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 6,
                description: '2 to 6 distinct options. Put the recommended option first ending with "(Recommended)" when appropriate.',
                items: {
                  type: 'object',
                  required: ['label'],
                  additionalProperties: false,
                  properties: {
                    label: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description: 'Short option label.',
                    },
                    description: {
                      type: 'string',
                      minLength: 1,
                      // No maxLength: an over-long note is shortened to 240 characters (with "…") rather than
                      // failing the whole call and costing the model a retry.
                      description: 'Optional brief note on trade-offs or behavior (about one sentence; longer notes are shortened).',
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as TSchema,
    executionMode: 'sequential',
    async execute(_id, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as { questions?: unknown };
      let questions: NormalizedAskUserQuestion[];
      try {
        questions = normalizeAskUserQuestions(params?.questions);
      } catch (error) {
        options.onAudit?.({
          tool: askUserToolName,
          args: rawParams,
          decision: 'block',
          rule: 'invalid-questions',
          prompted: false,
        });
        throw error;
      }

      if (!ctx.hasUI || ctx.signal?.aborted || signal?.aborted) {
        options.onAudit?.({
          tool: askUserToolName,
          args: rawParams,
          decision: 'block',
          rule: 'no-ui-block',
          prompted: false,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `${askUserToolName} requires an interactive UI session. State your assumptions explicitly or wait for user input.`,
          }],
          details: undefined,
        };
      }

      const outcome = await runAskUserQuestionnaire(ctx, questions, signal);
      options.onAudit?.({
        tool: askUserToolName,
        args: rawParams,
        decision: outcome.cancelled ? 'denied' : 'approved',
        rule: outcome.cancelled ? 'ask-user-cancelled' : 'ask-user-answered',
        prompted: true,
      });

      return {
        content: [{
          type: 'text' as const,
          text: formatAskUserSummary(outcome),
        }],
        details: outcome,
      };
    },
  });
}
