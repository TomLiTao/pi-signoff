// Pure formatting helpers for the Droid-style TUI (droid-ui.ts). No runtime imports, so the
// Node test runner can load this file directly.
import type { StatusSnapshot } from './status.ts';

export type UiStyle = 'droid' | 'classic';

export function parseUiStyle(raw: unknown): UiStyle | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'droid' || value === 'classic' ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Autonomy banner (left side of the footer, under the input box)

export interface AutonomyBanner {
  label: string;
  description: string;
  tone: 'spec' | 'off' | 'low' | 'medium' | 'locked';
}

const RETURN_MODE_NAMES: Record<NonNullable<StatusSnapshot['returnMode']>, string> = {
  'ask-edits': 'Ask-edits',
  'accept-edits': 'Accept-edits',
  workflow: 'Workflow',
};

export function autonomyBanner(state: Pick<StatusSnapshot, 'mode' | 'autonomy' | 'returnMode'>): AutonomyBanner {
  switch (state.mode) {
    case 'PLAN': {
      const target = RETURN_MODE_NAMES[state.returnMode ?? 'accept-edits'];
      const auto = state.autonomy && state.autonomy !== 'off' ? ` · ${autonomyLabel(state.autonomy)}` : '';
      return { label: 'Spec', description: `read-only planning; approve → ${target}${auto}`, tone: 'spec' };
    }
    case 'READ-ONLY':
      return { label: 'Read-only', description: 'no launch checkpoint; workspace writes disabled', tone: 'locked' };
    case 'WORKFLOW':
      return {
        label: autonomyLabel(state.autonomy),
        description: 'workflow: plan → approve permissions → execute',
        tone: toneFor(state.autonomy),
      };
    default:
      break;
  }
  const level = state.autonomy ?? 'off';
  if (level === 'low') {
    return { label: 'Auto (Low)', description: 'edits and read-only commands run without asking', tone: 'low' };
  }
  if (level === 'medium') {
    return { label: 'Auto (Medium)', description: 'low + local test, lint and build commands', tone: 'medium' };
  }
  return {
    label: 'Auto (Off)',
    description: state.mode === 'ASK-EDITS' ? 'every edit and command asks first' : 'edits run; commands ask first',
    tone: 'off',
  };
}

function autonomyLabel(level: StatusSnapshot['autonomy']): string {
  return level === 'low' ? 'Auto (Low)' : level === 'medium' ? 'Auto (Medium)' : 'Auto (Off)';
}

function toneFor(level: StatusSnapshot['autonomy']): AutonomyBanner['tone'] {
  return level === 'low' ? 'low' : level === 'medium' ? 'medium' : 'off';
}

/**
 * Droid's Shift+Tab ring: Auto Off → Auto Low → Auto Medium → Spec → Auto Off.
 * Protected Pi caps autonomy at medium, so there is no Auto High stop.
 */
export type DroidCycleStep =
  | { kind: 'autonomy'; level: 'off' | 'low' | 'medium' }
  | { kind: 'enter-spec' }
  | { kind: 'leave-spec' };

export function nextDroidCycleStep(state: { planning: boolean; autonomy: 'off' | 'low' | 'medium' }): DroidCycleStep {
  if (state.planning) return { kind: 'leave-spec' };
  if (state.autonomy === 'off') return { kind: 'autonomy', level: 'low' };
  if (state.autonomy === 'low') return { kind: 'autonomy', level: 'medium' };
  return { kind: 'enter-spec' };
}

