// Node install used by tests that load Pi's own modules: PI_NODE_HOME, else the path install.sh recorded,
// else the original author's layout. Matches the launcher's resolution.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function testNodeHome() {
  if (process.env.PI_NODE_HOME) return process.env.PI_NODE_HOME;
  try {
    const recorded = readFileSync(path.join(homedir(), '.local/lib/pi-protected/node-home'), 'utf8').trim();
    if (recorded) return recorded;
  } catch {
    // Not installed yet: fall back.
  }
  return path.join(homedir(), '.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64');
}
