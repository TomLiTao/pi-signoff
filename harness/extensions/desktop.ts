import { execFile, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { editDecision, visible, type Policy } from './approvals.ts';

const runFile = promisify(execFile);
const wlCopy = '/usr/bin/wl-copy';
const xdgOpenBin = '/usr/bin/xdg-open';
const libreOfficeBin = '/usr/bin/libreoffice';
const copyLimit = 1024 * 1024;
export const openToolName = 'pi_safe_open';
export type OpenAppChoice = 'default' | 'libreoffice';

const PRIVATE_SEGMENTS = new Set([
  '.git', '.pi', '.codex', '.ssh', '.gnupg', '.aws', '.kube', '.docker',
  '.config', '.local', '.cache', '.password-store', '.netrc', '.git-credentials',
]);

export const SAFE_OPEN_EXTENSIONS = new Set([
  '.pdf', '.pptx', '.ppt', '.odp',
  '.docx', '.doc', '.odt', '.rtf',
  '.xlsx', '.xls', '.ods', '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif',
  '.md', '.txt', '.json', '.html', '.htm', '.epub',
]);

const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
  char => `\\u{${char.codePointAt(0)!.toString(16)}}`);

function boundedFile(root: string, relative: string, limit: number) {
  const file = path.join(root, relative);
  // Reject symlinks in both the leaf and its parents, including source files replaced since install.
  if (realpathSync(file) !== file) throw new Error('Unexpected file link');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Invalid file size or type');
    const data = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < data.length) {
      const n = readSync(fd, data, count, data.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count !== info.size) throw new Error('File changed while reading');
    return data.subarray(0, count);
  } finally { closeSync(fd); }
}

function readManifest(dir: string) {
  const fields = boundedFile(realpathSync(dir), 'install-source', 16 * 1024).toString('utf8').split('\0');
  const [root, id, ...pairs] = fields;
  const validPath = (name: string) => /^[a-zA-Z0-9_.\-/]+$/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
  if (!path.isAbsolute(root ?? '') || !id || pairs.pop() !== '' || !pairs.length || pairs.length % 2 ||
      !pairs.every(validPath)) throw new Error('Invalid install manifest');
  return { root, id, pairs };
}

export function inspectInstallation(dir: string, startupId?: string) {
  try {
    const { root, id, pairs } = readManifest(dir);
    if (startupId && id !== startupId) return 'reinstalled since startup; restart Pi';
    if (realpathSync(root) !== root) return 'source checkout moved or no longer available';
    const installed = realpathSync(dir);
    const differences = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [source, target] = [pairs[i], pairs[i + 1]];
      try {
        if (boundedFile(root, source, copyLimit).equals(boundedFile(installed, target, copyLimit))) continue;
      } catch { /* Missing, untrusted, unreadable, or too large. */ }
      differences.push(target);
    }
    return differences.length ? `out of sync (${differences.length}): ${differences.slice(0, 6).join(', ')}${
      differences.length > 6 ? ', …' : ''}; run bash install.sh --pi-only and restart` : 'matches source checkout';
  } catch {
    return 'could not compare with source; check that the installer and its source checkout are present';
  }
}

/** patch-pi-bundle.py's patches: original anchor, applied marker, and what goes wrong without it. */
const BUNDLE_PATCHES = [
  { name: 'trust-notice', anchor: 'renderProjectTrustWarningIfNeeded(){',
    marker: 'usesProtectedProjectResourcePolicy(){', missing: 'startup shows the misleading trust warning' },
  { name: 'local-links', anchor: 'if(getCapabilities().hyperlinks)result+=hyperlink(styledLink,token.href)+stylePrefix;',
    marker: 'function piLocalLinkTarget(href){', missing: 'relative file links in replies cannot be opened' },
];

/** State of patch-pi-bundle.py's patches in the installed Pi bundle. */
export function inspectBundlePatch(nodeHome = process.env.PI_PROTECTED_NODE_HOME ?? '') {
  try {
    const chunks = path.join(nodeHome, 'lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks');
    const texts = readdirSync(chunks).filter(name => name.endsWith('.js'))
      .map(name => readFileSync(path.join(chunks, name), 'utf8'));
    const problems = BUNDLE_PATCHES.flatMap(patch => {
      const hits = texts.filter(text => text.includes(patch.anchor) || text.includes(patch.marker));
      if (hits.length !== 1) return [`${patch.name} unsupported by this Pi build`];
      return hits[0].includes(patch.marker) ? [] : [`${patch.name} missing (${patch.missing})`];
    });
    if (!problems.length) return 'present';
    const fix = problems.some(p => p.includes('missing')) ? '; run bash install.sh --pi-only' : '';
    return problems.join('; ') + fix;
  } catch {
    return 'could not inspect the Pi bundle';
  }
}