// ---------------------------------------------------------------------------------------------
// Footer secondary line

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 1000) return `${Math.max(0, Math.round(count || 0))}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function shortenHome(path: string, home = process.env.HOME): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** Home-relative path, cut to its last two segments when longer than `max` columns. */
export function compactPath(path: string, max = 40, home = process.env.HOME): string {
  const short = shortenHome(path, home);
  if (short.length <= max) return short;
  const segments = short.split('/').filter(Boolean);
  const tail = segments.slice(-2).join('/');
  return tail.length + 2 <= max ? `…/${tail}` : `…${short.slice(-(max - 1))}`;
}

export interface FooterDetails {
  cwd: string;
  branch?: string | null;
  snapshot?: StatusSnapshot;
  contextPercent?: number | null;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  extraStatuses?: readonly string[];
}

export function footerDetailParts(d: FooterDetails): string[] {
  const parts: string[] = [];
  parts.push(d.branch ? `${compactPath(d.cwd)} (${d.branch})` : compactPath(d.cwd));
  const s = d.snapshot;
  if (s) {
    if (s.mode === 'ASK-EDITS' || s.mode === 'WORKFLOW') parts.push(s.mode.toLowerCase());
    if (s.style && s.style !== 'default') parts.push(`style:${s.style}`);
    const ckpt = s.checkpointRef ? /-([0-9a-f]{8})$/.exec(s.checkpointRef)?.[1] ?? s.checkpointRef.slice(-8) : undefined;
    if (ckpt) parts.push(`ckpt ${ckpt}`);
    if (s.rejectedCount) parts.push(`${s.rejectedCount} rejected`);
    if (s.activeJobs > 0) parts.push(`${s.activeJobs} job${s.activeJobs === 1 ? '' : 's'}`);
    const rem = s.delegatesRemaining ?? s.delegateRemaining;
    const max = s.delegatesMax ?? s.delegateMax;
    if (typeof rem === 'number' && typeof max === 'number' && max > 0 && rem < max) parts.push(`droids ${rem}/${max}`);
    if (!s.webEnabled && !s.fetchEnabled) parts.push('web off');
    else if (!s.webEnabled) parts.push('search off');
    else if (!s.fetchEnabled) parts.push('fetch off');
  }
  if (typeof d.contextPercent === 'number' && Number.isFinite(d.contextPercent)) {
    const win = d.contextWindow ? `/${formatTokens(d.contextWindow)}` : '';
    parts.push(`ctx ${Math.round(d.contextPercent)}%${win}`);
  }
  if ((d.inputTokens ?? 0) > 0 || (d.outputTokens ?? 0) > 0) {
    parts.push(`↑${formatTokens(d.inputTokens ?? 0)} ↓${formatTokens(d.outputTokens ?? 0)}`);
  }
  if (typeof d.cost === 'number' && d.cost > 0) parts.push(`$${d.cost.toFixed(3)}`);
  for (const extra of d.extraStatuses ?? []) {
    const clean = extra.replace(/[\r\n\t]+/g, ' ').replace(/ +/g, ' ').trim();
    if (clean) parts.push(clean);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Tool rows: "LABEL (detail)" header + "↳ summary" result line

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

export function displayPath(path: string, cwd?: string): string {
  if (!path) return '.';
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return shortenHome(path);
}

export interface ToolHeader {
  label: string;
  detail: string;
}

export function canonicalToolName(name: string): string {
  return name.startsWith('pi_safe_') ? name.slice('pi_safe_'.length) : name;
}

export function toolHeader(name: string, rawArgs: unknown, cwd?: string): ToolHeader {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const tool = canonicalToolName(name);
  const path = displayPath(str(args.path), cwd);
  switch (tool) {
    case 'read': {
      const extras: string[] = [];
      if (typeof args.offset === 'number') extras.push(`offset: ${args.offset}`);
      if (typeof args.limit === 'number') extras.push(`limit: ${args.limit}`);
      return { label: 'READ', detail: [path, ...extras].join(', ') };
    }
    case 'bash':
      return { label: 'EXECUTE', detail: oneLine(str(args.command)) };
    case 'edit':
      return { label: 'EDIT', detail: path };
    case 'write':
      return { label: 'CREATE', detail: path };
    case 'grep': {
      const extras = [str(args.path) ? path : '', str(args.glob) ? `glob: ${str(args.glob)}` : ''].filter(Boolean);
      return { label: 'GREP', detail: [JSON.stringify(oneLine(str(args.pattern), 80)), ...extras].join(', ') };
    }
    case 'find':
      return { label: 'GLOB', detail: [oneLine(str(args.pattern), 80), str(args.path) ? path : ''].filter(Boolean).join(', ') };
    case 'ls':
      return { label: 'LIST DIRECTORY', detail: path };
    case 'git': {
      const extra = Array.isArray(args.args) ? args.args.map(str).join(' ') : '';
      return { label: 'GIT', detail: oneLine(`${str(args.subcommand)} ${extra}`.trim()) };
    }
    case 'web_search': {
      const filters = [args.site ? `site: ${str(args.site)}` : '', args.time ? `past ${str(args.time)}` : ''].filter(Boolean);
      return { label: 'WEB SEARCH', detail: [JSON.stringify(oneLine(str(args.query), 100)), ...filters].join(', ') };
    }
    case 'web_fetch': {
      const extra = [args.find ? `find "${oneLine(str(args.find), 40)}"` : '', args.offset ? `offset: ${str(args.offset)}` : ''].filter(Boolean);
      return { label: 'FETCH', detail: [oneLine(str(args.url), 110), ...extra].join(', ') };
    }
    case 'todo':
      return { label: 'TODO LIST', detail: '' };
    case 'code': {
      const action = str(args.action);
      const labels: Record<string, string> = { diagnostics: 'TYPE CHECK', definition: 'DEFINITION', references: 'REFERENCES', hover: 'HOVER', symbols: 'OUTLINE', workspace_symbols: 'FIND SYMBOL', rename: 'RENAME PREVIEW' };
      const files = Array.isArray(args.paths) ? (args.paths as unknown[]).map(p => displayPath(str(p), cwd)).join(', ') : args.path ? displayPath(str(args.path), cwd) : '';
      const at = args.line ? `:${str(args.line)}` : '';
      const extra = [args.symbol ? str(args.symbol) : '', args.query ? JSON.stringify(str(args.query)) : '', args.newName ? `→ ${str(args.newName)}` : ''].filter(Boolean).join(' ');
      return { label: labels[action] ?? 'CODE', detail: oneLine([`${files}${at}`, extra].filter(Boolean).join(' '), 120) };
    }
    case 'data':
      return args.action === 'query'
        ? { label: 'SQL', detail: JSON.stringify(oneLine(str(args.sql), 100)) }
        : { label: 'DATA PREVIEW', detail: oneLine(displayPath(str(args.path), cwd), 120) };
    case 'plan':
      return { label: 'SPEC', detail: oneLine(str(args.summary ?? args.title), 100) };
    case 'ask_user':
      return { label: 'ASK USER', detail: Array.isArray(args.questions) ? `${args.questions.length} question${args.questions.length === 1 ? '' : 's'}` : '' };
    case 'memory':
      return { label: 'MEMORY', detail: [str(args.action), str(args.file)].filter(Boolean).join(' ') };
    case 'delegate': {
      const droid = str(args.droid) || 'explorer';
      return { label: 'DROID', detail: `${droid}: ${oneLine(str(args.task), 100)}` };
    }
    case 'job_start':
      return { label: 'BACKGROUND', detail: oneLine(str(args.command)) };
    case 'job_status':
      return { label: 'JOB STATUS', detail: str(args.id ?? args.jobId) };
    case 'job_cancel':
      return { label: 'CANCEL JOB', detail: str(args.id ?? args.jobId) };
    case 'test':
      return { label: 'RUN CHECK', detail: str(args.name) || 'test' };
    case 'tool_search':
      return { label: 'TOOL SEARCH', detail: JSON.stringify(oneLine(str(args.query), 80)) };
    case 'codemode':
      return { label: 'CODE MODE', detail: oneLine(str(args.code ?? args.script), 100) };
    default:
      break;
  }
  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__');
    return { label: 'MCP', detail: `${server}:${rest.join('__')}` };
  }
  return { label: tool.replace(/_/g, ' ').toUpperCase(), detail: '' };
}

export interface ToolResultLike {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: unknown;
}

export function resultText(result: ToolResultLike | undefined): string {
  return (result?.content ?? [])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n');
}

function countLines(text: string): number {
  const trimmed = text.replace(/\n+$/, '');
  return trimmed ? trimmed.split('\n').length : 0;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (/^\+\s*\d/.test(line)) added++;
    else if (/^-\s*\d/.test(line)) removed++;
  }
  return { added, removed };
}

export function summarizeToolResult(name: string, rawArgs: unknown, result: ToolResultLike | undefined, isError: boolean): string {
  const text = resultText(result);
  const tool = canonicalToolName(name);
  if (tool === 'bash' || tool === 'job_start') {
    const status = /\n*\s*(Command (?:exited with code (-?\d+)|timed out[^\n]*|aborted|terminated[^\n]*))\s*$/.exec(text);
    const body = status ? text.slice(0, status.index) : text;
    const n = /^\(no output\)$/i.test(body.trim()) ? 0 : countLines(body);
    const out = n ? `${plural(n, 'line')} of output.` : 'No output.';
    if (status?.[2]) return `Exit code ${status[2]}. ${out}`;
    if (status) return `${oneLine(status[1], 120)}. ${out}`;
    if (isError) return `Error: ${oneLine(text || 'command failed', 160)}`;
    if (tool === 'job_start') return oneLine(text.split('\n').find(line => line.trim()) ?? 'Started.', 140);
    return `Exit code 0. ${out}`;
  }
  if (isError) return `Error: ${oneLine(text || 'tool failed', 160)}`;
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const details = (result?.details && typeof result.details === 'object' ? result.details : {}) as Record<string, unknown>;
  switch (tool) {
    case 'read': {
      const image = (result?.content ?? []).find(part => part.type === 'image') as { mimeType?: unknown } | undefined;
      if (image) return `Image attached for the model${typeof image.mimeType === 'string' ? ` (${image.mimeType})` : ''}.`;
      if (/^\[Image not shown:/m.test(text)) return 'Image not shown: this model does not accept images.';
      const n = countLines(text.replace(/\n\[[^\]\n]*(?:truncated|Showing|more lines)[^\]\n]*\]\s*$/i, ''));
      return `Read ${plural(n, 'line')}.${details.truncation ? ' (truncated)' : ''}`;
    }
    case 'edit': {
      const diff = typeof details.diff === 'string' ? details.diff : '';
      const { added, removed } = diffStats(diff);
      return diff ? `Succeeded. File edited. (+${added} added, -${removed} removed)` : 'Succeeded. File edited.';
    }
    case 'write': {
      const n = countLines(str(args.content));
      return `Succeeded. Wrote ${plural(n, 'line')}.`;
    }
    case 'grep': {
      if (/^no matches found/i.test(text.trim())) return 'No matches found.';
      const n = text.split('\n').filter(line => /^[^\s].*?:\d+[:-]/.test(line)).length || countLines(text);
      return `Found ${plural(n, 'match', 'matches')}.${details.matchLimitReached ? ' (limit reached)' : ''}`;
    }
    case 'find': {
      if (/^no files found/i.test(text.trim())) return 'No files found.';
      return `Found ${plural(countLines(text), 'file')}.${details.resultLimitReached ? ' (limit reached)' : ''}`;
    }
    case 'ls':
      return /^\(empty directory\)/i.test(text.trim()) ? 'Empty directory.' : `Listed ${plural(countLines(text), 'entry', 'entries')}.`;
    case 'todo':
      return todoSummary(args.items);
    case 'web_search':
    case 'web_fetch':
    case 'code':
    case 'data':
      // These tools put a one-line summary (count/provider, kind/range, counts, rows) first.
      return oneLine(text.split('\n').find(line => line.trim()) ?? 'Done.', 160);
    default:
      break;
  }
  const first = text.split('\n').find(line => line.trim()) ?? '';
  const n = countLines(text);
  if (!first) return 'Done.';
  return n > 1 ? `${oneLine(first, 100)} (+${plural(n - 1, 'more line')})` : oneLine(first, 140);
}

export interface TodoItemLike {
  content?: unknown;
  status?: unknown;
}

export function todoSummary(items: unknown): string {
  const list = Array.isArray(items) ? (items as TodoItemLike[]) : [];
  const done = list.filter(i => i.status === 'completed').length;
  const active = list.filter(i => i.status === 'in_progress').length;
  return `${list.length} total (${list.length - done - active} pending, ${active} in progress, ${done} completed)`;
}

export function todoLines(items: unknown): Array<{ mark: string; text: string; status: string }> {
  const list = Array.isArray(items) ? (items as TodoItemLike[]) : [];
  return list.map(item => {
    const status = str(item.status);
    const mark = status === 'completed' ? '☒' : status === 'in_progress' ? '◐' : '☐';
    return { mark, text: oneLine(str(item.content), 200), status };
  });
}

// ---------------------------------------------------------------------------------------------
// Assistant text marker and working indicator

export const ASSISTANT_GLYPH = '⛬';

/** Prefix the first paragraph of an assistant text block with the Droid glyph (display-only). */
export function prefixAssistantMarkdown(markdown: string, glyph = ASSISTANT_GLYPH): string {
  const match = /^(\s*)(\S[^\n]*)/.exec(markdown);
  if (!match) return markdown;
  const first = match[2];
  // Block-level syntax keeps its meaning only at column 0; give those blocks their own marker line.
  if (/^(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>|\||<|\$\$)/.test(first)) {
    return `${match[1]}${glyph}\n\n${markdown.slice(match[1].length)}`;
  }
  if (first.startsWith(glyph)) return markdown;
  return `${match[1]}${glyph}  ${markdown.slice(match[1].length)}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function workingMessage(elapsedMs: number, runningTools: readonly string[]): string {
  const verb = runningTools.length === 0
    ? 'Thinking…'
    : runningTools.length === 1
      ? `Running ${runningTools[0]}…`
      : `Running ${runningTools.length} tools…`;
  return `${verb} (${formatElapsed(elapsedMs)} · esc to interrupt)`;
}

