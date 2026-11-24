import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import {
  checkShellDeny,
  editDecision,
  isAllowedPrefixArgv,
  prefixRuleAllows,
  shellNeedsApproval,
  suggestShellPrefix,
  tokenizePrefixCommand,
  visible,
  type DenyArgvRule,
  type Policy,
} from './approvals.ts';
import type { AuditEvent } from './audit.ts';
import { autonomyAllowsEdit, autonomyAllowsShell, type AutonomyLevel } from './autonomy.ts';
import { openToolName, SAFE_OPEN_EXTENSIONS } from './desktop.ts';
import {
  checkScriptGrants,
  describeScriptGrant,
  makeScriptGrant,
  neverAutoMatch,
  parseScriptCommand,
  type ScriptGrant,
} from './script-grants.ts';
import type { PlanMode, PlanStep } from './pi-plan/src/types.ts';

export const planToolName = 'pi_safe_plan';

export type WriteSubMode = 'ask-edits' | 'accept-edits' | 'workflow';

export interface RequestedPlanPermissions {
  shellPrefixes?: string[];
  shellCommands?: string[];
  files?: string[];
  openFiles?: string[];
  worktreeSubagents?: boolean;
  scripts?: string[];
}

export interface RejectedPermissionItem {
  kind: 'shellPrefix' | 'shellCommand' | 'file' | 'openFile' | 'worktree' | 'script';
  value: string;
  reason: string;
}

export interface ClassifiedPlanPermissions {
  shellPrefixes: string[][];
  shellCommands: string[];
  scripts: Array<ScriptGrant & { files: string[] }>;
  askFiles: string[];
  plannedFiles: string[];
  openFiles: string[];
  worktreeSubagents: boolean;
  alreadyAllowed: string[];
  deferredSymlinks: string[];
  rejected: RejectedPermissionItem[];
}

export interface ActivePlanGrant {
  summary?: string;
  cwd: string;
  shellPrefixes: string[][];
  exactCommands: Set<string>;
  scripts: ScriptGrant[];
  askFiles: Set<string>;
  plannedFiles: Set<string>;
  openFiles: Set<string>;
  worktreeSubagents: boolean;
  approvedAt: string;
}

export type ApprovedRejectedMethod =
  | 'session-exact'
  | 'session-prefix'
  | 'project-exact'
  | 'project-prefix'
  | 'session-script'
  | 'project-script';

export interface RejectedExecutionEntry {
  id: number;
  cwd: string;
  kind: 'shell' | 'file' | 'open' | 'worktree';
  value: string;
  suggestedPrefix?: string[];
  /** The command is a workspace script run that can be approved as a script grant. */
  suggestedScript?: string;
  /** A script grant for this script exists, but its content changed after approval. */
  scriptChanged?: boolean;
  fileDecision?: 'allow' | 'ask';
  tool: string;
  planSummary?: string;
  count: number;
  firstRejectedAt: string;
  lastRejectedAt: string;
  status: 'rejected' | 'approved';
  approvedHow?: ApprovedRejectedMethod;
}

export interface PendingPlanProposal {
  summary?: string;
  steps: PlanStep[];
  permissions?: RequestedPlanPermissions;
}

export interface ShellStoreAdapter {
  inProject(cwd: string): boolean;
  allows(command: string): boolean;
  allowsPrefix(command: string, neverSessionAllow?: readonly string[]): boolean;
  denyRules(): DenyArgvRule[];
  add(command: string): void;
  addPrefix(argv: readonly string[], neverSessionAllow?: readonly string[]): void;
  scriptGrants?(): ScriptGrant[];
  allowsScript?(command: string, policy?: Partial<Policy>): boolean;
  addScript?(command: string, policy?: Partial<Policy>, pinned?: ScriptGrant): unknown;
}

export interface PlanApprovalOutcome {
  action:
    | 'execute-with-grant'
    | 'execute-auto-medium'
    | 'execute-saved-shell'
    | 'execute-ask-each'
    | 'execute-no-grant'
    | 'stay-in-plan'
    /** The user asked for changes; `feedback` holds them (empty in plan mode, where pi-plan asks). */
    | 'revise'
    /** The user rejected the plan. */
    | 'reject'
    /** The agent turn was aborted while the review was open; the user made no decision. */
    | 'interrupted'
    /** The UI could not show the review (it closed at once, repeatedly); the user made no decision. */
    | 'no-decision';
  granted: boolean;
  savedShellCount: number;
  classified: ClassifiedPlanPermissions;
  feedback?: string;
}

/**
 * What the model is told when a plan review ends without approval, and the audit rule. Each case says
 * what actually happened: only 'reject' is reported as the user rejecting the plan.
 */
export function undecidedPlanResult(outcome: PlanApprovalOutcome): { rule: string; text: string } | undefined {
  const noRun = 'Do NOT execute the planned edits or shell commands.';
  switch (outcome.action) {
    case 'reject':
      return { rule: 'plan-rejected', text: `The user rejected this plan. ${noRun} Acknowledge briefly and wait for the user's next instruction; do not propose a replacement plan unless asked.` };
    case 'revise':
      return {
        rule: 'plan-revise',
        text: `The user asked for changes before approving this plan. ${noRun} Their requested changes (from the user):\n${outcome.feedback ?? ''}\n\nRevise the plan to address them and call ${planToolName} again with the updated plan.`,
      };
    case 'interrupted':
      return { rule: 'plan-interrupted', text: `The plan review was interrupted before the user decided; the user neither approved nor rejected it. ${noRun} Stop and wait for the user.` };
    case 'no-decision':
      return { rule: 'plan-no-decision', text: `The plan review could not be shown, so the user has not decided. ${noRun} Tell the user the plan is awaiting their review and stop.` };
    default:
      return undefined;
  }
}

/** A review dismissed this quickly, this many times in a row, means the UI cannot show it. */
const UNSHOWABLE_REVIEW_MS = 250;
const UNSHOWABLE_REVIEW_TRIES = 3;

function sanitizeStepLine(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/^\s*(?:\d+[.)]|[-*])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const capped = cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

export function normalizePlanSteps(rawSteps: readonly string[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const raw of rawSteps.slice(0, 20)) {
    if (typeof raw !== 'string') continue;
    const text = sanitizeStepLine(raw);
    if (text.length >= 3) {
      out.push({ step: out.length + 1, text, completed: false });
    }
  }
  return out;
}

