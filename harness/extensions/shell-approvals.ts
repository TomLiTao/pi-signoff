import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { checkScriptGrants, makeScriptGrant, type ScriptGrant, type ScriptGrantStatus } from './script-grants.ts';
import {
  checkShellDeny,
  isAllowedPrefixArgv,
  prefixRuleAllows,
  seedDenyRules,
  tokenizeBareCommand,
  visible,
  type DenyArgvRule,
  type Policy,
} from './approvals.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const idPattern = /^[a-f0-9]{64}$/;
const recordLimit = 8192;

export type StoredShellRule =
  | { kind: 'exact'; command: string }
  | { kind: 'prefix'; argv: string[] }
  | { kind: 'script'; interpreter: string; script: string; fingerprint: string }
  | { kind: 'deny'; argv: string[]; reason?: string };

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.length > 0 && val.every(item => typeof item === 'string' && item.length > 0);
}

function parseStoredRule(rawText: string, expectedId: string): StoredShellRule {
  if (hash(rawText) !== expectedId) {
    throw new Error('Shell approval record does not match its ID.');
  }
  const parsed = JSON.parse(rawText);
  if (typeof parsed === 'string') {
    if (JSON.stringify(parsed) !== rawText) {
      throw new Error('Shell approval record is not canonical.');
    }
    return { kind: 'exact', command: parsed };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as { kind?: unknown; argv?: unknown; reason?: unknown; interpreter?: unknown; script?: unknown; fingerprint?: unknown };
    if (obj.kind === 'script' && typeof obj.interpreter === 'string' && typeof obj.script === 'string' &&
        typeof obj.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(obj.fingerprint)) {
      const canonical = JSON.stringify({ kind: 'script', interpreter: obj.interpreter, script: obj.script, fingerprint: obj.fingerprint });
      if (canonical !== rawText) throw new Error('Script rule record is not canonical.');
      return { kind: 'script', interpreter: obj.interpreter, script: obj.script, fingerprint: obj.fingerprint };
    }
    if (obj.kind === 'prefix' && isStringArray(obj.argv)) {
      const canonical = JSON.stringify({ kind: 'prefix', argv: obj.argv });
      if (canonical !== rawText) throw new Error('Prefix rule record is not canonical.');
      return { kind: 'prefix', argv: obj.argv };
    }
    if (obj.kind === 'deny' && isStringArray(obj.argv) && (obj.reason === undefined || typeof obj.reason === 'string')) {
      const canonical = JSON.stringify(
        obj.reason !== undefined ? { kind: 'deny', argv: obj.argv, reason: obj.reason } : { kind: 'deny', argv: obj.argv },
      );
      if (canonical !== rawText) throw new Error('Deny rule record is not canonical.');
      return obj.reason !== undefined
        ? { kind: 'deny', argv: obj.argv, reason: obj.reason }
        : { kind: 'deny', argv: obj.argv };
    }
  }
  throw new Error('Invalid shell approval rule payload.');
}

