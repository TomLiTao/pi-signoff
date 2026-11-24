// This worker runs only inside bubblewrap. The host sends one tool call on stdin.
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import nodePath from 'node:path';

const base = '/opt/pi-node/lib/node_modules/@earendil-works/pi-coding-agent/dist';
const toolsBase = `${base}/core/tools`;
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// sandbox.py sets PI_PROTECTED_ACCESS=host inside the sandbox for host access mode. There only
// credential stores are private, so find and the fallback search also cover .local, .codex and .pi.
const HOST_ACCESS = process.env.PI_PROTECTED_ACCESS === 'host';
const PRIVATE_NAMES = new Set(HOST_ACCESS
  ? ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.netrc', '.git-credentials', '.git']
  : ['.git', '.pi', '.codex', '.ssh', '.gnupg', '.aws', '.kube', '.docker',
    '.config', '.local', '.cache', '.password-store', '.netrc', '.git-credentials']);
const FIND_SECRET_EXCLUDES = [
  ...PRIVATE_NAMES,
  '.env', '.env.*', '*.pem', '*.key', '*.key.*', '*.p12', '*.pfx',
];
const FIND_FALLBACK_EXCLUDES = [
  ...FIND_SECRET_EXCLUDES,
  '__pycache__',
];

const loaders = {
  bash: () => import(`${toolsBase}/bash.js`).then(m => m.createBashTool),
  edit: () => import(`${toolsBase}/edit.js`).then(m => m.createEditTool),
  find: () => import(`${toolsBase}/find.js`).then(m => m.createFindTool),
  grep: () => import(`${toolsBase}/grep.js`).then(m => m.createGrepTool),
  ls: () => import(`${toolsBase}/ls.js`).then(m => m.createLsTool),
  read: () => import(`${toolsBase}/read.js`).then(m => m.createReadTool),
  write: () => import(`${toolsBase}/write.js`).then(m => m.createWriteTool),
};

async function safeLs(cwd, params) {
  if (params !== undefined && (typeof params !== 'object' || params === null)) return null;
  const rawPath = params?.path;
  const rawLimit = params?.limit;
  if (rawPath !== undefined && typeof rawPath !== 'string') return null;
  if (rawLimit !== undefined && typeof rawLimit !== 'number') return null;

  const [{ pathExists, resolveToCwd }, { DEFAULT_MAX_BYTES, formatSize, truncateHead }] = await Promise.all([
    import(`${toolsBase}/path-utils.js`),
    import(`${toolsBase}/truncate.js`),
  ]);

  const dirPath = resolveToCwd(rawPath || '.', cwd);
  const effectiveLimit = Math.max(1, Math.floor(rawLimit ?? 500));
  if (!(await pathExists(dirPath))) {
    throw new Error(`Path not found: ${dirPath}`);
  }
  const dirStat = await stat(dirPath);
  if (!dirStat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  let entries;
  try {
    entries = await readdir(dirPath);
  } catch (e) {
    throw new Error(`Cannot read directory: ${e.message}`);
  }
  entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const results = [];
  let entryLimitReached = false;
  for (const entry of entries) {
    if (results.length >= effectiveLimit) {
      entryLimitReached = true;
      break;
    }
    const fullPath = nodePath.join(dirPath, entry);
    try {
      const entryStat = await stat(fullPath);
      results.push(entryStat.isDirectory() ? `${entry}/` : entry);
    } catch {
      // Surface broken/dangling symlinks explicitly instead of silently omitting them.
      try {
        const linkStat = await lstat(fullPath);
        if (linkStat.isSymbolicLink()) {
          let target = '';
          try {
            target = await readlink(fullPath);
          } catch {
            target = '?';
          }
          results.push(`${entry}@ -> ${target} (broken symlink)`);
        }
      } catch {
        // Skip entries that vanished or cannot be inspected.
      }
    }
  }

  if (results.length === 0) {
    return { content: [{ type: 'text', text: '(empty directory)' }], details: undefined };
  }

  const rawOutput = results.join('\n');
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details = {};
  const notices = [];
  if (entryLimitReached) {
    notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
    details.entryLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) {
    output += `\n\n[${notices.join('. ')}]`;
  }
  return {
    content: [{ type: 'text', text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

async function fastReadText(cwd, params) {
  if (!params || typeof params !== 'object' || typeof params.path !== 'string') return null;
  const { path: rawPath, offset, limit } = params;
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) return null;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) return null;

  const [{ resolveReadPathAsync }, { detectSupportedImageMimeTypeFromFile }, { DEFAULT_MAX_BYTES, formatSize, truncateHead }] =
    await Promise.all([
      import(`${toolsBase}/path-utils.js`),
      import(`${base}/utils/mime.js`),
      import(`${toolsBase}/truncate.js`),
    ]);

  const absolutePath = await resolveReadPathAsync(rawPath, cwd);
  await access(absolutePath, constants.R_OK);
  const st = await stat(absolutePath);
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
  if (await detectSupportedImageMimeTypeFromFile(absolutePath)) return null;

  const buffer = await readFile(absolutePath);
  const allLines = buffer.toString('utf-8').split('\n');
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= totalFileLines) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
  }
  const endLine = limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines);
  const truncation = truncateHead(allLines.slice(startLine, endLine).join('\n'));
  const firstLineBytes = truncation.firstLineExceedsLimit ? Buffer.byteLength(allLines[startLine], 'utf-8') : 0;
  const userLimitedLines = limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines) - startLine;

  let outputText;
  let details;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(firstLineBytes);
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${rawPath} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === 'lines') {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
    const remaining = totalFileLines - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return {
    content: [{ type: 'text', text: outputText }],
    details,
    structuredContent: outputText,
  };
}

