import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OUTPUT_MOUNT, createOutputBudget, registerOutputBudget, shortenText } from './output-budget.ts';

function tempBase(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-output-budget-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return path.join(base, 'tool-output');
}

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

test('shortenText keeps head and tail at line breaks and counts what it drops', () => {
  const text = lines(1000);
  assert.equal(shortenText('short', 100, 0.5, () => 'x'), undefined);
  const out = shortenText(text, 1000, 0.25, (l, c) => `[omitted ${l} lines, ${c} chars]`);
  assert.ok(out);
  const [head, rest] = out.text.split('\n[omitted ');
  assert.ok(head.startsWith('line 1\n'));
  assert.ok(!head.endsWith('\n') && /^line \d+$/.test(head.split('\n').at(-1)), 'head ends on a whole line');
  assert.ok(out.text.endsWith('line 1000'));
  assert.ok(out.text.length < 1000 + 60);
  // Every line is either shown or counted as omitted.
  const shown = out.text.split('\n').filter(l => l.startsWith('line ')).length;
  assert.equal(shown + out.omittedLines, 1000);
  assert.match(rest, /^\d+ lines, \d+ chars\]/);
});

test('budget saves the full text of an over-budget result and points the model at it', t => {
  const base = tempBase(t);
  const budget = createOutputBudget({ base });
  assert.equal(budget.hostDir(), undefined, 'no folder until something is saved');

  // Under budget, or a tool without a budget: untouched, nothing saved.
  assert.equal(budget.apply({ toolName: 'pi_safe_bash', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] }), undefined);
  assert.equal(budget.apply({ toolName: 'pi_safe_read', toolCallId: 'b', content: [{ type: 'text', text: 'x'.repeat(100_000) }] }), undefined);
  assert.equal(budget.hostDir(), undefined);

  const full = lines(5000, 'out');
  const content = budget.apply({ toolName: 'pi_safe_bash', toolCallId: 'c', content: [{ type: 'text', text: full }] });
  assert.ok(content);
  assert.equal(content.length, 1);
  const text = content[0].text;
  assert.ok(text.length <= 16_000 + 400, `shortened to the budget (got ${text.length})`);
  assert.ok(text.endsWith('out 5000'), 'command output keeps its tail');
  const match = /Full output: (\S+) \(read it with pi_safe_read/.exec(text);
  assert.ok(match, text.slice(0, 200));
  assert.ok(match[1].startsWith(`${OUTPUT_MOUNT}/0001-pi_safe_bash.txt`));

  const dir = budget.hostDir();
  assert.ok(dir && path.dirname(dir) === base && path.basename(dir).startsWith('s-'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = path.join(dir, path.basename(match[1]));
  assert.equal(readFileSync(file, 'utf8'), full);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // Listings keep their head; images and other parts pass through.
  const listing = budget.apply({
    toolName: 'pi_safe_find', toolCallId: 'd',
    content: [{ type: 'text', text: lines(3000, 'src/file') }, { type: 'image', data: 'AA', mimeType: 'image/png' }],
  });
  assert.ok(listing[0].text.startsWith('src/file 1\nsrc/file 2\n'));
  assert.equal(listing[1].type, 'image');
  assert.equal(readdirSync(dir).length, 2);

  budget.cleanup();
  assert.equal(existsSync(dir), false);
});

test('bash full output from the sandbox /tmp is adopted, and apply reuses it instead of saving the shown text', t => {
  const base = tempBase(t);
  const budget = createOutputBudget({ base });
  const oldPath = '/tmp/pi-bash-8b79054cab3ba612.log';
  const shown = `${lines(2000, 'tail')}\n\n[Showing lines 3001-5000 of 5000. Full output: ${oldPath}]`;
  const result = {
    content: [{ type: 'text', text: shown }],
    details: { fullOutputPath: oldPath },
    structuredContent: { output: 'x', full_output_path: oldPath },
  };
  const fullText = lines(5000, 'tail');
  const adopted = budget.adoptFullOutput('call-1', 'pi_safe_bash', oldPath, fullText, result);
  const saved = adopted.details.fullOutputPath;
  assert.match(saved, /^\/tmp\/pi-tool-output\/0001-pi_safe_bash\.txt$/);
  assert.equal(adopted.structuredContent.full_output_path, saved);
  assert.ok(adopted.content[0].text.endsWith(`Full output: ${saved}]`));
  assert.ok(!JSON.stringify(adopted).includes(oldPath));
  assert.equal(readFileSync(path.join(budget.hostDir(), '0001-pi_safe_bash.txt'), 'utf8'), fullText);

  // Error text (a failed command) is rewritten the same way.
  const message = budget.adoptFullOutput('call-2', 'pi_safe_bash', oldPath, fullText, `boom\nFull output: ${oldPath}]`);
  assert.match(message, /Full output: \/tmp\/pi-tool-output\/0002-pi_safe_bash\.txt\]$/);

  const shortened = budget.apply({ toolName: 'pi_safe_bash', toolCallId: 'call-1', content: adopted.content });
  assert.ok(shortened[0].text.includes(`Full output: ${saved} (read it`));
  assert.equal(readdirSync(budget.hostDir()).length, 2, 'the shown text is not saved a second time');
});

test('saving stops at the session limit but results are still shortened', t => {
  const base = tempBase(t);
  const budget = createOutputBudget({ base, budgets: { pi_safe_bash: { chars: 100, head: 0.5 } } });
  const huge = 'y'.repeat(17 * 1024 * 1024);
  const content = budget.apply({ toolName: 'pi_safe_bash', toolCallId: 'z', content: [{ type: 'text', text: huge }] });
  assert.match(content[0].text, /The full output was not kept; narrow the command/);
  assert.ok(content[0].text.length < 400);
});

test('stale session folders from crashed sessions are pruned when a new one is created', t => {
  const base = tempBase(t);
  mkdirSync(base, { recursive: true });
  const stale = path.join(base, 's-old');
  const fresh = path.join(base, 's-new');
  const other = path.join(base, 'keep-me');
  for (const d of [stale, fresh, other]) mkdirSync(d);
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  utimesSync(stale, old, old);
  utimesSync(other, old, old);
  const budget = createOutputBudget({ base });
  budget.save('id', 'pi_safe_git', 'text');
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(other), true);
});

test('registerOutputBudget replaces content, keeps structured output, and cleans up on shutdown', async t => {
  const base = tempBase(t);
  const budget = createOutputBudget({ base, budgets: { pi_safe_git: { chars: 50, head: 0.8 } } });
  const handlers = {};
  registerOutputBudget({ on: (name, fn) => { handlers[name] = fn; } }, budget);
  const structured = { output: 'all of it' };
  const res = await handlers.tool_result({
    toolName: 'pi_safe_git', toolCallId: 'g', content: [{ type: 'text', text: lines(100) }], structuredContent: structured,
  });
  assert.equal(res.structuredContent, structured);
  assert.match(res.content[0].text, /omitted\. Full output: \/tmp\/pi-tool-output\/0001-pi_safe_git\.txt/);
  assert.equal(await handlers.tool_result({ toolName: 'pi_safe_git', toolCallId: 'h', content: [{ type: 'text', text: 'ok' }] }), undefined);
  const dir = budget.hostDir();
  await handlers.session_shutdown();
  assert.equal(existsSync(dir), false);
});