export function shellApprovalStore(dir: string, cwd: string) {
  const root = realpathSync(cwd);
  const storage = path.join(realpathSync(dir), 'shell-approvals');
  const relative = path.relative(root, storage);
  if (!relative.startsWith('../') && !path.isAbsolute(relative)) {
    throw new Error('Shell approval store must be outside the workspace.');
  }
  const prefix = `${hash(root)}-`;
  const record = (id: string) => path.join(storage, `${prefix}${id}.json`);

  function hasStorage(create = false) {
    if (create) {
      try { mkdirSync(storage, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    try {
      const st = lstatSync(storage);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
        throw new Error('Shell approval store must be a private user-owned directory.');
      }
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  function readRule(id: string): StoredShellRule | undefined {
    try {
      const fd = openSync(record(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 ||
            st.size > recordLimit) throw new Error('Invalid shell approval file.');
        const bytes = Buffer.alloc(recordLimit + 1);
        let size = 0;
        while (size < bytes.length) {
          const n = readSync(fd, bytes, size, bytes.length - size, null);
          if (!n) break;
          size += n;
        }
        if (size > recordLimit) throw new Error('Shell approval file is too large.');
        const rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        return parseStoredRule(rawText, id);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  function writeSerialized(data: string) {
    if (Buffer.byteLength(data) > recordLimit) throw new Error('Shell rule is too long to save.');
    if (!hasStorage(true)) throw new Error('Shell approval store is unavailable.');
    const file = record(hash(data));
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    try { renameSync(temp, file); } finally { rmSync(temp, { force: true }); }
  }

  function ids() {
    if (!hasStorage()) return [];
    return readdirSync(storage).filter(file => file.startsWith(prefix) && file.endsWith('.json'))
      .map(file => file.slice(prefix.length, -5)).filter(id => idPattern.test(id)).sort();
  }

  function validRules(): Array<{ id: string; rule: StoredShellRule }> {
    const out: Array<{ id: string; rule: StoredShellRule }> = [];
    for (const id of ids()) {
      try {
        const rule = readRule(id);
        if (rule) out.push({ id, rule });
      } catch {
        // Ignore damaged entries during matching; they still appear in list() for revocation.
      }
    }
    return out;
  }

  return {
    inProject: (candidate: string) => realpathSync(candidate) === root,
    allows(command: string) {
      try {
        if (!hasStorage()) return false;
        const rule = readRule(hash(JSON.stringify(command)));
        return rule?.kind === 'exact' && rule.command === command;
      } catch {
        // If the store is invalid, fall back to an explicit one-time approval.
        return false;
      }
    },
    allowsPrefix(command: string, neverSessionAllow?: readonly string[]) {
      try {
        if (!hasStorage()) return false;
        for (const { rule } of validRules()) {
          if (rule.kind === 'prefix' && prefixRuleAllows(rule.argv, command, neverSessionAllow)) {
            return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    scriptGrants(): ScriptGrant[] {
      try {
        if (!hasStorage()) return [];
        return validRules()
          .map(item => item.rule)
          .filter((rule): rule is Extract<StoredShellRule, { kind: 'script' }> => rule.kind === 'script')
          .map(({ interpreter, script, fingerprint }) => ({ interpreter, script, fingerprint }));
      } catch {
        return [];
      }
    },
    /** 'match' when a saved script rule covers the command at the script's current content. */
    scriptStatus(command: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>): ScriptGrantStatus {
      try {
        return checkScriptGrants(command, root, this.scriptGrants(), policy);
      } catch {
        return 'none';
      }
    },
    allowsScript(command: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>) {
      return this.scriptStatus(command, policy) === 'match';
    },
    /** Save (or re-pin) a script rule for the command's script at its current content. */
    addScript(command: string, policy?: Partial<Pick<Policy, 'secretPaths' | 'deniedPaths'>>, pinned?: ScriptGrant) {
      // Prefer the fingerprint taken when the user was shown the prompt, so a change made while
      // the prompt was open is not silently approved.
      const current = makeScriptGrant(command, root, policy);
      if (!current) throw new Error('This command cannot be saved as a script rule.');
      const grant = pinned && pinned.interpreter === current.interpreter && pinned.script === current.script
        ? { ...current, fingerprint: pinned.fingerprint }
        : current;
      for (const { id, rule } of validRules()) {
        if (rule.kind === 'script' && rule.interpreter === grant.interpreter && rule.script === grant.script) {
          rmSync(record(id), { force: true });
        }
      }
      writeSerialized(JSON.stringify({ kind: 'script', interpreter: grant.interpreter, script: grant.script, fingerprint: grant.fingerprint }));
      return grant;
    },
    denyRules(): DenyArgvRule[] {
      try {
        if (!hasStorage()) return [];
        return validRules()
          .map(item => item.rule)
          .filter((rule): rule is DenyArgvRule => rule.kind === 'deny');
      } catch {
        return [];
      }
    },
    evaluate(command: string, policy?: Pick<Policy, 'blockedCommands' | 'neverSessionAllow'>):
      | { decision: 'deny'; reason: string }
      | { decision: 'allow'; kind: 'saved-exact' | 'saved-prefix' | 'saved-script' }
      | { decision: 'ask' } {
      const denyReason = checkShellDeny(command, policy, this.denyRules());
      if (denyReason) return { decision: 'deny', reason: denyReason };
      if (this.allows(command)) return { decision: 'allow', kind: 'saved-exact' };
      if (this.allowsPrefix(command, policy?.neverSessionAllow)) {
        return { decision: 'allow', kind: 'saved-prefix' };
      }
      if (this.allowsScript(command, policy as Partial<Policy> | undefined)) {
        return { decision: 'allow', kind: 'saved-script' };
      }
      return { decision: 'ask' };
    },
    add(command: string) {
      writeSerialized(JSON.stringify(command));
    },
    addPrefix(argv: readonly string[], neverSessionAllow?: readonly string[]) {
      if (!isAllowedPrefixArgv(argv, neverSessionAllow)) {
        throw new Error('This command cannot be saved as a prefix rule.');
      }
      writeSerialized(JSON.stringify({ kind: 'prefix', argv: [...argv] }));
    },
    addDeny(argv: readonly string[], reason?: string) {
      if (!argv.length || argv.some(tok => !tok || /[^a-zA-Z0-9_./+-]/.test(tok))) {
        throw new Error('Deny rule requires bare command tokens.');
      }
      const payload = reason !== undefined
        ? { kind: 'deny' as const, argv: [...argv], reason }
        : { kind: 'deny' as const, argv: [...argv] };
      writeSerialized(JSON.stringify(payload));
    },
    list() {
      return ids().map(id => {
        // A damaged entry should still be visible and revocable by ID.
        try {
          const rule = readRule(id);
          return {
            id,
            command: rule?.kind === 'exact' ? rule.command : undefined,
            rule,
          };
        } catch {
          return { id, command: undefined, rule: undefined };
        }
      });
    },
    revoke(id: string) {
      const matches = ids().filter(candidate => candidate.startsWith(id));
      if (matches.length > 1) throw new Error('Ambiguous approval ID; use more digits.');
      if (!matches.length) return false;
      rmSync(record(matches[0]), { force: true });
      return true;
    },
  };
}

export interface PermissionsCommandOptions {
  getPolicy?: () => Policy | undefined;
  getMode?: (cwd: string) => string;
  getPlanGrant?: () => string | undefined;
  clearPlanGrant?: () => boolean;
  getRejectedSummary?: (cwd: string) => string | undefined;
  handleRejectedSubcommand?: (subArgs: string, ctx: unknown) => Promise<void>;
  neverAuto?: {
    list(cwd: string): { builtIn: readonly string[]; project: readonly string[] };
    update(cwd: string, glob: string, add: boolean): readonly string[];
  };
}

export function registerShellApprovals(
  pi: ExtensionAPI,
  dir: string,
  options: PermissionsCommandOptions = {},
) {
  const store = shellApprovalStore(dir, process.cwd());

  function formatPermissionsReport(cwd: string): string {
    const entries = store.list();
    const policy = options.getPolicy?.();
    const mode = options.getMode?.(cwd);
    const hasExtendedContext = Boolean(policy || mode);

    if (!hasExtendedContext) {
      return entries.length
        ? `Saved commands for this launch folder:\n${entries.map(({ id, rule }) => {
          if (!rule) return `${id.slice(0, 12)}  (unreadable)`;
          if (rule.kind === 'exact') return `${id.slice(0, 12)}  ${visible(rule.command)}`;
          if (rule.kind === 'prefix') return `${id.slice(0, 12)}  prefix ${visible(`${rule.argv.join(' ')} …`)}`;
          if (rule.kind === 'script') return `${id.slice(0, 12)}  script ${visible(`${rule.interpreter} ${rule.script} …`)} (while unchanged)`;
          return `${id.slice(0, 12)}  deny ${visible(rule.argv.join(' '))}`;
        }).join('\n')}`
        : 'No saved shell approvals for this launch folder.';
    }

    const exactLines: string[] = [];
    const prefixLines: string[] = [];
    const scriptLines: string[] = [];
    const savedDenyLines: string[] = [];
    const damagedLines: string[] = [];

    for (const { id, rule } of entries) {
      const short = id.slice(0, 12);
      if (!rule) damagedLines.push(`  ${short}  (unreadable)`);
      else if (rule.kind === 'exact') exactLines.push(`  ${short}  ${visible(rule.command)}`);
      else if (rule.kind === 'prefix') prefixLines.push(`  ${short}  ${visible(`${rule.argv.join(' ')} …`)}`);
      else if (rule.kind === 'script') {
        const state = store.scriptStatus(`${rule.interpreter} ${rule.script}`, policy) === 'match' ? 'unchanged' : 'changed since approval; will ask again';
        scriptLines.push(`  ${short}  ${visible(`${rule.interpreter} ${rule.script} …`)} (${state})`);
      }
      else savedDenyLines.push(`  ${short}  ${visible(rule.argv.join(' '))}${rule.reason ? ` (${rule.reason})` : ''}`);
    }

    const seededDeny = seedDenyRules(policy?.blockedCommands ?? []);
    const seededPreview = seededDeny.slice(0, 10).map(r => r.argv.join(' ')).join(', ')
      + (seededDeny.length > 10 ? `, … (+${seededDeny.length - 10} more from write-guard.json)` : '');
    const askPaths = policy?.askPaths ?? [];

    const planGrant = options.getPlanGrant?.();
    const rejectedSummary = options.getRejectedSummary?.(cwd);
    const sections: string[] = [];
    if (mode) sections.push(`Current mode: ${mode} (cycle with Ctrl+Alt+Y or /mode cycle)`);
    if (planGrant !== undefined) {
      sections.push(
        `Active plan permissions (auto-cleared when plan ends):${planGrant === 'none' ? ' none' : planGrant}`,
      );
    }
    if (rejectedSummary) {
      sections.push(rejectedSummary);
    }
    sections.push(`Saved exact rules (${exactLines.length}):${exactLines.length ? `\n${exactLines.join('\n')}` : ' none'}`);
    sections.push(`Saved prefix rules (${prefixLines.length}):${prefixLines.length ? `\n${prefixLines.join('\n')}` : ' none'}`);
    sections.push(`Saved script rules — any arguments while the script and its local imports are unchanged (${scriptLines.length}):${scriptLines.length ? `\n${scriptLines.join('\n')}` : ' none'}`);
    sections.push(
      `Deny rules (always win — ${savedDenyLines.length} custom, ${seededDeny.length} seeded):`
      + (savedDenyLines.length ? `\n${savedDenyLines.join('\n')}` : '')
      + (seededPreview ? `\n  built-in: ${seededPreview}` : ''),
    );
    if (damagedLines.length) {
      sections.push(`Damaged records (${damagedLines.length}):\n${damagedLines.join('\n')}`);
    }
    if (askPaths.length) {
      sections.push(`Sensitive paths (askPaths, ${askPaths.length}): ${askPaths.join(', ')}`);
    }
    const neverAuto = options.neverAuto?.list(cwd);
    if (neverAuto) {
      sections.push(`Never-auto scripts (ask every run; no saved rule, plan grant, or autonomy applies): ${[...neverAuto.builtIn].join(', ') || 'none'} (built-in)` +
        (neverAuto.project.length ? `, ${neverAuto.project.join(', ')} (this project)` : ''));
    }
    sections.push('Manage: /permissions never-auto add|remove <glob> | /permissions review | /permissions revoke <id> | /permissions deny <command prefix> | /permissions clear-plan');
    return sections.join('\n');
  }

  async function handleCommand(args: string, ctx: { cwd: string; ui: { notify: (msg: string, level?: 'info' | 'warning' | 'error') => void } }) {
    try {
      if (!store.inProject(ctx.cwd)) throw new Error('Open Pi in the folder whose permissions you want to manage.');
      const value = args.trim();
      if (!value || value === 'list') {
        ctx.ui.notify(formatPermissionsReport(ctx.cwd), 'info');
        return;
      }
      if (value === 'clear-plan' || value === 'revoke-plan') {
        const cleared = options.clearPlanGrant?.() ?? false;
        ctx.ui.notify(
          cleared ? 'Cleared active plan permissions.' : 'No active plan permissions to clear.',
          'info',
        );
        return;
      }
      if (options.handleRejectedSubcommand) {
        if (value === 'review' || value === 'rejected') {
          await options.handleRejectedSubcommand('review', ctx);
          return;
        }
        const rejSubMatch = /^rejected\s+(.+)$/i.exec(value);
        if (rejSubMatch) {
          await options.handleRejectedSubcommand(rejSubMatch[1], ctx);
          return;
        }
        if (value === 'clear-rejected') {
          await options.handleRejectedSubcommand('clear', ctx);
          return;
        }
        const approveRejMatch = /^approve-rejected(?:\s+(.+))?$/i.exec(value);
        if (approveRejMatch) {
          await options.handleRejectedSubcommand(`approve ${approveRejMatch[1] ?? ''}`.trim(), ctx);
          return;
        }
      }
      const neverAutoMatch = /^never-auto(?:\s+(list|add|remove)(?:\s+(\S+))?)?$/.exec(value);
      if (neverAutoMatch) {
        if (!options.neverAuto) throw new Error('Never-auto patterns are unavailable here.');
        const [, action = 'list', glob] = neverAutoMatch;
        if (action !== 'list') {
          if (!glob) throw new Error(`Usage: /permissions never-auto ${action} <glob>`);
          options.neverAuto.update(ctx.cwd, glob, action === 'add');
        }
        const { builtIn, project } = options.neverAuto.list(ctx.cwd);
        ctx.ui.notify(
          `Never-auto scripts ask on every run, even with Auto (Medium), saved rules, or plan grants.\n` +
          `Built-in (write-guard.json): ${builtIn.join(', ') || 'none'}\n` +
          `This project: ${project.join(', ') || 'none'} (/permissions never-auto add|remove <glob>)`,
          'info',
        );
        return;
      }
      const revokeMatch = /^revoke\s+([a-f0-9]{12,64})$/.exec(value);
      if (revokeMatch) {
        ctx.ui.notify(store.revoke(revokeMatch[1]) ? 'Permission rule revoked.' : 'No matching rule.', 'info');
        return;
      }
      const denyMatch = /^deny\s+(.+)$/.exec(value);
      if (denyMatch) {
        const argv = tokenizeBareCommand(denyMatch[1]);
        if (!argv) throw new Error('Deny rule must use bare command tokens without shell metacharacters.');
        store.addDeny(argv, 'denied by user rule');
        ctx.ui.notify(`Deny rule saved for ${visible(argv.join(' '))}.`, 'info');
        return;
      }
      ctx.ui.notify('Usage: /permissions [list | review | never-auto [add|remove <glob>] | rejected [list|approve <id|all>|clear] | revoke <id> | deny <command prefix> | clear-plan]', 'warning');
    } catch (error) {
      ctx.ui.notify((error as Error).message, 'warning');
    }
  }

  pi.registerCommand('permissions', {
    description: 'View permission mode, saved exact/prefix/deny rules, and askPaths: /permissions [list | revoke <id> | deny <prefix>]',
    handler: handleCommand,
  });
  pi.registerCommand('approvals', {
    description: 'Alias for /permissions: review or revoke saved shell rules',
    handler: handleCommand,
  });

  return store;
}
