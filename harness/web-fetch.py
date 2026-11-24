#!/usr/bin/python3
"""Fetch bounded public HTTP(S) documents as text. Run only through the isolated web launcher.

HTML becomes compact Markdown (main content, headings, lists, links, tables, code; navigation, cookie
banners, and hidden elements dropped). PDF (pdftotext), JSON, CSV, XML, and plain text/Markdown are
supported, gzip-compressed or not. A few sites get cleaner sources: GitHub file pages -> raw files,
arXiv abstracts -> HTML (else PDF) full text, Wikipedia -> its plain-text API, and pages that publish a
Markdown alternate. The host slices the returned text (offset / maxChars / find) and caches it."""
from contextlib import closing
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPException
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit
import zlib

MAX_URL = 2048
MAX_BODY = 4 * 1024 * 1024
MAX_PDF = 12 * 1024 * 1024
MAX_TEXT = 400_000
MAX_REDIRECTS = 3
REDIRECTS = {301, 302, 303, 307, 308}
LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
GUA = ipaddress.ip_network('2000::/3')
TRANSITION = (ipaddress.ip_network('2001::/23'), ipaddress.ip_network('2002::/16'))


def validate_url(url):
    if (not isinstance(url, str) or not 1 <= len(url) <= MAX_URL
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in url)):
        raise ValueError('Invalid or oversized URL.')
    parsed = urlsplit(url)
    scheme = parsed.scheme
    if scheme not in ('http', 'https') or not parsed.hostname or '@' in parsed.netloc:
        raise ValueError('Only HTTP(S) URLs without credentials are allowed.')
    port = 443 if scheme == 'https' else 80
    if parsed.port not in (None, port):
        raise ValueError('Only the default HTTP and HTTPS ports are allowed.')
    host = parsed.hostname.removesuffix('.').encode('idna').decode('ascii').lower()
    if '%' in host:
        raise ValueError('Scoped or escaped hosts are not allowed.')
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        labels = host.split('.')
        if (len(host) > 253 or len(labels) < 2 or not all(LABEL.fullmatch(label) for label in labels)
                or host.endswith(('.local', '.localhost', '.internal', '.lan', '.home', '.arpa', '.test', '.onion'))):
            raise ValueError('A public hostname or IP address is required.')
    else:
        require_public(addr)
    path = quote(parsed.path or '/', safe="/%:@!$&'()*+,;=-._~")
    if parsed.query:
        path += '?' + quote(parsed.query, safe="/?%:@!$&'()*+,;=-._~")
    return scheme, host, port, path


def require_public(addr):
    if (not addr.is_global or addr.is_multicast or addr.is_reserved or addr.is_loopback
            or (addr.version == 6 and (addr not in GUA or any(addr in net for net in TRANSITION)))):
        raise ValueError('Destination is not a public IP address.')


