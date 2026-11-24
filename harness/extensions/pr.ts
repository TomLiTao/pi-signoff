// /pr: user-run pull request flow on the host. Uses the user's own git and gh (gh must be signed
// in): optional branch creation off the default branch, a drafted title/description (current model
// via a read-only protected worker, from commits, diff, plan, and recent script runs), an editor to
// change it, the outgoing-secret check, then push and `gh pr create` after explicit confirmation.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

export interface ExecResult { code: number | null; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], cwd: string, stdin?: string, timeoutMs?: number) => Promise<ExecResult>;

export const defaultExec: Exec = (cmd, args, cwd, stdin, timeoutMs = 120_000) => new Promise(resolve => {
  const child = spawn(cmd, args, {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  child.stdin.on('error', () => {});
  child.once('error', error => resolve({ code: 127, stdout, stderr: String(error.message) }));
  child.once('close', code => resolve({ code, stdout, stderr }));
  child.stdin.end(stdin ?? '');
});

const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export function suggestBranch(subject: string, now = new Date()): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `pi/${slug || now.toISOString().slice(0, 10)}`;
}

/** Split an edited draft into title (first non-empty line, # stripped) and body. */
export function parseDraft(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex(line => line.trim());
  if (first === -1) return { title: '', body: '' };
  const title = lines[first].replace(/^#+\s*/, '').replace(/^title:\s*/i, '').trim().slice(0, 200);
  const body = lines.slice(first + 1).join('\n').trim();
  return { title, body };
}

export function draftPrompt(info: { commits: string; stat: string; patch: string; plan?: string; runs?: string }): string {
  return [
    'Write a GitHub pull request title and description for these changes.',
    'Output format: the title on the first line (imperative, <= 72 characters, no prefix), a blank line, then a Markdown body with',
    'sections "## Summary" (2-4 bullets: what and why), "## Changes" (key files or areas), and "## Testing" (what was run and the',
    'result, from the script runs below if any; otherwise say what should be checked). No code fences around the whole output.',
    '',
    'Commits:', info.commits.slice(0, 3000), '',
    'Diff stat:', info.stat.slice(0, 2000), '',
    ...(info.plan ? ['Plan:', info.plan.slice(0, 1500), ''] : []),
    ...(info.runs ? ['Recent script runs:', info.runs.slice(0, 1500), ''] : []),
    'Patch excerpt:', info.patch.slice(0, 6000),
  ].join('\n');
}

export interface PrOptions {
  dir: string;
  getSecretPatterns: () => readonly string[];
  isBusy: () => boolean;
  egressCheck?: (text: string) => string | null;
  getContext?: () => { plan?: string; runs?: string };
  exec?: Exec;
  gitBin?: string;
  ghBin?: string;
  draft?: (prompt: string, ctx: ExtensionCommandContext) => Promise<string>;
}

export function registerPr(pi: ExtensionAPI, options: PrOptions) {
  const launch = realpathSync(process.cwd());
  const exec = options.exec ?? defaultExec;
  const git = (args: string[], stdin?: string, timeout?: number) => exec(options.gitBin ?? '/usr/bin/git', args, launch, stdin, timeout);
  const gh = (args: string[], stdin?: string, timeout?: number) => exec(options.ghBin ?? '/usr/bin/gh', args, launch, stdin, timeout);

  async function defaultDraft(prompt: string, ctx: ExtensionCommandContext): Promise<string> {
    if (!ctx.model) return '';
    const res = await exec(path.join(options.dir, 'pi'), ['--protected-worker', ctx.model.provider, ctx.model.id, 'low', '1', '', prompt], launch, undefined, 90_000);
    return res.code === 0 ? clean(res.stdout).trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim() : '';
  }

  pi.registerCommand('pr', {
    description: 'Open a GitHub pull request: optional branch, drafted title/description you edit, push and gh pr create after confirmation: /pr [--draft]',
    async handler(raw, ctx) {
      const fail = (message: string) => ctx.ui.notify(`/pr: ${message}`, 'warning');
      if (!ctx.hasUI) return;
      if (realpathSync(ctx.cwd) !== launch) return fail('run it from the launch folder.');
      if (!ctx.isIdle() || options.isBusy()) return fail('wait for the current run or background jobs to finish.');
      const asDraft = raw.trim() === '--draft';

      if ((await git(['rev-parse', '--show-toplevel'])).code !== 0) return fail('this folder is not a Git repository.');
      const auth = await gh(['auth', 'status'], undefined, 20_000);
      if (auth.code !== 0) return fail('GitHub CLI is not signed in. Run `! gh auth login` first.');
      const remote = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
      if (!/github\.com[:/]/.test(remote)) return fail(`origin is not a GitHub remote (${clean(remote) || 'none'}).`);

      let base = (await gh(['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], undefined, 30_000)).stdout.trim();
      if (!base) base = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim().replace(/^origin\//, '') || 'main';
      let branch = (await git(['branch', '--show-current'])).stdout.trim();

      if (!branch || branch === base) {
        const subject = (await git(['log', '-1', '--format=%s'])).stdout.trim();
        const name = (await ctx.ui.input(`You are on ${branch || 'a detached HEAD'}. Name a new branch for this pull request (empty to cancel):`, suggestBranch(subject)))?.trim();
        if (!name) return;
        if ((await git(['check-ref-format', '--branch', name])).code !== 0) return fail(`"${clean(name)}" is not a valid branch name.`);
        const created = await git(['switch', '-c', name]);
        if (created.code !== 0) return fail(clean(created.stderr).trim() || 'could not create the branch.');
        branch = name;
        ctx.ui.notify(`Created and switched to ${branch}. Existing commits also stay on ${base} locally.`, 'info');
      }

      const excludes = options.getSecretPatterns().flatMap(p => [`:(exclude,glob)${p}`, `:(exclude,glob)**/${p}`]);
      const dirty = (await git(['status', '--porcelain', '--', '.', ...excludes])).stdout.trim();
      if (dirty) {
        const go = await ctx.ui.select(`Uncommitted changes will not be in the pull request:\n${clean(dirty).split('\n').slice(0, 12).join('\n')}\n\nRun /commit first to include them.`,
          ['Cancel', 'Continue without them'], { timeout: 120_000, signal: ctx.signal });
        if (go !== 'Continue without them') return;
      }

      await git(['fetch', '--quiet', 'origin', base], undefined, 60_000);
      const baseRef = (await git(['rev-parse', '--verify', '--quiet', `origin/${base}`])).code === 0 ? `origin/${base}` : base;
      const commits = clean((await git(['log', '--no-decorate', '--format=- %s', `${baseRef}..HEAD`])).stdout).trim();
      if (!commits) return fail(`no commits on ${branch} beyond ${baseRef}. Commit your changes (/commit) first.`);
      const stat = clean((await git(['diff', '--stat', `${baseRef}...HEAD`, '--', '.', ...excludes])).stdout).trim();
      const patch = clean((await git(['diff', '--no-ext-diff', '--no-textconv', `${baseRef}...HEAD`, '--', '.', ...excludes])).stdout);

      ctx.ui.notify('Drafting the pull request description…', 'info');
      const context = options.getContext?.() ?? {};
      let draft = '';
      try {
        draft = await (options.draft ?? defaultDraft)(draftPrompt({ commits, stat, patch, ...context }), ctx);
      } catch {
        draft = '';
      }
      if (!parseDraft(draft).title) {
        const subjects = commits.split('\n');
        draft = `${subjects[0].replace(/^- /, '')}\n\n## Summary\n${commits}\n\n## Changes\n\`\`\`\n${stat}\n\`\`\``;
      }
      const edited = await ctx.ui.editor('Pull request: title on the first line, description below (save empty to cancel)', draft);
      const { title, body } = parseDraft(edited ?? '');
      if (!title || ctx.signal?.aborted) {
        ctx.ui.notify('Pull request cancelled.', 'info');
        return;
      }
      const leak = options.egressCheck?.(`${title}\n${body}`);
      if (leak) return fail(`the title or description ${leak}. Edit it out and run /pr again; nothing was pushed.`);

      const pushLabel = `Push ${branch} and open ${asDraft ? 'a draft ' : ''}PR into ${base}`;
      const choices = ['Cancel', pushLabel, ...(asDraft ? [] : [`Push ${branch} and open as a draft`])];
      const commitCount = commits.split('\n').length;
      const confirm = await ctx.ui.select(`${title}\n\n${commitCount} commit${commitCount === 1 ? '' : 's'} · ${stat.split('\n').pop() ?? ''}\nRemote: ${clean(remote)}`, choices,
        { timeout: 300_000, signal: ctx.signal });
      if (!confirm || confirm === 'Cancel') return;
      const draftPr = asDraft || confirm.endsWith('as a draft');

      const push = await git(['push', '-u', 'origin', branch], undefined, 180_000);
      if (push.code !== 0) return fail(`git push failed: ${clean(push.stderr).trim().slice(0, 800)}`);
      const created = await gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-', ...(draftPr ? ['--draft'] : [])], body, 120_000);
      if (created.code !== 0) return fail(`gh pr create failed: ${clean(created.stderr).trim().slice(0, 800)}`);
      const url = clean(created.stdout).trim().split('\n').pop() ?? '';
      ctx.ui.notify(`Opened ${draftPr ? 'draft ' : ''}pull request: ${url}`, 'info');
      try {
        pi.sendMessage({ customType: 'pi-pr', content: `The user opened ${draftPr ? 'a draft ' : 'a '}pull request "${title}" from ${branch} into ${base}: ${url}`, display: false }, { deliverAs: 'nextTurn' });
      } catch {
        // The user saw the URL.
      }
    },
  });
}
