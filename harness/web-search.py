#!/usr/bin/python3
"""DuckDuckGo search worker and isolated launcher for the two web tools."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import fcntl
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
import re
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import ssl


HOST = 'html.duckduckgo.com'
MAX_HTML = 512 * 1024
BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'
MWMBL_URL = 'https://api.mwmbl.org/api/v1/search/'
SANDBOX_KEY = '/brave-search.key'
# Brave Search currently includes $5/month at $5 per 1,000 requests. A rolling
# 32-day window is conservative across calendar months and billing time zones.
BRAVE_MAX_REQUESTS = 1000
BRAVE_WINDOW_SECONDS = 32 * 24 * 60 * 60
BRAVE_USAGE = 'brave-search-usage.json'
BRAVE_LOCK = 'brave-search-usage.lock'


class BudgetExhausted(ValueError):
    pass


def retryable_http(status):
    return status in (408, 500, 502, 503, 504)


class UpstreamFailure(ValueError):
    def __init__(self, status):
        super().__init__(f'DuckDuckGo did not return search results (HTTP {status}).')
        self.retryable = retryable_http(status)


def should_back_off(status, headers):
    return status in (202, 403, 429) or (status == 503 and bool(headers.get('Retry-After')))


class Throttled(ValueError):
    def __init__(self, status, headers, provider='DuckDuckGo'):
        super().__init__(f'{provider} asked Pi to back off (HTTP {status}).')
        value = (headers.get('Retry-After') or '').strip()
        self.retry_seconds = 60 if provider == 'DuckDuckGo' else 300
        try:
            delay = int(value) if value.isascii() and value.isdecimal() else (
                parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
            self.retry_seconds = max(1, min(86_400, int(delay + 0.999)))
        except (ValueError, OverflowError, TypeError):
            pass


def result_url(href):
    if href.startswith('//'):
        href = 'https:' + href
    parsed = urlsplit(href)
    if parsed.path == '/l/' and parsed.netloc in ('', 'duckduckgo.com', HOST):
        href = parse_qs(parsed.query).get('uddg', [''])[0]
        parsed = urlsplit(href)
    if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username is not None
            or len(href) > 2048 or any(c.isspace() or ord(c) < 32 for c in href)):
        return ''
    return href


class Results(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []
        self.seen = set()
        self.capture = None
        self.href = ''
        self.text = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get('class') or '').split()
        if tag == 'span' and 'result__timestamp' in classes and self.items:
            self.capture = 'date'
            self.text = []
            return
        if tag != 'a':
            return
        if 'result__a' in classes:
            try:
                self.href = result_url(attrs.get('href') or '')
            except ValueError:
                self.href = ''
            self.capture = 'title'
        elif 'result__snippet' in classes and self.href and self.items and self.items[-1]['url'] == self.href:
            self.capture = 'snippet'
        else:
            return
        self.text = []

    def handle_data(self, text):
        if self.capture:
            self.text.append(text)

    def handle_endtag(self, tag):
        if not self.capture or (tag != 'a' and not (tag == 'span' and self.capture == 'date')):
            return
        text = ' '.join(''.join(self.text).split())
        if self.capture == 'date':
            if text:
                self.items[-1]['date'] = text[:40]
            self.capture = None
            return
        if self.capture == 'title' and text and self.href and self.href not in self.seen:
            self.items.append({'title': text[:300], 'url': self.href, 'snippet': ''})
            self.seen.add(self.href)
        elif self.capture == 'snippet':
            self.items[-1]['snippet'] = text[:500]
        self.capture = None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


SITE = re.compile(r'^(?=.{4,200}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:/[A-Za-z0-9._~/-]*)?$')
TIME_DDG = {'day': 'd', 'week': 'w', 'month': 'm', 'year': 'y'}
TIME_BRAVE = {'day': 'pd', 'week': 'pw', 'month': 'pm', 'year': 'py'}
TRACKING = re.compile(r'^(?:utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref|ref_src)$', re.I)


def validate(query, limit, opts=None):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 300:
        raise ValueError('Search query must contain 1 to 300 characters.')
    if type(limit) is not int or not 1 <= limit <= 8:
        raise ValueError('Search result limit must be between 1 and 8.')
    opts = opts or {}
    site, time_range = opts.get('site'), opts.get('time')
    if site is not None and (not isinstance(site, str) or not SITE.match(site.lower())):
        raise ValueError('site must be a domain such as docs.python.org (optionally with a path).')
    if time_range is not None and time_range not in TIME_DDG:
        raise ValueError('time must be day, week, month, or year.')
    q = query.strip()
    if site:
        q = f'{q} site:{site.lower()}'
    return q


def dedupe_key(url):
    """Same page regardless of fragment, tracking parameters, or a trailing slash."""
    parts = urlsplit(url)
    query = '&'.join(p for p in parts.query.split('&') if p and not TRACKING.match(p.split('=', 1)[0]))
    return urlunsplit((parts.scheme.lower(), (parts.hostname or '').lower(), parts.path.rstrip('/') or '/', query, ''))


def matches_site(url, site):
    """Host equals the domain or is a subdomain of it, and the path starts with the site's path."""
    domain, _, prefix = site.lower().partition('/')
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    if host != domain and not host.endswith('.' + domain):
        return False
    return not prefix or parts.path.lstrip('/').startswith(prefix.rstrip('/'))