async function safeFind(cwd, id, params) {
  if (!params || typeof params !== 'object' || typeof params.pattern !== 'string') {
    const factory = await loaders.find();
    return factory(cwd).execute(id, params);
  }
  const rawPath = params.path;
  const rawPattern = params.pattern;
  if (rawPath !== undefined && typeof rawPath !== 'string') {
    const factory = await loaders.find();
    return factory(cwd).execute(id, params);
  }
  if (params.limit !== undefined && typeof params.limit !== 'number') {
    const factory = await loaders.find();
    return factory(cwd).execute(id, params);
  }

  const [{ pathExists, resolveToCwd }, { relativizeFindResultPath }, { DEFAULT_MAX_BYTES, formatSize, truncateHead }, { ensureTool }] =
    await Promise.all([
      import(`${toolsBase}/path-utils.js`),
      import(`${toolsBase}/find.js`),
      import(`${toolsBase}/truncate.js`),
      import(`${base}/utils/tools-manager.js`),
    ]);

  const fdPath = await ensureTool('fd');
  if (!fdPath) {
    const factory = await loaders.find();
    return factory(cwd).execute(id, params);
  }

  const rootPath = nodePath.resolve(cwd);
  const searchPath = resolveToCwd(rawPath || '.', rootPath);
  const effectiveLimit = Math.max(1, Math.floor(params.limit ?? 1000));

  let insideGitRepo = false;
  for (let current = searchPath; ;) {
    if (await pathExists(nodePath.join(current, '.git'))) {
      insideGitRepo = true;
      break;
    }
    const parent = nodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const runFd = async ({ noIgnoreVcs, allowError }) => {
    let effectivePattern = rawPattern.replace(/^(?:\.\/)+/, '');
    const isPathPattern = effectivePattern.includes('/');
    const isRelativePathPattern = isPathPattern && !nodePath.isAbsolute(effectivePattern);
    const ignoreCase = effectivePattern === effectivePattern.toLowerCase();

    const args = ['--color=never', '--hidden'];
    if (noIgnoreVcs) {
      args.push('--no-ignore-vcs');
    } else if (!insideGitRepo) {
      args.push('--no-require-git');
    }
    const excludes = noIgnoreVcs ? FIND_FALLBACK_EXCLUDES : FIND_SECRET_EXCLUDES;
    for (const ex of excludes) {
      args.push('--exclude', ex);
    }
    args.push('--glob', '--max-results', String(effectiveLimit + 1));
    if (isPathPattern) args.push('--full-path');
    if (isRelativePathPattern) {
      const escapedRoot = searchPath.replace(/\/+$/, '').replace(/[\\*?[\]{}]/g, '\\$&');
      effectivePattern = `${escapedRoot}/${effectivePattern}`;
      if (ignoreCase) args.push('--ignore-case');
    }
    args.push('--', effectivePattern, searchPath);

    return await new Promise((resolve, reject) => {
      const child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const rl = createInterface({ input: child.stdout });
      const storedResults = [];
      let resultCount = 0;
      let outputBytes = 0;
      let resultLimitReached = false;
      let stderr = '';

      child.stderr?.on('data', chunk => {
        stderr += chunk.toString();
      });
      rl.on('line', rawLine => {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line) return;
        const entry = relativizeFindResultPath(line, searchPath);
        if (resultCount === effectiveLimit) {
          resultLimitReached = true;
          return;
        }
        resultCount++;
        if (outputBytes - 1 <= DEFAULT_MAX_BYTES) storedResults.push(entry);
        outputBytes += Buffer.byteLength(entry, 'utf-8') + 1;
      });
      child.on('error', err => {
        rl.close();
        reject(new Error(`Failed to run fd: ${err.message}`));
      });
      child.on('close', code => {
        rl.close();
        if (code !== 0 && resultCount === 0) {
          if (allowError) {
            resolve(null);
            return;
          }
          reject(new Error(stderr.trim() || `fd exited with code ${code}`));
          return;
        }
        if (resultCount === 0) {
          resolve({
            content: [{ type: 'text', text: 'No files found matching pattern' }],
            details: undefined,
          });
          return;
        }
        const truncation = {
          ...truncateHead(storedResults.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER }),
          totalLines: resultCount,
          totalBytes: outputBytes - 1,
        };
        let resultOutput = truncation.content;
        const details = {};
        const notices = [];
        if (resultLimitReached) {
          notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
          details.resultLimitReached = effectiveLimit;
        }
        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          details.truncation = truncation;
        }
        if (notices.length > 0) {
          resultOutput += `\n\n[${notices.join('. ')}]`;
        }
        resolve({
          content: [{ type: 'text', text: resultOutput }],
          details: Object.keys(details).length > 0 ? details : undefined,
        });
      });
    });
  };

  const initial = await runFd({ noIgnoreVcs: false, allowError: false });
  if (
    typeof rawPath !== 'string' ||
    !rawPath.trim() ||
    initial.content[0].text !== 'No files found matching pattern'
  ) {
    return initial;
  }

  const rel = nodePath.relative(rootPath, searchPath);
  if (!rel || rel === '.' || rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    return initial;
  }
  const parts = rel.split(nodePath.sep);
  if (parts.some(part => PRIVATE_NAMES.has(part))) {
    return initial;
  }
  let dirStat;
  try {
    dirStat = await stat(searchPath);
  } catch {
    return initial;
  }
  if (!dirStat.isDirectory()) return initial;

  return (await runFd({ noIgnoreVcs: true, allowError: true })) ?? initial;
}