export function canonicalRelativeWorkspacePath(cwd: string, input: string): string | null {
  const normalized = input.replace(/^@/, '').replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();
  if (!normalized || normalized.startsWith('~') || normalized.startsWith('file://')) return null;
  const relative = path.relative(cwd, path.resolve(cwd, normalized));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function hasSymbolicLinkInChain(cwd: string, relativePosix: string): boolean {
  let current = cwd;
  for (const part of relativePosix.split('/')) {
    if (!part) continue;
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

/**
 * Extract structured permission declarations from a markdown `Permissions:` section
 * when the user ran `/plan` mode and the model wrote text instead of calling `pi_safe_plan`.
 */
export function extractPlanPermissions(message: string): RequestedPlanPermissions | undefined {
  const headerMatch = message.match(
    /(?:^|\n)\s*(?:#{1,3}\s+)?\*{0,2}(?:Required\s+)?Permissions(?:\s+needed)?\*{0,2}\s*[:：]\s*\*{0,2}\s*\n/i,
  );
  if (!headerMatch) return undefined;

  const start = message.indexOf(headerMatch[0]) + headerMatch[0].length;
  const rest = message.slice(start);
  const shellPrefixes: string[] = [];
  const shellCommands: string[] = [];
  const files: string[] = [];
  const openFiles: string[] = [];
  const scripts: string[] = [];
  let worktreeSubagents = false;

  for (const rawLine of rest.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^(?:#{1,3}\s+|\*{2}[A-Z][^*\n]+\*{2}\s*[:：]?)/.test(trimmed) && !/^[-*\d]/.test(trimmed)) {
      break;
    }
    const bulletMatch = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (!bulletMatch) {
      if (shellPrefixes.length || shellCommands.length || files.length || openFiles.length || scripts.length || worktreeSubagents) break;
      continue;
    }
    const body = bulletMatch[1].trim();
    if (/^(?:none|no\s+extra\s+permissions\b|read-only\s+only\b)/i.test(body.replace(/[`*]/g, ''))) {
      continue;
    }
    const unquote = (val: string) => {
      const tick = /^`([^`]+)`/.exec(val.trim());
      if (tick) return tick[1].trim();
      return val.replace(/\*{1,2}/g, '').trim();
    };
    const wtMatch = /^(?:worktree(?:\s+subagents?)?|subagents?)\s*[:：]\s*(.+)$/i.exec(body);
    if (wtMatch) {
      if (/^(?:true|yes|worker|enabled|allow)$/i.test(unquote(wtMatch[1]))) {
        worktreeSubagents = true;
      }
      continue;
    }
    const scriptMatch = /^(?:script|python\s+script)s?\s*[:：]\s*(.+)$/i.exec(body);
    if (scriptMatch) {
      const candidate = unquote(scriptMatch[1]).replace(/\s*(?:\.\.\.|…)\s*$/, '').trim();
      if (candidate) scripts.push(candidate);
      continue;
    }
    const prefixMatch = /^(?:shell\s+prefix|command\s+prefix|prefix)\s*[:：]\s*(.+)$/i.exec(body);
    if (prefixMatch) {
      const candidate = unquote(prefixMatch[1]).replace(/\s*(?:\.\.\.|…)\s*$/, '').trim();
      if (candidate) shellPrefixes.push(candidate);
      continue;
    }
    const cmdMatch = /^(?:shell(?:\s+command)?|bash|command)\s*[:：]\s*(.+)$/i.exec(body);
    if (cmdMatch) {
      const candidate = unquote(cmdMatch[1]);
      if (candidate) shellCommands.push(candidate);
      continue;
    }
    const openMatch = /^(?:open(?:\s+file)?|desktop\s+open)s?\s*[:：]\s*(.+)$/i.exec(body);
    if (openMatch) {
      const rawTarget = openMatch[1];
      const backticks = [...rawTarget.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
      if (backticks.length > 0) {
        openFiles.push(...backticks);
      } else {
        for (const part of rawTarget.split(',')) {
          const cleaned = unquote(part);
          if (cleaned) openFiles.push(cleaned);
        }
      }
      continue;
    }
    const fileMatch = /^(?:sensitive\s+file|file|edit|write|path)s?\s*[:：]\s*(.+)$/i.exec(body);
    if (fileMatch) {
      const rawTarget = fileMatch[1];
      const backticks = [...rawTarget.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
      if (backticks.length > 0) {
        files.push(...backticks);
      } else {
        for (const part of rawTarget.split(',')) {
          const cleaned = unquote(part);
          if (cleaned) files.push(cleaned);
        }
      }
    }
  }

  if (!shellPrefixes.length && !shellCommands.length && !files.length && !openFiles.length && !scripts.length && !worktreeSubagents) {
    return undefined;
  }
  return {
    ...(shellPrefixes.length ? { shellPrefixes } : {}),
    ...(scripts.length ? { scripts } : {}),
    ...(shellCommands.length ? { shellCommands } : {}),
    ...(files.length ? { files } : {}),
    ...(openFiles.length ? { openFiles } : {}),
    ...(worktreeSubagents ? { worktreeSubagents: true } : {}),
  };
}

export interface ClassifyOptions {
  cwd: string;
  policy?: Policy;
  writeSubMode: WriteSubMode;
  autonomyLevel?: AutonomyLevel;
  isWritable: boolean;
  store?: Pick<ShellStoreAdapter, 'allows' | 'allowsPrefix' | 'denyRules' | 'allowsScript'>;
  /** Never-auto script globs: such commands cannot be granted upfront; they ask on every run. */
  neverAuto?: readonly string[];
}

export function classifyPlanPermissions(
  requested: RequestedPlanPermissions | undefined,
  options: ClassifyOptions,
): ClassifiedPlanPermissions {
  const result: ClassifiedPlanPermissions = {
    shellPrefixes: [],
    shellCommands: [],
    scripts: [],
    askFiles: [],
    plannedFiles: [],
    openFiles: [],
    worktreeSubagents: false,
    alreadyAllowed: [],
    deferredSymlinks: [],
    rejected: [],
  };
  if (!requested) return result;

  const extraDeny = options.store?.denyRules() ?? [];
  const neverAllow = options.policy?.neverSessionAllow;
  const neverAutoReason = (cmd: string): string | null => {
    const hit = neverAutoMatch(cmd, options.neverAuto ?? []);
    return hit ? `${hit.target} matches the never-auto pattern "${hit.pattern}"; it asks on every run instead` : null;
  };
  const seenPrefixes = new Set<string>();
  const seenCommands = new Set<string>();
  const seenFiles = new Set<string>();
  const seenOpenFiles = new Set<string>();

  for (const raw of (requested.shellPrefixes ?? []).slice(0, 16)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/\s*(?:\.\.\.|…)\s*$/, '').trim();
    if (!trimmed || seenPrefixes.has(trimmed)) continue;
    seenPrefixes.add(trimmed);

    if (/[\r\n\x00-\x1f\x7f-\x9f]/.test(trimmed) || visible(trimmed).length > 400) {
      result.rejected.push({
        kind: 'shellPrefix',
        value: trimmed.slice(0, 120),
        reason: 'prefix contains control characters or exceeds length limit',
      });
      continue;
    }
    const tokens = tokenizePrefixCommand(trimmed);
    if (!tokens) {
      result.rejected.push({
        kind: 'shellPrefix',
        value: trimmed,
        reason: 'prefix rules require bare tokens without quotes, redirects, or shell operators (use shellCommands for exact commands)',
      });
      continue;
    }
    const normalizedPrefix = tokens.join(' ');
    const denyReason = checkShellDeny(normalizedPrefix, options.policy, extraDeny) ?? neverAutoReason(normalizedPrefix);
    if (denyReason) {
      result.rejected.push({ kind: 'shellPrefix', value: trimmed, reason: denyReason });
      continue;
    }
    if (!isAllowedPrefixArgv(tokens, neverAllow)) {
      result.rejected.push({
        kind: 'shellPrefix',
        value: trimmed,
        reason: 'this command cannot be approved as a broad prefix rule (request exact command in shellCommands instead)',
      });
      continue;
    }
    if (options.store?.allowsPrefix(normalizedPrefix, neverAllow)) {
      result.alreadyAllowed.push(`prefix ${visible(`${normalizedPrefix} …`)} (saved)`);
      continue;
    }
    result.shellPrefixes.push(tokens);
  }

  const seenScripts = new Set<string>();
  for (const raw of (requested.scripts ?? []).slice(0, 16)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/\s*(?:\.\.\.|…)\s*$/, '').trim();
    if (!trimmed) continue;
    if (/[\r\n\x00-\x1f\x7f-\x9f]/.test(trimmed) || visible(trimmed).length > 400) {
      result.rejected.push({ kind: 'script', value: trimmed.slice(0, 120), reason: 'script contains control characters or exceeds length limit' });
      continue;
    }
    const denyReason = checkShellDeny(trimmed, options.policy, extraDeny) ?? neverAutoReason(trimmed);
    if (denyReason) {
      result.rejected.push({ kind: 'script', value: trimmed, reason: denyReason });
      continue;
    }
    const parsed = parseScriptCommand(trimmed, options.cwd, options.policy);
    if (!parsed) {
      result.rejected.push({
        kind: 'script',
        value: trimmed,
        reason: 'expected a workspace Python script run such as "python3 scripts/backtest.py" (bare words, no shell operators)',
      });
      continue;
    }
    const key = `${parsed.interpreter} ${parsed.script}`;
    if (seenScripts.has(key)) continue;
    seenScripts.add(key);
    if (!options.isWritable) {
      result.rejected.push({ kind: 'script', value: key, reason: 'workspace is read-only (no write checkpoint)' });
      continue;
    }
    if (options.store?.allowsScript?.(key, options.policy)) {
      result.alreadyAllowed.push(`script ${visible(`${key} …`)} (saved)`);
      continue;
    }
    const grant = makeScriptGrant(key, options.cwd, options.policy);
    if (!grant) {
      result.rejected.push({ kind: 'script', value: key, reason: 'script is missing, unreadable, or imports too many local files to pin' });
      continue;
    }
    result.scripts.push(grant);
  }

  for (const raw of (requested.shellCommands ?? []).slice(0, 20)) {
    if (typeof raw !== 'string') continue;
    const cmd = raw.replace(/^[ \t]+/, '');
    if (!cmd.trim() || seenCommands.has(cmd)) continue;
    seenCommands.add(cmd);

    if (visible(cmd).length > 1200) {
      result.rejected.push({
        kind: 'shellCommand',
        value: `${cmd.slice(0, 80)}…`,
        reason: 'command exceeds 1,200 visible characters; split into shorter commands',
      });
      continue;
    }
    const denyReason = checkShellDeny(cmd, options.policy, extraDeny) ?? neverAutoReason(cmd);
    if (denyReason) {
      result.rejected.push({ kind: 'shellCommand', value: cmd, reason: denyReason });
      continue;
    }
    if (!shellNeedsApproval(cmd)) {
      result.alreadyAllowed.push(`${visible(cmd)} (routine read-only)`);
      continue;
    }
    if (options.autonomyLevel && autonomyAllowsShell(options.autonomyLevel, cmd, options.policy, extraDeny)) {
      result.alreadyAllowed.push(`${visible(cmd)} (auto-${options.autonomyLevel})`);
      continue;
    }
    if (options.store?.allows(cmd) || options.store?.allowsPrefix(cmd, neverAllow)) {
      result.alreadyAllowed.push(`${visible(cmd)} (saved)`);
      continue;
    }
    if (options.store?.allowsScript?.(cmd, options.policy)) {
      result.alreadyAllowed.push(`${visible(cmd)} (saved script)`);
      continue;
    }
    if (result.shellPrefixes.some(prefix => prefixRuleAllows(prefix, cmd, neverAllow))) {
      continue;
    }
    if (checkScriptGrants(cmd, options.cwd, result.scripts, options.policy) === 'match') {
      continue;
    }
    result.shellCommands.push(cmd);
  }

  for (const raw of (requested.files ?? []).slice(0, 64)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (!options.policy) {
      result.rejected.push({ kind: 'file', value: raw, reason: 'path policy is unavailable' });
      continue;
    }
    const decision = editDecision(options.cwd, raw, options.policy);
    if (decision === 'deny') {
      result.rejected.push({
        kind: 'file',
        value: raw,
        reason: 'protected or out-of-workspace path (denied by policy)',
      });
      continue;
    }
    if (!options.isWritable) {
      result.rejected.push({
        kind: 'file',
        value: raw,
        reason: 'workspace is read-only (no write checkpoint)',
      });
      continue;
    }
    const rel = canonicalRelativeWorkspacePath(options.cwd, raw);
    if (!rel || seenFiles.has(rel)) continue;
    seenFiles.add(rel);

    if (hasSymbolicLinkInChain(options.cwd, rel)) {
      result.deferredSymlinks.push(rel);
      continue;
    }
    if (decision === 'ask') {
      result.askFiles.push(rel);
    } else if (options.autonomyLevel && autonomyAllowsEdit(options.autonomyLevel, decision)) {
      // Workflow execution also lets autonomy cover normal edits, so they need no plan grant.
      result.alreadyAllowed.push(`edit ${visible(rel)} (auto-${options.autonomyLevel})`);
    } else if (options.writeSubMode === 'ask-edits' || options.writeSubMode === 'workflow') {
      result.plannedFiles.push(rel);
    } else {
      result.alreadyAllowed.push(`edit ${visible(rel)} (${options.writeSubMode})`);
    }
  }

  for (const raw of (requested.openFiles ?? []).slice(0, 32)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (!options.policy) {
      result.rejected.push({ kind: 'openFile', value: raw, reason: 'path policy is unavailable' });
      continue;
    }
    const decision = editDecision(options.cwd, raw, options.policy);
    if (decision === 'deny') {
      result.rejected.push({
        kind: 'openFile',
        value: raw,
        reason: 'protected or out-of-workspace path (denied by policy)',
      });
      continue;
    }
    const rel = canonicalRelativeWorkspacePath(options.cwd, raw);
    if (!rel || seenOpenFiles.has(rel)) continue;
    seenOpenFiles.add(rel);
    const ext = path.posix.extname(rel).toLowerCase();
    if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
      result.rejected.push({
        kind: 'openFile',
        value: rel,
        reason: `unsupported desktop file type "${ext || '(no extension)'}"`,
      });
      continue;
    }
    if (hasSymbolicLinkInChain(options.cwd, rel)) {
      result.rejected.push({
        kind: 'openFile',
        value: rel,
        reason: 'symbolic links cannot be opened on the host desktop',
      });
      continue;
    }
    result.openFiles.push(rel);
  }

  if (requested.worktreeSubagents === true) {
    if (!options.isWritable) {
      result.rejected.push({
        kind: 'worktree',
        value: 'worktreeSubagents',
        reason: 'workspace is read-only (no write checkpoint)',
      });
    } else {
      result.worktreeSubagents = true;
    }
  }

  return result;
}

export function hasGrantablePermissions(c: ClassifiedPlanPermissions): boolean {
  return (
    c.shellPrefixes.length > 0 ||
    c.shellCommands.length > 0 ||
    c.scripts.length > 0 ||
    c.askFiles.length > 0 ||
    c.plannedFiles.length > 0 ||
    c.openFiles.length > 0 ||
    c.worktreeSubagents
  );
}

function formatApprovalDialogBody(
  cwd: string,
  steps: readonly PlanStep[],
  classified: ClassifiedPlanPermissions,
  summary?: string,
  canPersistShell = false,
  workflowMode = false,
): string {
  const lines: string[] = [];
  lines.push(`Review plan & permissions in ${visible(cwd)}:`);
  if (summary?.trim()) {
    const cleanSummary = summary.replace(/[\r\n\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 200);
    lines.push(`Goal: ${cleanSummary}`);
  }
  if (steps.length > 0) {
    lines.push(`Plan (${steps.length} step${steps.length === 1 ? '' : 's'}):`);
    for (const step of steps.slice(0, 10)) {
      lines.push(`  ${step.step}. ${step.text}`);
    }
    if (steps.length > 10) {
      lines.push(`  … (+${steps.length - 10} more steps)`);
    }
  }

  if (hasGrantablePermissions(classified)) {
    lines.push('');
    lines.push('Permissions requested for this plan (auto-cleared when plan finishes):');
    for (const prefix of classified.shellPrefixes) {
      lines.push(`  • Shell prefix: ${visible(`${prefix.join(' ')} …`)}`);
    }
    for (const cmd of classified.shellCommands) {
      lines.push(`  • Shell command: ${visible(cmd)}`);
    }
    for (const script of classified.scripts) {
      lines.push(`  • Script, any arguments while unchanged: ${visible(describeScriptGrant(script))}`);
    }
    for (const file of classified.askFiles) {
      lines.push(`  • Sensitive file (askPaths): ${visible(file)}`);
    }
    if (classified.plannedFiles.length > 0) {
      const preview = classified.plannedFiles.slice(0, 6).map(f => visible(f)).join(', ');
      const extra = classified.plannedFiles.length > 6 ? `, … (+${classified.plannedFiles.length - 6} more)` : '';
      const modeLabel = workflowMode ? 'workflow mode' : 'ask-edits mode';
      lines.push(`  • Planned edits (${modeLabel}, ${classified.plannedFiles.length}): ${preview}${extra}`);
    }
    if (classified.openFiles.length > 0) {
      const preview = classified.openFiles.slice(0, 6).map(f => visible(f)).join(', ');
      const extra = classified.openFiles.length > 6 ? `, … (+${classified.openFiles.length - 6} more)` : '';
      lines.push(`  • Open on host desktop (${classified.openFiles.length}): ${preview}${extra}`);
    }
    if (classified.worktreeSubagents) {
      lines.push('  • Isolated worktree subagents (worker droid)');
    }
    if (canPersistShell && (classified.shellPrefixes.length > 0 || classified.shellCommands.length > 0 || classified.scripts.length > 0)) {
      lines.push('  (Note: saving shell rules persists only shell commands/prefixes/scripts to /permissions; file grants stay plan-only.)');
    }
    if (classified.scripts.length > 0) {
      lines.push('  (A script grant stops matching if the script or a local module it imports is edited after approval.)');
    }
  } else if (classified.rejected.length === 0) {
    lines.push('');
    lines.push('Permissions needed: none beyond current mode.');
  }

  if (classified.alreadyAllowed.length > 0) {
    const preview = classified.alreadyAllowed.slice(0, 6).join(', ');
    const extra = classified.alreadyAllowed.length > 6 ? `, … (+${classified.alreadyAllowed.length - 6} more)` : '';
    lines.push(`Already allowed without a grant: ${preview}${extra}`);
  }

  if (workflowMode) {
    lines.push('Workflow constraint: unrequested permissions during execution are rejected by default (inspect/approve via /rejected).');
  }

  if (classified.deferredSymlinks.length > 0) {
    lines.push(`Symlink paths (${classified.deferredSymlinks.map(f => visible(f)).join(', ')}) will still confirm at write time.`);
  }

  if (classified.rejected.length > 0) {
    lines.push('');
    lines.push('Blocked by policy (will NOT be granted):');
    for (const item of classified.rejected.slice(0, 5)) {
      lines.push(`  ✕ ${visible(item.value)} — ${item.reason}`);
    }
    if (classified.rejected.length > 5) {
      lines.push(`  ✕ … (+${classified.rejected.length - 5} more blocked items)`);
    }
  }

  const full = lines.join('\n');
  return full.length > 2400 ? `${full.slice(0, 2390)}\n…` : full;
}

export interface PlanPermissionsManagerOptions {
  getPolicy: () => Policy | undefined;
  getWriteSubMode: () => WriteSubMode;
  getAutonomyLevel?: () => AutonomyLevel;
  setAutonomyLevel?: (level: AutonomyLevel, ctx: ExtensionContext) => void;
  isWritable: (cwd: string) => boolean;
  isPlanning: () => boolean;
  getPlanMode: () => PlanMode;
  startPlanExecution: (steps: PlanStep[], ctx: ExtensionContext) => void;
  setPlannedStepsInPlanMode: (steps: PlanStep[]) => void;
  getShellStore: () => ShellStoreAdapter | undefined;
  getNeverAutoPatterns?: (cwd: string) => readonly string[];
  onPlanApproved?: (info: {
    summary?: string;
    steps: PlanStep[];
    outcome: PlanApprovalOutcome;
    ctx: ExtensionContext;
  }) => void;
  onRejectedChange?: (ctx?: ExtensionContext) => void;
  onResumeAfterApproval?: () => void;
  onAudit?: (event: AuditEvent) => void;
}

export type ShellPlanAllowRule =
  | 'plan-approved-exact'
  | 'plan-approved-prefix'
  | 'plan-approved-script'
  | 'rejected-approved-exact'
  | 'rejected-approved-prefix'
  | 'rejected-approved-script';

export type FilePlanAllowRule =
  | 'plan-approved-sensitive-path'
  | 'plan-approved-edit'
  | 'rejected-approved-sensitive-path'
  | 'rejected-approved-edit';

export interface ApproveRejectedResult {
  approved: RejectedExecutionEntry[];
  skippedPolicy: Array<{ id: number; value: string; reason: string }>;
  notFound: number[];
}

export interface PlanPermissionsHandle {
  allowsShell(command: string, neverSessionAllow?: readonly string[]): ShellPlanAllowRule | null;
  allowsApprovedRejectedShell(command: string, neverSessionAllow?: readonly string[]): 'rejected-approved-exact' | 'rejected-approved-prefix' | 'rejected-approved-script' | null;
  allowsFileEdit(
    cwd: string,
    filePath: string,
    decision: 'allow' | 'ask',
    writeSubMode: WriteSubMode,
  ): FilePlanAllowRule | null;
  allowsApprovedRejectedFile(
    cwd: string,
    filePath: string,
    decision: 'allow' | 'ask',
  ): 'rejected-approved-sensitive-path' | 'rejected-approved-edit' | null;
  allowsFileOpen(cwd: string, filePath: string): 'plan-approved-open' | 'rejected-approved-open' | null;
  allowsApprovedRejectedOpen(cwd: string, filePath: string): 'rejected-approved-open' | null;
  allowsWorktreeDelegate(cwd: string): 'plan-approved-worktree' | 'rejected-approved-worktree' | null;
  allowsApprovedRejectedWorktree(cwd: string): 'rejected-approved-worktree' | null;
  recordRejectedShell(info: { cwd: string; command: string; tool: string; ctx?: ExtensionContext }): RejectedExecutionEntry;
  recordRejectedFile(info: {
    cwd: string;
    filePath: string;
    decision: 'allow' | 'ask';
    tool: string;
    ctx?: ExtensionContext;
  }): RejectedExecutionEntry | null;
  recordRejectedOpen(info: { cwd: string; filePath: string; tool: string; ctx?: ExtensionContext }): RejectedExecutionEntry | null;
  recordRejectedWorktree(info: { cwd: string; task: string; droidName: string; ctx?: ExtensionContext }): RejectedExecutionEntry;
  listRejected(cwd?: string): RejectedExecutionEntry[];
  pendingRejectedCount(cwd?: string): number;
  formatRejectedSummaryForPermissions(cwd: string): string | undefined;
  formatRejectedReport(cwd: string): string;
  approveRejected(
    cwd: string,
    selector: readonly number[] | 'all',
    opts?: { usePrefix?: boolean; persistToProject?: boolean; prompted?: boolean; ctx?: ExtensionContext },
  ): ApproveRejectedResult;
  clearRejected(ctx?: ExtensionContext): number;
  resetSession(ctx?: ExtensionContext): void;
  consumeTurnRejectionPause(): boolean;
  handleRejectedCommand(rawArgs: string, ctx: ExtensionContext): Promise<void>;
  /** Short dialog shown when a workflow run pauses on rejections; the safe choice is first. */
  promptAfterRejectionPause(ctx: ExtensionContext): Promise<void>;
  clearGrant(reason?: string): boolean;
  hasActiveGrant(): boolean;
  describeActiveGrant(): string;
  consumePendingProposal(): PendingPlanProposal | undefined;
  confirmFromPlanMode(
    ctx: ExtensionContext,
    steps: PlanStep[],
    fallbackText?: string,
  ): Promise<'execute' | 'stay' | 'refine'>;
}

export function registerPlanPermissions(
  pi: ExtensionAPI,
  options: PlanPermissionsManagerOptions,
): PlanPermissionsHandle {
  let activeGrant: ActivePlanGrant | null = null;
  let lastPlanSummary: string | undefined;
  let pendingProposal: PendingPlanProposal | undefined;
  let nextRejectedId = 1;
  let rejectedItems: RejectedExecutionEntry[] = [];
  let approvedRejectedByCwd = new Map<string, ActivePlanGrant>();
  let turnHadRejection = false;

  function safeRealpath(target: string): string {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }

  function getOrCreateRejectedGrant(cwd: string): ActivePlanGrant {
    const canon = safeRealpath(cwd);
    let grant = approvedRejectedByCwd.get(canon);
    if (!grant) {
      grant = {
        cwd: canon,
        shellPrefixes: [],
        exactCommands: new Set<string>(),
        scripts: [],
        askFiles: new Set<string>(),
        plannedFiles: new Set<string>(),
        openFiles: new Set<string>(),
        worktreeSubagents: false,
        approvedAt: new Date().toISOString(),
      };
      approvedRejectedByCwd.set(canon, grant);
    }
    return grant;
  }

  function clearGrant(): boolean {
    const had = activeGrant !== null || pendingProposal !== undefined;
    activeGrant = null;
    pendingProposal = undefined;
    return had;
  }

  function resetSession(ctx?: ExtensionContext): void {
    activeGrant = null;
    lastPlanSummary = undefined;
    pendingProposal = undefined;
    rejectedItems = [];
    approvedRejectedByCwd = new Map();
    nextRejectedId = 1;
    turnHadRejection = false;
    options.onRejectedChange?.(ctx);
  }

  function clearRejected(ctx?: ExtensionContext): number {
    const count = rejectedItems.length;
    rejectedItems = [];
    approvedRejectedByCwd = new Map();
    turnHadRejection = false;
    options.onRejectedChange?.(ctx);
    return count;
  }

  function activateGrant(cwd: string, classified: ClassifiedPlanPermissions, summary?: string): void {
    lastPlanSummary = summary;
    if (!hasGrantablePermissions(classified)) {
      activeGrant = null;
      return;
    }
    activeGrant = {
      summary,
      cwd: safeRealpath(cwd),
      shellPrefixes: classified.shellPrefixes.map(p => [...p]),
      exactCommands: new Set(classified.shellCommands),
      scripts: classified.scripts.map(({ interpreter, script, fingerprint }) => ({ interpreter, script, fingerprint })),
      askFiles: new Set(classified.askFiles),
      plannedFiles: new Set(classified.plannedFiles),
      openFiles: new Set(classified.openFiles),
      worktreeSubagents: classified.worktreeSubagents,
      approvedAt: new Date().toISOString(),
    };
  }

  function persistEligibleShellRules(
    store: ShellStoreAdapter,
    classified: ClassifiedPlanPermissions,
    neverSessionAllow?: readonly string[],
  ): number {
    let saved = 0;
    for (const prefix of classified.shellPrefixes) {
      store.addPrefix(prefix, neverSessionAllow);
      saved++;
    }
    for (const cmd of classified.shellCommands) {
      store.add(cmd);
      saved++;
    }
    for (const script of classified.scripts) {
      if (!store.addScript) continue;
      store.addScript(`${script.interpreter} ${script.script}`, options.getPolicy(), script);
      saved++;
    }
    return saved;
  }

  async function promptPlanAndPermissions(
    ctx: ExtensionContext,
    steps: PlanStep[],
    requested: RequestedPlanPermissions | undefined,
    summary?: string,
    fromPlanMode = false,
  ): Promise<PlanApprovalOutcome> {
    const policy = options.getPolicy();
    const store = options.getShellStore();
    const activeStore = store?.inProject(ctx.cwd) ? store : undefined;
    const isWritable = options.isWritable(ctx.cwd);
    const writeSubMode = options.getWriteSubMode();
    const workflowMode = writeSubMode === 'workflow';
    const currentAuto = options.getAutonomyLevel?.() ?? 'off';
    const classified = classifyPlanPermissions(requested, {
      cwd: ctx.cwd,
      policy,
      writeSubMode,
      autonomyLevel: currentAuto,
      isWritable,
      store: activeStore,
      neverAuto: options.getNeverAutoPatterns?.(ctx.cwd),
    });

    const undecided = (action: 'revise' | 'reject' | 'interrupted' | 'no-decision', feedback?: string): PlanApprovalOutcome =>
      ({ action, granted: false, savedShellCount: 0, classified, ...(feedback ? { feedback } : {}) });
    if (ctx.signal?.aborted) return undecided('interrupted');
    if (!ctx.hasUI) return undecided('no-decision');

    const grantable = hasGrantablePermissions(classified);
    const hasShellToPersist = Boolean(
      activeStore && isWritable && (classified.shellPrefixes.length > 0 || classified.shellCommands.length > 0 || classified.scripts.length > 0),
    );
    const canOfferAutoMedium = Boolean(options.setAutonomyLevel && isWritable && currentAuto !== 'medium');

    const approvePlanLabel = 'Approve plan & permissions for this plan';
    const approveAutoMediumLabel = 'Approve plan & enable Auto Medium (dev/test commands)';
    const approveAndSaveLabel = 'Approve plan & save shell rules for this project';
    const executeWithoutGrantLabel = grantable
      ? workflowMode
        ? 'Execute plan without extra permissions (reject unapproved commands)'
        : 'Execute plan (ask for each permission individually)'
      : classified.rejected.length > 0
        ? 'Execute plan without blocked permissions'
        : steps.length > 0
          ? 'Approve & execute plan'
          : 'Execute the plan (no steps detected)';
    const stayLabel = 'Stay in plan mode';
    const reviseLabel = 'Revise the plan… (tell the agent what to change)';
    const rejectLabel = 'Reject the plan';

    const choices: string[] = [];
    if (grantable) {
      choices.push(approvePlanLabel);
      if (canOfferAutoMedium) choices.push(approveAutoMediumLabel);
      if (hasShellToPersist) choices.push(approveAndSaveLabel);
      choices.push(executeWithoutGrantLabel);
    } else {
      choices.push(executeWithoutGrantLabel);
      if (canOfferAutoMedium) choices.push(approveAutoMediumLabel);
    }
    if (fromPlanMode) choices.push(stayLabel);
    choices.push(reviseLabel, rejectLabel);

    const promptBody = formatApprovalDialogBody(ctx.cwd, steps, classified, summary, hasShellToPersist, workflowMode);
    // No timeout: the review stays open until the user approves, revises or rejects. Dismissing it
    // (Esc) shows it again, so an unanswered review is never reported as a rejection.
    let choice: string | undefined;
    let quickDismissals = 0;
    for (;;) {
      const shownAt = Date.now();
      choice = await ctx.ui.select(promptBody, choices, { signal: ctx.signal });
      if (ctx.signal?.aborted) return undecided('interrupted');
      if (!choice) {
        quickDismissals = Date.now() - shownAt < UNSHOWABLE_REVIEW_MS ? quickDismissals + 1 : 0;
        if (quickDismissals >= UNSHOWABLE_REVIEW_TRIES) return undecided('no-decision');
        continue;
      }
      if (choice === reviseLabel && !fromPlanMode) {
        // In plan mode pi-plan opens its own editor; here the feedback goes back with the tool result.
        const feedback = (await ctx.ui.editor('Revise the plan: what should change?', ''))?.trim();
        if (ctx.signal?.aborted) return undecided('interrupted');
        if (!feedback) continue;
        return undecided('revise', feedback);
      }
      break;
    }
    if (choice === reviseLabel) return undecided('revise');
    if (choice === rejectLabel) return undecided('reject');
    if (fromPlanMode && choice === stayLabel) {
      return { action: 'stay-in-plan', granted: false, savedShellCount: 0, classified };
    }
    if (choice === approveAutoMediumLabel && canOfferAutoMedium) {
      options.setAutonomyLevel?.('medium', ctx);
      activateGrant(ctx.cwd, classified, summary);
      return { action: 'execute-auto-medium', granted: grantable, savedShellCount: 0, classified };
    }
    if (choice === approveAndSaveLabel && hasShellToPersist && activeStore) {
      let savedShellCount = 0;
      try {
        savedShellCount = persistEligibleShellRules(activeStore, classified, policy?.neverSessionAllow);
        ctx.ui.notify(
          `Saved ${savedShellCount} shell rule${savedShellCount === 1 ? '' : 's'} for this project (/permissions).`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`Could not persist all shell rules: ${(error as Error).message}`, 'warning');
      }
      activateGrant(ctx.cwd, classified, summary);
      return { action: 'execute-saved-shell', granted: true, savedShellCount, classified };
    }
    if (choice === approvePlanLabel && grantable) {
      activateGrant(ctx.cwd, classified, summary);
      return { action: 'execute-with-grant', granted: true, savedShellCount: 0, classified };
    }
    if (choice === executeWithoutGrantLabel) {
      lastPlanSummary = summary;
      activeGrant = null;
      return {
        action: workflowMode ? 'execute-no-grant' : 'execute-ask-each',
        granted: false,
        savedShellCount: 0,
        classified,
      };
    }
    return undecided('no-decision');
  }

  function describeActiveGrant(): string {
    const parts: string[] = [];
    if (activeGrant) {
      for (const p of activeGrant.shellPrefixes) {
        parts.push(`  prefix ${visible(`${p.join(' ')} …`)}`);
      }
      for (const cmd of activeGrant.exactCommands) {
        parts.push(`  exact ${visible(cmd)}`);
      }
      for (const script of activeGrant.scripts) {
        parts.push(`  script ${visible(`${script.interpreter} ${script.script} …`)} (any arguments while unchanged)`);
      }
      for (const file of activeGrant.askFiles) {
        parts.push(`  sensitive-file ${visible(file)}`);
      }
      for (const file of activeGrant.plannedFiles) {
        parts.push(`  planned-edit ${visible(file)}`);
      }
      for (const file of activeGrant.openFiles) {
        parts.push(`  open-file ${visible(file)}`);
      }
      if (activeGrant.worktreeSubagents) {
        parts.push('  worktree-subagents allowed');
      }
    }
    for (const grant of approvedRejectedByCwd.values()) {
      for (const p of grant.shellPrefixes) {
        parts.push(`  rejected-approved prefix ${visible(`${p.join(' ')} …`)}`);
      }
      for (const cmd of grant.exactCommands) {
        parts.push(`  rejected-approved exact ${visible(cmd)}`);
      }
      for (const script of grant.scripts) {
        parts.push(`  rejected-approved script ${visible(`${script.interpreter} ${script.script} …`)}`);
      }
      for (const file of grant.askFiles) {
        parts.push(`  rejected-approved sensitive-file ${visible(file)}`);
      }
      for (const file of grant.plannedFiles) {
        parts.push(`  rejected-approved edit ${visible(file)}`);
      }
      for (const file of grant.openFiles) {
        parts.push(`  rejected-approved open-file ${visible(file)}`);
      }
      if (grant.worktreeSubagents) {
        parts.push('  rejected-approved worktree-subagents');
      }
    }
    return parts.length > 0 ? `\n${parts.join('\n')}` : 'none';
  }

  function summarizeGrantedForModel(outcome: PlanApprovalOutcome): string {
    const workflowMode = options.getWriteSubMode() === 'workflow';
    const lines: string[] = [];
    if (outcome.granted) {
      const c = outcome.classified;
      if (c.shellPrefixes.length) {
        lines.push(`- Approved shell prefixes for this plan: ${c.shellPrefixes.map(p => `${p.join(' ')} …`).join(', ')}`);
      }
      if (c.shellCommands.length) {
        lines.push(`- Approved exact shell commands for this plan: ${c.shellCommands.map(cmd => visible(cmd)).join(', ')}`);
      }
      if (c.scripts.length) {
        lines.push(`- Approved scripts (any arguments) for this plan: ${c.scripts.map(sc => `${sc.interpreter} ${sc.script}`).join(', ')}. Editing a script or a local module it imports voids its grant; request it again with ${planToolName} if you must change it.`);
      }
      if (c.askFiles.length) {
        lines.push(`- Approved sensitive files for this plan: ${c.askFiles.join(', ')}`);
      }
      if (c.plannedFiles.length) {
        lines.push(`- Approved planned file edits for this plan: ${c.plannedFiles.join(', ')}`);
      }
      if (c.openFiles.length) {
        lines.push(`- Approved host desktop file opens for this plan: ${c.openFiles.join(', ')}`);
      }
      if (c.worktreeSubagents) {
        lines.push('- Approved isolated worktree subagents (worker droid) for this plan.');
      }
      if (outcome.savedShellCount > 0) {
        lines.push(`- Saved ${outcome.savedShellCount} shell rule(s) to project /permissions.`);
      }
      if (workflowMode) {
        lines.push('- Workflow execution constraint: any unrequested non-routine command or file modification during execution will be rejected by default (reviewable by the user via /rejected).');
      }
    } else if (outcome.action !== 'execute-auto-medium') {
      lines.push(
        workflowMode
          ? '- Upfront permission grant: none (any non-routine shell command or file modification during execution will be rejected by default; user can review/approve via /rejected).'
          : '- Upfront permission grant: none (any non-routine shell command or protected/ask-edits write will ask individually).',
      );
    }
    if (outcome.action === 'execute-auto-medium') {
      lines.push('- Session autonomy upgraded to medium (normal edits and local dev/test commands allowed).');
    }
    const hasRepoGitShell = [
      ...outcome.classified.shellPrefixes.map(p => p.join(' ')),
      ...outcome.classified.shellCommands,
      ...outcome.classified.alreadyAllowed,
    ].some(s => /(?:^|\s)git\s+(status|diff|log|show|blame|ls-files|rev-parse|branch)\b/.test(s) && !s.includes('--no-index'));
    if (hasRepoGitShell) {
      lines.push('- Note: .git is masked as empty inside pi_safe_bash; use the pi_safe_git tool (e.g. diff with args: ["--check"], log with args: ["--format=%h %aI %s"]) for Git repository inspection.');
    }
    if (outcome.classified.rejected.length > 0) {
      lines.push(
        `- Blocked by policy (do NOT attempt): ${outcome.classified.rejected
          .map(r => `${visible(r.value)} (${r.reason})`)
          .join('; ')}`,
      );
    }
    return lines.join('\n');
  }

  function listRejected(cwd?: string): RejectedExecutionEntry[] {
    const filterCwd = cwd ? safeRealpath(cwd) : undefined;
    return rejectedItems
      .filter(item => !filterCwd || item.cwd === filterCwd)
      .map(item => ({
        ...item,
        ...(item.suggestedPrefix ? { suggestedPrefix: [...item.suggestedPrefix] } : {}),
      }));
  }

  function pendingRejectedCount(cwd?: string): number {
    const filterCwd = cwd ? safeRealpath(cwd) : undefined;
    let count = 0;
    for (const item of rejectedItems) {
      if (item.status === 'rejected' && (!filterCwd || item.cwd === filterCwd)) count++;
    }
    return count;
  }

  function recordRejectedShell(info: {
    cwd: string;
    command: string;
    tool: string;
    ctx?: ExtensionContext;
  }): RejectedExecutionEntry {
    const canonCwd = safeRealpath(info.cwd);
    const trimmedCmd = info.command.replace(/^[ \t]+/, '');
    const now = new Date().toISOString();
    turnHadRejection = true;

    const existing = rejectedItems.find(
      item => item.cwd === canonCwd && item.kind === 'shell' && item.value === trimmedCmd && item.status === 'rejected',
    );
    if (existing) {
      existing.count += 1;
      existing.lastRejectedAt = now;
      return { ...existing, ...(existing.suggestedPrefix ? { suggestedPrefix: [...existing.suggestedPrefix] } : {}) };
    }

    const policy = options.getPolicy();
    const extraDeny = options.getShellStore()?.denyRules() ?? [];
    const parsedScript = parseScriptCommand(trimmedCmd, info.cwd, policy);
    // Workspace scripts are approved as pinned script grants, never as unpinned prefixes.
    const candidatePrefix = parsedScript ? undefined : suggestShellPrefix(trimmedCmd, policy, extraDeny) ?? undefined;
    const scriptKey = parsedScript ? `${parsedScript.interpreter} ${parsedScript.script}` : undefined;
    const knownGrants = [
      ...(activeGrant?.scripts ?? []),
      ...[...approvedRejectedByCwd.values()].flatMap(g => g.scripts),
      ...(options.getShellStore()?.scriptGrants?.() ?? []),
    ];
    const scriptChanged = Boolean(scriptKey) && checkScriptGrants(trimmedCmd, info.cwd, knownGrants, policy) === 'changed';
    const entry: RejectedExecutionEntry = {
      id: nextRejectedId++,
      cwd: canonCwd,
      kind: 'shell',
      value: trimmedCmd,
      ...(candidatePrefix ? { suggestedPrefix: candidatePrefix } : {}),
      ...(scriptKey ? { suggestedScript: scriptKey } : {}),
      ...(scriptChanged ? { scriptChanged: true } : {}),
      tool: info.tool,
      planSummary: activeGrant?.summary ?? lastPlanSummary,
      count: 1,
      firstRejectedAt: now,
      lastRejectedAt: now,
      status: 'rejected',
    };
    rejectedItems.push(entry);
    options.onRejectedChange?.(info.ctx);
    if (info.ctx?.hasUI) {
      info.ctx.ui.notify(
        `Rejected ${scriptChanged ? 'changed script' : 'unrequested command'} during execution (#${entry.id}): ${visible(trimmedCmd)} — run /rejected or /permissions review to inspect & approve.`,
        'warning',
      );
    }
    return { ...entry, ...(entry.suggestedPrefix ? { suggestedPrefix: [...entry.suggestedPrefix] } : {}) };
  }

  function recordRejectedFile(info: {
    cwd: string;
    filePath: string;
    decision: 'allow' | 'ask';
    tool: string;
    ctx?: ExtensionContext;
  }): RejectedExecutionEntry | null {
    const rel = canonicalRelativeWorkspacePath(info.cwd, info.filePath);
    if (!rel || hasSymbolicLinkInChain(info.cwd, rel)) return null;
    const canonCwd = safeRealpath(info.cwd);
    const now = new Date().toISOString();
    turnHadRejection = true;

    const existing = rejectedItems.find(
      item => item.cwd === canonCwd && item.kind === 'file' && item.value === rel && item.status === 'rejected',
    );
    if (existing) {
      existing.count += 1;
      existing.lastRejectedAt = now;
      return { ...existing };
    }

    const entry: RejectedExecutionEntry = {
      id: nextRejectedId++,
      cwd: canonCwd,
      kind: 'file',
      value: rel,
      fileDecision: info.decision,
      tool: info.tool,
      planSummary: activeGrant?.summary ?? lastPlanSummary,
      count: 1,
      firstRejectedAt: now,
      lastRejectedAt: now,
      status: 'rejected',
    };
    rejectedItems.push(entry);
    options.onRejectedChange?.(info.ctx);
    if (info.ctx?.hasUI) {
      info.ctx.ui.notify(
        `Rejected unrequested file edit during execution (#${entry.id}): ${visible(rel)} — run /rejected or /permissions review to inspect & approve.`,
        'warning',
      );
    }
    return { ...entry };
  }

  function recordRejectedOpen(info: {
    cwd: string;
    filePath: string;
    tool: string;
    ctx?: ExtensionContext;
  }): RejectedExecutionEntry | null {
    const rel = canonicalRelativeWorkspacePath(info.cwd, info.filePath);
    if (!rel || hasSymbolicLinkInChain(info.cwd, rel)) return null;
    const canonCwd = safeRealpath(info.cwd);
    const now = new Date().toISOString();
    turnHadRejection = true;

    const existing = rejectedItems.find(
      item => item.cwd === canonCwd && item.kind === 'open' && item.value === rel && item.status === 'rejected',
    );
    if (existing) {
      existing.count += 1;
      existing.lastRejectedAt = now;
      return { ...existing };
    }

    const entry: RejectedExecutionEntry = {
      id: nextRejectedId++,
      cwd: canonCwd,
      kind: 'open',
      value: rel,
      tool: info.tool,
      planSummary: activeGrant?.summary ?? lastPlanSummary,
      count: 1,
      firstRejectedAt: now,
      lastRejectedAt: now,
      status: 'rejected',
    };
    rejectedItems.push(entry);
    options.onRejectedChange?.(info.ctx);
    if (info.ctx?.hasUI) {
      info.ctx.ui.notify(
        `Rejected unrequested desktop open during execution (#${entry.id}): ${visible(rel)} — run /rejected or /permissions review to inspect & approve.`,
        'warning',
      );
    }
    return { ...entry };
  }

  function recordRejectedWorktree(info: {
    cwd: string;
    task: string;
    droidName: string;
    ctx?: ExtensionContext;
  }): RejectedExecutionEntry {
    const canonCwd = safeRealpath(info.cwd);
    const label = `${info.droidName}: ${info.task.replace(/\s+/g, ' ').trim().slice(0, 100)}`;
    const now = new Date().toISOString();
    turnHadRejection = true;

    const existing = rejectedItems.find(
      item => item.cwd === canonCwd && item.kind === 'worktree' && item.status === 'rejected',
    );
    if (existing) {
      existing.count += 1;
      existing.lastRejectedAt = now;
      return { ...existing };
    }

    const entry: RejectedExecutionEntry = {
      id: nextRejectedId++,
      cwd: canonCwd,
      kind: 'worktree',
      value: label,
      tool: 'pi_safe_delegate',
      planSummary: activeGrant?.summary ?? lastPlanSummary,
      count: 1,
      firstRejectedAt: now,
      lastRejectedAt: now,
      status: 'rejected',
    };
    rejectedItems.push(entry);
    options.onRejectedChange?.(info.ctx);
    if (info.ctx?.hasUI) {
      info.ctx.ui.notify(
        `Rejected unrequested worktree subagent during execution (#${entry.id}) — run /rejected or /permissions review to inspect & approve.`,
        'warning',
      );
    }
    return { ...entry };
  }

  function approveRejected(
    cwd: string,
    selector: readonly number[] | 'all',
    opts: { usePrefix?: boolean; persistToProject?: boolean; prompted?: boolean; ctx?: ExtensionContext } = {},
  ): ApproveRejectedResult {
    const canonCwd = safeRealpath(cwd);
    const policy = options.getPolicy();
    const store = options.getShellStore();
    const activeStore = store?.inProject(cwd) ? store : undefined;
    const extraDeny = activeStore?.denyRules() ?? [];
    const writable = options.isWritable(cwd);
    const grant = getOrCreateRejectedGrant(cwd);

    const approved: RejectedExecutionEntry[] = [];
    const skippedPolicy: Array<{ id: number; value: string; reason: string }> = [];
    const notFound: number[] = [];

    const targets: RejectedExecutionEntry[] = [];
    if (selector === 'all') {
      for (const item of rejectedItems) {
        if (item.cwd === canonCwd && item.status === 'rejected') targets.push(item);
      }
    } else {
      const seen = new Set<number>();
      for (const id of selector) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = rejectedItems.find(item => item.cwd === canonCwd && item.id === id);
        if (!found || found.status !== 'rejected') {
          notFound.push(id);
          continue;
        }
        targets.push(found);
      }
    }

    for (const item of targets) {
      if (item.kind === 'shell') {
        const denyReason = checkShellDeny(item.value, policy, extraDeny);
        if (denyReason) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: denyReason });
          continue;
        }
        const scriptGrant = opts.usePrefix && item.suggestedScript
          ? makeScriptGrant(item.suggestedScript, cwd, policy)
          : null;
        if (scriptGrant) {
          grant.scripts = grant.scripts.filter(g => !(g.interpreter === scriptGrant.interpreter && g.script === scriptGrant.script));
          grant.scripts.push({ interpreter: scriptGrant.interpreter, script: scriptGrant.script, fingerprint: scriptGrant.fingerprint });
          if (opts.persistToProject && activeStore?.addScript && writable) {
            activeStore.addScript(item.suggestedScript!, policy, scriptGrant);
            item.approvedHow = 'project-script';
          } else {
            item.approvedHow = 'session-script';
          }
          item.status = 'approved';
          approved.push({ ...item, ...(item.suggestedPrefix ? { suggestedPrefix: [...item.suggestedPrefix] } : {}) });
          options.onAudit?.({
            tool: 'rejected_permissions',
            args: { id: item.id, kind: item.kind, value: item.value, approvedHow: item.approvedHow },
            decision: 'approved',
            rule: `rejected-exec-${item.approvedHow}`,
            prompted: Boolean(opts.prompted),
          });
          continue;
        }
        const canUsePrefix = Boolean(
          opts.usePrefix &&
            item.suggestedPrefix &&
            isAllowedPrefixArgv(item.suggestedPrefix, policy?.neverSessionAllow) &&
            !checkShellDeny(item.suggestedPrefix.join(' '), policy, extraDeny),
        );
        if (canUsePrefix && item.suggestedPrefix) {
          const prefKey = item.suggestedPrefix.join(' ');
          if (!grant.shellPrefixes.some(p => p.join(' ') === prefKey)) {
            grant.shellPrefixes.push([...item.suggestedPrefix]);
          }
          if (opts.persistToProject && activeStore && writable) {
            activeStore.addPrefix(item.suggestedPrefix, policy?.neverSessionAllow);
            item.approvedHow = 'project-prefix';
          } else {
            item.approvedHow = 'session-prefix';
          }
        } else {
          grant.exactCommands.add(item.value);
          if (opts.persistToProject && activeStore && writable) {
            activeStore.add(item.value);
            item.approvedHow = 'project-exact';
          } else {
            item.approvedHow = 'session-exact';
          }
        }
        item.status = 'approved';
        approved.push({ ...item, ...(item.suggestedPrefix ? { suggestedPrefix: [...item.suggestedPrefix] } : {}) });
      } else if (item.kind === 'file') {
        if (!policy) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'path policy unavailable' });
          continue;
        }
        if (!writable) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'workspace is read-only' });
          continue;
        }
        const curDecision = editDecision(cwd, item.value, policy);
        if (curDecision === 'deny' || hasSymbolicLinkInChain(cwd, item.value)) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'path is protected or symlinked' });
          continue;
        }
        if (curDecision === 'ask' || item.fileDecision === 'ask') {
          grant.askFiles.add(item.value);
        } else {
          grant.plannedFiles.add(item.value);
        }
        item.approvedHow = 'session-exact';
        item.status = 'approved';
        approved.push({ ...item });
      } else if (item.kind === 'open') {
        if (!policy) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'path policy unavailable' });
          continue;
        }
        const curDecision = editDecision(cwd, item.value, policy);
        const ext = path.posix.extname(item.value).toLowerCase();
        if (curDecision === 'deny' || hasSymbolicLinkInChain(cwd, item.value) || !SAFE_OPEN_EXTENSIONS.has(ext)) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'path is protected, symlinked, or unsupported' });
          continue;
        }
        grant.openFiles.add(item.value);
        item.approvedHow = 'session-exact';
        item.status = 'approved';
        approved.push({ ...item });
      } else if (item.kind === 'worktree') {
        if (!writable) {
          skippedPolicy.push({ id: item.id, value: item.value, reason: 'workspace is read-only' });
          continue;
        }
        grant.worktreeSubagents = true;
        item.approvedHow = 'session-exact';
        item.status = 'approved';
        approved.push({ ...item });
      }

      if (item.status === 'approved') {
        options.onAudit?.({
          tool: 'rejected_permissions',
          args: { id: item.id, kind: item.kind, value: item.value, approvedHow: item.approvedHow },
          decision: 'approved',
          rule: `rejected-exec-${item.approvedHow}`,
          prompted: Boolean(opts.prompted),
        });
      }
    }

    if (approved.length > 0) {
      options.onRejectedChange?.(opts.ctx);
    }
    return { approved, skippedPolicy, notFound };
  }

  function formatRejectedReport(cwd: string): string {
    const items = listRejected(cwd);
    if (items.length === 0) {
      return 'No commands or permissions have been rejected during execution in this session.';
    }
    const pending = items.filter(i => i.status === 'rejected');
    const approved = items.filter(i => i.status === 'approved');
    const lines: string[] = [
      `Execution-phase rejected requests (${pending.length} pending, ${approved.length} approved):`,
    ];
    for (const item of items) {
      const kindTag = item.kind === 'shell' ? 'command' : item.kind === 'file' ? 'file' : item.kind === 'open' ? 'open' : 'worktree';
      const stateTag =
        item.status === 'rejected'
          ? `rejected${item.count > 1 ? ` ×${item.count}` : ''}`
          : `approved:${item.approvedHow ?? 'session'}`;
      const prefixHint =
        item.status === 'rejected' && item.suggestedScript
          ? ` [script grant eligible: ${visible(`${item.suggestedScript} …`)}${item.scriptChanged ? '; changed since approval' : ''}]`
          : item.status === 'rejected' && item.suggestedPrefix
            ? ` [prefix eligible: ${visible(`${item.suggestedPrefix.join(' ')} …`)}]`
            : '';
      lines.push(`  #${item.id} [${stateTag}] ${kindTag}: ${visible(item.value)} (${item.tool})${prefixHint}`);
    }
    if (pending.length > 0) {
      lines.push('Approve: /rejected (interactive selector) | /rejected approve <id[,id...]|all> [--prefix] [--save] | /rejected clear  (--prefix also turns script runs into script grants)');
    } else {
      lines.push('Clear history: /rejected clear');
    }
    return lines.join('\n');
  }

  function formatRejectedSummaryForPermissions(cwd: string): string | undefined {
    const items = listRejected(cwd);
    const workflowMode = options.getWriteSubMode() === 'workflow';
    if (items.length === 0) {
      return workflowMode ? 'Rejected during execution: none' : undefined;
    }
    const pending = items.filter(i => i.status === 'rejected');
    const preview = (pending.length > 0 ? pending : items).slice(0, 5).map(item => {
      const state = item.status === 'rejected' ? `rejected${item.count > 1 ? `×${item.count}` : ''}` : `approved`;
      return `  #${item.id} [${state}] ${visible(item.value)}`;
    });
    return (
      `Rejected during execution (${pending.length} pending, ${items.length - pending.length} approved):\n` +
      `${preview.join('\n')}` +
      (pending.length > 0 ? '\n  Inspect & approve: /rejected or /permissions review' : '')
    );
  }

  async function reviewRejectedInteractive(ctx: ExtensionContext): Promise<void> {
    const selected = new Set<number>();
    const store = options.getShellStore();
    const canPersistBase = Boolean(store?.inProject(ctx.cwd) && options.isWritable(ctx.cwd));

    while (true) {
      const pending = listRejected(ctx.cwd).filter(i => i.status === 'rejected');
      if (pending.length === 0) {
        ctx.ui.notify(formatRejectedReport(ctx.cwd), 'info');
        return;
      }

      const headerLines = [
        `Commands/permissions rejected during execution (${pending.length} pending):`,
        ...pending.slice(0, 10).map(item => {
          const kindLabel = item.kind === 'shell' ? 'shell' : item.kind === 'file' ? 'file' : item.kind === 'open' ? 'open' : 'worktree';
          const pref = item.suggestedScript
            ? ` · script: ${visible(`${item.suggestedScript} …`)}${item.scriptChanged ? ' (changed since approval)' : ''}`
            : item.suggestedPrefix ? ` · prefix: ${visible(`${item.suggestedPrefix.join(' ')} …`)}` : '';
          return `  #${item.id} [${kindLabel}] ${visible(item.value)} (${item.count}x${pref})`;
        }),
        'Toggle item(s) to select specific commands, or choose an Approve action below:',
      ];

      const itemRows = pending.map(item => {
        const mark = selected.has(item.id) ? '[✓]' : '[ ]';
        const kindLabel = item.kind === 'shell' ? 'Command' : item.kind === 'file' ? 'File' : item.kind === 'open' ? 'Open' : 'Worktree';
        return {
          id: item.id,
          label: `${mark} #${item.id} ${kindLabel}: ${visible(item.value)}${item.count > 1 ? ` (${item.count}x)` : ''}`,
        };
      });

      const activeTargets = selected.size > 0 ? pending.filter(i => selected.has(i.id)) : pending;
      const hasPrefixEligible = activeTargets.some(i => Boolean(i.suggestedPrefix || i.suggestedScript));
      const hasShellTargets = activeTargets.some(i => i.kind === 'shell');
      const scopeWord = selected.size > 0 ? `selected (${selected.size})` : `all pending (${pending.length})`;

      const approveSessionLabel = `✓ Approve ${scopeWord} for this session`;
      const approvePrefixLabel = `✓ Approve ${scopeWord} with script grants / safe prefixes where eligible (session)`;
      const approveSaveLabel = `✓ Approve ${scopeWord} & save shell rules for this project`;
      const approveContinueLabel = `✓ Approve ${scopeWord} & ask agent to continue`;
      const clearLabel = '✕ Clear rejected list';
      const cancelLabel = 'Cancel / close';

      const choices: string[] = itemRows.map(r => r.label);
      choices.push(approveSessionLabel);
      if (hasPrefixEligible) choices.push(approvePrefixLabel);
      if (canPersistBase && hasShellTargets) choices.push(approveSaveLabel);
      if (ctx.mode === 'tui' && ctx.isIdle?.() && options.onResumeAfterApproval) {
        choices.push(approveContinueLabel);
      }
      choices.push(clearLabel, cancelLabel);

      const choice = await ctx.ui.select(headerLines.join('\n'), choices, {
        timeout: 60_000,
        signal: ctx.signal,
      });
      if (!choice || choice === cancelLabel || ctx.signal?.aborted) {
        return;
      }
      if (choice === clearLabel) {
        const removed = clearRejected(ctx);
        ctx.ui.notify(`Cleared ${removed} rejected execution item${removed === 1 ? '' : 's'}.`, 'info');
        return;
      }
      const toggled = itemRows.find(r => r.label === choice);
      if (toggled) {
        if (selected.has(toggled.id)) selected.delete(toggled.id);
        else selected.add(toggled.id);
        continue;
      }

      const usePrefix = choice === approvePrefixLabel;
      const persistToProject = choice === approveSaveLabel;
      const resumeAfter = choice === approveContinueLabel;
      const selector: readonly number[] | 'all' = selected.size > 0 ? [...selected] : 'all';
      const res = approveRejected(ctx.cwd, selector, {
        usePrefix,
        persistToProject,
        prompted: true,
        ctx,
      });
      const summaryParts: string[] = [];
      if (res.approved.length > 0) {
        summaryParts.push(
          `Approved ${res.approved.length} rejected item${res.approved.length === 1 ? '' : 's'}: ` +
            res.approved.map(a => `#${a.id} ${visible(a.value)} (${a.approvedHow})`).join(', '),
        );
      }
      if (res.skippedPolicy.length > 0) {
        summaryParts.push(
          `Blocked by policy: ${res.skippedPolicy.map(s => `#${s.id} (${s.reason})`).join(', ')}`,
        );
      }
      ctx.ui.notify(summaryParts.join('\n') || 'No rejected items were approved.', res.approved.length > 0 ? 'info' : 'warning');
      if (resumeAfter && res.approved.length > 0) {
        options.onResumeAfterApproval?.();
      }
      return;
    }
  }

  async function promptAfterRejectionPause(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== 'tui' || ctx.signal?.aborted) return;
    const pending = listRejected(ctx.cwd).filter(i => i.status === 'rejected');
    if (pending.length === 0) return;
    const header = [
      `Workflow run paused: ${pending.length} unrequested permission${pending.length === 1 ? ' was' : 's were'} rejected.`,
      ...pending.slice(0, 8).map(item => {
        const kind = item.kind === 'shell' ? (item.scriptChanged ? 'changed script' : 'command') : item.kind;
        return `  #${item.id} ${kind}: ${visible(item.value)}${item.count > 1 ? ` (${item.count}x)` : ''}`;
      }),
      ...(pending.length > 8 ? [`  … (+${pending.length - 8} more)`] : []),
    ];
    const keepLabel = 'Keep paused (review later with /rejected)';
    const approveLabel = `✓ Approve ${pending.length === 1 ? 'it' : `all ${pending.length}`} for this session & continue`;
    const eligible = pending.some(i => i.suggestedScript || i.suggestedPrefix);
    const approveGrantLabel = `✓ Approve as script grants / safe prefixes where eligible & continue`;
    const chooseLabel = 'Choose items…';
    const choices = [keepLabel, approveLabel];
    if (eligible) choices.push(approveGrantLabel);
    choices.push(chooseLabel);
    const choice = await ctx.ui.select(header.join('\n'), choices, { timeout: 120_000, signal: ctx.signal });
    if (!choice || choice === keepLabel || ctx.signal?.aborted) return;
    if (choice === chooseLabel) {
      await reviewRejectedInteractive(ctx);
      return;
    }
    const res = approveRejected(ctx.cwd, 'all', { usePrefix: choice === approveGrantLabel, prompted: true, ctx });
    const notes: string[] = [];
    if (res.approved.length > 0) {
      notes.push(`Approved ${res.approved.length}: ${res.approved.map(a => `#${a.id} (${a.approvedHow})`).join(', ')}`);
    }
    if (res.skippedPolicy.length > 0) {
      notes.push(`Blocked by policy: ${res.skippedPolicy.map(item => `#${item.id} (${item.reason})`).join(', ')}`);
    }
    ctx.ui.notify(notes.join('\n') || 'No rejected items were approved.', res.approved.length > 0 ? 'info' : 'warning');
    if (res.approved.length > 0 && ctx.isIdle?.()) options.onResumeAfterApproval?.();
  }

  async function handleRejectedCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
    const trimmed = rawArgs.trim();
    if (!trimmed || trimmed === 'review') {
      if (ctx.hasUI && pendingRejectedCount(ctx.cwd) > 0) {
        await reviewRejectedInteractive(ctx);
      } else {
        ctx.ui.notify(formatRejectedReport(ctx.cwd), 'info');
      }
      return;
    }
    if (trimmed === 'list') {
      ctx.ui.notify(formatRejectedReport(ctx.cwd), 'info');
      return;
    }
    if (trimmed === 'clear') {
      const removed = clearRejected(ctx);
      ctx.ui.notify(
        removed > 0
          ? `Cleared ${removed} rejected execution item${removed === 1 ? '' : 's'} and session rejected grants.`
          : 'No rejected execution items to clear.',
        'info',
      );
      return;
    }
    const approveMatch = /^approve(?:\s+(.+))?$/i.exec(trimmed);
    if (approveMatch) {
      const rest = (approveMatch[1] ?? '').trim();
      if (!rest) {
        if (ctx.hasUI && pendingRejectedCount(ctx.cwd) > 0) {
          await reviewRejectedInteractive(ctx);
          return;
        }
        ctx.ui.notify('Usage: /rejected approve <id[,id...]|all> [--prefix] [--save]', 'warning');
        return;
      }
      const tokens = rest.split(/[\s,]+/).filter(Boolean);
      let usePrefix = false;
      let persistToProject = false;
      let approveAll = false;
      const ids: number[] = [];
      for (const tok of tokens) {
        if (tok === '--prefix' || tok === 'prefix') {
          usePrefix = true;
        } else if (tok === '--save' || tok === 'save') {
          persistToProject = true;
        } else if (tok === 'all' || tok === '*') {
          approveAll = true;
        } else {
          const idMatch = /^#?([1-9][0-9]*)$/.exec(tok);
          if (!idMatch) {
            ctx.ui.notify(`Invalid rejected item selector "${visible(tok)}". Usage: /rejected approve <id[,id...]|all> [--prefix] [--save]`, 'warning');
            return;
          }
          ids.push(Number(idMatch[1]));
        }
      }
      if (!approveAll && ids.length === 0) {
        ctx.ui.notify('Usage: /rejected approve <id[,id...]|all> [--prefix] [--save]', 'warning');
        return;
      }
      const res = approveRejected(ctx.cwd, approveAll ? 'all' : ids, {
        usePrefix,
        persistToProject,
        prompted: false,
        ctx,
      });
      const notes: string[] = [];
      if (res.approved.length > 0) {
        notes.push(
          `Approved ${res.approved.length} item${res.approved.length === 1 ? '' : 's'}: ` +
            res.approved.map(a => `#${a.id} ${visible(a.value)} (${a.approvedHow})`).join(', '),
        );
      }
      if (res.skippedPolicy.length > 0) {
        notes.push(`Blocked by policy: ${res.skippedPolicy.map(s => `#${s.id} (${s.reason})`).join(', ')}`);
      }
      if (res.notFound.length > 0) {
        notes.push(`Not pending: ${res.notFound.map(id => `#${id}`).join(', ')}`);
      }
      ctx.ui.notify(notes.join('\n') || 'No pending rejected items to approve.', res.approved.length > 0 ? 'info' : 'warning');
      return;
    }

    ctx.ui.notify('Usage: /rejected [review | list | approve <id[,id...]|all> [--prefix] [--save] | clear]', 'warning');
  }

  pi.registerCommand?.('rejected', {
    description: 'Inspect and selectively approve commands/permissions rejected during execution: /rejected [review | list | approve <id|all> [--prefix] [--save] | clear]',
    async handler(raw, ctx) {
      await handleRejectedCommand(raw, ctx);
    },
  });

  pi.registerTool({
    name: planToolName,
    label: 'Propose Plan & Request Permissions',
    promptSnippet: 'Present a step-by-step plan and request upfront user approval for all permissions needed to execute it',
    promptGuidelines: [
      `For multi-step tasks, in workflow mode before any file edit or non-routine shell command, or before editing sensitive askPaths files (AGENTS.md, CLAUDE.md, CI configs, lockfiles) or making edits in ask-edits mode: explore read-only first, then call ${planToolName} with ordered steps and ALL required permissions (shellPrefixes, shellCommands, scripts, files) before mutating files or running non-routine commands.`,
      `In workflow mode and ask-edits mode, list ALL workspace files the plan will create or modify in permissions.files; unrequested file writes and non-routine commands during workflow execution are rejected by default (and logged for user review via /rejected).`,
      `To run a workspace Python script with varying arguments (backtests, data pulls, reports), request it in permissions.scripts (e.g. "python3 scripts/backtest.py" or "python3 -m scripts.daily_memo"): the grant covers any arguments while the script and the local modules it imports stay unchanged, so finish editing a script before requesting it.`,
      `Scripts matching the user's never-auto patterns (broker, live trading, deploy, …) cannot be granted upfront: the user approves each run when it happens, so do not list them in permissions.`,
      `Do not request commands or edits the current autonomy level already allows (the autonomy section of this prompt lists them); they run without a grant once the plan is approved.`,
      `Inside pi_safe_bash, .git is masked as empty; use pi_safe_git (status, diff, log, show, blame, ls-files) for Git repository inspection instead of requesting git shell commands.`,
      `Skip ${planToolName} for simple questions and read-only lookups (and in accept-edits mode, straightforward single-step edits that require no extra permissions).`,
    ],
    description:
      'Present a concrete step-by-step execution plan and explicitly request upfront user approval for the shell prefixes, exact shell commands, and file writes needed to accomplish the task. Approved permissions apply for the active plan execution and clear automatically when the plan finishes.',
    parameters: {
      type: 'object',
      required: ['steps'],
      additionalProperties: false,
      properties: {
        summary: {
          type: 'string',
          description: 'Concise one-line summary of what the plan accomplishes.',
          maxLength: 240,
        },
        steps: {
          type: 'array',
          description: 'Ordered execution steps (1 to 20 concrete items).',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'string',
            minLength: 4,
            maxLength: 240,
          },
        },
        permissions: {
          type: 'object',
          additionalProperties: false,
          description: 'All permissions needed to complete this plan so the user can approve them upfront before execution starts.',
          properties: {
            shellPrefixes: {
              type: 'array',
              maxItems: 16,
              items: { type: 'string', minLength: 1, maxLength: 200 },
              description: 'Bare safe command prefixes needed during execution (e.g. ["pytest", "npm test", "node --test"]). No shell operators or never-allow binaries (bash, sh, rm, mv, cp, env, find).',
            },
            shellCommands: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', minLength: 1, maxLength: 1000 },
              description: 'Exact shell command strings needed during execution (use for pipelines, redirects, or specific commands like "rm -f dist/old.js" or "python3 scripts/gen.py").',
            },
            scripts: {
              type: 'array',
              maxItems: 16,
              items: { type: 'string', minLength: 1, maxLength: 400 },
              description: 'Workspace Python scripts to run with any arguments, as a path or a workspace module, e.g. ["python3 scripts/backtest.py", "python3 -m scripts.daily_memo"]. Approved at their current content: editing the script or a local module it imports voids the grant.',
            },
            files: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 512 },
              description: 'Workspace-relative file paths this plan will create or modify (include ALL planned files in workflow and ask-edits modes, plus sensitive askPaths files like AGENTS.md or lockfiles in any mode).',
            },
            openFiles: {
              type: 'array',
              maxItems: 32,
              items: { type: 'string', minLength: 1, maxLength: 512 },
              description: `Workspace-relative document/slide/PDF/image paths this plan will open on the user's host desktop via ${openToolName}.`,
            },
            worktreeSubagents: {
              type: 'boolean',
              description: 'Set true only if this plan needs to spawn write-capable isolated worktree subagents (droid: "worker").',
            },
          },
        },
      },
    } as unknown as TSchema,
    executionMode: 'sequential',
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as {
        summary?: string;
        steps?: string[];
        permissions?: RequestedPlanPermissions;
      };
      const steps = normalizePlanSteps(Array.isArray(params.steps) ? params.steps : []);
      if (steps.length === 0) {
        options.onAudit?.({
          tool: planToolName,
          args: params,
          decision: 'block',
          rule: 'invalid-plan',
          prompted: false,
        });
        throw new Error('pi_safe_plan requires at least one concrete step (4+ characters).');
      }

      // Replacing or proposing a plan always clears any previous active plan grant first.
      activeGrant = null;

      // In explicit read-only /plan mode, record the structured proposal so agent_settled
      // prompts once at the end of the planning turn while keeping this turn strictly read-only.
      if (options.isPlanning() || options.getPlanMode() === 'plan') {
        pendingProposal = {
          summary: params.summary,
          steps,
          permissions: params.permissions,
        };
        options.setPlannedStepsInPlanMode(steps);
        const classifiedPreview = classifyPlanPermissions(params.permissions, {
          cwd: ctx.cwd,
          policy: options.getPolicy(),
          writeSubMode: options.getWriteSubMode(),
          autonomyLevel: options.getAutonomyLevel?.() ?? 'off',
          isWritable: options.isWritable(ctx.cwd),
          store: options.getShellStore(),
          neverAuto: options.getNeverAutoPatterns?.(ctx.cwd),
        });
        options.onAudit?.({
          tool: planToolName,
          args: params,
          decision: 'allow',
          rule: 'plan-proposal-recorded',
          prompted: false,
        });
        const rejectedNote = classifiedPreview.rejected.length > 0
          ? `\nNote: ${classifiedPreview.rejected.length} requested item(s) are blocked by policy and cannot be granted: ${classifiedPreview.rejected.map(r => `${visible(r.value)} (${r.reason})`).join('; ')}.`
          : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Plan (${steps.length} steps) and required permissions recorded for user review.${rejectedNote}\nPresent a brief summary of your plan to the user and finish your turn so they can approve permissions and start execution.`,
          }],
          details: undefined,
        };
      }

      if (!ctx.hasUI || ctx.signal?.aborted) {
        options.onAudit?.({
          tool: planToolName,
          args: params,
          decision: 'block',
          rule: 'no-ui-block',
          prompted: false,
        });
        return {
          content: [{
            type: 'text' as const,
            text: 'Plan approval requires an interactive UI. Do not run unapproved commands or sensitive edits.',
          }],
          details: undefined,
        };
      }

      const outcome = await promptPlanAndPermissions(ctx, steps, params.permissions, params.summary, false);
      const undecided = undecidedPlanResult(outcome);
      if (undecided) {
        options.onAudit?.({
          tool: planToolName,
          args: params,
          decision: 'denied',
          rule: undecided.rule,
          prompted: true,
        });
        return { content: [{ type: 'text' as const, text: undecided.text }], details: undefined };
      }

      options.onAudit?.({
        tool: planToolName,
        args: params,
        decision: 'approved',
        rule:
          outcome.action === 'execute-saved-shell'
            ? 'plan-approved-saved-shell'
            : outcome.action === 'execute-auto-medium'
              ? 'plan-approved-auto-medium'
              : outcome.action === 'execute-with-grant'
                ? 'plan-approved'
                : outcome.action === 'execute-no-grant'
                  ? 'plan-execute-no-grant'
                  : 'plan-execute-ask-each',
        prompted: true,
      });

      options.onPlanApproved?.({ summary: params.summary, steps, outcome, ctx });
      options.startPlanExecution(steps, ctx);
      const stepList = steps.map(s => `${s.step}. ${s.text}`).join('\n');
      return {
        content: [{
          type: 'text' as const,
          text:
            `Plan approved for execution (${steps.length} steps).\n` +
            `${summarizeGrantedForModel(outcome)}\n\n` +
            `Steps:\n${stepList}\n\n` +
            `Execute each step in order now. Report completed steps with [DONE:n] (for example [DONE:1]) once that step's stated goal and core checks succeed. If an auxiliary check cannot read sandbox-masked private paths (such as .local, .git, or .env*) and the step's goal allows recording or reporting that limitation, note the limitation clearly and still mark [DONE:n]. Reserve [PLAN:PAUSED] (on its own line) for genuine blockers that require user action or permission approval (such as a /rejected command/file or a failed core check, or call ${planToolName} again to request updated permissions), and whenever you emit [PLAN:PAUSED], state the exact blocker and what user action will resume execution.`,
        }],
        details: undefined,
      };
    },
  });

  pi.on('before_agent_start', async (event, ctx) => {
    turnHadRejection = false;
    if (!ctx.hasUI || !event.systemPromptOptions) return;
    const mode = options.getPlanMode();
    const writeSubMode = options.getWriteSubMode();
    const writable = options.isWritable(ctx.cwd);
    const sections = (event.systemPromptOptions.sections ??= {});

    if (mode === 'plan') {
      sections.plan_permissions =
        `Plan mode is active (workspace is read-only). Inspect relevant files first, then call ${planToolName} with your ordered steps and all permissions needed for execution (shellPrefixes, shellCommands, scripts, and files) before finishing your turn so the user can approve the plan and permissions upfront.`;
      return;
    }

    if (mode === 'execute') {
      const grantSummary = describeActiveGrant();
      if (writeSubMode === 'workflow') {
        sections.plan_permissions =
          `Executing approved workflow plan (Stage 3: Execute). Active upfront permissions: ${grantSummary === 'none' ? 'none (all non-routine commands and file modifications are rejected by default)' : grantSummary.trim()}.\n` +
          `Any non-routine shell command or file modification NOT covered by these upfront permissions will be automatically REJECTED by default (without prompting) and recorded in /rejected for user review. Report [DONE:n] once a step's stated goal and core checks succeed (if an auxiliary check hits sandbox-masked private paths such as .local, .git, or .env* and the step's goal allows reporting that gap, record it clearly and mark [DONE:n]). Reserve [PLAN:PAUSED] on its own line for genuine blockers requiring user action or permission approval (or call ${planToolName} again with updated permissions), and always state the exact blocker and how to resume.`;
        return;
      }
      sections.plan_permissions =
        `Executing approved plan. Active plan-scoped permissions: ${grantSummary === 'none' ? 'none (non-routine commands and sensitive/ask-edits writes prompt individually)' : grantSummary.trim()}.\n` +
        `Report completed steps with [DONE:n] once a step's goal and core checks pass (if an auxiliary check hits sandbox-masked private paths such as .local or .env* and the step allows reporting that limitation, note it and mark [DONE:n]; reserve [PLAN:PAUSED] on its own line for genuine blockers requiring user action, stating the blocker clearly). These plan permissions clear automatically when the plan completes or is cancelled. If the plan changes and needs new permissions, call ${planToolName} again.`;
      return;
    }

    if (writeSubMode === 'workflow') {
      const roNote = !writable ? ' (Note: workspace has no write checkpoint and remains read-only.)' : '';
      sections.plan_permissions =
        `Current mode is workflow: the 3-stage sequence Plan → Ask for Permissions (${planToolName}) → Execute is strictly enforced.${roNote}\n` +
        `1. Stage 1 — Plan (Read-only): For questions or read-only analysis, inspect the codebase and answer directly. Before modifying any files or running non-routine shell commands, explore read-only first (use pi_safe_read, pi_safe_grep, pi_safe_find, pi_safe_ls, pi_safe_git, and pi_safe_ask_user if requirements need clarification).\n` +
        `2. Stage 2 — Ask for Permissions (${planToolName}): Call ${planToolName} with concrete ordered steps and ALL permissions needed for execution (shellPrefixes, shellCommands, scripts, and ALL files to create/modify in permissions.files). File edits and unapproved commands are blocked until ${planToolName} is approved.\n` +
        `3. Stage 3 — Execute: Once approved, execute the steps in order and report [DONE:n] only after each step succeeds. Any permission requested later during execution that was NOT approved upfront will be rejected by default (the user can check and approve rejected items via /rejected or /permissions review, or you may call ${planToolName} again to update permissions).`;
      return;
    }

    const editNote = !writable
      ? 'Workspace is currently read-only (no write checkpoint).'
      : writeSubMode === 'ask-edits'
        ? 'Current mode is ask-edits: every file edit/write requires approval unless pre-approved in a plan.'
        : 'Current mode is accept-edits: normal workspace edits are allowed, while sensitive askPaths files (AGENTS.md, CLAUDE.md, CI configs, lockfiles) and non-routine shell commands require approval.';

    sections.plan_permissions =
      `${editNote}\n` +
      `Adaptive planning with upfront permission approval:\n` +
      `- For simple questions, read-only exploration, or single-step edits that need no extra permissions, act directly without calling ${planToolName}.\n` +
      `- For multi-step tasks, or whenever accomplishing the task requires non-routine shell commands, sensitive askPaths edits, or file modifications in ask-edits mode: explore read-only first, then call ${planToolName} with your concrete steps and exact permissions (shellPrefixes, shellCommands, scripts, files) BEFORE making changes so the user can review and approve the plan and needed permissions upfront.`;
  });

  function checkGrantShell(
    grant: ActivePlanGrant | null | undefined,
    command: string,
    neverSessionAllow: readonly string[] | undefined,
    exactRule: ShellPlanAllowRule,
    prefixRule: ShellPlanAllowRule,
    scriptRule: ShellPlanAllowRule,
  ): ShellPlanAllowRule | null {
    if (!grant) return null;
    const policy = options.getPolicy();
    const extraDeny = options.getShellStore()?.denyRules() ?? [];
    if (checkShellDeny(command, policy, extraDeny)) return null;
    const trimmedLead = command.replace(/^[ \t]+/, '');
    if (grant.exactCommands.has(command) || grant.exactCommands.has(trimmedLead)) {
      return exactRule;
    }
    for (const prefix of grant.shellPrefixes) {
      if (prefixRuleAllows(prefix, command, neverSessionAllow)) {
        return prefixRule;
      }
    }
    if (grant.scripts.length && checkScriptGrants(trimmedLead, grant.cwd, grant.scripts, policy) === 'match') {
      return scriptRule;
    }
    return null;
  }

  function checkGrantFile(
    grant: ActivePlanGrant | null | undefined,
    cwd: string,
    filePath: string,
    decision: 'allow' | 'ask',
    writeSubMode: WriteSubMode,
    sensitiveRule: FilePlanAllowRule,
    editRule: FilePlanAllowRule,
  ): FilePlanAllowRule | null {
    if (!grant) return null;
    if (safeRealpath(cwd) !== grant.cwd) return null;
    const policy = options.getPolicy();
    if (policy && editDecision(cwd, filePath, policy) === 'deny') return null;
    const rel = canonicalRelativeWorkspacePath(cwd, filePath);
    if (!rel || hasSymbolicLinkInChain(cwd, rel)) return null;
    if (decision === 'ask') {
      return grant.askFiles.has(rel) ? sensitiveRule : null;
    }
    if (writeSubMode === 'ask-edits' || writeSubMode === 'workflow' || editRule === 'rejected-approved-edit') {
      return grant.plannedFiles.has(rel) ? editRule : null;
    }
    return null;
  }

  return {
    allowsShell(command: string, neverSessionAllow?: readonly string[]) {
      const fromPlan = checkGrantShell(
        activeGrant,
        command,
        neverSessionAllow,
        'plan-approved-exact',
        'plan-approved-prefix',
        'plan-approved-script',
      );
      if (fromPlan) return fromPlan;
      for (const grant of approvedRejectedByCwd.values()) {
        const fromRej = checkGrantShell(
          grant,
          command,
          neverSessionAllow,
          'rejected-approved-exact',
          'rejected-approved-prefix',
          'rejected-approved-script',
        );
        if (fromRej) return fromRej;
      }
      return null;
    },
    allowsApprovedRejectedShell(command: string, neverSessionAllow?: readonly string[]) {
      for (const grant of approvedRejectedByCwd.values()) {
        const fromRej = checkGrantShell(
          grant,
          command,
          neverSessionAllow,
          'rejected-approved-exact',
          'rejected-approved-prefix',
          'rejected-approved-script',
        );
        if (fromRej === 'rejected-approved-exact' || fromRej === 'rejected-approved-prefix' || fromRej === 'rejected-approved-script') {
          return fromRej;
        }
      }
      return null;
    },
    allowsFileEdit(cwd, filePath, decision, writeSubMode) {
      const fromPlan = checkGrantFile(
        activeGrant,
        cwd,
        filePath,
        decision,
        writeSubMode,
        'plan-approved-sensitive-path',
        'plan-approved-edit',
      );
      if (fromPlan) return fromPlan;
      const rejGrant = approvedRejectedByCwd.get(safeRealpath(cwd));
      return checkGrantFile(
        rejGrant,
        cwd,
        filePath,
        decision,
        writeSubMode,
        'rejected-approved-sensitive-path',
        'rejected-approved-edit',
      );
    },
    allowsApprovedRejectedFile(cwd, filePath, decision) {
      const rejGrant = approvedRejectedByCwd.get(safeRealpath(cwd));
      const matched = checkGrantFile(
        rejGrant,
        cwd,
        filePath,
        decision,
        'ask-edits',
        'rejected-approved-sensitive-path',
        'rejected-approved-edit',
      );
      if (matched === 'rejected-approved-sensitive-path' || matched === 'rejected-approved-edit') {
        return matched;
      }
      return null;
    },
    allowsWorktreeDelegate(cwd) {
      const canon = safeRealpath(cwd);
      if (activeGrant && activeGrant.cwd === canon && activeGrant.worktreeSubagents) {
        return 'plan-approved-worktree';
      }
      const rejGrant = approvedRejectedByCwd.get(canon);
      if (rejGrant?.worktreeSubagents) {
        return 'rejected-approved-worktree';
      }
      return null;
    },
    allowsFileOpen(cwd, filePath) {
      const canon = safeRealpath(cwd);
      const policy = options.getPolicy();
      if (policy && editDecision(cwd, filePath, policy) === 'deny') return null;
      const rel = canonicalRelativeWorkspacePath(cwd, filePath);
      if (!rel || hasSymbolicLinkInChain(cwd, rel)) return null;
      if (activeGrant && activeGrant.cwd === canon && activeGrant.openFiles.has(rel)) {
        return 'plan-approved-open';
      }
      const rejGrant = approvedRejectedByCwd.get(canon);
      if (rejGrant?.openFiles.has(rel)) {
        return 'rejected-approved-open';
      }
      return null;
    },
    allowsApprovedRejectedOpen(cwd, filePath) {
      const policy = options.getPolicy();
      if (policy && editDecision(cwd, filePath, policy) === 'deny') return null;
      const rel = canonicalRelativeWorkspacePath(cwd, filePath);
      if (!rel || hasSymbolicLinkInChain(cwd, rel)) return null;
      const rejGrant = approvedRejectedByCwd.get(safeRealpath(cwd));
      return rejGrant?.openFiles.has(rel) ? 'rejected-approved-open' : null;
    },
    allowsApprovedRejectedWorktree(cwd) {
      const rejGrant = approvedRejectedByCwd.get(safeRealpath(cwd));
      return rejGrant?.worktreeSubagents ? 'rejected-approved-worktree' : null;
    },
    recordRejectedShell,
    recordRejectedFile,
    recordRejectedOpen,
    recordRejectedWorktree,
    listRejected,
    pendingRejectedCount,
    formatRejectedSummaryForPermissions,
    formatRejectedReport,
    approveRejected,
    clearRejected,
    resetSession,
    consumeTurnRejectionPause() {
      const v = turnHadRejection;
      turnHadRejection = false;
      return v;
    },
    handleRejectedCommand,
    promptAfterRejectionPause,
    clearGrant,
    hasActiveGrant: () => activeGrant !== null,
    describeActiveGrant,
    consumePendingProposal() {
      const proposal = pendingProposal;
      pendingProposal = undefined;
      return proposal;
    },
    async confirmFromPlanMode(ctx, steps, fallbackText) {
      const proposal = pendingProposal;
      pendingProposal = undefined;
      const effectiveSteps = proposal?.steps.length ? proposal.steps : steps;
      const requested = proposal?.permissions ?? (fallbackText ? extractPlanPermissions(fallbackText) : undefined);
      const summary = proposal?.summary;

      activeGrant = null;
      const outcome = await promptPlanAndPermissions(ctx, effectiveSteps, requested, summary, true);
      if (outcome.action === 'stay-in-plan') {
        options.onAudit?.({
          tool: planToolName,
          args: { fromPlanMode: true, steps: effectiveSteps.map(s => s.text), permissions: requested },
          decision: 'denied',
          rule: 'plan-stay-readonly',
          prompted: true,
        });
        return 'stay';
      }
      const undecided = undecidedPlanResult(outcome);
      if (undecided) {
        options.onAudit?.({
          tool: planToolName,
          args: { fromPlanMode: true, steps: effectiveSteps.map(s => s.text), permissions: requested },
          decision: 'denied',
          rule: undecided.rule,
          prompted: true,
        });
        // pi-plan opens its editor for a revision; every other undecided case keeps plan mode, read-only.
        return outcome.action === 'revise' ? 'refine' : 'stay';
      }
      options.onAudit?.({
        tool: planToolName,
        args: { fromPlanMode: true, steps: effectiveSteps.map(s => s.text), permissions: requested },
        decision: 'approved',
        rule:
          outcome.action === 'execute-saved-shell'
            ? 'plan-approved-saved-shell'
            : outcome.action === 'execute-auto-medium'
              ? 'plan-approved-auto-medium'
              : outcome.action === 'execute-with-grant'
                ? 'plan-approved'
                : outcome.action === 'execute-no-grant'
                  ? 'plan-execute-no-grant'
                  : 'plan-execute-ask-each',
        prompted: true,
      });
      options.onPlanApproved?.({ summary, steps: effectiveSteps, outcome, ctx });
      return 'execute';
    },
  };
}