def unique(results, limit, site=None):
    seen, out = set(), []
    for row in results:
        if site and not matches_site(row['url'], site):
            continue
        key = dedupe_key(row['url'])
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
        if len(out) == limit:
            break
    return out


def search(query, limit, opts=None):
    params = {'q': validate(query, limit, opts), 'kp': '-1'}
    if (opts or {}).get('time'):
        params['df'] = TIME_DDG[opts['time']]
    url = f'https://{HOST}/html/?' + urlencode(params)
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
            if should_back_off(response.status, response.headers):
                raise Throttled(response.status, response.headers)
            if response.status != 200:
                raise UpstreamFailure(response.status)
            html = response.read(MAX_HTML)
            if b'anomaly-modal' in html:
                raise Throttled(response.status, response.headers)
    except HTTPError as error:
        if should_back_off(error.code, error.headers):
            with error:
                raise Throttled(error.code, error.headers) from None
        raise
    results = Results()
    results.feed(html.decode('utf-8', errors='replace'))
    results.close()
    return unique(results.items, limit, (opts or {}).get('site'))


def mwmbl_text(parts, limit):
    if not isinstance(parts, list):
        return ''
    text = ''.join(part['value'] for part in parts
                   if isinstance(part, dict) and isinstance(part.get('value'), str))
    return ' '.join(text.split())[:limit]


def mwmbl_search(query, limit, opts=None):
    # Mwmbl has no site: operator: send the plain query, then keep only results from the site.
    validate(query, limit, opts)
    url = MWMBL_URL + '?' + urlencode({'s': query.strip()})
    request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'pi-protected-search/1.0'})
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=6) as response:
            if should_back_off(response.status, response.headers):
                raise Throttled(response.status, response.headers, 'Mwmbl')
            if response.status != 200:
                raise ValueError('Unexpected Mwmbl response')
            data = response.read(MAX_HTML + 1)
    except HTTPError as error:
        if should_back_off(error.code, error.headers):
            with error:
                raise Throttled(error.code, error.headers, 'Mwmbl') from None
        raise
    if len(data) > MAX_HTML:
        raise ValueError('Mwmbl response exceeded the size limit')
    items = json.loads(data)
    if not isinstance(items, list):
        raise ValueError('Invalid Mwmbl response')
    results = []
    seen = set()
    for row in items:
        if not isinstance(row, dict) or not isinstance(row.get('url'), str):
            continue
        try:
            link = result_url(row['url'])
        except ValueError:
            continue
        title = mwmbl_text(row.get('title'), 300)
        if not link or link in seen or not title:
            continue
        seen.add(link)
        results.append({'url': link, 'title': title, 'snippet': mwmbl_text(row.get('extract'), 500)})
    return unique(results, limit, (opts or {}).get('site'))


