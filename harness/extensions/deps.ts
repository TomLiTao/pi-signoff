// /deps: user-run dependency installs. Sandboxed tools have no network, so the agent asks the user
// to run `/deps add <pkg>`. The package manager runs in its own Bubblewrap sandbox: network on, the
// project and package caches writable, the rest of the home folder hidden (only the uv / Node /
// Python runtimes are mounted read-only), project secrets masked, .git read-only. Source builds
// (uv) and install scripts (npm) are off unless the user passes --allow-build / --scripts.
// A checkpoint is taken first; the changed files are reported to the user and the agent.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TurnChangeSummary } from './checkpoints.ts';

export interface DepsPlan {
  manager: 'uv-project' | 'uv-venv' | 'npm';
  argv: string[];
  summary: string;
  notes: string[];
}

export interface DepsFlags { dev: boolean; build: boolean; npm: boolean; python: boolean }

const PKG = /^(?!-)[A-Za-z0-9@][A-Za-z0-9._\-[\],<>=!~^@/:+*]{0,199}$/;

export function parseDepsArgs(raw: string): { action: string; pkgs: string[]; flags: DepsFlags } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const flags: DepsFlags = { dev: false, build: false, npm: false, python: false };
  const rest: string[] = [];
  for (const tok of tokens) {
    if (tok === '--dev' || tok === '-D') flags.dev = true;
    else if (tok === '--allow-build' || tok === '--scripts') flags.build = true;
    else if (tok === '--npm') flags.npm = true;
    else if (tok === '--python') flags.python = true;
    else if (tok.startsWith('-')) throw new Error(`Unknown option ${tok}. Options: --dev, --allow-build (uv) / --scripts (npm), --npm, --python.`);
    else rest.push(tok);
  }
  const [action = 'status', ...pkgs] = rest;
  for (const pkg of pkgs) {
    if (!PKG.test(pkg)) throw new Error(`"${pkg}" does not look like a package name or requirement.`);
  }
  return { action, pkgs, flags };
}

export function detectDepsPlan(root: string, action: string, pkgs: string[], flags: DepsFlags): DepsPlan {
  const has = (f: string) => existsSync(path.join(root, f));
  const python = has('pyproject.toml') || has('requirements.txt') || has('uv.lock') || has('.venv/bin/python') || has('venv/bin/python');
  const node = has('package.json');
  if (!['add', 'remove', 'sync', 'venv'].includes(action)) throw new Error('Usage: /deps [add <pkg...> | remove <pkg...> | sync | venv] [--dev] [--allow-build|--scripts] [--npm|--python]');
  if ((action === 'add' || action === 'remove') && !pkgs.length) throw new Error(`Name the package(s): /deps ${action} <pkg...>`);
  const useNpm = flags.npm || (node && !python && !flags.python);
  if (useNpm) {
    if (!node) throw new Error('No package.json here.');
    const scripts = flags.build ? [] : ['--ignore-scripts'];
    const argv = action === 'add' ? ['npm', 'install', ...(flags.dev ? ['--save-dev'] : []), ...scripts, ...pkgs]
      : action === 'remove' ? ['npm', 'uninstall', ...pkgs]
        : action === 'sync' ? (has('package-lock.json') ? ['npm', 'ci', ...scripts] : ['npm', 'install', ...scripts])
          : (() => { throw new Error('/deps venv is for Python projects.'); })();
    return { manager: 'npm', argv, summary: 'npm (package.json)', notes: flags.build ? ['Install scripts are allowed (--scripts).'] : ['Install scripts are skipped (--ignore-scripts); pass --scripts if a package needs them.'] };
  }
  if (!python && action !== 'venv') throw new Error('No pyproject.toml, requirements.txt, .venv, or package.json here.');
  const noBuild = flags.build ? [] : ['--no-build'];
  const buildNote = flags.build ? 'Source builds are allowed (--allow-build).' : 'Only prebuilt wheels are installed (--no-build); pass --allow-build if a package has no wheel.';
  if (action === 'venv') return { manager: 'uv-venv', argv: ['uv', 'venv', '.venv'], summary: 'uv (create .venv)', notes: [] };
  if (has('uv.lock')) {
    const argv = action === 'add' ? ['uv', 'add', ...(flags.dev ? ['--dev'] : []), ...noBuild, ...pkgs]
      : action === 'remove' ? ['uv', 'remove', ...(flags.dev ? ['--dev'] : []), ...pkgs]
        : ['uv', 'sync', ...noBuild];
    return { manager: 'uv-project', argv, summary: 'uv project (uv.lock)', notes: [buildNote] };
  }
  const venvPython = has('.venv/bin/python') ? '.venv/bin/python' : has('venv/bin/python') ? 'venv/bin/python' : null;
  if (!venvPython) throw new Error('No uv.lock and no virtual environment: run /deps venv first (creates .venv with uv).');
  const notes = [buildNote];
  let argv: string[];
  if (action === 'add') {
    argv = ['uv', 'pip', 'install', '--python', venvPython, ...noBuild, ...pkgs];
    notes.push(`Installed into ${venvPython.split('/')[0]} only; pyproject.toml / requirements files are not changed, so add the package there if it should stay.`);
  } else if (action === 'remove') {
    argv = ['uv', 'pip', 'uninstall', '--python', venvPython, ...pkgs];
  } else if (has('requirements.txt')) {
    argv = ['uv', 'pip', 'install', '--python', venvPython, ...noBuild, '-r', 'requirements.txt'];
  } else if (has('pyproject.toml')) {
    argv = ['uv', 'pip', 'install', '--python', venvPython, ...noBuild, '-r', 'pyproject.toml'];
    notes.push('Installs the dependencies listed in pyproject.toml (not the project itself).');
  } else {
    throw new Error('Nothing to sync: no requirements.txt or pyproject.toml.');
  }
  return { manager: 'uv-venv', argv, summary: `uv pip into ${venvPython.split('/')[0]}`, notes };
}

