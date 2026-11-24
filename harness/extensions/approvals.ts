import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// Deliberately not a shell parser: accept only bare tokens and explicitly read-only options.
// Keep flags that take values, run external commands, or change mode out of this table.
const readOnlyFlags = new Map([
  ['ls', 'aAlhF1dtrSiR'], ['cat', 'AbEnstTv'], ['wc', 'clmwL'], ['head', 'qv'], ['tail', 'qv'],
  ['stat', 'fL'], ['du', 'ashc'], ['df', 'ahTi'], ['realpath', 'eL'], ['readlink', 'fem'],
]);

const DEFAULT_NEVER_SESSION_ALLOW = [
  'bash', 'sh', 'zsh', 'dash', 'env', 'xargs', 'eval', 'exec',
  'rm', 'mv', 'cp', 'kill', 'pkill', 'killall', 'awk', 'perl', 'ruby',
];

export interface BlockedCommandRule {
  match: string;
  reason: string;
  /** Enforced only under `pi --strict`; host access mode asks for approval instead. */
  strictOnly?: boolean;
}

export interface DenyArgvRule {
  kind: 'deny';
  argv: string[];
  reason?: string;
}

export interface Policy {
  askPaths: string[];
  deniedPaths: string[];
  secretPaths: string[];
  allowCommands?: string[];
  blockedCommands?: BlockedCommandRule[];
  neverSessionAllow?: string[];
  /** Script globs (e.g. `*broker*`) that ask every time and are never saved or granted upfront. */
  neverAutoScripts?: string[];
}

export function tokenizeBareCommand(command: string): string[] | null {
  if (/[^a-zA-Z0-9_./+ \t-]/.test(command)) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  return trimmed.split(/[ \t]+/);
}

export function shellNeedsApproval(command: string) {
  const tokens = tokenizeBareCommand(command);
  if (!tokens) return true;
  const [name, ...args] = tokens;
  if (['pwd', 'true', 'false'].includes(name)) return args.length !== 0;
  const allowed = readOnlyFlags.get(name);
  if (allowed === undefined) return true;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') {
      options = false;
    } else if (options && (name === 'head' || name === 'tail') && (arg === '-n' || arg === '-c')) {
      if (!/^\d+$/.test(args[++i] ?? '')) return true;
    } else if (options && arg.startsWith('-')) {
      if (arg.length === 1 || ![...arg.slice(1)].every(flag => allowed.includes(flag))) return true;
    } else if (arg === '-') return true;
  }
  return false;
}

export function loadEditPolicy(dir: string): Policy {
  const policy = JSON.parse(readFileSync(path.join(dir, 'write-guard.json'), 'utf8'));
  for (const key of ['askPaths', 'deniedPaths', 'secretPaths']) {
    if (!Array.isArray(policy[key]) || !policy[key].every((item: unknown) => typeof item === 'string')) {
      throw new Error('Invalid protected Pi path policy.');
    }
  }
  if (policy.blockedCommands !== undefined) {
    if (!Array.isArray(policy.blockedCommands) || !policy.blockedCommands.every((item: unknown) =>
      Boolean(item && typeof item === 'object' && typeof (item as BlockedCommandRule).match === 'string' && typeof (item as BlockedCommandRule).reason === 'string'))) {
      throw new Error('Invalid protected Pi blockedCommands policy.');
    }
  }
  if (policy.blockedCommands && process.env.PI_PROTECTED_ACCESS === 'host') {
    policy.blockedCommands = policy.blockedCommands.filter((item: BlockedCommandRule) => item.strictOnly !== true);
  }
  if (policy.neverAutoScripts !== undefined) {
    if (!Array.isArray(policy.neverAutoScripts) || !policy.neverAutoScripts.every((item: unknown) => typeof item === 'string')) {
      throw new Error('Invalid protected Pi neverAutoScripts policy.');
    }
  }
  if (policy.neverSessionAllow !== undefined) {
    if (!Array.isArray(policy.neverSessionAllow) || !policy.neverSessionAllow.every((item: unknown) => typeof item === 'string')) {
      throw new Error('Invalid protected Pi neverSessionAllow policy.');
    }
  }
  return policy;
}

