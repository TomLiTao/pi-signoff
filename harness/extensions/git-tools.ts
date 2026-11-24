import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { askApproval, editDecision, type Policy } from './approvals.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const runFile = promisify(execFile);
export const gitToolName = 'pi_safe_git';
export const gitRemoteToolName = 'pi_safe_git_remote';

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Branch, tag or src:dst refspec. No leading '+' (forced update) and no option-looking values.
const REFSPEC = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}^~-]{1,200}(?::[A-Za-z0-9._/-]{0,200})?$/;
const REMOTE_FLAGS: Record<string, readonly string[]> = {
  fetch: ['--prune', '--tags', '--no-tags', '--all'],
  pull: ['--ff-only', '--rebase', '--no-rebase', '--prune', '--tags'],
  push: ['--set-upstream', '-u', '--tags', '--force-with-lease', '--delete', '--dry-run'],
};

/** Validate a fetch/pull/push request and build the git argv (without the hardened prefix). */
export function buildRemoteGitArgs(params: { action?: unknown; remote?: unknown; refspecs?: unknown; flags?: unknown }): string[] {
  const action = params.action;
  if (action !== 'fetch' && action !== 'pull' && action !== 'push') throw new Error('action must be fetch, pull or push');
  const flags = params.flags === undefined ? [] : params.flags;
  const refspecs = params.refspecs === undefined ? [] : params.refspecs;
  if (!Array.isArray(flags) || flags.length > 6 || !flags.every(f => typeof f === 'string' && REMOTE_FLAGS[action].includes(f))) {
    throw new Error(`allowed ${action} flags: ${REMOTE_FLAGS[action].join(', ')}`);
  }
  if (!Array.isArray(refspecs) || refspecs.length > 16 || !refspecs.every(r => typeof r === 'string' && REFSPEC.test(r))) {
    throw new Error('refspecs must be plain branch/tag names or src:dst pairs (no leading +, no options)');
  }
  const remote = params.remote === undefined ? 'origin' : params.remote;
  if (typeof remote !== 'string' || !REMOTE_NAME.test(remote)) throw new Error('remote must be a configured remote name such as origin');
  if (flags.includes('--all') && refspecs.length) throw new Error('--all cannot be combined with refspecs');
  const out = [action, ...flags];
  if (action === 'pull' && !flags.some(f => f === '--rebase' || f === '--no-rebase' || f === '--ff-only')) out.push('--ff-only');
  if (!flags.includes('--all')) out.push(remote);
  out.push(...refspecs);
  return out;
}

/** Host Git for network operations: the user's own global config (credential helper, URL rewrites),
 *  never hooks, no prompts. Repository config is read-only to the sandbox, so it cannot inject commands. */
function remoteHostGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && !k.startsWith('PI_')) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GCM_INTERACTIVE: 'never' };
}
const outputCapBytes = 256 * 1024;

function sanitizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function hardenedHostGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
}

const HOST_GIT_BASE = [
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'color.ui=false',
];

export interface GitToolsOptions {
  dir: string;
  nodeHome: string;
  gitToolEnabled: boolean;
  registerCommitCommand: boolean;
  getPolicy: () => Policy | undefined;
  runRead: <T>(fn: () => Promise<T>) => Promise<T>;
  hasPendingWork?: () => boolean;
  draftCommitMessage?: (diffStat: string, patchExcerpt: string, ctx: ExtensionCommandContext) => Promise<string>;
  execHostGit?: (args: string[], cwd: string, stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Register pi_safe_git_remote (host access mode only). */
  remoteToolEnabled?: boolean;
  /** Returns a reason when remote Git must not run now (plan mode, subagent), else undefined. */
  remoteBlockedReason?: () => string | undefined;
  approve?: (ctx: ExtensionContext, action: string, value: string) => Promise<boolean>;
  runRemote?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ code: number; out: string }>;
}

