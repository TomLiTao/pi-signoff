import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visible } from './approvals.ts';

const skillMdName = 'SKILL.md';
const validSkillName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const maxFileBytes = 128 * 1024;
const maxSkillFiles = 48;
const maxStoreBytes = 128 * 1024;
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

function readRegular(file: string, limit: number, privateFile = false): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > limit ||
        (privateFile && (st.mode & 0o077) !== 0)) {
      throw new Error('Expected a small, user-owned regular file without symlinks or hardlinks.');
    }
    const buf = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    if (total > limit) throw new Error('Skill file exceeds size limit.');
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

function parseSkillDescription(markdown: string, fallbackName: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (fm) {
    const descMatch = /^description:\s*(.+)$/m.exec(fm[1]);
    if (descMatch) return descMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, 240);
  }
  const firstPara = normalized
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#'));
  return (firstPara ?? `Skill ${fallbackName}`).slice(0, 240);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface SkillSnapshot {
  name: string;
  hostDir: string;
  skillMdPath: string;
  description: string;
  source: 'user' | 'project';
  files: Record<string, string>; // relPosix -> sha256
  previewText: string;
}

export interface SkillsOptions {
  dir: string;
  enabled: boolean;
  secretPaths: string[];
  userSkillsDir?: string;
  codexSkillsDir?: string;
}

export interface SkillsHandle {
  activeSkillMounts(): Array<[string, string]>;
  summary(): { enabled: boolean; activeCount: number; promptBytes: number; names: string[] };
}

