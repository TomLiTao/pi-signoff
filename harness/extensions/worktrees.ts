// /worktree new|list|done: the project's task-worktree workflow (AGENTS.md "Local checkout layout")
// as user commands. Git runs on the host with the user's own config (identity, credentials for fetch)
// but never hooks. Nothing is pushed.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

export const WORKTREE_BRANCH_PREFIX = 'pi/';
const TASK = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WorktreeOptions {
  git?: GitRunner;
  /** Detached runs still running with a working folder inside dir. */
  liveRunsUnder?: (dir: string) => string[];
  onChange?: () => void;
}

const hostGit: GitRunner = (args, cwd) => new Promise(resolve => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('PI_')) env[k] = v;
  execFile('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'color.ui=false', '-c', 'protocol.ext.allow=never', '-C', cwd, ...args],
  { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  (error, stdout, stderr) => resolve({
    code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0,
    stdout: String(stdout), stderr: String(stderr),
  }));
});

export function registerWorktreeCommands(pi: ExtensionAPI, options: WorktreeOptions = {}) {
  const git = options.git ?? hostGit;

  async function must(args: string[], cwd: string): Promise<string> {
    const res = await git(args, cwd);
    if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim().slice(0, 600)}`);
    return res.stdout.trim();
  }

  /** The main checkout's top folder; refuses linked worktrees so tasks are never nested. */
  async function mainTop(cwd: string): Promise<string> {
    const top = await must(['rev-parse', '--show-toplevel'], cwd);
    const gitDir = path.resolve(top, await must(['rev-parse', '--git-dir'], top));
    const common = path.resolve(top, await must(['rev-parse', '--git-common-dir'], top));
    if (realpathSync(gitDir) !== realpathSync(common)) throw new Error('Run /worktree from the main checkout, not from inside a task worktree.');
    return top;
  }

  async function create(task: string, ctx: ExtensionCommandContext) {
    const top = await mainTop(ctx.cwd);
    const dir = path.join(top, '.claude', 'worktrees', task);
    const branch = `${WORKTREE_BRANCH_PREFIX}${task}`;
    if (existsSync(dir)) throw new Error(`${path.relative(top, dir)} already exists.`);
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top)).code === 0) throw new Error(`Branch ${branch} already exists.`);
    const hasOrigin = (await git(['remote', 'get-url', 'origin'], top)).code === 0;
    const choices = [...(hasOrigin ? ['Fetch origin, start from origin/main'] : []), 'Start from local main', 'Cancel'];
    const choice = await ctx.ui.select(`Create ${path.relative(top, dir)} on ${branch}?`, choices, { signal: ctx.signal });
    if (!choice || choice === 'Cancel') return;
    let base = 'main';
    if (choice.startsWith('Fetch')) {
      await must(['fetch', 'origin', 'main'], top);
      base = 'origin/main';
    }
    await must(['worktree', 'add', '--no-track', '-b', branch, dir, base], top);
    options.onChange?.();
    ctx.ui.notify(`Created ${path.relative(top, dir)} on ${branch} from ${base}.\nStart Pi there with:  cd ${path.relative(ctx.cwd, dir) || '.'} && pi`, 'info');
  }

  async function finish(task: string, ctx: ExtensionCommandContext) {
    const top = await mainTop(ctx.cwd);
    const dir = path.join(top, '.claude', 'worktrees', task);
    const branch = `${WORKTREE_BRANCH_PREFIX}${task}`;
    if (!existsSync(dir)) throw new Error(`${path.relative(top, dir)} does not exist.`);
    const current = await must(['symbolic-ref', '--short', 'HEAD'], top);
    if (current !== 'main') throw new Error(`The main checkout is on ${current}; switch it to main first.`);
    if (await must(['status', '--porcelain', '--untracked-files=no'], top)) throw new Error('The main checkout has uncommitted changes to tracked files; commit or set them aside first.');
    const dirty = await must(['status', '--porcelain', '--untracked-files=all'], dir);
    if (dirty) throw new Error(`The worktree has uncommitted or untracked files; commit or remove them first:\n${dirty.split('\n').slice(0, 12).join('\n')}`);
    const live = options.liveRunsUnder?.(realpathSync(dir)) ?? [];
    if (live.length) throw new Error(`Detached runs are still using this worktree: ${live.join(', ')}. Wait for them or cancel them first.`);
    const log = await must(['log', '--oneline', `main..${branch}`], top);
    const stat = log ? await must(['diff', '--stat', `main...${branch}`], top) : '';
    const prompt = log
      ? `Merge ${branch} into main (${log.split('\n').length} commit(s)), then remove the worktree and branch?\n\n${log.split('\n').slice(0, 15).join('\n')}\n\n${stat.split('\n').slice(-1)[0] ?? ''}`
      : `${branch} has no commits beyond main. Remove the worktree and branch?`;
    const choice = await ctx.ui.select(prompt, [log ? 'Merge and remove' : 'Remove', 'Cancel'], { signal: ctx.signal });
    if (!choice || choice === 'Cancel') return;
    if (log) {
      const merge = await git(['merge', '--no-ff', '-m', `Merge ${branch}`, branch], top);
      if (merge.code !== 0) {
        await git(['merge', '--abort'], top);
        throw new Error(`Merge stopped (conflict or error); main is unchanged.\n${(merge.stderr || merge.stdout).trim().slice(0, 600)}`);
      }
    }
    await must(['worktree', 'remove', dir], top);
    await must(['branch', '-d', branch], top);
    options.onChange?.();
    ctx.ui.notify(`${log ? `Merged ${branch} into main; ` : ''}removed ${path.relative(top, dir)} and branch ${branch}. Nothing was pushed.`, 'info');
  }

  pi.registerCommand('worktree', {
    description: 'Task worktrees under .claude/worktrees/<task> on pi/<task>: /worktree new <task> | list | done <task>',
    async handler(raw, ctx: ExtensionCommandContext) {
      const [sub, task, ...rest] = (raw ?? '').trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === 'list' || !sub) {
          const top = await must(['rev-parse', '--show-toplevel'], ctx.cwd);
          ctx.ui.notify(await must(['worktree', 'list'], top), 'info');
          return;
        }
        if ((sub !== 'new' && sub !== 'done') || !task || rest.length || !TASK.test(task)) {
          ctx.ui.notify('Usage: /worktree new <task> | list | done <task>   (task: lowercase letters, digits, . _ -)', 'warning');
          return;
        }
        if (!ctx.hasUI) return;
        await (sub === 'new' ? create(task, ctx) : finish(task, ctx));
      } catch (error) {
        ctx.ui.notify((error as Error).message, 'warning');
      }
    },
  });
}
