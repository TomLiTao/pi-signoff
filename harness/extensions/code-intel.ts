// Python code intelligence for protected Pi: a long-lived basedpyright language server inside a
// read-only Bubblewrap sandbox (sandbox.py --lsp), spoken to over stdio JSON-RPC from the host.
// pi_safe_code answers diagnostics / definition / references / hover / symbols / workspace symbols /
// rename previews, and Python edits get a short type-check note appended to their result.
// File contents are read on the host (never secret or denied paths) and sent with didOpen/didChange.
import type { ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { editDecision, type Policy } from './approvals.ts';

export const codeToolName = 'pi_safe_code';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IDLE_STOP_MS = 20 * 60_000;
const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];
const SYMBOL_KIND: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field',
  9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string',
  16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null', 22: 'enum member', 23: 'struct',
  24: 'event', 25: 'operator', 26: 'type parameter',
};

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
export interface Diagnostic { range: Range; severity?: number; message: string; rule?: string; code?: string | number; source?: string }
interface Location { uri: string; range: Range }

/** Minimal JSON-RPC (LSP base protocol) client over a child process's stdio. */
export class LspClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private diagnostics = new Map<string, { version?: number; items: Diagnostic[]; at: number }>();
  private waiters: Array<() => void> = [];
  exited = false;
  readonly startedAt = Date.now();
  private readonly child: ChildProcess;
  private readonly settings: (section?: string) => unknown;

  constructor(child: ChildProcess, settings: (section?: string) => unknown) {
    this.child = child;
    this.settings = settings;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.resume();
    child.once('exit', () => {
      this.exited = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('The Python language server stopped.'));
      }
      this.pending.clear();
      this.wake();
    });
    child.stdin?.on('error', () => {});
  }

  private send(message: object): void {
    if (this.exited) throw new Error('The Python language server is not running.');
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The Python language server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
      if (!Number.isFinite(length) || length > 64 * 1024 * 1024) {
        this.child.kill('SIGKILL');
        return;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      try {
        this.handle(JSON.parse(body));
      } catch {
        // Ignore a malformed message; the server keeps running.
      }
    }
  }

  private handle(msg: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message?: string } }): void {
    if (msg.method && msg.id !== undefined) {
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') {
        result = (msg.params?.items ?? []).map((item: { section?: string }) => this.settings(item.section));
      }
      this.send({ id: msg.id, result });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      this.diagnostics.set(msg.params.uri, { version: msg.params.version, items: msg.params.diagnostics ?? [], at: Date.now() });
      this.wake();
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'Language server error'));
      else entry.resolve(msg.result);
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Diagnostics for `uri` at `version` or later (or published after `since`), waiting up to `timeoutMs`. */
  async diagnosticsFor(uri: string, version: number, since: number, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const entry = this.diagnostics.get(uri);
      if (entry && ((entry.version !== undefined && entry.version >= version) || (entry.version === undefined && entry.at >= since))) {
        return entry.items;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.exited) return undefined;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(remaining, 500));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGTERM');
  }
}

export interface CodeIntelOptions {
  /** Start the language server (sandboxed in production) for the workspace root. */
  spawnServer: (root: string) => Promise<ChildProcess>;
  getPolicy: () => Policy | undefined;
  runRead?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Append a type-check note to successful pi_safe_edit / pi_safe_write results on .py files. */
  checkEdits?: boolean;
  editTools?: readonly string[];
}

function relative(root: string, file: string): string {
  const rel = path.relative(root, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const typeshed = file.indexOf('typeshed-fallback/');
  if (typeshed !== -1) return `typeshed: ${file.slice(typeshed + 'typeshed-fallback/'.length)}`;
  return file;
}

export function formatDiagnostics(rel: string, items: Diagnostic[], maxPerFile = 30): string[] {
  const sorted = [...items].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
  const lines = sorted.slice(0, maxPerFile).map(d => {
    const rule = d.rule ?? (d.code !== undefined ? String(d.code) : '');
    return `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? 'error'}: ${d.message.replace(/\s+/g, ' ').slice(0, 300)}${rule ? ` [${rule}]` : ''}`;
  });
  if (sorted.length > maxPerFile) lines.push(`… (+${sorted.length - maxPerFile} more in ${rel})`);
  return lines;
}

export function countBySeverity(items: Diagnostic[]): { errors: number; warnings: number } {
  return {
    errors: items.filter(d => (d.severity ?? 1) === 1).length,
    warnings: items.filter(d => d.severity === 2).length,
  };
}

/** 0-based column of `symbol` on a line (whole word preferred), or of the 1-based `column`. */
export function locateColumn(lineText: string, symbol?: string, column?: number): number | null {
  if (symbol) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).exec(lineText);
    if (word) return word.index;
    const loose = lineText.indexOf(symbol);
    return loose === -1 ? null : loose;
  }
  if (column !== undefined && column >= 1) return Math.min(column - 1, lineText.length);
  return null;
}