def brave_search(query, limit, opts=None):
    params = {'q': validate(query, limit, opts), 'count': limit, 'safesearch': 'moderate'}
    if (opts or {}).get('time'):
        params['freshness'] = TIME_BRAVE[opts['time']]
    url = BRAVE_URL + '?' + urlencode(params)
    key = Path(SANDBOX_KEY).read_text(encoding='ascii').strip()
    request = Request(url, headers={'Accept': 'application/json', 'X-Subscription-Token': key})
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
        data = response.read(MAX_HTML + 1)
    if len(data) > MAX_HTML:
        raise ValueError('Brave response exceeded the size limit.')
    try:
        items = json.loads(data).get('web', {}).get('results', [])
        results = []
        for row in items:
            url = result_url(row['url'])
            title = row['title'][:300]
            snippet = row.get('description', '')[:500]
            if url and isinstance(title, str) and isinstance(snippet, str):
                row_out = {'url': url, 'title': title, 'snippet': snippet}
                date = row.get('page_age') or row.get('age')
                if isinstance(date, str) and date:
                    row_out['date'] = date[:40]
                results.append(row_out)
        return unique(results, limit, (opts or {}).get('site'))
    except (ValueError, AttributeError, KeyError, TypeError):
        raise ValueError('Brave returned an invalid search response.') from None


def open_private_dir():
    fd = os.open(Path.home() / '.config/pi-protected', os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Insecure Brave configuration directory')
        return fd
    except (ValueError, OSError):
        os.close(fd)
        raise


def private_regular(info):
    return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0)


