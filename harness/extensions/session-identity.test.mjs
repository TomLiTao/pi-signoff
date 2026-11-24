import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSessionIdentity, sessionIdentitySection } from './session-identity.ts';

test('the prompt names the session ID and model so signatures need not say unavailable', async () => {
  const handlers = new Map();
  registerSessionIdentity({ on: (event, fn) => handlers.set(event, fn) });
  const event = { systemPromptOptions: { sections: {} } };
  const ctx = { sessionManager: { getSessionId: () => '01a20c67-6fde-7469-96f5-c7ac312f6757' }, model: { provider: 'openai-codex', id: 'gpt-6.2-sol' } };
  await handlers.get('before_agent_start')(event, ctx);
  const section = event.systemPromptOptions.sections.session_identity;
  assert.match(section, /Session ID: 01a20c67-6fde-7469-96f5-c7ac312f6757/);
  assert.match(section, /Model: openai-codex\/gpt-6\.2-sol/);
  // Same input, same text: the section is stable across turns.
  const again = { systemPromptOptions: { sections: {} } };
  await handlers.get('before_agent_start')(again, ctx);
  assert.equal(again.systemPromptOptions.sections.session_identity, section);
});

test('missing or throwing session data degrades gracefully', () => {
  assert.equal(sessionIdentitySection({}), undefined);
  const onlyModel = sessionIdentitySection({ sessionManager: { getSessionId() { throw new Error('stale'); } }, model: { provider: 'p', id: 'm' } });
  assert.match(onlyModel, /Model: p\/m/);
  assert.doesNotMatch(onlyModel, /Session ID/);
});