function clipboardIssue() {
  try { accessSync(wlCopy, constants.X_OK); }
  catch { return 'wl-copy is unavailable; install wl-clipboard.'; }
  if (!process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR) {
    return 'No Wayland desktop environment detected. Start Pi in a local Wayland terminal.';
  }
  return undefined;
}

async function writeClipboard(text: string) {
  const issue = clipboardIssue();
  if (issue) throw new Error(issue);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(wlCopy, ['--type', 'text/plain;charset=utf-8'], {
      cwd: '/', env: { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR },
      stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000, killSignal: 'SIGKILL',
    });
    child.stdin.on('error', reject);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? 'wl-copy did not finish.' : 'wl-copy could not reach the Wayland clipboard.'));
    });
    child.stdin.end(text, 'utf8');
  });
}

type Entry = ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];
export function lastAnswer(entries: readonly Entry[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const message = entry.message;
    if (message.stopReason !== 'stop' && message.stopReason !== 'length') continue;
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    if (text.trim()) return text;
  }
  throw new Error('No assistant answer with text on this session branch.');
}

export function codeBlocks(answer: string) {
  const blocks: string[] = [];
  let fence: string | undefined;
  let indent = 0;
  let lines: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        blocks.push(lines.length ? `${lines.join('\n')}\n` : '');
        fence = undefined;
        lines = [];
      } else {
        let strip = 0;
        while (strip < indent && line[strip] === ' ') strip++;
        lines.push(line.slice(strip));
      }
    } else {
      const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && (open[2][0] === '~' || !open[3].includes('`'))) {
        indent = open[1].length;
        fence = open[2];
      }
    }
  }
  return blocks;
}

export function registerCopy(pi: ExtensionAPI, jobOutput?: (id: number, ctx: ExtensionContext) => string,
  copy: (text: string) => Promise<void> = writeClipboard) {
  // Pi already reserves /copy for its built-in message clipboard command.
  pi.registerCommand('clip', {
    description: 'Copy to Wayland: /clip [code [number] | job <id>]',
    async handler(raw, ctx) {
      try {
        if (ctx.mode !== 'tui') throw new Error('Clipboard access requires the interactive Pi terminal.');
        const args = raw.trim();
        const code = /^code(?:\s+([1-9][0-9]*))?$/.exec(args);
        const job = /^job\s+([1-9][0-9]*)$/.exec(args);
        let text: string;
        let label: string;
        if (job && Number.isSafeInteger(Number(job[1]))) {
          if (!jobOutput) throw new Error('Background jobs are unavailable.');
          text = jobOutput(Number(job[1]), ctx);
          label = `job ${job[1]} output`;
        } else if (code) {
          const blocks = codeBlocks(lastAnswer(ctx.sessionManager.getBranch()));
          const index = Number(code[1] ?? '1');
          if (!blocks.length) throw new Error('The last answer has no complete fenced code blocks.');
          if (index > blocks.length) throw new Error(`Choose a code block from 1 to ${blocks.length}.`);
          text = blocks[index - 1];
          label = `code block ${index}`;
        } else if (!args) {
          text = lastAnswer(ctx.sessionManager.getBranch());
          label = 'last answer';
        } else {
          throw new Error('Usage: /clip [code [number] | job <id>]');
        }
        if (!text) throw new Error('There is no text to copy yet.');
        if (Buffer.byteLength(text) > copyLimit) throw new Error('Selection is larger than 1 MiB.');
        await copy(text);
        ctx.ui.notify(`Copied ${label} to the clipboard.`, 'info');
      } catch (error) {
        ctx.ui.notify(`Clip: ${clean((error as Error).message)}`, 'warning');
      }
    },
  });
}

export function desktopDisplayIssue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    return 'No host graphical display (WAYLAND_DISPLAY or DISPLAY) is available in this session.';
  }
  return undefined;
}

export interface ValidatedOpenTarget {
  absPath: string;
  relPosix: string;
  ext: string;
}

