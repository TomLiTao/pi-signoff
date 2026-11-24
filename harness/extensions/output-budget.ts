import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Output budget for noisy tools.
 *
 * A tool result longer than its tool's budget is shortened to a head and a tail, and its full text is
 * saved in a per-session folder that sandbox.py mounts read-only at OUTPUT_MOUNT in later tool and
 * shell calls, so the model can page through it with pi_safe_read or search it with pi_safe_grep
 * instead of re-running the command or carrying the whole text in context for the rest of the session.
 *
 * Pi's own bash tool also keeps the full output of a long command in a temp file and names it in the
 * result. That file lives in the call's private /tmp and is gone once the call ends, so the tool worker
 * sends its contents back and `adoptFullOutput` saves them here and rewrites the path.
 */

export const OUTPUT_MOUNT = '/tmp/pi-tool-output';

/** Characters kept in context per tool, and the share of them taken from the start of the output. */
export const OUTPUT_BUDGETS: Record<string, { chars: number; head: number }> = {
  // Command output: errors and summaries come last.
  pi_safe_bash: { chars: 16_000, head: 0.25 },
  pi_safe_job_status: { chars: 16_000, head: 0.25 },
  pi_safe_test: { chars: 16_000, head: 0.25 },
  pi_safe_run_status: { chars: 16_000, head: 0.25 },
  // Listings and search results: the first entries are the useful ones.
  pi_safe_git: { chars: 24_000, head: 0.8 },
  pi_safe_grep: { chars: 16_000, head: 0.85 },
  pi_safe_find: { chars: 12_000, head: 0.9 },
  pi_safe_ls: { chars: 12_000, head: 0.9 },
  pi_safe_data: { chars: 16_000, head: 0.8 },
  pi_safe_code: { chars: 16_000, head: 0.8 },
};

/** Total bytes saved per session; beyond it results are still shortened, but not saved. */
const SESSION_SAVE_LIMIT = 256 * 1024 * 1024;
/** Largest single saved output. */
const FILE_SAVE_LIMIT = 16 * 1024 * 1024;
/** Session folders left behind by a crash are removed after this long. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

export function outputBaseDir(home = homedir()): string {
  return path.join(home, '.cache', 'pi-protected', 'tool-output');
}

export interface Shortened {
  text: string;
  omittedLines: number;
  omittedChars: number;
}

/**
 * Keep `limit` characters of `text`: a head and a tail, cut at line breaks where that loses little.
 * Returns undefined when the text already fits.
 */
export function shortenText(text: string, limit: number, headShare: number, notice: (omittedLines: number, omittedChars: number) => string): Shortened | undefined {
  if (text.length <= limit) return undefined;
  const headChars = Math.max(0, Math.floor(limit * headShare));
  const tailChars = Math.max(0, limit - headChars);
  let headEnd = headChars;
  const lastBreak = text.lastIndexOf('\n', headChars);
  if (lastBreak >= headChars * 0.5) headEnd = lastBreak + 1;
  let tailStart = text.length - tailChars;
  const nextBreak = text.indexOf('\n', tailStart);
  if (nextBreak !== -1 && nextBreak < tailStart + tailChars * 0.5) tailStart = nextBreak + 1;
  if (tailStart < headEnd) tailStart = headEnd;
  const omitted = text.slice(headEnd, tailStart);
  const omittedLines = omitted.length ? omitted.split('\n').length - (omitted.endsWith('\n') ? 1 : 0) : 0;
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const sep = head && !head.endsWith('\n') ? '\n' : '';
  return {
    text: `${head}${sep}${notice(omittedLines, omitted.length)}${tail ? `\n${tail}` : ''}`,
    omittedLines,
    omittedChars: omitted.length,
  };
}

export interface OutputBudget {
  /** Host folder to mount at OUTPUT_MOUNT, once something has been saved. */
  hostDir(): string | undefined;
  /** Save a full output; returns its path as seen inside the sandbox, or undefined if not saved. */
  save(toolCallId: string, toolName: string, text: string): string | undefined;
  /** Save the full output a tool reported at `oldPath` and point the result (or error text) at the copy. */
  adoptFullOutput<T>(toolCallId: string, toolName: string, oldPath: string, fullText: string, value: T): T;
  /** Apply the budget to one tool result; returns the replacement content, or undefined to keep it. */
  apply(event: { toolName?: string; toolCallId: string; content: Array<{ type: string; text?: string }> }): Array<{ type: string; text?: string }> | undefined;
  cleanup(): void;
}