process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { id, name, params } = JSON.parse(input);
try {
  let result;
  if (name === 'read') {
    result = await fastReadText(process.cwd(), params);
  } else if (name === 'ls') {
    result = await safeLs(process.cwd(), params);
  } else if (name === 'find') {
    result = await safeFind(process.cwd(), id, params);
  }
  if (!result) {
    const load = loaders[name];
    if (!load) throw new Error(`Unknown protected tool: ${name}`);
    const factory = await load();
    // createEditTool and createWriteTool already serialize through withFileMutationQueue internally.
    const tool = factory(process.cwd());
    result = await tool.execute(id, params);
  }
  const fullOutput = name === 'bash' ? await bashFullOutput(JSON.stringify(result)) : undefined;
  process.stdout.write(JSON.stringify({ result, ...(fullOutput ? { fullOutput } : {}) }));
} catch (error) {
  let message = String(error.message ?? error);
  if (['read', 'ls', 'find', 'grep', 'edit'].includes(name) && /ENOENT|not found|no such file/i.test(message)) {
    const hint = outsideWorkspaceHint(process.cwd(), params?.path)
      || await nearestPaths(process.cwd(), params?.path).catch(() => '');
    if (hint) message += `\n${hint}`;
  }
  const fullOutput = name === 'bash' ? await bashFullOutput(message) : undefined;
  process.stdout.write(JSON.stringify({ error: message, ...(fullOutput ? { fullOutput } : {}) }));
}