/**
 * Expand simple anchored `blockedCommands` entries from write-guard.json into concrete
 * `{ kind: 'deny', argv, reason }` rules. Complex regex entries remain enforced alongside them.
 */
export function seedDenyRules(blockedCommands: readonly BlockedCommandRule[] = []): DenyArgvRule[] {
  const seeded: DenyArgvRule[] = [];
  const seen = new Set<string>();
  const push = (argv: string[], reason: string) => {
    if (!argv.length || argv.some(tok => !tok || /[*+?^$()[\]{}|\\]/.test(tok))) return;
    const key = JSON.stringify(argv);
    if (seen.has(key)) return;
    seen.add(key);
    seeded.push({ kind: 'deny', argv, reason });
  };

  for (const entry of blockedCommands) {
    const body = entry.match.replace(/^\^/, '').replace(/\(\s*\|\$\)$/, '').replace(/\$$/, '');
    // Pattern 1: `(a|b|c)` single-word group
    const singleGroup = /^\(([a-zA-Z0-9_./+ -]+(?:\|[a-zA-Z0-9_./+ -]+)*)\)$/.exec(body);
    if (singleGroup) {
      for (const alt of singleGroup[1].split('|')) {
        push(alt.trim().split(/\s+/), entry.reason);
      }
      continue;
    }
    // Pattern 2: `<head> (sub1|sub2|...)` or `(h1|h2) (sub1|sub2)`
    const twoGroup = /^(?:\(([a-zA-Z0-9_./+-]+(?:\|[a-zA-Z0-9_./+-]+)*)\)|([a-zA-Z0-9_./+-]+))\s+\(([a-zA-Z0-9_./+ -]+(?:\|[a-zA-Z0-9_./+ -]+)*)\)$/.exec(body);
    if (twoGroup) {
      const heads = twoGroup[1] ? twoGroup[1].split('|') : [twoGroup[2]];
      const subs = twoGroup[3].split('|');
      for (const h of heads) {
        for (const s of subs) {
          push([...h.trim().split(/\s+/), ...s.trim().split(/\s+/)], entry.reason);
        }
      }
      continue;
    }
    // Pattern 3: `python3? -m pip (install|download|uninstall)`
    const pyPip = /^python3\?\s+-m\s+pip\s+\(([a-zA-Z0-9_|-]+)\)$/.exec(body);
    if (pyPip) {
      for (const py of ['python', 'python3']) {
        for (const sub of pyPip[1].split('|')) {
          push([py, '-m', 'pip', sub], entry.reason);
        }
      }
    }
  }
  return seeded;
}

function splitShellSegments(cmd: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let quote: "'" | '"' | null = null;

  const pushWord = () => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const pushSeg = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && n !== undefined) {
        cur += n;
        i++;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && n !== undefined) {
      if (n !== '\n') {
        cur += n;
        has = true;
      }
      i++;
      continue;
    }
    if (c === '#' && !has) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      pushSeg();
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      continue;
    }
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      pushSeg();
      continue;
    }
    if ((c === '&' && n === '&') || (c === '|' && (n === '|' || n === '&'))) {
      pushSeg();
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      pushSeg();
      continue;
    }
    cur += c;
    has = true;
  }
  pushSeg();
  return segments;
}

