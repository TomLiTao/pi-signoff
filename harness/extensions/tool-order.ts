import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Sort tool names into registry order; names the registry does not know keep their relative order at the end. */
export function canonicalToolOrder(names: readonly string[], registry: readonly string[]): string[] {
  const rank = new Map(registry.map((name, index) => [name, index]));
  return [...new Set(names)]
    .map((name, index) => ({ name, rank: rank.get(name) ?? registry.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.name);
}

/**
 * Keep the active tool list in one fixed order: the order tools were registered in.
 *
 * Pi writes the tool list into the system prompt in the order passed to setActiveTools. Plan mode removes
 * edit, write and the detached-run tools and later re-adds them at the end, so each round trip into plan mode
 * reordered the start of the system prompt and voided the provider's prompt cache (a full re-bill of the
 * conversation). A restart restored the original order and voided it again. Call this before any other
 * extension can change the active tools.
 */
export function keepToolOrderStable(pi: ExtensionAPI): void {
  const setRaw = pi.setActiveTools.bind(pi);
  const registry = (): string[] => {
    try {
      return pi.getAllTools().map(tool => tool.name);
    } catch {
      return [];
    }
  };
  try {
    pi.setActiveTools = (names: string[]) => setRaw(canonicalToolOrder(names, registry()));
  } catch {
    return; // A read-only API object: keep Pi's own ordering.
  }
  // The launch order (the --tools list, then extension tools) need not match registry order; settle it once.
  pi.on('session_start', async () => {
    const active = pi.getActiveTools();
    const ordered = canonicalToolOrder(active, registry());
    if (ordered.some((name, index) => name !== active[index])) setRaw(ordered);
  });
}