export function registerCodeIntel(pi: ExtensionAPI, options: CodeIntelOptions) {
  let client: LspClient | undefined;
  let starting: Promise<LspClient> | undefined;
  let clientRoot: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const docs = new Map<string, { version: number; text: string }>();
  const runRead = options.runRead ?? (fn => fn());

  function settingsFor(root: string) {
    let pythonPath = '/usr/bin/python3';
    for (const candidate of ['.venv/bin/python', 'venv/bin/python']) {
      try {
        if (statSync(path.join(root, candidate)).isFile()) {
          pythonPath = path.join(root, candidate);
          break;
        }
      } catch {
        // Not present.
      }
    }
    const analysis = { typeCheckingMode: 'standard', diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: false };
    const all: Record<string, unknown> = {
      python: { pythonPath, analysis },
      'python.analysis': analysis,
      basedpyright: { analysis },
      'basedpyright.analysis': analysis,
    };
    return (section?: string) => (section ? all[section] ?? {} : all);
  }

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_STOP_MS);
    idleTimer.unref?.();
  }

  function stop(): void {
    client?.kill();
    client = undefined;
    starting = undefined;
    docs.clear();
  }

  async function ensure(root: string): Promise<LspClient> {
    if (client && !client.exited && clientRoot === root) {
      touch();
      return client;
    }
    if (starting && clientRoot === root) return starting;
    stop();
    clientRoot = root;
    starting = (async () => {
      const child = await options.spawnServer(root);
      const lsp = new LspClient(child, settingsFor(root));
      const uri = pathToFileURL(root).href;
      await lsp.request('initialize', {
        processId: null,
        rootUri: uri,
        workspaceFolders: [{ uri, name: path.basename(root) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { versionSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: {}, references: {}, rename: { prepareSupport: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { configuration: true, workspaceFolders: true, symbol: {} },
        },
      }, 60_000);
      lsp.notify('initialized', {});
      lsp.notify('workspace/didChangeConfiguration', { settings: settingsFor(root)() });
      client = lsp;
      touch();
      return lsp;
    })();
    try {
      return await starting;
    } catch (error) {
      starting = undefined;
      throw error;
    }
  }

  /** Read a workspace Python file on the host and sync it to the server. */
  function sync(lsp: LspClient, root: string, rawPath: string): { uri: string; version: number; text: string; rel: string; sent: number } {
    const policy = options.getPolicy();
    const abs = path.resolve(root, rawPath);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new Error(`File not found: ${rawPath}`);
    }
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Only workspace files can be analyzed.');
    if (policy && editDecision(root, rel, policy) === 'deny') throw new Error('This path is protected.');
    if (!/\.pyi?$/.test(real)) throw new Error('pi_safe_code analyzes Python files (.py, .pyi).');
    if (statSync(real).size > MAX_FILE_BYTES) throw new Error('File is too large to analyze.');
    const text = readFileSync(real, 'utf8');
    const uri = pathToFileURL(real).href;
    const known = docs.get(uri);
    const sent = Date.now();
    if (!known) {
      docs.set(uri, { version: 1, text });
      lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text } });
      return { uri, version: 1, text, rel: rel.split(path.sep).join('/'), sent };
    }
    if (known.text !== text) {
      known.version += 1;
      known.text = text;
      lsp.notify('textDocument/didChange', { textDocument: { uri, version: known.version }, contentChanges: [{ text }] });
    }
    return { uri, version: known.version, text, rel: rel.split(path.sep).join('/'), sent };
  }

  function lineOf(file: string, line: number): string {
    try {
      const policy = options.getPolicy();
      if (clientRoot && policy) {
        const rel = path.relative(clientRoot, file);
        if (!rel.startsWith('..') && editDecision(clientRoot, rel, policy) === 'deny') return '';
      }
      return (readFileSync(file, 'utf8').split('\n')[line] ?? '').trim().slice(0, 160);
    } catch {
      return '';
    }
  }

  function formatLocations(root: string, locations: Location[], limit = 100): string[] {
    return locations.slice(0, limit).map(loc => {
      const file = fileURLToPath(loc.uri);
      const text = lineOf(file, loc.range.start.line);
      return `${relative(root, file)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}${text ? `  ${text}` : ''}`;
    });
  }

  function position(doc: { text: string }, line?: number, symbol?: string, column?: number): Position {
    if (!line || line < 1) throw new Error('Pass line (1-based) and symbol (the name on that line).');
    const lines = doc.text.split('\n');
    if (line > lines.length) throw new Error(`The file has ${lines.length} lines.`);
    const character = locateColumn(lines[line - 1], symbol, column);
    if (character === null) throw new Error(symbol ? `"${symbol}" does not appear on line ${line}.` : 'Pass symbol (preferred) or column.');
    return { line: line - 1, character };
  }

  async function diagnosticsText(root: string, paths: string[]): Promise<string> {
    const lsp = await ensure(root);
    const out: string[] = [];
    let errors = 0;
    let warnings = 0;
    for (const raw of paths.slice(0, 20)) {
      const doc = sync(lsp, root, raw);
      const items = await lsp.diagnosticsFor(doc.uri, doc.version, doc.sent, 30_000);
      if (!items) {
        out.push(`${doc.rel}: analysis did not finish in time; try again.`);
        continue;
      }
      const counts = countBySeverity(items);
      errors += counts.errors;
      warnings += counts.warnings;
      out.push(...(items.length ? formatDiagnostics(doc.rel, items) : [`${doc.rel}: no problems`]));
    }
    return `basedpyright: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} in ${Math.min(paths.length, 20)} file${paths.length === 1 ? '' : 's'}\n${out.join('\n')}`;
  }

  /**
   * Cross-file answers (references, workspace symbols, rename) are incomplete while a freshly started
   * server is still scanning the workspace: repeat until two answers agree (only in its first 30 s).
   */
  async function stable<T>(lsp: LspClient, ask: () => Promise<T>, size: (value: T) => number): Promise<T> {
    let value = await ask();
    if (Date.now() - lsp.startedAt > 30_000) return value;
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const next = await ask();
      if (size(next) === size(value)) return next;
      value = next;
    }
    return value;
  }

  function symbolTree(items: any[], depth = 0, out: string[] = []): string[] {
    for (const s of items) {
      if (out.length >= 300) break;
      const range = s.range ?? s.location?.range;
      out.push(`${'  '.repeat(depth)}${SYMBOL_KIND[s.kind] ?? 'symbol'} ${s.name}${s.detail ? ` ${String(s.detail).slice(0, 80)}` : ''} (L${(range?.start.line ?? 0) + 1}${range && range.end.line !== range.start.line ? `-${range.end.line + 1}` : ''})`);
      if (Array.isArray(s.children) && depth < 4) symbolTree(s.children, depth + 1, out);
    }
    return out;
  }

  pi.registerTool({
    name: codeToolName,
    label: 'Python Code Intelligence',
    promptSnippet: 'Python language server: type errors, definitions, references, hover types, symbols, rename previews',
    promptGuidelines: [
      `Use ${codeToolName} for Python instead of grep when you need where something is defined or used (definition, references), its type (hover), a file outline (symbols), or real errors (diagnostics). Positions are a 1-based line plus the symbol name on that line.`,
      `Python edits get a short basedpyright note appended; fix reported errors before running the code. rename returns a preview of every edit; apply them with the edit tool.`,
    ],
    description: 'Python code intelligence via a sandboxed basedpyright language server. Actions: diagnostics (paths: up to 20 files), definition / references / hover (path, line, symbol), symbols (path: file outline), workspace_symbols (query), rename (path, line, symbol, newName: returns a preview, applies nothing).',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['diagnostics', 'definition', 'references', 'hover', 'symbols', 'workspace_symbols', 'rename'] },
        path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Workspace-relative Python file.' },
        paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1024 }, maxItems: 20, description: 'Files for diagnostics.' },
        line: { type: 'integer', minimum: 1, description: '1-based line of the symbol.' },
        symbol: { type: 'string', minLength: 1, maxLength: 200, description: 'The identifier on that line.' },
        column: { type: 'integer', minimum: 1, description: '1-based column, only if symbol is ambiguous.' },
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Name to search for (workspace_symbols).' },
        newName: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      },
    } as unknown as TSchema,
    executionMode: 'parallel',
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      const p = raw as { action: string; path?: string; paths?: string[]; line?: number; symbol?: string; column?: number; query?: string; newName?: string };
      const root = realpathSync(ctx.cwd);
      const text = await runRead(async () => {
        if (p.action === 'diagnostics') {
          const paths = p.paths?.length ? p.paths : p.path ? [p.path] : [];
          if (!paths.length) throw new Error('Pass path or paths (Python files) for diagnostics.');
          return diagnosticsText(root, paths);
        }
        const lsp = await ensure(root);
        if (p.action === 'workspace_symbols') {
          if (!p.query) throw new Error('Pass query for workspace_symbols.');
          const found = await stable(lsp, async () => (await lsp.request<any[]>('workspace/symbol', { query: p.query }, 30_000)) ?? [], v => v.length);
          const rows = found.slice(0, 60).map(s => `${SYMBOL_KIND[s.kind] ?? 'symbol'} ${s.containerName ? `${s.containerName}.` : ''}${s.name}  ${formatLocations(root, [s.location])[0] ?? ''}`);
          return rows.length ? `${found.length} symbol${found.length === 1 ? '' : 's'} matching "${p.query}"${found.length > 60 ? ' (first 60)' : ''}:\n${rows.join('\n')}` : `No symbols match "${p.query}".`;
        }
        if (!p.path) throw new Error(`Pass path for ${p.action}.`);
        const doc = sync(lsp, root, p.path);
        if (p.action === 'symbols') {
          const items = (await lsp.request<any[]>('textDocument/documentSymbol', { textDocument: { uri: doc.uri } })) ?? [];
          return items.length ? `Outline of ${doc.rel}:\n${symbolTree(items).join('\n')}` : `No symbols in ${doc.rel}.`;
        }
        const pos = position(doc, p.line, p.symbol, p.column);
        const where = { textDocument: { uri: doc.uri }, position: pos };
        if (p.action === 'hover') {
          const hover = await lsp.request<any>('textDocument/hover', where);
          const contents = hover?.contents;
          const value = typeof contents === 'string' ? contents : Array.isArray(contents) ? contents.map((c: any) => c.value ?? c).join('\n') : contents?.value ?? '';
          return value ? `${doc.rel}:${p.line} ${p.symbol ?? ''}\n${String(value).trim().slice(0, 4000)}` : 'No type information here.';
        }
        if (p.action === 'definition') {
          const result = await lsp.request<any>('textDocument/definition', where);
          const locations: Location[] = (Array.isArray(result) ? result : result ? [result] : [])
            .map((l: any) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
          return locations.length ? `Definition of ${p.symbol ?? 'symbol'}:\n${formatLocations(root, locations).join('\n')}` : 'No definition found (dynamic attribute or unresolved import?).';
        }
        if (p.action === 'references') {
          const result = await stable(lsp, async () => (await lsp.request<Location[]>('textDocument/references', { ...where, context: { includeDeclaration: true } }, 60_000)) ?? [], v => v.length);
          return result.length ? `${result.length} reference${result.length === 1 ? '' : 's'} to ${p.symbol ?? 'symbol'}${result.length > 100 ? ' (first 100)' : ''}:\n${formatLocations(root, result).join('\n')}` : 'No references found.';
        }
        if (p.action === 'rename') {
          if (!p.newName) throw new Error('Pass newName for rename.');
          const edit = await stable(lsp, () => lsp.request<any>('textDocument/rename', { ...where, newName: p.newName }, 60_000),
            v => Object.values(v?.changes ?? {}).reduce((n: number, e: any) => n + e.length, 0) + (v?.documentChanges ?? []).reduce((n: number, d: any) => n + (d.edits?.length ?? 0), 0));
          const changes: Record<string, Array<{ range: Range; newText: string }>> = { ...(edit?.changes ?? {}) };
          for (const dc of edit?.documentChanges ?? []) if (dc.textDocument?.uri) changes[dc.textDocument.uri] = dc.edits ?? [];
          const files = Object.keys(changes);
          if (!files.length) return 'Nothing to rename here.';
          const out = [`Rename preview: ${p.symbol} → ${p.newName} (${files.reduce((n, f) => n + changes[f].length, 0)} edits in ${files.length} files). Nothing was changed; apply with the edit tool:`];
          for (const uri of files.slice(0, 40)) {
            const file = fileURLToPath(uri);
            const fileLines = (() => { try { return readFileSync(file, 'utf8').split('\n'); } catch { return []; } })();
            out.push(`${relative(root, file)}:`);
            const byLine = new Map<number, Array<{ range: Range; newText: string }>>();
            for (const e of changes[uri]) byLine.set(e.range.start.line, [...(byLine.get(e.range.start.line) ?? []), e]);
            for (const [line, edits] of [...byLine].sort((a, b) => a[0] - b[0]).slice(0, 60)) {
              const before = fileLines[line] ?? '';
              let after = before;
              for (const e of [...edits].sort((a, b) => b.range.start.character - a.range.start.character)) {
                if (e.range.end.line === line) after = after.slice(0, e.range.start.character) + e.newText + after.slice(e.range.end.character);
              }
              out.push(`  L${line + 1}: ${before.trim()}  →  ${after.trim()}`);
            }
          }
          return out.join('\n');
        }
        throw new Error(`Unknown action ${p.action}.`);
      });
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  if (options.checkEdits !== false) {
    const editTools = new Set(options.editTools ?? ['pi_safe_edit', 'pi_safe_write']);
    pi.on('tool_result', async (event, ctx) => {
      const name = (event as { toolName?: string }).toolName ?? '';
      const file = (event.input as { path?: unknown })?.path;
      if (!editTools.has(name) || event.isError || typeof file !== 'string' || !/\.pyi?$/.test(file)) return;
      try {
        const root = realpathSync(ctx.cwd);
        // A cold server keeps starting in the background; this edit just goes without a note.
        const pending = ensure(root);
        pending.catch(() => undefined);
        const lsp = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3_000))]);
        if (!lsp) return;
        const doc = sync(lsp, root, file);
        const items = await lsp.diagnosticsFor(doc.uri, doc.version, doc.sent, 8_000);
        if (!items) return;
        const { errors, warnings } = countBySeverity(items);
        const lines = errors
          ? [`basedpyright: ${errors} error${errors === 1 ? '' : 's'} in ${doc.rel}${warnings ? ` (+${warnings} warning${warnings === 1 ? '' : 's'})` : ''}:`,
            ...formatDiagnostics(doc.rel, items.filter(d => (d.severity ?? 1) === 1), 8)]
          : [`basedpyright: no errors in ${doc.rel}${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'}; ${codeToolName} diagnostics to list them)` : ''}.`];
        return { content: [...event.content, { type: 'text', text: `\n${lines.join('\n')}` }] };
      } catch {
        return undefined;
      }
    });
  }

  // Warm the server as soon as the agent touches a Python file, so edit notes are ready.
  pi.on('tool_execution_start', async (event, ctx) => {
    if (options.checkEdits === false) return;
    const file = (event.args as { path?: unknown } | undefined)?.path;
    if (typeof file !== 'string' || !/\.pyi?$/.test(file) || !/(?:_read|_edit|_write)$/.test(event.toolName)) return;
    try {
      ensure(realpathSync(ctx.cwd)).catch(() => undefined);
    } catch {
      // Not a real directory; nothing to warm.
    }
  });

  pi.on('session_shutdown', async () => stop());

  return { stop, isRunning: () => Boolean(client && !client.exited) };
}
