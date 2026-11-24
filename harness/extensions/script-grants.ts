// Script grants: approve `python3 path/to/script.py <any args>` while the script and the local
// modules it imports are unchanged. The grant stores a fingerprint (SHA-256 over every resolved
// workspace file and its content); the agent editing the script, editing a local module it
// imports, or adding a file that shadows an import changes the fingerprint and voids the grant.
//
// Limits (by design, documented in the README): imports are resolved statically, so code loaded
// dynamically from other paths, installed packages, and stale bytecode are not covered. The
// Bubblewrap sandbox stays the real boundary; this keeps an approval tied to what was reviewed.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { editDecision, type Policy } from './approvals.ts';

export interface ScriptCommand {
  /** Interpreter token as typed: python, python3, python3.12, .venv/bin/python, … */
  interpreter: string;
  /** Grant key: the workspace-relative script path, or `-m dotted.module` for module runs. */
  script: string;
  /** Workspace-relative POSIX path of the file that runs. */
  file: string;
  /** Dotted module name for `python -m` runs. */
  module?: string;
  args: string[];
}

export interface ScriptFingerprint {
  hash: string;
  /** Workspace-relative files covered, script first. */
  files: string[];
}

export interface ScriptGrant {
  interpreter: string;
  script: string;
  fingerprint: string;
}

export type ScriptGrantStatus = 'match' | 'changed' | 'none';

const INTERPRETER = /^(?:python|python3(?:\.\d{1,2})?|(?:\.venv|venv)\/bin\/python3?)$/;
// Interpreter flags that cannot run other code or change what the script means.
const HARMLESS_FLAGS = new Set(['-u', '-B', '-O', '-OO', '-I', '-E', '-s', '-q']);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Bare words only: no quotes, globs, expansions, redirects, or operators. */
function tokenizeScriptCommand(command: string): string[] | null {
  if (/[^a-zA-Z0-9_./+=:,@%\t -]/.test(command)) return null;
  const tokens = command.trim().split(/[ \t]+/).filter(Boolean);
  if (!tokens.length || tokens[0].includes('=')) return null;
  return tokens;
}

