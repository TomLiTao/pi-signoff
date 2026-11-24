// Worktree guard: keep a session's task worktree from being removed under it, notice when it is removed
// anyway, and keep the session's working location in the system prompt.
//
// The failure it prevents: Pi, launched in the main checkout, created `.claude/worktrees/<task>` and worked
// there for hours. Another agent merged and removed that worktree while the session was still open. When
// the next request came, Pi found the folder gone and silently carried on in the main checkout; its plan
// listed main-checkout paths and the user approved it without noticing the change.
//
// - A task worktree becomes *active* when this session writes into it (edit/write tools), creates it with
//   `git worktree add`, or was launched inside it.
// - Active worktrees are locked with Git's own lock file (`git worktree remove` refuses a locked worktree,
//   whoever runs it). The lock names this session and its process; it is released when the session ends,
//   and a lock left by a process that no longer exists counts as stale.
// - If an active worktree disappears, the user is told, and edit/write calls that would land in the main
//   checkout are blocked until the user has answered a question or approved a plan after the removal.
// - A <working_state> system prompt section names the checkout, branch and task worktrees.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface WorktreeRoot {
  /** Absolute, real path of the linked worktree's top folder. */
  root: string;
  /** Git's admin folder for it (`<common>/worktrees/<id>`), from the worktree's `.git` file. */
  gitdir: string;
}

const LOCK_TAG = 'pi session ';

