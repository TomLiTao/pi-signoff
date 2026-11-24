/**
 * pi-plan Extension
 *
 * Read-only exploration mode with plan-then-execute workflow.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - /plan:status to view current plan and progress
 * - --plan flag to start in plan mode
 * - Multi-layer bash safety (shell constructs, redirects, pipes, whitelist)
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to track step completion during execution
 * - Progress tracking widget during execution
 * - Branch-aware state via session entries
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { checkCommand } from "../../src/safety.js";
import { extractPlanSteps } from "../../src/planner.js";
import {
  isPlanPausedText,
  markCompletedSteps,
  getCompletionStats,
  settledPlanOutcome,
} from "../../src/progress.js";
import type { PlanStep, PlanMode, PlanState, PlanMessageDetails } from "../../src/types.js";
import { renderPlanMessage, transformDoneMarkers } from "./render.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const UI_ONLY_PLAN_TYPES = new Set([
  "pi-plan-todo-list",
  "pi-plan-complete",
  "pi-plan-ended",
]);

function hasPlanModeActiveBanner(content: unknown): boolean {
  if (typeof content === "string") {
    return content.includes("[PLAN MODE ACTIVE]");
  }
  if (Array.isArray(content)) {
    return content.some(
      (c: { type?: string; text?: string }) =>
        c.type === "text" && Boolean(c.text?.includes("[PLAN MODE ACTIVE]"))
    );
  }
  return false;
}

// Local integration: use the protected tool names and enforce read-only mounts in plan mode.
interface PlanOptions {
  toolPrefix?: string;
  extraPlanTools?: string[];
  extraPlanToolMatcher?: (toolName: string) => boolean;
  isDynamicNormalTool?: (toolName: string) => boolean;
  onPlanModeChange?: (planning: boolean) => void;
  onPlanCleared?: (reason: "complete" | "ended" | "mode-change" | "aborted" | "session-start") => void;
  confirmPlanExecution?: (
    ctx: ExtensionContext,
    steps: PlanStep[],
    assistantText?: string,
  ) => Promise<"execute" | "stay" | "refine">;
  describePlanPermissions?: () => string;
  shouldPauseOnSettled?: () => boolean;
  isWorkflowMode?: () => boolean;
  hasPendingTools?: () => boolean;
  renderWidget?: (ctx: ExtensionContext, mode: PlanMode, steps: PlanStep[]) => void;
}

export default function piPlanExtension(pi: ExtensionAPI, options: PlanOptions = {}) {
  let planMode: PlanMode = "normal";
  let steps: PlanStep[] = [];
  let planPaused = false;
  let runWasPausedAtStart = false;
  let runHadToolCall = false;
  let runCompletedStepCount = 0;
  let hasStructuredStepsThisTurn = false;
  let normalTools: string[] | undefined;
  const planTools = [
    ...PLAN_MODE_TOOLS.map((name) => `${options.toolPrefix ?? ""}${name}`),
    ...(options.extraPlanTools ?? []),
  ];

  // --- Helpers ---

  function applyTools(): void {
    const activeNow = pi.getActiveTools();
    if (!normalTools) {
      normalTools = activeNow;
    } else if (options.isDynamicNormalTool) {
      for (const name of activeNow) {
        if (options.isDynamicNormalTool(name) && !normalTools.includes(name)) {
          normalTools = [...normalTools, name];
        }
      }
    }
    options.onPlanModeChange?.(planMode === "plan");
    pi.setActiveTools(
      planMode === "plan"
        ? normalTools.filter((name) => planTools.includes(name) || Boolean(options.extraPlanToolMatcher?.(name)))
        : normalTools
    );
  }

  function persistState(): void {
    pi.appendEntry("pi-plan", {
      mode: planMode,
      steps,
      ...(planPaused ? { paused: true } : {}),
    });
  }

  function updateUI(ctx: ExtensionContext): void {
    if (planMode === "execute" && steps.length > 0) {
      const { completed, total } = getCompletionStats(steps);
      ctx.ui.setStatus(
        "pi-plan",
        planPaused
          ? ctx.ui.theme.fg("warning", `⏸ ${completed}/${total} paused`)
          : ctx.ui.theme.fg("accent", `📋 ${completed}/${total}`)
      );
    } else if (planMode === "plan") {
      ctx.ui.setStatus("pi-plan", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("pi-plan", undefined);
    }
    if (options.renderWidget) {
      options.renderWidget(ctx, planMode, steps);
      return;
    }
    if (planMode === "execute" && steps.length > 0) {
      const lines = steps.map((item) =>
        item.completed
          ? ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          : `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`
      );
      ctx.ui.setWidget("pi-plan-todos", lines);
    } else {
      ctx.ui.setWidget("pi-plan-todos", undefined);
    }
  }

  function togglePlanMode(ctx: ExtensionContext, rawArgs = ""): void {
    if (!ctx.isIdle() || options.hasPendingTools?.()) {
      ctx.ui.notify("Wait for the current run or command to finish before switching plan mode.", "warning");
      return;
    }
    const sub = rawArgs.trim().toLowerCase();
    if (sub === "cancel" || sub === "stop" || sub === "clear") {
      if (planMode === "normal") {
        ctx.ui.notify("No active plan to cancel.", "info");
        return;
      }
      const wasExecute = planMode === "execute";
      planMode = "normal";
      planPaused = false;
      runWasPausedAtStart = false;
      steps = [];
      hasStructuredStepsThisTurn = false;
      options.onPlanCleared?.("mode-change");
      ctx.ui.notify(
        wasExecute
          ? "Plan execution cancelled. Normal tool policy restored."
          : "Plan mode disabled. Normal tool policy restored."
      );
      applyTools();
      persistState();
      updateUI(ctx);
      return;
    }
    if (planMode === "plan") {
      planMode = "normal";
      planPaused = false;
      runWasPausedAtStart = false;
      steps = [];
      hasStructuredStepsThisTurn = false;
      options.onPlanCleared?.("mode-change");
      ctx.ui.notify("Plan mode disabled. Normal tool policy restored.");
    } else if (planMode === "execute") {
      planMode = "normal";
      planPaused = false;
      runWasPausedAtStart = false;
      steps = [];
      hasStructuredStepsThisTurn = false;
      options.onPlanCleared?.("mode-change");
      ctx.ui.notify("Plan execution cancelled. Normal tool policy restored.");
    } else {
      planMode = "plan";
      planPaused = false;
      runWasPausedAtStart = false;
      steps = [];
      hasStructuredStepsThisTurn = false;
      options.onPlanCleared?.("mode-change");
      ctx.ui.notify("Plan mode enabled. The workspace is read-only.");
    }
    applyTools();
    persistState();
    updateUI(ctx);
  }

  function getLastAssistantText(ctx: ExtensionContext): string | undefined {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type: string;
      message?: { role?: string; content?: unknown };
    }>;

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

      const text = (message.content as Array<{ type?: string; text?: string }>)
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text" && typeof item.text === "string"
        )
        .map((item) => item.text)
        .join("\n");

      return text;
    }

    return undefined;
  }

  function lastExecutionReply(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    const start = branch.findLastIndex((entry) =>
      (entry.type === "custom_message" && entry.customType === "pi-plan-execute") ||
      (entry.type === "custom" && (entry as { customType?: string }).customType === "pi-plan-exec-start")
    );
    if (start < 0) return undefined;
    const entry = branch.slice(start + 1).findLast((item) =>
      item.type === "message" && (item.message.role === "assistant" || item.message.role === "user")
    );
    if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
    const { stopReason, content } = entry.message;
    const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    return { stopReason, text };
  }

  function finishExecution(ctx: ExtensionContext, opts?: { onResume?: boolean }) {
    const reply = lastExecutionReply(ctx);
    const pauseForRejection = !opts?.onResume && options.shouldPauseOnSettled?.() === true;
    const outcome = settledPlanOutcome(steps, reply);

    if (pauseForRejection) {
      const { allDone } = getCompletionStats(steps);
      if (allDone && steps.length > 0) {
        steps[steps.length - 1].completed = false;
      }
      planPaused = true;
      persistState();
      const statsNow = getCompletionStats(steps);
      updateUI(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Plan paused (${statsNow.completed}/${statsNow.total} steps complete): unrequested permission(s) were rejected during execution. Run /rejected or /permissions review to inspect & approve, then ask the agent to continue.`,
          "warning"
        );
      }
      return;
    }

    if (!outcome) {
      const explicitPause = Boolean(
        reply?.stopReason === "stop" && reply.text && isPlanPausedText(reply.text)
      );
      if (explicitPause) {
        planPaused = true;
        if (!opts?.onResume) {
          persistState();
        }
        const statsNow = getCompletionStats(steps);
        updateUI(ctx);
        if (!opts?.onResume && ctx.hasUI) {
          ctx.ui.notify(
            `Plan paused (${statsNow.completed}/${statsNow.total} steps complete). Reply to continue execution, or run /plan cancel to stop the plan.`,
            "warning"
          );
        }
      }
      return;
    }

    // If the plan was already paused at the start of this turn and the assistant gave a pure
    // conversational answer (zero tool calls, zero newly completed steps, remaining steps open),
    // keep the plan paused and preserve upfront permissions until the user resumes or cancels.
    if (
      !opts?.onResume &&
      runWasPausedAtStart &&
      outcome === "ended" &&
      !runHadToolCall &&
      runCompletedStepCount === 0
    ) {
      planPaused = true;
      persistState();
      updateUI(ctx);
      return;
    }

    const { completed, total } = getCompletionStats(steps);
    const finished = steps.map((step) => ({ ...step }));
    planMode = "normal";
    planPaused = false;
    runWasPausedAtStart = false;
    steps = [];
    hasStructuredStepsThisTurn = false;
    options.onPlanCleared?.(outcome);
    applyTools();
    persistState();
    updateUI(ctx);
    pi.sendMessage(
      outcome === "complete" ? {
        customType: "pi-plan-complete",
        content: `**Plan Complete!** ✓\n\n${finished.map((step) => `~~${step.text}~~`).join("\n")}`,
        display: true,
        details: { steps: finished } satisfies PlanMessageDetails,
      } : {
        customType: "pi-plan-ended",
        content: `Plan run ended: ${completed}/${total} steps marked complete.`,
        display: true,
      },
      { triggerTurn: false }
    );
  }

  const progressInstructions =
    "Report completed steps with [DONE:n] once that step's stated goal and core checks succeed. " +
    "If an auxiliary check cannot access sandbox-masked private paths (such as .local, .git, or .env*) and the step's goal can still be satisfied by recording or reporting that limitation, note the limitation clearly and still mark [DONE:n]. " +
    "Reserve [PLAN:PAUSED] (on its own line) for genuine blockers that require user action or permission approval (such as a /rejected command/file or a failed core check); whenever you emit [PLAN:PAUSED], state the exact blocker and what user action will resume execution.";

  // --- CLI flag ---

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // --- Commands ---

  pi.registerCommand("plan", {
    description: "Toggle plan mode or cancel an active plan (/plan [cancel])",
    handler: async (args, ctx) => togglePlanMode(ctx, args),
  });

  pi.registerCommand("plan:status", {
    description: "Show current plan and progress",
    handler: async (_args, ctx) => {
      if (steps.length === 0) {
        ctx.ui.notify("No active plan. Use /plan to start.", "info");
        return;
      }
      const list = steps
        .map((s) => `${s.completed ? "✓" : "○"} ${s.text}`)
        .join("\n");
      const perms = options.describePlanPermissions?.();
      const permLine = perms && perms !== "none" ? `\nApproved plan permissions:${perms}` : "";
      const modeLabel = planPaused && planMode === "execute" ? "execute, paused" : planMode;
      ctx.ui.notify(`Plan (${modeLabel}):\n${list}${permLine}`, "info");
    },
  });

  // --- Shortcut ---

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // --- Tool call filter ---

  pi.on("tool_call", async (event) => {
    if (planMode === "execute") {
      runHadToolCall = true;
      return;
    }
    if (planMode !== "plan") return;

    const prefix = options.toolPrefix ?? "";
    const toolName = event.toolName.startsWith(prefix) ? event.toolName.slice(prefix.length) : event.toolName;

    // Block write/edit tools entirely
    if (toolName === "write" || toolName === "edit") {
      return {
        block: true,
        terminate: true,
        reason: "Plan mode active. File modifications blocked. Use /plan to disable.",
      };
    }

    // Bash safety: multi-layer check
    if (toolName === "bash") {
      const command = event.input.command as string;
      const result = checkCommand(command);
      if (!result.safe) {
        return { block: true, terminate: true, reason: result.reason };
      }
    }
  });

  // --- User ! / !! command filter ---

  pi.on("user_bash", async (event, ctx) => {
    if (planMode !== "plan") return;

    const result = checkCommand(event.command);
    if (result.safe) return;

    if (ctx.hasUI) {
      ctx.ui.notify(`Plan mode blocked: ${result.reason}`, "warning");
    }

    return {
      result: {
        output: `Blocked by pi-plan: ${result.reason}`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  // --- Context filter: strip UI-only cards in all modes & manage pi-plan-context per mode ---

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as { customType?: string; role?: string; content?: unknown };
        // Display-only plan status cards must never enter the LLM transcript (prevents mid-run prefix shifts).
        if (msg.customType && UI_ONLY_PLAN_TYPES.has(msg.customType)) {
          return false;
        }
        if (planMode === "plan") {
          return true;
        }
        if (msg.customType === "pi-plan-context") {
          // In execute mode, retain execute-mode context messages while stripping stale plan-mode banners.
          return planMode === "execute" && !hasPlanModeActiveBanner(msg.content);
        }
        if (msg.role === "user" && hasPlanModeActiveBanner(msg.content)) {
          return false;
        }
        return true;
      }),
    };
  });

  // --- System prompt injection ---

  pi.on("before_agent_start", async (event) => {
    // Pi 1.2+ also fires this for extension-triggered runs. Keep the original
    // user-prompt behavior and avoid double-injecting plan context on execute.
    if (event.messageType !== "user") return;
    if (planMode === "plan") {
      hasStructuredStepsThisTurn = false;
    }

    if (planMode === "plan") {
      return {
        message: {
          customType: "pi-plan-context",
          content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- Enabled tools are limited to: ${planTools.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Instructions:
- Analyze the codebase and understand the task
- Ask clarifying questions if needed
- Call pi_safe_plan (if enabled) with your ordered steps and required permissions (shellPrefixes, shellCommands, files), and output a clear numbered plan under a "Plan:" header (with an optional "Permissions:" section listing any shell prefixes, commands, or files needed)

Plan:
1. First step description
2. Second step description
...

Permissions:
- prefix: ` + "`pytest`" + `
- file: ` + "`AGENTS.md`" + `

Do NOT attempt to make changes — just describe what you would do and what permissions are required.`,
          display: false,
        },
      };
    }

    if (planMode === "execute" && steps.length > 0) {
      runWasPausedAtStart = planPaused;
      runHadToolCall = false;
      runCompletedStepCount = 0;

      const { completed, total } = getCompletionStats(steps);
      const remaining = steps.filter((s) => !s.completed);
      const todoList = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
      const policyBanner = options.isWorkflowMode?.()
        ? "[EXECUTING PLAN — Upfront permissions active; unrequested permissions are rejected by default]"
        : "[EXECUTING PLAN — Normal tool policy applies]";
      const pauseGuidance = planPaused
        ? `\nPlan status: PAUSED (${completed}/${total} steps complete).\n` +
          "- If the user is asking a clarifying or status question (such as why the plan is paused) without asking to continue, answer clearly and include [PLAN:PAUSED] on its own line so the plan stays paused and active.\n" +
          "- If the user asks to continue, resume, or adjust execution, proceed with the remaining steps in order."
        : "\nIf the user asks a clarifying/status question mid-plan without asking to finish or cancel the remaining steps, answer it and include [PLAN:PAUSED] on its own line to keep the plan active.";
      return {
        message: {
          customType: "pi-plan-context",
          content: `${policyBanner}${pauseGuidance}

Remaining steps:
${todoList}

Execute each step in order.
${progressInstructions}`,
          display: false,
        },
      };
    }
  });

  // --- Track progress during execution ---

  pi.on("turn_end", async (event, ctx) => {
    if (planMode !== "execute" || steps.length === 0) return;
    const msg = event.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    const text = (msg.content as Array<{ type: string; text?: string }>)
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const newlyCompleted = markCompletedSteps(text, steps);
    if (newlyCompleted > 0) {
      runCompletedStepCount += newlyCompleted;
      planPaused = false;
      updateUI(ctx);
      persistState();
    }
  });

  // --- After the agent has fully settled: extract plan or check completion ---

  pi.on("agent_settled", async (event, ctx) => {
    // Do not prompt after the user aborted the run; clear any ephemeral plan grants
    if (event.aborted) {
      options.onPlanCleared?.("aborted");
      return;
    }

    // Check if execution is complete
    if (planMode === "execute" && steps.length > 0) {
      finishExecution(ctx);
      return;
    }

    if (planMode !== "plan" || !ctx.hasUI) return;

    // Extract todos from the last assistant message unless pi_safe_plan already recorded structured steps
    const text = getLastAssistantText(ctx);
    if (!hasStructuredStepsThisTurn && text) {
      const extracted = extractPlanSteps(text);
      if (extracted.length > 0) {
        steps = extracted;
        persistState();
      }
    }
    hasStructuredStepsThisTurn = false;

    // Show plan and prompt for next action + upfront permissions
    if (steps.length > 0) {
      const list = steps.map((s) => `${s.step}. ☐ ${s.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "pi-plan-todo-list",
          content: `**Plan Steps (${steps.length}):**\n\n${list}`,
          display: true,
          details: { steps: steps.map((s) => ({ ...s })) } satisfies PlanMessageDetails,
        },
        { triggerTurn: false }
      );
    }

    let nextAction: "execute" | "stay" | "refine" = "stay";
    if (options.confirmPlanExecution) {
      nextAction = await options.confirmPlanExecution(ctx, steps, text);
    } else {
      const choice = await ctx.ui.select("Plan mode — what next?", [
        steps.length > 0 ? "Execute the plan" : "Execute the plan (no steps detected)",
        "Stay in plan mode",
        "Refine the plan",
      ]);
      if (choice?.startsWith("Execute")) nextAction = "execute";
      else if (choice === "Refine the plan") nextAction = "refine";
    }

    if (nextAction === "execute") {
      if (steps.length === 0 && options.confirmPlanExecution) {
        steps = [{ step: 1, text: "Execute approved plan", completed: false }];
      }
      planMode = steps.length > 0 ? "execute" : "normal";
      planPaused = false;
      runWasPausedAtStart = false;
      runHadToolCall = false;
      runCompletedStepCount = 0;
      applyTools();
      persistState();
      if (planMode === "execute") {
        pi.appendEntry("pi-plan-exec-start", { total: steps.length });
      }
      updateUI(ctx);

      const execMsg =
        steps.length > 0
          ? `Execute the plan. Start with: ${steps[0].text}\n\n${progressInstructions}`
          : "Execute the plan you just created.";
      pi.sendMessage(
        {
          customType: "pi-plan-execute",
          content: execMsg,
          display: true,
          details: {
            steps: steps.filter((s) => !s.completed).map((s) => ({ ...s })),
          } satisfies PlanMessageDetails,
        },
        { triggerTurn: true }
      );
    } else if (nextAction === "refine") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // --- Message cards + [DONE:n] rendering ---

  pi.registerMessageRenderer<PlanMessageDetails>(
    "pi-plan-todo-list",
    (message, options, theme) =>
      renderPlanMessage("todo", message.content, message.details, options, theme)
  );
  pi.registerMessageRenderer<PlanMessageDetails>(
    "pi-plan-complete",
    (message, options, theme) =>
      renderPlanMessage("complete", message.content, message.details, options, theme)
  );
  pi.registerMessageRenderer<PlanMessageDetails>(
    "pi-plan-execute",
    (message, options, theme) =>
      renderPlanMessage("execute", message.content, message.details, options, theme)
  );

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant") return markdown;
    return transformDoneMarkers(markdown);
  });

  // --- Restore state on session start/resume ---

  pi.on("session_start", async (_event, ctx) => {
    planMode = "normal";
    planPaused = false;
    runWasPausedAtStart = false;
    runHadToolCall = false;
    runCompletedStepCount = 0;
    steps = [];
    hasStructuredStepsThisTurn = false;
    options.onPlanCleared?.("session-start");

    // Restore from branch entries (branch-aware)
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        (entry as { customType?: string }).customType === "pi-plan"
      ) {
        const data = (entry as { data?: PlanState }).data;
        if (data) {
          planMode = data.mode ?? planMode;
          steps = data.steps ?? steps;
          planPaused = Boolean(data.paused) && planMode === "execute";
        }
      }
    }

    // An explicit startup flag takes precedence over previously saved execution state.
    if (pi.getFlag("plan") === true) {
      if (planMode !== "plan") steps = [];
      planMode = "plan";
      planPaused = false;
    }

    // On resume in execute mode: rebuild completion from messages after last execute marker
    if (planMode === "execute" && steps.length > 0) {
      const branch = ctx.sessionManager.getBranch() as Array<{
        type: string;
        customType?: string;
        data?: PlanState;
        message?: { role: string; content?: unknown };
      }>;
      let executeIndex = -1;
      for (let i = branch.length - 1; i >= 0; i--) {
        if (
          branch[i].type === "custom" &&
          branch[i].customType === "pi-plan" &&
          branch[i].data?.mode === "execute"
        ) {
          executeIndex = i;
          break;
        }
      }

      const relevantEntries = branch.slice(executeIndex + 1);
      const allText = relevantEntries
        .filter(
          (e) =>
            e.type === "message" &&
            e.message?.role === "assistant" &&
            Array.isArray(e.message?.content)
        )
        .flatMap((e) =>
          (e.message!.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text!)
        )
        .join("\n");

      markCompletedSteps(allText, steps);
      // Clear a finished execution left active by an older version when that session is resumed.
      finishExecution(ctx, { onResume: true });
    }

    applyTools();
    updateUI(ctx);
  });

  function setPlanMode(enabled: boolean, ctx?: ExtensionContext): boolean {
    if (ctx && (!ctx.isIdle() || options.hasPendingTools?.())) {
      ctx.ui.notify("Wait for the current run or command to finish before switching permission mode.", "warning");
      return false;
    }
    const target: PlanMode = enabled ? "plan" : "normal";
    if (planMode !== target) {
      planMode = target;
      planPaused = false;
      runWasPausedAtStart = false;
      steps = [];
      hasStructuredStepsThisTurn = false;
      options.onPlanCleared?.("mode-change");
      applyTools();
      persistState();
      if (ctx) updateUI(ctx);
    }
    return true;
  }

  function setPlannedSteps(newSteps: PlanStep[]): void {
    steps = newSteps.map(step => ({ ...step }));
    planPaused = false;
    hasStructuredStepsThisTurn = steps.length > 0;
    persistState();
  }

  function startExecution(newSteps: PlanStep[], ctx: ExtensionContext): void {
    steps = newSteps.map(step => ({ ...step }));
    planPaused = false;
    runWasPausedAtStart = false;
    runHadToolCall = false;
    runCompletedStepCount = 0;
    hasStructuredStepsThisTurn = false;
    planMode = "execute";
    applyTools();
    persistState();
    pi.appendEntry("pi-plan-exec-start", { total: steps.length });
    updateUI(ctx);
    if (steps.length > 0) {
      const list = steps.map((s) => `${s.step}. ☐ ${s.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "pi-plan-todo-list",
          content: `**Plan Steps (${steps.length}):**\n\n${list}`,
          display: true,
          details: { steps: steps.map((s) => ({ ...s })) } satisfies PlanMessageDetails,
        },
        { triggerTurn: false }
      );
    }
  }

  function setNormalToolActive(toolName: string, active: boolean): void {
    if (!normalTools) return;
    if (active && !normalTools.includes(toolName)) normalTools = [...normalTools, toolName];
    if (!active && normalTools.includes(toolName)) normalTools = normalTools.filter(t => t !== toolName);
  }

  return Object.assign(
    () => ({ mode: planMode, steps: steps.map(step => ({ ...step })), paused: planPaused }),
    { setPlanMode, setPlannedSteps, startExecution, setNormalToolActive, reapplyTools: applyTools },
  );
}