function insideWorkspace(cwd: string, abs: string): string | null {
  const rel = path.relative(cwd, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function denied(root: string, rel: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): boolean {
  if (!policy || !Array.isArray(policy.secretPaths) || !Array.isArray(policy.deniedPaths)) {
    return rel.split('/').includes('.git');
  }
  return editDecision(root, rel, { askPaths: [], secretPaths: policy.secretPaths, deniedPaths: policy.deniedPaths } as unknown as Policy) === 'deny';
}

function hasSymlink(cwd: string, rel: string): boolean {
  let current = cwd;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Parse a command into a script invocation, or null when it is not a plain workspace script run. */
export function parseScriptCommand(command: string, cwd: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): ScriptCommand | null {
  const tokens = tokenizeScriptCommand(command);
  if (!tokens || !INTERPRETER.test(tokens[0])) return null;
  let i = 1;
  while (i < tokens.length && HARMLESS_FLAGS.has(tokens[i])) i++;
  let root: string;
  try { root = realpathSync(cwd); } catch { return null; }
  if (tokens[i] === '-m') {
    const module = tokens[i + 1];
    const file = module ? resolveWorkspaceModule(root, module, policy) : null;
    if (!module || !file) return null;
    return { interpreter: tokens[0], script: `-m ${module}`, file, module, args: tokens.slice(i + 2) };
  }
  const scriptToken = tokens[i];
  if (!scriptToken || scriptToken.startsWith('-') || !scriptToken.endsWith('.py')) return null;
  const rel = insideWorkspace(root, path.resolve(root, scriptToken));
  if (!rel || hasSymlink(root, rel)) return null;
  if (denied(root, rel, policy)) return null;
  return { interpreter: tokens[0], script: rel, file: rel, args: tokens.slice(i + 1) };
}

const MODULE_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/**
 * Resolve `python -m a.b` to a workspace file the way Python would with the launch folder as
 * sys.path[0] (plus `src/` for editable installs): `a/b.py`, else the package's `a/b/__main__.py`.
 * Returns null for modules that are not workspace files (pytest, pip, …).
 */
export function resolveWorkspaceModule(root: string, module: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): string | null {
  if (!MODULE_NAME.test(module)) return null;
  const parts = module.split('.');
  for (const base of [root, path.join(root, 'src')]) {
    for (const candidate of [path.join(base, ...parts) + '.py', path.join(base, ...parts, '__main__.py')]) {
      const rel = insideWorkspace(root, candidate);
      if (!rel) continue;
      let st;
      try { st = lstatSync(candidate); } catch { continue; }
      if (!st.isFile() || hasSymlink(root, rel) || denied(root, rel, policy)) continue;
      return rel;
    }
  }
  return null;
}

/**
 * Never-auto patterns: scripts that can move money or deploy ask every time. Patterns are
 * case-insensitive globs; one without `/` matches the file name (with or without `.py`), one with
 * `/` matches the workspace-relative path. Any `.py` token or `-m` module in the command counts, so
 * pipelines and wrappers (`bash -c "python3 scripts/ibkr_x.py"`) are caught too.
 */
export function neverAutoMatch(command: string, patterns: readonly string[]): { target: string; pattern: string } | null {
  if (!patterns.length) return null;
  const tokens = command.split(/[\s;|&<>()`'"$]+/).filter(Boolean);
  const targets: string[] = [];
  tokens.forEach((token, idx) => {
    if (/\.py$/i.test(token)) targets.push(token.replace(/^\.\//, ''));
    else if (tokens[idx - 1] === '-m' && MODULE_NAME.test(token)) targets.push(`${token.split('.').join('/')}.py`);
    else if (/^-m[A-Za-z_]/.test(token) && MODULE_NAME.test(token.slice(2))) targets.push(`${token.slice(2).split('.').join('/')}.py`);
  });
  for (const target of targets) {
    const rel = target.toLowerCase();
    const name = rel.split('/').pop() ?? rel;
    const stem = name.replace(/\.py$/, '');
    for (const pattern of patterns) {
      const p = pattern.toLowerCase();
      const hit = p.includes('/')
        ? path.matchesGlob(rel, p) || path.matchesGlob(rel.replace(/\.py$/, ''), p)
        : path.matchesGlob(name, p) || path.matchesGlob(stem, p);
      if (hit) return { target, pattern };
    }
  }
  return null;
}

function readSmallFile(abs: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    return buf.subarray(0, total);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface ImportRef {
  /** Leading dots of a relative import (0 for absolute). */
  level: number;
  module: string;
  names: string[];
}

/** Static scan of Python import statements; over-matching (e.g. inside strings) only adds files. */
export function scanPythonImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const clean = (name: string) => name.trim().split(/\s+as\s+/)[0].trim();
  const valid = (name: string) => /^[A-Za-z_][\w.]*$/.test(name);
  for (const m of source.matchAll(/^[ \t]*import[ \t]+([^#\n;]+)/gm)) {
    for (const part of m[1].split(',')) {
      const name = clean(part);
      if (valid(name)) refs.push({ level: 0, module: name, names: [] });
    }
  }
  for (const m of source.matchAll(/^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+(\([^)]*\)|[^#\n;]*)/gm)) {
    const names = m[3].replace(/[()\\]/g, ' ').split(',').map(clean).filter(n => n && n !== '*' && /^[A-Za-z_]\w*$/.test(n));
    refs.push({ level: m[1].length, module: m[2] ?? '', names });
  }
  for (const m of source.matchAll(/(?:import_module|__import__)\(\s*['"]([A-Za-z_][\w.]*)['"]/g)) {
    refs.push({ level: 0, module: m[1], names: [] });
  }
  return refs;
}

function moduleCandidates(base: string, dotted: string): string[] {
  const parts = dotted ? dotted.split('.') : [];
  const out: string[] = [];
  let dir = base;
  if (!parts.length) out.push(path.join(base, '__init__.py'));
  parts.forEach((part, idx) => {
    if (idx < parts.length - 1) {
      dir = path.join(dir, part);
      out.push(path.join(dir, '__init__.py'));
    } else {
      out.push(path.join(dir, `${part}.py`), path.join(dir, part, '__init__.py'));
    }
  });
  return out;
}

/**
 * Fingerprint a workspace script plus the local modules it (transitively) imports. Absolute
 * imports resolve against the script's folder (Python's sys.path[0]), the workspace root, and
 * `src/` (editable installs). Returns null when the script is unreadable or the graph is too big.
 */
export function scriptFingerprint(cwd: string, scriptRel: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): ScriptFingerprint | null {
  let root: string;
  try { root = realpathSync(cwd); } catch { return null; }
  const scriptAbs = path.join(root, scriptRel);
  const roots = [...new Set([path.dirname(scriptAbs), root, path.join(root, 'src')])];
  const queue = [scriptAbs];
  // Package __init__ files above the script run first for `python -m` (harmless extra for paths).
  for (let dir = path.dirname(scriptAbs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    queue.push(path.join(dir, '__init__.py'));
  }
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  let total = 0;

  while (queue.length) {
    const abs = queue.shift()!;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const rel = insideWorkspace(root, abs);
    if (!rel) continue;
    let st;
    try { st = lstatSync(abs); } catch { st = undefined; }
    if (!st) {
      if (abs === scriptAbs) return null;
      continue;
    }
    if (!st.isFile() || hasSymlink(root, rel)) {
      if (abs === scriptAbs) return null;
      continue;
    }
    if (denied(root, rel, policy)) {
      if (abs === scriptAbs) return null;
      continue;
    }
    const data = readSmallFile(abs);
    if (!data) return null;
    total += data.length;
    if (entries.length >= MAX_FILES || total > MAX_TOTAL_BYTES) return null;
    entries.push([rel, sha256(data)]);

    const dir = path.dirname(abs);
    for (const ref of scanPythonImports(data.toString('utf8'))) {
      const bases = ref.level > 0
        ? [ref.level === 1 ? dir : path.resolve(dir, ...Array(ref.level - 1).fill('..'))]
        : roots;
      for (const base of bases) {
        const targets = [ref.module, ...ref.names.map(n => (ref.module ? `${ref.module}.${n}` : n))];
        for (const target of targets) {
          for (const candidate of moduleCandidates(base, target)) {
            if (!seen.has(candidate)) queue.push(candidate);
          }
        }
      }
    }
  }
  const [first, ...rest] = entries;
  const ordered = [first, ...rest.sort((a, b) => a[0].localeCompare(b[0]))];
  const hash = sha256(ordered.map(([rel, digest]) => `${rel}\0${digest}\n`).join(''));
  return { hash, files: ordered.map(([rel]) => rel) };
}

/** Check a command against grants: match, changed (same script, different fingerprint), or none. */
export function checkScriptGrants(
  command: string,
  cwd: string,
  grants: readonly ScriptGrant[],
  policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>,
): ScriptGrantStatus {
  if (!grants.length) return 'none';
  const parsed = parseScriptCommand(command, cwd, policy);
  if (!parsed) return 'none';
  const candidates = grants.filter(g => g.interpreter === parsed.interpreter && g.script === parsed.script);
  if (!candidates.length) return 'none';
  const fp = scriptFingerprint(cwd, parsed.file, policy);
  if (fp && candidates.some(g => g.fingerprint === fp.hash)) return 'match';
  return 'changed';
}

/** Build a grant for the current content of a script command, or null if it cannot be pinned. */
export function makeScriptGrant(command: string, cwd: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): (ScriptGrant & { files: string[] }) | null {
  const parsed = parseScriptCommand(command, cwd, policy);
  if (!parsed) return null;
  const fp = scriptFingerprint(cwd, parsed.file, policy);
  if (!fp) return null;
  return { interpreter: parsed.interpreter, script: parsed.script, fingerprint: fp.hash, files: fp.files };
}

export function describeScriptGrant(grant: Pick<ScriptGrant, 'interpreter' | 'script'> & { files?: string[] }): string {
  const extra = grant.files && grant.files.length > 1 ? ` (+${grant.files.length - 1} local module${grant.files.length === 2 ? '' : 's'})` : '';
  return `${grant.interpreter} ${grant.script} …${extra}`;
}