export function validateWorkspaceOpenTarget(
  cwd: string,
  rawPath: string,
  policy?: Policy,
): ValidatedOpenTarget {
  if (typeof rawPath !== 'string') throw new Error('A workspace file path is required.');
  const normalized = rawPath.replace(/^@/, '').replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();
  if (!normalized || /[\x00-\x1f\x7f-\x9f]/.test(normalized)) {
    throw new Error('Invalid file path.');
  }
  if (normalized.startsWith('~') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    throw new Error('Only workspace-relative file paths (not URLs or home paths) can be opened.');
  }
  const launchRoot = realpathSync(cwd);
  const candidate = path.resolve(launchRoot, normalized);
  const rel = path.relative(launchRoot, candidate);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error('Only files strictly inside the current workspace can be opened.');
  }
  const relPosix = rel.split(path.sep).join('/');
  const parts = relPosix.split('/');
  if (parts.some(part => PRIVATE_SEGMENTS.has(part))) {
    throw new Error('Protected workspace paths cannot be opened on the host desktop.');
  }
  if (policy && editDecision(launchRoot, relPosix, policy) === 'deny') {
    throw new Error('This file path is protected by policy and cannot be opened.');
  }
  const ext = path.posix.extname(relPosix).toLowerCase();
  if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext || '(no extension)'}" for host desktop open (allowed: documents, slides, spreadsheets, PDFs, images, HTML/Markdown/text).`,
    );
  }

  let current = launchRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`File not found: ${visible(relPosix)}`);
      }
      throw new Error(`Cannot inspect path: ${visible(relPosix)}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error('Symbolic links cannot be opened on the host desktop.');
    }
  }

  const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`Not a regular file: ${visible(relPosix)}`);
    if (info.nlink !== 1) throw new Error('Hardlinked files cannot be opened on the host desktop.');
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    if (
      (n >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) ||
      (n >= 2 && head[0] === 0x23 && head[1] === 0x21)
    ) {
      throw new Error('Executable binaries and script files cannot be opened via desktop viewer.');
    }
  } finally {
    closeSync(fd);
  }

  return { absPath: candidate, relPosix, ext };
}

export async function defaultLaunchHostFile(
  absPath: string,
  app: OpenAppChoice = 'default',
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.PI_PROTECTED_OPEN_DRY_RUN === '1') return;
  const issue = desktopDisplayIssue(env);
  if (issue) throw new Error(issue);
  const bin = app === 'libreoffice' ? libreOfficeBin : xdgOpenBin;
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(`${path.basename(bin)} is unavailable on the host.`);
  }
  const args = app === 'libreoffice'
    ? ['--nologo', '--norestore', '--nolockcheck', '--', absPath]
    : [absPath];
  const childEnv: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
  };
  for (const key of [
    'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
    'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'DESKTOP_SESSION',
  ]) {
    const val = env[key];
    if (val) childEnv[key] = val;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: '/',
      env: childEnv,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 250);
    child.once('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not launch ${path.basename(bin)}: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            signal
              ? `${path.basename(bin)} terminated by signal ${signal}.`
              : `${path.basename(bin)} exited with code ${code}.`,
          ),
        );
      }
    });
  });
}

export interface RegisterOpenOptions {
  getPolicy: () => Policy | undefined;
  launch?: (absPath: string, app: OpenAppChoice) => Promise<void>;
}

export function registerOpen(pi: ExtensionAPI, options: RegisterOpenOptions) {
  const launchRoot = realpathSync(process.cwd());
  const launcher = options.launch ?? defaultLaunchHostFile;

  pi.registerCommand('open', {
    description: 'Open a non-secret workspace document/image on the host desktop: /open [--libreoffice] <path>',
    async handler(raw, ctx) {
      try {
        if (ctx.mode !== 'tui') throw new Error('Opening desktop files requires the interactive Pi terminal.');
        if (realpathSync(ctx.cwd) !== launchRoot) {
          throw new Error('Run /open from the launch folder.');
        }
        let rest = raw.trim();
        let app: OpenAppChoice = 'default';
        if (rest.startsWith('--libreoffice ')) {
          app = 'libreoffice';
          rest = rest.slice('--libreoffice '.length).trim();
        }
        if (!rest) {
          throw new Error('Usage: /open [--libreoffice] <workspace-file>');
        }
        if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
          rest = rest.slice(1, -1);
        }
        const target = validateWorkspaceOpenTarget(launchRoot, rest, options.getPolicy());
        await launcher(target.absPath, app);
        ctx.ui.notify(
          `Opened ${visible(target.relPosix)} on host desktop${app === 'libreoffice' ? ' (LibreOffice)' : ''}.`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`Open: ${clean((error as Error).message)}`, 'warning');
      }
    },
  });
}

interface DoctorOptions {
  dir: string;
  ref?: string;
  writeRoot?: string;
  isPlanning: () => boolean;
  probeSandbox: (cwd: string) => Promise<boolean>;
  inspectCollapsed?: (cwd: string) => Promise<string[]>;
  instructionsStatus?: () => string;
  hooksStatus?: () => string;
  mcpStatus?: () => string;
  autonomyStatus?: () => string;
  droidsStatus?: () => string;
  styleStatus?: () => string;
  webStatus?: () => string;
}

export function registerDoctor(pi: ExtensionAPI, options: DoctorOptions) {
  const launch = realpathSync(process.cwd());
  let startupId: string | undefined;
  try { startupId = readManifest(options.dir).id; } catch { /* Older or incomplete install. */ }
  // Record which install a session ran on, so a log that spans a reinstall can be read correctly,
  // and tell the user once when the harness was reinstalled under a running session.
  let warnedReinstall = false;
  pi.on('session_start', async () => {
    if (!startupId) return;
    try {
      pi.appendEntry('pi-harness-install', { id: startupId, at: new Date().toISOString() });
    } catch { /* No active session file. */ }
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    if (warnedReinstall || !startupId || !ctx.hasUI) return;
    let current: string | undefined;
    try { current = readManifest(options.dir).id; } catch { return; }
    if (current === startupId) return;
    warnedReinstall = true;
    ctx.ui.notify('The Pi harness was reinstalled after this session started. This session still runs the old code; restart Pi to load the new version.', 'warning');
  });
  pi.registerCommand('doctor', {
    description: 'Check the protected Pi installation and current session (local only)',
    async handler(raw, ctx) {
      if (!ctx.hasUI) return;
      if (raw.trim()) { ctx.ui.notify('Usage: /doctor', 'warning'); return; }
      if (realpathSync(ctx.cwd) !== launch) {
        ctx.ui.notify('Doctor: run from the launch folder.', 'warning');
        return;
      }
      const [sandbox, checkpoint, collapsed] = await Promise.all([
        options.probeSandbox(launch).catch(() => false),
        options.ref ? runFile('/usr/bin/python3', ['-IB', path.join(options.dir, 'protected-checkpoint.py'),
          'verify', launch, options.ref], { cwd: launch, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 })
          .then(() => 'present', () => 'missing or invalid') : 'not created at launch',
        options.inspectCollapsed ? options.inspectCollapsed(launch).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const linkState = (name: string) => {
        try {
          return realpathSync(path.join(homedir(), '.local/bin', name)) === path.join(realpathSync(options.dir), 'pi')
            ? 'linked' : 'points elsewhere';
        } catch {
          return 'not linked';
        }
      };
      // pi-signoff is always linked; `pi` only when the user opted in.
      const launcher = `${linkState('pi-signoff')}; ~/.local/bin/pi: ${linkState('pi')}`;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'none selected';
      const tools = pi.getActiveTools().map(clean);
      const mode = options.isPlanning() ? 'read-only (plan)' : options.writeRoot === launch
        ? 'writable (startup checkpoint gate)' : 'read-only (no launch checkpoint)';
      ctx.ui.notify([
        'Protected Pi diagnostics (no provider request)',
        `Install: ${inspectInstallation(options.dir, startupId)}`, `Pi bundle patch: ${inspectBundlePatch()}`, `~/.local/bin/pi-signoff: ${launcher}`,
        `Sandbox: ${sandbox ? 'read-only probe passed' : 'read-only probe failed (check Bubblewrap and workspace mounts)'}`,
        ...(collapsed !== undefined ? [`Collapsed mask dirs: ${collapsed.length
          ? `${collapsed.map(clean).join(', ')} (masked as empty; use UV_LINK_MODE=copy or pnpm --package-import-method=copy)`
          : 'none'}`] : []),
        `Checkpoint: ${checkpoint}`, `Workspace policy: ${mode}`,
        ...(options.instructionsStatus ? [`Instructions: ${clean(options.instructionsStatus())}`] : []),
        ...(options.autonomyStatus ? [`Autonomy: ${clean(options.autonomyStatus())}`] : []),
        ...(options.droidsStatus ? [`Droids: ${clean(options.droidsStatus())}`] : []),
        ...(options.styleStatus ? [`Style / notify: ${clean(options.styleStatus())}`] : []),
        ...(options.webStatus ? [`Web: ${clean(options.webStatus())}`] : []),
        ...(options.hooksStatus ? [`Hooks: ${clean(options.hooksStatus())}`] : []),
        ...(options.mcpStatus ? [`MCP: ${clean(options.mcpStatus())}`] : []),
        `Model: ${clean(model)} (thinking: ${clean(ctx.thinkingLevel ?? 'unknown')})`,
        `Active model tools: ${tools.length ? tools.join(', ') : 'none'}`,
        `Clipboard: ${clipboardIssue() ?? 'Wayland environment detected (not tested)'}`,
      ].join('\n'), !sandbox || checkpoint === 'missing or invalid' ? 'warning' : 'info');
    },
  });
}
