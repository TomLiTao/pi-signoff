/**
 * Progress tracking for plan execution.
 * Parses [DONE:n] markers from LLM output and updates step completion.
 */

import type { PlanStep } from "./types.js";

type ProgressMarker = { step: number } | { indent: string };

function mapProgressMarkers(markdown: string, map: (marker: ProgressMarker, original: string) => string): string {
  // Match code spans as a unit, then recognize standalone pause lines and inline DONE markers.
  const markers = /(?<!\x60)(\x60+)(?!\x60)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!\x60)\1(?!\x60)|^([ \t]*)\[PLAN:PAUSED\][ \t]*(?=\r?$)|\[DONE:(\d+)\]/gim;
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (!prose.length) return;
    output.push(prose.join("").replace(markers, (original, code, indent, step) => {
      if (code !== undefined) return original;
      return map(step === undefined ? { indent } : { step: Number(step) }, original);
    }));
    prose = [];
  };

  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (fence) {
      output.push(line);
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = undefined;
      }
    } else if (delimiter && (delimiter[1][0] === "~" || !delimiter[2].includes("\x60"))) {
      flush();
      fence = delimiter[1];
      output.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return output.join("");
}

/**
 * Extract completed step numbers from [DONE:n] markers in text.
 */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  mapProgressMarkers(message, (marker, original) => {
    if ("step" in marker && Number.isFinite(marker.step)) steps.push(marker.step);
    return original;
  });
  return steps;
}

/**
 * Mark steps as completed based on [DONE:n] markers found in text.
 * Returns the number of steps newly marked as completed.
 */
export function markCompletedSteps(text: string, items: PlanStep[]): number {
  const doneSteps = extractDoneSteps(text);
  let newlyCompleted = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      newlyCompleted++;
    }
  }
  return newlyCompleted;
}

/**
 * Calculate completion stats for a set of plan steps.
 */
export function isPlanPausedText(text: string): boolean {
  let paused = false;
  mapProgressMarkers(text, (marker, original) => {
    if ("indent" in marker) paused = true;
    return original;
  });
  return paused;
}

/**
 * Show live progress markers using the same rules as plan state tracking.
 */
export function transformDoneMarkers(markdown: string): string {
  return mapProgressMarkers(markdown, (marker, original) => {
    if ("indent" in marker) return `${marker.indent}\`⏸ plan paused\``;
    return Number.isFinite(marker.step) ? `\`✓ step ${marker.step}\`` : original;
  });
}

export function settledPlanOutcome(
  steps: PlanStep[],
  reply: { stopReason?: string; text: string } | undefined,
): 'complete' | 'ended' | undefined {
  if (reply?.stopReason !== 'stop' || !reply.text.trim() || isPlanPausedText(reply.text)) {
    return undefined;
  }
  // Missing progress markers must not leave a finished run active or mark unverified steps done.
  return getCompletionStats(steps).allDone ? 'complete' : 'ended';
}

export function getCompletionStats(steps: PlanStep[]): {
  completed: number;
  total: number;
  allDone: boolean;
} {
  const completed = steps.filter((s) => s.completed).length;
  return {
    completed,
    total: steps.length,
    allDone: steps.length > 0 && completed === steps.length,
  };
}
