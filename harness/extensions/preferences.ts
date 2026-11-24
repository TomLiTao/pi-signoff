import { randomUUID } from 'node:crypto';
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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visible } from './approvals.ts';

export type NotifyMode = 'off' | 'prompts' | 'all';

export interface OutputStyleDefinition {
  name: string;
  description: string;
  instructions: string;
  source: 'builtin' | 'user';
}

const VALID_STYLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const MAX_STYLE_BYTES = 16 * 1024;
const MAX_PREFS_BYTES = 32 * 1024;

export const BUILTIN_STYLES: readonly OutputStyleDefinition[] = [
  {
    name: 'default',
    description: 'Standard balanced software engineering communication (no extra prompt overhead).',
    instructions: '',
    source: 'builtin',
  },
  {
    name: 'concise',
    description: 'Lead with the outcome; short direct paragraphs; preserve exact technical evidence.',
    instructions:
      'Output Style (concise): Lead with the answer, outcome, or intended action. Keep sentences short and each paragraph focused on one point. Omit filler, recaps, and unsolicited commentary while preserving exact file paths, technical reasoning, and verification evidence.',
    source: 'builtin',
  },
  {
    name: 'explanatory',
    description: 'Explain architectural context, trade-offs, and codebase connections alongside work.',
    instructions:
      'Output Style (explanatory): Alongside completing the requested work, concisely explain relevant architectural context, design trade-offs, and how modified modules connect to the rest of the codebase.',
    source: 'builtin',
  },
  {
    name: 'terse',
    description: 'Minimal bullets and results only; omit prose unless reporting blockers or answering questions.',
    instructions:
      'Output Style (terse): Respond as compactly as possible using brief bullets, file references, and verification results. Omit narrative prose unless explaining a blocker or answering a direct question.',
    source: 'builtin',
  },
];

const BUILTIN_STYLE_NAMES = new Set(BUILTIN_STYLES.map(s => s.name));
const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export function parseNotifyMode(raw: unknown): NotifyMode | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === 'off' || cleaned === 'none' || cleaned === 'false') return 'off';
  if (cleaned === 'prompts' || cleaned === 'prompt') return 'prompts';
  if (cleaned === 'all' || cleaned === 'bell' || cleaned === 'on' || cleaned === 'complete') return 'all';
  return null;
}

function readRegular(filePath: string, limit: number, privateOnly = false): Buffer {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      st.size > limit ||
      (privateOnly && (st.mode & 0o077) !== 0)
    ) {
      throw new Error('Expected a small user-owned regular file without symlinks or hardlinks.');
    }
    const buf = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    if (total > limit) throw new Error('File exceeds size limit.');
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

export function parseStyleMarkdown(markdown: string, fallbackName: string): OutputStyleDefinition {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized.replace(/[\n\t]/g, ''))) {
    throw new Error(`Style ${fallbackName} contains hidden or control characters.`);
  }
  let name = fallbackName;
  let description = '';
  let body = normalized;

  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1];
      const val = kv[2].trim().replace(/^["']|["']$/g, '').trim();
      if (key === 'name' && val) name = val;
      else if (key === 'description' && val) description = val.slice(0, 200);
    }
  }

  if (!VALID_STYLE_NAME.test(name) || BUILTIN_STYLE_NAMES.has(name)) {
    throw new Error(`Invalid or reserved style name "${name}".`);
  }
  const instructions = body.trim();
  if (!instructions) {
    throw new Error(`Style "${name}" requires non-empty instructions.`);
  }
  if (!description) {
    description = (instructions.split('\n').map(l => l.trim()).find(Boolean) ?? `Custom style ${name}`).slice(0, 200);
  }

  return {
    name,
    description,
    instructions: `Output Style (${name}):\n${instructions}`,
    source: 'user',
  };
}

interface StoredPrefs {
  style?: string;
  notify?: NotifyMode;
}

export interface RegisterPreferencesOptions {
  cwd?: string;
  prefsFile?: string;
  stylesDir?: string;
  initialStyleOverride?: string;
  initialNotifyOverride?: NotifyMode;
  emitBell?: () => void;
  onStatusChange?: (ctx?: ExtensionContext) => void;
}

export interface PreferencesHandle {
  getStyle(): string;
  getNotifyMode(): NotifyMode;
  listStyles(): OutputStyleDefinition[];
  summary(): { style: string; notify: NotifyMode; promptBytes: number };
}

