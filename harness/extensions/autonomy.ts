import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  argvPrefixMatches,
  checkShellDeny,
  isAllowedPrefixArgv,
  visible,
  type DenyArgvRule,
  type Policy,
} from './approvals.ts';

function tokenizeSafeSingleCommand(command: string): string[] | null {
  // Allow `,` and `:` in argument tokens (e.g. `sed -n 1,20p`, `git show HEAD:file`, `pytest a.py::test_b`),
  // while forbidding all shell operators, quotes, globs, braces, substitutions, redirects, and newlines.
  if (/[^a-zA-Z0-9_./+=:, \t-]/.test(command)) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/[ \t]+/);
  if (!tokens.length || tokens[0] === ':' || tokens[0].includes('=')) return null;
  return tokens;
}
import type { ClassifiedPlanPermissions } from './plan-permissions.ts';
import type { PlanStep } from './pi-plan/src/types.ts';

export type AutonomyLevel = 'off' | 'low' | 'medium';
export type SpecThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const VALID_AUTONOMY = new Set<AutonomyLevel>(['off', 'low', 'medium']);
const VALID_THINKING = new Set<SpecThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const AUTO_LOW_SINGLE_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'file', 'stat', 'pwd',
  'which', 'type', 'tree', 'du', 'df', 'basename', 'dirname', 'realpath',
  'readlink', 'date', 'jq', 'column', 'nl', 'md5sum', 'sha256sum', 'xxd',
  'hexdump', 'uname', 'whoami', 'id',
]);

const AUTO_LOW_GIT_SUBCOMMANDS = [
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'log'],
  ['git', 'show'],
  ['git', 'blame'],
  ['git', 'ls-files'],
  ['git', 'grep'],
  ['git', 'rev-parse'],
  ['git', 'describe'],
  ['git', 'shortlog'],
  ['git', 'branch'],
] as const;

const UNSAFE_FIND_FLAGS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf',
]);

const AUTO_MEDIUM_DEV_PREFIXES: readonly (readonly string[])[] = [
  ['pytest'],
  ['.venv/bin/pytest'],
  ['uv', 'run', 'pytest'],
  ['python', '-m', 'pytest'],
  ['python3', '-m', 'pytest'],
  ['.venv/bin/python', '-m', 'pytest'],
  ['python', '-m', 'unittest'],
  ['python3', '-m', 'unittest'],
  ['python', '-m', 'py_compile'],
  ['python3', '-m', 'py_compile'],
  ['python', '-m', 'mypy'],
  ['python3', '-m', 'mypy'],
  ['mypy'],
  ['ruff', 'check'],
  ['ruff', 'format'],
  ['npm', 'test'],
  ['npm', 'run', 'test'],
  ['npm', 'run', 'lint'],
  ['npm', 'run', 'build'],
  ['npm', 'run', 'typecheck'],
  ['npx', 'tsc'],
  ['tsc'],
  ['node', '--test'],
  ['npx', 'vitest', 'run'],
  ['npx', 'jest'],
  ['make', 'test'],
  ['make', 'check'],
  ['make', 'lint'],
  ['make', 'build'],
  ['cargo', 'test'],
  ['cargo', 'check'],
  ['cargo', 'build'],
  ['cargo', 'clippy'],
  ['cargo', 'fmt'],
  ['go', 'test'],
  ['go', 'vet'],
  ['go', 'build'],
  ['gofmt'],
];

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function parseAutonomyLevel(raw: unknown): AutonomyLevel | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === 'med') return 'medium';
  return VALID_AUTONOMY.has(cleaned as AutonomyLevel) ? (cleaned as AutonomyLevel) : null;
}

export function parseSpecThinkingLevel(raw: unknown): SpecThinkingLevel | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  return VALID_THINKING.has(cleaned as SpecThinkingLevel) ? (cleaned as SpecThinkingLevel) : null;
}

export function nextAutonomyLevel(current: AutonomyLevel): AutonomyLevel {
  return current === 'off' ? 'low' : current === 'low' ? 'medium' : 'off';
}

