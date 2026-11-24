#!/usr/bin/python3
"""Read-only data preview and SQL worker for pi_safe_data. Runs only inside the read-only sandbox
(sandbox.py --data): the workspace is mounted read-only, secrets are masked, and there is no network.

preview: schema, inferred column types, null counts, numeric stats, and the first rows of CSV/TSV,
JSON, JSONL/NDJSON (optionally .gz) and Parquet files, or a summary of a glob of files.
query:   one read-only DuckDB statement (SELECT / WITH / FROM / DESCRIBE / SUMMARIZE / SHOW / EXPLAIN)
         over workspace files, e.g. SELECT symbol, avg(ret) FROM 'data/*.parquet' GROUP BY 1."""
import csv
import glob
import gzip
import io
import json
import math
import os
import re
import sys
import threading

sys.path.insert(0, '/opt/pi-data')

MAX_SCAN = 64 * 1024 * 1024
SAMPLE_ROWS = 10_000
MAX_OUT = 60_000
MAX_COLS = 14
CELL = 40
FORMATS = {'.csv': 'csv', '.tsv': 'tsv', '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl', '.parquet': 'parquet'}
NULLS = {'', 'na', 'n/a', 'nan', 'null', 'none', '-'}
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$')


def fail(message):
    raise ValueError(message)


def workspace_path(raw):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 1024 or '\0' in raw:
        fail('path must be a workspace-relative file or glob')
    root = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(root, raw.strip()))
    if full != root and not full.startswith(root + os.sep):
        fail('path must stay inside the workspace')
    return root, full


def fmt_of(path):
    name = path.lower()
    if name.endswith('.gz'):
        name = name[:-3]
    for suffix, kind in FORMATS.items():
        if name.endswith(suffix):
            return kind
    return None


def opener(path):
    return gzip.open(path, 'rb') if path.lower().endswith('.gz') else open(path, 'rb')


def size_text(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f} {unit}' if unit == 'B' else f'{n:.1f} {unit}'
        n /= 1024
    return f'{n} B'


def cell(value):
    if value is None:
        text = ''
    elif isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, default=str)
    else:
        text = str(value)
    text = ' '.join(text.split()).replace('|', '\\|')
    return text if len(text) <= CELL else text[:CELL - 1] + '…'


def table(columns, rows):
    shown = columns[:MAX_COLS]
    out = ['| ' + ' | '.join(cell(c) for c in shown) + ' |', '|' + '---|' * len(shown)]
    for row in rows:
        out.append('| ' + ' | '.join(cell(row[i] if i < len(row) else None) for i in range(len(shown))) + ' |')
    if len(columns) > MAX_COLS:
        out.append(f'(+{len(columns) - MAX_COLS} more columns: {", ".join(columns[MAX_COLS:MAX_COLS + 20])}{"…" if len(columns) > MAX_COLS + 20 else ""})')
    return '\n'.join(out)


def infer(values):
    """Column type over sampled values: int, float, bool, date, string, mixed; plus stats."""
    kinds, nums, nulls, examples = set(), [], 0, []
    for value in values:
        if value is None or (isinstance(value, str) and value.strip().lower() in NULLS) or (isinstance(value, float) and math.isnan(value)):
            nulls += 1
            continue
        if isinstance(value, bool):
            kinds.add('bool')
            continue
        if isinstance(value, (int, float)):
            kinds.add('int' if isinstance(value, int) else 'float')
            nums.append(float(value))
            continue
        if isinstance(value, (dict, list)):
            kinds.add('object' if isinstance(value, dict) else 'list')
            continue
        text = str(value).strip()
        if len(examples) < 3 and text not in examples:
            examples.append(text[:30])
        if text.lower() in ('true', 'false'):
            kinds.add('bool')
            continue
        try:
            number = float(text.replace(',', '')) if re.fullmatch(r'[-+]?[\d,]*\.?\d+(?:[eE][-+]?\d+)?', text) else None
        except ValueError:
            number = None
        if number is not None:
            kinds.add('int' if re.fullmatch(r'[-+]?\d[\d,]*', text) else 'float')
            nums.append(number)
        elif DATE.match(text):
            kinds.add('date')
        else:
            kinds.add('string')
    if kinds <= {'int', 'float'} and kinds:
        kind = 'float' if 'float' in kinds else 'int'
    elif len(kinds) == 1:
        kind = kinds.pop()
    elif not kinds:
        kind = 'empty'
    else:
        kind = 'mixed(' + '/'.join(sorted(kinds)) + ')'
    stats = ''
    if nums:
        stats = f'min {min(nums):.6g}, max {max(nums):.6g}, mean {sum(nums) / len(nums):.6g}'
    elif examples:
        stats = 'e.g. ' + ', '.join(examples)
    return kind, nulls, stats