/** The linked worktree whose top folder contains `target`, strictly inside `launch`; undefined for the main checkout. */
export function nestedWorktreeOf(launch: string, target: string): WorktreeRoot | undefined {
  let dir = path.resolve(target);
  // Walk up from the deepest existing folder (a new file's parent folders may not exist yet).
  while (!existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  for (;;) {
    const rel = path.relative(launch, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const gitdir = linkedGitdir(dir);
    if (gitdir) {
      try {
        return { root: realpathSync(dir), gitdir };
      } catch {
        return undefined;
      }
    }
    dir = path.dirname(dir);
  }
}

/** For a linked worktree top folder, its admin folder; undefined when `.git` is not a `gitdir:` file. */
export function linkedGitdir(dir: string): string | undefined {
  try {
    const dotGit = path.join(dir, '.git');
    if (!lstatSync(dotGit).isFile()) return undefined;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096));
    return m ? path.resolve(dir, m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Branch checked out in a Git admin or `.git` folder, `detached`, or undefined if unreadable. */
export function headBranch(gitdir: string): string | undefined {
  try {
    const head = readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : 'detached';
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockReason(sessionId: string | undefined, pid = process.pid): string {
  return `${LOCK_TAG}${sessionId ?? 'unknown'} (pid ${pid}) is working in this worktree. The lock is released when that session exits. `
    + 'To remove the worktree anyway, end that session first, or run "git worktree unlock" if it is no longer running.';
}

/** The holder of a worktree lock: ours, another live Pi session, a dead Pi process, or not a Pi lock. */
export function lockState(gitdir: string, pid = process.pid): { state: 'none' | 'ours' | 'live-pi' | 'stale-pi' | 'foreign'; reason?: string } {
  let reason: string;
  try {
    reason = readFileSync(path.join(gitdir, 'locked'), 'utf8');
  } catch {
    return { state: 'none' };
  }
  const m = new RegExp(`^${LOCK_TAG}\\S+ \\(pid (\\d+)\\)`).exec(reason);
  if (!m) return { state: 'foreign', reason };
  const holder = Number(m[1]);
  if (holder === pid) return { state: 'ours', reason };
  return { state: pidAlive(holder) ? 'live-pi' : 'stale-pi', reason };
}

/** Lock a worktree for this session. Leaves a lock held by anyone else alive in place. */
export function lockWorktree(gitdir: string, sessionId: string | undefined, pid = process.pid): boolean {
  const current = lockState(gitdir, pid);
  if (current.state === 'ours') return true;
  if (current.state === 'live-pi' || current.state === 'foreign') return false;
  const file = path.join(gitdir, 'locked');
  try {
    if (current.state === 'stale-pi') unlinkSync(file);
    const fd = openSync(file, 'wx', 0o644);
    try {
      writeSync(fd, `${lockReason(sessionId, pid)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove this session's lock, or a stale Pi lock; never anyone else's. */
export function unlockWorktree(gitdir: string, pid = process.pid, staleToo = false): boolean {
  const current = lockState(gitdir, pid);
  if (current.state !== 'ours' && !(staleToo && current.state === 'stale-pi')) return false;
  try {
    unlinkSync(path.join(gitdir, 'locked'));
    return true;
  } catch {
    return false;
  }
}

/** True when a shell command creates a Git worktree. */
export function createsWorktree(command: string): boolean {
  return /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+)*\s+worktree\s+add\b/.test(command);
}

/** Paths of linked worktrees inside `launch`, from `git worktree list --porcelain` output. */
export function nestedWorktreesFromPorcelain(launch: string, porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    const rel = path.relative(launch, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.push(p);
  }
  return out;
}

interface Tracked extends WorktreeRoot {
  rel: string;
  branch?: string;
  vanishedAt?: string;
  locked: boolean;
}

export interface WorktreeGuardOptions {
  /** Real path of the launch folder. */
  launch: string;
  toolPrefix?: string;
  /** Host `git worktree list --porcelain` in `cwd`; injectable for tests. */
  listWorktrees?: (cwd: string) => Promise<string>;
  /** Called when a nested worktree becomes active (for per-root checkpoints). */
  onActivate?: (root: string) => void;
  pid?: number;
}

export interface WorktreeGuardHandle {
  /** Mark the worktree containing an absolute target path active; returns its root, if any. */
  noteWriteTarget(target: string, ctx?: ExtensionContext): string | undefined;
  /** Present, active nested worktrees (excluding the launch folder itself). */
  activeRoots(): string[];
  /** Lines for the plan review: where the planned files go and what deserves a second look. */
  reviewNotices(cwd: string, files: readonly string[]): string[];
  workingStateSection(): string | undefined;
  /** The user decided after a removal (answered a question or approved a plan). */
  acknowledgeRemoval(): void;
  /** Block reason for an edit/write to `target`, if the session lost its worktree and the user has not decided yet. */
  checkWrite(target: string, ctx?: ExtensionContext): string | undefined;
  /** Release this session's locks (session end). */
  releaseAll(): void;
  /** Absolute paths this session's edit/write tools changed during the current agent run. */
  turnWrites(): Set<string>;
  /** Stop tracking a worktree the user removed on purpose (/worktree done). */
  forget(root: string): void;
}

const hostWorktreeList = (cwd: string) => new Promise<string>(resolve => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('PI_')) env[k] = v;
  execFile('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd,
    'worktree', 'list', '--porcelain'], { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024 },
  (error, stdout) => resolve(error ? '' : String(stdout)));
});

export function createWorktreeGuard(options: WorktreeGuardOptions) {
  const launch = options.launch;
  const pid = options.pid ?? process.pid;
  const listWorktrees = options.listWorktrees ?? hostWorktreeList;
  const tracked = new Map<string, Tracked>();
  let sessionId: string | undefined;
  /** Nested worktrees that existed before this session touched anything: others' work, never auto-activated by a scan. */
  let preexisting = new Set<string>();
  let awaitingDecision = false;
  let writes = new Set<string>();
  const launchGitdir = linkedGitdir(launch);
  const launchGitDirPlain = launchGitdir ? undefined : path.join(launch, '.git');

  function launchBranch(): string | undefined {
    return headBranch(launchGitdir ?? launchGitDirPlain!);
  }

  function activate(wt: WorktreeRoot, ctx?: ExtensionContext): string {
    let t = tracked.get(wt.root);
    if (!t) {
      t = { ...wt, rel: path.relative(launch, wt.root) || '.', branch: headBranch(wt.gitdir), locked: false };
      tracked.set(wt.root, t);
      if (wt.root !== launch) options.onActivate?.(wt.root);
    }
    if (!t.vanishedAt && !t.locked) {
      t.locked = lockWorktree(t.gitdir, sessionId, pid);
      if (!t.locked && ctx?.hasUI) {
        const held = lockState(t.gitdir, pid);
        if (held.state === 'live-pi') ctx.ui.notify(`${t.rel} is locked by another running Pi session; edits here may collide with it.`, 'warning');
      }
    }
    return wt.root;
  }

  /** Mark vanished worktrees; returns the newly vanished ones. */
  function refresh(ctx?: ExtensionContext): Tracked[] {
    const gone: Tracked[] = [];
    for (const t of tracked.values()) {
      if (t.vanishedAt || existsSync(t.root)) {
        if (!t.vanishedAt) t.branch = headBranch(t.gitdir) ?? t.branch;
        continue;
      }
      t.vanishedAt = new Date().toISOString();
      t.locked = false;
      gone.push(t);
    }
    if (gone.length) {
      awaitingDecision = true;
      const names = gone.map(t => `${t.rel}${t.branch ? ` (${t.branch})` : ''}`).join(', ');
      ctx?.ui?.notify?.(`The task worktree ${names} was removed outside this session. Pi will not move its work to the main checkout until you decide.`, 'warning');
    }
    return gone;
  }

  function targetLabel(root: string | undefined): string {
    if (!root || root === launch) return `the main checkout (${path.basename(launch)}) on ${launchBranch() ?? 'unknown branch'}`;
    const t = tracked.get(root);
    return `${path.relative(launch, root)} on ${t?.branch ?? headBranch(linkedGitdir(root) ?? '') ?? 'unknown branch'}`;
  }

  const handle: WorktreeGuardHandle & {
    onSessionStart(id: string | undefined, ctx?: ExtensionContext): Promise<void>;
    afterShell(command: string, ctx?: ExtensionContext): Promise<void>;
    refresh: typeof refresh;
    resetTurnWrites(): void;
    recordWrite(target: string): void;
  } = {
    async onSessionStart(id, ctx) {
      sessionId = id;
      awaitingDecision = false;
      for (const t of tracked.values()) if (t.locked) unlockWorktree(t.gitdir, pid);
      tracked.clear();
      preexisting = new Set(nestedWorktreesFromPorcelain(launch, await listWorktrees(launch)).map(p => {
        try { return realpathSync(p); } catch { return p; }
      }));
      // Launched inside a linked worktree: that is the task worktree from the start.
      if (launchGitdir) activate({ root: launch, gitdir: launchGitdir }, ctx);
    },
    async afterShell(command, ctx) {
      if (!createsWorktree(command)) return;
      for (const p of nestedWorktreesFromPorcelain(launch, await listWorktrees(launch))) {
        let real: string;
        try { real = realpathSync(p); } catch { continue; }
        if (preexisting.has(real) || tracked.has(real)) continue;
        const gitdir = linkedGitdir(real);
        if (gitdir) activate({ root: real, gitdir }, ctx);
      }
    },
    refresh,
    noteWriteTarget(target, ctx) {
      const wt = nestedWorktreeOf(launch, target);
      return wt ? activate(wt, ctx) : undefined;
    },
    activeRoots() {
      return [...tracked.values()].filter(t => !t.vanishedAt && t.root !== launch && existsSync(t.root)).map(t => t.root);
    },
    acknowledgeRemoval() {
      awaitingDecision = false;
    },
    checkWrite(target, ctx) {
      refresh(ctx);
      if (!awaitingDecision) return undefined;
      if (nestedWorktreeOf(launch, target)) return undefined;
      const gone = [...tracked.values()].filter(t => t.vanishedAt);
      const names = gone.map(t => `${t.rel}${t.branch ? ` (branch ${t.branch})` : ''}`).join(', ');
      return `The task worktree ${names} that this session was working in was removed outside this session `
        + '(for example merged and deleted by another agent). Do not continue in the main checkout on your own. '
        + 'Tell the user what happened, then ask with pi_safe_ask_user whether to create a new task worktree or to continue in the main checkout.';
    },
    reviewNotices(cwd, files) {
      refresh();
      const notes: string[] = [];
      const targets = new Map<string, number>();
      let instructionEdits: string[] = [];
      for (const raw of files) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const abs = path.resolve(cwd, raw.replace(/^@/, ''));
        const rel = path.relative(launch, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const root = nestedWorktreeOf(launch, abs)?.root ?? launch;
        targets.set(root, (targets.get(root) ?? 0) + 1);
        if (/^(AGENTS|CLAUDE)\.md$/i.test(path.basename(abs))) instructionEdits.push(path.relative(root, abs));
      }
      instructionEdits = [...new Set(instructionEdits)];
      for (const [root, n] of targets) notes.push(`Files go to ${targetLabel(root)} (${n} file${n === 1 ? '' : 's'}).`);
      const gone = [...tracked.values()].filter(t => t.vanishedAt);
      if (gone.length) {
        notes.push(`⚠ The task worktree ${gone.map(t => t.rel).join(', ')} was removed outside this session; this plan continues without it.`);
      }
      const mainCount = targets.get(launch) ?? 0;
      const branch = launchBranch();
      const onMain = !launchGitdir && (branch === 'main' || branch === 'master');
      const live = [...tracked.values()].filter(t => !t.vanishedAt && t.root !== launch);
      if (mainCount && onMain && (live.length || gone.length)) {
        notes.push(`⚠ ${mainCount} file${mainCount === 1 ? ' goes' : 's go'} to the main checkout on ${branch}, not the task worktree.`);
      } else if (mainCount && onMain && mentionsWorktrees(launch)) {
        notes.push(`⚠ ${mainCount} file${mainCount === 1 ? ' goes' : 's go'} to ${branch} directly, but the project instructions describe a worktree per task.`);
      }
      if (instructionEdits.length) notes.push(`⚠ Edits the project instructions: ${instructionEdits.join(', ')}.`);
      return notes;
    },
    workingStateSection() {
      refresh();
      if (!tracked.size) return undefined;
      const lines = [`Launch folder: ${launch} (${launchGitdir ? 'a linked worktree' : 'the main checkout'}, branch ${launchBranch() ?? 'unknown'}).`];
      const nested = [...tracked.values()].filter(t => t.root !== launch);
      if (nested.length) {
        lines.push('Task worktrees this session works in (paths relative to the launch folder):');
        for (const t of nested) {
          lines.push(t.vanishedAt
            ? `- ${t.rel} on ${t.branch ?? 'unknown branch'}: REMOVED outside this session at ${t.vanishedAt.slice(11, 16)} UTC. Do not move its work to the main checkout without the user's decision.`
            : `- ${t.rel} on ${t.branch ?? 'unknown branch'}: present${t.locked ? ', locked for this session' : ''}.`);
        }
        lines.push('Keep the task\'s files inside its worktree. In text meant for other people (emails, reports), do not link to .claude/worktrees/… paths, which disappear after the merge: give the path from the repository root and name the branch.');
      } else {
        lines.push('This session works in its own task worktree; keep the task\'s files here.');
      }
      return lines.join('\n');
    },
    turnWrites() {
      return writes;
    },
    forget(root) {
      tracked.delete(root);
      if (![...tracked.values()].some(t => t.vanishedAt)) awaitingDecision = false;
    },
    resetTurnWrites() {
      writes = new Set();
    },
    recordWrite(target: string) {
      writes.add(target);
    },
    releaseAll() {
      for (const t of tracked.values()) {
        if (t.locked) unlockWorktree(t.gitdir, pid);
        t.locked = false;
      }
    },
  };
  return handle;
}

function mentionsWorktrees(launch: string): boolean {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      if (/\bworktree/i.test(readFileSync(path.join(launch, name), 'utf8').slice(0, 256 * 1024))) return true;
    } catch { /* Absent. */ }
  }
  return false;
}

export function registerWorktreeGuard(pi: ExtensionAPI, options: WorktreeGuardOptions) {
  const guard = createWorktreeGuard(options);
  const prefix = options.toolPrefix ?? 'pi_safe_';
  const writeTools = new Set([`${prefix}write`, `${prefix}edit`]);

  pi.on('session_start', async (_event, ctx) => {
    let id: string | undefined;
    try { id = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.(); } catch { id = undefined; }
    await guard.onSessionStart(id, ctx);
  });
  pi.on('session_shutdown', async () => {
    guard.releaseAll();
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!writeTools.has(event.toolName)) return;
    const raw = (event.input as { path?: unknown }).path;
    if (typeof raw !== 'string' || !raw.trim()) return;
    const target = path.resolve(ctx.cwd, raw.replace(/^@/, ''));
    const reason = guard.checkWrite(target, ctx);
    if (reason) return { block: true, reason };
    guard.noteWriteTarget(target, ctx);
  });
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return;
    if (writeTools.has(event.toolName)) {
      const raw = event.input?.path;
      if (typeof raw === 'string' && raw.trim()) guard.recordWrite(path.resolve(options.launch, raw.replace(/^@/, '')));
      return;
    }
    if (event.toolName === `${prefix}bash`) {
      const command = event.input?.command;
      if (typeof command === 'string') await guard.afterShell(command, ctx);
      return;
    }
    if (event.toolName !== `${prefix}ask_user`) return;
    const text = (event.content ?? []).map(part => (part.type === 'text' ? part.text : '')).join('\n');
    if (/^User responses:/m.test(text)) guard.acknowledgeRemoval();
  });
  pi.on('before_agent_start', async (event, ctx) => {
    guard.resetTurnWrites();
    guard.refresh(ctx);
    if (!event.systemPromptOptions) return;
    const section = guard.workingStateSection();
    if (section) (event.systemPromptOptions.sections ??= {}).working_state = section;
  });
  return guard;
}

