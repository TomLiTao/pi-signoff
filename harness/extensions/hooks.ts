import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart';

export interface HookEntry {
  event: HookEventName;
  command: string;
  matcher?: string;
  writable: boolean;
  timeoutSec: number;
  runOnError: boolean;
}

export interface LoadedHooksConfig {
  hooksFile: string;
  present: boolean;
  hooks: Record<HookEventName, HookEntry[]>;
  error?: string;
}

export interface HooksShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HooksOptions {
  enabled: boolean;
  hooksFile?: string;
  workspaceRoot?: string;
  canWrite: (cwd: string) => boolean;
  ensureWriteCheckpoint?: (ctx: ExtensionContext) => Promise<boolean>;
  runSandboxShell: (
    command: string,
    cwd: string,
    stdinJson: string,
    timeoutSec: number,
    forceReadonly: boolean,
    signal?: AbortSignal,
  ) => Promise<HooksShellResult>;
  onAfterWritableHook?: () => void;
  onAudit?: (entry: { tool: string; args: unknown; decision: 'allow' | 'block'; rule: string }) => void;
}

export interface HooksHandle {
  reload(): LoadedHooksConfig;
  statusLine(): string;
  summary(): { enabled: boolean; total: number; error?: string };
}

const HOOK_EVENTS: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'];
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_COMMAND_LEN = 8192;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 4096;
const MAX_STOP_OUTPUT_CHARS = 8192;
const MAX_SESSION_START_CHARS = 4096;
const DEFAULT_TIMEOUT_SEC = 30;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 120;

const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

function emptyHooks(): Record<HookEventName, HookEntry[]> {
  return { PreToolUse: [], PostToolUse: [], Stop: [], SessionStart: [] };
}

