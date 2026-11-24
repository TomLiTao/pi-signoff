import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { shortCheckpointId } from './status.ts';

const runFile = promisify(execFile);
export const checkpointEntryType = 'pi-checkpoint';

export interface CheckpointEntryData {
  entryId: string | null;
  ref: string;
  kind: 'turn' | 'shell' | 'safety';
  label?: string;
}

export interface TurnChangeSummary {
  files: Array<{ path: string; added: number; removed: number; binary: boolean }>;
  total: number;
}

export function parseNumstat(stdout: string): TurnChangeSummary | undefined {
  try {
    const parsed = JSON.parse(stdout) as { files?: unknown; total?: unknown };
    if (!Array.isArray(parsed.files) || typeof parsed.total !== 'number') return undefined;
    const files = parsed.files.flatMap(item => {
      const f = item as { path?: unknown; added?: unknown; removed?: unknown; binary?: unknown };
      if (typeof f.path !== 'string' || typeof f.added !== 'number' || typeof f.removed !== 'number') return [];
      return [{ path: f.path.replace(/[\p{Cc}\p{Cf}]/gu, '?'), added: f.added, removed: f.removed, binary: f.binary === true }];
    });
    return { files, total: parsed.total };
  } catch {
    return undefined;
  }
}

export interface RewindTarget {
  label: string;
  entryId: string | null;
  ref?: string;
  turnNumber?: number;
}

type BranchEntry = ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];

function extractMessagePreview(content: unknown, maxLen = 72): string {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((item): item is { type: 'text'; text: string } =>
        Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text' && typeof (item as { text?: unknown }).text === 'string'))
      .map(item => item.text)
      .join(' ');
  }
  const single = raw.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return single.length > maxLen ? `${single.slice(0, maxLen - 1)}…` : (single || '(empty prompt)');
}

/**
 * Resolve rewind targets from a session branch.
 * For each user message `U_k`, the file state immediately before `U_k`'s mutations
 * is the first `pi-checkpoint` recorded at or after `U_k` on the branch.
 */
export function buildRewindTargets(branch: readonly BranchEntry[], launchRef?: string): RewindTarget[] {
  const targets: RewindTarget[] = [];

  // Check if the most recent checkpoint is a safety checkpoint from a prior rewind
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: CheckpointEntryData };
    if (entry.type === 'custom' && entry.customType === checkpointEntryType && entry.data?.kind === 'safety' && entry.data.ref) {
      targets.push({
        label: `Undo previous rewind (ckpt ${shortCheckpointId(entry.data.ref)})`,
        entryId: null,
        ref: entry.data.ref,
      });
      break;
    }
  }

  // Collect user messages from newest to oldest
  const userIndices: Array<{ index: number; id: string; preview: string; turn: number }> = [];
  let turnCounter = 0;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === 'message' && entry.message.role === 'user') {
      turnCounter++;
      userIndices.push({
        index: i,
        id: entry.id,
        preview: extractMessagePreview(entry.message.content),
        turn: turnCounter,
      });
    }
  }

  for (let u = userIndices.length - 1; u >= 0; u--) {
    const item = userIndices[u];
    let resolvedRef: string | undefined;
    for (let j = item.index; j < branch.length; j++) {
      const entry = branch[j] as { type?: string; customType?: string; data?: CheckpointEntryData };
      if (entry.type === 'custom' && entry.customType === checkpointEntryType && entry.data?.ref && entry.data.kind !== 'safety') {
        resolvedRef = entry.data.ref;
        break;
      }
    }
    if (!resolvedRef && item.turn === 1 && launchRef) {
      resolvedRef = launchRef;
    }
    const ckptTag = resolvedRef ? `ckpt ${shortCheckpointId(resolvedRef)}` : 'no file changes after';
    targets.push({
      label: `Turn ${item.turn}: "${item.preview}" (${ckptTag})`,
      entryId: item.id,
      ref: resolvedRef,
      turnNumber: item.turn,
    });
  }

  if (launchRef) {
    targets.push({
      label: `Launch checkpoint (ckpt ${shortCheckpointId(launchRef)})`,
      entryId: userIndices[0]?.id ?? null,
      ref: launchRef,
      turnNumber: 0,
    });
  }

  return targets;
}

