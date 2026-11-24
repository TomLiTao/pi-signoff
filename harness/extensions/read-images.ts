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

