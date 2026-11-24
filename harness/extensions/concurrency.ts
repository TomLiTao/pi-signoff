/**
 * Reader/writer concurrency gate for protected Pi tool execution.
 *
 * - Read-only calls run in parallel up to `maxReaders` (default 4).
 * - Mutating calls (`bash`, `!`, `edit`, `write`, job mutations) run exclusively:
 *   no read runs while a mutation is active, and queued mutations block new reads
 *   so read-after-write and write-after-read ordering always hold.
 * - `pendingCount()` tracks all active + queued operations for `pi-plan` mode-switch gating.
 */
export function createToolGate(maxReaders = 4) {
  if (!Number.isInteger(maxReaders) || maxReaders < 1) {
    throw new Error('maxReaders must be a positive integer');
  }
  type Waiter = { kind: 'read' | 'write'; start: () => void };
  const queue: Waiter[] = [];
  let activeReaders = 0;
  let activeWriter = false;
  let pending = 0;

  function pump(): void {
    if (activeWriter || queue.length === 0) return;
    if (queue[0].kind === 'write') {
      if (activeReaders === 0) {
        const next = queue.shift()!;
        activeWriter = true;
        next.start();
      }
      return;
    }
    while (queue.length > 0 && queue[0].kind === 'read' && activeReaders < maxReaders) {
      const next = queue.shift()!;
      activeReaders++;
      next.start();
    }
  }

  async function runRead<T>(fn: () => Promise<T>): Promise<T> {
    pending++;
    const hasQueuedWriter = queue.some(item => item.kind === 'write');
    if (activeWriter || hasQueuedWriter || activeReaders >= maxReaders) {
      await new Promise<void>(resolve => {
        queue.push({ kind: 'read', start: resolve });
      });
    } else {
      activeReaders++;
    }
    try {
      return await fn();
    } finally {
      activeReaders--;
      pending--;
      pump();
    }
  }

  async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
    pending++;
    if (activeWriter || activeReaders > 0 || queue.length > 0) {
      await new Promise<void>(resolve => {
        queue.push({ kind: 'write', start: resolve });
      });
    } else {
      activeWriter = true;
    }
    try {
      return await fn();
    } finally {
      activeWriter = false;
      pending--;
      pump();
    }
  }

  return {
    runRead,
    runWrite,
    pendingCount: () => pending,
    activeReaders: () => activeReaders,
    isWriting: () => activeWriter,
  };
}