def schema_lines(columns, rows):
    lines = []
    for i, name in enumerate(columns[:60]):
        kind, nulls, stats = infer([row[i] if i < len(row) else None for row in rows])
        null_text = f', {nulls} null' if nulls else ''
        lines.append(f'- {name}: {kind}{null_text}{f" · {stats}" if stats else ""}')
    if len(columns) > 60:
        lines.append(f'- … (+{len(columns) - 60} more columns)')
    return lines


def preview_csv(path, kind, n):
    delimiter = '\t' if kind == 'tsv' else ','
    if kind == 'csv':
        with opener(path) as raw:
            head = raw.read(65536).decode('utf-8', errors='replace')
        try:
            delimiter = csv.Sniffer().sniff(head, delimiters=',;|\t').delimiter
        except csv.Error:
            pass
    rows, total, scanned, complete = [], 0, 0, True
    with opener(path) as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding='utf-8', errors='replace', newline=''), delimiter=delimiter)
        header = next(reader, None) or []
        for row in reader:
            total += 1
            if len(rows) < SAMPLE_ROWS:
                rows.append(row)
            scanned += sum(len(c) for c in row) + len(row)
            if scanned > MAX_SCAN:
                complete = False
                break
    columns = [h.strip() or f'col{i + 1}' for i, h in enumerate(header)]
    count = f'{total:,} rows' if complete else f'at least {total:,} rows (stopped counting after {size_text(MAX_SCAN)} of text)'
    return columns, rows, count, f'delimiter {delimiter!r}'


def flatten_records(records):
    columns = []
    for rec in records:
        for key in rec:
            if key not in columns:
                columns.append(key)
            if len(columns) >= 200:
                break
    return columns, [[rec.get(c) for c in columns] for rec in records]


def describe(value, depth=0, max_depth=3):
    pad = '  ' * depth
    if isinstance(value, dict):
        lines = [f'{pad}object with {len(value)} keys']
        if depth < max_depth:
            for key in list(value)[:25]:
                sub = describe(value[key], depth + 1, max_depth)
                lines.append(f'{pad}- {key}: {sub[0].strip()}')
                lines.extend(sub[1:])
            if len(value) > 25:
                lines.append(f'{pad}- … (+{len(value) - 25} more keys)')
        return lines
    if isinstance(value, list):
        inner = describe(value[0], depth + 1, max_depth) if value else []
        return [f'{pad}list of {len(value)}{f" × {inner[0].strip()}" if inner else ""}', *inner[1:]]
    return [f'{pad}{type(value).__name__}' + (f' ({cell(value)})' if isinstance(value, str) else '')]


