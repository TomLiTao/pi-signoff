import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PRIVATE_NAMES = new Set([
  '.git', '.pi', '.codex', '.ssh', '.gnupg', '.aws', '.kube', '.docker',
  '.config', '.local', '.cache', '.password-store', '.netrc', '.git-credentials',
]);

// Host access mode (PI_PROTECTED_ACCESS=host): mirrors HOST_PRIVATE_NAMES / HOST_SCAN_PRUNE in sandbox.py.
const HOST_PRIVATE_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.netrc', '.git-credentials']);
const HOST_SCAN_PRUNE = new Set([
  '.git', 'node_modules', '__pycache__', 'site-packages', 'dist-packages', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache',
]);

const HOST_FILES = ['auth.json', 'settings.json', 'models.json', 'mcp.json', 'trust.json', 'models-store.json'];

export interface MaskSnapshot {
  root: string;
  masks: Array<[string, boolean]>;
  collapsed: string[];
  payload: string;
}

function globToPartSource(glob: string): string {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') src += '.*';
    else if (c === '?') src += '.';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return `^(?:${src})$`;
}

function compileProtectedMatcher(secretPaths: readonly string[]): (name: string) => boolean {
  // Directories the digest does not descend into: masked ones, plus (host mode) the pruned trees
  // that sandbox.py neither masks nor scans.
  const host = process.env.PI_PROTECTED_ACCESS === 'host';
  const isPrivate = host
    ? (name: string) => HOST_PRIVATE_NAMES.has(name) || HOST_SCAN_PRUNE.has(name)
    : (name: string) => PRIVATE_NAMES.has(name);
  if (secretPaths.length === 0) return isPrivate;
  const combined = new RegExp(secretPaths.map(globToPartSource).join('|'));
  return name => isPrivate(name) || combined.test(name);
}

/**
 * Compute a digest over `(path, st_mtime_ns, st_ino, st_mode)` for every non-protected directory
 * under `root` (plus protected directory stat headers, `write-guard.json`, and `PI_CODING_AGENT_DIR` targets).
 * Any file created, renamed, linked, or deleted mutates its parent directory's `st_mtime_ns`.
 */
export function computeDirSnapshotDigest(root: string, policyDir: string, secretPaths: readonly string[]): string {
  const isProtected = compileProtectedMatcher(secretPaths);
  const hasher = createHash('sha256');
  const policyFile = path.join(policyDir, 'write-guard.json');
  try {
    const pst = lstatSync(policyFile, { bigint: true });
    hasher.update(`policy:${pst.mtimeNs}:${pst.size}\n`);
  } catch {
    hasher.update('policy:missing\n');
  }

  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi/agent');
  for (const name of HOST_FILES) {
    try {
      const target = realpathSync(path.join(agentDir, name));
      const tst = lstatSync(target, { bigint: true });
      hasher.update(`host:${name}:${target}:${tst.ino}:${tst.mtimeNs}\n`);
    } catch {
      hasher.update(`host:${name}:missing\n`);
    }
  }

  const stack: string[] = [root];
  const lines: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const st = lstatSync(current, { bigint: true });
    if (!st.isDirectory()) continue;
    lines.push(`${current}\0${st.mtimeNs}:${st.ino}:${st.mode}`);
    const entries = readdirSync(current, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (isProtected(entry.name)) {
        const pst = lstatSync(full, { bigint: true });
        lines.push(`P:${full}\0${pst.mtimeNs}:${pst.ino}:${pst.mode}`);
        continue;
      }
      stack.push(full);
    }
  }
  lines.sort();
  for (const line of lines) {
    hasher.update(line);
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

export function createMaskCache(
  protectedDir: string,
  scanFn?: (root: string) => Promise<{ root: string; masks: Array<[string, boolean]>; collapsed: string[] }>,
) {
  let cached: { root: string; digest: string; snapshot: MaskSnapshot } | undefined;
  let inflight: Promise<MaskSnapshot> | undefined;

  function loadSecretPaths(): string[] {
    const raw = JSON.parse(readFileSync(path.join(protectedDir, 'write-guard.json'), 'utf8'));
    return Array.isArray(raw.secretPaths) ? raw.secretPaths : [];
  }

  const defaultScan = async (root: string) => {
    const { stdout } = await execFileAsync(
      '/usr/bin/python3',
      ['-I', path.join(protectedDir, 'sandbox.py'), '--scan-masks', root],
      { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as { root: string; masks: Array<[string, boolean]>; collapsed: string[] };
  };

  const runScan = scanFn ?? defaultScan;

  async function resolveSnapshot(cwd: string): Promise<MaskSnapshot> {
    const root = realpathSync(cwd);
    const secretPaths = loadSecretPaths();
    const digestBefore = computeDirSnapshotDigest(root, protectedDir, secretPaths);
    if (cached && cached.root === root && cached.digest === digestBefore) {
      return cached.snapshot;
    }
    const scanned = await runScan(root);
    const snapshot: MaskSnapshot = {
      root: scanned.root,
      masks: scanned.masks,
      collapsed: scanned.collapsed,
      payload: JSON.stringify({ root: scanned.root, masks: scanned.masks }),
    };
    const digestAfter = computeDirSnapshotDigest(root, protectedDir, secretPaths);
    if (digestAfter === digestBefore) {
      cached = { root, digest: digestAfter, snapshot };
    } else {
      cached = undefined;
    }
    return snapshot;
  }

  return {
    get(cwd: string): Promise<MaskSnapshot> {
      if (inflight) return inflight;
      const p = Promise.resolve()
        .then(() => resolveSnapshot(cwd))
        .finally(() => {
          if (inflight === p) inflight = undefined;
        });
      inflight = p;
      return p;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
