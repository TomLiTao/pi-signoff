# pi-plan-gate

**Approve once, between planning and execution.** pi-plan-gate is a hardening and workflow layer for the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`).
The agent explores read-only, then submits one plan listing every permission it will need: shell commands,
sensitive files, worktree subagents. You review that plan once and approve, revise or reject it. Approved
work then runs without interruptions. Anything the plan did not ask for is rejected and queued for review,
not prompted mid-run.

Every tool call also runs inside a [Bubblewrap](https://github.com/containers/bubblewrap) sandbox, with Git
checkpoints before each turn's first change. The terminal experience is modelled on Factory Droid and Claude
Code.

> **Status:** a personal configuration, published as is. It has been developed and tested on one Linux
> workstation with Pi 1.6.0 and the OpenAI Codex provider. It has had no independent security review; read
> the code before relying on it. Not affiliated with Earendil, Factory or Anthropic.

## Contents

- [The plan gate](#the-plan-gate)
- [How it differs from stock Pi](#how-it-differs-from-stock-pi)
- [Install](#install)
- [Will it behave like the author's setup?](#will-it-behave-like-the-authors-setup)
- [Tests](#tests) · [Layout](#layout) · [Licence](#licence)

## The plan gate

In **workflow mode** (`pi --workflow`, `/mode workflow`, or `Ctrl+Alt+Y` to cycle modes) the sequence is enforced:

1. **Plan (read-only).** Read-only tools and routine read-only shell commands run in a read-only mount.
   Edits and non-routine commands are blocked.
2. **Ask once (`pi_safe_plan`).** The agent submits ordered steps plus the exact permissions it needs:
   `shellPrefixes`, `shellCommands`, `scripts`, sensitive `files` and `worktreeSubagents`. The review dialog
   has **no timeout**; it waits until you choose:
   - **Approve:** for this plan only, with Auto Medium, or saving the shell rules for the project.
   - **Revise the plan…:** type what to change; the agent revises the plan and resubmits it.
   - **Reject the plan:** the agent stops and waits for your next instruction.

   Pressing Esc shows the dialog again. An interrupted turn is reported to the agent as "no decision",
   never as a rejection.
3. **Execute.** Approved permissions run without prompts. An unrequested command is **rejected by default**,
   and the run pauses once it settles. The item is listed in `/rejected`, where you can approve it
   selectively and continue.

Outside workflow mode, the same plan review appears whenever a multi-step task needs non-routine commands
or sensitive edits.

## How it differs from stock Pi

### Safety and approvals

| Feature | Stock Pi | pi-plan-gate |
|---|---|---|
| Tool execution | On your host as your user | Each call in a fresh Bubblewrap sandbox. Secret-named files (`.env*`, keys) and their hardlinks are hidden; writes are limited to the launch folder, its Git directory and a private `/tmp`. `--strict` also removes network access and hides `$HOME`. |
| Tools the model sees | Built-in `read`, `bash`, `edit`, … | Only `pi_safe_*` wrappers; built-in tools are switched off |
| Shell approval | Not gated | In order: deny rules → plan-mode safety → routine read-only commands → "never-auto" scripts (deploy or broker scripts ask every run) → autonomy level → plan grants → prompt. Saved rules match on tokenized argv. |
| Script grants | — | Approve `python3 scripts/x.py` for any arguments, pinned to the SHA-256 of the script and its local imports; an edit voids the grant |
| Undo | — | Git checkpoint before each turn's first change; `/rewind` restores files, conversation or both; on exit you get a patch (optionally keep / revert / diff) |
| Sensitive paths | — | `AGENTS.md`, `CLAUDE.md`, CI config, lockfiles and symlinks always ask; secrets and `.git` are always denied (`harness/write-guard.json`) |
| Untrusted input | — | Project `AGENTS.md`, skills and droids load only after you pin their SHA-256; MCP and web results are labelled as untrusted data; queries and URLs carrying `.env` values or credential-shaped strings are blocked before they leave |
| Audit | — | Every permission decision goes to `~/.cache/pi-protected/audit/<session>.jsonl` (argument digests, no contents) |

### Factory Droid–style interface

The default interface (`--ui droid`; `--ui classic` or `/ui classic` restores stock Pi) follows Factory Droid's
terminal UX:
- **Autonomy in Droid's terms:** `Auto (Off | Low | Medium)` and `Spec`, cycled with **Shift+Tab**.
  - Low allows workspace edits and read-only inspection.
  - Medium adds allowlisted test, lint and build commands.
  - There is no High.
- **Spec mode** (`/plan`, `--use-spec`): read-only planning that hands over to the plan gate. Approved specs
  can be saved (`/spec`).
- **Custom droids:** built-in `explorer`, `reviewer` and `worker`; personal droids in
  `~/.config/pi-protected/droids/`; hash-pinned project droids in `.factory/droids/` or `.agents/droids/`.
  Run them with `/droids`, `/delegate --droid <name>` or the `pi_safe_delegate` tool.
- **Tool rows:**
  - Rows read like `READ (path)`, `EXECUTE (cmd)` or `EDIT (path)`, followed by a `↳` summary.
  - After any turn that changed files, a review line appears, e.g.
    `● Changed 3 files (+42 −7) · /diff to review · /rewind to undo`.
- **Layout:** a startup banner, a boxed input, a two-line footer (autonomy, model, folder, checkpoint, jobs,
  context, tokens, cost), and approval dialogs with `Deny` first.

### Claude Code–style features

| Claude Code | pi-plan-gate equivalent |
|---|---|
| Permission modes (plan, default, accept edits) | `/mode plan`, `ask-edits`, `accept-edits`, plus `workflow` (the plan gate); per-folder defaults with `/mode default` |
| `AskUserQuestion` | `pi_safe_ask_user`: up to 4 single- or multi-choice questions, with recommended options and free-text answers |
| Hooks | `SessionStart`, `PreToolUse`, `PostToolUse` and `Stop` in `~/.config/pi-protected/hooks.json`; each runs in the sandbox after the permission checks |
| Skills | `SKILL.md` skills from `~/.config/pi-protected/skills/` (or `~/.codex/skills/`) and hash-pinned `.agents/skills/` |
| `CLAUDE.md` / memory | Pinned `AGENTS.md` (falls back to `CLAUDE.md`; nested files load when their folder is first read); opt-in `/memory` |
| Subagents and background tasks | `pi_safe_delegate` (read-only, or writing in an isolated worktree and returning a patch); `/bg` and `pi_safe_job_*` jobs (≤30 min); detached runs (`pi_safe_run_*`, ≤24 h) |
| `/rewind`, `/review`, `/commit`, `/pr` | All present: `/review` runs a read-only bugs-first reviewer on the checkpoint diff; `/commit` drafts the message and blocks staged secrets; `/pr` uses your `gh` |
| Todos, `/context`, status line | `pi_safe_todo`, a token breakdown with `/context`, and a footer status line |
| Output styles, notifications | `/style` (concise, explanatory, terse, custom); `/notify` bell cues |
| MCP and tool search | Sandboxed stdio MCP bridges (`~/.config/pi-protected/mcp.json`); deferred servers promoted on demand via `tool_search` |
| `/doctor` | Checks the installed files, sandbox, checkpoint, hooks, MCP and Pi bundle patches |

### Other additions

- Background jobs announce completion themselves, so the model does not poll.
- `pi_safe_code`: basedpyright diagnostics, definitions, references and rename previews. It also runs a check
  after every Python edit.
- `pi_safe_data`: preview CSV, JSON or Parquet files, or run read-only DuckDB SQL on them.
- `/deps`: installs dependencies with network access, in a separate sandbox.
- Web search (DuckDuckGo, then Mwmbl, then Brave if you add a key) and web fetch, which converts pages and
  PDFs to Markdown.
- `/runs`: a log of the agent's Python script runs. `/handoff`: a redacted session hand-off file.
  `/recap`, `/worktree` and `/clip` are also available.
- Pi bundle patches, reapplied by `install.sh`:
  - relative file links in replies become openable `file://` links;
  - a misleading trust warning is replaced.