def preview_json(path, kind, n):
    if kind == 'jsonl':
        records, total, scanned, bad = [], 0, 0, 0
        with opener(path) as raw:
            for line in raw:
                scanned += len(line)
                if scanned > MAX_SCAN:
                    break
                line = line.strip()
                if not line:
                    continue
                total += 1
                if len(records) < SAMPLE_ROWS:
                    try:
                        value = json.loads(line)
                        records.append(value if isinstance(value, dict) else {'value': value})
                    except ValueError:
                        bad += 1
        columns, rows = flatten_records(records)
        note = f'{bad} unparsable line(s) in the sample' if bad else ''
        count = f'{total:,} records' + ('' if scanned <= MAX_SCAN else f' (stopped after {size_text(MAX_SCAN)})')
        return columns, rows, count, note, None
    with opener(path) as raw:
        data = raw.read(MAX_SCAN + 1)
    if len(data) > MAX_SCAN:
        fail(f'JSON file is larger than {size_text(MAX_SCAN)} decompressed; query it with action "query" (DuckDB read_json).')
    value = json.loads(data.decode('utf-8', errors='replace'))
    structure = describe(value)
    records, where = None, ''
    if isinstance(value, list) and value and all(isinstance(v, dict) for v in value[:100]):
        records = value
    elif isinstance(value, dict):
        for key, inner in value.items():
            if isinstance(inner, list) and inner and all(isinstance(v, dict) for v in inner[:100]):
                records, where = inner, f' (records under key "{key}")'
                break
    if records is None:
        return None, None, None, '', structure
    columns, rows = flatten_records(records[:SAMPLE_ROWS])
    return columns, rows, f'{len(records):,} records{where}', '', structure


def duckdb_connection():
    try:
        import duckdb  # noqa: PLC0415 - optional runtime mounted at /opt/pi-data
    except ImportError:
        fail('DuckDB is not installed for pi (run ./install.sh --pi-only); Parquet and SQL need it.')
    con = duckdb.connect(':memory:', config={
        'autoinstall_known_extensions': False, 'autoload_known_extensions': False,
        'threads': 4, 'memory_limit': '2GB',
    })
    return con


def preview_parquet(path, n):
    con = duckdb_connection()
    described = con.execute('DESCRIBE SELECT * FROM read_parquet(?)', [path]).fetchall()
    total = con.execute('SELECT count(*) FROM read_parquet(?)', [path]).fetchone()[0]
    cur = con.execute(f'SELECT * FROM read_parquet(?) LIMIT {int(n)}', [path])
    columns = [d[0] for d in cur.description]
    rows = cur.fetchall()
    schema = [f'- {name}: {kind}{"" if nullable == "YES" else " (not null)"}' for name, kind, nullable, *_ in described[:60]]
    return columns, rows, f'{total:,} rows', schema


def preview(raw_path, n):
    root, full = workspace_path(raw_path)
    rel = os.path.relpath(full, root)
    if any(ch in raw_path for ch in '*?['):
        matches = sorted(p for p in glob.glob(os.path.join(root, raw_path.strip()), recursive=True) if os.path.isfile(p))[:10000]
        if not matches:
            fail(f'No files match {raw_path}.')
        total = sum(os.path.getsize(p) for p in matches)
        kinds = sorted({fmt_of(p) or 'other' for p in matches})
        head = [f'{len(matches):,} files match {raw_path} ({size_text(total)}; formats: {", ".join(kinds)}).',
                'First files: ' + ', '.join(os.path.relpath(p, root) for p in matches[:8]) + (' …' if len(matches) > 8 else ''),
                f'Query them all at once with action "query", e.g. SELECT count(*) FROM \'{raw_path.strip()}\'.', '']
        return '\n'.join(head) + preview(os.path.relpath(matches[0], root), n)
    if not os.path.isfile(full):
        fail(f'{rel} is not a file.')
    kind = fmt_of(full)
    if kind is None:
        fail('Supported formats: .csv, .tsv, .json, .jsonl/.ndjson (optionally .gz), and .parquet.')
    size = os.path.getsize(full)
    lines = [f'{rel} · {kind.upper()}{" (gzip)" if full.lower().endswith(".gz") else ""} · {size_text(size)}']
    if kind in ('csv', 'tsv'):
        columns, rows, count, note = preview_csv(full, kind, n)
        lines[0] += f' · {count} · {len(columns)} columns · {note}'
        lines += ['', f'Columns (types from the first {min(len(rows), SAMPLE_ROWS):,} rows):', *schema_lines(columns, rows)]
        lines += ['', f'First {min(n, len(rows))} rows:', table(columns, rows[:n])]
    elif kind in ('json', 'jsonl'):
        columns, rows, count, note, structure = preview_json(full, kind, n)
        if columns is None:
            lines += ['', 'Structure (not a list of records):', *structure[:80]]
        else:
            lines[0] += f' · {count} · {len(columns)} fields{f" · {note}" if note else ""}'
            lines += ['', f'Fields (types from the first {min(len(rows), SAMPLE_ROWS):,} records):', *schema_lines(columns, rows)]
            lines += ['', f'First {min(n, len(rows))} records:', table(columns, rows[:n])]
    else:
        columns, rows, count, schema = preview_parquet(full, n)
        lines[0] += f' · {count} · {len(columns)} columns'
        lines += ['', 'Schema:', *schema, '', f'First {len(rows)} rows:', table(columns, rows)]
    return '\n'.join(lines)