def addresses(host, port):
    # Make DNS names absolute so resolv.conf search domains cannot expand them.
    try:
        ipaddress.ip_address(host)
        lookup = host
    except ValueError:
        lookup = host + '.'
    matches = socket.getaddrinfo(lookup, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    endpoints = []
    for family, kind, proto, _, sockaddr in matches:
        require_public(ipaddress.ip_address(sockaddr[0]))
        endpoints.append((family, kind, proto, sockaddr))
    if not endpoints:
        raise ValueError('No public address found.')
    return endpoints


def connect(scheme, host, port):
    endpoints = addresses(host, port)
    conn = HTTPConnection(host, port, timeout=6)
    conn.default_port = port
    conn.auto_open = 0  # Never permit an implicit connection using the hostname.
    tls = ssl.create_default_context() if scheme == 'https' else None
    # Connect directly to the validated sockaddr; do not resolve the hostname again.
    for family, kind, proto, sockaddr in endpoints[:4]:
        sock = socket.socket(family, kind, proto)
        try:
            sock.settimeout(6)
            sock.connect(sockaddr)
            conn.sock = tls.wrap_socket(sock, server_hostname=host) if tls else sock
            return conn
        except ssl.SSLError:
            sock.close()
            raise
        except OSError:
            sock.close()
    raise OSError('No approved address could be reached.')



TEXT_TYPES = {'text/plain', 'text/markdown', 'text/x-markdown'}
HTML_TYPES = {'text/html', 'application/xhtml+xml'}
XML_TYPES = {'text/xml', 'application/xml', 'application/rss+xml', 'application/atom+xml'}
CSV_TYPES = {'text/csv', 'text/tab-separated-values'}
ACCEPT = ('text/html, application/xhtml+xml, text/markdown, text/plain, application/pdf, '
          'application/json, text/csv, application/xml;q=0.8, */*;q=0.1')


def kind_of(media, url, head):
    if media in HTML_TYPES:
        return 'html'
    if media == 'application/pdf' or (head.startswith(b'%PDF-') and media in ('', 'application/octet-stream')):
        return 'pdf'
    if media == 'application/json' or media.endswith('+json'):
        return 'json'
    if media in CSV_TYPES:
        return 'csv'
    if media in XML_TYPES:
        return 'xml'
    if media in TEXT_TYPES:
        return 'markdown' if 'markdown' in media or urlsplit(url).path.endswith('.md') else 'text'
    return None


def read_body(response, limit):
    """Read at most `limit` decoded bytes; gzip is decompressed with the same cap (no zip bombs)."""
    encoding = (response.getheader('Content-Encoding') or 'identity').strip().lower()
    if encoding not in ('identity', 'gzip', 'x-gzip'):
        raise ValueError(f'Unsupported content encoding: {encoding[:20]}.')
    raw = response.read(limit + 1)
    if encoding == 'identity':
        return raw[:limit], len(raw) > limit
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        data = inflater.decompress(raw[:limit], limit + 1)
    except zlib.error:
        raise ValueError('The compressed response could not be decoded.') from None
    return data[:limit], len(data) > limit or bool(inflater.unconsumed_tail) or len(raw) > limit


def get(url, accept=ACCEPT):
    """GET with validated, DNS-pinned public endpoints and bounded redirects."""
    previous_scheme = None
    for hop in range(MAX_REDIRECTS + 1):
        scheme, host, port, path = validate_url(url)
        if previous_scheme == 'https' and scheme == 'http':
            raise ValueError('HTTPS-to-HTTP redirects are not allowed.')
        previous_scheme = scheme
        with closing(connect(scheme, host, port)) as conn:
            conn.request('GET', path, headers={'User-Agent': 'Pi-PublicText/1.1', 'Accept': accept,
                         'Accept-Encoding': 'gzip', 'Connection': 'close'})
            with conn.getresponse() as response:
                if response.status in REDIRECTS:
                    location = response.getheader('Location')
                    if hop == MAX_REDIRECTS or not location:
                        raise ValueError('Too many redirects or missing redirect destination.')
                    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in location):
                        raise ValueError('Invalid redirect destination.')
                    url = urljoin(url, location)
                    continue
                if response.status != 200:
                    raise ValueError(f'Public page returned HTTP {response.status}.')
                media = response.headers.get_content_type() if response.getheader('Content-Type') else ''
                limit = MAX_PDF if media in ('application/pdf', 'application/octet-stream') else MAX_BODY
                data, truncated = read_body(response, limit)
                charset = response.headers.get_content_charset() or 'utf-8'
                return url, media, charset, data, truncated
    raise ValueError('Too many redirects.')


def decode(data, charset):
    allowed = {'utf-8', 'utf8', 'ascii', 'us-ascii', 'iso-8859-1', 'latin-1', 'windows-1252', 'cp1252'}
    return data.decode(charset if charset.lower() in allowed else 'utf-8', errors='replace')


def clean(text):
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text.replace('\r\n', '\n').replace('\r', '\n'))
    return re.sub(r'\n{3,}', '\n\n', text).strip()


# ---------------------------------------------------------------- HTML -> Markdown
SKIP_TAGS = {'script', 'style', 'template', 'svg', 'noscript', 'iframe', 'form', 'button', 'select',
             'textarea', 'nav', 'aside', 'footer', 'dialog', 'canvas', 'video', 'audio', 'object',
             'embed', 'map', 'head'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
        'track', 'wbr'}