function sanitizeHookText(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}… [truncated]`;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesHookTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher.trim() === '' || matcher.trim() === '*') return true;
  const bare = toolName.startsWith('pi_safe_') ? toolName.slice('pi_safe_'.length) : toolName;
  const parts = matcher.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.some(part => {
    if (part === '*') return true;
    if (part.includes('*')) {
      const rx = globToRegExp(part);
      return rx.test(toolName) || rx.test(bare);
    }
    const lower = part.toLowerCase();
    return toolName.toLowerCase() === lower || bare.toLowerCase() === lower;
  });
}

function parseSingleHookObject(
  event: HookEventName,
  raw: Record<string, unknown>,
  groupMatcher?: string,
): HookEntry {
  if (raw.type !== undefined && raw.type !== 'command') {
    throw new Error(`${event} hook type must be "command".`);
  }
  if (typeof raw.command !== 'string' || !raw.command.trim() || raw.command.length > MAX_COMMAND_LEN || raw.command.includes('\0')) {
    throw new Error(`${event} hook requires a non-empty "command" string (<= 8 KiB).`);
  }
  const rawMatcher = raw.matcher !== undefined ? raw.matcher : groupMatcher;
  if (rawMatcher !== undefined && (typeof rawMatcher !== 'string' || rawMatcher.length > 256 || rawMatcher.includes('\0'))) {
    throw new Error(`${event} hook "matcher" must be a short string.`);
  }
  if (raw.writable !== undefined && typeof raw.writable !== 'boolean') {
    throw new Error(`${event} hook "writable" must be a boolean.`);
  }
  if (raw.runOnError !== undefined && typeof raw.runOnError !== 'boolean') {
    throw new Error(`${event} hook "runOnError" must be a boolean.`);
  }
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout)) {
      throw new Error(`${event} hook "timeout" must be a number in seconds.`);
    }
    timeoutSec = Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.round(raw.timeout)));
  }
  return {
    event,
    command: raw.command,
    matcher: rawMatcher as string | undefined,
    writable: raw.writable === true,
    timeoutSec,
    runOnError: raw.runOnError === true,
  };
}

export function loadHooksFile(hooksFile: string, workspaceRoot: string): LoadedHooksConfig {
  const resolvedPath = path.resolve(hooksFile);
  let wsReal: string;
  try {
    wsReal = realpathSync(workspaceRoot);
  } catch {
    wsReal = path.resolve(workspaceRoot);
  }

  if (isInsideOrEqual(wsReal, resolvedPath)) {
    return {
      hooksFile: resolvedPath,
      present: true,
      hooks: emptyHooks(),
      error: 'Hooks configuration must reside outside the project workspace.',
    };
  }

  let fd: number;
  try {
    const parentStat = lstatSync(path.dirname(resolvedPath));
    if (parentStat.isSymbolicLink()) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: 'Hooks configuration directory must not be a symlink.',
      };
    }
    const parentReal = realpathSync(path.dirname(resolvedPath));
    if (isInsideOrEqual(wsReal, parentReal)) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: 'Hooks configuration must reside outside the project workspace.',
      };
    }
    fd = openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) {
      return { hooksFile: resolvedPath, present: false, hooks: emptyHooks() };
    }
    return {
      hooksFile: resolvedPath,
      present: true,
      hooks: emptyHooks(),
      error: 'Hooks configuration must be a regular non-symlink file.',
    };
  }

  let rawText: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: 'Hooks configuration must be a user-owned regular file without hardlinks.',
      };
    }
    if ((st.mode & 0o077) !== 0) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: `Hooks configuration must have private permissions (chmod 600 ${resolvedPath}).`,
      };
    }
    if (st.size > MAX_CONFIG_BYTES) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: 'Hooks configuration exceeds 64 KiB.',
      };
    }
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    if (total !== st.size) {
      return {
        hooksFile: resolvedPath,
        present: true,
        hooks: emptyHooks(),
        error: 'Hooks configuration changed while reading.',
      };
    }
    rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, total));
  } catch (error) {
    return {
      hooksFile: resolvedPath,
      present: true,
      hooks: emptyHooks(),
      error: `Could not read hooks configuration: ${(error as Error).message}`,
    };
  } finally {
    closeSync(fd);
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object.');
    }
    const rootObj = parsed as Record<string, unknown>;
    const container = rootObj.hooks !== undefined
      ? (typeof rootObj.hooks === 'object' && rootObj.hooks !== null && !Array.isArray(rootObj.hooks)
        ? (rootObj.hooks as Record<string, unknown>)
        : (() => { throw new Error('"hooks" must be an object.'); })())
      : rootObj;

    const result = emptyHooks();
    for (const [key, val] of Object.entries(container)) {
      if (!HOOK_EVENTS.includes(key as HookEventName)) {
        throw new Error(`Unsupported hook event "${key}" (expected: ${HOOK_EVENTS.join(', ')}).`);
      }
      if (!Array.isArray(val)) {
        throw new Error(`Hook event "${key}" must map to an array.`);
      }
      const eventName = key as HookEventName;
      for (const item of val) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`Each "${key}" entry must be an object.`);
        }
        const entryObj = item as Record<string, unknown>;
        if (Array.isArray(entryObj.hooks)) {
          const groupMatcher = entryObj.matcher !== undefined ? String(entryObj.matcher) : undefined;
          if (entryObj.matcher !== undefined && typeof entryObj.matcher !== 'string') {
            throw new Error(`"${key}" matcher must be a string.`);
          }
          for (const nested of entryObj.hooks) {
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
              throw new Error(`Nested "${key}" hook must be an object.`);
            }
            result[eventName].push(parseSingleHookObject(eventName, nested as Record<string, unknown>, groupMatcher));
          }
        } else {
          result[eventName].push(parseSingleHookObject(eventName, entryObj));
        }
      }
      if (result[eventName].length > 16) {
        throw new Error(`Too many hooks for "${key}" (max 16).`);
      }
    }
    return { hooksFile: resolvedPath, present: true, hooks: result };
  } catch (error) {
    return {
      hooksFile: resolvedPath,
      present: true,
      hooks: emptyHooks(),
      error: (error as Error).message,
    };
  }
}

function encodeHookStdin(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') <= MAX_STDIN_BYTES) return json;
  const slim = { ...payload, inputTruncated: true };
  delete slim.input;
  return JSON.stringify(slim).slice(0, MAX_STDIN_BYTES);
}

function parseStopDecision(result: HooksShellResult): { shouldContinue: boolean; reason: string } {
  const trimmedOut = result.stdout.trim();
  if (result.code === 0 && trimmedOut.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmedOut) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        if (parsed.continue === true || parsed.decision === 'block') {
          const msg = typeof parsed.reason === 'string' && parsed.reason.trim()
            ? parsed.reason
            : typeof parsed.message === 'string' && parsed.message.trim()
              ? parsed.message
              : (result.stderr.trim() || trimmedOut);
          return { shouldContinue: true, reason: sanitizeHookText(msg, MAX_STOP_OUTPUT_CHARS) };
        }
        return { shouldContinue: false, reason: '' };
      }
    } catch {
      // Plain non-JSON stdout on exit 0 settles normally.
    }
  }
  if (result.code !== 0) {
    const raw = [result.stderr.trim(), trimmedOut].filter(Boolean).join('\n')
      || `Stop hook exited with code ${result.code ?? 'signal'}.`;
    return { shouldContinue: true, reason: sanitizeHookText(raw, MAX_STOP_OUTPUT_CHARS) };
  }
  return { shouldContinue: false, reason: '' };
}

export function registerHooks(pi: ExtensionAPI, options: HooksOptions): HooksHandle {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const hooksFile = options.hooksFile
    ?? (process.env.PI_PROTECTED_HOOKS_FILE
      ? path.resolve(process.env.PI_PROTECTED_HOOKS_FILE)
      : path.join(os.homedir(), '.config/pi-protected/hooks.json'));

  let state: LoadedHooksConfig = options.enabled
    ? loadHooksFile(hooksFile, workspaceRoot)
    : { hooksFile, present: false, hooks: emptyHooks() };
  let stopContinuedThisRun = false;
  let pendingSessionStartOutput: string | null = null;

  function totalCount(cfg = state): number {
    return HOOK_EVENTS.reduce((sum, k) => sum + cfg.hooks[k].length, 0);
  }

  function reload(): LoadedHooksConfig {
    state = options.enabled
      ? loadHooksFile(hooksFile, workspaceRoot)
      : { hooksFile, present: false, hooks: emptyHooks() };
    return state;
  }

  function statusLine(): string {
    if (!options.enabled) return 'disabled (--no-hooks)';
    if (state.error) return `error (${state.error})`;
    if (!state.present || totalCount() === 0) return 'none configured';
    const parts = HOOK_EVENTS
      .filter(k => state.hooks[k].length > 0)
      .map(k => `${k}:${state.hooks[k].length}`);
    return `active (${parts.join(', ')})`;
  }

  async function executeHook(
    entry: HookEntry,
    ctx: ExtensionContext,
    payload: Record<string, unknown>,
  ): Promise<HooksShellResult> {
    const allowWrite = entry.writable && options.canWrite(ctx.cwd);
    let forceReadonly = !allowWrite;
    if (allowWrite && options.ensureWriteCheckpoint) {
      const ok = await options.ensureWriteCheckpoint(ctx);
      if (!ok) forceReadonly = true;
    }
    try {
      return await options.runSandboxShell(
        entry.command,
        ctx.cwd,
        encodeHookStdin(payload),
        entry.timeoutSec,
        forceReadonly,
        ctx.signal,
      );
    } finally {
      if (!forceReadonly) options.onAfterWritableHook?.();
    }
  }

  pi.registerCommand('hooks', {
    description: 'Inspect or reload user-level sandboxed hooks (~/.config/pi-protected/hooks.json): /hooks [status | reload]',
    async handler(raw, ctx) {
      const sub = raw.trim().toLowerCase();
      if (sub && sub !== 'status' && sub !== 'reload') {
        ctx.ui.notify('Usage: /hooks [status | reload]', 'warning');
        return;
      }
      if (!options.enabled) {
        ctx.ui.notify('Hooks are disabled for this session (--no-hooks).', 'info');
        return;
      }
      if (sub === 'reload') reload();
      if (state.error) {
        ctx.ui.notify(`Hooks (${state.hooksFile}): error — ${state.error}`, 'warning');
        return;
      }
      if (!state.present || totalCount() === 0) {
        ctx.ui.notify(`Hooks: none configured (create mode-0600 ${state.hooksFile} to add user-level hooks).`, 'info');
        return;
      }
      const lines = [`Hooks (${state.hooksFile}):`];
      for (const ev of HOOK_EVENTS) {
        for (const h of state.hooks[ev]) {
          const matcher = h.matcher ? ` [${h.matcher}]` : '';
          const mode = h.writable ? ' (writable when mode allows)' : ' (read-only)';
          lines.push(`  ${ev}${matcher}: ${sanitizeHookText(h.command, 120)}${mode}`);
        }
      }
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  if (!options.enabled) {
    return {
      reload,
      statusLine,
      summary: () => ({ enabled: false, total: 0 }),
    };
  }

  pi.on('session_start', async (event, ctx) => {
    stopContinuedThisRun = false;
    pendingSessionStartOutput = null;
    reload();
    if (state.error) {
      if (ctx.hasUI) ctx.ui.notify(`Protected hooks disabled due to config issue: ${state.error}`, 'warning');
      return;
    }
    const hooks = state.hooks.SessionStart;
    if (hooks.length === 0) return;

    const outputs: string[] = [];
    for (const hook of hooks) {
      try {
        const res = await executeHook(hook, ctx, {
          event: 'SessionStart',
          cwd: ctx.cwd,
          reason: event.reason,
        });
        if (res.code !== 0) {
          const msg = sanitizeHookText(res.stderr || res.stdout || `exit ${res.code}`, 400);
          if (ctx.hasUI) ctx.ui.notify(`SessionStart hook failed: ${msg}`, 'warning');
        } else if (res.stdout.trim()) {
          outputs.push(sanitizeHookText(res.stdout, MAX_SESSION_START_CHARS));
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`SessionStart hook error: ${(error as Error).message}`, 'warning');
      }
    }
    if (outputs.length > 0) {
      pendingSessionStartOutput = sanitizeHookText(outputs.join('\n\n'), MAX_SESSION_START_CHARS);
    }
  });

  pi.on('before_agent_start', async event => {
    if (event.messageType === 'user') {
      stopContinuedThisRun = false;
    }
    if (!pendingSessionStartOutput) return;
    const content = `[SessionStart hook output]\n${pendingSessionStartOutput}`;
    pendingSessionStartOutput = null;
    return {
      message: {
        customType: 'pi-hook-session-start',
        content,
        display: false,
      },
    };
  });

  pi.on('tool_call', async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
    const matching = state.hooks.PreToolUse.filter(h => matchesHookTool(h.matcher, event.toolName));
    if (matching.length === 0) return;

    for (const hook of matching) {
      if (ctx.signal?.aborted) {
        return { block: true, reason: 'PreToolUse hook aborted.' };
      }
      try {
        const res = await executeHook(hook, ctx, {
          event: 'PreToolUse',
          cwd: ctx.cwd,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: event.input,
        });
        if (res.code !== 0) {
          const detail = sanitizeHookText(
            res.stderr || res.stdout || `exit code ${res.code ?? 'signal'}`,
            MAX_REASON_CHARS,
          );
          const reason = `Blocked by PreToolUse hook: ${detail}`;
          options.onAudit?.({
            tool: event.toolName,
            args: event.input,
            decision: 'block',
            rule: 'hook-pre-tool-block',
          });
          return { block: true, reason };
        }
      } catch (error) {
        const msg = sanitizeHookText((error as Error).message || 'execution failed', 400);
        options.onAudit?.({
          tool: event.toolName,
          args: event.input,
          decision: 'block',
          rule: 'hook-pre-tool-error',
        });
        return { block: true, reason: `Blocked by PreToolUse hook failure: ${msg}` };
      }
    }
  });

  pi.on('tool_result', async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | void> => {
    const matching = state.hooks.PostToolUse.filter(
      h => matchesHookTool(h.matcher, event.toolName) && (!event.isError || h.runOnError),
    );
    if (matching.length === 0) return;

    const notes: string[] = [];
    for (const hook of matching) {
      if (ctx.signal?.aborted) break;
      try {
        const res = await executeHook(hook, ctx, {
          event: 'PostToolUse',
          cwd: ctx.cwd,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: event.input,
          isError: event.isError,
        });
        if (res.code !== 0) {
          const detail = sanitizeHookText(res.stderr || res.stdout || `exit ${res.code}`, MAX_REASON_CHARS);
          notes.push(`[PostToolUse hook exited ${res.code ?? 'non-zero'}]\n${detail}`);
        } else if (res.stdout.trim()) {
          notes.push(`[PostToolUse hook output]\n${sanitizeHookText(res.stdout, MAX_REASON_CHARS)}`);
        }
      } catch (error) {
        notes.push(`[PostToolUse hook error: ${sanitizeHookText((error as Error).message, 400)}]`);
      }
    }
    if (notes.length === 0) return;
    const noteBlock = { type: 'text' as const, text: notes.join('\n\n') };
    return {
      content: [...event.content, noteBlock],
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });

  pi.on('agent_before_settle', async (
    event: AgentBeforeSettleEvent,
    ctx,
  ): Promise<AgentBeforeSettleEventResult | void> => {
    if (event.outcome !== 'completed' || ctx.signal?.aborted) return;
    const stopHooks = state.hooks.Stop;
    if (stopHooks.length === 0) return;

    const reasons: string[] = [];
    for (const hook of stopHooks) {
      if (ctx.signal?.aborted) return;
      try {
        const res = await executeHook(hook, ctx, {
          event: 'Stop',
          cwd: ctx.cwd,
          outcome: event.outcome,
        });
        const decision = parseStopDecision(res);
        if (decision.shouldContinue) {
          reasons.push(decision.reason);
          break;
        }
      } catch (error) {
        const msg = sanitizeHookText((error as Error).message, 400);
        if (ctx.hasUI) ctx.ui.notify(`Stop hook error: ${msg}`, 'warning');
      }
    }

    if (reasons.length === 0) return;
    const combined = reasons.join('\n\n');

    if (stopContinuedThisRun) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Stop hook failed again after 1 continuation; settling (${sanitizeHookText(combined, 180)}).`, 'warning');
      }
      return {
        entries: [{
          type: 'custom',
          customType: 'pi-hook-stop-capped',
          data: { reason: combined },
        }],
        continue: false,
      };
    }

    stopContinuedThisRun = true;
    return {
      entries: [{
        type: 'custom_message',
        customType: 'pi-hook-stop',
        content: `[Untrusted Stop hook output — address before finishing]\n${combined}`,
        display: true,
      }],
      continue: true,
    };
  });

  return {
    reload,
    statusLine,
    summary: () => ({ enabled: true, total: totalCount(), error: state.error }),
  };
}
