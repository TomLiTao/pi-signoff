import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { InstructionsHandle } from './project-instructions.ts';
import type { MemoryHandle } from './memory.ts';
import type { SkillsHandle } from './skills.ts';

function estTokens(bytesOrChars: number): number {
  return Math.ceil(bytesOrChars / 4);
}

function fmtSize(chars: number): string {
  return `${chars.toLocaleString('en-US')} chars (~${estTokens(chars).toLocaleString('en-US')} tok)`;
}

export interface ContextCmdOptions {
  instructions?: () => ReturnType<InstructionsHandle['summary']> | undefined;
  memory?: () => ReturnType<MemoryHandle['summary']> | undefined;
  skills?: () => ReturnType<SkillsHandle['summary']> | undefined;
  droids?: () => { enabled: boolean; activeCount: number; untrustedCount: number; promptBytes: number; names: string[] } | undefined;
  style?: () => { style: string; notify: string; promptBytes: number } | undefined;
  autonomy?: () => string | undefined;
  hooks?: () => string | undefined;
  mcp?: () => string | undefined;
}

export function formatContextReport(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'getAllTools'>,
  ctx: Pick<ExtensionCommandContext, 'getContextUsage' | 'getSystemPrompt' | 'sessionManager' | 'model'>,
  options: ContextCmdOptions,
): string {
  const usage = ctx.getContextUsage();
  const sysPrompt = ctx.getSystemPrompt() ?? '';
  const activeNames = new Set(pi.getActiveTools());
  const activeToolDefs = pi.getAllTools().filter(t => activeNames.has(t.name));
  const toolSchemaChars = activeToolDefs.reduce(
    (sum, t) => sum + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length,
    0,
  );

  const inst = options.instructions?.();
  const mem = options.memory?.();
  const sk = options.skills?.();
  const dr = options.droids?.();
  const st = options.style?.();

  const instChars = (inst?.rootLoadedBytes ?? 0);
  const memChars = (mem?.indexBytes ?? 0);
  const skillChars = (sk?.promptBytes ?? 0);
  const droidChars = (dr?.promptBytes ?? 0);
  const styleChars = (st?.promptBytes ?? 0);
  const basePromptChars = Math.max(0, sysPrompt.length - instChars - memChars - skillChars - droidChars - styleChars);

  let msgCount = 0;
  let convChars = 0;
  for (const raw of ctx.sessionManager.getBranch()) {
    const entry = raw as { type?: string; content?: unknown; message?: { content?: unknown } };
    if (entry.type === 'message' && entry.message) {
      msgCount++;
      const c = entry.message.content;
      convChars += typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
    } else if (entry.type === 'custom_message') {
      msgCount++;
      convChars += typeof entry.content === 'string' ? entry.content.length : JSON.stringify(entry.content ?? '').length;
    }
  }
  convChars += inst?.nestedInjectedBytes ?? 0;

  const lines: string[] = [];
  const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'none selected';
  lines.push(`Context breakdown (${modelLabel}):`);
  if (usage) {
    const usedStr = usage.tokens !== null ? `${usage.tokens.toLocaleString('en-US')} tok` : 'pending next turn';
    const pctStr = usage.percent !== null ? ` (${Math.round(usage.percent)}%)` : '';
    lines.push(`  Window:       ${usedStr} / ${usage.contextWindow.toLocaleString('en-US')} tok${pctStr}`);
  } else {
    lines.push('  Window:       unavailable (no active model)');
  }
  lines.push(`  System total: ${fmtSize(sysPrompt.length)}`);
  lines.push(`    Base prompt:  ${fmtSize(basePromptChars)}`);
  lines.push(`    Instructions: ${inst?.rootFile ? `${inst.rootFile} — ${fmtSize(instChars)}` : 'none loaded'}${inst?.nestedInjectedCount ? ` (+${inst.nestedInjectedCount} nested in transcript, ${fmtSize(inst.nestedInjectedBytes)})` : ''}`);
  lines.push(`    Memory:       ${mem?.hardDisabled ? 'disabled (--no-memory)' : mem?.enabled ? fmtSize(memChars) : 'off'}`);
  lines.push(`    Skills:       ${sk?.enabled === false ? 'disabled (--no-skills)' : `${sk?.activeCount ?? 0} active — ${fmtSize(skillChars)}`}`);
  if (dr) {
    const untrustedSuffix = dr.untrustedCount ? ` (${dr.untrustedCount} untrusted project droid(s))` : '';
    lines.push(`    Droids:       ${dr.enabled === false ? 'disabled' : `${dr.activeCount} active — ${fmtSize(droidChars)}${untrustedSuffix}`}`);
  }
  if (st && st.style !== 'default') {
    lines.push(`    Output style: ${st.style} — ${fmtSize(styleChars)}`);
  }
  const autoLine = options.autonomy?.();
  if (autoLine) lines.push(`  Autonomy:     ${autoLine}`);
  const hooksLine = options.hooks?.();
  if (hooksLine) lines.push(`  Hooks:        ${hooksLine}`);
  const mcpLine = options.mcp?.();
  if (mcpLine) lines.push(`  MCP:          ${mcpLine}`);
  lines.push(`  Tool schemas: ${activeToolDefs.length} active — ${fmtSize(toolSchemaChars)}`);
  lines.push(`  Conversation: ${msgCount} message(s) — ${fmtSize(convChars)}`);
  return lines.join('\n');
}

export function registerContextCommand(pi: ExtensionAPI, options: ContextCmdOptions) {
  pi.registerCommand('context', {
    description: 'Show context window breakdown (system prompt, tools, instructions, memory, skills, conversation): /context',
    async handler(_raw, ctx) {
      ctx.ui.notify(formatContextReport(pi, ctx, options), 'info');
    },
  });
}