BLOCKS = {'p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'details',
          'summary', 'address', 'dl', 'dt', 'dd', 'ul', 'ol', 'center', 'fieldset', 'body'}
SKIP_ROLES = {'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog',
              'menu', 'menubar', 'tablist'}
NOISE = re.compile(r'(?:^|[\s_-])(?:cookie|consent|gdpr|banner|newsletter|subscribe|popup|modal|advert'
                   r'|ads|sponsor|share|sharing|social|breadcrumbs?|sidebar|navbar|nav|menu|skip-link'
                   r'|related|comments?|promo|footer|masthead|toolbar)(?:$|[\s_-])', re.I)
HIDDEN_STYLE = re.compile(r'display\s*:\s*none|visibility\s*:\s*hidden', re.I)
NEVER_NOISE = {'html', 'body', 'main', 'article'}


class Markdown(HTMLParser):
    def __init__(self, base, filter_noise=True):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.filter_noise = filter_noise
        self.stack = []
        self.skip_depth = None
        self.collectors = {'all': []}
        self.active = {'all': 0}
        self.captures = []
        self.lists = []
        self.tables = []
        self.pre = 0
        self.title = ''
        self.in_title = False
        self.alternate = None
        self.last = '\n'
        self.links = []
        self.main_seen = False

    # -- output
    def emit(self, text):
        if not text:
            return
        if self.captures:
            self.captures[-1].append(text)
        else:
            for name in self.active:
                self.collectors[name].append(text)
        self.last = text[-1]

    def block(self):
        if self.last != '\n':
            self.emit('\n\n')
        elif not self.captures:
            self.emit('\n')

    def inside(self, *tags):
        return any(t in self.stack for t in tags)

    # -- filtering
    def skipped(self, tag, attrs):
        if tag in SKIP_TAGS:
            return True
        if tag == 'header' and not self.inside('article', 'main'):
            return True
        if 'hidden' in attrs or (attrs.get('aria-hidden') or '').lower() == 'true':
            return True
        if HIDDEN_STYLE.search(attrs.get('style') or ''):
            return True
        if self.filter_noise and tag not in NEVER_NOISE:
            if (attrs.get('role') or '').lower() in SKIP_ROLES:
                return True
            if NOISE.search(f"{attrs.get('class') or ''} {attrs.get('id') or ''}"):
                return True
        return False

    def implicit_close(self, tag):
        closers = {'p': {'p'}, 'li': {'li'}, 'dt': {'dt', 'dd'}, 'dd': {'dt', 'dd'},
                   'tr': {'tr', 'td', 'th'}, 'td': {'td', 'th'}, 'th': {'td', 'th'}, 'option': {'option'}}
        if tag in closers and self.stack and self.stack[-1] in closers[tag]:
            self.handle_endtag(self.stack[-1])

    # -- parser callbacks
    def handle_starttag(self, tag, attr_list):
        attrs = {k: (v or '') for k, v in attr_list}
        if tag in VOID:
            self.void(tag, attrs)
            return
        self.implicit_close(tag)
        self.stack.append(tag)
        if tag == 'title':
            self.in_title = True
            return
        if self.skip_depth is None and self.skipped(tag, attrs):
            self.skip_depth = len(self.stack)
        if self.skip_depth is not None:
            return
        self.open_tag(tag, attrs)

    def handle_startendtag(self, tag, attr_list):
        if tag in VOID:
            self.handle_starttag(tag, attr_list)

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag in VOID or tag not in self.stack:
            return
        while self.stack:
            current = self.stack.pop()
            if self.skip_depth is None:
                self.close_tag(current)
            elif len(self.stack) < self.skip_depth:
                self.skip_depth = None
            if current == tag:
                break

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if self.skip_depth is not None:
            return
        if self.pre:
            self.emit(data)
            return
        text = re.sub(r'\s+', ' ', data)
        if self.last in '\n ' or self.last == '':
            text = text.lstrip()
        self.emit(text)

    # -- elements
    def void(self, tag, attrs):
        if tag == 'link' and 'alternate' in (attrs.get('rel') or '').lower().split() \
                and (attrs.get('type') or '').lower() in ('text/markdown', 'text/x-markdown') and attrs.get('href'):
            self.alternate = urljoin(self.base, attrs['href'])
        if self.skip_depth is not None:
            return
        if tag == 'br':
            self.emit('\n')
        elif tag == 'hr':
            self.block()
            self.emit('---')
            self.block()

    def open_tag(self, tag, attrs):
        if tag in ('main', 'article'):
            name = 'main' if tag == 'main' else f'article{len(self.collectors)}'
            if tag == 'main' and self.main_seen:
                pass
            else:
                self.main_seen = self.main_seen or tag == 'main'
                self.collectors[name] = []
                self.active[name] = len(self.stack)
            self.block()
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.block()
            self.emit('#' * int(tag[1]) + ' ')
        elif tag == 'pre':
            self.block()
            self.emit('```\n')
            self.pre += 1
        elif tag == 'code' and not self.pre:
            self.emit('`')
        elif tag in ('strong', 'b'):
            self.emit('**')
        elif tag in ('em', 'i'):
            self.emit('_')
        elif tag == 'a':
            href = attrs.get('href') or ''
            target = urljoin(self.base, href) if href and not href.startswith(('#', 'javascript:', 'mailto:')) else ''
            self.links.append(target if urlsplit(target).scheme in ('http', 'https') else '')
            self.captures.append([])
        elif tag in ('ul', 'ol'):
            if self.lists:
                if self.last != '\n':
                    self.emit('\n')
            else:
                self.block()
            self.lists.append([tag, 0])
        elif tag == 'li':
            if self.last != '\n':
                self.emit('\n')
            depth = max(0, len(self.lists) - 1)
            if self.lists and self.lists[-1][0] == 'ol':
                self.lists[-1][1] += 1
                marker = f'{self.lists[-1][1]}. '
            else:
                marker = '- '
            self.emit('  ' * depth + marker)
        elif tag == 'blockquote':
            self.block()
            self.captures.append([])
        elif tag == 'table':
            self.block()
            self.tables.append([])
        elif tag == 'tr' and self.tables:
            self.tables[-1].append([])
        elif tag in ('td', 'th') and self.tables:
            self.captures.append([])
        elif tag in BLOCKS:
            self.block()

    def close_tag(self, tag):
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.block()
        elif tag == 'pre':
            self.pre = max(0, self.pre - 1)
            if self.last != '\n':
                self.emit('\n')
            self.emit('```')
            self.block()
        elif tag == 'code' and not self.pre:
            self.emit('`')
        elif tag in ('strong', 'b'):
            self.emit('**')
        elif tag in ('em', 'i'):
            self.emit('_')
        elif tag == 'a' and self.links:
            href = self.links.pop()
            text = ' '.join(''.join(self.captures.pop()).split()) if self.captures else ''
            if text and href and text != href:
                self.emit(f'[{text}]({href})')
            elif text:
                self.emit(text)
        elif tag in ('ul', 'ol'):
            if self.lists:
                self.lists.pop()
            if self.lists:
                if self.last != '\n':
                    self.emit('\n')
            else:
                self.block()
        elif tag == 'blockquote' and self.captures:
            inner = clean(''.join(self.captures.pop()))
            if inner:
                self.emit('\n'.join(f'> {line}' if line else '>' for line in inner.split('\n')))
            self.block()
        elif tag in ('td', 'th') and self.tables and self.captures:
            cell = ' '.join(''.join(self.captures.pop()).split()).replace('|', '\\|')
            if not self.tables[-1]:
                self.tables[-1].append([])
            self.tables[-1][-1].append(cell)
        elif tag == 'table' and self.tables:
            self.emit_table(self.tables.pop())
        elif tag in ('main', 'article'):
            for name, depth in list(self.active.items()):
                if name != 'all' and depth == len(self.stack) + 1:
                    del self.active[name]
            self.block()
        elif tag in BLOCKS:
            self.block()

    def emit_table(self, rows):
        rows = [row for row in rows if any(cell for cell in row)]
        if not rows:
            return
        width = max(len(row) for row in rows)
        if width == 1:
            for row in rows:
                self.emit(row[0] + '\n')
            self.block()
            return
        lines = []
        for i, row in enumerate(rows):
            cells = row + [''] * (width - len(row))
            lines.append('| ' + ' | '.join(cells) + ' |')
            if i == 0:
                lines.append('|' + '---|' * width)
        self.block()
        self.emit('\n'.join(lines))
        self.block()

    def finish(self):
        """Close tags left open at the end of the document and flush pending captures."""
        while self.stack:
            self.handle_endtag(self.stack[-1])
        while self.captures:
            pending = ''.join(self.captures.pop())
            self.emit(pending)

    def result(self, name='all'):
        text = ''.join(self.collectors.get(name, [])).replace('\u00b6', '')
        text = re.sub(r'\[\]\([^)]*\)', '', text)
        text = re.sub(r'\*\*\s*\*\*|(?<![_\w])__(?![_\w])|(?<!`)``(?!`)', '', text)
        lines = [line.rstrip() for line in text.split('\n')]
        lines = [line for line in lines if line.strip() not in ('-', '*', '#', '##', '###')]
        return clean('\n'.join(lines))


