import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type PermissionModeLabel = 'PLAN' | 'ASK-EDITS' | 'ACCEPT-EDITS' | 'WORKFLOW' | 'WRITE' | 'READ-ONLY';
export type StatusAutonomyLevel = 'off' | 'low' | 'medium';

export interface StatusSnapshot {
  mode: PermissionModeLabel;
  autonomy?: StatusAutonomyLevel;
  /** Write mode that approving a Spec returns to. */
  returnMode?: 'ask-edits' | 'accept-edits' | 'workflow';
  style?: string;
  checkpointRef?: string;
  activeJobs: number;
  rejectedCount?: number;
  contextPercent?: number | null;
  webEnabled: boolean;
  fetchEnabled: boolean;
  delegatesRemaining?: number;
  delegatesMax?: number;
  delegateRemaining?: number;
  delegateMax?: number;
}

export function shortCheckpointId(ref?: string): string | undefined {
  if (!ref) return undefined;
  const match = /-([0-9a-f]{8})$/.exec(ref);
  if (match) return match[1];
  const tail = ref.split('/').pop() ?? ref;
  return tail.slice(-8);
}

export function formatStatusLine(state: StatusSnapshot): string {
  const parts: string[] = [state.mode];
  if (state.autonomy && state.autonomy !== 'off' && state.mode !== 'PLAN' && state.mode !== 'READ-ONLY') {
    parts.push(state.autonomy === 'medium' ? 'auto:med' : 'auto:low');
  }
  if (state.style && state.style !== 'default') {
    parts.push(`style:${state.style}`);
  }
  const ckpt = shortCheckpointId(state.checkpointRef);
  parts.push(ckpt ? `ckpt ${ckpt}` : 'no ckpt');
  if (typeof state.rejectedCount === 'number' && state.rejectedCount > 0) {
    parts.push(`rej:${state.rejectedCount}`);
  }
  if (state.activeJobs > 0) {
    parts.push(`${state.activeJobs} job${state.activeJobs === 1 ? '' : 's'}`);
  }
  const rem = state.delegatesRemaining ?? state.delegateRemaining;
  const max = state.delegatesMax ?? state.delegateMax;
  if (typeof rem === 'number' && typeof max === 'number' && max > 0 && rem < max) {
    parts.push(`delegates ${rem}/${max}`);
  }
  if (typeof state.contextPercent === 'number' && Number.isFinite(state.contextPercent)) {
    parts.push(`ctx ${Math.round(state.contextPercent)}%`);
  }
  if (!state.webEnabled && !state.fetchEnabled) {
    parts.push('web off');
  } else if (!state.webEnabled) {
    parts.push('search off');
  } else if (!state.fetchEnabled) {
    parts.push('fetch off');
  }
  return parts.join(' · ');
}

let latestSnapshot: StatusSnapshot | undefined;
const snapshotListeners = new Set<() => void>();

/** Last snapshot pushed by updateProtectedStatus (read by the Droid-style footer). */
export function getProtectedSnapshot(): StatusSnapshot | undefined {
  return latestSnapshot;
}

export function onProtectedSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

export function updateProtectedStatus(ctx: ExtensionContext | undefined, snapshot: Omit<StatusSnapshot, 'contextPercent'>): void {
  if (!ctx?.hasUI) return;
  let contextPercent: number | null | undefined;
  try {
    contextPercent = ctx.getContextUsage?.()?.percent;
  } catch {
    contextPercent = undefined;
  }
  latestSnapshot = { ...snapshot, contextPercent };
  for (const listener of snapshotListeners) {
    try {
      listener();
    } catch {
      // Display listeners must never break status updates.
    }
  }
  ctx.ui.setStatus('pi-protected', formatStatusLine(latestSnapshot));
}