READ_ONLY_START = re.compile(r'^\s*(?:select|with|from|describe|summarize|show|explain|values|table)\b', re.I)
FORBIDDEN = re.compile(r'\b(?:copy|attach|detach|install|load|export|import|create|insert|update|delete|drop|alter|'
                       r'pragma|call|set|reset|checkpoint|vacuum|use|begin|commit|rollback)\b', re.I)


def strip_sql(sql):
    no_comments = re.sub(r'--[^\n]*|/\*.*?\*/', ' ', sql, flags=re.S)
    return re.sub(r"'(?:[^']|'')*'", "''", no_comments)


def query(sql, limit):
    if not isinstance(sql, str) or not sql.strip() or len(sql) > 20_000:
        fail('sql must be one read-only statement (up to 20,000 characters).')
    body = sql.strip().rstrip(';').strip()
    bare = strip_sql(body)
    if ';' in bare:
        fail('Run one statement at a time.')
    if not READ_ONLY_START.match(bare):
        fail('Only read-only statements are allowed: SELECT, WITH, FROM, DESCRIBE, SUMMARIZE, SHOW, EXPLAIN, VALUES.')
    word = FORBIDDEN.search(bare)
    if word:
        fail(f'"{word.group(0).upper()}" is not allowed here; this tool only reads data.')
    con = duckdb_connection()
    timer = threading.Timer(60, con.interrupt)
    timer.start()
    try:
        cur = con.execute(body)
        columns = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchmany(limit + 1)
    except Exception as error:  # noqa: BLE001 - surface DuckDB's message
        message = str(error).split('\n')[0][:500]
        fail(f'DuckDB error: {message}' if 'INTERRUPT' not in message.upper() else 'Query stopped after 60 seconds.')
    finally:
        timer.cancel()
    more = len(rows) > limit
    rows = rows[:limit]
    head = f'{len(rows)} row{"" if len(rows) == 1 else "s"}{" (more available; raise limit or aggregate)" if more else ""} · {len(columns)} columns'
    return head + '\n\n' + (table(columns, rows) if columns else '(no columns)')


def main():
    payload = json.loads(sys.stdin.read(65536))
    action = payload.get('action')
    if action == 'preview':
        rows = payload.get('rows', 10)
        if type(rows) is not int or not 1 <= rows <= 50:
            fail('rows must be between 1 and 50.')
        text = preview(payload.get('path'), rows)
    elif action == 'query':
        limit = payload.get('limit', 100)
        if type(limit) is not int or not 1 <= limit <= 500:
            fail('limit must be between 1 and 500.')
        text = query(payload.get('sql'), limit)
    else:
        fail('action must be "preview" or "query".')
    if len(text) > MAX_OUT:
        text = text[:MAX_OUT] + '\n[output truncated]'
    print(json.dumps({'text': text}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError, UnicodeError, csv.Error) as error:
        print(json.dumps({'error': str(error)[:800]}))
