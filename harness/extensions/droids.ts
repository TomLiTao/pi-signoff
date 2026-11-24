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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visible } from './approvals.ts';

export type DroidReasoningEffort = 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type DroidComplexity = 'light' | 'medium' | 'heavy';
export type DroidTrustStatus = 'builtin' | 'user' | 'trusted' | 'untrusted' | 'modified';

export interface DroidDefinition {
  name: string;
  description: string;
  model: string; // 'inherit' | '<provider>/<id>' | '<id>'
  reasoningEffort: DroidReasoningEffort;
  tools: string[];
  writeCapable: boolean;
  systemPrompt: string;
  source: 'builtin' | 'user' | 'project';
  trustStatus: DroidTrustStatus;
  filePath?: string;
  relPath?: string;
  sha256?: string;
}

const VALID_DROID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_MODEL_SPEC = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const VALID_PROVIDER_SPEC = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_REASONING = new Set<DroidReasoningEffort>([
  'inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
]);

const MAX_DROID_FILE_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 128 * 1024;

const READ_ONLY_DEFAULT_TOOLS = [
  'pi_safe_read',
  'pi_safe_grep',
  'pi_safe_find',
  'pi_safe_ls',
  'pi_safe_git',
] as const;

const REVIEWER_DEFAULT_TOOLS = [
  'pi_safe_read',
  'pi_safe_bash',
  'pi_safe_grep',
  'pi_safe_find',
  'pi_safe_ls',
  'pi_safe_git',
] as const;

const RESEARCH_DEFAULT_TOOLS = [
  ...READ_ONLY_DEFAULT_TOOLS,
  'pi_safe_web_search',
  'pi_safe_web_fetch',
] as const;

const WORKTREE_WRITE_TOOLS = [
  'pi_safe_read',
  'pi_safe_bash',
  'pi_safe_edit',
  'pi_safe_write',
  'pi_safe_grep',
  'pi_safe_find',
  'pi_safe_ls',
  'pi_safe_git',
] as const;

const TOOL_ALIAS_MAP: Record<string, string> = {
  pi_safe_read: 'pi_safe_read',
  read: 'pi_safe_read',
  pi_safe_grep: 'pi_safe_grep',
  grep: 'pi_safe_grep',
  pi_safe_find: 'pi_safe_find',
  find: 'pi_safe_find',
  glob: 'pi_safe_find',
  pi_safe_ls: 'pi_safe_ls',
  ls: 'pi_safe_ls',
  pi_safe_bash: 'pi_safe_bash',
  bash: 'pi_safe_bash',
  execute: 'pi_safe_bash',
  pi_safe_edit: 'pi_safe_edit',
  edit: 'pi_safe_edit',
  applypatch: 'pi_safe_edit',
  pi_safe_write: 'pi_safe_write',
  write: 'pi_safe_write',
  create: 'pi_safe_write',
  pi_safe_git: 'pi_safe_git',
  git: 'pi_safe_git',
  pi_safe_web_search: 'pi_safe_web_search',
  websearch: 'pi_safe_web_search',
  web_search: 'pi_safe_web_search',
  pi_safe_web_fetch: 'pi_safe_web_fetch',
  fetchurl: 'pi_safe_web_fetch',
  web_fetch: 'pi_safe_web_fetch',
};