/**
 * Evaluate whether the current Autonomy Level permits a shell command without prompting.
 * Non-bypassable: `checkShellDeny` (blockedCommands + user deny rules) ALWAYS runs first,
 * and shell operators / redirects / substitutions / `neverSessionAllow` binaries never auto-approve.
 */
export function autonomyAllowsShell(
  level: AutonomyLevel,
  command: string,
  policy?: Pick<Policy, 'blockedCommands' | 'neverSessionAllow'>,
  extraDenyRules: readonly DenyArgvRule[] = [],
): 'auto-low-readonly' | 'auto-medium-dev' | null {
  if (level === 'off') return null;
  if (checkShellDeny(command, policy, extraDenyRules) !== null) return null;

  const tokens = tokenizeSafeSingleCommand(command);
  if (!tokens || tokens.length === 0) return null;

  const prog = path.basename(tokens[0]);
  const never = policy?.neverSessionAllow ?? [];
  if (never.includes(prog)) return null;

  // 1. Auto Low (and Medium): bounded read-only inspection commands
  if (AUTO_LOW_SINGLE_BINARIES.has(tokens[0])) {
    return 'auto-low-readonly';
  }
  if (tokens[0] === 'find') {
    const hasDanger = tokens.slice(1).some(arg => UNSAFE_FIND_FLAGS.has(arg) || arg.startsWith('-fprint') || arg.startsWith('-fls'));
    if (!hasDanger) return 'auto-low-readonly';
    return null;
  }
  if (tokens[0] === 'sed') {
    const args = tokens.slice(1);
    const hasPrintOnly = args.includes('-n') || args.includes('--quiet') || args.includes('--silent');
    const hasInPlace = args.some(a => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'));
    if (hasPrintOnly && !hasInPlace) return 'auto-low-readonly';
  }
  for (const gitPrefix of AUTO_LOW_GIT_SUBCOMMANDS) {
    if (argvPrefixMatches(gitPrefix, tokens)) {
      return 'auto-low-readonly';
    }
  }

  // 2. Auto Medium: bounded local test, lint, typecheck, and build commands
  if (level === 'medium') {
    for (const devPrefix of AUTO_MEDIUM_DEV_PREFIXES) {
      if (devPrefix[0].startsWith('.venv/')) {
        if (tokens.length >= devPrefix.length && devPrefix.every((t, i) => tokens[i] === t)) {
          return 'auto-medium-dev';
        }
        continue;
      }
      if (
        isAllowedPrefixArgv(devPrefix, policy?.neverSessionAllow) &&
        argvPrefixMatches(devPrefix, tokens)
      ) {
        return 'auto-medium-dev';
      }
    }
  }

  return null;
}

export function autonomyAllowsEdit(
  level: AutonomyLevel,
  decision: 'allow' | 'ask' | 'deny',
): 'auto-edit-allow' | null {
  if (level === 'off') return null;
  if (decision === 'allow') return 'auto-edit-allow';
  return null;
}

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'spec';
}