export function createOutputBudget(options: { base?: string; budgets?: typeof OUTPUT_BUDGETS; now?: () => number } = {}): OutputBudget {
  const base = options.base ?? outputBaseDir();
  const budgets = options.budgets ?? OUTPUT_BUDGETS;
  const now = options.now ?? Date.now;
  let dir: string | undefined;
  let failed = false;
  let saved = 0;
  let sequence = 0;
  // Calls whose full output is already saved (bash's own temp file), so apply() points there.
  const fullOutputs = new Map<string, string>();

  function ensureDir(): string | undefined {
    if (dir || failed) return dir;
    try {
      mkdirSync(base, { recursive: true, mode: 0o700 });
      pruneStale();
      dir = mkdtempSync(path.join(base, 's-'));
    } catch {
      failed = true;
    }
    return dir;
  }

  function pruneStale(): void {
    try {
      for (const name of readdirSync(base)) {
        if (!name.startsWith('s-')) continue;
        const full = path.join(base, name);
        try {
          if (now() - statSync(full).mtimeMs > STALE_MS) rmSync(full, { recursive: true, force: true });
        } catch {
          // Another session may be removing it.
        }
      }
    } catch {
      // Nothing to prune.
    }
  }

  function save(toolCallId: string, toolName: string, text: string): string | undefined {
    const bytes = Buffer.byteLength(text);
    if (bytes > FILE_SAVE_LIMIT || saved + bytes > SESSION_SAVE_LIMIT) return undefined;
    const folder = ensureDir();
    if (!folder) return undefined;
    const name = `${String(++sequence).padStart(4, '0')}-${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    try {
      writeFileSync(path.join(folder, name), text, { mode: 0o600, flag: 'wx' });
    } catch {
      return undefined;
    }
    saved += bytes;
    const inSandbox = `${OUTPUT_MOUNT}/${name}`;
    fullOutputs.set(toolCallId, inSandbox);
    return inSandbox;
  }

  return {
    hostDir: () => dir,
    save,
    adoptFullOutput(toolCallId, toolName, oldPath, fullText, value) {
      const savedPath = save(toolCallId, toolName, fullText);
      const replacement = savedPath ?? '(not kept: the command ran in a sandbox whose /tmp is discarded after each call)';
      const escape = (s: string) => JSON.stringify(s).slice(1, -1);
      return JSON.parse(JSON.stringify(value).split(escape(oldPath)).join(escape(replacement)));
    },
    apply(event) {
      const existing = fullOutputs.get(event.toolCallId);
      fullOutputs.delete(event.toolCallId);
      const budget = event.toolName ? budgets[event.toolName] : undefined;
      if (!budget || !Array.isArray(event.content)) return undefined;
      const texts = event.content.filter(part => part.type === 'text' && typeof part.text === 'string');
      const total = texts.reduce((sum, part) => sum + (part.text as string).length, 0);
      if (total <= budget.chars) return undefined;
      const fullText = texts.map(part => part.text).join('\n');
      const savedPath = existing ?? save(event.toolCallId, event.toolName as string, fullText);
      fullOutputs.delete(event.toolCallId);
      const where = savedPath
        ? `Full output: ${savedPath} (read it with pi_safe_read offset/limit or search it with pi_safe_grep; do not re-run the command to see it).`
        : 'The full output was not kept; narrow the command (filters, head/tail, --stat) to see the omitted part.';
      const shortened = shortenText(fullText, budget.chars, budget.head, (lines, chars) =>
        `[… ${lines.toLocaleString('en-US')} lines (${chars.toLocaleString('en-US')} characters) omitted. ${where}]`);
      if (!shortened) return undefined;
      const others = event.content.filter(part => !(part.type === 'text' && typeof part.text === 'string'));
      return [{ type: 'text', text: shortened.text }, ...others];
    },
    cleanup() {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Left for the next session's stale-folder prune.
        }
      }
      dir = undefined;
      fullOutputs.clear();
    },
  };
}

/** Register the budget as the last tool_result handler, so hooks and diagnostics see the full text. */
export function registerOutputBudget(pi: ExtensionAPI, budget: OutputBudget): void {
  pi.on('tool_result', async event => {
    const e = event as unknown as { toolName?: string; toolCallId: string; content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    const content = budget.apply(e);
    if (!content) return undefined;
    // Keep structured output (codemode scripts read it) instead of letting Pi drop it with the content.
    return e.structuredContent !== undefined
      ? { content: content as never, structuredContent: e.structuredContent as never }
      : { content: content as never };
  });
  pi.on('session_shutdown', async () => budget.cleanup());
}