const LEADING_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{']);

function normalizeSegmentArgv(rawWords: readonly string[]): string[] {
  let w = rawWords.slice();
  while (w.length && LEADING_KEYWORDS.has(w[0])) w = w.slice(1);
  let changed = true;
  while (changed && w.length) {
    changed = false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
      changed = true;
    } else if (w[0] === 'time' || w[0] === 'nice' || w[0] === 'command' || w[0] === 'nohup') {
      w = w.slice(1);
      changed = true;
    } else if (w[0] === 'timeout') {
      w = w.slice(1);
      while (w.length && w[0].startsWith('-')) w = w.slice(1);
      if (w.length) w = w.slice(1);
      changed = true;
    } else if (path.basename(w[0]) === 'env') {
      let idx = 1;
      while (idx < w.length && (w[idx].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[idx]))) idx++;
      if (idx < w.length) {
        w = w.slice(idx);
        changed = true;
      }
    }
  }
  if (!w.length) return w;
  if (path.basename(w[0]) === 'git') {
    const rest = w.slice(1);
    while (rest.length && rest[0].startsWith('-')) {
      const opt = rest.shift()!;
      if ((opt === '-C' || opt === '-c' || opt === '--git-dir' || opt === '--work-tree' || opt === '--namespace') && rest.length) {
        rest.shift();
      }
    }
    return [w[0], ...rest];
  }
  return w;
}

export function argvPrefixMatches(prefix: readonly string[], words: readonly string[]): boolean {
  if (!prefix.length || prefix.length > words.length) return false;
  return prefix.every((tok, idx) =>
    words[idx] === tok || (idx === 0 && !tok.includes('/') && path.basename(words[0]) === tok));
}

/**
 * Evaluate deny rules (user-saved + write-guard.json seeded + blockedCommands regexes).
 * Deny always wins over routine allowlists, saved exact rules, and saved prefix rules.
 */
export function checkShellDeny(
  command: string,
  policy?: Pick<Policy, 'blockedCommands'>,
  extraDenyRules: readonly DenyArgvRule[] = [],
): string | null {
  const blocked = policy?.blockedCommands ?? [];
  const allDeny = [...extraDenyRules, ...seedDenyRules(blocked)];
  const segments = splitShellSegments(command);

  for (const raw of segments) {
    const words = normalizeSegmentArgv(raw);
    if (!words.length) continue;
    const prog = path.basename(words[0]);

    for (const rule of allDeny) {
      if (argvPrefixMatches(rule.argv, words)) {
        return rule.reason ? `${prog}: ${rule.reason}` : `${rule.argv.join(' ')} is denied by policy`;
      }
    }

    const joined = [prog, ...words.slice(1)].join(' ');
    for (const b of blocked) {
      const rx = new RegExp(b.match);
      if (rx.test(prog) || rx.test(joined)) {
        return `${prog}: ${b.reason}`;
      }
    }

    if (prog === 'rm') {
      const flags = words.slice(1).filter(x => x.startsWith('-'));
      const r = flags.some(f => /^-[^-]*[rR]/.test(f) || f === '--recursive');
      const f = flags.some(x => /^-[^-]*f/.test(x) || x === '--force');
      if (r && f) return 'rm -rf is blocked; delete specific files instead';
    }
  }
  return null;
}

export function isAllowedPrefixArgv(
  argv: readonly string[],
  neverSessionAllow: readonly string[] = DEFAULT_NEVER_SESSION_ALLOW,
): boolean {
  if (!argv.length) return false;
  if (argv.some(tok => !tok || /[^a-zA-Z0-9_./+-]/.test(tok))) return false;
  const first = argv[0];
  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('-')) return false;
  const prog = path.basename(first);
  if (neverSessionAllow.includes(prog) || prog === 'find') return false;
  if (prog === 'python' || prog === 'python3') {
    return argv.length >= 3
      && argv[1] === '-m'
      && !argv[2].startsWith('-')
      && !['pip', 'venv', 'http.server', 'pdb', 'code', 'timeit', 'cProfile'].includes(argv[2]);
  }
  if (prog === 'node') {
    return argv.length >= 2 && argv[1] === '--test';
  }
  return true;
}

export function tokenizePrefixCommand(command: string): string[] | null {
  if (/[^a-zA-Z0-9_./+= \t-]/.test(command)) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/[ \t]+/);
  // Reject leading VAR=value assignments; `=` is only safe in argument flags after argv[0].
  if (!tokens.length || tokens[0].includes('=')) return null;
  return tokens;
}

