import assert from 'node:assert/strict';
import test from 'node:test';
import { formatContextReport } from './context-cmd.ts';

test('/context breaks down window usage, system prompt, tools, instructions, memory, skills, and conversation', () => {
  const report = formatContextReport(
    {
      getActiveTools: () => ['pi_safe_read', 'pi_safe_bash'],
      getAllTools: () => [
        { name: 'pi_safe_read', description: 'Read file', parameters: { type: 'object' }, exposure: 'direct', sourceInfo: {} },
        { name: 'pi_safe_bash', description: 'Run bash', parameters: { type: 'object' }, exposure: 'direct', sourceInfo: {} },
      ],
    },
    {
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      getContextUsage: () => ({ tokens: 12400, contextWindow: 200000, percent: 6.2 }),
      getSystemPrompt: () => 'x'.repeat(2000),
      sessionManager: {
        getBranch: () => [
          { type: 'message', message: { role: 'user', content: 'hello world' } },
          { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
        ],
      },
    },
    {
      instructions: () => ({ rootLoadedBytes: 400, rootFile: 'AGENTS.md', nestedInjectedCount: 1, nestedInjectedBytes: 120 }),
      memory: () => ({ enabled: true, hardDisabled: false, indexBytes: 200, totalBytes: 500, fileCount: 2 }),
      skills: () => ({ enabled: true, activeCount: 2, promptBytes: 300, names: ['helper', 'deploy'] }),
    },
  );

  assert.match(report, /12,400 tok \/ 200,000 tok \(6%\)/);
  assert.match(report, /Instructions: AGENTS\.md/);
  assert.match(report, /\+1 nested in transcript/);
  assert.match(report, /Memory:\s+200 chars/);
  assert.match(report, /Skills:\s+2 active/);
  assert.match(report, /Tool schemas: 2 active/);
  assert.match(report, /Conversation: 2 message\(s\)/);
});