/** Secret files to mask inside the install sandbox (bounded walk, skipping large/managed dirs). */
export function findSecretFiles(root: string, patterns: readonly string[], limit = 500): string[] {
  const skip = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.ruff_cache', '.pytest_cache', 'dist', 'build']);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!skip.has(entry.name)) walk(full, depth + 1);
      } else if (patterns.some(p => path.matchesGlob(entry.name, p))) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

export interface SandboxSpec {
  root: string;
  home: string;
  nodeHome: string;
  uvPath?: string;
  emptySecret: string;
  secretFiles: string[];
}

export function depsSandboxArgs(spec: SandboxSpec): string[] {
  const { root, home } = spec;
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve', '--tmpfs', home];
  const ro = [spec.nodeHome, path.join(home, '.local/share/uv/python'), path.join(home, '.local/share/python-runtimes'), path.join(home, '.pyenv/versions')];
  if (spec.uvPath) ro.push(spec.uvPath);
  for (const p of ro) args.push('--ro-bind-try', p, p);
  for (const cache of ['.cache/uv', '.cache/pip', '.npm']) {
    const p = path.join(home, cache);
    args.push('--bind-try', p, p);
  }
  args.push('--bind', root, root);
  for (const git of ['.git']) {
    const p = path.join(root, git);
    if (existsSync(p)) args.push('--ro-bind', p, p);
  }
  for (const file of spec.secretFiles) args.push('--ro-bind', spec.emptySecret, file);
  const pathVar = [path.join(spec.nodeHome, 'bin'), ...(spec.uvPath ? [path.dirname(spec.uvPath)] : []), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  args.push('--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'HOME', home, '--setenv', 'PATH', pathVar, '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'UV_CACHE_DIR', path.join(home, '.cache/uv'), '--setenv', 'UV_LINK_MODE', 'copy', '--setenv', 'UV_NO_CONFIG', '1',
    '--setenv', 'npm_config_cache', path.join(home, '.npm'), '--setenv', 'npm_config_update_notifier', 'false',
    '--setenv', 'npm_config_fund', 'false', '--setenv', 'npm_config_audit', 'false', '--chdir', root);
  return args;
}

function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      if (lstatSync(candidate)) return realpathSync(candidate);
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

export interface DepsOptions {
  dir: string;
  nodeHome: string;
  getSecretPatterns: () => readonly string[];
  isWritable: (cwd: string) => boolean;
  isBusy: () => boolean;
  /** Take a checkpoint and return its ref (undefined if it failed). */
  checkpoint: (ctx: ExtensionCommandContext) => Promise<string | undefined>;
  changesSince: (ref: string) => Promise<TurnChangeSummary | undefined>;
  runner?: (argv: string[], bwrapArgs: string[], signal?: AbortSignal) => Promise<{ code: number | null; output: string }>;
}

async function defaultRunner(argv: string[], bwrapArgs: string[], signal?: AbortSignal) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn('/usr/bin/bwrap', [...bwrapArgs, '--', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 15 * 60_000 });
    let output = '';
    const add = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-200_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

export function registerDeps(pi: ExtensionAPI, options: DepsOptions) {
  const launch = realpathSync(process.cwd());
  const runner = options.runner ?? defaultRunner;

  pi.on('before_agent_start', async event => {
    if (!event.systemPromptOptions) return;
    const sections = (event.systemPromptOptions.sections ??= {});
    sections.dependency_installs = 'Shell commands have no network, so pip/uv/npm installs fail inside tools. When a package is missing, ask the user to run `/deps add <package>` (installs into this project from a network sandbox; `--dev` for dev dependencies), or `/deps sync` to install what the project already declares. Do not try to work around the missing network.';
  });

  pi.registerCommand('deps', {
    description: 'Install project dependencies with network, in a sandbox: /deps [add <pkg...> | remove <pkg...> | sync | venv] [--dev] [--allow-build|--scripts] [--npm|--python]',
    async handler(raw, ctx) {
      try {
        if (realpathSync(ctx.cwd) !== launch) throw new Error('Run /deps from the launch folder.');
        const { action, pkgs, flags } = parseDepsArgs(raw);
        if (action === 'status') {
          let detected = 'nothing detected';
          try { detected = detectDepsPlan(launch, 'sync', [], flags).summary; } catch (error) { detected = (error as Error).message; }
          ctx.ui.notify(`Dependencies: ${detected}.\nUsage: /deps add <pkg...> | remove <pkg...> | sync | venv  [--dev] [--allow-build|--scripts] [--npm|--python]\nRuns with network in a sandbox that can write only this project and package caches.`, 'info');
          return;
        }
        if (!options.isWritable(ctx.cwd)) throw new Error('This workspace is read-only (no launch checkpoint).');
        if (!ctx.isIdle() || options.isBusy()) throw new Error('Wait for the current run or background jobs to finish.');
        const plan = detectDepsPlan(launch, action, pkgs, flags);
        const uvPath = plan.argv[0] === 'uv' ? which('uv') : undefined;
        if (plan.argv[0] === 'uv' && !uvPath) throw new Error('uv is not installed (https://docs.astral.sh/uv/).');
        const home = realpathSync(os.homedir());
        for (const cache of ['.cache/uv', '.npm']) mkdirSync(path.join(home, cache), { recursive: true, mode: 0o700 });
        const secretFiles = findSecretFiles(launch, options.getSecretPatterns());
        const bwrapArgs = depsSandboxArgs({ root: launch, home, nodeHome: options.nodeHome, uvPath, emptySecret: path.join(options.dir, 'empty-secret'), secretFiles });
        const shown = plan.argv.join(' ');
        const choice = await ctx.ui.select(
          `Run with network access in ${launch}?\n  ${shown}\n${plan.summary} · writes this project and package caches only · home folder hidden · ${secretFiles.length} secret file(s) masked · .git read-only\n${plan.notes.join('\n')}`,
          ['Cancel', `Run ${plan.argv.slice(0, 3).join(' ')}…`],
          { timeout: 120_000, signal: ctx.signal },
        );
        if (!choice || choice === 'Cancel' || ctx.signal?.aborted) return;
        const ref = await options.checkpoint(ctx);
        if (!ref) throw new Error('Could not create a checkpoint first; nothing was installed.');
        ctx.ui.notify(`Running ${shown} …`, 'info');
        const started = Date.now();
        const { code, output } = await runner(plan.argv, bwrapArgs, ctx.signal);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const changes = await options.changesSince(ref);
        const changed = changes?.files.map(f => f.path).filter(p => !/^(?:\.venv|venv|node_modules)\//.test(p)) ?? [];
        const envChanged = changes?.files.some(f => /^(?:\.venv|venv|node_modules)\//.test(f.path)) ?? false;
        const tail = output.trimEnd().split('\n').slice(-25).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        const status = code === 0 ? `finished in ${seconds}s` : `failed (exit ${code ?? 'signal'}) after ${seconds}s`;
        const files = changed.length ? `Changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? `, … (+${changed.length - 10})` : ''}` : 'No tracked project files changed';
        ctx.ui.notify(`/deps ${status}. ${files}${envChanged ? ' (+ environment files)' : ''}. Undo with /rewind.\n${tail}`, code === 0 ? 'info' : 'warning');
        try {
          pi.sendMessage({
            customType: 'pi-deps',
            content: `The user ran \`${shown}\` (${plan.summary}); it ${status}. ${files}.${plan.notes.length ? ` ${plan.notes.join(' ')}` : ''}\nOutput tail (untrusted):\n${tail.slice(-2000)}`,
            display: false,
          }, { deliverAs: 'nextTurn' });
        } catch {
          // Outside an active session the user still sees the notice.
        }
      } catch (error) {
        ctx.ui.notify(`/deps: ${(error as Error).message}`, 'warning');
      }
    },
  });
}
