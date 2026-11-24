#!/usr/bin/python3
"""Summarise agent session logs (Claude Code, Codex, Droid, Pi) for one project.

Runs inside the read-only Protected Pi sandbox (sandbox.py --sessions). Reads one JSON request on stdin:
  {"cwd": <project folder, set by the host>, "action": "list"|"digest"|"search",
   "agent": "all"|"claude"|"codex"|"droid"|"pi", "id": <session id prefix>, "query": <text>, "limit": <n>}
and prints plain text. Raw transcripts never leave this process; only digests and short snippets do.
"""
import collections
import datetime as dt
import glob
import json
import os
import re
import sys

OUT_CAP = 60_000
ERR_RX = re.compile(r'(?i)(^error|^\s*error:|traceback \(most recent|exit(ed)? (with )?code:? ?[1-9]|"exit_code":\s*[1-9]|'
                    r'process exited with code [1-9]|script failed|command failed|no such file|permission denied|'
                    r'read-only file system|timed out|not found|pi sandbox:|disallowed|is unavailable in)')
NOISE = ('<system-reminder>', '<command-', '<local-command', 'Caveat:', '[Request interrupted', '<environment_context',
         '<user_instructions', '# AGENTS.md', '<permissions', '<task-notification', 'Conversation history has been compacted')


def text_of(c):
    if isinstance(c, str):
        return c
    out = []
    for b in c or []:
        if isinstance(b, dict):
            if b.get('type') in ('text', 'input_text', 'output_text'):
                out.append(b.get('text', ''))
            elif b.get('type') == 'tool_result':
                out.append(text_of(b.get('content')))
    return '\n'.join(out)


def when(v):
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v / 1000 if v > 1e11 else v, dt.timezone.utc).replace(tzinfo=None)
    if isinstance(v, str):
        try:
            return dt.datetime.fromisoformat(v.replace('Z', '+00:00')).replace(tzinfo=None)
        except ValueError:
            return None
    return None


def project_root(cwd):
    return cwd.split('/.claude/worktrees/')[0].rstrip('/')


def inventory(root, agent):
    home = os.path.expanduser('~')
    dash = root.replace('/', '-').replace('.', '-')
    found = []

    def dirs_for(base, names):
        for d in glob.glob(os.path.join(base, '*')):
            if os.path.basename(d) in names or any(os.path.basename(d).startswith(n) for n in names if n.endswith('-')):
                found_dirs.append(d)

    if agent in ('all', 'claude'):
        found_dirs = []
        dirs_for(os.path.join(home, '.claude/projects'), {dash, dash + '--claude-worktrees-'})
        found += [('claude', f) for d in found_dirs for f in glob.glob(os.path.join(d, '*.jsonl'))]
    if agent in ('all', 'droid'):
        found_dirs = []
        dirs_for(os.path.join(home, '.factory/sessions'), {dash, dash + '--claude-worktrees-'})
        found += [('droid', f) for d in found_dirs for f in glob.glob(os.path.join(d, '*.jsonl'))]
    if agent in ('all', 'pi'):
        pi_name = '--' + root.lstrip('/').replace('/', '-') + '--'
        found_dirs = []
        dirs_for(os.path.join(home, '.pi/agent/sessions'), {pi_name, pi_name[:-2] + '-.claude-worktrees-'})
        found += [('pi', f) for d in found_dirs for f in glob.glob(os.path.join(d, '*.jsonl'))]
        found += [('pi', f) for f in glob.glob(os.path.join(root, '.local/**/sessions/*.jsonl'), recursive=True)]
    if agent in ('all', 'codex'):
        for f in glob.glob(os.path.join(home, '.codex/sessions/**/*.jsonl'), recursive=True):
            try:
                with open(f, errors='replace') as fh:
                    meta = json.loads(fh.readline())
            except (OSError, ValueError):
                continue
            p = meta.get('payload') or {}
            cwd = p.get('cwd') or ''
            if (cwd == root or cwd.startswith(root + '/')) and not p.get('parent_thread_id'):
                found.append(('codex', f))
    return found