export function prefixRuleAllows(
  ruleArgv: readonly string[],
  command: string,
  neverSessionAllow: readonly string[] = DEFAULT_NEVER_SESSION_ALLOW,
): boolean {
  if (!isAllowedPrefixArgv(ruleArgv, neverSessionAllow)) return false;
  const tokens = tokenizePrefixCommand(command);
  if (!tokens || ruleArgv.length > tokens.length) return false;
  return ruleArgv.every((tok, idx) => tokens[idx] === tok);
}

export function suggestShellPrefix(
  command: string,
  policy?: Pick<Policy, 'blockedCommands' | 'neverSessionAllow'>,
  extraDenyRules: readonly DenyArgvRule[] = [],
): string[] | null {
  const tokens = tokenizePrefixCommand(command);
  if (!tokens || tokens.length === 0) return null;
  if (checkShellDeny(command, policy, extraDenyRules) !== null) return null;

  const never = policy?.neverSessionAllow ?? DEFAULT_NEVER_SESSION_ALLOW;
  const first = tokens[0];
  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('-')) return null;
  const prog = path.basename(first);
  if (never.includes(prog) || prog === 'find') return null;

  let candidate: string[] | null = null;
  if (prog === 'python' || prog === 'python3') {
    if (tokens.length >= 3 && tokens[1] === '-m' && !tokens[2].startsWith('-')) {
      candidate = tokens.slice(0, 3);
    }
  } else if (prog === 'node') {
    if (tokens.length >= 2 && tokens[1] === '--test') {
      candidate = tokens.slice(0, 2);
    }
  } else if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') {
    if (tokens.length >= 3 && tokens[1] === 'run' && !tokens[2].startsWith('-')) {
      candidate = tokens.slice(0, 3);
    } else if (tokens.length >= 2 && !tokens[1].startsWith('-')) {
      candidate = tokens.slice(0, 2);
    }
  } else if (['cargo', 'go', 'git', 'uv', 'ruff', 'make', 'npx'].includes(prog)) {
    if (tokens.length >= 2 && !tokens[1].startsWith('-')) {
      candidate = tokens.slice(0, 2);
    }
  } else {
    candidate = [first];
  }

  if (!candidate || !isAllowedPrefixArgv(candidate, never)) return null;
  return candidate;
}

export function editDecision(cwd: string, input: string, policy: Policy): 'allow' | 'ask' | 'deny' {
  // Match Pi's @ prefix and Unicode-space normalization. Be conservative with ambiguous paths.
  const normalized = input.replace(/^@/, '').replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (!normalized || normalized.startsWith('~') || normalized.startsWith('file://')) return 'deny';
  const relative = path.relative(cwd, path.resolve(cwd, normalized));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return 'deny';
  const parts = relative.split('/');
  if (parts.includes('.git') || parts.some(part => policy.secretPaths.some(glob => path.matchesGlob(part, glob))) ||
      policy.deniedPaths.some(glob => path.matchesGlob(relative, glob))) return 'deny';
  if (parts.some((_, i) => {
    const suffix = parts.slice(i).join('/');
    return policy.askPaths.some(glob => path.matchesGlob(suffix, glob) ||
      (glob.endsWith('/**') && suffix === glob.slice(0, -3)));
  })) return 'ask';

  // Do not silently approve a write through a link, including a dangling symlink.
  let parent = cwd;
  for (const part of parts) {
    parent = path.join(parent, part);
    try {
      if (lstatSync(parent).isSymbolicLink()) return 'ask';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return 'ask';
    }
  }
  return 'allow';
}

