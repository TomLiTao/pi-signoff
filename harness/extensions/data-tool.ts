// pi_safe_data: read-only data previews and DuckDB SQL over workspace files, executed by
// data-tool.py inside the read-only sandbox (sandbox.py --data).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

export const dataToolName = 'pi_safe_data';

export interface DataToolOptions {
  /** Run data-tool.py in the sandbox with this JSON request on stdin; resolves to its stdout. */
  runSandbox: (request: object, cwd: string, signal?: AbortSignal) => Promise<string>;
  runRead?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function registerDataTool(pi: ExtensionAPI, options: DataToolOptions) {
  const runRead = options.runRead ?? (fn => fn());
  pi.registerTool({
    name: dataToolName,
    label: 'Data Preview & SQL',
    promptSnippet: 'Preview data files (schema, types, stats, first rows) and run read-only DuckDB SQL over them',
    promptGuidelines: [
      `Use ${dataToolName} preview before reading data files with cat/head: it handles CSV/TSV, JSON, JSONL (also .gz) and Parquet, and globs like data/**/*.json.gz.`,
      `Use ${dataToolName} query for counts, aggregates, joins, and filters over files (DuckDB SQL, read-only), e.g. SELECT date, count(*) FROM 'data/*.parquet' GROUP BY 1; read_csv / read_json / read_parquet take globs.`,
    ],
    description: 'Read-only data tool. preview: path (file or glob) and rows (1-50, default 10): format, size, row count, column types, nulls, numeric stats, first rows. query: one read-only DuckDB statement (SELECT / WITH / FROM / DESCRIBE / SUMMARIZE / SHOW / EXPLAIN) over workspace files, limit (1-500 rows, default 100). Runs in the read-only sandbox with no network.',
    parameters: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['preview', 'query'] },
        path: { type: 'string', minLength: 1, maxLength: 1024, description: 'Workspace-relative file or glob (preview).' },
        rows: { type: 'integer', minimum: 1, maximum: 50 },
        sql: { type: 'string', minLength: 1, maxLength: 20_000, description: 'One read-only DuckDB statement (query).' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    } as unknown as TSchema,
    executionMode: 'parallel',
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const p = raw as { action: string; path?: string; rows?: number; sql?: string; limit?: number };
      if (p.action === 'preview' && !p.path) throw new Error('Pass path (a data file or glob) for preview.');
      if (p.action === 'query' && !p.sql) throw new Error('Pass sql for query.');
      const request = p.action === 'preview'
        ? { action: 'preview', path: p.path, rows: p.rows ?? 10 }
        : { action: 'query', sql: p.sql, limit: p.limit ?? 100 };
      const stdout = await runRead(() => options.runSandbox(request, ctx.cwd, signal));
      let parsed: { text?: string; error?: string };
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(stdout.trim().slice(0, 500) || 'The data helper failed.');
      }
      if (parsed.error) throw new Error(parsed.error);
      return { content: [{ type: 'text', text: parsed.text ?? '' }], details: undefined };
    },
  });
}