function readPrivateFile(filePath: string, maxBytes = 256 * 1024): string {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > maxBytes || (st.mode & 0o077) !== 0) {
      throw new Error('Expected a private 0600 regular file.');
    }
    const buf = Buffer.alloc(st.size + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    return buf.subarray(0, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export interface SpecArtifactInput {
  cwd: string;
  summary?: string;
  steps: readonly PlanStep[];
  classified?: ClassifiedPlanPermissions;
  autonomyLevel: AutonomyLevel;
  specsBaseDir?: string;
}

export function resolveSpecsProjectDir(cwd: string, specsBaseDir?: string): string {
  const realCwd = (() => {
    try { return realpathSync(cwd); } catch { return path.resolve(cwd); }
  })();
  const base = specsBaseDir
    ? path.resolve(specsBaseDir)
    : (process.env.PI_PROTECTED_SPECS_DIR
      ? path.resolve(process.env.PI_PROTECTED_SPECS_DIR)
      : path.join(os.homedir(), '.local/state/pi-protected/specs'));
  const rel = path.relative(realCwd, base);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('Specs state directory must reside outside the workspace.');
  }
  return path.join(base, sha256(realCwd).slice(0, 12));
}

export function renderSpecMarkdown(input: SpecArtifactInput, createdAt = new Date()): string {
  const title = (input.summary ?? '').replace(/[\r\n\x00-\x1f\x7f-\x9f]+/g, ' ').trim() || input.steps[0]?.text || 'Execution Spec';
  const lines: string[] = [
    `# Spec: ${title}`,
    '',
    `- **Created**: ${createdAt.toISOString()}`,
    `- **Workspace**: ${visible(input.cwd)}`,
    `- **Autonomy**: \`${input.autonomyLevel}\``,
    '',
    '## Steps',
    '',
  ];
  if (input.steps.length === 0) {
    lines.push('_(No structured steps recorded)_');
  } else {
    for (const step of input.steps) {
      lines.push(`${step.step}. [${step.completed ? 'x' : ' '}] ${step.text}`);
    }
  }

  if (input.classified) {
    const c = input.classified;
    lines.push('', '## Permissions', '');
    if (
      c.shellPrefixes.length === 0 &&
      c.shellCommands.length === 0 &&
      (c.scripts?.length ?? 0) === 0 &&
      c.askFiles.length === 0 &&
      c.plannedFiles.length === 0 &&
      c.openFiles.length === 0
    ) {
      lines.push('- None beyond active mode policy.');
    } else {
      for (const prefix of c.shellPrefixes) {
        lines.push(`- Shell prefix: \`${prefix.join(' ')} …\``);
      }
      for (const cmd of c.shellCommands) {
        lines.push(`- Shell command: ${visible(cmd)}`);
      }
      for (const script of c.scripts ?? []) {
        lines.push(`- Script (any arguments while unchanged): \`${script.interpreter} ${script.script}\``);
      }
      for (const file of c.askFiles) {
        lines.push(`- Sensitive file: \`${file}\``);
      }
      for (const file of c.plannedFiles) {
        lines.push(`- Planned file: \`${file}\``);
      }
      for (const file of c.openFiles) {
        lines.push(`- Open on host desktop: \`${file}\``);
      }
    }
    if (c.rejected.length > 0) {
      lines.push('', '## Blocked by Policy', '');
      for (const rej of c.rejected) {
        lines.push(`- ${visible(rej.value)} — ${rej.reason}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function saveSpecMarkdown(input: SpecArtifactInput, now = new Date()): { filePath: string; fileName: string } {
  const projectDir = resolveSpecsProjectDir(input.cwd, input.specsBaseDir);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(projectDir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) {
    throw new Error('Specs project directory must be a private user-owned non-symlink directory.');
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = slugify(input.summary || input.steps[0]?.text || 'spec');
  const fileName = `${stamp}-${slug}.md`;
  const filePath = path.join(projectDir, fileName);
  const markdown = renderSpecMarkdown(input, now);
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, markdown, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { filePath, fileName };
}

export function listSavedSpecs(cwd: string, specsBaseDir?: string): string[] {
  let projectDir: string;
  try {
    projectDir = resolveSpecsProjectDir(cwd, specsBaseDir);
    const st = lstatSync(projectDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  return readdirSync(projectDir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.md'))
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
}

export function readSavedSpec(cwd: string, selector: string, specsBaseDir?: string): { fileName: string; content: string } {
  const projectDir = resolveSpecsProjectDir(cwd, specsBaseDir);
  const files = listSavedSpecs(cwd, specsBaseDir);
  if (files.length === 0) {
    throw new Error('No saved specs for this workspace yet.');
  }
  let targetName: string | undefined;
  if (!selector || selector === 'latest') {
    targetName = files[0];
  } else if (/^[1-9][0-9]*$/.test(selector)) {
    const idx = Number(selector) - 1;
    if (idx < 0 || idx >= files.length) {
      throw new Error(`Choose a spec number between 1 and ${files.length}.`);
    }
    targetName = files[idx];
  } else {
    targetName = files.find(f => f === selector || f === `${selector}.md` || f.includes(selector));
  }
  if (!targetName) {
    throw new Error(`No saved spec matching "${selector}". Use /spec list.`);
  }
  return {
    fileName: targetName,
    content: readPrivateFile(path.join(projectDir, targetName)),
  };
}

export interface RegisterAutonomyOptions {
  initialLevel?: AutonomyLevel;
  explicitStartLevel?: boolean;
  initialSaveSpecs?: boolean;
  initialSpecThinking?: SpecThinkingLevel | null;
  specsBaseDir?: string;
  isPlanning: () => boolean;
  isWritable: (cwd: string) => boolean;
  hasPendingWork: () => boolean;
  getCurrentPlan?: () => { steps: PlanStep[]; mode: string } | undefined;
  onStatusChange?: (ctx?: ExtensionContext) => void;
  /** This project's saved launch default, used when a session has no saved level. */
  getDefaultLevel?: () => AutonomyLevel | undefined;
  /** Save (or clear with null) this project's default; returns a description of the defaults. */
  saveDefaultLevel?: (level: AutonomyLevel | null, cwd: string) => string;
  /** Workflow mode before plan approval blocks even autonomy-covered commands. */
  getModeContext?: () => { workflow: boolean; executing: boolean };
}

const MEDIUM_DEV_SUMMARY = 'pytest, python -m unittest/mypy/py_compile, ruff check/format, npm test, npm run test/lint/build/typecheck, npx tsc/vitest run/jest, node --test, make test/check/lint/build, cargo test/check/build/clippy/fmt, go test/vet/build, gofmt';

/** Prompt text describing what the autonomy level covers and that plans need not request it. */
export function autonomyPromptSection(
  level: AutonomyLevel,
  context: { planning: boolean; workflow: boolean; executing: boolean },
): string | undefined {
  if (level === 'off') return undefined;
  const covered = level === 'medium'
    ? `normal workspace file edits, single read-only inspection commands (ls, cat, rg, grep, find without -exec, sed -n, git status/diff/log, …), and these local dev commands as single commands without pipes or redirects: ${MEDIUM_DEV_SUMMARY}`
    : 'normal workspace file edits and single read-only inspection commands (ls, cat, rg, grep, find without -exec, sed -n, git status/diff/log, …)';
  const when = context.planning
    ? 'Once the plan is approved, they run without approval'
    : context.workflow && !context.executing
      ? 'In workflow mode they run without approval only after the plan is approved (Stage 3); until then file edits and non-routine commands stay blocked'
      : 'They run without approval';
  return `Autonomy level is ${level}: it covers ${covered}. ${when}. Do not request these in ${'pi_safe_plan'} permissions. ` +
    'Sensitive askPaths files, other scripts, pipelines/redirects, and unlisted commands still need approval: outside workflow mode just run them and the user is asked; in a plan, request workspace Python scripts in permissions.scripts.';
}

export interface AutonomyHandle {
  getLevel(): AutonomyLevel;
  setLevel(next: AutonomyLevel, ctx?: ExtensionContext, silent?: boolean): boolean;
  allowsShell(
    command: string,
    policy?: Pick<Policy, 'blockedCommands' | 'neverSessionAllow'>,
    extraDenyRules?: readonly DenyArgvRule[],
  ): 'auto-low-readonly' | 'auto-medium-dev' | null;
  allowsEdit(decision: 'allow' | 'ask' | 'deny'): 'auto-edit-allow' | null;
  onPlanModeChange(planning: boolean): void;
  recordApprovedSpec(info: {
    cwd: string;
    summary?: string;
    steps: readonly PlanStep[];
    classified?: ClassifiedPlanPermissions;
    ctx?: ExtensionContext;
  }): string | undefined;
  isSaveSpecsEnabled(): boolean;
  getSpecThinking(): SpecThinkingLevel | null;
}

export function registerAutonomy(pi: ExtensionAPI, options: RegisterAutonomyOptions): AutonomyHandle {
  let level: AutonomyLevel = options.initialLevel ?? 'off';
  let saveSpecs = Boolean(options.initialSaveSpecs);
  let specThinking: SpecThinkingLevel | null = options.initialSpecThinking ?? null;
  let savedNormalThinking: SpecThinkingLevel | null = null;
  let lastSpecSnapshot: Omit<SpecArtifactInput, 'autonomyLevel' | 'specsBaseDir'> | null = null;
  let pendingNote: string | null = level !== 'off'
    ? `Autonomy level is ${level}: ${level === 'medium' ? 'normal workspace edits, safe read-only commands, and allowlisted dev/test/lint/build commands run without confirmation.' : 'normal workspace edits and safe read-only inspection commands run without confirmation.'}`
    : null;

  function applySpecThinking(planning: boolean): void {
    try {
      if (planning) {
        if (specThinking) {
          if (savedNormalThinking === null) {
            const cur = parseSpecThinkingLevel(pi.getThinkingLevel?.());
            if (cur) savedNormalThinking = cur;
          }
          pi.setThinkingLevel?.(specThinking);
        }
      } else if (savedNormalThinking !== null) {
        pi.setThinkingLevel?.(savedNormalThinking);
        savedNormalThinking = null;
      }
    } catch {
      // Ignore if active model or test harness omits thinking level control.
    }
  }

  function setLevel(next: AutonomyLevel, ctx?: ExtensionContext, silent = false): boolean {
    if (ctx && (!ctx.isIdle() || options.hasPendingWork()) && !silent) {
      ctx.ui.notify('Wait for active runs or background jobs to finish before changing autonomy level.', 'warning');
      return false;
    }
    if (next !== 'off' && ctx && !options.isWritable(ctx.cwd) && !options.isPlanning() && !silent) {
      ctx.ui.notify('Workspace has no launch checkpoint and remains read-only.', 'warning');
      return false;
    }
    const changed = level !== next;
    level = next;
    if (changed) {
      pendingNote = next === 'off'
        ? 'Autonomy level set to off: manual approvals apply according to permission mode.'
        : next === 'low'
          ? 'Autonomy level set to low: normal workspace edits and safe read-only inspection commands run without confirmation.'
          : 'Autonomy level set to medium: normal workspace edits, read-only inspection commands, and allowlisted local test/lint/build commands run without confirmation.';
      try {
        pi.appendEntry('pi-autonomy-level', { level: next });
      } catch {
        // Ignore outside active session.
      }
    }
    options.onStatusChange?.(ctx);
    if (!silent && ctx?.hasUI) {
      ctx.ui.notify(`Autonomy level: ${next} (Ctrl+Alt+A or /auto cycle).`, 'info');
    }
    return true;
  }

  function cycleLevel(ctx: ExtensionContext): void {
    setLevel(nextAutonomyLevel(level), ctx, false);
  }

  pi.registerShortcut('ctrl+alt+a', {
    description: 'Cycle autonomy level (off → low → medium)',
    handler: async ctx => cycleLevel(ctx),
  });

  pi.registerCommand('auto', {
    description: 'View or switch autonomy level: /auto [off | low | medium | cycle | default [level|clear]]',
    async handler(raw, ctx) {
      const arg = raw.trim().toLowerCase();
      const defaultMatch = /^default(?:\s+(\S+))?$/.exec(arg);
      if (defaultMatch) {
        if (!options.saveDefaultLevel) {
          ctx.ui.notify('Project defaults are unavailable in this session.', 'warning');
          return;
        }
        const value = defaultMatch[1];
        if (value === 'high') {
          ctx.ui.notify('Protected Pi caps autonomy at "medium".', 'warning');
          return;
        }
        const target = !value ? level : value === 'clear' || value === 'none' ? null : parseAutonomyLevel(value);
        if (target === undefined || (value && value !== 'clear' && value !== 'none' && !target)) {
          ctx.ui.notify('Usage: /auto default [off | low | medium | clear]  (no value saves the current level)', 'warning');
          return;
        }
        try {
          const desc = options.saveDefaultLevel(target as AutonomyLevel | null, ctx.cwd);
          ctx.ui.notify(`Launch default for this project: ${desc}. New sessions here start this way; --auto still overrides.`, 'info');
        } catch (error) {
          ctx.ui.notify(`Could not save the project default: ${(error as Error).message}`, 'warning');
        }
        return;
      }
      if (!arg || arg === 'status') {
        const desc = level === 'off'
          ? 'off (manual approvals per /mode)'
          : level === 'low'
            ? 'low (normal edits + read-only inspection commands)'
            : 'medium (low + local test/lint/typecheck/build commands)';
        const projectDefault = options.getDefaultLevel?.();
        ctx.ui.notify(`Autonomy level: ${desc}. Use /auto <off|low|medium|cycle> or Ctrl+Alt+A.${projectDefault ? ` Project default: ${projectDefault} (/auto default).` : ''}`, 'info');
        return;
      }
      if (arg === 'cycle') {
        cycleLevel(ctx);
        return;
      }
      if (arg === 'high') {
        ctx.ui.notify('Protected Pi caps autonomy at "medium" so destructive commands, scripts, and sensitive paths always stay gated.', 'warning');
        return;
      }
      const parsed = parseAutonomyLevel(arg);
      if (!parsed) {
        ctx.ui.notify('Usage: /auto [off | low | medium | cycle | default [level|clear]]', 'warning');
        return;
      }
      setLevel(parsed, ctx, false);
    },
  });

  pi.registerCommand('spec', {
    description: 'Manage Spec mode artifacts & settings: /spec [status | save [on|off|now] | list | show [n] | thinking <level|inherit>]',
    async handler(raw, ctx) {
      const args = raw.trim();
      if (!args || args === 'status') {
        const files = listSavedSpecs(ctx.cwd, options.specsBaseDir);
        ctx.ui.notify(
          [
            `Spec mode: ${options.isPlanning() ? 'active (read-only)' : 'inactive (/plan or Ctrl+Alt+P to toggle)'}`,
            `Auto-save approved specs: ${saveSpecs ? 'on' : 'off'} (/spec save on|off)`,
            `Spec reasoning effort: ${specThinking ?? 'inherit'} (/spec thinking <off|minimal|low|medium|high|xhigh|inherit>)`,
            `Saved specs for this workspace: ${files.length} (/spec list)`,
          ].join('\n'),
          'info',
        );
        return;
      }

      if (args === 'list') {
        const files = listSavedSpecs(ctx.cwd, options.specsBaseDir);
        if (files.length === 0) {
          ctx.ui.notify('No saved specs for this workspace. Enable with /spec save on or save current plan with /spec save now.', 'info');
          return;
        }
        const preview = files.slice(0, 15).map((name, idx) => `  ${idx + 1}. ${name}`).join('\n');
        ctx.ui.notify(`Saved specs (${files.length}):\n${preview}\nUse /spec show <number> to view.`, 'info');
        return;
      }

      const showMatch = /^show(?:\s+(.+))?$/.exec(args);
      if (showMatch) {
        try {
          const { fileName, content } = readSavedSpec(ctx.cwd, (showMatch[1] ?? 'latest').trim(), options.specsBaseDir);
          ctx.ui.notify(`=== ${fileName} ===\n${content.trimEnd()}`, 'info');
        } catch (error) {
          ctx.ui.notify(`Spec: ${(error as Error).message}`, 'warning');
        }
        return;
      }

      const saveMatch = /^save(?:\s+(on|off|now))?$/.exec(args);
      if (saveMatch) {
        const sub = saveMatch[1] ?? 'now';
        if (sub === 'on' || sub === 'off') {
          saveSpecs = sub === 'on';
          ctx.ui.notify(`Auto-save approved specs: ${saveSpecs ? 'on' : 'off'}.`, 'info');
          return;
        }
        const currentPlan = options.getCurrentPlan?.();
        const steps = currentPlan?.steps?.length ? currentPlan.steps : lastSpecSnapshot?.steps ?? [];
        if (steps.length === 0) {
          ctx.ui.notify('No active or recent plan steps to save yet.', 'warning');
          return;
        }
        try {
          const saved = saveSpecMarkdown({
            cwd: ctx.cwd,
            summary: lastSpecSnapshot?.summary,
            steps,
            classified: lastSpecSnapshot?.classified,
            autonomyLevel: level,
            specsBaseDir: options.specsBaseDir,
          });
          ctx.ui.notify(`Saved spec to ${saved.filePath}`, 'info');
        } catch (error) {
          ctx.ui.notify(`Could not save spec: ${(error as Error).message}`, 'warning');
        }
        return;
      }

      const thinkMatch = /^thinking\s+(.+)$/.exec(args);
      if (thinkMatch) {
        const val = thinkMatch[1].trim().toLowerCase();
        if (val === 'inherit' || val === 'default') {
          specThinking = null;
          if (savedNormalThinking !== null) {
            try { pi.setThinkingLevel?.(savedNormalThinking); } catch {}
            savedNormalThinking = null;
          }
          ctx.ui.notify('Spec reasoning effort reset to inherit session thinking level.', 'info');
          return;
        }
        const parsed = parseSpecThinkingLevel(val);
        if (!parsed) {
          ctx.ui.notify('Usage: /spec thinking <off | minimal | low | medium | high | xhigh | inherit>', 'warning');
          return;
        }
        specThinking = parsed;
        if (options.isPlanning()) applySpecThinking(true);
        ctx.ui.notify(`Spec reasoning effort set to ${parsed}.`, 'info');
        return;
      }

      ctx.ui.notify('Usage: /spec [status | save [on|off|now] | list | show [n] | thinking <level|inherit>]', 'warning');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    if (!options.explicitStartLevel) {
      let restored: AutonomyLevel = options.getDefaultLevel?.() ?? 'off';
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'custom' && (entry as { customType?: string }).customType === 'pi-autonomy-level') {
          const parsed = parseAutonomyLevel((entry as { data?: { level?: unknown } }).data?.level);
          if (parsed) restored = parsed;
        }
      }
      level = restored;
    }
    if (options.isPlanning() && specThinking) {
      applySpecThinking(true);
    }
  });

  pi.on('before_agent_start', async event => {
    if (!event.systemPromptOptions) return;
    const modeContext = options.getModeContext?.() ?? { workflow: false, executing: false };
    const section = autonomyPromptSection(level, { planning: options.isPlanning(), ...modeContext });
    if (section) {
      const sections = (event.systemPromptOptions.sections ??= {});
      sections.autonomy_level = section;
    }
    if (pendingNote) {
      const content = pendingNote;
      pendingNote = null;
      return { message: { customType: 'pi-autonomy-level', content, display: false } };
    }
  });

  return {
    getLevel: () => level,
    setLevel,
    allowsShell: (command, policy, extraDenyRules) => autonomyAllowsShell(level, command, policy, extraDenyRules),
    allowsEdit: decision => autonomyAllowsEdit(level, decision),
    onPlanModeChange: planning => applySpecThinking(planning),
    recordApprovedSpec(info) {
      lastSpecSnapshot = {
        cwd: info.cwd,
        summary: info.summary,
        steps: info.steps.map(s => ({ ...s })),
        classified: info.classified,
      };
      if (!saveSpecs) return undefined;
      try {
        const saved = saveSpecMarkdown({
          ...lastSpecSnapshot,
          autonomyLevel: level,
          specsBaseDir: options.specsBaseDir,
        });
        if (info.ctx?.hasUI) {
          info.ctx.ui.notify(`Saved approved spec: ${saved.fileName} (/spec show 1)`, 'info');
        }
        return saved.filePath;
      } catch (error) {
        if (info.ctx?.hasUI) {
          info.ctx.ui.notify(`Could not save spec Markdown: ${(error as Error).message}`, 'warning');
        }
        return undefined;
      }
    },
    isSaveSpecsEnabled: () => saveSpecs,
    getSpecThinking: () => specThinking,
  };
}