export function registerGitTools(pi: ExtensionAPI, options: GitToolsOptions) {
  const launch = realpathSync(process.cwd());

  const defaultExecHostGit = (args: string[], cwd: string, stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/git', [...HOST_GIT_BASE, '-C', cwd, ...args], {
        cwd,
        env: hardenedHostGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outLen = 0;
      child.stdout.on('data', (d: Buffer) => {
        if (outLen < 512 * 1024) {
          outChunks.push(d);
          outLen += d.length;
        }
      });
      child.stderr.on('data', (d: Buffer) => errChunks.push(d));
      child.once('error', reject);
      child.once('close', code => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        });
      });
      child.stdin.end(stdin ?? '');
    });

  const execGit = options.execHostGit ?? defaultExecHostGit;

  async function defaultDraftCommitMessage(
    diffStat: string,
    patchExcerpt: string,
    ctx: ExtensionCommandContext,
  ): Promise<string> {
    if (ctx.model) {
      try {
        const prompt = [
          'Draft a concise, conventional Git commit message (imperative subject line <= 72 chars, optional short body) for the following staged changes.',
          'Output ONLY the commit message text, with no markdown fences or commentary.',
          '',
          'Staged diff --stat:',
          diffStat.slice(0, 2000),
          '',
          'Patch excerpt:',
          patchExcerpt.slice(0, 5000),
        ].join('\n');
        const { stdout } = await runFile(
          path.join(options.dir, 'pi'),
          ['--protected-worker', ctx.model.provider, ctx.model.id, 'low', '1', '', prompt],
          { cwd: launch, env: process.env, timeout: 45_000, maxBuffer: 256 * 1024 },
        );
        const cleaned = sanitizeText(stdout).trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
        if (cleaned) return cleaned;
      } catch {
        // Fall through to deterministic stat draft when offline or unauthenticated.
      }
    }
    const firstFile = diffStat.split('\n').map(l => l.trim()).find(l => l.includes('|'))?.split('|')[0]?.trim();
    return firstFile ? `Update ${firstFile}` : 'Update project files';
  }

  const draftMessage = options.draftCommitMessage ?? defaultDraftCommitMessage;

  const defaultRunRemote = (args: string[], cwd: string, signal?: AbortSignal) =>
    new Promise<{ code: number; out: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/git', [
        '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
        '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgSign=false', '-C', cwd, ...args,
      ], { cwd, env: remoteHostGitEnv(), stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 300_000 });
      const chunks: Buffer[] = [];
      let total = 0;
      const onData = (d: Buffer) => { if (total < outputCapBytes) chunks.push(d.subarray(0, outputCapBytes - total)); total += d.length; };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', reject);
      child.once('close', code => resolve({ code: code ?? 1, out: Buffer.concat(chunks).toString('utf8') }));
    });

  if (options.remoteToolEnabled) {
    pi.registerTool({
      name: gitRemoteToolName,
      label: 'Git Fetch/Pull/Push',
      promptSnippet: 'Fetch, pull (fast-forward by default) or push with the user\'s Git credentials, after the user approves each run',
      description: 'Run git fetch, pull or push on the host with the user\'s saved credentials. The user approves every run. Local Git work (commit, branch, merge, worktree) happens in pi_safe_bash; use this tool only for network operations. Forced pushes other than --force-with-lease are not available.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { anyOf: (['fetch', 'pull', 'push'] as const).map(v => ({ type: 'string', const: v })) },
          remote: { type: 'string', minLength: 1, maxLength: 64 },
          refspecs: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 401 }, maxItems: 16 },
          flags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 32 }, maxItems: 6 },
        },
        additionalProperties: false,
      } as unknown as TSchema,
      executionMode: 'sequential',
      async execute(_id, rawParams, signal, _onUpdate, ctx) {
        const blocked = options.remoteBlockedReason?.();
        if (blocked) throw new Error(blocked);
        const args = buildRemoteGitArgs(rawParams as Record<string, unknown>);
        const display = `git ${args.join(' ')}   (in ${ctx.cwd})`;
        const approve = options.approve ?? ((c: ExtensionContext, a: string, v: string) => askApproval(c, a, v));
        if (!(await approve(ctx as ExtensionContext, 'Run Git network command with your credentials', display))) {
          throw new Error('Git network command not approved. Do not retry without the user\'s approval.');
        }
        const res = await (options.runRemote ?? defaultRunRemote)(args, ctx.cwd, signal);
        const text = sanitizeText(res.out).trimEnd() || '(no output)';
        if (res.code !== 0) throw new Error(`git ${args[0]} exited with code ${res.code}:\n${text}`);
        return { content: [{ type: 'text' as const, text }], details: undefined };
      },
    });
  }

  if (options.gitToolEnabled) {
    pi.registerTool({
      name: gitToolName,
      label: 'Read-Only Git Inspect',
      promptSnippet: 'Inspect Git repository state read-only (status, diff, log, show, blame, ls-files)',
      description: (process.env.PI_PROTECTED_ACCESS === 'host'
        ? 'Run a read-only Git inspection command (status, log, diff, show, blame, ls-files) with secret paths excluded. For anything else (commit, branch, merge, worktree, branch listing) use git in pi_safe_bash; for fetch/pull/push use pi_safe_git_remote.'
        : 'Run a read-only Git inspection command (status, log, diff, show, blame, ls-files) inside the sandbox with .git mounted read-only and secret paths excluded.')
        + ' Flags and revisions go in args (combined short flags such as -sb work; pickaxe text is attached, as in -Sneedle); file filters go in paths. To read a file as of a revision, use show with args ["<rev>:<path>"]. A rejected flag error lists the allowed flags.',
      parameters: {
        type: 'object',
        required: ['subcommand'],
        properties: {
          subcommand: {
            anyOf: (['status', 'log', 'diff', 'show', 'blame', 'ls-files'] as const).map(v => ({ type: 'string', const: v })),
          },
          args: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 },
            maxItems: 24,
          },
          paths: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 512 },
            maxItems: 32,
          },
        },
        additionalProperties: false,
      } as unknown as TSchema,
      executionMode: 'parallel',
      async execute(_id, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as { subcommand: string; args?: string[]; paths?: string[] };
        return options.runRead(async () => {
          const payload = JSON.stringify({
            subcommand: params.subcommand,
            args: params.args ?? [],
            paths: params.paths ?? [],
          });
          const res = await new Promise<{ code: number | null; out: string; truncated: boolean }>((resolve, reject) => {
            const env = { ...process.env };
            delete env.PI_SANDBOX_MASKS_FD;
            delete env.PI_PROTECTED_WRITE_ROOT;
            const child = spawn('/usr/bin/python3', ['-I', `${options.dir}/sandbox.py`, '--git', ctx.cwd, options.nodeHome], {
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              signal,
              timeout: 20_000,
            });
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            const onChunk = (data: Buffer) => {
              if (total < outputCapBytes) {
                const slice = data.subarray(0, Math.min(data.length, outputCapBytes - total));
                chunks.push(slice);
              } else {
                truncated = true;
              }
              total += data.length;
              if (total > outputCapBytes) truncated = true;
            };
            child.stdout.on('data', onChunk);
            child.stderr.on('data', onChunk);
            child.stdin.on('error', () => {});
            let spawnErr: Error | undefined;
            child.once('error', err => { spawnErr = err; });
            child.once('close', code => {
              if (spawnErr) reject(spawnErr);
              else resolve({ code, out: Buffer.concat(chunks).toString('utf8'), truncated });
            });
            child.stdin.end(payload);
          });

          const text = sanitizeText(res.out).trimEnd();
          if (res.code !== 0) {
            throw new Error(text || `git ${params.subcommand} exited with code ${res.code}`);
          }
          const finalText = res.truncated ? `${text}\n[Output truncated at 256 KiB]` : (text || '(no output)');
          return { content: [{ type: 'text' as const, text: finalText }], details: undefined };
        });
      },
    });
  }

  if (options.registerCommitCommand) {
    pi.registerCommand('commit', {
      description: 'Review diff --stat, draft & edit a commit message, and run git commit on the host: /commit',
      async handler(_raw, ctx: ExtensionCommandContext) {
        if (!ctx.hasUI) return;
        if (realpathSync(ctx.cwd) !== launch) {
          ctx.ui.notify('Run /commit from the launch folder.', 'warning');
          return;
        }
        if (!ctx.isIdle() || options.hasPendingWork?.()) {
          ctx.ui.notify('Wait for active runs or background jobs to finish before committing.', 'warning');
          return;
        }

        const policy = options.getPolicy();
        if (!policy) {
          ctx.ui.notify('Cannot commit: project path policy is unavailable.', 'warning');
          return;
        }

        const excludeSpecs = policy.secretPaths.flatMap(pat => [`:(exclude,glob)${pat}`, `:(exclude,glob)**/${pat}`]);

        let stagedStat = await execGit(['diff', '--cached', '--stat', '--', '.', ...excludeSpecs], launch);
        if (stagedStat.code !== 0) {
          ctx.ui.notify(`Git error: ${sanitizeText(stagedStat.stderr).trim() || 'not a Git repository'}`, 'warning');
          return;
        }

        if (!stagedStat.stdout.trim()) {
          const statusRes = await execGit(['status', '--short', '--', '.', ...excludeSpecs], launch);
          if (!statusRes.stdout.trim()) {
            ctx.ui.notify('Nothing to commit (working tree clean).', 'info');
            return;
          }
          const stageChoice = await ctx.ui.select(
            `No staged changes yet.\n\n${sanitizeText(statusRes.stdout).trim().slice(0, 1000)}\n\nHow would you like to stage files?`,
            ['Stage tracked modified files', 'Stage all non-protected files', 'Cancel'],
            { timeout: 60_000, signal: ctx.signal },
          );
          if (!stageChoice || stageChoice === 'Cancel' || ctx.signal?.aborted) return;

          const lsArgs = stageChoice === 'Stage tracked modified files'
            ? ['ls-files', '-m', '-d', '-z']
            : ['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z'];
          const candidatesRes = await execGit(lsArgs, launch);
          const candidates = candidatesRes.stdout.split('\0').filter(Boolean);
          const safeFiles = candidates.filter(rel => editDecision(launch, rel, policy) !== 'deny');
          if (safeFiles.length === 0) {
            ctx.ui.notify('No non-protected files eligible to stage.', 'warning');
            return;
          }
          const addRes = await execGit(['add', '--', ...safeFiles], launch);
          if (addRes.code !== 0) {
            ctx.ui.notify(`Failed to stage files: ${sanitizeText(addRes.stderr).trim()}`, 'warning');
            return;
          }
          stagedStat = await execGit(['diff', '--cached', '--stat', '--', '.', ...excludeSpecs], launch);
          if (!stagedStat.stdout.trim()) {
            ctx.ui.notify('Nothing staged to commit.', 'info');
            return;
          }
        }

        // Refuse to commit if any denied/secret path is already staged in the index!
        const stagedNamesRes = await execGit(['diff', '--cached', '--name-only', '-z'], launch);
        const stagedNames = stagedNamesRes.stdout.split('\0').filter(Boolean);
        const forbidden = stagedNames.find(rel => editDecision(launch, rel, policy) === 'deny');
        if (forbidden) {
          ctx.ui.notify(`Refusing to commit: protected/secret path "${sanitizeText(forbidden)}" is staged in index.`, 'warning');
          return;
        }

        const statDisplay = sanitizeText(stagedStat.stdout).trim();
        ctx.ui.notify(`Staged changes:\n${statDisplay}`, 'info');

        const patchRes = await execGit(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.', ...excludeSpecs], launch);
        const draft = await draftMessage(statDisplay, sanitizeText(patchRes.stdout).slice(0, 6000), ctx);
        if (ctx.signal?.aborted) return;

        const edited = await ctx.ui.editor('Commit message (save empty to cancel):', draft);
        const finalMsg = edited?.trim();
        if (!finalMsg || ctx.signal?.aborted) {
          ctx.ui.notify('Commit cancelled.', 'info');
          return;
        }

        const commitRes = await execGit(['-c', 'commit.gpgSign=false', 'commit', '-F', '-'], launch, `${finalMsg}\n`);
        if (commitRes.code !== 0) {
          ctx.ui.notify(`git commit failed: ${sanitizeText(commitRes.stderr || commitRes.stdout).trim()}`, 'warning');
          return;
        }
        ctx.ui.notify(`Committed:\n${sanitizeText(commitRes.stdout).trim()}`, 'info');
      },
    });
  }
}