export function registerPreferences(pi: ExtensionAPI, options: RegisterPreferencesOptions = {}): PreferencesHandle {
  const launch = (() => {
    try { return realpathSync(options.cwd ?? process.cwd()); } catch { return path.resolve(options.cwd ?? process.cwd()); }
  })();

  const prefsFile = options.prefsFile
    ? path.resolve(options.prefsFile)
    : (process.env.PI_PROTECTED_PREFS_FILE
      ? path.resolve(process.env.PI_PROTECTED_PREFS_FILE)
      : path.join(os.homedir(), '.config/pi-protected/preferences.json'));

  const stylesDir = options.stylesDir
    ? path.resolve(options.stylesDir)
    : (process.env.PI_PROTECTED_STYLES_DIR
      ? path.resolve(process.env.PI_PROTECTED_STYLES_DIR)
      : path.join(os.homedir(), '.config/pi-protected/styles'));

  function isOutsideWorkspace(target: string): boolean {
    const rel = path.relative(launch, target);
    return rel.startsWith('../') || path.isAbsolute(rel);
  }

  function loadStoredPrefs(): StoredPrefs {
    if (!isOutsideWorkspace(prefsFile)) return {};
    try {
      const raw = JSON.parse(readRegular(prefsFile, MAX_PREFS_BYTES, true).toString('utf8')) as {
        style?: unknown;
        notify?: unknown;
      };
      const out: StoredPrefs = {};
      if (typeof raw?.style === 'string' && VALID_STYLE_NAME.test(raw.style)) {
        out.style = raw.style;
      }
      const parsedNotify = parseNotifyMode(raw?.notify);
      if (parsedNotify) out.notify = parsedNotify;
      return out;
    } catch (err) {
      if (missing(err)) return {};
      return {};
    }
  }

  function saveStoredPrefs(prefs: StoredPrefs): void {
    if (!isOutsideWorkspace(prefsFile)) {
      throw new Error('Preferences file must reside outside the workspace.');
    }
    const dirPath = path.dirname(prefsFile);
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    const st = lstatSync(dirPath);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) {
      throw new Error('Preferences directory must be a user-owned non-symlink directory.');
    }
    const tmp = `${prefsFile}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, ...prefs }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, prefsFile);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  function discoverStyles(): OutputStyleDefinition[] {
    const all: OutputStyleDefinition[] = [...BUILTIN_STYLES];
    if (!isOutsideWorkspace(stylesDir)) return all;
    let entries;
    try {
      const st = lstatSync(stylesDir);
      if (!st.isDirectory() || st.isSymbolicLink()) return all;
      entries = readdirSync(stylesDir, { withFileTypes: true });
    } catch {
      return all;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) continue;
      const stem = entry.name.slice(0, -3);
      if (!VALID_STYLE_NAME.test(stem) || BUILTIN_STYLE_NAMES.has(stem)) continue;
      try {
        const bytes = readRegular(path.join(stylesDir, entry.name), MAX_STYLE_BYTES, false);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = parseStyleMarkdown(text, stem);
        if (!all.some(s => s.name === parsed.name)) {
          all.push(parsed);
        }
      } catch {
        // Invalid custom style skipped
      }
    }
    return all;
  }

  const stored = loadStoredPrefs();
  let currentStyle = options.initialStyleOverride ?? stored.style ?? 'default';
  let currentNotify: NotifyMode = options.initialNotifyOverride ?? stored.notify ?? 'off';
  let lastPromptBytes = 0;

  // Validate initial style against discovered styles; fall back to 'default' if missing
  if (!discoverStyles().some(s => s.name === currentStyle)) {
    currentStyle = 'default';
  }

  const ringBell = (ctx: ExtensionContext): void => {
    // NEVER write terminal control characters in rpc or json modes!
    if (ctx.mode !== 'tui') return;
    if (options.emitBell) {
      options.emitBell();
      return;
    }
    if (process.stderr.isTTY) {
      process.stderr.write('\x07');
    }
  };

  pi.on('ui_prompt_start', async (_event, ctx) => {
    if (currentNotify === 'prompts' || currentNotify === 'all') {
      ringBell(ctx);
    }
  });

  pi.on('agent_settled', async (event, ctx) => {
    if (currentNotify === 'all' && !event.aborted) {
      ringBell(ctx);
    }
  });

  pi.on('before_agent_start', async event => {
    if (!event.systemPromptOptions) return;
    const activeDef = discoverStyles().find(s => s.name === currentStyle);
    if (!activeDef || activeDef.name === 'default' || !activeDef.instructions) {
      lastPromptBytes = 0;
      return;
    }
    const sections = (event.systemPromptOptions.sections ??= {});
    sections.output_style = activeDef.instructions;
    lastPromptBytes = Buffer.byteLength(activeDef.instructions, 'utf8');
  });

  async function handleStyleCommand(raw: string, ctx: ExtensionCommandContext): Promise<void> {
    const args = raw.trim();
    const styles = discoverStyles();
    if (!args || args === 'list' || args === 'status') {
      const lines = [
        `Active output style: ${currentStyle}`,
        'Available styles:',
        ...styles.map(
          s => `  ${s.name === currentStyle ? '●' : '○'} ${s.name} [${s.source}] — ${s.description}`,
        ),
        'Usage: /style <name> | /style create <name>',
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
      return;
    }

    const createMatch = /^create\s+([a-zA-Z0-9._-]+)$/.exec(args);
    if (createMatch) {
      if (!ctx.hasUI) return;
      const name = createMatch[1];
      if (!VALID_STYLE_NAME.test(name) || BUILTIN_STYLE_NAMES.has(name)) {
        ctx.ui.notify(`Invalid or reserved style name ${visible(name)}.`, 'warning');
        return;
      }
      if (!isOutsideWorkspace(stylesDir)) {
        ctx.ui.notify('Styles directory must reside outside the workspace.', 'warning');
        return;
      }
      const desc = await ctx.ui.input(`Description for style "${name}":`, 'How responses should read…', {
        timeout: 120_000,
        signal: ctx.signal,
      });
      if (!desc?.trim() || ctx.signal?.aborted) {
        ctx.ui.notify('Style creation cancelled.', 'info');
        return;
      }
      const body = await ctx.ui.editor(
        `Instructions for output style "${name}":`,
        'Lead with the result and format responses as…\n',
      );
      if (!body?.trim() || ctx.signal?.aborted) {
        ctx.ui.notify('Style creation cancelled.', 'info');
        return;
      }
      mkdirSync(stylesDir, { recursive: true, mode: 0o700 });
      const target = path.join(stylesDir, `${name}.md`);
      const content = [
        '---',
        `name: ${name}`,
        `description: ${JSON.stringify(desc.trim().slice(0, 180))}`,
        '---',
        body.trim(),
        '',
      ].join('\n');
      const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, target);
      } finally {
        rmSync(tmp, { force: true });
      }
      currentStyle = name;
      try { saveStoredPrefs({ style: currentStyle, notify: currentNotify }); } catch {}
      options.onStatusChange?.(ctx);
      ctx.ui.notify(`Created and activated output style "${name}".`, 'info');
      return;
    }

    const chosen = styles.find(s => s.name === args);
    if (!chosen) {
      ctx.ui.notify(
        `Unknown output style ${visible(args)}. Available: ${styles.map(s => s.name).join(', ')}.`,
        'warning',
      );
      return;
    }
    currentStyle = chosen.name;
    try {
      saveStoredPrefs({ style: currentStyle, notify: currentNotify });
    } catch (error) {
      ctx.ui.notify(`Style set for this session (could not persist: ${(error as Error).message}).`, 'warning');
      options.onStatusChange?.(ctx);
      return;
    }
    options.onStatusChange?.(ctx);
    ctx.ui.notify(`Output style set to "${currentStyle}".`, 'info');
  }

  async function handleNotifyCommand(raw: string, ctx: ExtensionCommandContext): Promise<void> {
    const arg = raw.trim().toLowerCase();
    if (!arg || arg === 'status') {
      ctx.ui.notify(
        `Terminal bell notifications: ${currentNotify} (options: off | prompts | all). Emits BEL only in interactive TUI mode.`,
        'info',
      );
      return;
    }
    const parsed = parseNotifyMode(arg);
    if (!parsed) {
      ctx.ui.notify('Usage: /notify [off | prompts | all]', 'warning');
      return;
    }
    currentNotify = parsed;
    try {
      saveStoredPrefs({ style: currentStyle, notify: currentNotify });
    } catch (error) {
      ctx.ui.notify(`Notification mode set for this session (could not persist: ${(error as Error).message}).`, 'warning');
      return;
    }
    ctx.ui.notify(`Terminal bell notifications set to "${currentNotify}".`, 'info');
  }

  pi.registerCommand('style', {
    description: 'View, switch, or create output styles: /style [default | concise | explanatory | terse | <custom> | create <name>]',
    handler: handleStyleCommand,
  });

  pi.registerCommand('notify', {
    description: 'Configure terminal bell cues on prompts and turn completion: /notify [off | prompts | all]',
    handler: handleNotifyCommand,
  });

  return {
    getStyle: () => currentStyle,
    getNotifyMode: () => currentNotify,
    listStyles: () => discoverStyles(),
    summary: () => ({
      style: currentStyle,
      notify: currentNotify,
      promptBytes: currentStyle === 'default' ? 0 : lastPromptBytes,
    }),
  };
}
