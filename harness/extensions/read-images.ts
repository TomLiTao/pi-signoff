// Image results from pi_safe_read: pi's read tool (inside Bubblewrap) attaches PNG/JPG/GIF/WebP files as
// image blocks. Models without image input get a short note instead of an image they cannot use.
export const IMAGE_READ_GUIDELINE = 'After a script writes a chart or figure (PNG, JPG, GIF, WebP; save matplotlib output as PNG), read the file with pi_safe_read to check it before reporting: it is attached as an image when your model accepts images. SVG and PDF are not attached. An animated GIF reaches you as a single still frame: check its frame count, timing and other frames with a script (for example render a contact sheet of frames to PNG), and do not describe motion you have not seen.';

export type ReadResult = { content?: Array<{ type: string; [key: string]: unknown }>; structuredContent?: unknown; [key: string]: unknown };

/** Replace image blocks with a note for models that do not accept image input. */
export function withImagesForModel<T>(result: T, ctx: { model?: { id?: string; input?: readonly string[] } }): T {
  const r = result as ReadResult;
  const model = ctx.model;
  if (!model || !Array.isArray(r?.content) || model.input?.includes('image') !== false) return result;
  if (!r.content.some(block => block.type === 'image')) return result;
  const note = `[Image not shown: ${model.id ?? 'this model'} does not accept images. Work from the data that produced it, or ask the user to look at it (pi_safe_open).]`;
  return {
    ...r,
    content: [...r.content.filter(block => block.type !== 'image'), { type: 'text', text: note }],
    structuredContent: note,
  } as T;
}


type Msg = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; [key: string]: unknown };

/**
 * Replace images in tool results older than the last `keepUserTurns` user prompts with a one-line note.
 * A rendered figure is checked once, right after it is made; keeping every image in context until the
 * next compaction made them most of a long session's input. The cut-off only moves forward when the
 * user sends a prompt, so the cached prompt prefix changes at most once per prompt. The session file
 * keeps the images; only what is sent to the model changes. Returns undefined when nothing changes.
 */
export function stubOldImages<T extends Msg>(messages: readonly T[], keepUserTurns = 2): T[] | undefined {
  let seen = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && ++seen === keepUserTurns) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return undefined;
  const pathsById = new Map<string, string>();
  for (let i = 0; i < cut; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: string; id?: string; arguments?: { path?: unknown } }>) {
      if (block?.type === 'toolCall' && block.id && typeof block.arguments?.path === 'string') pathsById.set(block.id, block.arguments.path);
    }
  }
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= cut || m?.role !== 'toolResult' || !Array.isArray(m.content)) return m;
    const blocks = m.content as Array<{ type: string; [key: string]: unknown }>;
    if (!blocks.some(b => b?.type === 'image')) return m;
    changed = true;
    const file = m.toolCallId ? pathsById.get(m.toolCallId) : undefined;
    const note = `[Image removed from older context${file ? `: ${file}` : ''}. Read the file again if you need to look at it.]`;
    return { ...m, content: [...blocks.filter(b => b?.type !== 'image'), { type: 'text', text: note }] };
  });
  return changed ? out : undefined;
}
