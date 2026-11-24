import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autonomyBanner, compactPath, diffStats, footerDetailParts, formatElapsed, formatTurnChanges, nextDroidCycleStep, parseUiStyle,
  prefixAssistantMarkdown, summarizeToolResult, todoLines, todoSummary, toolHeader, workingMessage,
} from './droid-ui-format.ts';
import { testNodeHome } from './_node-home.mjs';

const text = t => ({ content: [{ type: 'text', text: t }] });

test('ui style parsing accepts droid and classic only', () => {
  assert.equal(parseUiStyle('Droid'), 'droid');
  assert.equal(parseUiStyle(' classic '), 'classic');
  assert.equal(parseUiStyle('fancy'), null);
  assert.equal(parseUiStyle(undefined), null);
});

test('autonomy banner describes mode and autonomy the way the footer shows them', () => {
  assert.deepEqual(autonomyBanner({ mode: 'PLAN', autonomy: 'medium' }).label, 'Spec');
  assert.equal(autonomyBanner({ mode: 'READ-ONLY' }).label, 'Read-only');
  assert.equal(autonomyBanner({ mode: 'ACCEPT-EDITS', autonomy: 'off' }).description, 'edits run; commands ask first');
  assert.equal(autonomyBanner({ mode: 'ASK-EDITS', autonomy: 'off' }).description, 'every edit and command asks first');
  assert.equal(autonomyBanner({ mode: 'ACCEPT-EDITS', autonomy: 'low' }).label, 'Auto (Low)');
  assert.equal(autonomyBanner({ mode: 'ACCEPT-EDITS', autonomy: 'medium' }).label, 'Auto (Medium)');
  const wf = autonomyBanner({ mode: 'WORKFLOW', autonomy: 'low' });
  assert.equal(wf.label, 'Auto (Low)');
  assert.match(wf.description, /^workflow/);
});

test('shift+tab ring goes Off → Low → Medium → Spec → Off and never reaches high', () => {
  assert.deepEqual(nextDroidCycleStep({ planning: false, autonomy: 'off' }), { kind: 'autonomy', level: 'low' });
  assert.deepEqual(nextDroidCycleStep({ planning: false, autonomy: 'low' }), { kind: 'autonomy', level: 'medium' });
  assert.deepEqual(nextDroidCycleStep({ planning: false, autonomy: 'medium' }), { kind: 'enter-spec' });
  assert.deepEqual(nextDroidCycleStep({ planning: true, autonomy: 'medium' }), { kind: 'leave-spec' });
});

test('footer detail line lists cwd, checkpoint, jobs, context and tokens', () => {
  const parts = footerDetailParts({
    cwd: '/home/u/proj',
    branch: 'main',
    snapshot: {
      mode: 'WORKFLOW', checkpointRef: 'refs/pi-protected-checkpoints/20261122-120000-deadbeef',
      activeJobs: 2, rejectedCount: 1, webEnabled: true, fetchEnabled: false,
      delegatesRemaining: 3, delegatesMax: 4,
    },
    contextPercent: 12.6,
    contextWindow: 400_000,
    inputTokens: 15_300,
    outputTokens: 900,
    extraStatuses: ['mcp: 2 servers\n'],
  });
  assert.deepEqual(parts.slice(1), [
    'workflow', 'ckpt deadbeef', '1 rejected', '2 jobs', 'droids 3/4', 'fetch off', 'ctx 13%/400k', '↑15k ↓900', 'mcp: 2 servers',
  ]);
  assert.match(parts[0], /proj \(main\)$/);
});

test('tool headers use Droid verbs with compact arguments', () => {
  assert.deepEqual(toolHeader('pi_safe_read', { path: '/w/src/a.ts', offset: 10, limit: 50 }, '/w'),
    { label: 'READ', detail: 'src/a.ts, offset: 10, limit: 50' });
  assert.deepEqual(toolHeader('pi_safe_bash', { command: 'npm test\n  --silent' }), { label: 'EXECUTE', detail: 'npm test ⏎ --silent' });
  assert.equal(toolHeader('pi_safe_edit', { path: 'x.py' }).label, 'EDIT');
  assert.equal(toolHeader('pi_safe_write', { path: 'x.py' }).label, 'CREATE');
  assert.deepEqual(toolHeader('pi_safe_grep', { pattern: 'foo', glob: '*.ts' }), { label: 'GREP', detail: '"foo", glob: *.ts' });
  assert.equal(toolHeader('pi_safe_find', { pattern: '**/*.md' }).detail, '**/*.md');
  assert.equal(toolHeader('pi_safe_ls', {}).label, 'LIST DIRECTORY');
  assert.equal(toolHeader('pi_safe_git', { subcommand: 'log', args: ['-5'] }).detail, 'log -5');
  assert.equal(toolHeader('pi_safe_delegate', { task: 'find bugs', droid: 'reviewer' }).detail, 'reviewer: find bugs');
  assert.deepEqual(toolHeader('mcp__docs__search', {}), { label: 'MCP', detail: 'docs:search' });
  assert.equal(toolHeader('something_new', {}).label, 'SOMETHING NEW');
  assert.ok(toolHeader('pi_safe_bash', { command: 'x'.repeat(500) }).detail.length <= 120);
});

