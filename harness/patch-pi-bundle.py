#!/usr/bin/python3
"""Apply, check or revert Protected Pi's patches to the installed Pi bundle.

Patches (each found, applied and reverted independently):

trust-notice
    Protected Pi always launches Pi with --no-approve, which forces Pi's native project trust to
    false. Unpatched, Pi then tells the user to run /trust and restart, even when trust is already
    saved. The patch (written by Codex on 2026-11-24) shows a muted notice instead on Protected Pi launches only; ordinary Pi keeps its
    original warning.

local-links
    With terminal hyperlinks on (Ghostty, kitty, WezTerm, iTerm2...), Pi's markdown renderer puts
    a link's raw href into the OSC 8 escape and hides the href text. A relative path such as
    `.local/outbox/x.gif` is not a URL, so the terminal cannot open it. The patch (written by
    Claude Code on 2026-11-24) turns any href without a URL scheme into an absolute file:// URL,
    resolved against Pi's working directory (`~/` expands to the home directory). Hrefs with a
    scheme (https:, file:, mailto:...) and bare #anchors are unchanged.

Usage: patch-pi-bundle.py apply|check|revert NODE_HOME
Exit status: 0 = all patched (or reverted), 3 = some patch not applied,
             4 = unsupported Pi build for some patch (that patch left untouched).
"""
import os
from pathlib import Path
import stat
import sys
import tempfile

LOCAL_LINK_TARGET = (
    b'function piLocalLinkTarget(href){'
    b'if(!href||href.startsWith("#")||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href))return href;'
    b'let path=href;try{path=decodeURI(href)}catch{}'
    b'if(path==="~"||path.startsWith("~/")){let home=homedir2();if(!home)return href;path=home+path.slice(1)}'
    b'try{return pathToFileURL(path).href}catch{return href}}'
)

PATCHES = [
    {
        'name': 'trust-notice',
        'anchor': b'renderProjectTrustWarningIfNeeded(){',
        'marker': b'usesProtectedProjectResourcePolicy(){',
        'replacements': [
            (
                b'renderProjectTrustWarningIfNeeded(){',
                b'usesProtectedProjectResourcePolicy(){return Boolean(process.env.PI_PROTECTED_DIR&&process.argv.includes("--no-approve"))}'
                b'renderProjectTrustWarningIfNeeded(){let protectedPolicy=this.usesProtectedProjectResourcePolicy();',
            ),
            (
                b'theme.fg("warning",`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart pi.`)',
                b'theme.fg(protectedPolicy?"muted":"warning",protectedPolicy?"Protected Pi disables native project settings, packages, and extensions for this session.":'
                b'`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart pi.`)',
            ),
            (
                b'`Saved trust decision: ${selection.trusted?"trusted":"untrusted"}. Restart ${APP_NAME} for this to take effect.`',
                b'`Saved trust decision: ${selection.trusted?"trusted":"untrusted"}. ${this.usesProtectedProjectResourcePolicy()?'
                b'"Protected Pi keeps native project resources disabled.":`Restart ${APP_NAME} for this to take effect.`}`',
            ),
        ],
    },
    {
        'name': 'local-links',
        'anchor': b'if(getCapabilities().hyperlinks)result+=hyperlink(styledLink,token.href)+stylePrefix;',
        'marker': b'function piLocalLinkTarget(href){',
        # The helper relies on the chunk's existing pathToFileURL and homedir2 imports.
        'requires': [b'import{pathToFileURL}from"node:url"', b'import{homedir as homedir2}'],
        'replacements': [
            (b'function hyperlink(text,url){', LOCAL_LINK_TARGET + b'function hyperlink(text,url){'),
            (
                b'if(getCapabilities().hyperlinks)result+=hyperlink(styledLink,token.href)+stylePrefix;',
                b'if(getCapabilities().hyperlinks)result+=hyperlink(styledLink,piLocalLinkTarget(token.href))+stylePrefix;',
            ),
        ],
    },
]


def chunks_dir(node_home):
    return Path(node_home) / 'lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks'


def find_chunk(node_home, patch):
    """The one chunk holding the patch, matched by its original anchor or, once patched, its marker."""
    hits = []
    for path in sorted(chunks_dir(node_home).glob('*.js')):
        data = path.read_bytes()
        if patch['anchor'] in data or patch['marker'] in data:
            hits.append(path)
    return hits[0] if len(hits) == 1 else None


def write_atomic(target, data):
    meta = target.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_nlink != 1:
        raise SystemExit(f'pi bundle patch: {target} is not a plain user-owned file')
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.pi-bundle-', delete=False) as pending:
        tmp = Path(pending.name)
        try:
            pending.write(data)
            pending.flush()
            os.fchmod(pending.fileno(), stat.S_IMODE(meta.st_mode))
            os.replace(tmp, target)
        finally:
            tmp.unlink(missing_ok=True)


def run(action, node_home, patch):
    """Return 0 (done or present), 3 (missing) or 4 (unsupported) for one patch."""
    name = patch['name']
    chunk = find_chunk(node_home, patch)
    if chunk is None:
        print(f'pi bundle patch {name}: unsupported Pi build (target not found); left untouched')
        return 4
    data = chunk.read_bytes()
    patched = patch['marker'] in data
    if action == 'check':
        print(f'pi bundle patch {name}: {"present" if patched else "missing"} ({chunk.name})')
        return 0 if patched else 3
    if action == 'apply':
        if patched:
            print(f'pi bundle patch {name}: already present ({chunk.name})')
            return 0
        if (any(data.count(before) != 1 for before, _ in patch['replacements'])
                or any(req not in data for req in patch.get('requires', []))):
            print(f'pi bundle patch {name}: unsupported Pi build (expected text changed); left untouched')
            return 4
        for before, after in patch['replacements']:
            data = data.replace(before, after, 1)
        write_atomic(chunk, data)
        print(f'pi bundle patch {name}: applied ({chunk.name})')
        return 0
    if not patched:
        print(f'pi bundle patch {name}: not present')
        return 0
    if any(data.count(after) != 1 for _, after in patch['replacements']):
        print(f'pi bundle patch {name}: patched text changed; left untouched')
        return 4
    for before, after in reversed(patch['replacements']):
        data = data.replace(after, before, 1)
    write_atomic(chunk, data)
    print(f'pi bundle patch {name}: reverted ({chunk.name})')
    return 0


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('apply', 'check', 'revert'):
        raise SystemExit(__doc__)
    action, node_home = sys.argv[1:]
    results = [run(action, node_home, patch) for patch in PATCHES]
    return max(results)


if __name__ == '__main__':
    sys.exit(main())