export function visible(value: string) {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    char => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

export interface ScriptRememberOption {
  /** Display form, e.g. `python3 backtest.py …`. */
  label: string;
  /** A saved rule exists for this script but its content (or a local import) changed since. */
  changed: boolean;
  save: () => void;
}

export interface PrefixRememberOption {
  label: string;
  save: () => void;
}

export const APPROVAL_TIMEOUT_MS = 60_000;

/**
 * Why the last askApproval call returned false. A prompt that times out is not a refusal: the model
 * must be told so, or it reports that the user rejected something they never answered.
 */
export type ApprovalMiss = 'denied' | 'timeout' | 'no-ui' | 'aborted' | 'too-long';
let lastMiss: ApprovalMiss = 'denied';
export function lastApprovalMiss(): ApprovalMiss {
  return lastMiss;
}

/** The message for a refused or unanswered shell approval; `detail` goes in brackets. */
export function shellNotApprovedMessage(miss: ApprovalMiss, detail?: string): string {
  const extra = detail ? ` (${detail})` : '';
  if (miss === 'timeout') {
    return `Shell command not run: the approval prompt got no answer within ${APPROVAL_TIMEOUT_MS / 1000} s${extra}. The user did not refuse it. Do not report it as rejected; continue without it or ask the user whether to run it.`;
  }
  if (miss === 'too-long') {
    return `Shell command not run: it is too long to show in full for approval${extra}. Split it into shorter, independent commands.`;
  }
  return `Shell command not approved${extra}. Do not retry without user approval.`;
}

export async function askApproval(
  ctx: ExtensionContext,
  action: string,
  value: string,
  remember?: () => void,
  rememberPrefix?: PrefixRememberOption,
  rememberScript?: ScriptRememberOption,
  warning?: string,
) {
  lastMiss = 'denied';
  if (!ctx.hasUI || ctx.signal?.aborted) {
    lastMiss = ctx.hasUI ? 'aborted' : 'no-ui';
    return false;
  }
  const display = visible(value);
  if (display.length > 1200) {
    // Avoid approving partially displayed input. Request shorter, independent calls instead.
    lastMiss = 'too-long';
    return false;
  }
  const always = 'Always allow this command for this project';
  const prefixLabel = rememberPrefix ? `Always allow ${visible(`${rememberPrefix.label} …`)} in this project` : undefined;
  const scriptLabel = rememberScript
    ? `${rememberScript.changed ? 'Re-approve' : 'Always allow'} ${visible(rememberScript.label)} with any arguments while it is unchanged`
    : undefined;
  const options = ['Deny', 'Allow once'];
  if (scriptLabel) options.push(scriptLabel);
  if (prefixLabel) options.push(prefixLabel);
  if (remember) options.push(always);
  const notes: string[] = warning ? [warning] : [];
  if (rememberScript?.changed) {
    notes.push('The script or a local module it imports changed since you approved it, so it asks again.');
  }
  if (remember || rememberPrefix) {
    notes.push('Saved command and prefix rules run without asking, even if project scripts change.');
  }
  if (rememberScript) {
    notes.push('A script rule stops matching as soon as the script or a local module it imports changes.');
  }
  const manage = remember || rememberPrefix || rememberScript ? ' Manage with /permissions.' : '';
  const note = notes.length ? `\n${notes.join('\n')}${manage}` : '';
  const shownAt = Date.now();
  const choice = await ctx.ui.select(`${action} in ${visible(ctx.cwd)}?\n${display}${note}`, options,
    { timeout: APPROVAL_TIMEOUT_MS, signal: ctx.signal });
  if (ctx.signal?.aborted) {
    lastMiss = 'aborted';
    return false;
  }
  if (choice === undefined && Date.now() - shownAt >= APPROVAL_TIMEOUT_MS - 1_000) lastMiss = 'timeout';
  if (scriptLabel && choice === scriptLabel && rememberScript) {
    rememberScript.save();
    return true;
  }
  if (prefixLabel && choice === prefixLabel && rememberPrefix) {
    rememberPrefix.save();
    return true;
  }
  if (choice === always && remember) {
    remember();
    return true;
  }
  return choice === 'Allow once';
}