def html_to_markdown(html, base):
    """Main content as Markdown: <main>, else the longest <article>, else the whole page. Noise
    filtering by class/role is undone if it removed most of the page (wrappers with nav-ish names)."""
    def render(filter_noise):
        parser = Markdown(base, filter_noise)
        parser.feed(html)
        parser.close()
        parser.finish()
        return parser
    filtered, unfiltered = render(True), render(False)
    full_f, full_u = filtered.result(), unfiltered.result()
    parser = filtered if len(full_f) >= max(300, len(full_u) // 4) else unfiltered
    whole = parser.result()
    candidates = []
    if 'main' in parser.collectors:
        candidates.append(parser.result('main'))
    articles = [parser.result(n) for n in parser.collectors if n.startswith('article')]
    if articles:
        candidates.append(max(articles, key=len))
    body = next((c for c in candidates if len(c) >= 300), whole)
    title = ' '.join(parser.title.split())[:300]
    return body, title, parser.alternate


# ---------------------------------------------------------------- formats
def pdf_to_text(data):
    try:
        proc = subprocess.run(['/usr/bin/pdftotext', '-q', '-l', '300', '-enc', 'UTF-8', '-', '-'],
                              input=data, capture_output=True, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('Could not extract text from the PDF (converter unavailable or too slow).') from None
    text = proc.stdout.decode('utf-8', errors='replace')
    if proc.returncode != 0 or not text.strip():
        raise ValueError('The PDF has no extractable text (it may be scanned or protected).')
    pages = text.split('\f')
    out = []
    for number, page in enumerate(pages, 1):
        page = clean(page)
        if page:
            out.append(f'--- page {number} ---\n{page}')
    return '\n\n'.join(out)


def json_to_text(data, charset):
    try:
        value = json.loads(decode(data, charset))
    except ValueError:
        return clean(decode(data, charset))
    return json.dumps(value, indent=1, ensure_ascii=False)


# ---------------------------------------------------------------- site shortcuts
GITHUB_BLOB = re.compile(r'^/([^/]+)/([^/]+)/blob/(.+)$')
ARXIV = re.compile(r'^/abs/([\w.\-/]+?)(?:v\d+)?/?$')
WIKI = re.compile(r'^([a-z]{2,12}(?:-[a-z]+)?)\.(?:m\.)?wikipedia\.org$')


def shortcut(url):
    """Cleaner sources for a few sites: (list of candidate URLs, label) or None."""
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    if host in ('github.com', 'www.github.com') and (m := GITHUB_BLOB.match(parts.path)):
        return [f'https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}'], 'github-raw'
    if host == 'gist.github.com' and re.fullmatch(r'/[\w-]+/[0-9a-f]+/?', parts.path):
        return [f'https://gist.githubusercontent.com{parts.path.rstrip("/")}/raw'], 'gist-raw'
    if host in ('arxiv.org', 'www.arxiv.org', 'export.arxiv.org') and (m := ARXIV.match(parts.path)):
        return [f'https://arxiv.org/html/{m[1]}', f'https://arxiv.org/pdf/{m[1]}'], 'arxiv-fulltext'
    if (m := WIKI.match(host)) and parts.path.startswith('/wiki/') and len(parts.path) > 6:
        title = unquote(parts.path[6:])
        if ':' not in title:
            query = urlencode({'action': 'query', 'prop': 'extracts', 'explaintext': 1, 'format': 'json',
                               'redirects': 1, 'titles': title})
            return [f'https://{m[1]}.wikipedia.org/w/api.php?{query}'], 'wikipedia-api'
    return None


def wikipedia_text(data, charset):
    pages = json.loads(decode(data, charset)).get('query', {}).get('pages', {})
    page = next(iter(pages.values()), {})
    extract = page.get('extract')
    if not isinstance(extract, str) or not extract.strip():
        raise ValueError('Wikipedia returned no article text.')
    text = re.sub(r'^(=+)\s*(.*?)\s*=+\s*$', lambda m: '#' * min(6, len(m[1])) + ' ' + m[2], extract, flags=re.M)
    return clean(text), str(page.get('title') or '')[:300]


# ---------------------------------------------------------------- main entry
def convert(url, media, charset, data):
    head = data[:8]
    kind = kind_of(media, url, head)
    if kind is None:
        raise ValueError(f'Unsupported content type: {media or "unknown"}. Supported: HTML, PDF, JSON, CSV, XML, text/Markdown.')
    title, alternate = '', None
    if kind == 'html':
        text, title, alternate = html_to_markdown(decode(data, charset), url)
        kind = 'markdown'
    elif kind == 'pdf':
        text = pdf_to_text(data)
    elif kind == 'json':
        text = json_to_text(data, charset)
    else:
        text = clean(decode(data, charset))
    return kind, title, alternate, text


def fetch(url):
    validate_url(url)
    via = None
    final = media = charset = data = None
    truncated = False
    shortcut_hit = shortcut(url)
    if shortcut_hit:
        candidates, label = shortcut_hit
        for candidate in candidates:
            try:
                final, media, charset, data, truncated = get(candidate)
                via = label
                break
            except (ValueError, OSError, HTTPException):
                continue
    if via == 'wikipedia-api':
        try:
            text, title = wikipedia_text(data, charset)
            return finish(url, final, 'markdown', title, text, truncated, via)
        except (ValueError, AttributeError):
            via = None
    if via is None:
        final, media, charset, data, truncated = get(url)
    kind, title, alternate, text = convert(final, media, charset, data)
    if alternate and urlsplit(alternate).hostname == urlsplit(final).hostname:
        try:
            alt_final, alt_media, alt_charset, alt_data, alt_truncated = get(alternate, 'text/markdown, text/plain')
            if kind_of(alt_media, alt_final, alt_data[:8]) in ('markdown', 'text'):
                alt_text = clean(decode(alt_data, alt_charset))
                if len(alt_text) >= 200:
                    final, text, truncated, via = alt_final, alt_text, alt_truncated, 'markdown-alternate'
        except (ValueError, OSError, HTTPException):
            pass
    return finish(url, final, kind, title, text, truncated, via)


def finish(requested, final, kind, title, text, truncated, via):
    text = text or '(no text content)'
    return {
        'url': final, 'requested': requested, 'kind': kind, 'title': title, 'via': via,
        'text': text[:MAX_TEXT], 'truncated': bool(truncated) or len(text) > MAX_TEXT,
    }


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.buffer.read(16384))
        print(json.dumps(fetch(payload['url'])))
    except (ValueError, TypeError, KeyError) as error:
        print(json.dumps({'error': str(error)}))
    except (OSError, HTTPException):
        print(json.dumps({'error': 'Could not connect to the public page or read its response.'}))