class Session:
    def __init__(self, agent, fn):
        self.agent, self.fn = agent, fn
        self.id = os.path.basename(fn).rsplit('.', 1)[0]
        self.users, self.texts, self.errors = [], [], []
        self.tools, self.calls = collections.Counter(), collections.Counter()
        self.t0 = self.t1 = None
        self.interrupts = self.compactions = self.results = 0
        self.final = ''

    def stamp(self, v):
        t = when(v)
        if t:
            self.t0 = min(self.t0, t) if self.t0 else t
            self.t1 = max(self.t1, t) if self.t1 else t

    def user(self, t, ts=None):
        t = (t or '').strip()
        if '[Request interrupted' in t:
            self.interrupts += 1
        if t and not t.startswith(NOISE):
            self.users.append((when(ts), t))

    def call(self, name, args):
        self.tools[name] += 1
        self.calls[(name, json.dumps(args, sort_keys=True)[:300])] += 1

    def result(self, txt, is_err=None):
        self.results += 1
        head = (txt or '')[:600]
        if is_err or (is_err is None and ERR_RX.search(head)):
            self.errors.append(re.sub(r'\s+', ' ', head)[:200])

    def say(self, t, ts=None):
        if t and t.strip():
            self.final = t
            self.texts.append((when(ts), t))


def parse(agent, fn):
    s = Session(agent, fn)
    with open(fn, errors='replace') as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            ts = e.get('timestamp')
            s.stamp(ts)
            t = e.get('type')
            if agent in ('claude', 'droid'):
                if t in ('summary', 'compaction_state'):
                    s.compactions += 1
                m = e.get('message') if isinstance(e.get('message'), dict) else None
                if not m:
                    continue
                role, c = m.get('role'), m.get('content')
                if role == 'user':
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                        for b in c:
                            if isinstance(b, dict) and b.get('type') == 'tool_result':
                                s.result(text_of(b.get('content')), b.get('is_error'))
                    elif not e.get('isMeta') and not e.get('isSidechain'):
                        s.user(text_of(c), ts)
                elif role == 'assistant' and isinstance(c, list):
                    for b in c:
                        if b.get('type') == 'tool_use':
                            s.call(b.get('name'), b.get('input'))
                        elif b.get('type') == 'text':
                            s.say(b.get('text', ''), ts)
            elif agent == 'codex':
                p = e.get('payload') if isinstance(e.get('payload'), dict) else {}
                pt = p.get('type')
                if pt in ('compaction', 'context_compacted'):
                    s.compactions += 1
                if t == 'event_msg' and pt == 'user_message':
                    s.user(p.get('message'), ts)
                elif t == 'event_msg' and pt == 'item_completed' and (p.get('item') or {}).get('type') == 'UserMessage':
                    s.user(text_of(p['item'].get('content')), ts)
                elif t == 'response_item' and pt in ('function_call', 'custom_tool_call', 'local_shell_call'):
                    s.call(p.get('name') or pt, p.get('arguments') or p.get('input') or p.get('action'))
                elif t == 'response_item' and pt in ('function_call_output', 'custom_tool_call_output'):
                    o = p.get('output')
                    s.result(o if isinstance(o, str) else text_of(o))
                elif t == 'event_msg' and pt == 'task_complete':
                    s.say(p.get('last_agent_message') or '', ts)
                elif t == 'event_msg' and pt == 'turn_aborted':
                    s.interrupts += 1
            else:
                if t == 'compaction':
                    s.compactions += 1
                m = e.get('message') if isinstance(e.get('message'), dict) else None
                if not m:
                    continue
                s.stamp(m.get('timestamp'))
                role = m.get('role')
                if role == 'user':
                    s.user(text_of(m.get('content')), m.get('timestamp'))
                elif role == 'assistant':
                    if m.get('stopReason') == 'aborted':
                        s.interrupts += 1
                    for b in m.get('content') or []:
                        if b.get('type') == 'toolCall':
                            s.call(b.get('name'), b.get('arguments'))
                        elif b.get('type') == 'text':
                            s.say(b.get('text', ''), m.get('timestamp'))
                elif role == 'toolResult':
                    s.result(text_of(m.get('content')), m.get('isError'))
    return s


def one_line(t, n):
    return re.sub(r'\s+', ' ', t or '')[:n]


def summary_line(s):
    span = (s.t1 - s.t0).total_seconds() / 3600 if s.t0 and s.t1 else 0
    first = s.users[0][1] if s.users else ''
    start = f'{s.t0:%Y-%m-%d %H:%M}' if s.t0 else 'no time'
    return (f'{s.agent:6} {s.id[:44]:44} {start}  {span:5.1f} h  {len(s.users):3} msgs  {sum(s.tools.values()):5} calls  '
            f'{len(s.errors):3} errors  | {one_line(first, 110)}')