## Install

Requirements:
- Linux with `/usr/bin/bwrap` (Bubblewrap), `/usr/bin/python3` and `/usr/bin/git`.
- Pi installed globally into a **self-contained Node prefix** (official tarball, nvm, fnm or volta) that holds
  both `bin/node` and Pi. The sandbox mounts that prefix and runs its `node`.
- Optional: `uv`, used to install DuckDB for `pi_safe_data`; `wl-copy` for `/clip`; `gh` for `/pr`.

```bash
npm install -g @earendil-works/pi-coding-agent@1.6.0     # tested version
git clone <this repository> pi-plan-gate && cd pi-plan-gate
./install.sh            # PI_NODE_HOME=/node/prefix to choose a Node; PI_SKIP_RUNTIMES=1 to skip basedpyright/DuckDB
cd ~/some/project && pi --workflow                       # run from a project folder, not from $HOME
```

`install.sh`:
- finds the Node prefix (`PI_NODE_HOME`, else `npm root -g`) and records it for the launcher;
- copies the harness to `~/.local/lib/pi-protected/` and links `~/.local/bin/pi`;
- installs basedpyright and DuckDB, and applies the bundle patches;
- copies `config/pi-settings.json` to `~/.pi/agent/settings.json` **only if you have no settings yet**.