test('result summaries count lines, matches and exit codes', () => {
  assert.equal(summarizeToolResult('pi_safe_read', {}, text('a\nb\nc\n'), false), 'Read 3 lines.');
  assert.equal(summarizeToolResult('pi_safe_bash', {}, text('ok\n'), false), 'Exit code 0. 1 line of output.');
  assert.equal(summarizeToolResult('pi_safe_bash', {}, text('(no output)'), false), 'Exit code 0. No output.');
  assert.equal(summarizeToolResult('pi_safe_bash', {}, text('boom\nbad\n\nCommand exited with code 2'), true),
    'Exit code 2. 2 lines of output.');
  assert.match(summarizeToolResult('pi_safe_bash', {}, text('Command timed out after 5 seconds'), true), /^Command timed out/);
  assert.equal(summarizeToolResult('pi_safe_grep', {}, text('No matches found'), false), 'No matches found.');
  assert.equal(summarizeToolResult('pi_safe_grep', {}, text('a.ts:1: x\nb.ts:22: y'), false), 'Found 2 matches.');
  assert.equal(summarizeToolResult('pi_safe_find', {}, text('a\nb'), false), 'Found 2 files.');
  assert.equal(summarizeToolResult('pi_safe_ls', {}, text('a/\nb'), false), 'Listed 2 entries.');
  assert.equal(summarizeToolResult('pi_safe_write', { content: 'x\ny\n' }, text('ok'), false), 'Succeeded. Wrote 2 lines.');
  assert.equal(
    summarizeToolResult('pi_safe_edit', {}, { ...text('ok'), details: { diff: ' 1 a\n-2 b\n+2 c\n+3 d' } }, false),
    'Succeeded. File edited. (+2 added, -1 removed)',
  );
  assert.equal(summarizeToolResult('pi_safe_read', {}, text('denied'), true), 'Error: denied');
  assert.equal(summarizeToolResult('pi_safe_web_search', {}, text('5 results from DuckDuckGo\nUntrusted…\n1. A'), false), '5 results from DuckDuckGo');
  assert.equal(summarizeToolResult('pi_safe_web_fetch', {}, text('PDF "Paper" · chars 0-20,000 of 90,000\n\nbody'), false), 'PDF "Paper" · chars 0-20,000 of 90,000');
  assert.deepEqual(toolHeader('pi_safe_code', { action: 'references', path: '/w/quant/m.py', line: 1, symbol: 'sharpe' }, '/w'), { label: 'REFERENCES', detail: 'quant/m.py:1 sharpe' });
  assert.deepEqual(toolHeader('pi_safe_data', { action: 'query', sql: 'SELECT 1' }), { label: 'SQL', detail: '"SELECT 1"' });
  assert.equal(summarizeToolResult('pi_safe_code', {}, text('3 references to sharpe:\na.py:1'), false), '3 references to sharpe:');
  assert.deepEqual(toolHeader('pi_safe_web_search', { query: 'fed rates', time: 'week', site: 'reuters.com' }), { label: 'WEB SEARCH', detail: '"fed rates", site: reuters.com, past week' });
  assert.deepEqual(toolHeader('pi_safe_web_fetch', { url: 'https://x.test/a.pdf', find: 'Sharpe', offset: 20000 }), { label: 'FETCH', detail: 'https://x.test/a.pdf, find "Sharpe", offset: 20000' });
  assert.equal(summarizeToolResult('pi_safe_memory', {}, text(''), false), 'Done.');
});

test('diff stats ignore context lines', () => {
  assert.deepEqual(diffStats(' 1 keep\n-2 old\n+2 new\n   ...'), { added: 1, removed: 1 });
});

test('todo rendering marks status', () => {
  const items = [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ];
  assert.equal(todoSummary(items), '3 total (1 pending, 1 in progress, 1 completed)');
  assert.deepEqual(todoLines(items).map(r => r.mark), ['☒', '◐', '☐']);
});