def digest(s):
    span = (s.t1 - s.t0).total_seconds() / 3600 if s.t0 and s.t1 else 0
    out = [f'{s.agent} session {s.id}', f'File: {s.fn}',
           f'{s.t0:%Y-%m-%d %H:%M} to {s.t1:%Y-%m-%d %H:%M} UTC ({span:.1f} h span)' if s.t0 else 'No timestamps',
           f'{len(s.users)} user messages, {sum(s.tools.values())} tool calls, {len(s.errors)} errored results of {s.results}, '
           f'{sum(n - 1 for n in s.calls.values() if n > 1)} exact repeat calls, {s.interrupts} interrupts, {s.compactions} compactions',
           'Tools: ' + ', '.join(f'{k}:{v}' for k, v in s.tools.most_common(12)), '', 'User requests:']
    for ts, u in s.users[:40]:
        out.append(f'- {ts:%m-%d %H:%M} ' if ts else '- ' )
        out[-1] += one_line(u, 400)
    if len(s.users) > 40:
        out.append(f'- (+{len(s.users) - 40} more)')
    errs = collections.Counter(e[:160] for e in s.errors)
    if errs:
        out += ['', 'Most frequent errors:'] + [f'- x{n}: {e}' for e, n in errs.most_common(12)]
    reps = [(k, n) for k, n in s.calls.most_common(5) if n > 2]
    if reps:
        out += ['', 'Most repeated calls:'] + [f'- x{n}: {name} {one_line(args, 160)}' for (name, args), n in reps]
    out += ['', 'Final assistant message:', one_line(s.final, 1500)]
    return '\n'.join(out)


def main():
    req = json.loads(sys.stdin.read(65536) or '{}')
    root = project_root(str(req.get('cwd') or ''))
    if not root.startswith('/'):
        raise SystemExit('session digest: invalid project folder')
    agent = req.get('agent') or 'all'
    if agent not in ('all', 'claude', 'codex', 'droid', 'pi'):
        raise SystemExit('session digest: agent must be all, claude, codex, droid or pi')
    action = req.get('action') or 'list'
    limit = max(1, min(int(req.get('limit') or 30), 200))
    files = inventory(root, agent)
    if action == 'list':
        rows = [parse(a, f) for a, f in files]
        rows = [r for r in rows if r.users or r.tools]
        rows.sort(key=lambda r: r.t0 or dt.datetime.min)
        text = f'{len(rows)} sessions for {root} (agent: {agent}); showing the latest {min(limit, len(rows))}.\n' + \
            '\n'.join(summary_line(r) for r in rows[-limit:])
    elif action == 'digest':
        want = str(req.get('id') or '')
        hits = [(a, f) for a, f in files if want and os.path.basename(f).startswith(want) or want and want in os.path.basename(f)]
        if len(hits) != 1:
            raise SystemExit(f'session digest: id "{want}" matched {len(hits)} sessions; use a longer prefix from list')
        text = digest(parse(*hits[0]))
    elif action == 'search':
        query = str(req.get('query') or '').strip()
        if len(query) < 3:
            raise SystemExit('session digest: query must be at least 3 characters')
        rx = re.compile(re.escape(query), re.I)
        matches = []
        for a, f in files:
            s = parse(a, f)
            for kind, items in (('user', s.users), ('assistant', s.texts)):
                for ts, t in items:
                    m = rx.search(t)
                    if m:
                        lo = max(0, m.start() - 120)
                        matches.append((ts or dt.datetime.min, f'{a:6} {s.id[:40]} {ts:%Y-%m-%d %H:%M} {kind}: …{one_line(t[lo:m.end() + 200], 340)}…'
                                        if ts else f'{a:6} {s.id[:40]} {kind}: {one_line(t[lo:m.end() + 200], 340)}'))
            for e in s.errors:
                if rx.search(e):
                    matches.append((s.t0 or dt.datetime.min, f'{a:6} {s.id[:40]} error: {e}'))
        matches.sort(key=lambda x: x[0])
        text = f'{len(matches)} matches for "{query}"; showing the latest {min(limit, len(matches))}.\n' + \
            '\n'.join(m for _, m in matches[-limit:])
    else:
        raise SystemExit('session digest: action must be list, digest or search')
    if len(text) > OUT_CAP:
        text = text[:OUT_CAP] + '\n[Output truncated; narrow with agent, id or limit]'
    sys.stdout.write(text + '\n')


if __name__ == '__main__':
    main()