export interface CheckpointManagerOptions {
  dir: string;
  launchRef?: string;
  writeRoot?: string;
  isPlanning: () => boolean;
  hasPendingWork: () => boolean;
  onCheckpointChange: (ref: string | undefined) => void;
  onFilesRestored: () => void;
  onRewind?: () => void;
  execCheckpoint?: (args: string[], cwd: string) => Promise<string>;
}

export function registerCheckpoints(pi: ExtensionAPI, options: CheckpointManagerOptions) {
  const launch = realpathSync(process.cwd());
  const defaultExec = async (args: string[], cwd: string) => {
    const { stdout } = await runFile(
      '/usr/bin/python3',
      ['-IB', path.join(options.dir, 'protected-checkpoint.py'), ...args],
      { cwd, timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 },
    );
    return stdout.trim();
  };
  const execCkpt = options.execCheckpoint ?? defaultExec;

  let currentRef = options.launchRef;
  let turnCheckpointed = false;
  let turnReadOnlyFallback = false;
  let turnRef: string | undefined;
  let inflightTurnCkpt: Promise<boolean> | undefined;

  function resetTurn(): void {
    turnRef = undefined;
    turnCheckpointed = false;
    turnReadOnlyFallback = false;
    inflightTurnCkpt = undefined;
  }

  function currentUserEntryId(ctx?: ExtensionContext): string | null {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === 'message' && entry.message.role === 'user') return entry.id;
    }
    return ctx?.sessionManager?.getLeafId?.() ?? null;
  }

  async function ensureMutationCheckpoint(
    ctx: ExtensionContext | undefined,
    kind: 'turn' | 'shell' = 'turn',
  ): Promise<boolean> {
    if (options.isPlanning() || options.writeRoot !== launch) return false;
    if (kind === 'turn' && turnCheckpointed) return !turnReadOnlyFallback;
    if (kind === 'turn' && inflightTurnCkpt) return inflightTurnCkpt;

    const task = (async () => {
      try {
        const ref = await execCkpt(['create', launch], launch);
        if (!ref) throw new Error('Empty checkpoint ref');
        currentRef = ref;
        if (kind === 'turn') {
          turnCheckpointed = true;
          turnReadOnlyFallback = false;
        }
        turnRef ??= ref;
        options.onCheckpointChange(ref);
        try {
          pi.appendEntry(checkpointEntryType, {
            entryId: currentUserEntryId(ctx),
            ref,
            kind,
          } satisfies CheckpointEntryData);
        } catch {
          // Non-fatal if session manager cannot append outside an active session.
        }
        return true;
      } catch {
        if (kind === 'turn') {
          turnCheckpointed = true;
          turnReadOnlyFallback = true;
        }
        ctx?.ui?.notify?.('Checkpoint creation failed; falling back to read-only for this turn.', 'warning');
        return false;
      } finally {
        if (inflightTurnCkpt === task) inflightTurnCkpt = undefined;
      }
    })();

    if (kind === 'turn') inflightTurnCkpt = task;
    return task;
  }

  pi.on('before_agent_start', async () => {
    resetTurn();
  });

  pi.on('session_start', async () => {
    resetTurn();
    currentRef = options.launchRef;
  });

  pi.registerCommand('rewind', {
    description: 'Rewind workspace files, conversation, or both to an earlier turn: /rewind',
    async handler(raw, ctx: ExtensionCommandContext) {
      if (!ctx.hasUI) return;
      if (realpathSync(ctx.cwd) !== launch) {
        ctx.ui.notify('Rewind is only available in the launch folder.', 'warning');
        return;
      }
      if (!ctx.isIdle() || options.hasPendingWork()) {
        ctx.ui.notify('Wait for active runs or background jobs to finish before rewinding.', 'warning');
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      const targets = buildRewindTargets(branch, options.launchRef);
      if (targets.length === 0) {
        ctx.ui.notify('Nothing to rewind yet in this session.', 'info');
        return;
      }

      let chosen: RewindTarget | undefined;
      const trimmed = raw.trim();
      if (trimmed === 'launch' && options.launchRef) {
        chosen = targets.find(t => t.ref === options.launchRef && t.turnNumber === 0) ?? targets.at(-1);
      } else {
        const labels = [...targets.map(t => t.label), 'Cancel'];
        const pickedLabel = await ctx.ui.select('Select point to rewind to:', labels, { timeout: 60_000, signal: ctx.signal });
        if (!pickedLabel || pickedLabel === 'Cancel' || ctx.signal?.aborted) return;
        chosen = targets.find(t => t.label === pickedLabel);
      }
      if (!chosen) return;

      const modeChoices: string[] = [];
      if (chosen.ref && chosen.entryId) {
        modeChoices.push('Both (files and conversation)');
        modeChoices.push('Both (fork into new session)');
      }
      if (chosen.ref) modeChoices.push('Files only');
      if (chosen.entryId) {
        modeChoices.push('Conversation only');
        modeChoices.push('Conversation only (fork into new session)');
      }
      modeChoices.push('Cancel');

      const action = await ctx.ui.select(`Rewind action for ${chosen.label}:`, modeChoices, { timeout: 60_000, signal: ctx.signal });
      if (!action || action === 'Cancel' || ctx.signal?.aborted) return;

      const doFiles = action.startsWith('Both') || action === 'Files only';
      const doConv = action.startsWith('Both') || action.startsWith('Conversation only');
      const useFork = action.includes('fork');

      try {
        let safetyRef: string | undefined;
        if (doFiles && chosen.ref) {
          safetyRef = await execCkpt(['restore', launch, chosen.ref], launch);
          currentRef = chosen.ref;
          options.onFilesRestored();
          options.onCheckpointChange(chosen.ref);
        }

        if (doConv && chosen.entryId) {
          const navResult = useFork
            ? await ctx.fork(chosen.entryId, { position: 'before' })
            : await ctx.navigateTree(chosen.entryId);
          if (navResult.cancelled) {
            ctx.ui.notify(
              doFiles ? 'Files were restored, but conversation rewind was cancelled.' : 'Conversation rewind cancelled.',
              'warning',
            );
            if (safetyRef) {
              pi.appendEntry(checkpointEntryType, {
                entryId: null,
                ref: safetyRef,
                kind: 'safety',
                label: 'Before rewind',
              } satisfies CheckpointEntryData);
            }
            return;
          }
        }

        if (safetyRef) {
          try {
            pi.appendEntry(checkpointEntryType, {
              entryId: null,
              ref: safetyRef,
              kind: 'safety',
              label: 'Before rewind',
            } satisfies CheckpointEntryData);
          } catch {
            // Ignore if session switched without active branch.
          }
        }

        options.onRewind?.();
        const summaryParts: string[] = [];
        if (doFiles && chosen.ref) summaryParts.push(`files restored to ckpt ${shortCheckpointId(chosen.ref)}`);
        if (doConv && chosen.entryId) summaryParts.push(useFork ? 'conversation forked' : 'conversation rewound');
        ctx.ui.notify(`Rewind complete: ${summaryParts.join(', ')}.`, 'info');
      } catch (error) {
        ctx.ui.notify(`Rewind failed: ${(error as Error).message}`, 'warning');
      }
    },
  });

  return {
    ensureMutationCheckpoint,
    isTurnReadOnlyFallback: () => turnReadOnlyFallback,
    /** First checkpoint created during the current turn (the state before its changes). */
    getTurnRef: () => turnRef,
    /** Files changed in the workspace since `ref`, or undefined when the comparison fails. */
    async changesSince(ref: string): Promise<TurnChangeSummary | undefined> {
      try {
        return parseNumstat(await execCkpt(['numstat', launch, ref], launch));
      } catch {
        return undefined;
      }
    },
    getCurrentRef: () => currentRef,
    resolveSinceRef(turnOneBased: number, branch: readonly BranchEntry[]): string | undefined {
      const targets = buildRewindTargets(branch, options.launchRef);
      return targets.find(t => t.turnNumber === turnOneBased)?.ref;
    },
  };
}