test('assistant marker keeps block markdown intact', () => {
  assert.equal(prefixAssistantMarkdown('Hello there'), '⛬  Hello there');
  assert.equal(prefixAssistantMarkdown('\nHello'), '\n⛬  Hello');
  assert.equal(prefixAssistantMarkdown('# Title\nbody'), '⛬\n\n# Title\nbody');
  assert.equal(prefixAssistantMarkdown('- item'), '⛬\n\n- item');
  assert.equal(prefixAssistantMarkdown('```js\nx\n```'), '⛬\n\n```js\nx\n```');
  assert.equal(prefixAssistantMarkdown('⛬  already'), '⛬  already');
  assert.equal(prefixAssistantMarkdown(''), '');
});

test('working message shows elapsed time and running tools', () => {
  assert.equal(formatElapsed(65_000), '1m 05s');
  assert.equal(workingMessage(3_200, []), 'Thinking… (3s · esc to interrupt)');
  assert.equal(workingMessage(1_000, ['READ']), 'Running READ… (1s · esc to interrupt)');
  assert.equal(workingMessage(1_000, ['READ', 'GREP']), 'Running 2 tools… (1s · esc to interrupt)');
});

test('compact paths keep the last two segments', () => {
  assert.equal(compactPath('/home/u/proj', 40, '/home/u'), '~/proj');
  assert.equal(compactPath('/tmp/a-very-long-directory-name/with/more/scratchpad/demo', 30, '/home/u'), '…/scratchpad/demo');
  assert.equal(compactPath('/x/' + 'y'.repeat(60), 20, '/home/u').length, 20);
});

test('spec banner names the mode approval returns to', () => {
  assert.equal(autonomyBanner({ mode: 'PLAN', returnMode: 'workflow', autonomy: 'medium' }).description,
    'read-only planning; approve → Workflow · Auto (Medium)');
  assert.equal(autonomyBanner({ mode: 'PLAN' }).description, 'read-only planning; approve → Accept-edits');
});

test('turn change summary totals lines and lists the biggest files first', () => {
  const out = formatTurnChanges({
    total: 7,
    files: [
      { path: 'a.py', added: 1, removed: 0 },
      { path: 'b.py', added: 30, removed: 5 },
      { path: 'img.png', added: 0, removed: 0, binary: true },
    ],
  }, 2);
  assert.equal(out.headline, 'Changed 7 files (+31 −5)');
  assert.deepEqual(out.rows, ['b.py  +30 −5', 'a.py  +1 −0']);
  assert.equal(out.more, 5);
});

test('droid tone neutralizes violet message panels and accents on the real Pi Theme class', async t => {
  const themeModule = `${testNodeHome()}/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js`;
  let mod;
  try { mod = await import(themeModule); } catch { t.skip('pi-coding-agent is not installed here'); return; }
  const { installDroidTone } = await import('./droid-ui-format.ts');
  const dark = mod.loadThemeFromPath(themeModule.replace(/theme\.js$/, 'dark.json'), 'truecolor');
  const before = { user: dark.getBgAnsi('userMessageBg'), note: dark.getBgAnsi('customMessageBg'), accent: dark.getFgAnsi('accent'), neutral: dark.getBgAnsi('toolPendingBg') };
  assert.notEqual(before.user, before.neutral);
  let enabled = true;
  assert.equal(installDroidTone(dark, () => enabled), true);
  assert.equal(installDroidTone(dark, () => enabled), true, 'idempotent');
  assert.equal(dark.getBgAnsi('userMessageBg'), before.neutral);
  assert.equal(dark.bg('customMessageBg', 'x'), `${before.neutral}x\x1b[49m`);
  assert.equal(dark.fg('accent', 'x'), '\x1b[38;5;208mx\x1b[39m');
  assert.equal(dark.getFgAnsi('customMessageLabel'), '\x1b[38;5;208m');
  assert.equal(dark.getFgAnsi('text'), dark.getFgAnsi('text'));
  // Through the global `theme` proxy, which is what Pi's components use.
  mod.setThemeInstance(dark);
  assert.equal(mod.theme.bg('userMessageBg', 'y'), `${before.neutral}y\x1b[49m`);
  // Classic style: untouched.
  enabled = false;
  assert.equal(dark.getBgAnsi('userMessageBg'), before.user);
  assert.equal(dark.getFgAnsi('accent'), before.accent);
  assert.equal(installDroidTone({}, () => true), false, 'plain objects are not patched');
});