export function registerSkills(pi: ExtensionAPI, options: SkillsOptions): SkillsHandle {
  const launch = realpathSync(process.cwd());
  const storage = path.join(realpathSync(options.dir), 'trusted-skills');
  const storeRecord = path.join(storage, `${sha256(launch)}.json`);
  const relStorage = path.relative(launch, storage);
  const external = relStorage.startsWith('../') || path.isAbsolute(relStorage);

  const explicitUserDir = options.userSkillsDir || process.env.PI_PROTECTED_SKILLS_DIR;
  const primaryUserRoot = explicitUserDir
    ? path.resolve(explicitUserDir)
    : path.join(os.homedir(), '.config/pi-protected/skills');
  const codexUserRoot = options.codexSkillsDir
    ? path.resolve(options.codexSkillsDir)
    : (!explicitUserDir ? path.join(os.homedir(), '.codex/skills') : undefined);
  const userRoots = [primaryUserRoot, ...(codexUserRoot ? [codexUserRoot] : [])];
  const projectSkillsRoot = path.join(launch, '.agents', 'skills');

  const warnedChanged = new Set<string>();
  let lastPromptBytes = 0;

  function matchesSecret(relPosix: string): boolean {
    const base = path.posix.basename(relPosix);
    return options.secretPaths.some(glob => path.matchesGlob(relPosix, glob) || path.matchesGlob(base, glob));
  }

  function checkStorage(create: boolean) {
    if (!external) throw new Error('Skill trust store must reside outside the workspace.');
    if (create) {
      try { mkdirSync(storage, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const st = lstatSync(storage);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      throw new Error('Skill trust store must be a private 0700 user-owned directory.');
    }
  }

  function loadApprovedSkills(): Record<string, Record<string, string>> {
    try {
      checkStorage(false);
      const raw = JSON.parse(readRegular(storeRecord, maxStoreBytes, true).toString('utf8')) as {
        skills?: Record<string, Record<string, unknown>>;
      };
      const out: Record<string, Record<string, string>> = {};
      if (raw?.skills && typeof raw.skills === 'object') {
        for (const [skillName, manifest] of Object.entries(raw.skills)) {
          if (!validSkillName.test(skillName) || !manifest || typeof manifest !== 'object') continue;
          const clean: Record<string, string> = {};
          for (const [relFile, hash] of Object.entries(manifest)) {
            if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) clean[relFile] = hash;
          }
          if (clean[skillMdName]) out[skillName] = clean;
        }
      }
      return out;
    } catch (err) {
      if (missing(err)) return {};
      throw err;
    }
  }

  function saveApprovedSkills(skills: Record<string, Record<string, string>>) {
    checkStorage(true);
    const tmp = `${storeRecord}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, storeRecord);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  function inspectSkillDir(skillDir: string, name: string, source: 'user' | 'project'): SkillSnapshot {
    if (!validSkillName.test(name)) throw new Error(`Invalid skill name: ${name}`);
    const dirStat = lstatSync(skillDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.()) {
      throw new Error(`Skill directory ${name} must be a user-owned non-symlink directory.`);
    }
    const files: Record<string, string> = {};
    const previews: string[] = [];
    let fileCount = 0;

    const walk = (folder: string, depth: number) => {
      if (depth > 5) throw new Error(`Skill ${name} directory nesting is too deep.`);
      const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new Error(`Skill ${name} cannot contain symlinks (${entry.name}).`);
        }
        const full = path.join(folder, entry.name);
        const relPosix = path.relative(skillDir, full).split(path.sep).join('/');
        if (matchesSecret(relPosix)) {
          throw new Error(`Skill ${name} contains protected/secret filename: ${relPosix}`);
        }
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          fileCount++;
          if (fileCount > maxSkillFiles) throw new Error(`Skill ${name} exceeds ${maxSkillFiles}-file limit.`);
          const bytes = readRegular(full, maxFileBytes, false);
          files[relPosix] = sha256(bytes);
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n/g, '\n');
          previews.push(`=== ${relPosix} ===\n${text}`);
        } else {
          throw new Error(`Skill ${name} contains unsupported special file: ${relPosix}`);
        }
      }
    };

    walk(skillDir, 1);
    if (!files[skillMdName]) throw new Error(`Skill ${name} is missing ${skillMdName}.`);

    const mdText = new TextDecoder('utf-8', { fatal: true })
      .decode(readRegular(path.join(skillDir, skillMdName), maxFileBytes, false))
      .replace(/\r\n/g, '\n');
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(mdText.replace(/[\n\t]/g, ''))) {
      throw new Error(`Skill ${name} ${skillMdName} contains hidden control characters.`);
    }

    return {
      name,
      hostDir: realpathSync(skillDir),
      skillMdPath: path.join(realpathSync(skillDir), skillMdName),
      description: parseSkillDescription(mdText, name),
      source,
      files,
      previewText: previews.join('\n\n'),
    };
  }

  function manifestsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, idx) => k === bKeys[idx] && a[k] === b[k]);
  }

  function scanCandidates(root: string, source: 'user' | 'project'): Array<{ name: string; dir: string }> {
    try {
      const st = lstatSync(root);
      if (!st.isDirectory() || st.isSymbolicLink()) return [];
    } catch {
      return [];
    }
    return readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.isSymbolicLink() && validSkillName.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, dir: path.join(root, e.name) }));
  }

  function resolveActiveSkills(ctx?: ExtensionContext): SkillSnapshot[] {
    if (!options.enabled) return [];
    const active = new Map<string, SkillSnapshot>();

    // 1. User skills (~/.config/pi-protected/skills/<name> and fallback ~/.codex/skills/<name>)
    for (const rootDir of userRoots) {
      const userRel = path.relative(launch, rootDir);
      const userOutsideWorkspace = userRel.startsWith('../') || path.isAbsolute(userRel);
      if (!userOutsideWorkspace) continue;
      for (const item of scanCandidates(rootDir, 'user')) {
        if (active.has(item.name)) continue; // Primary user root wins on name collision
        try {
          const snap = inspectSkillDir(item.dir, item.name, 'user');
          active.set(snap.name, snap);
        } catch {
          // Invalid user skill skipped
        }
      }
    }

    // 2. Hash-pinned project skills (<launch>/.agents/skills/<name>)
    let approved: Record<string, Record<string, string>> = {};
    try {
      approved = loadApprovedSkills();
    } catch {
      approved = {};
    }
    for (const item of scanCandidates(projectSkillsRoot, 'project')) {
      if (active.has(item.name)) continue; // User skill takes precedence on name collision
      const pinned = approved[item.name];
      if (!pinned) continue;
      try {
        const snap = inspectSkillDir(item.dir, item.name, 'project');
        if (!manifestsMatch(snap.files, pinned)) {
          if (!warnedChanged.has(item.name)) {
            warnedChanged.add(item.name);
            ctx?.ui?.notify?.(
              `Project skill ${visible(item.name)} changed since approval and was not loaded. Review with /skills trust.`,
              'warning',
            );
          }
          continue;
        }
        active.set(snap.name, snap);
      } catch {
        if (!warnedChanged.has(item.name)) {
          warnedChanged.add(item.name);
          ctx?.ui?.notify?.(
            `Project skill ${visible(item.name)} failed verification and was not loaded.`,
            'warning',
          );
        }
      }
    }

    return [...active.values()];
  }

  function renderSkillsPrompt(skills: SkillSnapshot[]): string {
    if (skills.length === 0) return '';
    const lines = [
      'The following skills provide specialized instructions and sandboxed helper files.',
      'Use pi_safe_read to load /opt/pi-skills/<name>/SKILL.md when a task matches its description, and resolve any bundled relative scripts against /opt/pi-skills/<name>/.',
      '',
      '<available_skills>',
    ];
    for (const s of skills) {
      lines.push(
        `  <skill>`,
        `    <name>${escapeXml(s.name)}</name>`,
        `    <description>${escapeXml(s.description)}</description>`,
        `    <location>/opt/pi-skills/${escapeXml(s.name)}/SKILL.md</location>`,
        `  </skill>`,
      );
    }
    lines.push('</available_skills>');
    return lines.join('\n');
  }

  pi.on('resources_discover', (_event, ctx) => {
    if (!options.enabled) return;
    try {
      if (realpathSync(ctx.cwd) !== launch) return;
      const skills = resolveActiveSkills(ctx);
      if (skills.length === 0) return;
      return { skillPaths: skills.map(s => s.skillMdPath) };
    } catch {
      return;
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    lastPromptBytes = 0;
    if (!options.enabled) return;
    try {
      if (realpathSync(ctx.cwd) !== launch) return;
      const skills = resolveActiveSkills(ctx);
      if (skills.length === 0) return;
      const rendered = renderSkillsPrompt(skills);
      lastPromptBytes = Buffer.byteLength(rendered, 'utf8');
      (event.systemPromptOptions.sections ??= {}).skills = rendered;
    } catch {
      // Never load unverified skills.
    }
  });

  pi.registerCommand('skills', {
    description: 'Inspect user skills and review/trust project skills (.agents/skills): /skills [status | trust | revoke [name]]',
    async handler(raw, ctx: ExtensionCommandContext) {
      if (realpathSync(ctx.cwd) !== launch) {
        ctx.ui.notify('Run /skills from the launch folder.', 'warning');
        return;
      }
      if (!options.enabled) {
        ctx.ui.notify('Skills are disabled for this session (--no-skills).', 'info');
        return;
      }
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed === 'status') {
        const seenUserNames = new Set<string>();
        const userCandidates: Array<{ name: string; dir: string }> = [];
        for (const rootDir of userRoots) {
          for (const c of scanCandidates(rootDir, 'user')) {
            if (!seenUserNames.has(c.name)) {
              seenUserNames.add(c.name);
              userCandidates.push(c);
            }
          }
        }
        const projCandidates = scanCandidates(projectSkillsRoot, 'project');
        const approved = loadApprovedSkills();
        const lines = ['Skills:'];
        if (userCandidates.length === 0 && projCandidates.length === 0) {
          lines.push('  (no user skills in ~/.config/pi-protected/skills, ~/.codex/skills, or project skills in .agents/skills)');
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }
        for (const u of userCandidates) {
          try {
            inspectSkillDir(u.dir, u.name, 'user');
            lines.push(`  - ${u.name} [user, mounted at /opt/pi-skills/${u.name}]`);
          } catch (err) {
            lines.push(`  - ${u.name} [user, invalid: ${(err as Error).message}]`);
          }
        }
        for (const p of projCandidates) {
          const pinned = approved[p.name];
          try {
            const snap = inspectSkillDir(p.dir, p.name, 'project');
            const state = pinned && manifestsMatch(snap.files, pinned)
              ? `trusted, mounted at /opt/pi-skills/${p.name}`
              : pinned
                ? 'changed and not loaded (run /skills trust)'
                : 'untrusted (run /skills trust)';
            lines.push(`  - ${p.name} [project, ${state}]`);
          } catch (err) {
            lines.push(`  - ${p.name} [project, invalid: ${(err as Error).message}]`);
          }
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      if (trimmed === 'trust') {
        if (!ctx.hasUI || !ctx.isIdle()) {
          ctx.ui.notify('Skill trust requires an idle interactive session.', 'warning');
          return;
        }
        const projCandidates = scanCandidates(projectSkillsRoot, 'project');
        if (projCandidates.length === 0) {
          ctx.ui.notify('No project skills found in .agents/skills/.', 'info');
          return;
        }
        const approved = loadApprovedSkills();
        const choices = projCandidates.map(c => `${c.name}`);
        const picked = choices.length === 1
          ? choices[0]
          : await ctx.ui.select('Select a project skill in .agents/skills/ to review and trust:', choices);
        if (!picked) return;
        const target = projCandidates.find(c => c.name === picked);
        if (!target) return;

        const snap = inspectSkillDir(target.dir, target.name, 'project');
        const reviewed = await ctx.ui.editor(
          `Review skill "${snap.name}" (${Object.keys(snap.files).length} file(s); submit unchanged to continue, Esc to cancel)`,
          snap.previewText,
        );
        if (reviewed?.trim() !== snap.previewText.trim()) return;
        if (!await ctx.ui.confirm(
          `Trust project skill "${snap.name}"?`,
          `${Object.keys(snap.files).length} file(s) under .agents/skills/${snap.name} will be hash-pinned and bound read-only at /opt/pi-skills/${snap.name}.`,
        )) return;

        const verifySnap = inspectSkillDir(target.dir, target.name, 'project');
        if (!manifestsMatch(snap.files, verifySnap.files)) {
          ctx.ui.notify(`Skill "${snap.name}" changed during review. Run /skills trust again.`, 'warning');
          return;
        }
        approved[snap.name] = snap.files;
        saveApprovedSkills(approved);
        warnedChanged.delete(snap.name);
        ctx.ui.notify(`Trusted project skill "${snap.name}" (mounted at /opt/pi-skills/${snap.name}).`, 'info');
        try {
          await ctx.reload?.();
        } catch {
          // Reload is optional in non-TUI tests.
        }
        return;
      }

      if (trimmed === 'revoke' || trimmed.startsWith('revoke ')) {
        const name = trimmed.slice('revoke'.length).trim();
        if (name) {
          const approved = loadApprovedSkills();
          delete approved[name];
          saveApprovedSkills(approved);
          ctx.ui.notify(`Revoked trust for project skill ${visible(name)}.`, 'info');
        } else {
          rmSync(storeRecord, { force: true });
          ctx.ui.notify('Revoked trust for all project skills in this launch folder.', 'info');
        }
        return;
      }

      ctx.ui.notify('Usage: /skills [status | trust | revoke [name]]', 'warning');
    },
  });

  return {
    activeSkillMounts() {
      try {
        return resolveActiveSkills().map(s => [s.hostDir, s.name]);
      } catch {
        return [];
      }
    },
    summary() {
      const skills = resolveActiveSkills();
      return {
        enabled: options.enabled,
        activeCount: skills.length,
        promptBytes: lastPromptBytes,
        names: skills.map(s => s.name),
      };
    },
  };
}
