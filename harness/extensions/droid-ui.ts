// Droid-style TUI for protected Pi: banner header, boxed "> " input, an autonomy footer that
// Shift+Tab cycles (Auto Off → Low → Medium → Spec), "LABEL (detail) / ↳ summary" tool rows,
// a ⛬ marker on assistant text, and an elapsed-time working line. Display only: nothing here
// changes what a tool may do; the cycle calls the same mode/autonomy setters as /mode and /auto.
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { CustomEditor, renderDiff, VERSION } from '@earendil-works/pi-coding-agent';
import type { Component, EditorTheme, TUI } from '@earendil-works/pi-tui';
import { Container, matchesKey, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  autonomyBanner, compactPath, footerDetailParts, formatTurnChanges, installDroidTone, oneLine, prefixAssistantMarkdown, resultText,
  summarizeToolResult, todoLines, toolHeader, workingMessage, canonicalToolName, type TurnChanges, type UiStyle,
} from './droid-ui-format.ts';
import { getProtectedSnapshot, onProtectedSnapshot } from './status.ts';

export interface DroidUiOptions {
  initialStyle: UiStyle;
  /** Shift+Tab handler; omitted for workers or read-only launches. */
  cycle?: (ctx: ExtensionContext) => void;
}

export interface DroidUiHandle {
  getStyle(): UiStyle;
}

// Fixed brand accent (xterm-256 orange ramp); everything else uses the active Pi theme.
const ORANGE = [208, 209, 215, 216, 222, 223];
const brand = (text: string, shade = 0) => `\x1b[38;5;${ORANGE[Math.min(shade, ORANGE.length - 1)]}m${text}\x1b[39m`;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const LOGO = [
  '██████╗ ██╗',
  '██╔══██╗██║',
  '██████╔╝██║',
  '██╔═══╝ ██║',
  '██║     ██║',
  '╚═╝     ╚═╝',
];

function fitLeftRight(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + rw + 2 <= width) return left + ' '.repeat(width - lw - rw) + right;
  return truncateToWidth(left, width);
}

function boxLines(lines: string[], width: number, border: (s: string) => string, title = ''): string[] {
  const inner = Math.max(4, width - 4);
  const titleText = title ? ` ${title} ` : '';
  const topFill = Math.max(0, width - 3 - visibleWidth(titleText));
  const out = [border('╭─') + titleText + border(`${'─'.repeat(topFill)}╮`)];
  for (const line of lines) {
    const clipped = truncateToWidth(line, inner);
    out.push(`${border('│')} ${clipped}${' '.repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border('│')}`);
  }
  out.push(border(`╰${'─'.repeat(Math.max(0, width - 2))}╯`));
  return out;
}

function indentBlock(text: string, pad: number): string {
  const prefix = ' '.repeat(pad);
  return text.split('\n').map(line => prefix + line).join('\n');
}