def reserve_brave_request():
    dir_fd = open_private_dir()
    try:
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            lock_fd = os.open(BRAVE_LOCK, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
            first_run = True
        except FileExistsError:
            lock_fd = os.open(BRAVE_LOCK, flags, dir_fd=dir_fd)
            first_run = False
        try:
            if not private_regular(os.fstat(lock_fd)):
                raise ValueError('Invalid Brave budget lock')
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            _reserve_locked(dir_fd, int(time.time()), first_run)
        finally:
            os.close(lock_fd)
    finally:
        os.close(dir_fd)


def _reserve_locked(dir_fd, now, first_run):
    limit = 32 * 1024
    try:
        fd = os.open(BRAVE_USAGE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        if not first_run:
            raise
        attempts = []
    else:
        with os.fdopen(fd, 'rb') as ledger:
            info = os.fstat(ledger.fileno())
            if not private_regular(info) or info.st_size > limit:
                raise ValueError('Invalid Brave budget file')
            data = ledger.read(limit + 1)
        if len(data) != info.st_size:
            raise ValueError('Brave budget changed while reading')
        attempts = json.loads(data)
        if (not isinstance(attempts, list) or len(attempts) > BRAVE_MAX_REQUESTS
                or any(type(stamp) is not int or not 0 < stamp <= now for stamp in attempts)
                or attempts != sorted(attempts)):
            raise ValueError('Invalid Brave budget history or system clock')
    if now <= 0:
        raise ValueError('Invalid system clock')
    attempts = [stamp for stamp in attempts if now - stamp <= BRAVE_WINDOW_SECONDS]
    if len(attempts) >= BRAVE_MAX_REQUESTS:
        raise BudgetExhausted('Brave free-usage cap reached. No Brave request was sent.')
    attempts.append(now)
    temp = f'.brave-budget-{secrets.token_hex(12)}'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
    try:
        with os.fdopen(fd, 'w', encoding='ascii') as ledger:
            json.dump(attempts, ledger, separators=(',', ':'))
            ledger.flush()
            os.fsync(ledger.fileno())
        os.replace(temp, BRAVE_USAGE, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.fsync(dir_fd)
    finally:
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass


def open_brave_key():
    dir_fd = open_private_dir()
    try:
        fd = os.open('brave-search.key', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    finally:
        os.close(dir_fd)
    with os.fdopen(fd, 'rb') as key:
        info = os.fstat(key.fileno())
        if not private_regular(info) or not 0 < info.st_size <= 512:
            raise ValueError('Insecure key file')
        data = key.read(513).rstrip(b'\n')
        if not data or len(data) > 512 or any(not 33 <= char <= 126 for char in data):
            raise ValueError('Invalid key')
    # Forward only the verified bytes, not a file path or a mount of the host directory.
    fd = os.memfd_create('pi-search-key', flags=0)
    try:
        if os.write(fd, data) != len(data):
            raise OSError('Could not stage key')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except OSError:
        os.close(fd)
        raise


def main():
    modes = {
        '--worker': ('DuckDuckGo', search),
        '--mwmbl-worker': ('Mwmbl', mwmbl_search),
        '--brave-worker': ('Brave', brave_search),
    }
    if len(sys.argv) == 2 and sys.argv[1] in modes:
        provider, lookup = modes[sys.argv[1]]
        ddg = provider == 'DuckDuckGo'
        try:
            payload = json.loads(sys.stdin.buffer.read(4096))
            opts = {k: payload[k] for k in ('site', 'time') if payload.get(k) is not None}
            print(json.dumps({'results': lookup(payload['query'], payload['limit'], opts)}))
        except Throttled as error:
            print(json.dumps({'error': str(error), 'retry_seconds': error.retry_seconds}))
        except UpstreamFailure as error:
            print(json.dumps({'error': str(error), 'upstream_failure': ddg, 'retryable': ddg and error.retryable}))
        except HTTPError as error:
            with error:
                print(json.dumps({'error': f'{provider} search failed (HTTP {error.code}).',
                                  'upstream_failure': ddg, 'retryable': ddg and retryable_http(error.code)}))
        except (URLError, TimeoutError, ConnectionError, ssl.SSLError) as error:
            reason = error.reason if isinstance(error, URLError) else error
            print(json.dumps({'error': f'Could not connect to {provider}.', 'upstream_failure': ddg,
                              'retryable': ddg and not isinstance(reason, ssl.SSLCertVerificationError)}))
        except (ValueError, KeyError, TypeError, OSError, RecursionError):
            print(json.dumps({'error': f'{provider} search request or response was invalid.'}))
        return
    if sys.argv[1:] not in ([], ['--fetch'], ['--mwmbl'], ['--brave']):
        sys.exit('Unexpected arguments')
    fetching = sys.argv[1:] == ['--fetch']
    brave = sys.argv[1:] == ['--brave']
    mwmbl = sys.argv[1:] == ['--mwmbl']
    worker = 'web-fetch.py' if fetching else 'web-search.py'
    worker_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), worker)

    # Only the selected worker is mounted. No workspace, home, host processes, or runtime sockets.
    args = ['/usr/bin/bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--share-net',
            '--die-with-parent', '--new-session', '--clearenv', '--chdir', '/',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib',
            '--symlink', 'usr/lib64', '/lib64', '--dev', '/dev',
            '--ro-bind', worker_path, '/' + worker]
    for path in ('/etc/ssl/certs', '/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/hosts', '/etc/ld.so.cache'):
        args += ['--ro-bind-try', path, path]
    if brave:
        try:
            fd = open_brave_key()
        except (OSError, ValueError):
            print(json.dumps({'error': 'Brave key unavailable or not private. Run bash bin/setup-brave-search-key in your normal terminal.'}))
            return
        # Charge every attempt before it can reach Brave, even if the worker later fails.
        try:
            reserve_brave_request()
        except BudgetExhausted as error:
            os.close(fd)
            print(json.dumps({'error': str(error)}))
            return
        except (OSError, ValueError, RecursionError):
            os.close(fd)
            print(json.dumps({'error': 'Brave usage counter unavailable or invalid. No Brave request was sent.'}))
            return
        args += ['--perms', '0600', '--ro-bind-data', str(fd), SANDBOX_KEY]
    mode = '--brave-worker' if brave else '--mwmbl-worker' if mwmbl else '--worker'
    os.execv(args[0], [*args, '--', '/usr/bin/python3', '-IB', '/' + worker, *([] if fetching else [mode])])


if __name__ == '__main__':
    main()