Re-run it after updating Pi. Inside Pi, `/doctor` confirms that the install matches the checkout and that the
patches are applied. On first start, sign in to a provider with `/login`.

## Will it behave like the author's setup?

The code is the same. Everything that depends on personal configuration is outside the repository and starts
empty:

| Item | Where it lives | Fresh install |
|---|---|---|
| Default model, idle timeout, telemetry off | `~/.pi/agent/settings.json` | Copied from `config/pi-settings.json` (OpenAI Codex, `gpt-6.2-sol`) if absent. Edit it for your provider. |
| Provider sign-in | `~/.pi/agent/auth.json` | Run `/login` |
| Saved shell rules, trusted instructions | `~/.local/lib/pi-protected/` | Empty; built up as you approve |
| Per-folder default mode and autonomy | `~/.local/state/pi-protected/project-defaults/` | Stock defaults: accept-edits, Auto Off |
| Skills, droids, hooks, MCP servers, output style | `~/.config/pi-protected/` (skills also `~/.codex/skills/`) | None |
| Brave Search fallback key | `~/.config/pi-protected/brave-search.key` | None; DuckDuckGo and Mwmbl still work |

## Tests

```bash
(cd harness/extensions && node --test *.test.mjs)        # unit tests, no install needed
python3 -m pytest -q harness/test_protected_pi.py       # end-to-end; launches the installed pi in RPC mode
```

Tests that load Pi's own modules use the same Node prefix as the launcher (`PI_NODE_HOME`, else the one
recorded by `install.sh`).

## Layout

| Path | Contents |
|---|---|
| `bin/pi` | Launcher: checkpoint, sandbox checks, Pi flags and extension loading |
| `harness/sandbox.py` | Bubblewrap profiles for tool calls, shell, hooks, MCP and dependency installs |
| `harness/tool-worker.mjs` | Runs one tool call inside the sandbox |
| `harness/extensions/` | Pi extensions: plan gate, approvals, modes, interface, jobs, tools |
| `harness/extensions/pi-plan/` | Vendored [pi-plan](https://github.com/zx06/pi-packages/tree/main/packages/plan) (MIT) |
| `harness/write-guard.json` | Path and command policy (ask, deny, secret, never-auto) |
| `config/pi-settings.json` | Recommended Pi settings |

## Licence

MIT; see [LICENSE](LICENSE). The vendored `harness/extensions/pi-plan/` keeps its own MIT licence; see
[THIRD_PARTY.md](THIRD_PARTY.md). "Factory", "Droid" and "Claude Code" are mentioned only to describe
interface similarities.