export interface TurnChanges {
  files: ReadonlyArray<{ path: string; added: number; removed: number; binary?: boolean }>;
  total: number;
}

/** "Changed 3 files (+42 −7)" plus up to `limit` per-file rows, largest first. */
export function formatTurnChanges(changes: TurnChanges, limit = 5): { headline: string; rows: string[]; more: number } {
  const added = changes.files.reduce((sum, f) => sum + f.added, 0);
  const removed = changes.files.reduce((sum, f) => sum + f.removed, 0);
  const n = changes.total;
  const headline = `Changed ${n} file${n === 1 ? '' : 's'} (+${added} −${removed})`;
  const sorted = [...changes.files].sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path));
  const rows = sorted.slice(0, limit).map(f => `${oneLine(f.path, 70)}  ${f.binary ? 'binary' : `+${f.added} −${f.removed}`}`);
  return { headline, rows, more: Math.max(0, n - rows.length) };
}

// Pi's system theme gives user messages a blue-violet panel, extension notes (plan steps, skills,
// compaction) a violet one, and dialog titles, selections and list bullets a violet accent. In
// the Droid style the panels use the theme's neutral panel (derived from the terminal background)
// and the violet accents use the brand orange.
export const DROID_BG_TONE: Readonly<Record<string, string>> = { userMessageBg: 'toolPendingBg', customMessageBg: 'toolPendingBg' };
export const DROID_FG_TONE: Readonly<Record<string, string>> = {
  accent: '\x1b[38;5;208m',
  borderAccent: '\x1b[38;5;208m',
  customMessageLabel: '\x1b[38;5;208m',
  mdListBullet: '\x1b[38;5;208m',
};
const TONE_PATCHED = Symbol.for('pi-protected.droid-tone');

