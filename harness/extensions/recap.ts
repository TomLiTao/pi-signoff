import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PlanState } from './pi-plan/src/types.ts';
import { checkResultEntry } from './jobs.ts';

type Branch = ReturnType<ExtensionContext['sessionManager']['getBranch']>;
const outcomes = new Set(['passed', 'failed', 'cancelled', 'timed out']);

function excerpt(text: string, limit = 240) {
  const single = text.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const chars = [...single];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : single;
}

function lastCheck(branch: Branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== checkResultEntry) continue;
    const data = entry.data as { name?: unknown; outcome?: unknown; elapsedMs?: unknown } | null | undefined;
    if (!data || typeof data.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(data.name) ||
        typeof data.outcome !== 'string' || !outcomes.has(data.outcome)) continue;
    const duration = typeof data.elapsedMs === 'number' && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0
      ? ` in ${(data.elapsedMs / 1000).toFixed(1)}s` : '';
    const date = new Date(entry.timestamp);
    const when = Number.isNaN(date.valueOf()) ? '' : `, ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    return `${data.name} — ${data.outcome}${duration} (recorded${when}; not rerun)`;
  }
}

export function buildRecap(branch: Branch, plan: PlanState | undefined, activeJobs: number) {
  const requestIndex = branch.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const request = branch[requestIndex];
  const lines = ['Session recap (current branch)'];
  if (request?.type === 'message' && request.message.role === 'user') {
    const { content } = request.message;
    const text = typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ');
    lines.push(`Last request: ${excerpt(text) || '(no text)'}`);
  }
  let replied = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const { content, stopReason } = entry.message;
    if (stopReason !== 'stop' && stopReason !== 'length') continue;
    const text = excerpt(content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' '));
    if (!text) continue;
    replied = i > requestIndex;
    lines.push(`${replied ? 'Last reply' : 'Earlier reply'}: ${text}`);
    break;
  }
  if (requestIndex >= 0 && !replied) lines.push('No final reply to the last request yet.');
  if (requestIndex < 0 && !replied) lines.push('No conversation yet.');

  if (plan && plan.mode !== 'normal') {
    const open = plan.steps.filter(step => !step.completed);
    const phase = plan.mode === 'plan' ? 'draft, read-only' : 'execution';
    lines.push(`Active plan: ${phase} · ${plan.steps.length - open.length}/${plan.steps.length} steps marked done.`);
    for (const step of open.slice(0, 3)) lines.push(`  ${step.step}. ${excerpt(step.text, 120)}`);
    if (open.length > 3) lines.push(`  ${open.length - 3} more; see /plan:status.`);
  }
  const check = lastCheck(branch);
  if (check) lines.push(`Last named check: ${check}`);
  lines.push(activeJobs ? `Jobs: ${activeJobs} active in this session (/jobs).` : 'Jobs: none active. Jobs from previous sessions do not resume.');
  return lines.join('\n');
}

export function registerRecap(pi: ExtensionAPI, options: { plan: () => PlanState | undefined; activeJobs: () => number }) {
  function show(ctx: ExtensionContext, branch = ctx.sessionManager.getBranch()) {
    ctx.ui.notify(buildRecap(branch, options.plan(), options.activeJobs()), 'info');
  }
  pi.registerCommand('recap', {
    description: 'Show where you left off on this session branch, without a model call',
    async handler(raw, ctx) {
      if (!ctx.hasUI) return;
      if (raw.trim()) ctx.ui.notify('Usage: /recap', 'warning');
      else show(ctx);
    },
  });
  pi.on('session_start', (event, ctx) => {
    if (ctx.mode !== 'tui' || !['resume', 'startup'].includes(event.reason)) return;
    const branch = ctx.sessionManager.getBranch();
    if (branch.some(entry => entry.type === 'message' && entry.message.role === 'user')) show(ctx, branch);
  });
}
