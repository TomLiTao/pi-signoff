# pi-plan-gate

**Approve once, between planning and execution.** pi-plan-gate is a hardening layer for the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent` 1.6.x).
The agent explores read-only, then submits one plan that lists every permission it will need: shell
commands, sensitive files, worktree subagents. You review that plan once and approve, revise or reject it.
Approved work then runs without interruptions. Anything the plan did not ask for is rejected and queued for
your review instead of interrupting you mid-run.

Every tool call runs inside a [Bubblewrap](https://github.com/containers/bubblewrap) sandbox, and file
changes are checkpointed in Git, so the gate is not the only line of defence.

> Status: a personal configuration, published as is. It is developed and tested on one Linux workstation
> with Pi 1.6.0. Read the code before trusting it with anything that matters. It has had no independent
> security review.

## How the plan gate works

In **workflow mode** (`pi --workflow`, or `/mode workflow`) the sequence is enforced:

1. **Plan (read-only).** Read-only tools and routine read-only shell commands run in a read-only mount.
   Edits and non-routine commands are blocked.
2. **Ask once (`pi_safe_plan`).** The agent submits ordered steps plus the exact permissions it needs
   (`shellPrefixes`, `shellCommands`, `scripts`, sensitive `files`, `worktreeSubagents`). The review dialog
   **waits until you decide**; it has no timeout:
   - **Approve:** for this plan only, with Auto Medium, or saving the shell rules for the project.
   - **Revise the plan…:** type what should change; the agent revises the plan and resubmits it.
   - **Reject the plan:** the agent stops and waits for your next instruction.

   Dismissing the dialog shows it again. An interrupted turn is reported to the agent as "no decision",
   never as a rejection.
3. **Execute.** Approved permissions run without prompts. An unrequested command is **rejected by default**,
   the run pauses when it settles, and the item goes to `/rejected`, where you can approve it selectively.

Outside workflow mode the same plan review is used whenever a task needs non-routine commands or sensitive
edits, and the other modes (`plan`, `ask-edits`, `accept-edits`) behave as usual.

## What else it adds

- **Sandboxed tools.** The model only gets `pi_safe_*` tools; Pi's built-in tools are disabled. Each call
  runs in a fresh Bubblewrap sandbox. Secret-named files (`.env*`, keys) and their hardlinks are hidden.
  Writes are limited to the launch folder, its Git directory and a private `/tmp`. The default host mode
  allows shell network access and reads from a small home-directory allowlist; `--strict` removes both.
- **Git checkpoints.** Before the first change in each turn, the working tree is snapshotted to
  `refs/pi-protected-checkpoints/` without touching your index or branch. On exit you get a patch, and
  optionally a keep / revert / diff prompt (`PI_PROTECTED_EXIT=ask`).
- **Approval layers for shell commands.** In order: deny rules, plan-mode safety, routine read-only commands,
  "never-auto" scripts (deploy or broker scripts that ask every run), autonomy level (`off`, `low` or
  `medium`; never higher), plan grants, then a prompt. Saved rules match on tokenized argv. Script grants
  are pinned to the SHA-256 of the script and its local imports.
- **Audit log.** Every permission decision goes to `~/.cache/pi-protected/audit/<session>.jsonl`, with
  argument digests rather than raw contents.
- **Background work.** Background jobs (`pi_safe_job_*`, up to 30 min); detached runs that survive Pi
  exiting (`pi_safe_run_*`, up to 24 h); read-only or isolated-worktree subagents.
- **Other tools.** Web search and fetch, structured questions (`pi_safe_ask_user`), code intelligence
  (basedpyright), a data tool (DuckDB), sandboxed MCP bridges and user hooks.
- **Pi bundle patches** (`harness/patch-pi-bundle.py`, reapplied by `install.sh`). One makes relative file
  links in replies openable from the terminal. The other replaces a misleading trust warning.

## Requirements

- Linux with `/usr/bin/bwrap` (Bubblewrap), `/usr/bin/python3` and `/usr/bin/git`.
- Pi 1.6.x installed globally into a Node 24 install. `bin/pi` and `install.sh` currently expect
  `~/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64`. Edit `NODE_HOME` in both if yours
  differs. Making this configurable is on the to-do list.
- A model provider configured in Pi (developed against the OpenAI Codex provider).
- Optional: `uv`, used to install DuckDB for `pi_safe_data`.

## Install

```bash
git clone <this repository> pi-plan-gate
cd pi-plan-gate
./install.sh                     # PI_SKIP_RUNTIMES=1 ./install.sh skips basedpyright and DuckDB
pi --workflow                    # run from a project folder, not from $HOME
```

`install.sh` copies the harness to `~/.local/lib/pi-protected/`, links `~/.local/bin/pi`, and applies the
bundle patches. Re-run it after updating Pi. Inside Pi, `/doctor` checks that the installed copy matches
this checkout and that the patches are present.

## Tests

```bash
(cd harness/extensions && node --test *.test.mjs)            # unit tests, no install needed
python3 -m pytest -q harness/test_protected_pi.py           # launches the installed pi in RPC mode
```

## Layout

| Path | Contents |
|---|---|
| `bin/pi` | Launcher: checkpoint, sandbox checks, Pi flags and extension loading |
| `harness/sandbox.py` | Bubblewrap profiles for tool calls, shell and hooks |
| `harness/tool-worker.mjs` | Runs one tool call inside the sandbox |
| `harness/extensions/` | Pi extensions: approvals, plan gate, modes, jobs, tools, UI |
| `harness/extensions/pi-plan/` | Vendored [pi-plan](https://github.com/zx06/pi-packages/tree/main/packages/plan) (MIT) |
| `harness/write-guard.json` | Path and command policy (ask, deny, secret, never-auto) |

## Licence

MIT; see [LICENSE](LICENSE). `harness/extensions/pi-plan/` keeps its own MIT licence; see
[THIRD_PARTY.md](THIRD_PARTY.md).
