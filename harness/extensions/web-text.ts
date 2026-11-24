// Windowing for fetched documents: return a slice (offset / maxChars) or only the passages around a
// search term (find), with character positions so the model can continue precisely.

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 60_000;
const FIND_CONTEXT = 700;
const FIND_MAX_PASSAGES = 8;

export interface DocumentSlice {
  text: string;
  /** 0-based start and end (exclusive) of the returned text, or passage spans for find. */
  start: number;
  end: number;
  total: number;
  /** Offset to continue reading from, when more text follows. */
  next?: number;
  matches?: number;
  shownMatches?: number;
}

export function sliceDocument(full: string, opts: { offset?: number; maxChars?: number; find?: string } = {}): DocumentSlice {
  const total = full.length;
  const maxChars = Math.min(MAX_MAX_CHARS, Math.max(500, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)));
  const start = Math.min(Math.max(0, Math.floor(opts.offset ?? 0)), total);
  const find = opts.find?.trim();
  if (find) {
    const pattern = new RegExp(RegExp.escape(find), 'giu');
    pattern.lastIndex = start;
    const spans: Array<[number, number]> = [];
    let matches = 0;
    let shownMatches = 0;
    let available = maxChars;
    let next: number | undefined;
    for (const match of full.matchAll(pattern)) {
      const at = match.index;
      if (at < start) continue;
      matches++;
      if (next !== undefined) continue;
      const matchEnd = at + match[0].length;
      const last = spans.at(-1);
      if (last && at - FIND_CONTEXT <= last[1] && matchEnd - last[1] <= available) {
        const end = Math.max(last[1], Math.min(total, matchEnd + FIND_CONTEXT, last[1] + available));
        available -= end - last[1];
        last[1] = end;
      } else if (spans.length < FIND_MAX_PASSAGES && match[0].length <= available) {
        const context = available - match[0].length;
        const left = Math.max(start, last?.[1] ?? start, at - Math.min(FIND_CONTEXT, Math.floor(context / 2)));
        const right = Math.min(total, matchEnd + Math.min(FIND_CONTEXT, context - (at - left)));
        spans.push([left, right]);
        available -= right - left;
      } else {
        // End at the next match so the continuation never repeats a complete match from this page.
        if (last && at < last[1]) last[1] = at;
        next = at;
        continue;
      }
      shownMatches++;
    }
    return {
      text: spans.map(([from, to]) => `[chars ${from}-${to}]\n${full.slice(from, to)}`).join('\n\n…\n\n'),
      start: spans[0]?.[0] ?? start, end: spans.at(-1)?.[1] ?? start, total, matches, shownMatches,
      ...(next === undefined ? {} : { next }),
    };
  }
  let end = Math.min(total, start + maxChars);
  // Prefer ending at a paragraph or line break when one is near the cut.
  if (end < total) {
    const window = full.slice(start, end);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut > maxChars * 0.8) end = start + cut + 1;
  }
  return { text: full.slice(start, end), start, end, total, ...(end < total ? { next: end } : {}) };
}