type TokenAnsiFn = (this: { fgAnsi: Map<string, string>; bgAnsi: Map<string, string> }, ansi: Map<string, string>, token: string) => string;

/**
 * Remap theme tokens at the lookup every Theme method goes through (`tokenAnsi`). Patching the
 * class, not one instance, keeps working when Pi regenerates the system theme from the terminal's
 * reported colors; `enabled()` makes it a no-op in the classic style. Returns false (and changes
 * nothing) if the Theme internals are not what this expects.
 */
export function installDroidTone(theme: unknown, enabled: () => boolean): boolean {
  const ctor = (theme as { constructor?: { prototype?: Record<PropertyKey, unknown> } } | undefined)?.constructor;
  const proto = ctor?.prototype;
  if (!proto || ctor === Object) return false;
  if (proto[TONE_PATCHED]) return true;
  const original = proto.tokenAnsi as TokenAnsiFn | undefined;
  if (typeof original !== 'function') return false;
  const patched: TokenAnsiFn = function (ansi, token) {
    if (enabled()) {
      if (ansi === this.bgAnsi) {
        const target = DROID_BG_TONE[token];
        if (target && this.bgAnsi.has(target)) return original.call(this, ansi, target);
      } else if (ansi === this.fgAnsi && token in DROID_FG_TONE && this.fgAnsi.has(token)) {
        return DROID_FG_TONE[token];
      }
    }
    return original.call(this, ansi, token);
  };
  proto.tokenAnsi = patched;
  proto[TONE_PATCHED] = true;
  return true;
}
