// /handoff: write a redacted Markdown handoff of the session: context, plan recap, changes since
// launch, script runs, and a compact transcript (user and assistant text, one line per tool call
// with its result summary; thinking omitted). Dotenv values and credential-shaped strings are
// replaced with [redacted]. Written privately outside the workspace unless a path is given.
import { closeSync, constants, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TurnChangeSummary } from './checkpoints.ts';
import { summarizeToolResult, toolHeader } from './droid-ui-format.ts';
import { formatRunLine, type RunRecord } from './run-log.ts';

type Entry = { type: string; timestamp?: string; customType?: string; data?: unknown; message?: any };

export interface HandoffInfo {
  cwd: string;
  model?: string;
  mode?: string;
  branch?: string;
  checkpoint?: string;
  recap?: string;
  changes?: TurnChangeSummary;
  runs?: RunRecord[];
  generatedAt?: Date;
}

const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more characters)` : trimmed;
}

export function buildHandoff(entries: readonly Entry[], info: HandoffInfo): string {
  const when = (info.generatedAt ?? new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const out: string[] = [
    `# Pi session handoff — ${path.basename(info.cwd)} — ${when} UTC`, '',
    `- Folder: \`${info.cwd}\``,
    ...(info.branch ? [`- Git branch: \`${info.branch}\``] : []),
    ...(info.model ? [`- Model: ${info.model}`] : []),
    ...(info.mode ? [`- Permission mode: ${info.mode}`] : []),
    ...(info.checkpoint ? [`- Launch checkpoint: \`${info.checkpoint}\``] : []),
    '- Continue with `pi --continue` in this folder, or give this file to another agent.', '',
  ];
  if (info.recap) out.push('## Recap', '', '```', info.recap.trim(), '```', '');
  if (info.changes?.files.length) {
    const added = info.changes.files.reduce((n, f) => n + f.added, 0);
    const removed = info.changes.files.reduce((n, f) => n + f.removed, 0);
    out.push(`## Changes since launch (${info.changes.total} files, +${added} −${removed})`, '');
    for (const f of info.changes.files.slice(0, 60)) out.push(`- \`${f.path}\` ${f.binary ? 'binary' : `+${f.added} −${f.removed}`}`);
    if (info.changes.total > 60) out.push(`- … (+${info.changes.total - 60} more)`);
    out.push('');
  }
  if (info.runs?.length) {
    out.push(`## Script runs this session (${info.runs.length})`, '');
    for (const run of info.runs.slice(-30)) out.push(`- ${formatRunLine(run)}`);
    out.push('');
  }
  out.push('## Transcript', '');
  const results = new Map<string, { result: any; isError: boolean; toolName: string }>();
  for (const e of entries) {
    if (e.type === 'message' && e.message?.role === 'toolResult') {
      results.set(e.message.toolCallId, { result: { content: e.message.content, details: e.message.details }, isError: Boolean(e.message.isError), toolName: e.message.toolName });
    }
  }
  for (const e of entries) {
    if (e.type === 'custom' && e.customType === 'pi-turn-changes') {
      const data = e.data as { total?: number; files?: Array<{ added: number; removed: number }> } | undefined;
      if (data?.total) {
        const added = data.files?.reduce((n, f) => n + f.added, 0) ?? 0;
        const removed = data.files?.reduce((n, f) => n + f.removed, 0) ?? 0;
        out.push(`_Changed ${data.total} file${data.total === 1 ? '' : 's'} (+${added} −${removed})._`, '');
      }
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m?.role === 'user') {
      const text = textOf(m.content);
      if (text.trim()) out.push('### User', '', clip(text, 6000), '');
    } else if (m?.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const calls = blocks.filter((b: any) => b.type === 'toolCall');
      if (text.trim() || calls.length) out.push('### Assistant', '');
      if (text.trim()) out.push(clip(text, 8000), '');
      for (const call of calls) {
        const { label, detail } = toolHeader(call.name, call.arguments ?? {}, info.cwd);
        const res = results.get(call.id);
        const summary = res ? summarizeToolResult(call.name, call.arguments ?? {}, res.result, res.isError) : 'no result';
        out.push(`- \`${label}\`${detail ? ` ${detail}` : ''} → ${summary}`);
      }
      if (calls.length) out.push('');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function handoffDir(cwd: string): string {
  const base = process.env.PI_PROTECTED_STATE_DIR
    ? path.resolve(process.env.PI_PROTECTED_STATE_DIR)
    : path.join(os.homedir(), '.local/state/pi-protected');
  return path.join(base, 'handoffs', createHash('sha256').update(cwd).digest('hex').slice(0, 12));
}

export interface HandoffOptions {
  redact: (text: string) => string;
  getInfo: (ctx: ExtensionCommandContext) => Promise<HandoffInfo>;
}

export function registerHandoff(pi: ExtensionAPI, options: HandoffOptions) {
  pi.registerCommand('handoff', {
    description: 'Write a redacted Markdown handoff of this session (context, plan, changes, script runs, transcript): /handoff [path.md]',
    async handler(raw, ctx) {
      try {
        const root = realpathSync(ctx.cwd);
        const info = await options.getInfo(ctx);
        const markdown = options.redact(buildHandoff(ctx.sessionManager.getBranch() as Entry[], { ...info, cwd: root }));
        const arg = raw.trim();
        let target: string;
        if (arg) {
          if (!arg.endsWith('.md')) throw new Error('Give a .md path, e.g. /handoff notes/handoff.md');
          target = path.resolve(root, arg);
          const rel = path.relative(root, target);
          const inHome = !path.relative(os.homedir(), target).startsWith('..');
          if ((rel.startsWith('..') || path.isAbsolute(rel)) && !inHome) throw new Error('Write the handoff inside this folder or your home folder.');
        } else {
          const dir = handoffDir(root);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const slug = path.basename(root).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
          target = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${slug}.md`);
        }
        mkdirSync(path.dirname(target), { recursive: true });
        const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeSync(fd, markdown);
        } finally {
          closeSync(fd);
        }
        ctx.ui.notify(`Handoff written (${markdown.length.toLocaleString('en-US')} characters, secrets redacted): ${target}`, 'info');
      } catch (error) {
        const message = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'that file already exists; choose another name.' : (error as Error).message;
        ctx.ui.notify(`/handoff: ${message}`, 'warning');
      }
    },
  });
}
