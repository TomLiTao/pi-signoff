// Outgoing secret check for web search queries and fetch URLs. Runs on the host before anything
// leaves the laptop: blocks text containing a value from the workspace's dotenv files or a string
// shaped like a known credential. The reason never repeats the secret.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';

const KEY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style API key', /\bsk-(?:proj-|svcacct-|live_|test_)?[A-Za-z0-9_-]{20,}/],
  ['an AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a credential in a URL', /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret)=[^&#\s]{8,}/i],
  ['a password in a URL', /\/\/[^/\s:@]+:[^/\s@]{4,}@/],
];

const DOTENV_FILE = /^\.env(?:\..+)?$/;
const MAX_ENV_BYTES = 256 * 1024;
// Values too generic to treat as secrets: booleans, plain words, loopback/private hosts, paths.
const BENIGN_VALUE = /^(?:true|false|yes|no|on|off|null|none|debug|info|warn|warning|error|production|development|staging|test|localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i;

function readSmall(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ENV_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (!n) break;
      total += n;
    }
    return buf.subarray(0, total).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** KEY → value pairs from dotenv text, keeping only values worth treating as secrets. */
export function parseDotenvSecrets(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    if (value.length < 8 || BENIGN_VALUE.test(value)) continue;
    if (/^[a-z]+$/.test(value) || /^\d{1,7}$/.test(value)) continue;
    if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/?$/i.test(value)) continue;
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('~/')) continue;
    out.push({ key: m[1], value });
  }
  return out;
}

function variants(text: string): string[] {
  const out = [text];
  try {
    const decoded = decodeURIComponent(text.replace(/\+/g, ' '));
    if (decoded !== text) out.push(decoded);
  } catch {
    // Malformed escapes: the raw text is still checked.
  }
  return out;
}

export interface EgressGuard {
  /** A human-readable reason when `text` must not leave the laptop, else null. */
  check(text: string): string | null;
  /** `text` with dotenv values and credential-shaped strings replaced by [redacted]. */
  redact(text: string): string;
}

export function createEgressGuard(cwd: string): EgressGuard {
  let cache: { key: string; secrets: Array<{ key: string; value: string; file: string }> } | undefined;

  function dotenvSecrets() {
    let names: string[];
    try {
      names = readdirSync(cwd).filter(name => DOTENV_FILE.test(name)).sort();
    } catch {
      names = [];
    }
    const stamps = names.map(name => {
      try {
        const fd = openSync(path.join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const st = fstatSync(fd);
          return `${name}:${st.size}:${st.mtimeMs}`;
        } finally {
          closeSync(fd);
        }
      } catch {
        return `${name}:x`;
      }
    });
    const key = stamps.join('|');
    if (cache?.key === key) return cache.secrets;
    const secrets = names.flatMap(name => {
      const text = readSmall(path.join(cwd, name));
      return text ? parseDotenvSecrets(text).map(s => ({ ...s, file: name })) : [];
    });
    cache = { key, secrets };
    return secrets;
  }

  return {
    check(text: string): string | null {
      const forms = variants(text);
      for (const form of forms) {
        for (const [label, pattern] of KEY_PATTERNS) {
          if (pattern.test(form)) return `contains what looks like ${label}`;
        }
      }
      for (const secret of dotenvSecrets()) {
        if (forms.some(form => form.includes(secret.value))) {
          return `contains the value of ${secret.key} from ${secret.file}`;
        }
      }
      return null;
    },
    redact(text: string): string {
      let out = text;
      for (const [, pattern] of KEY_PATTERNS) {
        out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]');
      }
      for (const secret of dotenvSecrets()) out = out.split(secret.value).join('[redacted]');
      return out;
    },
  };
}