export const BUILTIN_DROIDS: readonly DroidDefinition[] = [
  {
    name: 'explorer',
    description: 'Fast read-only codebase explorer for locating files, symbols, call paths, and architecture facts.',
    model: 'inherit',
    reasoningEffort: 'low',
    tools: [...READ_ONLY_DEFAULT_TOOLS],
    writeCapable: false,
    systemPrompt:
      'You are Explorer, a fast read-only codebase investigation subagent. Search precisely, read relevant lines, and return concise findings with exact file paths and line numbers.',
    source: 'builtin',
    trustStatus: 'builtin',
  },
  {
    name: 'reviewer',
    description: 'Read-only code and security reviewer focused on bugs, regressions, edge cases, and boundary invariants.',
    model: 'inherit',
    reasoningEffort: 'high',
    tools: [...REVIEWER_DEFAULT_TOOLS],
    writeCapable: false,
    systemPrompt:
      'You are Reviewer, a thorough read-only engineering and security auditor. Inspect diffs and surrounding code for logic bugs, race conditions, missing validation, and security boundary issues. Cite concrete file paths and evidence.',
    source: 'builtin',
    trustStatus: 'builtin',
  },
  {
    name: 'worker',
    description: 'Isolated worktree implementation worker that edits and tests changes in a private temporary copy for review.',
    model: 'inherit',
    reasoningEffort: 'medium',
    tools: [...WORKTREE_WRITE_TOOLS],
    writeCapable: true,
    systemPrompt:
      'You are Worker, a focused implementation subagent operating inside an isolated temporary worktree. Implement the requested change cleanly, run relevant local verification checks, and summarize modified files and verification outcomes.',
    source: 'builtin',
    trustStatus: 'builtin',
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_DROIDS.map(d => d.name));
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

function readRegular(file: string, limit: number, privateFile = false): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      st.size > limit ||
      (privateFile && (st.mode & 0o077) !== 0)
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
    if (total > limit) throw new Error('Droid file exceeds size limit.');
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function resolveToolsSpec(rawTools: string | readonly string[] | undefined): { tools: string[]; writeCapable: boolean } {
  if (rawTools === undefined) {
    return { tools: [...READ_ONLY_DEFAULT_TOOLS], writeCapable: false };
  }
  if (typeof rawTools === 'string') {
    const lower = rawTools.trim().toLowerCase();
    if (!lower || lower === 'read-only' || lower === 'readonly') {
      return { tools: [...READ_ONLY_DEFAULT_TOOLS], writeCapable: false };
    }
    if (lower === 'reviewer' || lower === 'audit') {
      return { tools: [...REVIEWER_DEFAULT_TOOLS], writeCapable: false };
    }
    if (lower === 'research' || lower === 'web') {
      return { tools: [...RESEARCH_DEFAULT_TOOLS], writeCapable: false };
    }
    if (lower === 'worktree-write' || lower === 'write' || lower === 'edit' || lower === 'all') {
      return { tools: [...WORKTREE_WRITE_TOOLS], writeCapable: true };
    }
    const items = rawTools
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(s => unquoteYamlScalar(s))
      .filter(Boolean);
    return resolveToolsSpec(items);
  }

  const mapped: string[] = [];
  for (const item of rawTools) {
    const key = unquoteYamlScalar(String(item)).toLowerCase().replace(/[\s-]+/g, '_');
    const target = TOOL_ALIAS_MAP[key];
    if (!target) {
      throw new Error(`Unsupported droid tool "${item}". Use read-only, worktree-write, or valid tool names (Read, Grep, Glob, LS, Execute, Edit, Create, Git, WebSearch, FetchUrl).`);
    }
    if (!mapped.includes(target)) mapped.push(target);
  }
  if (mapped.length === 0) {
    throw new Error('Droid tools list resolved to zero tools.');
  }
  const writeCapable = mapped.includes('pi_safe_edit') || mapped.includes('pi_safe_write');
  return { tools: mapped, writeCapable };
}

export function parseDroidMarkdown(
  markdown: string,
  fallbackName: string,
  meta: {
    source: 'user' | 'project';
    trustStatus: DroidTrustStatus;
    filePath?: string;
    relPath?: string;
    sha256?: string;
  },
): DroidDefinition {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized.replace(/[\n\t]/g, ''))) {
    throw new Error(`Droid ${fallbackName} contains hidden or control characters.`);
  }

  let name = fallbackName;
  let description = '';
  let model = 'inherit';
  let reasoningEffort: DroidReasoningEffort = 'inherit';
  let toolsRaw: string | string[] | undefined;
  let body = normalized;

  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (fmMatch) {
    const fmText = fmMatch[1];
    body = fmMatch[2];
    const lines = fmText.split('\n');
    let listKey: string | null = null;
    const listItems: string[] = [];

    const flushList = () => {
      if (listKey === 'tools' && listItems.length > 0) {
        toolsRaw = [...listItems];
      }
      listKey = null;
      listItems.length = 0;
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (listKey && /^-\s+(.+)$/.test(trimmed)) {
        const m = /^-\s+(.+)$/.exec(trimmed)!;
        listItems.push(unquoteYamlScalar(m[1]));
        continue;
      }
      flushList();
      const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!kv) continue;
      const key = kv[1];
      const val = unquoteYamlScalar(kv[2]);
      if (key === 'name' && val) {
        name = val;
      } else if (key === 'description' && val) {
        description = val.slice(0, 240);
      } else if (key === 'model' && val) {
        model = val;
      } else if ((key === 'reasoningEffort' || key === 'reasoning_effort' || key === 'thinking') && val) {
        const low = val.toLowerCase() as DroidReasoningEffort;
        if (!VALID_REASONING.has(low)) {
          throw new Error(`Invalid droid reasoningEffort "${val}".`);
        }
        reasoningEffort = low;
      } else if (key === 'tools') {
        if (!val) {
          listKey = 'tools';
        } else {
          toolsRaw = val;
        }
      }
    }
    flushList();
  }

  if (!VALID_DROID_NAME.test(name)) {
    throw new Error(`Invalid droid name "${name}".`);
  }
  if (BUILTIN_NAMES.has(name)) {
    throw new Error(`Droid name "${name}" is reserved by a built-in droid.`);
  }
  if (model !== 'inherit' && !VALID_MODEL_SPEC.test(model)) {
    throw new Error(`Invalid droid model "${model}".`);
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) {
    throw new Error(`Droid ${name} requires a non-empty system prompt body.`);
  }
  if (Buffer.byteLength(systemPrompt, 'utf8') > 24 * 1024) {
    throw new Error(`Droid ${name} system prompt exceeds 24 KiB limit.`);
  }

  if (!description) {
    const firstLine = systemPrompt.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? `Custom droid ${name}`;
    description = firstLine.slice(0, 240);
  }

  const { tools, writeCapable } = resolveToolsSpec(toolsRaw);
  return {
    name,
    description,
    model,
    reasoningEffort,
    tools,
    writeCapable,
    systemPrompt,
    source: meta.source,
    trustStatus: meta.trustStatus,
    filePath: meta.filePath,
    relPath: meta.relPath,
    sha256: meta.sha256,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ResolvedDelegateExecution {
  droid?: DroidDefinition;
  provider: string;
  model: string;
  thinking: Exclude<DroidReasoningEffort, 'inherit'>;
  toolsCsv: string;
  writeCapable: boolean;
  fullTask: string;
  label: string;
}

export function resolveDelegateExecution(params: {
  task: string;
  droid?: DroidDefinition;
  complexity?: DroidComplexity;
  parentProvider: string;
  parentModel: string;
  parentThinking: string;
  activeParentTools: readonly string[];
  webEnabled: boolean;
  fetchEnabled: boolean;
  gitEnabled: boolean;
  isPlanning: boolean;
  isWritable: boolean;
}): ResolvedDelegateExecution {
  if (!VALID_PROVIDER_SPEC.test(params.parentProvider) || !VALID_MODEL_SPEC.test(params.parentModel)) {
    throw new Error('Active model/provider identifier is invalid for delegation.');
  }

  let provider = params.parentProvider;
  let model = params.parentModel;
  const droid = params.droid;

  if (droid) {
    if (droid.trustStatus === 'untrusted' || droid.trustStatus === 'modified') {
      throw new Error(`Project droid "${droid.name}" is ${droid.trustStatus}. Review and pin it with /droids trust ${droid.name} first.`);
    }
    if (droid.model !== 'inherit') {
      const slash = droid.model.indexOf('/');
      if (slash > 0) {
        const candProv = droid.model.slice(0, slash);
        const candModel = droid.model.slice(slash + 1);
        if (!VALID_PROVIDER_SPEC.test(candProv) || !VALID_MODEL_SPEC.test(candModel)) {
          throw new Error(`Invalid provider/model "${droid.model}" in droid "${droid.name}".`);
        }
        provider = candProv;
        model = candModel;
      } else {
        model = droid.model;
      }
    }
  }

  let thinking: Exclude<DroidReasoningEffort, 'inherit'> =
    VALID_REASONING.has(params.parentThinking as DroidReasoningEffort) && params.parentThinking !== 'inherit'
      ? (params.parentThinking as Exclude<DroidReasoningEffort, 'inherit'>)
      : 'low';

  if (droid && droid.reasoningEffort !== 'inherit') {
    thinking = droid.reasoningEffort;
  }
  if (params.complexity === 'light') thinking = 'low';
  else if (params.complexity === 'medium') thinking = 'medium';
  else if (params.complexity === 'heavy') thinking = 'high';

  const writeCapable = Boolean(droid?.writeCapable);
  if (writeCapable && (params.isPlanning || !params.isWritable)) {
    throw new Error(`Droid "${droid?.name}" requires worktree write access, which is unavailable while in plan/read-only mode.`);
  }

  const allowedSessionTools = new Set<string>(['pi_safe_read', 'pi_safe_bash', 'pi_safe_grep', 'pi_safe_find', 'pi_safe_ls']);
  if (params.gitEnabled) allowedSessionTools.add('pi_safe_git');
  if (params.webEnabled) allowedSessionTools.add('pi_safe_web_search');
  if (params.fetchEnabled) allowedSessionTools.add('pi_safe_web_fetch');
  if (writeCapable) {
    allowedSessionTools.add('pi_safe_edit');
    allowedSessionTools.add('pi_safe_write');
  }

  let selectedTools: string[];
  if (droid) {
    selectedTools = droid.tools.filter(t => allowedSessionTools.has(t));
  } else {
    selectedTools = params.activeParentTools.filter(t => allowedSessionTools.has(t) && t !== 'pi_safe_edit' && t !== 'pi_safe_write');
  }

  const fullTask = droid
    ? `Subagent role: ${droid.name} — ${droid.description}\n\nRole instructions:\n${droid.systemPrompt}\n\nAssigned task:\n${params.task}`
    : params.task;

  return {
    droid,
    provider,
    model,
    thinking,
    toolsCsv: selectedTools.join(','),
    writeCapable,
    fullTask,
    label: droid ? `[${droid.name}] ${params.task}` : params.task,
  };
}

export interface DroidsOptions {
  dir: string;
  enabled?: boolean;
  secretPaths: string[];
  userDroidsDir?: string;
}

export interface DroidsHandle {
  listAll(): DroidDefinition[];
  listActive(): DroidDefinition[];
  getDroid(name: string): DroidDefinition | undefined;
  getActive(name: string): DroidDefinition | undefined;
  summary(): { enabled: boolean; activeCount: number; customCount: number; untrustedCount: number; promptBytes: number; names: string[] };
}

interface StoredDroidTrust {
  relPath: string;
  sha256: string;
}

export function registerDroids(pi: ExtensionAPI, options: DroidsOptions): DroidsHandle {
  const enabled = options.enabled !== false;
  const launch = realpathSync(process.cwd());
  const storage = path.join(realpathSync(options.dir), 'trusted-droids');
  const storeRecord = path.join(storage, `${sha256(launch)}.json`);
  const relStorage = path.relative(launch, storage);
  const external = relStorage.startsWith('../') || path.isAbsolute(relStorage);

  const userRoot = options.userDroidsDir
    ? path.resolve(options.userDroidsDir)
    : (process.env.PI_PROTECTED_DROIDS_DIR
      ? path.resolve(process.env.PI_PROTECTED_DROIDS_DIR)
      : path.join(os.homedir(), '.config/pi-protected/droids'));

  const projectDirs = [
    { root: path.join(launch, '.factory', 'droids'), prefix: '.factory/droids' },
    { root: path.join(launch, '.agents', 'droids'), prefix: '.agents/droids' },
  ];

  const warnedModified = new Set<string>();

  function matchesSecret(relPosix: string): boolean {
    const base = path.posix.basename(relPosix);
    return options.secretPaths.some(glob => path.matchesGlob(relPosix, glob) || path.matchesGlob(base, glob));
  }

  function checkStorage(create: boolean): void {
    if (!external) throw new Error('Droid trust store must reside outside the workspace.');
    if (create) {
      try { mkdirSync(storage, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const st = lstatSync(storage);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      throw new Error('Droid trust store must be a private 0700 user-owned directory.');
    }
  }

  function loadApprovedDroids(): Record<string, StoredDroidTrust> {
    try {
      checkStorage(false);
      const raw = JSON.parse(readRegular(storeRecord, MAX_STORE_BYTES, true).toString('utf8')) as {
        droids?: Record<string, Partial<StoredDroidTrust>>;
      };
      const out: Record<string, StoredDroidTrust> = {};
      if (raw?.droids && typeof raw.droids === 'object') {
        for (const [name, entry] of Object.entries(raw.droids)) {
          if (
            VALID_DROID_NAME.test(name) &&
            entry &&
            typeof entry.relPath === 'string' &&
            typeof entry.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(entry.sha256)
          ) {
            out[name] = { relPath: entry.relPath, sha256: entry.sha256 };
          }
        }
      }
      return out;
    } catch (err) {
      if (missing(err)) return {};
      throw err;
    }
  }

  function saveApprovedDroids(droids: Record<string, StoredDroidTrust>): void {
    checkStorage(true);
    const tmp = `${storeRecord}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, droids }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, storeRecord);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  function scanMarkdownFiles(dirPath: string): Array<{ stem: string; fullPath: string }> {
    try {
      const st = lstatSync(dirPath);
      if (!st.isDirectory() || st.isSymbolicLink()) return [];
    } catch {
      return [];
    }
    return readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        stem: e.name.slice(0, -3),
        fullPath: path.join(dirPath, e.name),
      }))
      .filter(x => VALID_DROID_NAME.test(x.stem));
  }

  function discoverAll(ctx?: ExtensionContext): DroidDefinition[] {
    if (!enabled) return [...BUILTIN_DROIDS];
    const byName = new Map<string, DroidDefinition>();
    for (const b of BUILTIN_DROIDS) {
      byName.set(b.name, b);
    }

    // 1. Personal droids (~/.config/pi-protected/droids/*.md)
    const userRel = path.relative(launch, userRoot);
    const userOutside = userRel.startsWith('../') || path.isAbsolute(userRel);
    if (userOutside) {
      for (const item of scanMarkdownFiles(userRoot)) {
        try {
          const bytes = readRegular(item.fullPath, MAX_DROID_FILE_BYTES, false);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const parsed = parseDroidMarkdown(text, item.stem, {
            source: 'user',
            trustStatus: 'user',
            filePath: item.fullPath,
            sha256: sha256(bytes),
          });
          if (!byName.has(parsed.name)) {
            byName.set(parsed.name, parsed);
          }
        } catch {
          // Invalid user droid skipped cleanly
        }
      }
    }

    // 2. Project droids (.factory/droids/*.md and .agents/droids/*.md) — hash-pinned zero trust
    let approved: Record<string, StoredDroidTrust> = {};
    try {
      approved = loadApprovedDroids();
    } catch {
      approved = {};
    }

    for (const loc of projectDirs) {
      for (const item of scanMarkdownFiles(loc.root)) {
        const relPosix = `${loc.prefix}/${path.basename(item.fullPath)}`;
        if (matchesSecret(relPosix)) continue;
        try {
          const bytes = readRegular(item.fullPath, MAX_DROID_FILE_BYTES, false);
          const digest = sha256(bytes);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const tempParsed = parseDroidMarkdown(text, item.stem, {
            source: 'project',
            trustStatus: 'untrusted',
            filePath: item.fullPath,
            relPath: relPosix,
            sha256: digest,
          });
          // Never allow project droids to shadow built-in or personal droids
          if (byName.has(tempParsed.name)) continue;

          const pin = approved[tempParsed.name];
          let trustStatus: DroidTrustStatus = 'untrusted';
          if (pin) {
            if (pin.relPath === relPosix && pin.sha256 === digest) {
              trustStatus = 'trusted';
            } else {
              trustStatus = 'modified';
              if (ctx?.hasUI && !warnedModified.has(tempParsed.name)) {
                warnedModified.add(tempParsed.name);
                ctx.ui.notify(
                  `Project droid "${tempParsed.name}" (${relPosix}) changed since approval and is disabled. Run /droids trust ${tempParsed.name} to review.`,
                  'warning',
                );
              }
            }
          }
          byName.set(tempParsed.name, { ...tempParsed, trustStatus });
        } catch {
          // Invalid project droid skipped cleanly
        }
      }
    }

    return [...byName.values()];
  }

  function listActive(ctx?: ExtensionContext): DroidDefinition[] {
    return discoverAll(ctx).filter(
      d => d.trustStatus === 'builtin' || d.trustStatus === 'user' || d.trustStatus === 'trusted',
    );
  }

  let lastPromptBytes = 0;

  pi.on('before_agent_start', async (event, ctx) => {
    if (!enabled || !event.systemPromptOptions) return;
    const active = listActive(ctx);
    if (active.length === 0) {
      lastPromptBytes = 0;
      return;
    }
    const lines = [
      'Specialized subagents (droids) available via pi_safe_delegate({ droid, task, complexity }):',
      '<available_droids>',
      ...active.map(
        d =>
          `  <droid name="${escapeXml(d.name)}" mode="${d.writeCapable ? 'worktree-write' : 'read-only'}" reasoning="${d.reasoningEffort}">${escapeXml(d.description)}</droid>`,
      ),
      '</available_droids>',
      'Note: Write-capable droids (like "worker") run in an isolated temporary worktree after user approval and return a reviewable diff without touching the live workspace directly.',
    ];
    const joined = lines.join('\n');
    const sections = (event.systemPromptOptions.sections ??= {});
    sections.droids = joined;
    lastPromptBytes = Buffer.byteLength(joined, 'utf8');
  });

  async function handleDroidsCommand(raw: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!enabled) {
      ctx.ui.notify('Custom droids are disabled for this session.', 'info');
      return;
    }
    if (realpathSync(ctx.cwd) !== launch) {
      ctx.ui.notify('Manage droids from the launch folder.', 'warning');
      return;
    }
    const args = raw.trim();

    if (!args || args === 'list' || args === 'status') {
      const all = discoverAll(ctx);
      const lines = ['Available Droids (Subagents):'];
      for (const d of all) {
        const badge =
          d.trustStatus === 'builtin'
            ? '[built-in]'
            : d.trustStatus === 'user'
              ? '[personal]'
              : d.trustStatus === 'trusted'
                ? `[project · trusted · ${d.relPath}]`
                : d.trustStatus === 'modified'
                  ? `[project · MODIFIED (untrusted) · ${d.relPath}]`
                  : `[project · untrusted · ${d.relPath}]`;
        const modeTag = d.writeCapable ? 'worktree-write' : 'read-only';
        lines.push(`  • ${d.name} (${modeTag}) ${badge} — ${d.description}`);
      }
      lines.push('Commands: /droids show <name> | /droids create <name> | /droids trust [name] | /droids revoke [name]');
      ctx.ui.notify(lines.join('\n'), 'info');
      return;
    }

    const showMatch = /^show\s+([a-zA-Z0-9._-]+)$/.exec(args);
    if (showMatch) {
      const target = discoverAll(ctx).find(d => d.name === showMatch[1]);
      if (!target) {
        ctx.ui.notify(`No droid named "${showMatch[1]}". Run /droids list.`, 'warning');
        return;
      }
      ctx.ui.notify(
        [
          `Droid: ${target.name}`,
          `Source: ${target.source} (${target.trustStatus})${target.relPath ? ` · ${target.relPath}` : ''}`,
          `Mode: ${target.writeCapable ? 'isolated worktree-write' : 'read-only'}`,
          `Model: ${target.model} · Reasoning: ${target.reasoningEffort}`,
          `Tools: ${target.tools.join(', ')}`,
          `Description: ${target.description}`,
          '',
          'System Prompt:',
          target.systemPrompt.slice(0, 1800),
        ].join('\n'),
        'info',
      );
      return;
    }

    const trustMatch = /^trust(?:\s+([a-zA-Z0-9._-]+))?$/.exec(args);
    if (trustMatch) {
      if (!ctx.hasUI) return;
      const allProj = discoverAll(ctx).filter(d => d.source === 'project');
      if (allProj.length === 0) {
        ctx.ui.notify('No project droids found in .factory/droids/ or .agents/droids/.', 'info');
        return;
      }
      const candidates = trustMatch[1]
        ? allProj.filter(d => d.name === trustMatch[1])
        : allProj.filter(d => d.trustStatus !== 'trusted');
      if (candidates.length === 0) {
        ctx.ui.notify(
          trustMatch[1]
            ? `No project droid named "${trustMatch[1]}".`
            : 'All discovered project droids are already hash-pinned and trusted.',
          'info',
        );
        return;
      }
      const approved = loadApprovedDroids();
      let count = 0;
      for (const cand of candidates) {
        const preview = [
          `Trust project droid "${cand.name}" (${cand.relPath})?`,
          `SHA-256: ${cand.sha256?.slice(0, 16)}…`,
          `Mode: ${cand.writeCapable ? 'worktree-write' : 'read-only'} · Tools: ${cand.tools.join(', ')}`,
          `Model: ${cand.model} · Reasoning: ${cand.reasoningEffort}`,
          '',
          cand.systemPrompt.slice(0, 1200),
        ].join('\n');
        const choice = await ctx.ui.select(preview, ['Pin SHA-256 & trust droid', 'Skip'], {
          timeout: 60_000,
          signal: ctx.signal,
        });
        if (choice === 'Pin SHA-256 & trust droid' && cand.relPath && cand.sha256) {
          approved[cand.name] = { relPath: cand.relPath, sha256: cand.sha256 };
          warnedModified.delete(cand.name);
          count++;
        }
      }
      if (count > 0) {
        saveApprovedDroids(approved);
        ctx.ui.notify(`Pinned and trusted ${count} project droid${count === 1 ? '' : 's'}.`, 'info');
      } else {
        ctx.ui.notify('No project droids were trusted.', 'info');
      }
      return;
    }

    const revokeMatch = /^revoke(?:\s+([a-zA-Z0-9._-]+))?$/.exec(args);
    if (revokeMatch) {
      const approved = loadApprovedDroids();
      if (revokeMatch[1]) {
        if (!approved[revokeMatch[1]]) {
          ctx.ui.notify(`Project droid "${revokeMatch[1]}" is not currently trusted.`, 'info');
          return;
        }
        delete approved[revokeMatch[1]];
        saveApprovedDroids(approved);
        ctx.ui.notify(`Revoked trust for project droid "${revokeMatch[1]}".`, 'info');
      } else {
        saveApprovedDroids({});
        ctx.ui.notify('Revoked trust for all project droids in this workspace.', 'info');
      }
      return;
    }

    const createMatch = /^create\s+([a-zA-Z0-9._-]+)$/.exec(args);
    if (createMatch) {
      if (!ctx.hasUI) return;
      const name = createMatch[1];
      if (!VALID_DROID_NAME.test(name) || BUILTIN_NAMES.has(name)) {
        ctx.ui.notify(`Invalid or reserved droid name ${visible(name)}.`, 'warning');
        return;
      }
      const userRel = path.relative(launch, userRoot);
      if (!userRel.startsWith('../') && !path.isAbsolute(userRel)) {
        ctx.ui.notify('Personal droids directory must reside outside the workspace.', 'warning');
        return;
      }
      const desc = await ctx.ui.input(`Description for droid "${name}":`, 'Focused subagent purpose…', {
        timeout: 120_000,
        signal: ctx.signal,
      });
      if (!desc?.trim() || ctx.signal?.aborted) {
        ctx.ui.notify('Droid creation cancelled.', 'info');
        return;
      }
      const toolChoice = await ctx.ui.select(
        `Tool policy for droid "${name}":`,
        [
          'read-only (Read, Grep, Find, LS, Git)',
          'reviewer (Read, Bash, Grep, Find, LS, Git)',
          'worktree-write (Isolated worktree with Edit & Write)',
          'Cancel',
        ],
        { timeout: 60_000, signal: ctx.signal },
      );
      if (!toolChoice || toolChoice === 'Cancel' || ctx.signal?.aborted) {
        ctx.ui.notify('Droid creation cancelled.', 'info');
        return;
      }
      const toolsMode = toolChoice.startsWith('worktree-write')
        ? 'worktree-write'
        : toolChoice.startsWith('reviewer')
          ? 'reviewer'
          : 'read-only';
      const promptBody = await ctx.ui.editor(
        `System prompt for "${name}":`,
        `You are ${name}, a specialized subagent.\n\nGoal: ${desc.trim()}\n`,
      );
      if (!promptBody?.trim() || ctx.signal?.aborted) {
        ctx.ui.notify('Droid creation cancelled.', 'info');
        return;
      }
      mkdirSync(userRoot, { recursive: true, mode: 0o700 });
      const targetFile = path.join(userRoot, `${name}.md`);
      const content = [
        '---',
        `name: ${name}`,
        `description: ${JSON.stringify(desc.trim().slice(0, 200))}`,
        'model: inherit',
        'reasoningEffort: inherit',
        `tools: ${toolsMode}`,
        '---',
        promptBody.trim(),
        '',
      ].join('\n');
      const tmp = `${targetFile}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, targetFile);
      } finally {
        rmSync(tmp, { force: true });
      }
      ctx.ui.notify(`Created personal droid "${name}" at ${targetFile}`, 'info');
      return;
    }

    ctx.ui.notify('Usage: /droids [list | show <name> | create <name> | trust [name] | revoke [name]]', 'warning');
  }

  pi.registerCommand('droids', {
    description: 'List, inspect, create, or trust custom droids (subagents): /droids [list | show <name> | create <name> | trust | revoke]',
    handler: handleDroidsCommand,
  });

  return {
    listAll: () => discoverAll(),
    listActive: () => listActive(),
    getDroid: (name: string) => discoverAll().find(d => d.name === name),
    getActive: (name: string) => listActive().find(d => d.name === name),
    summary() {
      if (!enabled) {
        return { enabled: false, activeCount: 0, customCount: 0, untrustedCount: 0, promptBytes: 0, names: [] };
      }
      const all = discoverAll();
      const active = all.filter(d => d.trustStatus === 'builtin' || d.trustStatus === 'user' || d.trustStatus === 'trusted');
      const customCount = active.filter(d => d.source !== 'builtin').length;
      const untrustedCount = all.filter(d => d.trustStatus === 'untrusted' || d.trustStatus === 'modified').length;
      return {
        enabled: true,
        activeCount: active.length,
        customCount,
        untrustedCount,
        promptBytes: lastPromptBytes,
        names: active.map(d => d.name),
      };
    },
  };
}
