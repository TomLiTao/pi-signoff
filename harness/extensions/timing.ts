import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type OutputKind = 'thinking' | 'text' | 'tool';

interface RequestTiming {
  id: number;
  turn: number;
  provider?: string;
  model?: string;
  startedAtMs: number;
  headers: Array<{ atMs: number; status: number }>;
  firstStreamAtMs?: number;
  firstOutputAtMs: Partial<Record<OutputKind, number>>;
}

export function registerTiming(
  pi: ExtensionAPI,
  write: (row: object) => void = row => process.stderr.write(`Pi timing ${JSON.stringify(row)}\n`),
  now = () => performance.now(),
): void {
  const origin = now();
  const elapsed = () => Math.round((now() - origin) * 10) / 10;
  let run = 0;
  let turn = 0;
  let sequence = 0;
  let request: RequestTiming | undefined;
  const tools = new Map<string, { tool: string; turn: number; startedAtMs: number }>();

  function finishRequest(outcome: string): void {
    if (!request) return;
    write({ kind: 'request', run, ...request, endedAtMs: elapsed(), outcome });
    request = undefined;
  }

  pi.on('before_agent_start', () => {
    run++;
    write({ kind: 'run_start', run, atMs: elapsed() });
  });
  pi.on('turn_start', event => {
    turn = event.turnIndex;
  });
  pi.on('before_provider_request', (_event, ctx) => {
    finishRequest('superseded');
    request = {
      id: ++sequence, turn, provider: ctx.model?.provider, model: ctx.model?.id,
      startedAtMs: elapsed(), headers: [], firstOutputAtMs: {},
    };
  });
  pi.on('after_provider_response', event => {
    request?.headers.push({ atMs: elapsed(), status: event.status });
  });
  pi.on('provider_stream_event', () => {
    if (request) request.firstStreamAtMs ??= elapsed();
  });
  pi.on('message_update', ({ assistantMessageEvent: update }) => {
    if (!request) return;
    const kind = ({
      thinking_delta: 'thinking', text_delta: 'text', toolcall_delta: 'tool', toolcall_end: 'tool',
    } as const)[update.type as 'thinking_delta' | 'text_delta' | 'toolcall_delta' | 'toolcall_end'];
    if (kind && (update.type === 'toolcall_end' || ('delta' in update && update.delta))) {
      request.firstOutputAtMs[kind] ??= elapsed();
    }
  });
  pi.on('message_end', event => {
    if (event.message.role === 'assistant') finishRequest(event.message.stopReason);
  });
  pi.on('tool_execution_start', event => {
    tools.set(event.toolCallId, { turn, tool: event.toolName, startedAtMs: elapsed() });
  });
  pi.on('tool_execution_end', event => {
    const span = tools.get(event.toolCallId);
    if (!span) return;
    tools.delete(event.toolCallId);
    write({
      kind: 'tool', run, ...span, endedAtMs: elapsed(),
      durationMs: event.durationMs, outcome: event.isError ? 'error' : 'ok',
    });
  });
  pi.on('agent_settled', event => {
    finishRequest(event.aborted ? 'aborted' : 'incomplete');
    for (const span of tools.values()) {
      write({ kind: 'tool', run, ...span, endedAtMs: elapsed(), outcome: event.aborted ? 'aborted' : 'incomplete' });
    }
    tools.clear();
    write({ kind: 'run_end', run, atMs: elapsed(), aborted: event.aborted });
  });
}