export function registerDroidUi(pi: ExtensionAPI, options: DroidUiOptions): DroidUiHandle {
  let style: UiStyle = options.initialStyle;
  let latestCtx: ExtensionContext | undefined;
  let activeTui: TUI | undefined;
  let promptDepth = 0;
  let unsubscribeInput: (() => void) | undefined;
  let workStarted = 0;
  let workTimer: ReturnType<typeof setInterval> | undefined;
  const runningTools = new Map<string, string>();
  let usageCache: { key: string; input: number; output: number; cost: number } | undefined;

  onProtectedSnapshot(() => activeTui?.requestRender());

  const droid = () => style === 'droid';

  // ---- usage totals for the footer (cached per session entry count) ----
  function usageTotals(ctx: ExtensionContext): { input: number; output: number; cost: number } {
    try {
      const sm = ctx.sessionManager as unknown as {
        getEntries(): Array<{ type: string; message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } }>;
        getEntryCount?(): number; getSessionId?(): string;
      };
      const key = `${sm.getSessionId?.() ?? ''}:${sm.getEntryCount?.() ?? -1}`;
      if (usageCache?.key === key && key !== ':-1') return usageCache;
      let input = 0, output = 0, cost = 0;
      for (const entry of sm.getEntries()) {
        if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
        const u = entry.message.usage;
        input += u?.input ?? 0;
        output += u?.output ?? 0;
        cost += u?.cost?.total ?? 0;
      }
      usageCache = { key, input, output, cost };
      return usageCache;
    } catch {
      return { input: 0, output: 0, cost: 0 };
    }
  }

  // ---- header ----
  function headerFactory(ctx: ExtensionContext) {
    return (_tui: TUI, theme: Theme): Component => ({
      invalidate() {},
      render(width: number): string[] {
        const out: string[] = [''];
        if (width >= 24) {
          LOGO.forEach((line, i) => out.push(` ${brand(line, Math.floor(i / 2))}`));
          out.push('');
        }
        const model = ctx.model ? `${ctx.model.id} · ${pi.getThinkingLevel()}` : 'no model selected';
        const key = (k: string, d: string) => `${brand(k, 1)} ${theme.fg('muted', d)}`;
        const lines = [
          `${theme.bold('Protected Pi')} ${theme.fg('dim', `v${VERSION}`)}  ${theme.fg('muted', model)}`,
          theme.fg('muted', compactPath(ctx.cwd, 72)),
          '',
          [key('/', 'commands'), key('@', 'files'), key('!', 'shell'), key('esc', 'interrupt')].join(theme.fg('dim', '  ·  ')),
          [key('shift+tab', 'Auto Off → Low → Medium → Spec'), key('ctrl+o', 'expand tools')].join(theme.fg('dim', '  ·  ')),
          theme.fg('dim', 'Every tool runs in Bubblewrap; /ui classic restores the stock Pi look.'),
        ];
        const boxWidth = Math.min(width - 1, 84);
        if (boxWidth < 30) return [...out, ...lines.map(l => truncateToWidth(` ${l}`, width))];
        return [...out, ...boxLines(lines, boxWidth, s => theme.fg('border', s)).map(l => ` ${l}`)];
      },
    });
  }

  // ---- footer ----
  function footerFactory(ctx: ExtensionContext) {
    return (tui: TUI, theme: Theme, footerData: {
      getGitBranch(): string | null;
      getExtensionStatuses(): ReadonlyMap<string, string>;
      onBranchChange(cb: () => void): () => void;
    }): Component & { dispose?(): void } => {
      activeTui = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const snap = getProtectedSnapshot();
          const banner = autonomyBanner({ mode: snap?.mode ?? 'ACCEPT-EDITS', autonomy: snap?.autonomy, returnMode: snap?.returnMode });
          const badge = banner.tone === 'spec' ? theme.fg('warning', theme.bold(banner.label))
            : banner.tone === 'locked' ? theme.fg('error', theme.bold(banner.label))
              : banner.tone === 'off' ? theme.bold(theme.fg('text', banner.label))
                : brand(theme.bold(banner.label), banner.tone === 'medium' ? 0 : 2);
          const hint = options.cycle && snap?.mode !== 'READ-ONLY' ? theme.fg('dim', '  shift+tab to cycle') : '';
          const model = ctx.model ? `${ctx.model.id} · ${pi.getThinkingLevel()}` : 'no model';
          const right = theme.fg('muted', model);
          const room = width - 2 - visibleWidth(right) - 2;
          const desc = theme.fg('muted', ` – ${banner.description}`);
          let left = `${badge}${desc}${hint}`;
          if (visibleWidth(left) > room) left = `${badge}${desc}`;
          if (visibleWidth(left) > room) left = truncateToWidth(left, Math.max(visibleWidth(badge), room));
          const line1 = ` ${fitLeftRight(left, right, width - 2)}`;

          let usage: ReturnType<typeof ctx.getContextUsage> | undefined;
          try { usage = ctx.getContextUsage(); } catch { usage = undefined; }
          const totals = usageTotals(ctx);
          const extras = [...footerData.getExtensionStatuses()]
            .filter(([key]) => key !== 'pi-protected')
            .map(([, text]) => text);
          const parts = footerDetailParts({
            cwd: ctx.cwd,
            branch: footerData.getGitBranch(),
            snapshot: snap,
            contextPercent: usage?.percent,
            contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
            inputTokens: totals.input,
            outputTokens: totals.output,
            cost: totals.cost,
            extraStatuses: extras,
          });
          const line2 = ` ${truncateToWidth(theme.fg('dim', parts.join(' · ')), Math.max(1, width - 2))}`;
          return [line1, line2];
        },
      };
    };
  }

  // ---- boxed editor with a "> " prompt ----
  class DroidEditor extends CustomEditor {
    constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
      super(tui, theme, keybindings, { paddingX: 0 });
      activeTui = tui;
    }

    render(width: number): string[] {
      if (!droid() || width < 16) return super.render(width);
      const inner = width - 6;
      const lines = super.render(inner);
      const self = this as unknown as { renderedVisibleLineCount?: number; getText?: () => string };
      const visible = self.renderedVisibleLineCount ?? Math.max(1, lines.length - 2);
      const bottomIndex = Math.min(lines.length - 1, visible + 1);
      const b = (s: string) => this.borderColor(s);
      const text = self.getText?.() ?? '';
      const promptGlyph = text.startsWith('!') ? '!' : '>';
      const out: string[] = [b('╭──') + lines[0] + b('──╮')];
      for (let i = 1; i < bottomIndex; i++) {
        const prefix = i === 1 ? ` ${brand(promptGlyph, 0)} ` : '   ';
        out.push(`${b('│')}${prefix}${lines[i]} ${b('│')}`);
      }
      out.push(b('╰──') + lines[bottomIndex] + b('──╯'));
      for (let i = bottomIndex + 1; i < lines.length; i++) out.push(`    ${lines[i]}  `);
      return out;
    }

    handleMouse(event: Parameters<CustomEditor['handleMouse']>[0]) {
      if (!droid() || event.width < 16) return super.handleMouse(event);
      return super.handleMouse({ ...event, x: event.x - 4, width: event.width - 6 });
    }
  }

  // ---- tool rows ----
  pi.registerToolRenderer((toolName, next) => {
    if (!droid()) return next();
    const tool = canonicalToolName(toolName);
    return {
      renderShell: 'self',
      renderCall(args, theme, context) {
        const { label, detail } = toolHeader(toolName, args, context.cwd);
        const head = context.isError
          ? theme.fg('error', theme.bold(label))
          : context.isPartial
            ? theme.fg('muted', theme.bold(label))
            : brand(theme.bold(label), 1);
        const shownLabel = tool === 'todo' ? `${head}${theme.fg('muted', theme.bold(' UPDATED'))}` : head;
        const text = shownLabel + (detail ? theme.fg('muted', `  (${detail})`) : '');
        const component = (context.lastComponent as Text | undefined) ?? new Text('', context.outputPad, 0);
        component.setText(text);
        return component;
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        const pad = context.outputPad;
        const container = (context.lastComponent as Container | undefined) ?? new Container();
        container.clear();
        if (isPartial) {
          const partial = resultText(result);
          const lastLine = partial.trimEnd().split('\n').pop() ?? '';
          container.addChild(new Text(theme.fg('dim', `↳ ${lastLine ? oneLine(lastLine, 120) : 'running…'}`), pad, 0));
          return container;
        }
        const summary = summarizeToolResult(toolName, context.args, result, context.isError);
        const seconds = context.durationMs !== undefined && context.durationMs >= 1000
          ? theme.fg('dim', `  ${(context.durationMs / 1000).toFixed(1)}s`) : '';
        const details = (result.details && typeof result.details === 'object' ? result.details : {}) as Record<string, unknown>;
        const diff = tool === 'edit' && typeof details.diff === 'string' ? details.diff : '';
        const output = resultText(result);
        const expandable = !context.isError && (diff ? false : output.trim().length > 0 && tool !== 'todo');
        const hint = expandable && !expanded ? theme.fg('dim', `  ${context.keyHint('app.tools.expand', 'to expand')}`) : '';
        const line = context.isError ? theme.fg('error', `↳ ${summary}`) : theme.fg('muted', `↳ ${summary}`);
        container.addChild(new Text(line + seconds + hint, pad, 0));

        if (tool === 'todo') {
          const rows = todoLines(context.args?.items).map(({ mark, text, status }) =>
            status === 'completed' ? theme.fg('dim', `${mark} ${theme.strikethrough(text)}`)
              : status === 'in_progress' ? brand(`${mark} ${text}`, 1)
                : theme.fg('text', `${mark} ${text}`));
          if (rows.length) container.addChild(new Text(indentBlock(rows.join('\n'), 2), pad, 0));
        } else if (diff) {
          const lines = renderDiff(diff).split('\n');
          const limit = expanded ? lines.length : 24;
          let body = lines.slice(0, limit).join('\n');
          if (lines.length > limit) {
            body += `\n${theme.fg('dim', `… ${lines.length - limit} more lines  ${context.keyHint('app.tools.expand', 'to expand')}`)}`;
          }
          container.addChild(new Text(indentBlock(body, 2), pad, 0));
        } else if (context.isError && output.trim()) {
          const lines = output.trimEnd().split('\n');
          const shown = expanded ? lines : lines.slice(-6);
          container.addChild(new Text(indentBlock(shown.map(l => theme.fg('dim', l)).join('\n'), 2), pad, 0));
        } else if (expanded && output.trim()) {
          const lines = output.trimEnd().split('\n');
          const limit = 400;
          let body = lines.slice(0, limit).map(l => theme.fg('toolOutput', l)).join('\n');
          if (lines.length > limit) body += `\n${theme.fg('dim', `… ${lines.length - limit} more lines`)}`;
          container.addChild(new Text(indentBlock(body, 2), pad, 0));
        }
        return container;
      },
    };
  });

  // ---- per-turn change summary (entries appended by secret-tools on agent_end) ----
  pi.registerEntryRenderer<TurnChanges>('pi-turn-changes', (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data || !Array.isArray(data.files) || typeof data.total !== 'number') return undefined;
    const { headline, rows, more } = formatTurnChanges(data, expanded ? 50 : 5);
    const bullet = droid() ? brand('●', 0) : theme.fg('accent', '●');
    const head = `${bullet} ${theme.bold(headline)}${theme.fg('dim', '  ·  /diff to review  ·  /rewind to undo')}`;
    const body = rows.map(row => theme.fg('muted', `  ${row}`));
    if (more > 0) body.push(theme.fg('dim', `  … ${more} more file${more === 1 ? '' : 's'}${expanded ? '' : ' (ctrl+o to expand)'}`));
    return new Text([head, ...body].join('\n'), 1, 0);
  });

  // ---- assistant marker ----
  // Pi keeps one markdown transformer per extension, and every protected module shares this
  // extension's `pi`. Later registrations (pi-plan's done markers) are chained ahead of ours
  // instead of replacing it.
  type Transformer = Parameters<ExtensionAPI['registerMarkdownTransformer']>[0];
  type TransformerOptions = Parameters<ExtensionAPI['registerMarkdownTransformer']>[1];
  type SurfaceType = NonNullable<NonNullable<TransformerOptions>['messageTypes']>[number];
  const defaultSurfaces: SurfaceType[] = ['user', 'assistant', 'assistant-thinking'];
  const chained: Array<{ transform: Transformer; surfaces: Set<SurfaceType> }> = [];
  const registerTransformer = pi.registerMarkdownTransformer.bind(pi);
  const composite: Transformer = (markdown, context) => {
    let out = markdown;
    for (const { transform, surfaces } of chained) {
      if (!surfaces.has(context.messageType as SurfaceType)) continue;
      try {
        out = transform(out, context);
      } catch {
        // Keep the Markdown produced so far, as Pi does for a throwing transformer.
      }
    }
    if (!droid() || context.messageType !== 'assistant') return out;
    return prefixAssistantMarkdown(out);
  };
  const publishComposite = () => {
    const surfaces = new Set<SurfaceType>(['assistant']);
    for (const entry of chained) for (const surface of entry.surfaces) surfaces.add(surface);
    registerTransformer(composite, { messageTypes: [...surfaces] });
  };
  try {
    pi.registerMarkdownTransformer = (transform, transformerOptions) => {
      chained.push({ transform, surfaces: new Set(transformerOptions?.messageTypes ?? defaultSurfaces) });
      publishComposite();
    };
  } catch {
    // A read-only API object: a later transformer then replaces the marker, which is display-only.
  }
  publishComposite();

  // ---- working line ----
  function refreshWorking(): void {
    const ctx = latestCtx;
    if (!ctx?.hasUI || !droid() || !workStarted || typeof ctx.ui.setWorkingMessage !== 'function') return;
    ctx.ui.setWorkingMessage(workingMessage(Date.now() - workStarted, [...runningTools.values()]));
  }

  function stopWorking(): void {
    if (workTimer) clearInterval(workTimer);
    workTimer = undefined;
    workStarted = 0;
    runningTools.clear();
    if (latestCtx?.hasUI && latestCtx.mode === 'tui' && typeof latestCtx.ui.setWorkingMessage === 'function') {
      latestCtx.ui.setWorkingMessage();
    }
  }

  pi.on('agent_start', async (_event, ctx) => {
    latestCtx = ctx;
    if (!droid() || ctx.mode !== 'tui' || !hasTuiHooks(ctx)) return;
    stopWorking();
    workStarted = Date.now();
    refreshWorking();
    workTimer = setInterval(refreshWorking, 1000);
    workTimer.unref?.();
  });
  pi.on('agent_end', async () => stopWorking());
  pi.on('tool_execution_start', async event => {
    if (!workStarted) return;
    runningTools.set(event.toolCallId, toolHeader(event.toolName, event.args).label);
    refreshWorking();
  });
  pi.on('tool_execution_end', async event => {
    runningTools.delete(event.toolCallId);
    refreshWorking();
  });

  // ---- Shift+Tab: only while no extension dialog is open ----
  pi.on('ui_prompt_start', async () => { promptDepth++; });
  pi.on('ui_prompt_end', async () => { promptDepth = Math.max(0, promptDepth - 1); });

  // The interface is cosmetic: hosts without the TUI hooks (or any error here) keep the stock look
  // instead of failing session start.
  function hasTuiHooks(ctx: ExtensionContext): boolean {
    const ui = ctx.ui as unknown as Record<string, unknown>;
    return ['setHeader', 'setFooter', 'setEditorComponent', 'setWorkingIndicator', 'setHiddenThinkingLabel', 'setWorkingMessage', 'onTerminalInput']
      .every(name => typeof ui?.[name] === 'function');
  }

  function apply(ctx: ExtensionContext): void {
    try {
      applyUnsafe(ctx);
    } catch (error) {
      console.error('Pi: Droid-style interface could not be applied; using the stock look:', error);
    }
  }

  function applyUnsafe(ctx: ExtensionContext): void {
    latestCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== 'tui' || !hasTuiHooks(ctx)) return;
    try {
      installDroidTone(ctx.ui.theme, droid);
    } catch {
      // Colors are cosmetic; keep the stock panels if the theme internals differ.
    }
    (activeTui as { invalidate?: () => void } | undefined)?.invalidate?.();
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (droid()) {
      ctx.ui.setHeader(headerFactory(ctx));
      ctx.ui.setFooter(footerFactory(ctx));
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new DroidEditor(tui, theme, keybindings));
      ctx.ui.setWorkingIndicator({ frames: SPINNER.map(f => brand(f, 0)), intervalMs: 80 });
      ctx.ui.setHiddenThinkingLabel('Thinking…');
      if (options.cycle) {
        const cycle = options.cycle;
        unsubscribeInput = ctx.ui.onTerminalInput(data => {
          if (promptDepth > 0 || !matchesKey(data, 'shift+tab')) return undefined;
          cycle(latestCtx ?? ctx);
          activeTui?.requestRender();
          return { consume: true };
        });
      }
    } else {
      stopWorking();
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setWorkingIndicator();
      ctx.ui.setHiddenThinkingLabel();
    }
  }

  pi.on('session_start', async (_event, ctx) => apply(ctx));
  pi.on('session_shutdown', async () => {
    stopWorking();
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    activeTui = undefined;
  });

  pi.registerCommand('ui', {
    description: 'Switch the interface style: /ui [droid | classic] (new tool rows use the new style)',
    async handler(raw, ctx) {
      const arg = raw.trim().toLowerCase();
      if (!arg) {
        ctx.ui.notify(`Interface style: ${style}. Use /ui droid or /ui classic (pi --ui <style> at launch).`, 'info');
        return;
      }
      if (arg !== 'droid' && arg !== 'classic') {
        ctx.ui.notify('Usage: /ui [droid | classic]', 'warning');
        return;
      }
      if (arg === style) {
        ctx.ui.notify(`Interface style is already ${style}.`, 'info');
        return;
      }
      style = arg;
      apply(ctx);
      ctx.ui.notify(`Interface style: ${style}. Earlier tool rows keep their previous look.`, 'info');
    },
  });

  return { getStyle: () => style };
}