/**
 * Pi's bash tool keeps the full output of a long command in /tmp/pi-bash-*.log and names it in the
 * result, but this sandbox's /tmp is discarded when the call ends. Send the contents back so the host
 * can keep them where later calls can read them.
 */
async function bashFullOutput(text) {
  const match = /\/tmp\/pi-bash-[A-Za-z0-9]{6,64}\.log/.exec(text);
  if (!match) return undefined;
  try {
    const info = await lstat(match[0]);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return undefined;
    return { path: match[0], text: await readFile(match[0], 'utf8') };
  } catch {
    return undefined;
  }
}

/**
 * Explain a missing path outside the workspace: the sandbox mounts only part of the machine, so
 * "not found" there often means "not visible here" rather than "does not exist".
 */
function outsideWorkspaceHint(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  const wanted = nodePath.resolve(root, rawPath.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
  const rel = nodePath.relative(root, wanted);
  if (!rel.startsWith('..') && !nodePath.isAbsolute(rel)) return '';
  if (wanted === '/tmp/pi-tool-output' || wanted.startsWith('/tmp/pi-tool-output/')) {
    return 'Saved tool output exists only for the current Pi session: use the exact path given in the shortened result. Files from an earlier session are not available.';
  }
  if (wanted === '/tmp' || wanted.startsWith('/tmp/')) {
    return 'Each sandboxed tool call gets its own empty /tmp, so files written to /tmp by an earlier call no longer exist. '
      + 'Recreate the file, or keep files that later calls need inside the project folder.';
  }
  const home = process.env.HOME || '';
  if (HOST_ACCESS) {
    const homeNote = home && /^\/home\/[^/]+/.test(wanted) && !(wanted === home || wanted.startsWith(`${home}/`))
      ? ` Your home folder is ${home}.` : '';
    return `This path is outside the project folder (${root}). There the sandbox shows only /usr, a private /tmp and `
      + 'a read-only allowlist of home paths (tool runtimes, ~/.gitconfig, agent session logs); if the path exists, '
      + `it is not visible to tools.${homeNote}`;
  }
  return `This path is outside the project folder (${root}). In strict mode the sandbox shows only the project folder, `
    + '/usr and a private /tmp; your home folder and other paths are not mounted.';
}

/** Suggest up to three existing workspace paths for a missing one (same name first, then similar). */
async function nearestPaths(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  const wanted = nodePath.resolve(root, rawPath);
  const rel = nodePath.relative(root, wanted);
  if (!rel || rel.startsWith('..') || nodePath.isAbsolute(rel)) return '';
  const want = rel.split(nodePath.sep).filter(Boolean);
  const base = want[want.length - 1].toLowerCase();
  const skip = new Set([...PRIVATE_NAMES, 'node_modules', '__pycache__', '.venv', 'venv', 'site-packages', '.git']);
  const scored = [];
  const queue = [''];
  let seen = 0;
  while (queue.length && seen < 40000) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(nodePath.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const relPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !skip.has(entry.name)) queue.push(relPath);
      const name = entry.name.toLowerCase();
      const parts = relPath.split('/');
      // Score: same final name dominates; then shared trailing segments; then shared leading segments.
      let score = name === base ? 100 : name.includes(base) || base.includes(name) && name.length > 3 ? 20 : 0;
      if (!score) continue;
      for (let i = 1; i <= Math.min(parts.length, want.length); i++) {
        if (parts[parts.length - i].toLowerCase() !== want[want.length - i].toLowerCase()) break;
        score += 10;
      }
      for (let i = 0; i < Math.min(parts.length, want.length) && parts[i] === want[i]; i++) score += 3;
      score -= Math.abs(parts.length - want.length);
      scored.push([score, relPath]);
    }
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  const best = [...new Set(scored.slice(0, 3).map(item => item[1]))];
  return best.length ? `Closest existing paths: ${best.join(', ')}` : '';
}
