import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/**
 * Tell the model its own session ID and model, so records and signatures can name them instead of
 * writing `unavailable`. Both are constant within a session, so the section does not disturb prompt caching.
 */
export function sessionIdentitySection(ctx: Pick<ExtensionContext, 'sessionManager' | 'model'>): string | undefined {
  let sessionId: string | undefined;
  try {
    sessionId = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  if (!sessionId && !model) return undefined;
  const lines = ['Runtime identity (supplied by the Pi harness; use these exact values where a record or signature asks for them):'];
  if (sessionId) lines.push(`- Session ID: ${sessionId}`);
  if (model) lines.push(`- Model: ${model}`);
  return lines.join('\n');
}

export function registerSessionIdentity(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event, ctx) => {
    if (!event.systemPromptOptions) return;
    const section = sessionIdentitySection(ctx);
    if (section) (event.systemPromptOptions.sections ??= {}).session_identity = section;
  });
}
