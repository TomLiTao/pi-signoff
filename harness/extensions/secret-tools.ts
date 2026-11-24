import { execFileSync, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { BashOperations, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { askApproval, checkShellDeny, editDecision, loadEditPolicy, shellNeedsApproval, suggestShellPrefix } from './approvals.ts';
import { askUserToolName, registerAskUser } from './ask-user.ts';
import { createAuditLogger } from './audit.ts';
import { parseAutonomyLevel, parseSpecThinkingLevel, registerAutonomy, type AutonomyHandle } from './autonomy.ts';
import { registerCheckpoints } from './checkpoints.ts';
import { describeDefaults, isNeverAutoGlob, projectDefaultsStore, type ProjectDefaults } from './project-defaults.ts';
import { neverAutoMatch, parseScriptCommand, scriptFingerprint } from './script-grants.ts';
import { createEgressGuard } from './egress-guard.ts';
import { IMAGE_READ_GUIDELINE, withImagesForModel } from './read-images.ts';
import { bashOutcome, formatRunDetail, formatRunLine, leadingCommand, outputTail, runLogStore, type RunRecord } from './run-log.ts';
import { registerCodeIntel } from './code-intel.ts';
import { registerDataTool } from './data-tool.ts';
import { registerDeps } from './deps.ts';
import { registerPr } from './pr.ts';
import { registerHandoff } from './handoff.ts';
import { createToolGate } from './concurrency.ts';
import { registerContextCommand } from './context-cmd.ts';
import { registerDroids, resolveDelegateExecution, type DroidsHandle } from './droids.ts';
import { gitRemoteToolName, gitToolName, registerGitTools } from './git-tools.ts';
import { registerHooks, type HooksHandle } from './hooks.ts';
import { createMaskCache } from './mask-cache.ts';
import { createOutputBudget, registerOutputBudget } from './output-budget.ts';
import { registerMcpBridges, type McpBridgesHandle } from './mcp-bridge.ts';
import { memoryToolName, registerMemory, type MemoryHandle } from './memory.ts';
import { keepToolOrderStable } from './tool-order.ts';
import { registerSessionIdentity } from './session-identity.ts';
import { planToolName, registerPlanPermissions, type PlanPermissionsHandle } from './plan-permissions.ts';
import { parseNotifyMode, registerPreferences, type PreferencesHandle } from './preferences.ts';
import { adaptCorePromptGuidelines, registerProjectInstructions, type InstructionsHandle } from './project-instructions.ts';
import { registerShellApprovals } from './shell-approvals.ts';
import { registerSkills, type SkillsHandle } from './skills.ts';
import { updateProtectedStatus, type PermissionModeLabel } from './status.ts';
import { nextDroidCycleStep, parseUiStyle } from './droid-ui-format.ts';
import { registerTodos, todoToolName, type TodosHandle } from './todos.ts';
import { registerTiming } from './timing.ts';
import type { registerJobs } from './jobs.ts';
import type { PlanState } from './pi-plan/src/types.ts';
import { braveUsage, registerWebFetch, registerWebSearch, webFetchTool, webSearchTool } from './web-search.ts';
import {
  createBashToolDefinition, createCodemodeExtension, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createMcpExtension, createReadToolDefinition,
  createToolSearchExtension, createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';

const dir = process.env.PI_PROTECTED_DIR!;
const nodeHome = process.env.PI_PROTECTED_NODE_HOME!;
const definitions = [
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
].map(create => create(process.cwd()));
const toolPrefix = 'pi_safe_';
const readOnlyCoreNames = new Set(['read', 'grep', 'find', 'ls']);
const names = new Set(definitions.map(tool => `${toolPrefix}${tool.name}`));
const jobStart = 'pi_safe_job_start';
const jobStatus = 'pi_safe_job_status';
const jobCancel = 'pi_safe_job_cancel';
const checkTool = 'pi_safe_test';
const delegateTool = 'pi_safe_delegate';
const jobNames = [jobStart, jobStatus, jobCancel, checkTool, delegateTool];
const gate = createToolGate(4);
const maskCache = createMaskCache(dir);
const outputBudget = createOutputBudget();
const worker = process.env.PI_PROTECTED_WORKER === '1';
const worktreeWorker = worker && process.env.PI_PROTECTED_WORKTREE_WORKER === '1';
const workerPlanning = worker && !worktreeWorker && process.env.PI_PROTECTED_WORKER_PLAN === '1';
const startModeEnv = !worker ? process.env.PI_PROTECTED_START_MODE : undefined;
const rawDelegateBudget = process.env.PI_PROTECTED_DELEGATE_BUDGET;
const delegateBudgetMax = !worker && rawDelegateBudget !== undefined
  ? Math.max(0, Number.parseInt(rawDelegateBudget, 10) || 0)
  : (!worker ? 4 : 0);
let planning = !worker && (process.argv.includes('--plan') || startModeEnv === 'plan');
let writeSubMode: 'ask-edits' | 'accept-edits' | 'workflow' =
  startModeEnv === 'workflow' ? 'workflow' : startModeEnv === 'ask-edits' ? 'ask-edits' : 'accept-edits';
let turnReadOnly = () => false;
let getSkillMounts: () => Array<[string, string]> = () => [];

function sandboxInvocation(mode: '--tool' | '--shell' | '--lsp' | '--data', cwd: string, args: string[], forceReadonly = false) {
  const env = { ...process.env };
  delete env.PI_SANDBOX_MASKS_FD;
  delete env.PI_SANDBOX_SKILL_MOUNTS;
  delete env.PI_SANDBOX_OUTPUT_DIR;
  const outputDir = outputBudget.hostDir();
  if (outputDir && (mode === '--tool' || mode === '--shell')) env.PI_SANDBOX_OUTPUT_DIR = outputDir;
  if (!worker) {
    const mounts = getSkillMounts();
    if (mounts.length > 0) env.PI_SANDBOX_SKILL_MOUNTS = JSON.stringify(mounts);
  }
  if (planning || (worker && !worktreeWorker) || forceReadonly || turnReadOnly()) delete env.PI_PROTECTED_WRITE_ROOT;
  return { file: '/usr/bin/python3', args: ['-I', `${dir}/sandbox.py`, mode, cwd, nodeHome, ...args], env };
}

async function run(
  mode: '--tool' | '--shell' | '--data', cwd: string, args: string[], input: string,
  onData: (data: Buffer) => void, signal?: AbortSignal, timeout?: number, forceReadonly = false,
  onStderr: (data: Buffer) => void = onData,
): Promise<{ code: number | null; collapsed: string[] }> {
  if (signal?.aborted) throw new Error('aborted');
  const snapshot = await maskCache.get(cwd);
  if (signal?.aborted) throw new Error('aborted');
  return new Promise((resolve, reject) => {
    const invocation = sandboxInvocation(mode, cwd, args, forceReadonly);
    const child = spawn(invocation.file, invocation.args, {
      env: { ...invocation.env, PI_SANDBOX_MASKS_FD: '3' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      signal,
      timeout: timeout ? timeout * 1000 : undefined,
    });
    const masksPipe = child.stdio[3] as Writable | null;
    masksPipe?.on('error', () => {});
    masksPipe?.end(snapshot.payload);
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onStderr);
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, killedBy) => {
      if (spawnError) reject(spawnError);
      else if (killedBy && timeout) reject(new Error(`timeout:${timeout}`));
      else resolve({ code, collapsed: snapshot.collapsed });
    });
    child.stdin?.end(input);
  });
}

let beforeUserShell: ((cwd: string) => Promise<boolean>) | undefined;

const shell: BashOperations = {
  exec(command, cwd, { onData, signal, timeout }) {
    return gate.runWrite(async () => {
      try {
        const forceReadonly = beforeUserShell ? !(await beforeUserShell(cwd)) : false;
        const { code } = await run('--shell', cwd, [command], '', onData, signal, timeout, forceReadonly);
        return { exitCode: code };
      } finally {
        maskCache.invalidate();
      }
    });
  },
};

export default async function (pi: ExtensionAPI) {
  // Before any extension changes the active tools: a stable order keeps the system prompt cacheable.
  keepToolOrderStable(pi);
  registerSessionIdentity(pi);
  if (!worker && process.env.PI_PROTECTED_TIMING === '1') registerTiming(pi);
  const webEnabled = process.env.PI_PROTECTED_WEB === '1';
  const fetchEnabled = process.env.PI_PROTECTED_FETCH === '1';
  const gitEnabled = process.env.PI_PROTECTED_GIT === '1';
  const hostAccess = process.env.PI_PROTECTED_ACCESS === 'host';
  const gitRemoteEnabled = gitEnabled && hostAccess && !worker;
  const skillsEnabled = !worker && process.env.PI_PROTECTED_SKILLS === '1';
  const hooksEnabled = !worker && process.env.PI_PROTECTED_HOOKS === '1';
  const mcpEnabled = !worker && process.env.PI_PROTECTED_MCP === '1';
  const codemodeEnabled = !worker && process.env.PI_PROTECTED_CODEMODE === '1';
  const toolSearchName = 'tool_search';
  const codemodeName = 'codemode';
  const rawMemoryMode = process.env.PI_PROTECTED_MEMORY;
  const memoryMode: 'off' | 'on' | 'never' = worker || rawMemoryMode === 'never'
    ? 'never'
    : rawMemoryMode === 'on'
      ? 'on'
      : 'off';
  const webTools = new Set([
    ...(webEnabled ? [webSearchTool] : []), ...(fetchEnabled ? [webFetchTool] : []),
    ...(gitEnabled ? [gitToolName] : []),
    ...(gitRemoteEnabled ? [gitRemoteToolName] : []),
    ...(hostAccess && !worker ? ['pi_safe_sessions'] : []),
    ...(!worker ? [todoToolName, planToolName, askUserToolName] : []),
    ...(codemodeEnabled ? [toolSearchName, codemodeName] : []),
    ...(!worker && memoryMode !== 'never' ? [memoryToolName] : []),
    // Read-only helpers (data previews/SQL and the Python language server), main session only.
    ...(!worker ? ['pi_safe_data', ...(process.env.PI_PROTECTED_CODE_INTEL !== '0' ? ['pi_safe_code'] : [])] : []),
  ]);
  let audit: ReturnType<typeof createAuditLogger> | undefined;
  if (!worker) {
    try {
      audit = createAuditLogger(process.cwd());
    } catch (error) {
      console.error('Pi: could not initialize approval audit log:', error);
    }
  }
  let latestCtx: ExtensionContext | undefined;
  let onShellJobStartedRef: ((job: { id: number; command: string; cwd: string }) => void) | undefined;
  let onShellJobFinishedRef: ((job: { id: number; state: string; exit?: string; elapsedMs?: number; output: string }) => void) | undefined;
  let currentCheckpointRef = process.env.PI_PROTECTED_CHECKPOINT_REF;
  let delegatesRemaining = delegateBudgetMax;
  let jobsRef: ReturnType<typeof registerJobs> | undefined;
  let runsHandle: ReturnType<typeof import('./runs.ts').registerRuns> | undefined;

  let checkpoints: ReturnType<typeof registerCheckpoints> | undefined;
  let autonomyHandle: AutonomyHandle | undefined;
  let preferencesHandle: PreferencesHandle | undefined;
  let droidsHandle: DroidsHandle | undefined;
  let editPolicy: ReturnType<typeof loadEditPolicy> | undefined;
  try {
    editPolicy = loadEditPolicy(dir);
  } catch (error) {
    console.error('Pi: could not load protected project policy:', error);
  }

  let planPermissions: PlanPermissionsHandle | undefined;
  let getActivePlanMode: () => PlanState['mode'] = () => (planning ? 'plan' : 'normal');

  function currentModeLabel(cwd: string): PermissionModeLabel {
    if (planning || workerPlanning) return 'PLAN';
    if ((worker && !worktreeWorker) || process.env.PI_PROTECTED_WRITE_ROOT !== cwd || checkpoints?.isTurnReadOnlyFallback()) return 'READ-ONLY';
    if (writeSubMode === 'workflow') return 'WORKFLOW';
    return writeSubMode === 'ask-edits' ? 'ASK-EDITS' : 'ACCEPT-EDITS';
  }

  function neverAutoPatterns(cwd: string): string[] {
    return [...new Set([...(editPolicy?.neverAutoScripts ?? []), ...(readProjectDefaults(cwd).neverAuto ?? [])])];
  }

  function readProjectDefaults(cwd: string): ProjectDefaults {
    if (worker) return {};
    try {
      return projectDefaultsStore(cwd).read();
    } catch {
      return {};
    }
  }

  function refreshStatus(ctx = latestCtx): void {
    if (worker || !ctx) return;
    latestCtx = ctx;
    updateProtectedStatus(ctx, {
      mode: currentModeLabel(ctx.cwd),
      autonomy: autonomyHandle?.getLevel(),
      returnMode: writeSubMode,
      style: preferencesHandle?.getStyle(),
      checkpointRef: currentCheckpointRef,
      activeJobs: jobsRef?.activeCount() ?? 0,
      rejectedCount: planPermissions?.pendingRejectedCount(ctx.cwd) ?? 0,
      delegatesRemaining: delegateBudgetMax > 0 ? delegatesRemaining : undefined,
      delegatesMax: delegateBudgetMax > 0 ? delegateBudgetMax : undefined,
      webEnabled,
      fetchEnabled,
    });
  }

  let notifiedCollapsed = false;
  function notifyCollapsedFromList(ctx: ExtensionContext, collapsed: string[]): void {
    if (worker || notifiedCollapsed || !ctx.hasUI || collapsed.length === 0) return;
    notifiedCollapsed = true;
    const shown = collapsed.slice(0, 4).join(', ') + (collapsed.length > 4 ? ', …' : '');
    ctx.ui.notify(
      `Sandbox masked ${collapsed.length} hardlink-heavy director${collapsed.length === 1 ? 'y' : 'ies'} as empty (${shown}). Use UV_LINK_MODE=copy or pnpm --package-import-method=copy if tools need them.`,
      'warning',
    );
  }

  async function maybeNotifyCollapsed(ctx: ExtensionContext) {
    if (worker || notifiedCollapsed || !ctx.hasUI) return;
    try {
      const snap = await maskCache.get(ctx.cwd);
      notifyCollapsedFromList(ctx, snap.collapsed);
    } catch {
      // Errors surface on tool call or /doctor.
    }
  }

  let shellApprovals: ReturnType<typeof registerShellApprovals> | undefined;
  try {
    shellApprovals = registerShellApprovals(pi, dir, {
      getPolicy: () => editPolicy,
      getMode: cwd => currentModeLabel(cwd).toLowerCase(),
      getPlanGrant: !worker ? () => planPermissions?.describeActiveGrant() : undefined,
      clearPlanGrant: !worker ? () => planPermissions?.clearGrant('manual-clear') ?? false : undefined,
      getRejectedSummary: !worker ? cwd => planPermissions?.formatRejectedSummaryForPermissions(cwd) : undefined,
      neverAuto: !worker
        ? {
          list: cwd => ({ builtIn: editPolicy?.neverAutoScripts ?? [], project: readProjectDefaults(cwd).neverAuto ?? [] }),
          update: (cwd, glob, add) => {
            if (!isNeverAutoGlob(glob)) throw new Error('Use a simple glob such as *broker* or scripts/live/*.');
            const current = readProjectDefaults(cwd).neverAuto ?? [];
            const next = add ? [...new Set([...current, glob])] : current.filter(g => g !== glob);
            projectDefaultsStore(cwd).update({ neverAuto: next.length ? next : null });
            return next;
          },
        }
        : undefined,
      handleRejectedSubcommand: !worker
        ? async (subArgs, ctx) => {
          await planPermissions?.handleRejectedCommand(subArgs, ctx as ExtensionContext);
        }
        : undefined,
    });
  } catch (error) {
    console.error('Pi: could not initialize saved shell approvals:', error);
  }

  async function authorizeShell(command: string, ctx: ExtensionContext, background = false): Promise<{ rule: string; prompted: boolean }> {
    const store = shellApprovals?.inProject(ctx.cwd) ? shellApprovals : undefined;
    const denyReason = checkShellDeny(command, editPolicy, store?.denyRules() ?? []);
    if (denyReason) {
      const err = new Error(`Shell command blocked by deny policy: ${denyReason}`) as Error & {
        prompted?: boolean;
        auditRule?: string;
        exposeMessage?: boolean;
      };
      err.prompted = false;
      err.auditRule = 'deny-rule';
      err.exposeMessage = true;
      throw err;
    }
    if (planning || workerPlanning) {
      const { checkCommand } = await import('./pi-plan/src/safety.ts');
      const check = checkCommand(command);
      if (!check.safe) throw new Error(check.reason ?? 'Shell command is unavailable in plan mode.');
    }
    if (!shellNeedsApproval(command)) return { rule: 'routine-shell', prompted: false };
    const neverAuto = neverAutoMatch(command, neverAutoPatterns(ctx.cwd));
    if (neverAuto) {
      // Money-moving or deploy scripts: no saved rule, plan grant, rejected-list approval, or
      // autonomy level applies. The user approves each run, even mid-workflow.
      const why = `${neverAuto.target} matches the never-auto pattern "${neverAuto.pattern}", so it asks every time`;
      const fail = (message: string, rule: string, prompted = false): never => {
        const err = new Error(message) as Error & { prompted?: boolean; auditRule?: string; exposeMessage?: boolean };
        err.prompted = prompted;
        err.auditRule = rule;
        err.exposeMessage = true;
        throw err;
      };
      if (worker) fail(`Shell command needs the user's approval on every run (${why}); subagents cannot run it.`, 'never-auto-worker');
      if (!planning && writeSubMode === 'workflow' && getActivePlanMode() !== 'execute') {
        fail('Workflow mode requires Plan → Ask for Permissions → Execute: non-routine shell commands are blocked before plan approval. Call pi_safe_plan first.', 'workflow-plan-required');
      }
      const approved = await askApproval(ctx, background ? 'Run background shell command' : 'Run shell command', command,
        undefined, undefined, undefined, `⚠ ${why}.`);
      if (!approved) {
        fail(`Shell command not approved (${why}). Do not retry without the user's approval.`,
          ctx.hasUI ? 'user-denied' : 'no-ui-block', Boolean(ctx.hasUI && !ctx.signal?.aborted));
      }
      return { rule: 'never-auto-approved-once', prompted: true };
    }
    if (worktreeWorker) {
      // Isolated worktree subagents get the Auto (Medium) list: read-only inspection plus local
      // test/lint/build commands. Not write-guard.json's allowCommands, whose bare `python3`,
      // `sed`, `mkdir`, and `touch` prefixes would run any script or in-place edit unprompted.
      const { autonomyAllowsShell } = await import('./autonomy.ts');
      if (autonomyAllowsShell('medium', command, editPolicy, store?.denyRules() ?? [])) {
        return { rule: 'worktree-allowlist', prompted: false };
      }
    }
    if (!worker && !planning && writeSubMode === 'workflow' && getActivePlanMode() !== 'execute') {
      const rejRule = planPermissions?.allowsApprovedRejectedShell(command, editPolicy?.neverSessionAllow);
      if (rejRule) return { rule: rejRule, prompted: false };
      const err = new Error(
        'Workflow mode requires Plan → Ask for Permissions → Execute: non-routine shell commands are blocked before plan approval. Inspect read-only first, then call pi_safe_plan with your ordered steps and required permissions (shellPrefixes, shellCommands, files).',
      ) as Error & { prompted?: boolean; auditRule?: string; exposeMessage?: boolean };
      err.prompted = false;
      err.auditRule = 'workflow-plan-required';
      err.exposeMessage = true;
      throw err;
    }
    if (store?.allows(command)) return { rule: 'saved-exact', prompted: false };
    if (store?.allowsPrefix(command, editPolicy?.neverSessionAllow)) return { rule: 'saved-prefix', prompted: false };
    const savedScript = store && !worker && !planning ? store.scriptStatus(command, editPolicy) : 'none';
    if (savedScript === 'match') return { rule: 'saved-script', prompted: false };
    if (!worker && !planning && planPermissions) {
      const planRule = planPermissions.allowsShell(command, editPolicy?.neverSessionAllow);
      if (planRule) return { rule: planRule, prompted: false };
    }
    if (!worker && !planning && autonomyHandle) {
      const autoRule = autonomyHandle.allowsShell(command, editPolicy, store?.denyRules() ?? []);
      if (autoRule) return { rule: autoRule, prompted: false };
    }
    if (!worker && !planning && writeSubMode === 'workflow' && getActivePlanMode() === 'execute') {
      const entry = planPermissions?.recordRejectedShell({
        cwd: ctx.cwd,
        command,
        tool: background ? jobStart : `${toolPrefix}bash`,
        ctx,
      });
      const changedNote = entry?.scriptChanged
        ? ' The script or a local module it imports changed after its grant was approved, so the grant no longer applies.'
        : '';
      const err = new Error(
        `Shell command rejected by default during execution${entry ? ` (#${entry.id})` : ''}:${changedNote} permission was not requested in the Ask for Permissions stage (pi_safe_plan). Do not retry without approval; include [PLAN:PAUSED] on its own line if blocked so the user can check and approve rejected commands via /rejected (or /permissions review), or call pi_safe_plan to propose updated permissions.`,
      ) as Error & { prompted?: boolean; auditRule?: string; exposeMessage?: boolean };
      err.prompted = false;
      err.auditRule = 'workflow-exec-rejected-shell';
      err.exposeMessage = true;
      throw err;
    }
    // Do not save an approval under more restrictive permissions than future runs.
    const canPersist = Boolean(store && !worker && !planning && process.env.PI_PROTECTED_WRITE_ROOT === ctx.cwd);
    let savedKind: 'exact' | 'prefix' | 'script' | undefined;
    const remember = canPersist
      ? () => {
        if (planning) throw new Error('Cannot save an approval in plan mode.');
        try {
          store!.add(command);
          savedKind = 'exact';
        } catch (error) {
          ctx.ui.notify(`Shell approval not saved: ${(error as Error).message}`, 'warning');
          throw error;
        }
        ctx.ui.notify('Shell approval saved for this launch folder. Manage with /permissions.', 'info');
      }
      : undefined;
    // A workspace script gets a pinned script rule instead of an unpinned `python -m x` prefix rule.
    const { makeScriptGrant, describeScriptGrant } = await import('./script-grants.ts');
    const scriptPreview = canPersist ? makeScriptGrant(command, ctx.cwd, editPolicy) : null;
    const candidatePrefix = canPersist && !scriptPreview ? suggestShellPrefix(command, editPolicy, store!.denyRules()) : null;
    const rememberPrefix = canPersist && candidatePrefix
      ? {
        label: candidatePrefix.join(' '),
        save: () => {
          if (planning) throw new Error('Cannot save a prefix rule in plan mode.');
          try {
            store!.addPrefix(candidatePrefix, editPolicy?.neverSessionAllow);
            savedKind = 'prefix';
          } catch (error) {
            ctx.ui.notify(`Prefix rule not saved: ${(error as Error).message}`, 'warning');
            throw error;
          }
          ctx.ui.notify(`Prefix rule "${candidatePrefix.join(' ')} …" saved for this launch folder. Manage with /permissions.`, 'info');
        },
      }
      : undefined;
    let rememberScript: Parameters<typeof askApproval>[5];
    if (canPersist) {
      const preview = scriptPreview;
      if (preview) {
        rememberScript = {
          label: describeScriptGrant(preview),
          changed: savedScript === 'changed',
          save: () => {
            if (planning) throw new Error('Cannot save a script rule in plan mode.');
            try {
              store!.addScript(command, editPolicy, preview);
              savedKind = 'script';
            } catch (error) {
              ctx.ui.notify(`Script rule not saved: ${(error as Error).message}`, 'warning');
              throw error;
            }
            ctx.ui.notify(`Script rule saved: ${describeScriptGrant(preview)} runs with any arguments until it or a local module it imports changes. Manage with /permissions.`, 'info');
          },
        };
      }
    }
    if (!await askApproval(ctx, background ? 'Run background shell command' : 'Run shell command', command, remember, rememberPrefix, rememberScript)) {
      const err = new Error('Shell command not approved. Do not retry without user approval.') as Error & { prompted?: boolean; auditRule?: string };
      err.prompted = Boolean(ctx.hasUI && !ctx.signal?.aborted);
      err.auditRule = ctx.hasUI ? 'user-denied' : 'no-ui-block';
      throw err;
    }
    return {
      rule: savedKind === 'prefix' ? 'user-approved-prefix' : savedKind === 'script' ? 'user-approved-script' : savedKind === 'exact' ? 'user-approved-always' : 'user-approved-once',
      prompted: true,
    };
  }

  let instructionsHandle: InstructionsHandle | undefined;
  let memoryHandle: MemoryHandle | undefined;
  let skillsHandle: SkillsHandle | undefined;
  let todosHandle: TodosHandle | undefined;
  let hooksHandle: HooksHandle | undefined;
  let mcpHandle: McpBridgesHandle | undefined;

  const enabledJobTools = new Set<string>();
  if (!worker) {
    let jobs: ReturnType<typeof registerJobs> | undefined;
    let planState: ((() => PlanState) & {
      setPlanMode?: (enabled: boolean, ctx?: ExtensionContext) => boolean;
      setPlannedSteps?: (steps: PlanState['steps']) => void;
      startExecution?: (steps: PlanState['steps'], ctx: ExtensionContext) => void;
      setNormalToolActive?: (toolName: string, active: boolean) => void;
      reapplyTools?: () => void;
    }) | undefined;
    let pendingModeNote: string | null = null;

    type PermMode = 'plan' | 'ask-edits' | 'accept-edits' | 'workflow';
    const modeNotes: Record<PermMode, string> = {
      plan: 'Permission mode switched to plan: workspace is read-only and edit/write tools are disabled.',
      'ask-edits': 'Permission mode switched to ask-edits: every edit and write requires user confirmation.',
      'accept-edits': 'Permission mode switched to accept-edits: workspace edits within normal paths run without confirmation.',
      workflow: 'Permission mode switched to workflow: strict Plan → Ask for Permissions (pi_safe_plan) → Execute sequence; unrequested execution permissions are rejected by default (review with /rejected).',
    };

    function activePermMode(): PermMode {
      return planning ? 'plan' : writeSubMode;
    }

    function applyPermMode(next: PermMode, ctx: ExtensionContext, quiet = false): void {
      if (!ctx.isIdle() || gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true) {
        ctx.ui.notify('Wait for active runs or background jobs to finish before switching permission mode.', 'warning');
        return;
      }
      if (next !== 'plan' && process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) {
        ctx.ui.notify('Workspace has no launch checkpoint and remains read-only.', 'warning');
        return;
      }
      const prev = activePermMode();
      if (prev === next) {
        ctx.ui.notify(`Permission mode is already ${next}.`, 'info');
        return;
      }
      if (next === 'plan') {
        if (planState?.setPlanMode && !planState.setPlanMode(true, ctx)) return;
        planning = true;
      } else {
        writeSubMode = next;
        if (planning) {
          if (planState?.setPlanMode && !planState.setPlanMode(false, ctx)) return;
          planning = false;
        }
      }
      planPermissions?.clearGrant('mode-change');
      pendingModeNote = modeNotes[next];
      try {
        pi.appendEntry('pi-permission-mode', { mode: next });
      } catch {
        // Ignore outside active session.
      }
      refreshStatus(ctx);
      if (!quiet) ctx.ui.notify(`Permission mode: ${next} (Ctrl+Alt+Y to cycle).`, 'info');
    }

    function cyclePermMode(ctx: ExtensionContext): void {
      if (process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) {
        ctx.ui.notify('Workspace has no launch checkpoint and remains read-only.', 'warning');
        return;
      }
      const cur = activePermMode();
      const next: PermMode =
        cur === 'plan'
          ? 'ask-edits'
          : cur === 'ask-edits'
            ? 'accept-edits'
            : cur === 'accept-edits'
              ? 'workflow'
              : 'plan';
      applyPermMode(next, ctx);
    }

    pi.registerShortcut('ctrl+alt+y', {
      description: 'Cycle permission mode (plan → ask-edits → accept-edits → workflow)',
      handler: async ctx => cyclePermMode(ctx),
    });

    pi.registerCommand('mode', {
      description: 'View or switch permission mode: /mode [plan | ask-edits | accept-edits | workflow | cycle | default [mode|clear]]',
      async handler(raw, ctx) {
        const arg = raw.trim().toLowerCase();
        if (!arg) {
          const defaults = readProjectDefaults(ctx.cwd);
          ctx.ui.notify(
            `Current permission mode: ${currentModeLabel(ctx.cwd).toLowerCase()} (use Ctrl+Alt+Y or /mode cycle).\n` +
            `This project's launch default: ${describeDefaults(defaults)} (/mode default, /auto default).`,
            'info',
          );
          return;
        }
        const defaultMatch = /^default(?:\s+(\S+))?$/.exec(arg);
        if (defaultMatch) {
          const value = defaultMatch[1];
          if (value === 'status') {
            ctx.ui.notify(`This project's launch default: ${describeDefaults(readProjectDefaults(ctx.cwd))}.`, 'info');
            return;
          }
          let patch: Partial<Record<keyof ProjectDefaults, ProjectDefaults[keyof ProjectDefaults] | null>>;
          if (!value) patch = { mode: writeSubMode, spec: planning ? true : null };
          else if (value === 'clear' || value === 'none') patch = { mode: null, spec: null };
          else if (value === 'plan' || value === 'spec') patch = { mode: writeSubMode, spec: true };
          else if (value === 'ask-edits' || value === 'accept-edits' || value === 'workflow') patch = { mode: value, spec: null };
          else {
            ctx.ui.notify('Usage: /mode default [plan | ask-edits | accept-edits | workflow | clear]  (no value saves the current mode)', 'warning');
            return;
          }
          try {
            const saved = projectDefaultsStore(ctx.cwd).update(patch);
            ctx.ui.notify(`Launch default for this project: ${describeDefaults(saved)}. New sessions here start this way; --mode/--auto flags still override.`, 'info');
          } catch (error) {
            ctx.ui.notify(`Could not save the project default: ${(error as Error).message}`, 'warning');
          }
          return;
        }
        if (arg === 'cycle') {
          cyclePermMode(ctx);
          return;
        }
        if (arg === 'plan' || arg === 'ask-edits' || arg === 'accept-edits' || arg === 'workflow') {
          applyPermMode(arg, ctx);
          return;
        }
        ctx.ui.notify('Usage: /mode [plan | ask-edits | accept-edits | workflow | cycle | default [mode|clear]]', 'warning');
      },
    });

    pi.registerCommand('workflow', {
      description: 'Enable or inspect strict Plan → Ask for Permissions → Execute workflow mode: /workflow [on | off | status | review]',
      async handler(raw, ctx) {
        const arg = raw.trim().toLowerCase();
        if (arg === 'off') {
          applyPermMode('accept-edits', ctx);
          return;
        }
        if (arg === 'review' || arg === 'rejected') {
          await planPermissions?.handleRejectedCommand('review', ctx);
          return;
        }
        if (arg === 'on' || (!arg && activePermMode() !== 'workflow')) {
          applyPermMode('workflow', ctx);
          return;
        }
        if (!arg || arg === 'status') {
          const curMode = currentModeLabel(ctx.cwd).toLowerCase();
          const pMode = getActivePlanMode();
          const stage =
            curMode !== 'workflow'
              ? `inactive (current mode: ${curMode}; run /workflow on or /mode workflow)`
              : pMode === 'execute'
                ? 'Stage 3 — Execute (unrequested permissions rejected by default)'
                : 'Stage 1 — Plan (read-only until pi_safe_plan is approved in Stage 2)';
          const rej = planPermissions?.formatRejectedSummaryForPermissions(ctx.cwd) ?? 'Rejected during execution: none';
          ctx.ui.notify(`Workflow mode: ${stage}\n${rej}`, 'info');
          return;
        }
        ctx.ui.notify('Usage: /workflow [on | off | status | review]', 'warning');
      },
    });

    pi.on('before_agent_start', async (event, ctx) => {
      if (event.systemPromptOptions) {
        const sections = (event.systemPromptOptions.sections ??= {});
        sections.environment = `Current date: ${new Date().toISOString().slice(0, 10)} (UTC)`;
        sections.docs =
          'Protected Pi commands (user-only slash commands): /mode, /workflow, /plan, /rejected, /permissions, /instructions, /doctor, /diff, /review, /rewind, /open, /clip.';
        const guidelines = (event.systemPromptOptions.promptGuidelines ??= []);
        const headlessRule =
          'pi_safe_bash and pi_safe_job_start run inside a headless Linux sandbox without DISPLAY or WAYLAND_DISPLAY: use headless CLI flags (such as libreoffice --headless --convert-to pdf) inside pi_safe_bash, and use pi_safe_open (requesting permissions.openFiles in pi_safe_plan) when the user asks to open a workspace file on the host desktop. Each tool call gets its own empty /tmp, so files left in /tmp do not survive to the next call; keep files that later calls need in the project folder. When a long result is shortened, its full text is saved under /tmp/pi-tool-output/ (read-only, visible to later calls in this session): page through it with pi_safe_read offset/limit or search it with pi_safe_grep instead of re-running the command.';
        if (!guidelines.includes(headlessRule)) guidelines.push(headlessRule);
        if (hostAccess) {
          const accessRule =
            'Access: pi_safe_bash has network access and runs git normally (commit, branch, merge, stash, worktree add/remove) after the usual approvals. It can read your home allowlist (tool runtimes, ~/.gitconfig) and earlier agent session logs under ~/.claude/projects, ~/.codex/sessions, ~/.factory/sessions and ~/.pi/agent/sessions; it writes only the project, its Git folder and /tmp. Keys, tokens and the rest of home are not mounted, and .git/config and hooks are read-only. Use pi_safe_git_remote for fetch, pull and push. To review earlier agent sessions use pi_safe_sessions (digests, not raw logs). For commands that run longer than 30 minutes (solver batches), use pi_safe_run_start (up to 24 h, survives Pi exiting, announces completion) and do not poll.';
          if (!guidelines.includes(accessRule)) guidelines.push(accessRule);
        }
      }
      if (!pendingModeNote) return;
      const content = pendingModeNote;
      pendingModeNote = null;
      if (event.systemPromptOptions) {
        const branch = ctx?.sessionManager?.getBranch?.() ?? [];
        const hasPriorAssistant = branch.some(
          entry => entry.type === 'message' && entry.message.role === 'assistant',
        );
        if (!hasPriorAssistant) return;
      }
      return { message: { customType: 'pi-permission-mode', content, display: false } };
    });
    try {
      checkpoints = registerCheckpoints(pi, {
        dir,
        launchRef: process.env.PI_PROTECTED_CHECKPOINT_REF,
        writeRoot: process.env.PI_PROTECTED_WRITE_ROOT,
        isPlanning: () => planning,
        hasPendingWork: () => gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true,
        onCheckpointChange: ref => {
          currentCheckpointRef = ref;
          refreshStatus();
        },
        onFilesRestored: () => {
          maskCache.invalidate();
        },
        onRewind: () => {
          planPermissions?.clearGrant('rewind');
        },
      });
      turnReadOnly = () => checkpoints?.isTurnReadOnlyFallback() === true;
      beforeUserShell = async cwd => {
        if (!checkpoints || planning || process.env.PI_PROTECTED_WRITE_ROOT !== cwd) return true;
        return checkpoints.ensureMutationCheckpoint(latestCtx, 'shell');
      };
    } catch (error) {
      console.error('Pi: could not initialize per-turn checkpoints:', error);
    }
    try {
      registerAskUser(pi, { onAudit: entry => audit?.record(entry) });
    } catch (error) {
      console.error('Pi: could not initialize ask_user tool:', error);
    }
    try {
      mcpHandle = await registerMcpBridges(pi, {
        dir,
        nodeHome,
        enabled: mcpEnabled,
        createMcpExtension: createMcpExtension as never,
        onActiveServersChanged: () => planState?.reapplyTools?.(),
      });
    } catch (error) {
      console.error('Pi: could not initialize sandboxed MCP bridges:', error);
    }
    const toolSearchEnabled = codemodeEnabled || Boolean(mcpHandle?.hasDeferredTools());
    if (toolSearchEnabled) {
      webTools.add(toolSearchName);
      try {
        createToolSearchExtension()(pi);
      } catch (error) {
        console.error('Pi: could not initialize deferred tool search:', error);
      }
    }
    if (codemodeEnabled) {
      try {
        createCodemodeExtension({ models: false })(pi);
      } catch (error) {
        console.error('Pi: could not initialize codemode:', error);
      }
    }
    try {
      const explicitAuto = parseAutonomyLevel(process.env.PI_PROTECTED_AUTO_LEVEL);
      autonomyHandle = registerAutonomy(pi, {
        initialLevel: explicitAuto ?? readProjectDefaults(process.cwd()).autonomy,
        explicitStartLevel: explicitAuto !== null,
        getDefaultLevel: () => readProjectDefaults(process.cwd()).autonomy,
        saveDefaultLevel: (level, cwd) => describeDefaults(projectDefaultsStore(cwd).update({ autonomy: level })),
        initialSaveSpecs: process.env.PI_PROTECTED_SAVE_SPECS === '1',
        initialSpecThinking: parseSpecThinkingLevel(process.env.PI_PROTECTED_SPEC_THINKING) ?? undefined,
        hasPendingWork: () => gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true,
        isWritable: cwd => process.env.PI_PROTECTED_WRITE_ROOT === cwd && !checkpoints?.isTurnReadOnlyFallback(),
        isPlanning: () => planning,
        getCurrentPlan: () => planState?.(),
        onStatusChange: ctx => refreshStatus(ctx),
        getModeContext: () => ({ workflow: writeSubMode === 'workflow', executing: planState?.().mode === 'execute' }),
      });
    } catch (error) {
      console.error('Pi: could not initialize autonomy and spec controls:', error);
    }
    // Droid-style Shift+Tab ring. Guards match /auto and /mode: refuse while busy or read-only,
    // and only suppress the success toast (the footer shows the new state).
    function droidCycle(ctx: ExtensionContext): void {
      const writable = process.env.PI_PROTECTED_WRITE_ROOT === ctx.cwd && !checkpoints?.isTurnReadOnlyFallback();
      const busy = !ctx.isIdle() || gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true;
      if (!writable && !planning) {
        ctx.ui.notify('Workspace has no launch checkpoint and remains read-only.', 'warning');
        return;
      }
      if (busy) {
        ctx.ui.notify('Wait for active runs or background jobs to finish before changing autonomy or Spec mode.', 'warning');
        return;
      }
      const step = nextDroidCycleStep({ planning, autonomy: autonomyHandle?.getLevel() ?? 'off' });
      if (step.kind === 'enter-spec') {
        applyPermMode('plan', ctx, true);
      } else if (step.kind === 'leave-spec') {
        applyPermMode(writeSubMode, ctx, true);
        if (!planning) autonomyHandle?.setLevel('off', ctx, true);
      } else {
        autonomyHandle?.setLevel(step.level, ctx, true);
      }
      refreshStatus(ctx);
    }
    try {
      const { registerDroidUi } = await import('./droid-ui.ts');
      registerDroidUi(pi, {
        initialStyle: parseUiStyle(process.env.PI_PROTECTED_UI) ?? 'droid',
        cycle: droidCycle,
      });
    } catch (error) {
      console.error('Pi: could not load the Droid-style interface; using the stock Pi look:', error);
    }
    try {
      preferencesHandle = registerPreferences(pi, {
        initialStyleOverride: process.env.PI_PROTECTED_STYLE || undefined,
        initialNotifyOverride: parseNotifyMode(process.env.PI_PROTECTED_NOTIFY) ?? undefined,
        onStatusChange: ctx => refreshStatus(ctx),
      });
    } catch (error) {
      console.error('Pi: could not initialize output style and notification preferences:', error);
    }
    try {
      todosHandle = registerTodos(pi, true);
    } catch (error) {
      console.error('Pi: could not initialize todo list:', error);
    }
    try {
      memoryHandle = registerMemory(pi, {
        mode: memoryMode,
        isPlanning: () => planning,
        runRead: gate.runRead,
        runWrite: gate.runWrite,
        onToolActiveChange: active => planState?.setNormalToolActive?.(memoryToolName, active),
      });
    } catch (error) {
      console.error('Pi: could not initialize project memory:', error);
    }
    try {
      skillsHandle = registerSkills(pi, {
        dir,
        enabled: skillsEnabled,
        secretPaths: editPolicy?.secretPaths ?? [],
      });
      getSkillMounts = () => skillsHandle?.activeSkillMounts() ?? [];
    } catch (error) {
      console.error('Pi: could not initialize skills:', error);
    }
    try {
      droidsHandle = registerDroids(pi, {
        dir,
        enabled: delegateBudgetMax > 0,
        secretPaths: editPolicy?.secretPaths ?? [],
      });
    } catch (error) {
      console.error('Pi: could not initialize custom droids:', error);
    }
    try {
      planPermissions = registerPlanPermissions(pi, {
        getPolicy: () => editPolicy,
        getWriteSubMode: () => writeSubMode,
        getAutonomyLevel: () => autonomyHandle?.getLevel() ?? 'off',
        setAutonomyLevel: (level, ctx) => { autonomyHandle?.setLevel(level, ctx, false); },
        onPlanApproved: ({ summary, steps, outcome, ctx }) => {
          autonomyHandle?.recordApprovedSpec({ cwd: ctx.cwd, summary, steps, classified: outcome.classified, ctx });
        },
        onRejectedChange: ctx => refreshStatus(ctx ?? latestCtx),
        onResumeAfterApproval: () => {
          pi.sendUserMessage('Approved the selected rejected execution permission(s); please continue.');
        },
        isWritable: cwd => process.env.PI_PROTECTED_WRITE_ROOT === cwd && !checkpoints?.isTurnReadOnlyFallback(),
        isPlanning: () => planning,
        getPlanMode: () => planState?.().mode ?? (planning ? 'plan' : 'normal'),
        startPlanExecution: (steps, ctx) => planState?.startExecution?.(steps, ctx),
        setPlannedStepsInPlanMode: steps => planState?.setPlannedSteps?.(steps),
        getShellStore: () => shellApprovals,
        getNeverAutoPatterns: cwd => neverAutoPatterns(cwd),
        onAudit: entry => audit?.record(entry),
      });
    } catch (error) {
      console.error('Pi: could not initialize upfront plan permissions:', error);
    }
    // Keep the core sandbox hooks available even if optional features fail to initialize.
    try {
      const { default: plan } = await import('./pi-plan/extensions/plan/index.ts');
      planState = plan(pi, {
        toolPrefix,
        extraPlanTools: [...webTools, ...jobNames, 'pi_safe_code', 'pi_safe_data'],
        extraPlanToolMatcher: name => Boolean(mcpHandle?.isPlanAllowedTool(name)),
        isDynamicNormalTool: name => Boolean(mcpHandle?.isAllowedTool(name)),
        onPlanModeChange: enabled => {
          planning = enabled;
          autonomyHandle?.onPlanModeChange(enabled);
          refreshStatus();
        },
        onPlanCleared: reason => {
          planPermissions?.clearGrant(reason);
        },
        confirmPlanExecution: planPermissions
          ? (ctx, steps, assistantText) => planPermissions!.confirmFromPlanMode(ctx, steps, assistantText)
          : undefined,
        describePlanPermissions: () => planPermissions?.describeActiveGrant() ?? 'none',
        shouldPauseOnSettled: () => {
          const pause = writeSubMode === 'workflow' && (planPermissions?.consumeTurnRejectionPause() ?? false);
          if (pause) {
            // Open the review right away instead of asking the user to type /rejected.
            const ctx = latestCtx;
            setTimeout(() => {
              try {
                if (ctx?.hasUI && ctx.mode === 'tui' && ctx.isIdle()) {
                  void planPermissions?.promptAfterRejectionPause(ctx).catch(() => undefined);
                }
              } catch {
                // The session was replaced or reloaded within 50 ms; its ctx is stale.
              }
            }, 50);
          }
          return pause;
        },
        isWorkflowMode: () => writeSubMode === 'workflow',
        hasPendingTools: () => gate.pendingCount() > 0 || jobs?.hasActiveJobs() === true,
        renderWidget: todosHandle
          ? (ctx, mode, steps) => todosHandle!.updatePlanWidget(ctx, mode, steps)
          : undefined,
      });
      getActivePlanMode = () => planState?.().mode ?? (planning ? 'plan' : 'normal');
    } catch (error) {
      console.error('Pi: could not load pi-plan:', error);
    }
    try {
      registerContextCommand(pi, {
        instructions: () => instructionsHandle?.summary(),
        memory: () => memoryHandle?.summary(),
        skills: () => skillsHandle?.summary(),
        droids: () => droidsHandle?.summary(),
        style: () => preferencesHandle?.summary(),
        autonomy: () => autonomyHandle?.getLevel(),
        hooks: () => hooksHandle?.statusLine(),
        mcp: () => mcpHandle?.statusLine(),
      });
    } catch (error) {
      console.error('Pi: could not initialize /context command:', error);
    }
    try {
      const jobsModule = await import('./jobs.ts');
      const jobManager = jobs = jobsRef = jobsModule.registerJobs(pi, {
        dir,
        launchRef: process.env.PI_PROTECTED_CHECKPOINT_REF,
        writeRoot: process.env.PI_PROTECTED_WRITE_ROOT,
        isPlanning: () => planning,
        resolveDroid: name => droidsHandle?.getDroid(name),
        onJobsChange: () => {
          maskCache.invalidate();
          refreshStatus();
        },
        onShellJobStarted: job => onShellJobStartedRef?.(job),
        onShellJobFinished: job => onShellJobFinishedRef?.(job),
        onWorktreeApplied: safetyRef => {
          maskCache.invalidate();
          currentCheckpointRef = safetyRef;
          refreshStatus();
        },
        authorizeShell: async (command, ctx) => {
          try {
            const auth = await authorizeShell(command, ctx, true);
            audit?.record({ tool: jobStart, args: { command }, decision: auth.prompted ? 'approved' : 'allow', rule: auth.rule, prompted: auth.prompted });
          } catch (error) {
            const e = error as Error & { prompted?: boolean; auditRule?: string };
            audit?.record({ tool: jobStart, args: { command }, decision: e.prompted ? 'denied' : 'block', rule: e.auditRule ?? 'shell-blocked', prompted: e.prompted });
            throw error;
          }
        },
        beforeShellJob: async (ctx, kind) => {
          if (!checkpoints || planning || process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) return true;
          return checkpoints.ensureMutationCheckpoint(ctx, kind === 'model-shell' ? 'turn' : 'shell');
        },
        shell: (command, cwd, forceReadonly = false) => sandboxInvocation('--shell', cwd, [command], forceReadonly),
      });
      const jobResult = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
      const jobId = Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
        { additionalProperties: false });
      const jobStatusParams = Type.Object(
        {
          id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          waitSeconds: Type.Optional(
            Type.Number({
              minimum: 0,
              maximum: 60,
              description:
                'Seconds to wait for the job to finish before returning status (default: 15, max: 60; pass 0 for an immediate non-blocking check).',
            }),
          ),
        },
        { additionalProperties: false },
      );
      pi.registerTool({
        name: jobStart, label: 'Start Background Check',
        promptSnippet: 'Start a long-running shell command in the background and return a job ID',
        description: 'Start a long-running project check in the protected shell and return a job ID immediately. Same approvals and sandbox as pi_safe_bash. Prefer foreground execution for quick commands.',
        parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 8192 }) },
          { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_id, { command }, signal, _update, ctx) {
          return gate.runWrite(async () => {
            try {
              return jobResult(await jobManager.startModelShell(command, ctx, signal));
            } finally {
              maskCache.invalidate();
              refreshStatus(ctx);
            }
          });
        },
      });
      pi.registerTool({
        name: jobStatus, label: 'Background Check Status',
        promptSnippet: 'Wait for or inspect the status and recent output of a background shell job',
        description: 'Wait up to waitSeconds (default 15s, max 60s; 0 for an immediate check) for a model-started background shell job to finish, then return its state and untrusted output (concise tail while still running, full captured output once finished). Use waitSeconds instead of dummy sleep/date commands or tight polling loops.',
        parameters: jobStatusParams,
        executionMode: 'parallel',
        async execute(_id, { id, waitSeconds }, signal, _update, ctx) {
          return jobResult(
            await jobManager.waitModelOutput(id, ctx, {
              waitMs: (waitSeconds ?? 15) * 1000,
              signal,
            }),
          );
        },
      });
      pi.registerTool({
        name: jobCancel, label: 'Cancel Background Check',
        promptSnippet: 'Cancel a model-started background shell job by ID',
        description: 'Cancel a model-started background shell job by ID. Cannot cancel user-started jobs or delegates.',
        parameters: jobId,
        executionMode: 'sequential',
        async execute(_id, { id }, _signal, _update, ctx) {
          return gate.runWrite(async () => {
            try {
              return jobResult(jobManager.cancelModelShell(id, ctx));
            } finally {
              maskCache.invalidate();
              refreshStatus(ctx);
            }
          });
        },
      });
      for (const name of [jobStart, jobStatus, jobCancel]) enabledJobTools.add(name);
      if (hostAccess && !worker) {
        const { registerRuns, runToolNames, runStartTool } = await import('./runs.ts');
        runsHandle = registerRuns(pi, {
          authorize: async (command, ctx) => {
            try {
              const auth = await authorizeShell(command, ctx, true);
              audit?.record({ tool: runStartTool, args: { command }, decision: auth.prompted ? 'approved' : 'allow', rule: auth.rule, prompted: auth.prompted });
              return auth;
            } catch (error) {
              const e = error as Error & { prompted?: boolean; auditRule?: string };
              audit?.record({ tool: runStartTool, args: { command }, decision: e.prompted ? 'denied' : 'block', rule: e.auditRule ?? 'shell-blocked', prompted: e.prompted });
              throw error;
            }
          },
          confirm: (ctx, action, value) => askApproval(ctx, action, value),
          beforeRun: async ctx => {
            if (!checkpoints || process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) return true;
            return checkpoints.ensureMutationCheckpoint(ctx, 'shell');
          },
          invocation: (command, cwd) => sandboxInvocation('--shell', cwd, [command]),
          blockedReason: () => (planning || getActivePlanMode() === 'plan' ? 'Detached runs are unavailable in plan mode.' : undefined),
        });
        for (const name of runToolNames) enabledJobTools.add(name);
      }
      if (delegateBudgetMax > 0) {
        pi.registerTool({
          name: delegateTool,
          label: 'Subagent Delegate',
          promptSnippet: 'Spawn an isolated subagent (droid) for read-only research, review, or worktree changes',
          description:
            'Spawn an isolated Pi subagent (droid) with a fresh context window to investigate, review, or implement a bounded task. Defaults to read-only research; pass droid ("explorer", "reviewer", "worker", or a trusted custom droid from <available_droids>) and optional complexity ("light" | "medium" | "heavy"). Write-capable droids ("worker") run inside an isolated temporary worktree after user approval and stage changes for /delegate apply <id>.',
          parameters: Type.Object(
            {
              task: Type.String({ minLength: 1, maxLength: 8192 }),
              droid: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: 64,
                  description: 'Optional droid subagent name (e.g. "explorer", "reviewer", "worker", or a custom droid).',
                }),
              ),
              complexity: Type.Optional(
                Type.Union(
                  [Type.Literal('light'), Type.Literal('medium'), Type.Literal('heavy')],
                  { description: 'Optional reasoning effort tier for the subagent.' },
                ),
              ),
            },
            { additionalProperties: false },
          ),
          executionMode: 'parallel',
          async execute(_id, { task, droid, complexity }, signal, _update, ctx) {
            if (delegatesRemaining <= 0) {
              throw new Error(`Delegate budget exhausted (${delegateBudgetMax} per session).`);
            }
            const droidDef = droid?.trim() ? droidsHandle?.getActive(droid.trim()) : undefined;
            if (droid?.trim() && !droidDef) {
              throw new Error(`Unknown or untrusted droid "${droid.trim()}". Use /droids to inspect available droids.`);
            }
            const writable = process.env.PI_PROTECTED_WRITE_ROOT === ctx.cwd && !checkpoints?.isTurnReadOnlyFallback();
            const resolved = resolveDelegateExecution({
              task,
              droid: droidDef,
              complexity,
              parentProvider: ctx.model?.provider ?? 'openai',
              parentModel: ctx.model?.id ?? 'gpt-5',
              parentThinking: pi.getThinkingLevel(),
              activeParentTools: pi.getActiveTools(),
              webEnabled,
              fetchEnabled,
              gitEnabled,
              isPlanning: planning,
              isWritable: writable,
            });
            if (resolved.writeCapable) {
              const droidName = resolved.droid?.name ?? 'worker';
              if (!planning && writeSubMode === 'workflow') {
                const activeMode = getActivePlanMode();
                if (activeMode !== 'execute') {
                  const rejWt = planPermissions?.allowsApprovedRejectedWorktree(ctx.cwd);
                  if (rejWt) {
                    audit?.record({
                      tool: delegateTool,
                      args: { task, droid, complexity },
                      decision: 'allow',
                      rule: rejWt,
                      prompted: false,
                    });
                  } else {
                    audit?.record({
                      tool: delegateTool,
                      args: { task, droid, complexity },
                      decision: 'block',
                      rule: 'workflow-plan-required',
                      prompted: false,
                    });
                    throw new Error(
                      'Isolated worktree subagent was not approved: workflow mode requires requesting permissions upfront via pi_safe_plan (worktreeSubagents: true) before execution.',
                    );
                  }
                } else {
                  const wtRule = planPermissions?.allowsWorktreeDelegate(ctx.cwd);
                  if (wtRule) {
                    audit?.record({
                      tool: delegateTool,
                      args: { task, droid, complexity },
                      decision: 'allow',
                      rule: wtRule,
                      prompted: false,
                    });
                  } else {
                    const entry = planPermissions?.recordRejectedWorktree({ cwd: ctx.cwd, task, droidName, ctx });
                    audit?.record({
                      tool: delegateTool,
                      args: { task, droid, complexity },
                      decision: 'block',
                      rule: 'workflow-exec-rejected-worktree',
                      prompted: false,
                    });
                    throw new Error(
                      `Isolated worktree subagent was not approved upfront in pi_safe_plan (rejected by default during execution${entry ? `, #${entry.id}` : ''}). Run /rejected to review and approve.`,
                    );
                  }
                }
              } else {
                const preApprovedWt = !planning ? planPermissions?.allowsWorktreeDelegate(ctx.cwd) : null;
                if (preApprovedWt) {
                  audit?.record({
                    tool: delegateTool,
                    args: { task, droid, complexity },
                    decision: 'allow',
                    rule: preApprovedWt,
                    prompted: false,
                  });
                } else {
                  const prompted = Boolean(ctx.hasUI && !ctx.signal?.aborted);
                  const label = `Run isolated worktree subagent (${droidName})`;
                  if (!await askApproval(ctx, label, task)) {
                    audit?.record({
                      tool: delegateTool,
                      args: { task, droid, complexity },
                      decision: prompted ? 'denied' : 'block',
                      rule: prompted ? 'worktree-delegate-denied' : 'no-ui-block',
                      prompted,
                    });
                    throw new Error('Isolated worktree subagent was not approved. Do not retry without user approval.');
                  }
                  audit?.record({
                    tool: delegateTool,
                    args: { task, droid, complexity },
                    decision: 'approved',
                    rule: 'worktree-delegate-approved',
                    prompted: true,
                  });
                }
              }
            }
            if (delegatesRemaining <= 0) {
              throw new Error(`Delegate budget exhausted (${delegateBudgetMax} per session).`);
            }
            delegatesRemaining--;
            refreshStatus(ctx);
            try {
              const text = resolved.writeCapable
                ? await jobManager.runModelWorktreeDelegate(resolved.fullTask, ctx, signal, resolved)
                : await jobManager.runModelDelegate(resolved.fullTask, ctx, signal, resolved);
              return jobResult(text);
            } finally {
              refreshStatus(ctx);
            }
          },
        });
        enabledJobTools.add(delegateTool);
      }
    } catch (error) {
      console.error('Pi: could not initialize background jobs:', error);
    }
    try {
      const { registerDiff, registerChecks, registerReview } = await import('./workflows.ts');
      registerDiff(pi, dir, process.env.PI_PROTECTED_CHECKPOINT_REF);
      if (jobs) {
        registerReview(
          pi,
          dir,
          process.env.PI_PROTECTED_CHECKPOINT_REF,
          jobs,
          (turn, branch) => checkpoints?.resolveSinceRef(turn, branch as never),
        );
        const runCheck = registerChecks(pi, dir, jobs);
        pi.registerTool({
          name: checkTool, label: 'Run Named Project Check',
          promptSnippet: 'Run a configured project check (such as test or lint) as a background job',
          description: 'Run a user-configured project check as a background job under the same shell approvals and sandbox. Defaults to test. Use name "list" to discover checks, or pi_safe_job_status to read a started job’s outcome.',
          parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })) },
            { additionalProperties: false }),
          executionMode: 'sequential',
          async execute(_id, { name = 'test' }, signal, _update, ctx) {
            return gate.runWrite(async () => {
              try {
                return { content: [{ type: 'text', text: await runCheck(name, ctx, signal) }], details: undefined };
              } finally {
                maskCache.invalidate();
                refreshStatus(ctx);
              }
            });
          },
        });
        enabledJobTools.add(checkTool);
      }
    } catch (error) {
      console.error('Pi: could not initialize review and test workflows:', error);
    }
    try {
      const {
        defaultLaunchHostFile,
        openToolName,
        registerCopy,
        registerDoctor,
        registerOpen,
        validateWorkspaceOpenTarget,
      } = await import('./desktop.ts');
      registerCopy(pi, jobs?.copyOutput);
      registerOpen(pi, { getPolicy: () => editPolicy });
      pi.registerTool({
        name: openToolName,
        label: 'Open File on Host Desktop',
        promptSnippet: 'Open a non-secret workspace document, slide deck, spreadsheet, PDF, or image on the host desktop',
        description:
          'Open an existing non-secret workspace file (such as .pptx, .pdf, .docx, .xlsx, .png, .html, or .md) on the user’s host desktop using xdg-open or LibreOffice. Requires user approval (or upfront approval via permissions.openFiles in pi_safe_plan). Never use pi_safe_bash or pi_safe_job_start to launch GUI desktop windows.',
        parameters: Type.Object(
          {
            path: Type.String({
              minLength: 1,
              maxLength: 512,
              description: 'Workspace-relative path to the existing document, presentation, spreadsheet, PDF, or image.',
            }),
            app: Type.Optional(
              Type.Union(
                [Type.Literal('default'), Type.Literal('libreoffice')],
                { description: 'Host viewer application ("default" uses xdg-open; "libreoffice" launches LibreOffice directly).' },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: 'sequential',
        async execute(_id, { path: rawPath, app = 'default' }, _signal, _update, ctx) {
          const target = validateWorkspaceOpenTarget(ctx.cwd, rawPath, editPolicy);
          await defaultLaunchHostFile(target.absPath, app);
          return {
            content: [{
              type: 'text' as const,
              text: `Opened ${target.relPosix} on host desktop${app === 'libreoffice' ? ' in LibreOffice' : ''}.`,
            }],
            details: undefined,
          };
        },
      });
      enabledJobTools.add(openToolName);
      registerDoctor(pi, { dir, ref: currentCheckpointRef,
        writeRoot: process.env.PI_PROTECTED_WRITE_ROOT, isPlanning: () => planning,
        inspectCollapsed: async cwd => (await maskCache.get(cwd)).collapsed,
        instructionsStatus: () => instructionsHandle?.statusLine() ?? 'disabled',
        autonomyStatus: () => autonomyHandle?.getLevel() ?? 'off',
        droidsStatus: () => {
          const s = droidsHandle?.summary();
          if (!s || !s.enabled) return 'disabled';
          return `${s.activeCount} active (${s.names.join(', ')})${s.untrustedCount ? `; ${s.untrustedCount} untrusted` : ''}`;
        },
        webStatus: () => {
          if (!webEnabled && !fetchEnabled) return 'off (--no-web --no-fetch)';
          const brave = process.env.PI_PROTECTED_BRAVE_FALLBACK === '1';
          const mwmbl = process.env.PI_PROTECTED_MWMBL_FALLBACK === '1';
          const order = ['DuckDuckGo', ...(mwmbl ? ['Mwmbl'] : []), ...(brave ? ['Brave'] : [])].join(' → ');
          const usage = brave ? braveUsage() : null;
          return [
            webEnabled ? `search ${order}${usage ? ` (Brave: ${usage.used}/${usage.max} requests in the last 32 days)` : ''}` : 'search off',
            fetchEnabled ? 'fetch on (Markdown/PDF/JSON/CSV)' : 'fetch off',
            'cache ~/.cache/pi-protected/web (15 min searches, 30 min pages)',
          ].join(' · ');
        },
        styleStatus: () => {
          const s = preferencesHandle?.summary();
          return s ? `style=${s.style}, notify=${s.notify}` : 'default';
        },
        hooksStatus: () => hooksHandle?.statusLine() ?? 'disabled',
        mcpStatus: () => mcpHandle?.statusLine() ?? 'disabled',
        async probeSandbox(cwd) {
          const command = `exec /usr/bin/python3 -I -c 'import os; raise SystemExit(not (os.statvfs(".").f_flag & os.ST_RDONLY))'`;
          return (await run('--shell', cwd, [command], '', () => {}, undefined, 5, true)).code === 0;
        },
      });
    } catch (error) {
      console.error('Pi: could not initialize desktop commands:', error);
    }
    try {
      const { registerRecap } = await import('./recap.ts');
      registerRecap(pi, { plan: () => planState?.(), activeJobs: () => jobs?.activeCount() ?? 0 });
    } catch (error) {
      console.error('Pi: could not initialize session recap:', error);
    }
    pi.on('session_start', async (event, ctx) => {
      latestCtx = ctx;
      if (event.reason === 'new' || event.reason === 'startup') {
        planPermissions?.resetSession(ctx);
      } else {
        planPermissions?.clearGrant('session-start');
      }
      const sessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.();
      if (sessionId) audit?.setSession(sessionId);
      if (event.reason === 'new' || event.reason === 'startup') {
        notifiedCollapsed = false;
        delegatesRemaining = delegateBudgetMax;
      }
      // Restore saved write sub-mode from session branch unless explicit --mode / --plan was given at startup.
      if (!startModeEnv && !process.argv.includes('--plan')) {
        const branchEntries = ctx.sessionManager.getBranch();
        const hasSavedMode = branchEntries.some(entry => entry.type === 'custom' &&
          ['pi-permission-mode', 'pi-plan'].includes((entry as { customType?: string }).customType ?? ''));
        const defaults = readProjectDefaults(ctx.cwd);
        if (!hasSavedMode && (defaults.mode || defaults.spec)) {
          // A fresh session in a project with saved defaults starts in that mode.
          writeSubMode = defaults.mode ?? 'accept-edits';
          if (defaults.spec && !planning && process.env.PI_PROTECTED_WRITE_ROOT === ctx.cwd) {
            if (planState?.setPlanMode?.(true, ctx)) planning = true;
          }
        }
        for (const entry of branchEntries) {
          if (entry.type === 'custom' && (entry as { customType?: string }).customType === 'pi-permission-mode') {
            const m = (entry as { data?: { mode?: string } }).data?.mode;
            if (m === 'ask-edits' || m === 'accept-edits' || m === 'workflow') writeSubMode = m;
          }
        }
      }
      autonomyHandle?.onPlanModeChange(planning);
      maskCache.invalidate();
      refreshStatus(ctx);
      void maybeNotifyCollapsed(ctx);
    });
    pi.on('turn_end', async (_event, ctx) => {
      refreshStatus(ctx);
    });
    pi.on('agent_settled', async (_event, ctx) => {
      if (planState?.().mode !== 'execute') {
        planPermissions?.clearGrant('not-executing');
      }
      refreshStatus(ctx);
    });
    // ---- run log: every workspace Python script run, with its code fingerprint ----
    const runLog = (() => {
      try {
        return runLogStore(process.cwd());
      } catch (error) {
        console.error('Pi: run log unavailable:', error);
        return undefined;
      }
    })();
    const runRedactor = createEgressGuard(process.cwd());
    type PendingRun = Omit<RunRecord, 'id' | 'status' | 'tail'> & { started: number };
    const pendingRuns = new Map<string, PendingRun>();
    const pendingJobRuns = new Map<number, PendingRun>();
    function beginRun(command: unknown, cwd: string): PendingRun | undefined {
      if (!runLog || typeof command !== 'string' || cwd !== process.cwd()) return undefined;
      try {
        const parsed = parseScriptCommand(leadingCommand(command), cwd, editPolicy);
        if (!parsed) return undefined;
        const fp = scriptFingerprint(cwd, parsed.file, editPolicy);
        return {
          at: new Date().toISOString(),
          started: Date.now(),
          command: command.length > 400 ? `${command.slice(0, 399)}…` : command,
          script: `${parsed.interpreter} ${parsed.script}`,
          args: parsed.args.slice(0, 40),
          fingerprint: fp?.hash ?? null,
          files: fp?.files.length ?? 0,
        };
      } catch {
        return undefined;
      }
    }
    function finishRun(run: PendingRun, outcome: Pick<RunRecord, 'status' | 'exitCode'>, output: string, durationMs?: number, job?: number): void {
      if (!runLog) return;
      try {
        const previous = runLog.lastFor(run.script);
        const { started: _started, ...rest } = run;
        runLog.append({
          ...rest,
          ...outcome,
          durationMs: durationMs ?? Date.now() - run.started,
          checkpoint: checkpoints?.getTurnRef() ?? currentCheckpointRef,
          tail: outputTail(output, text => runRedactor.redact(text)),
          ...(job !== undefined ? { job } : {}),
          ...(previous?.fingerprint && run.fingerprint && previous.fingerprint !== run.fingerprint ? { codeChanged: true } : {}),
        });
      } catch (error) {
        console.error('Pi: could not record the run:', error);
      }
    }
    pi.on('tool_execution_start', async (event, ctx) => {
      if (event.toolName !== `${toolPrefix}bash`) return;
      const run = beginRun((event.args as { command?: unknown } | undefined)?.command, ctx.cwd);
      if (run) pendingRuns.set(event.toolCallId, run);
    });
    pi.on('tool_execution_end', async event => {
      const run = pendingRuns.get(event.toolCallId);
      if (!run) return;
      pendingRuns.delete(event.toolCallId);
      const content = (event.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
      const text = content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
      const outcome = bashOutcome(text, event.isError);
      if (outcome) finishRun(run, outcome, text.replace(/\n*Command exited with code \d+\s*$/, ''), event.durationMs);
    });
    onShellJobStartedRef = job => {
      const run = beginRun(job.command, job.cwd);
      if (run) pendingJobRuns.set(job.id, run);
    };
    onShellJobFinishedRef = job => {
      const run = pendingJobRuns.get(job.id);
      if (!run) return;
      pendingJobRuns.delete(job.id);
      const code = /^exit (\d+)$/.exec(job.exit ?? '');
      const status: RunRecord['status'] = job.state === 'done' ? 'ok'
        : job.state === 'timed out' ? 'timed out' : job.state === 'cancelled' ? 'cancelled' : 'failed';
      finishRun(run, { status, ...(code ? { exitCode: Number(code[1]) } : {}) }, job.output, job.elapsedMs, job.id);
    };
    pi.registerCommand('runs', {
      description: 'Script run log (code fingerprint, args, checkpoint, exit, output tail): /runs [<id> | <script path> | clear]',
      async handler(raw, ctx) {
        if (!runLog) {
          ctx.ui.notify('The run log is unavailable in this session.', 'warning');
          return;
        }
        const arg = raw.trim();
        if (arg === 'clear') {
          const ok = !ctx.hasUI || await ctx.ui.confirm('Clear the run log for this folder?', 'This deletes every recorded run here.');
          if (ok) ctx.ui.notify(`Cleared ${runLog.clear()} recorded runs.`, 'info');
          return;
        }
        const idMatch = /^#?(\d+)$/.exec(arg);
        if (idMatch) {
          const record = runLog.get(Number(idMatch[1]));
          ctx.ui.notify(record ? formatRunDetail(record) : `No run #${idMatch[1]}. Use /runs to list them.`, record ? 'info' : 'warning');
          return;
        }
        const records = runLog.list().filter(r => !arg || r.script.includes(arg) || r.command.includes(arg)).slice(-15);
        ctx.ui.notify(records.length
          ? `Script runs${arg ? ` matching ${JSON.stringify(arg)}` : ''} (latest ${records.length}; /runs <id> for details):\n${records.map(formatRunLine).join('\n')}`
          : 'No script runs recorded for this folder yet. Workspace Python scripts run by the agent (python3 path.py, python3 -m module) are logged here.',
        'info');
      },
    });
    // ---- code intelligence, data tool, /deps, /pr, /handoff ----
    const busy = () => gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true;
    const userGuard = createEgressGuard(process.cwd());
    if (process.env.PI_PROTECTED_CODE_INTEL !== '0') {
      try {
        registerCodeIntel(pi, {
          getPolicy: () => editPolicy,
          runRead: gate.runRead,
          spawnServer: async root => {
            const snapshot = await maskCache.get(root);
            const invocation = sandboxInvocation('--lsp', root, [], true);
            const child = spawn(invocation.file, invocation.args, {
              env: { ...invocation.env, PI_SANDBOX_MASKS_FD: '3' },
              stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            });
            const masksPipe = child.stdio[3] as Writable | null;
            masksPipe?.on('error', () => {});
            masksPipe?.end(snapshot.payload);
            return child;
          },
        });
      } catch (error) {
        console.error('Pi: could not initialize Python code intelligence:', error);
      }
    }
    try {
      registerDataTool(pi, {
        runRead: gate.runRead,
        runSandbox: async (request, cwd, signal) => {
          const chunks: Buffer[] = [];
          await run('--data', cwd, [], JSON.stringify(request), data => { chunks.push(data); }, signal, 120, true, () => {});
          return Buffer.concat(chunks).toString('utf8');
        },
      });
    } catch (error) {
      console.error('Pi: could not initialize the data tool:', error);
    }
    try {
      registerDeps(pi, {
        dir,
        nodeHome,
        getSecretPatterns: () => editPolicy?.secretPaths ?? [],
        isWritable: cwd => process.env.PI_PROTECTED_WRITE_ROOT === cwd && !checkpoints?.isTurnReadOnlyFallback(),
        isBusy: busy,
        checkpoint: async ctx => {
          if (!checkpoints) return undefined;
          const ok = await checkpoints.ensureMutationCheckpoint(ctx, 'shell');
          return ok ? checkpoints.getCurrentRef() : undefined;
        },
        changesSince: ref => checkpoints?.changesSince(ref) ?? Promise.resolve(undefined),
      });
    } catch (error) {
      console.error('Pi: could not initialize /deps:', error);
    }
    const recentRunsText = (limit: number) => (runLog?.list() ?? []).slice(-limit).map(formatRunLine).join('\n');
    try {
      registerPr(pi, {
        dir,
        getSecretPatterns: () => editPolicy?.secretPaths ?? [],
        isBusy: busy,
        egressCheck: text => userGuard.check(text),
        getContext: () => {
          const plan = planState?.();
          const steps = plan?.steps?.length ? plan.steps.map(step => `${step.step}. [${step.completed ? 'x' : ' '}] ${step.text}`).join('\n') : undefined;
          return { plan: steps, runs: recentRunsText(8) || undefined };
        },
      });
    } catch (error) {
      console.error('Pi: could not initialize /pr:', error);
    }
    try {
      registerHandoff(pi, {
        redact: text => userGuard.redact(text),
        getInfo: async ctx => {
          const { buildRecap } = await import('./recap.ts');
          const branchEntries = ctx.sessionManager.getBranch();
          const sessionStart = (branchEntries.find(entry => typeof (entry as { timestamp?: string }).timestamp === 'string') as { timestamp?: string } | undefined)?.timestamp;
          const launchRef = process.env.PI_PROTECTED_CHECKPOINT_REF;
          let gitBranch: string | undefined;
          try {
            gitBranch = execFileSync('/usr/bin/git', ['-C', ctx.cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
          } catch {
            gitBranch = undefined;
          }
          return {
            cwd: ctx.cwd,
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            mode: currentModeLabel(ctx.cwd).toLowerCase(),
            branch: gitBranch,
            checkpoint: launchRef,
            recap: buildRecap(branchEntries, planState?.(), jobsRef?.activeCount() ?? 0),
            changes: launchRef && checkpoints ? await checkpoints.changesSince(launchRef) : undefined,
            runs: (runLog?.list() ?? []).filter(r => !sessionStart || r.at >= sessionStart),
          };
        },
      });
    } catch (error) {
      console.error('Pi: could not initialize /handoff:', error);
    }
    // One-line review of what a turn changed (accept-edits applies edits without asking, so this
    // is the review point): "Changed 3 files (+42 −7) · /diff to review · /rewind to undo".
    pi.on('agent_end', async (_event, ctx) => {
      const ref = checkpoints?.getTurnRef();
      if (!ref || !checkpoints || planning || process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) return;
      const summary = await checkpoints.changesSince(ref);
      if (!summary || summary.total === 0) return;
      try {
        pi.appendEntry('pi-turn-changes', { ref, mode: writeSubMode, ...summary });
      } catch {
        // Outside an active session there is nowhere to show it.
      }
    });
  }
  pi.on('user_bash', () => ({ operations: shell }));
  if (editPolicy) {
    try {
      instructionsHandle = registerProjectInstructions(pi, dir, editPolicy.secretPaths);
    } catch (error) {
      console.error('Pi: could not initialize protected project instructions:', error);
    }
  }
  pi.on('tool_call', async (event, ctx) => {
    latestCtx = ctx;
    const isMcpAllowed = Boolean(mcpHandle?.isAllowedTool(event.toolName));
    if (!names.has(event.toolName) && !webTools.has(event.toolName) && !enabledJobTools.has(event.toolName) && !isMcpAllowed) {
      audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'unavailable-tool' });
      return { block: true, reason: 'The tool is not available inside protected Pi.' };
    }
    if (isMcpAllowed) {
      if (planning && !mcpHandle?.isPlanAllowedTool(event.toolName)) {
        audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'mcp-plan-mode-blocked' });
        return { block: true, reason: 'This MCP server is disabled in plan mode.' };
      }
      audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: 'mcp-allowlisted-tool' });
      return;
    }
    try {
      if (event.toolName === `${toolPrefix}bash`) {
        const command = event.input.command;
        if (typeof command !== 'string') {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'invalid-command' });
          return { block: true, reason: 'Invalid shell command.' };
        }
        const auth = await authorizeShell(command, ctx);
        audit?.record({
          tool: event.toolName,
          args: event.input,
          decision: auth.prompted ? 'approved' : 'allow',
          rule: auth.rule,
          prompted: auth.prompted,
        });
        return;
      }
      if (event.toolName === delegateTool) {
        if (worker || delegatesRemaining <= 0) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: worker ? 'worker-no-recursion' : 'delegate-budget-exhausted' });
          return {
            block: true,
            reason: worker ? 'Delegates cannot spawn nested delegates.' : `Delegate budget exhausted (${delegateBudgetMax} per session).`,
          };
        }
        const rawDroid = event.input.droid;
        if (typeof rawDroid === 'string' && rawDroid.trim()) {
          const droidDef = droidsHandle?.getActive(rawDroid.trim());
          if (!droidDef) {
            audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'unknown-or-untrusted-droid' });
            return {
              block: true,
              reason: `Unknown or untrusted droid "${rawDroid.trim()}". Use an active droid from <available_droids> or ask the user to run /droids trust.`,
            };
          }
          if (droidDef.writeCapable && planning) {
            audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'plan-mode-worktree-droid' });
            return {
              block: true,
              reason: 'Write-capable subagent droids are unavailable in plan mode; use a read-only droid such as "explorer" or "reviewer".',
            };
          }
        }
        audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: 'delegate-budget-ok' });
        return;
      }
      if (event.toolName === `${toolPrefix}write` || event.toolName === `${toolPrefix}edit`) {
        if (worker && !worktreeWorker) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'worker-readonly' });
          return { block: true, reason: 'Delegated workers are read-only.' };
        }
        if (planning) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'plan-mode' });
          return { block: true, reason: 'Plan mode is read-only.' };
        }
        if (process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd || checkpoints?.isTurnReadOnlyFallback()) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: checkpoints?.isTurnReadOnlyFallback() ? 'turn-checkpoint-failed' : 'no-checkpoint' });
          return { block: true, reason: checkpoints?.isTurnReadOnlyFallback() ? 'Workspace is read-only for this turn: checkpoint creation failed.' : 'Workspace is read-only: no checkpoint for this directory.' };
        }
        const file = event.input.path;
        if (!editPolicy || typeof file !== 'string') {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'invalid-path-or-policy' });
          return { block: true, reason: 'No valid edit policy or file path.' };
        }
        const decision = editDecision(ctx.cwd, file, editPolicy);
        if (decision === 'deny') {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'denied-path' });
          return { block: true, reason: 'This file path is protected.' };
        }
        if (!worker && writeSubMode === 'workflow') {
          const activeMode = getActivePlanMode();
          if (activeMode !== 'execute') {
            const rejFileRule = planPermissions?.allowsApprovedRejectedFile(ctx.cwd, file, decision);
            if (rejFileRule) {
              audit?.record({
                tool: event.toolName,
                args: event.input,
                decision: 'allow',
                rule: rejFileRule,
                prompted: false,
              });
              return;
            }
            audit?.record({
              tool: event.toolName,
              args: event.input,
              decision: 'block',
              rule: 'workflow-plan-required',
              prompted: false,
            });
            return {
              block: true,
              reason:
                'Workflow mode requires Plan → Ask for Permissions → Execute: file modifications are blocked before plan approval. Inspect read-only first, then call pi_safe_plan with your ordered steps and required permissions.',
            };
          }
          const planFileRule = planPermissions?.allowsFileEdit(ctx.cwd, file, decision, writeSubMode);
          if (planFileRule) {
            audit?.record({
              tool: event.toolName,
              args: event.input,
              decision: 'allow',
              rule: planFileRule,
              prompted: false,
            });
            return;
          }
          if (decision === 'allow' && autonomyHandle) {
            const autoEditRule = autonomyHandle.allowsEdit(decision);
            if (autoEditRule) {
              audit?.record({
                tool: event.toolName,
                args: event.input,
                decision: 'allow',
                rule: autoEditRule,
                prompted: false,
              });
              return;
            }
          }
          const entry = planPermissions?.recordRejectedFile({
            cwd: ctx.cwd,
            filePath: file,
            decision,
            tool: event.toolName,
            ctx,
          });
          audit?.record({
            tool: event.toolName,
            args: event.input,
            decision: 'block',
            rule: 'workflow-exec-rejected-file',
            prompted: false,
          });
          return {
            block: true,
            reason: `${decision === 'ask' ? 'Sensitive file' : 'Unplanned file'} change rejected by default during execution${entry ? ` (#${entry.id})` : ''}: file was not approved upfront in pi_safe_plan (permissions.files). Include [PLAN:PAUSED] so the user can review and approve via /rejected, or call pi_safe_plan to update permissions.`,
          };
        }
        if (decision === 'ask' || writeSubMode === 'ask-edits') {
          if (!worker && planPermissions) {
            const planFileRule = planPermissions.allowsFileEdit(ctx.cwd, file, decision, writeSubMode);
            if (planFileRule) {
              audit?.record({
                tool: event.toolName,
                args: event.input,
                decision: 'allow',
                rule: planFileRule,
                prompted: false,
              });
              return;
            }
          }
          if (!worker && decision === 'allow' && autonomyHandle) {
            const autoEditRule = autonomyHandle.allowsEdit(decision);
            if (autoEditRule) {
              audit?.record({
                tool: event.toolName,
                args: event.input,
                decision: 'allow',
                rule: autoEditRule,
                prompted: false,
              });
              return;
            }
          }
          const isSensitive = decision === 'ask';
          const verb = event.toolName === `${toolPrefix}edit` ? 'Edit' : 'Write';
          const label = isSensitive ? `${verb} sensitive file` : `${verb} file (ask-edits mode)`;
          const prompted = Boolean(ctx.hasUI && !ctx.signal?.aborted);
          if (!await askApproval(ctx, label, file)) {
            audit?.record({
              tool: event.toolName,
              args: event.input,
              decision: prompted ? 'denied' : 'block',
              rule: prompted ? (isSensitive ? 'sensitive-path-denied' : 'ask-edits-denied') : 'no-ui-block',
              prompted,
            });
            return {
              block: true,
              reason: isSensitive
                ? 'Sensitive file change not approved. Do not retry without user approval.'
                : 'File change not approved in ask-edits mode. Do not retry without user approval.',
            };
          }
          audit?.record({
            tool: event.toolName,
            args: event.input,
            decision: 'approved',
            rule: isSensitive ? 'sensitive-path-approved' : 'ask-edits-approved',
            prompted: true,
          });
          return;
        }
        audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: 'edit-policy-allow' });
        return;
      }
      if (event.toolName === 'pi_safe_open') {
        if (worker) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'worker-no-desktop-open' });
          return { block: true, reason: 'Delegated workers cannot open files on the host desktop.' };
        }
        if (planning) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'plan-mode' });
          return { block: true, reason: 'Plan mode is read-only; request permissions.openFiles via pi_safe_plan first.' };
        }
        const rawPath = event.input.path;
        const rawApp = event.input.app;
        if (typeof rawPath !== 'string' || (rawApp !== undefined && rawApp !== 'default' && rawApp !== 'libreoffice')) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'invalid-open-args' });
          return { block: true, reason: 'Invalid pi_safe_open arguments.' };
        }
        const { validateWorkspaceOpenTarget } = await import('./desktop.ts');
        let target;
        try {
          target = validateWorkspaceOpenTarget(ctx.cwd, rawPath, editPolicy);
        } catch (err) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'denied-open-target' });
          return { block: true, reason: (err as Error).message };
        }
        if (writeSubMode === 'workflow') {
          const activeMode = getActivePlanMode();
          if (activeMode !== 'execute') {
            const rejOpenRule = planPermissions?.allowsApprovedRejectedOpen(ctx.cwd, target.relPosix);
            if (rejOpenRule) {
              audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: rejOpenRule, prompted: false });
              return;
            }
            audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'workflow-plan-required', prompted: false });
            return {
              block: true,
              reason:
                'Workflow mode requires Plan → Ask for Permissions → Execute: host desktop file opens are blocked before plan approval. Call pi_safe_plan with ordered steps and permissions.openFiles first.',
            };
          }
          const planOpenRule = planPermissions?.allowsFileOpen(ctx.cwd, target.relPosix);
          if (planOpenRule) {
            audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: planOpenRule, prompted: false });
            return;
          }
          const entry = planPermissions?.recordRejectedOpen({
            cwd: ctx.cwd,
            filePath: target.relPosix,
            tool: event.toolName,
            ctx,
          });
          audit?.record({ tool: event.toolName, args: event.input, decision: 'block', rule: 'workflow-exec-rejected-open', prompted: false });
          return {
            block: true,
            reason: `Host desktop open rejected by default during execution${entry ? ` (#${entry.id})` : ''}: file was not approved upfront in pi_safe_plan (permissions.openFiles). Include [PLAN:PAUSED] so the user can approve via /rejected, or call pi_safe_plan to update permissions.`,
          };
        }
        const planOpenRule = planPermissions?.allowsFileOpen(ctx.cwd, target.relPosix);
        if (planOpenRule) {
          audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: planOpenRule, prompted: false });
          return;
        }
        const prompted = Boolean(ctx.hasUI && !ctx.signal?.aborted);
        const detail = rawApp === 'libreoffice' ? `libreoffice -- ${target.relPosix}` : target.relPosix;
        if (!await askApproval(ctx, 'Open file on host desktop', detail)) {
          audit?.record({
            tool: event.toolName,
            args: event.input,
            decision: prompted ? 'denied' : 'block',
            rule: prompted ? 'desktop-open-denied' : 'no-ui-block',
            prompted,
          });
          return { block: true, reason: 'Host desktop open was not approved. Do not retry without user approval.' };
        }
        audit?.record({
          tool: event.toolName,
          args: event.input,
          decision: 'approved',
          rule: 'desktop-open-approved',
          prompted: true,
        });
        return;
      }
      if (event.toolName !== jobStart && event.toolName !== checkTool && event.toolName !== planToolName && event.toolName !== askUserToolName) {
        audit?.record({ tool: event.toolName, args: event.input, decision: 'allow', rule: 'allowed-tool' });
      }
    } catch (error) {
      const e = error as Error & { prompted?: boolean; auditRule?: string; exposeMessage?: boolean };
      const message = e.message;
      audit?.record({
        tool: event.toolName,
        args: event.input,
        decision: e.prompted ? 'denied' : 'block',
        rule: e.auditRule ?? (message?.startsWith('Plan mode:') ? 'plan-mode-shell' : 'permission-error'),
        prompted: e.prompted,
      });
      const reason = e.exposeMessage
        || message?.startsWith('Shell command not approved.')
        || message?.startsWith('Shell command blocked by deny policy:')
        || message?.startsWith('Plan mode:')
        ? message : 'Permission check failed. Action blocked.';
      return { block: true, reason };
    }
  });
  if (!worker) {
    try {
      hooksHandle = registerHooks(pi, {
        enabled: hooksEnabled,
        canWrite: cwd => !planning && process.env.PI_PROTECTED_WRITE_ROOT === cwd && !checkpoints?.isTurnReadOnlyFallback(),
        ensureWriteCheckpoint: async ctx => {
          if (!checkpoints || planning || process.env.PI_PROTECTED_WRITE_ROOT !== ctx.cwd) return false;
          return checkpoints.ensureMutationCheckpoint(ctx, 'turn');
        },
        runSandboxShell: async (command, cwd, stdinJson, timeoutSec, forceReadonly, signal) => {
          const execHook = async () => {
            const outChunks: Buffer[] = [];
            const errChunks: Buffer[] = [];
            let outBytes = 0;
            let errBytes = 0;
            const cap = 256 * 1024;
            const { code } = await run(
              '--shell',
              cwd,
              [command],
              stdinJson,
              chunk => {
                outBytes += chunk.length;
                if (outBytes <= cap) outChunks.push(chunk);
              },
              signal,
              timeoutSec,
              forceReadonly,
              chunk => {
                errBytes += chunk.length;
                if (errBytes <= cap) errChunks.push(chunk);
              },
            );
            return {
              code,
              stdout: Buffer.concat(outChunks).toString('utf8'),
              stderr: Buffer.concat(errChunks).toString('utf8'),
            };
          };
          return forceReadonly ? gate.runRead(execHook) : gate.runWrite(execHook);
        },
        onAfterWritableHook: () => maskCache.invalidate(),
        onAudit: entry => audit?.record(entry),
      });
    } catch (error) {
      console.error('Pi: could not initialize user hooks:', error);
    }
  }
  // Host-side check: block search queries and fetch URLs that carry a dotenv value or a
  // credential-shaped string before they leave the laptop.
  const egressGuard = createEgressGuard(process.cwd());
  const egressCheck = (text: string, tool: string) => {
    const reason = egressGuard.check(text);
    if (reason) audit?.record({ tool, args: { length: text.length }, decision: 'block', rule: 'egress-secret', prompted: false });
    return reason;
  };
  if (webEnabled) registerWebSearch(pi, dir,
    !worker && process.env.PI_PROTECTED_BRAVE_FALLBACK === '1',
    !worker && process.env.PI_PROTECTED_MWMBL_FALLBACK === '1',
    gate.runRead, egressCheck);
  if (fetchEnabled) registerWebFetch(pi, dir, gate.runRead, egressCheck);
  if (hostAccess && !worker) {
    try {
      const { registerSessions } = await import('./sessions.ts');
      registerSessions(pi, { dir, nodeHome, runRead: gate.runRead });
    } catch (error) {
      console.error('Pi: could not initialize pi_safe_sessions:', error);
    }
  }
  if (!worker) {
    try {
      const { registerWorktreeCommands } = await import('./worktrees.ts');
      registerWorktreeCommands(pi, {
        liveRunsUnder: folder => (runsHandle?.store.list() ?? [])
          .filter(r => (r.cwd === folder || r.cwd.startsWith(`${folder}/`)) && runsHandle!.store.state(r).state === 'running')
          .map(r => r.id),
        onChange: () => {
          maskCache.invalidate();
          refreshStatus();
        },
      });
    } catch (error) {
      console.error('Pi: could not initialize /worktree:', error);
    }
  }
  try {
    registerGitTools(pi, {
      dir,
      nodeHome,
      gitToolEnabled: gitEnabled,
      registerCommitCommand: !worker,
      getPolicy: () => editPolicy,
      runRead: gate.runRead,
      hasPendingWork: () => gate.pendingCount() > 0 || jobsRef?.hasActiveJobs() === true,
      remoteToolEnabled: gitRemoteEnabled,
      remoteBlockedReason: () => {
        if (worker) return 'Subagents cannot run Git network commands.';
        if (planning || getActivePlanMode() === 'plan') return 'Git network commands are unavailable in plan mode.';
        return undefined;
      },
    });
  } catch (error) {
    console.error('Pi: could not initialize protected Git tools:', error);
  }
  for (const tool of definitions) {
    const name = tool.name;
    const isReadOnly = readOnlyCoreNames.has(name);
    pi.registerTool({
      ...tool,
      name: `${toolPrefix}${name}`,
      promptGuidelines: [
        ...(adaptCorePromptGuidelines(name, toolPrefix, tool.promptGuidelines) ?? []),
        ...(name === 'read' ? [IMAGE_READ_GUIDELINE] : []),
      ],
      executionMode: isReadOnly ? 'parallel' : 'sequential',
      async execute(id, params, signal, _onUpdate, ctx) {
        const workflowStage1Readonly = Boolean(
          !worker &&
            writeSubMode === 'workflow' &&
            getActivePlanMode() !== 'execute' &&
            name === 'bash' &&
            !planPermissions?.allowsApprovedRejectedShell(
              String((params as { command?: unknown })?.command ?? ''),
              editPolicy?.neverSessionAllow,
            ),
        );
        const executeInSandbox = async () => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          const limit = 32 * 1024 * 1024;
          const { code, collapsed } = await run('--tool', ctx.cwd, [], JSON.stringify({ id, name, params }), data => {
            bytes += data.length;
            if (bytes <= limit) chunks.push(data);
          }, signal, undefined, isReadOnly || workflowStage1Readonly);
          notifyCollapsedFromList(ctx, collapsed);
          if (bytes > limit) throw new Error('Protected tool output exceeded its limit.');
          const output = Buffer.concat(chunks).toString('utf8');
          if (code !== 0) throw new Error(output.trim() || `Sandbox exited with code ${code}`);
          const { result, error, fullOutput } = JSON.parse(output);
          const adopt = <T>(value: T): T =>
            fullOutput && typeof fullOutput.path === 'string' && typeof fullOutput.text === 'string'
              ? outputBudget.adoptFullOutput(id, `${toolPrefix}${name}`, fullOutput.path, fullOutput.text, value)
              : value;
          if (error) throw new Error(adopt(String(error)));
          return adopt(result);
        };
        if (isReadOnly) {
          const result = await gate.runRead(executeInSandbox);
          return name === 'read' ? withImagesForModel(result, ctx) : result;
        }
        return gate.runWrite(async () => {
          try {
            if (checkpoints && !planning && !worker && !workflowStage1Readonly && process.env.PI_PROTECTED_WRITE_ROOT === ctx.cwd) {
              const ok = await checkpoints.ensureMutationCheckpoint(ctx, 'turn');
              if (!ok && (name === 'edit' || name === 'write')) {
                audit?.record({ tool: `${toolPrefix}${name}`, args: params, decision: 'block', rule: 'turn-checkpoint-failed' });
                throw new Error('Workspace is read-only for this turn: checkpoint creation failed.');
              }
            }
            return await executeInSandbox();
          } finally {
            maskCache.invalidate();
          }
        });
      },
    });
  }
  // Last tool_result handler: hooks, diagnostics and labels above see and shape the full text first.
  registerOutputBudget(pi, outputBudget);
}
