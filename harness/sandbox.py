#!/usr/bin/python3
"""Build the filesystem sandbox for a single protected Pi tool call."""
import collections
import fnmatch
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
BWRAP = '/usr/bin/bwrap'
GIT_BIN = '/usr/bin/git'
PRIVATE_NAMES = {'.git', '.pi', '.codex', '.ssh', '.gnupg', '.aws', '.kube', '.docker',
                 '.config', '.local', '.cache', '.password-store', '.netrc', '.git-credentials'}
# Host access mode (Claude-like): only credential stores are private inside the workspace, and the
# project's .git, .local, .codex and .pi folders stay visible. Strict mode keeps the original list.
HOST_PRIVATE_NAMES = {'.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.netrc', '.git-credentials'}
# Visible in host mode but not searched for secret files (dependency trees, caches, Git internals).
HOST_SCAN_PRUNE = {'.git', 'node_modules', '__pycache__', 'site-packages', 'dist-packages', '.venv', 'venv',
                   '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache'}
# Home-folder paths readable in host mode. Everything else under $HOME (keys, tokens, browser
# profiles, desktop sockets) stays unmounted. Agent session logs are readable so earlier sessions
# can be reviewed; they can contain anything pasted into those sessions.
HOST_HOME_READ = (
    '.gitconfig', '.config/git', '.local/bin', '.local/share/uv/python', '.local/share/uv/tools',
    '.local/share/ubuntu-workstation', '.local/share/python-runtimes', '.local/opt', 'opt',
    '.cargo/bin', '.rustup', '.bun/bin',
    '.claude/projects', '.codex/sessions', '.codex/archived_sessions', '.factory/sessions',
    '.pi/agent/sessions', '.qwen/projects', '.qwen/tmp', '.cursor/projects', '.cursor/chats', '.gemini/tmp',
)
HOST_ETC = ('hosts', 'resolv.conf', 'nsswitch.conf', 'host.conf', 'gai.conf', 'ssl', 'ca-certificates',
            'localtime', 'timezone', 'alternatives', 'mime.types', 'gitconfig', 'ld.so.conf', 'ld.so.conf.d')
DIR_MASK_LIMIT = 256
TOTAL_MASK_LIMIT = 2500

GIT_SUBCOMMANDS = {'status', 'log', 'diff', 'show', 'blame', 'ls-files'}
GIT_HISTORY_SUBCOMMANDS = {'log', 'diff', 'show', 'blame'}
GIT_SAFE_FLAGS = {
    'status': {
        '-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2',
        '-u', '--untracked-files', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all',
    },
    'ls-files': {
        '-c', '--cached', '-o', '--others', '-m', '--modified', '-d', '--deleted', '--exclude-standard', '--stage',
    },
    'log': {
        '--oneline', '--stat', '--shortstat', '--name-only', '--name-status', '--graph', '--decorate',
        '--no-decorate', '-p', '--patch', '--follow', '--reverse', '--first-parent', '--no-merges', '--merges',
        '--abbrev-commit', '--no-abbrev-commit', '--full-history',
        '--date=iso', '--date=iso-strict', '--date=short', '--date=relative',
    },
    'diff': {
        '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--cached', '--staged',
        '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--minimal', '--patience', '--histogram',
        '--check', '-p', '--patch', '--no-patch', '-s', '--summary', '--raw', '--full-index', '--binary',
        '-M', '--find-renames', '-C', '--find-copies', '--no-renames', '--word-diff',
    },
    'show': {
        '--stat', '--shortstat', '--name-only', '--name-status', '--oneline', '-s', '--no-patch', '-p', '--patch',
        '--check', '--abbrev-commit', '--no-abbrev-commit',
        '--date=iso', '--date=iso-strict', '--date=short', '--date=relative',
    },
    'blame': {
        '-l', '-s', '-w', '-n', '-f', '-e', '--line-porcelain', '--porcelain',
    },
}


SECRET_EXCEPTIONS = []


def access_mode():
    return 'host' if os.environ.get('PI_PROTECTED_ACCESS') == 'host' else 'strict'


GIT_HOST_FLAGS = {
    'log': {'--all', '--branches', '--remotes', '--tags', '--decorate=short', '--decorate=full',
            '--simplify-by-decoration', '--topo-order', '--date-order', '--left-right', '--boundary'},
    'status': {'--ignored', '--ahead-behind', '--no-ahead-behind'},
}


def secret_patterns():
    policy = json.loads((HERE / 'write-guard.json').read_text())
    SECRET_EXCEPTIONS[:] = [x for x in policy.get('secretExceptions', []) if isinstance(x, str)]
    return policy['secretPaths']


def is_secret_name(name, patterns):
    if any(fnmatch.fnmatchcase(name, pattern) for pattern in SECRET_EXCEPTIONS):
        return False
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def is_protected(name, patterns):
    return name in PRIVATE_NAMES or is_secret_name(name, patterns)


def is_masked_name(name, patterns):
    """Whether a workspace entry is hidden from tools under the current access mode."""
    if access_mode() == 'host':
        return name in HOST_PRIVATE_NAMES or is_secret_name(name, patterns)
    return is_protected(name, patterns)


def workspace(path, patterns):
    root = Path(path).resolve(strict=True)
    home = Path.home().resolve(strict=True)
    bases = [home, Path('/tmp'), Path('/mnt'), Path('/media')]
    for base in bases:
        if root != base and root.is_relative_to(base):
            parts = root.relative_to(base).parts
            if not any(is_protected(part, patterns) for part in parts):
                return root
    raise ValueError('choose a project folder, not your home, a credentials directory, or a system directory')


def check_mounts(root):
    with open('/proc/self/mountinfo', encoding='ascii', errors='surrogateescape') as mounts:
        for line in mounts:
            mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
            target = Path(os.fsdecode(mount.encode('ascii', 'surrogateescape')))
            if target != root and target.is_relative_to(root):
                raise ValueError(f'nested workspace mount is not supported: {target}')


def scan_workspace_masks(root, patterns):
    check_mounts(root)
    masks = {}
    agent_dir = Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent')))
    host_files = {'auth.json', 'settings.json', 'models.json', 'mcp.json', 'trust.json', 'models-store.json'}
    trusted_targets = {(agent_dir / name).resolve() for name in host_files}

    def fail(error):
        raise error

    def add_mask(path):
        if not path.is_relative_to(root) or path == root:
            raise ValueError(f'protected workspace link resolves outside its allowed path: {path}')
        mode = path.lstat().st_mode
        masks[path] = stat.S_ISDIR(mode)

    if access_mode() == 'host':
        return scan_host_masks(root, patterns, trusted_targets, add_mask, masks)
    for folder, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        for name in dirs + files:
            path = Path(folder) / name
            info = path.lstat()
            protected = path in trusted_targets or is_masked_name(name, patterns)
            if stat.S_ISLNK(info.st_mode):
                if protected:
                    # Relative and absolute links into the project see the same mask as the original.
                    target = path.resolve()
                    if target.exists():
                        add_mask(target)
                continue
            is_dir = stat.S_ISDIR(info.st_mode)
            if protected or (not is_dir and (not stat.S_ISREG(info.st_mode) or info.st_nlink > 1)):
                masks[path] = is_dir
                if is_dir and name in dirs:
                    dirs.remove(name)

    return masks


def scan_host_masks(root, patterns, trusted_targets, add_mask, masks):
    """Host-mode scan: credential folders, secret-named files, links to them, and non-regular files.

    Uses directory-entry types instead of a stat per file, skips the HOST_SCAN_PRUNE trees, and does
    not mask hardlinks: no credential store is mounted in host mode, so a link cannot reach one.
    """
    secret = re.compile('|'.join(fnmatch.translate(p) for p in patterns)) if patterns else None
    exempt = re.compile('|'.join(fnmatch.translate(p) for p in SECRET_EXCEPTIONS)) if SECRET_EXCEPTIONS else None
    trusted = {str(t) for t in trusted_targets}
    by_inode = collections.defaultdict(list)  # regular files seen, keyed by inode (free from readdir)
    pruned = []

    def walk(start, record_pruned):
        stack = [start]
        while stack:
            folder = stack.pop()
            with os.scandir(folder) as entries:
                for entry in entries:
                    name = entry.name
                    protected = (name in HOST_PRIVATE_NAMES or entry.path in trusted
                                 or (secret is not None and secret.match(name) is not None
                                     and (exempt is None or exempt.match(name) is None)))
                    if entry.is_symlink():
                        if protected:
                            target = Path(entry.path).resolve()
                            if target.exists():
                                add_mask(target)
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if protected:
                            masks[Path(entry.path)] = True
                        elif name in HOST_SCAN_PRUNE:
                            if record_pruned:
                                pruned.append(entry.path)
                        else:
                            stack.append(entry.path)
                        continue
                    if protected or not entry.is_file(follow_symlinks=False):
                        masks[Path(entry.path)] = False
                    else:
                        by_inode[entry.inode()].append(entry.path)

    walk(str(root), True)
    # Hardlinks to a hidden file would show its bytes under another name: hide every other link too.
    secret_inodes = {}
    for path, is_dir in list(masks.items()):
        files = [path] if not is_dir else [Path(d) / f for d, _, fs in os.walk(path) for f in fs]
        for file in files:
            try:
                st = file.lstat()
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
                secret_inodes[st.st_ino] = st.st_nlink - (0 if is_dir else 1)
    if secret_inodes:
        def mask_links():
            missing = 0
            for ino, expected in secret_inodes.items():
                links = by_inode.get(ino, [])
                for link in links:
                    masks[Path(link)] = False
                missing += max(0, expected - len(links))
            return missing
        if mask_links() and pruned:
            # Some links live in dependency or Git trees that are normally skipped: search them too.
            by_inode.clear()
            for folder in pruned:
                walk(folder, False)
            mask_links()
    return masks


def collapse_masks(root, raw_masks, dir_limit=DIR_MASK_LIMIT, total_limit=TOTAL_MASK_LIMIT):
    initial_dirs = {path for path, is_dir in raw_masks.items() if is_dir}
    masks = {
        path: is_dir
        for path, is_dir in raw_masks.items()
        if not initial_dirs.intersection(path.parents)
    }
    collapsed = set()

    def collapse_dir(directory):
        masks[directory] = True
        for path in [item for item in masks if directory in item.parents]:
            del masks[path]
        for child in [item for item in collapsed if directory in item.parents]:
            collapsed.remove(child)
        collapsed.add(directory)

    parents = sorted({path.parent for path in masks if path.parent != root},
                     key=lambda item: (-len(item.parts), str(item)))
    for directory in parents:
        if directory not in masks or not masks[directory]:
            direct = sum(1 for path in masks if path.parent == directory)
            if direct > dir_limit:
                collapse_dir(directory)

    if len(masks) > total_limit:
        ancestors = sorted(
            {anc for path in masks for anc in path.parents if anc != root and root in anc.parents},
            key=lambda item: (-len(item.parts), str(item)),
        )
        for threshold in (dir_limit, 64, 16, 1):
            if len(masks) <= total_limit:
                break
            for directory in ancestors:
                if len(masks) <= total_limit:
                    break
                if directory in masks and masks[directory]:
                    continue
                sub_count = sum(1 for path in masks if directory in path.parents)
                if sub_count > threshold:
                    collapse_dir(directory)

    if len(masks) > total_limit:
        raise ValueError(
            f'too many masked files ({len(masks)} > {total_limit}) in {root}; '
            'reinstall dependencies without hardlinks (UV_LINK_MODE=copy or pnpm --package-import-method=copy)'
        )

    return masks, sorted(collapsed)


def effective_masks(root, patterns):
    return collapse_masks(root, scan_workspace_masks(root, patterns))


def workspace_masks(root, patterns):
    return effective_masks(root, patterns)[0]


def python_runtime_mount_args(workspace_root):
    """Expose standard user/root-owned read-only Python base runtimes so workspace .venv symlinks resolve."""
    try:
        home = Path.home().resolve(strict=True)
    except OSError:
        return []
    uid = os.getuid()
    candidates = [
        home / '.local' / 'share' / 'python-runtimes',
        home / '.local' / 'share' / 'uv' / 'python',
        home / '.pyenv' / 'versions',
        home / '.rye' / 'py',
    ]
    out = []
    seen = set()
    for base in candidates:
        # Walk each prefix component from home downward to ensure no symlink intermediates exist.
        try:
            cur = home
            valid_chain = True
            for part in base.relative_to(home).parts:
                cur = cur / part
                st = cur.lstat()
                if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (uid, 0):
                    valid_chain = False
                    break
            if not valid_chain:
                continue
            entries = sorted(base.iterdir(), key=lambda p: p.name)[:16]
        except OSError:
            continue
        for entry in entries:
            try:
                est = entry.lstat()
                if not stat.S_ISDIR(est.st_mode) or est.st_uid not in (uid, 0):
                    continue
                if entry == workspace_root or entry.is_relative_to(workspace_root) or workspace_root.is_relative_to(entry):
                    continue
                bin_st = (entry / 'bin').lstat()
                lib_st = (entry / 'lib').lstat()
                if not (stat.S_ISDIR(bin_st.st_mode) and stat.S_ISDIR(lib_st.st_mode)):
                    continue
                if bin_st.st_uid not in (uid, 0) or lib_st.st_uid not in (uid, 0):
                    continue
            except OSError:
                continue
            resolved = str(entry)
            if resolved not in seen:
                seen.add(resolved)
                out += ['--ro-bind', resolved, resolved]
    return out


def _apply_dir_masks(out, host_dir, mount_dest, skill_masks, empty_dirs):
    for path, is_dir in sorted(skill_masks.items()):
        if not empty_dirs.intersection(path.parents):
            rel = path.relative_to(host_dir)
            target = mount_dest / rel
            if is_dir:
                out += ['--tmpfs', str(target), '--remount-ro', str(target)]
            else:
                out += ['--ro-bind', str(HERE / 'empty-secret'), str(target)]


def skill_mount_args(patterns, workspace_root=None):
    raw = os.environ.get('PI_SANDBOX_SKILL_MOUNTS')
    if not raw:
        return []
    entries = json.loads(raw)
    if not isinstance(entries, list):
        raise ValueError('invalid skill mounts')
    try:
        codex_skills_root = (Path.home().resolve(strict=True) / '.codex' / 'skills').resolve(strict=False)
    except OSError:
        codex_skills_root = None
    out = []
    seen = set()
    for item in entries:
        if not (isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and isinstance(item[1], str)):
            raise ValueError('invalid skill mount entry')
        host_dir_str, name = item
        if not re.fullmatch(r'[a-zA-Z0-9._-]{1,64}', name) or name in ('.', '..') or name in seen:
            raise ValueError(f'invalid skill mount name: {name}')
        seen.add(name)
        host_dir = Path(host_dir_str).resolve(strict=True)
        if not host_dir.is_dir():
            raise ValueError(f'skill mount is not a directory: {host_dir}')
        dest = Path('/opt/pi-skills') / name
        out += ['--ro-bind', str(host_dir), str(dest)]
        # Mask any secret/protected/hardlinked entries inside the bound skill directory too.
        skill_masks, _ = collapse_masks(host_dir, scan_workspace_masks(host_dir, patterns))
        empty_dirs = {p for p, is_dir in skill_masks.items() if is_dir}
        _apply_dir_masks(out, host_dir, dest, skill_masks, empty_dirs)
        # Also expose verified ~/.codex/skills/<name> at its host path so AGENTS.md links resolve read-only
        # while keeping the rest of ~/.codex (auth.json, sessions, config) completely unmounted.
        if (
            codex_skills_root is not None
            and host_dir != codex_skills_root
            and host_dir.parent == codex_skills_root
            and (workspace_root is None or not host_dir.is_relative_to(workspace_root))
        ):
            out += ['--ro-bind', str(host_dir), str(host_dir)]
            _apply_dir_masks(out, host_dir, host_dir, skill_masks, empty_dirs)
    return out


def repo_git_dirs(root):
    """Return (git_dir, common_dir) for the repository containing root, or (None, None).

    git_dir is the repository's own .git directory, or a linked worktree's private gitdir; common_dir
    holds the shared objects and refs. Both are validated as user-owned directories under $HOME.
    """
    home = Path.home().resolve(strict=True)
    bases = [home, Path('/tmp'), Path('/mnt'), Path('/media')]
    uid = os.getuid()
    entry = None
    for candidate in (root, *root.parents):
        if not any(candidate != base and candidate.is_relative_to(base) for base in bases):
            break
        if (candidate / '.git').exists() or (candidate / '.git').is_symlink():
            entry = candidate / '.git'
            break
    if entry is None or entry.is_symlink():
        return None, None
    if entry.is_dir():
        git_dir = entry.resolve(strict=True)
        common = git_dir
    else:
        text = entry.read_text(encoding='utf-8', errors='strict')[:4096].strip()
        if not text.startswith('gitdir: '):
            return None, None
        git_dir = (entry.parent / text[len('gitdir: '):]).resolve(strict=True)
        common_file = git_dir / 'commondir'
        common = (git_dir / common_file.read_text().strip()).resolve(strict=True) if common_file.is_file() else git_dir
    for path in (git_dir, common):
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or not any(path.is_relative_to(b) for b in bases):
            raise ValueError(f'unsupported Git directory: {path}')
        if any(part in HOST_PRIVATE_NAMES for part in path.parts):
            raise ValueError(f'Git directory is inside a credentials folder: {path}')
    if not (common / 'objects').is_dir() or not (common / 'HEAD').exists():
        raise ValueError(f'not a Git directory: {common}')
    return git_dir, common


def host_sandbox_args(root, node_home, patterns, writable, masks, chdir=None):
    """Claude-like view: network, the allowlisted home paths, and the repository's Git directory."""
    home = Path.home().resolve(strict=True)
    args = ['--unshare-all', '--unshare-user', '--share-net', '--disable-userns', '--die-with-parent', '--new-session',
            '--clearenv', '--ro-bind', '/usr', '/usr', '--dev', '/dev', '--proc', '/proc',
            '--tmpfs', '/tmp', '--ro-bind', node_home, '/opt/pi-node',
            '--ro-bind', str(HERE / 'tool-worker.mjs'), '/opt/tool-worker.mjs',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--dir', str(home),
            '--setenv', 'HOME', str(home),
            '--setenv', 'PATH', f'{home}/.local/bin:/opt/pi-node/bin:/usr/bin:/bin',
            '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
            '--setenv', 'USER', home.name, '--setenv', 'LOGNAME', home.name,
            '--setenv', 'PI_PROTECTED_ACCESS', 'host']
    for name in ('passwd', 'group', 'ld.so.cache', 'fonts', 'libreoffice', *HOST_ETC):
        args += ['--ro-bind-try', '/etc/' + name, '/etc/' + name]
    # /etc/resolv.conf is usually a link into systemd-resolved's runtime folder.
    args += ['--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve']
    for rel in HOST_HOME_READ:
        src = home / rel
        if not (src.exists() or src.is_symlink()):
            continue
        resolved = src.resolve()
        if (resolved == root or resolved.is_relative_to(root) or root.is_relative_to(resolved)
                or not resolved.is_relative_to(home)
                or any(part in HOST_PRIVATE_NAMES for part in resolved.relative_to(home).parts)):
            continue
        args += ['--ro-bind-try', str(resolved), str(src)]
    args += python_runtime_mount_args(root)
    args += ['--bind' if writable else '--ro-bind', str(root), str(root)]
    git_dir, common = repo_git_dirs(root)
    for path in dict.fromkeys(p for p in (common, git_dir) if p is not None):
        if not path.is_relative_to(root):
            args += ['--bind' if writable else '--ro-bind', str(path), str(path)]
    # Commits, branches and worktrees work, but hooks and repository config stay read-only: host-side
    # Git (pi_safe_git_remote, /commit, the user's own git) reads them, so a planted credential
    # helper, filter driver or hook would otherwise run outside the sandbox.
    for path in (common / 'hooks' if common else None, common / 'config' if common else None,
                 git_dir / 'config.worktree' if git_dir else None):
        if path is not None and (path.exists() or path.is_symlink()):
            args += ['--ro-bind', str(path), str(path)]
    if common is not None:
        # Creating a branch from origin/... would otherwise try to record its upstream in .git/config.
        args += ['--setenv', 'GIT_CONFIG_PARAMETERS', "'branch.autosetupmerge'='false'"]
    empty_dirs = {path for path, is_dir in masks.items() if is_dir}
    for path, is_dir in sorted(masks.items()):
        if not empty_dirs.intersection(path.parents):
            if is_dir:
                args += ['--tmpfs', str(path), '--remount-ro', str(path)]
            else:
                args += ['--ro-bind', str(HERE / 'empty-secret'), str(path)]
    args += skill_mount_args(patterns, workspace_root=root)
    args += ['--chdir', str(chdir or root)]
    return args


def sandbox_args(root, node_home, patterns, writable, masks=None, chdir=None):
    if masks is None:
        masks = workspace_masks(root, patterns)
    if access_mode() == 'host':
        return host_sandbox_args(root, node_home, patterns, writable, masks, chdir)
    args = ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
            '--clearenv', '--ro-bind', '/usr', '/usr', '--dev', '/dev', '--proc', '/proc',
            '--tmpfs', '/tmp', '--dir', '/run/pi-home', '--ro-bind', node_home, '/opt/pi-node',
            '--ro-bind', str(HERE / 'tool-worker.mjs'), '/opt/tool-worker.mjs',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--setenv', 'HOME', '/run/pi-home', '--setenv', 'PATH', '/opt/pi-node/bin:/usr/bin:/bin',
            '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
            '--bind' if writable else '--ro-bind', str(root), str(root), '--chdir', str(chdir or root)]
    for name in ('passwd', 'group', 'ld.so.cache', 'fonts', 'libreoffice'):
        args += ['--ro-bind-try', '/etc/' + name, '/etc/' + name]
    empty_dirs = {path for path, is_dir in masks.items() if is_dir}
    for path, is_dir in sorted(masks.items()):
        if not empty_dirs.intersection(path.parents):
            if is_dir:
                args += ['--tmpfs', str(path), '--remount-ro', str(path)]
            else:
                args += ['--ro-bind', str(HERE / 'empty-secret'), str(path)]
    args += python_runtime_mount_args(root)
    args += skill_mount_args(patterns, workspace_root=root)
    return args


def hardened_git_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(
        GIT_CONFIG_NOSYSTEM='1',
        GIT_CONFIG_GLOBAL='/dev/null',
        GIT_TERMINAL_PROMPT='0',
        GIT_NO_REPLACE_OBJECTS='1',
        GIT_NO_LAZY_FETCH='1',
        GIT_OPTIONAL_LOCKS='0',
    )
    return env


# Flag shapes accepted by pattern, shown in rejection messages so the model can retry correctly.
GIT_PATTERN_FLAGS = {
    'log': ('-n<N>', '-<N>', '--max-count=<N>', '--since=<date>', '--until=<date>', '--author=<text>',
            '--grep=<text>', '-S<text>', '-G<regex>', '--format=<fmt>', '--pretty=<fmt>', '--date=format:<fmt>',
            '-U<N>', '--unified=<N>', '--stat=<width>'),
    'show': ('--format=<fmt>', '--pretty=<fmt>', '--date=format:<fmt>', '-U<N>', '--unified=<N>', '--stat=<width>'),
    'diff': ('-U<N>', '--unified=<N>', '--stat=<width>'),
    'blame': ('-L<start>,<end>',),
}


def git_flag_allowed(subcommand, token):
    if token in GIT_SAFE_FLAGS[subcommand]:
        return True
    if access_mode() == 'host' and token in GIT_HOST_FLAGS.get(subcommand, ()):
        return True
    if subcommand in ('log', 'diff', 'show') and (
        re.fullmatch(r'-U\d{1,3}|--unified=\d{1,3}', token)
        or re.fullmatch(r'--stat=\d{1,4}(,\d{1,4}){0,2}', token)
    ):
        return True
    if subcommand in ('log', 'show') and (
        re.fullmatch(
            r'--(format|pretty)=(oneline|short|medium|full|fuller|reference|raw|(t?format:)?[a-zA-Z0-9_%.,:/+ -]{1,120})',
            token,
        )
        or re.fullmatch(r'--date=format(-local)?:[a-zA-Z0-9_%.,:/+ -]{1,60}', token)
    ):
        return True
    if subcommand == 'log' and (
        re.fullmatch(r'-n\d{1,3}|-\d{1,3}|--max-count=\d{1,3}', token)
        or re.fullmatch(r'--(since|until|author|grep)=[a-zA-Z0-9_./:@+ -]{1,120}', token)
        # Pickaxe: the search text must be attached (-Sfoo), so it cannot be read as a revision.
        or re.fullmatch(r'-[SG][a-zA-Z0-9_./:@+ -]{1,120}', token)
    ):
        return True
    if subcommand == 'blame' and re.fullmatch(r'-L\d{1,6},\+?\d{1,6}', token):
        return True
    return False


def git_flag_error(subcommand, token):
    message = f'disallowed git flag for {subcommand}: {token}'
    if token in GIT_HOST_FLAGS.get(subcommand, ()):
        return f'{message} (available only in host access mode; this session runs in strict mode)'
    allowed = sorted(GIT_SAFE_FLAGS[subcommand])
    if access_mode() == 'host':
        allowed += sorted(GIT_HOST_FLAGS.get(subcommand, ()))
    allowed += GIT_PATTERN_FLAGS.get(subcommand, ())
    hint = f'. Allowed: {", ".join(allowed)}'
    if subcommand in ('log', 'diff', 'show', 'blame'):
        hint += '. Revisions go in args; file filters go in paths'
        if subcommand == 'show':
            hint += "; a file at a revision is '<rev>:<path>'"
    return message + hint


def expand_git_short_flags(subcommand, args):
    """Split combined short flags (`-sb`) into flags this validator knows (`-s`, `-b`).

    Only letters are split, and only when every resulting flag is allowed on its own, so flags that
    take an attached value (`-n5`, `-U3`, `-L1,2`, `-Sfoo`) are left whole.
    """
    out = []
    for token in args:
        if (isinstance(token, str) and re.fullmatch(r'-[a-zA-Z]{2,8}', token)
                and not git_flag_allowed(subcommand, token)):
            parts = [f'-{c}' for c in token[1:]]
            if all(git_flag_allowed(subcommand, p) for p in parts):
                out.extend(parts)
                continue
        out.append(token)
    return out


def split_git_object_spec(token):
    """Parse `<rev>:<path>` for `git show`. Returns (rev, path) or None if the token is not one."""
    if not isinstance(token, str) or token.startswith('-') or ':' not in token:
        return None
    rev, _, path = token.partition(':')
    if not rev or not re.fullmatch(r'[a-zA-Z0-9_./~^-]{1,200}', rev) or rev.startswith('-'):
        raise ValueError(f"invalid revision in '<rev>:<path>': {token}")
    if not path or ':' in path or '\\' in path:
        raise ValueError(f"invalid path in '<rev>:<path>': {token}")
    return rev, path


def validate_git_arg(subcommand, token):
    if not isinstance(token, str) or not token or len(token) > 256 or any(ord(c) < 32 or ord(c) == 127 for c in token):
        raise ValueError('invalid git argument')
    if token.startswith('-'):
        if git_flag_allowed(subcommand, token):
            return
        raise ValueError(git_flag_error(subcommand, token))
    if subcommand in ('status', 'ls-files'):
        raise ValueError(f'pass file filters in paths, not args, for git {subcommand}')
    # Revision argument for log/diff/show/blame: forbid `:` so `<rev>:<secret-file>` cannot bypass pathspecs!
    if ':' in token or '\\' in token or token.startswith('@') or '..' in token and '/' in token:
        if ':' in token:
            raise ValueError(
                f"'<rev>:<path>' is only accepted by git show (to read a file at a revision); for git {subcommand}, "
                "pass the revision in args and file filters in 'paths'"
            )
    if not re.fullmatch(r'[a-zA-Z0-9_./~^-]{1,200}', token):
        raise ValueError(f'invalid git revision token: {token}')


def run_sandboxed_git(root, node_home, patterns):
    raw_req = sys.stdin.buffer.read(65536)
    req = json.loads(raw_req.decode('utf-8'))
    if not isinstance(req, dict):
        raise ValueError('invalid git request')
    subcommand = req.get('subcommand')
    if subcommand not in GIT_SUBCOMMANDS:
        raise ValueError(f'unsupported git subcommand: {subcommand}')
    raw_args = req.get('args') or []
    raw_paths = req.get('paths') or []
    if not isinstance(raw_args, list) or len(raw_args) > 24:
        raise ValueError('invalid git args list')
    if not isinstance(raw_paths, list) or len(raw_paths) > 32:
        raise ValueError('invalid git paths list')

    raw_args = expand_git_short_flags(subcommand, raw_args)
    if len(raw_args) > 32:
        raise ValueError('invalid git args list')
    # `git show <rev>:<path>` reads a file at a revision. The path gets the same checks as `paths`
    # below (pathspec excludes do not apply to object names), and the secret-history guard still
    # blocks show in any repository that ever committed a secret-named file.
    object_specs = []
    if subcommand == 'show':
        rest = []
        for tok in raw_args:
            spec = split_git_object_spec(tok) if isinstance(tok, str) and len(tok) <= 256 else None
            if spec is None:
                rest.append(tok)
            else:
                object_specs.append(spec)
        raw_args = rest
        if len(object_specs) > 8:
            raise ValueError("at most 8 '<rev>:<path>' arguments per git show")

    for tok in raw_args:
        validate_git_arg(subcommand, tok)

    env = hardened_git_env()
    base_git = [
        GIT_BIN, '--no-pager',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.pager=cat',
        '-c', 'color.ui=false',
        '-c', 'protocol.allow=never',
    ]
    top_res = subprocess.run(
        base_git + ['-C', str(root), 'rev-parse', '--show-toplevel'],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if top_res.returncode != 0:
        raise ValueError('not in a Git repository')
    top = workspace(os.fsdecode(top_res.stdout.removesuffix(b'\n')), patterns)
    if root != top and not root.is_relative_to(top):
        raise ValueError('workspace must reside inside the Git repository')
    git_entry = top / '.git'
    if git_entry.is_symlink() or not (git_entry.is_dir() or (access_mode() == 'host' and git_entry.is_file())):
        raise ValueError('only standard directory .git repositories are supported by pi_safe_git')

    # Secret-history guard (Confirmed User Decision #3):
    # Block history-reading subcommands if any secretPaths file was ever committed in repository history.
    if subcommand in GIT_HISTORY_SUBCOMMANDS and patterns:
        secret_specs = []
        for pat in patterns:
            secret_specs.append(f':(glob){pat}')
            secret_specs.append(f':(glob)**/{pat}')
        hist = subprocess.run(
            base_git + ['-C', str(top), 'log', '--all', '-n', '1', '--format=%H', '--', *secret_specs],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if hist.returncode != 0:
            raise ValueError('could not verify repository secret history')
        if hist.stdout.strip():
            raise ValueError(
                'history subcommands (log, show, diff, blame) are blocked in this repository because a '
                'secret-matching file appears in commit history; status and ls-files remain available'
            )

    masks = workspace_masks(top, patterns)
    # Expose top/.git read-only for this single invocation while keeping all other masks intact.
    git_masks = {p: is_dir for p, is_dir in masks.items() if p != git_entry}

    def checked_path(p, base):
        if not isinstance(p, str) or not p or len(p) > 512 or '\x00' in p:
            raise ValueError('invalid git path filter')
        rel = Path(p)
        if rel.is_absolute() or not rel.parts or '..' in rel.parts:
            raise ValueError(f'path must be relative to workspace: {p}')
        if any(is_masked_name(part, patterns) for part in rel.parts):
            raise ValueError(f'protected path is hidden in pi_safe_git: {p}')
        resolved = (base / rel)
        if resolved in git_masks or any(anc in git_masks for anc in resolved.parents):
            raise ValueError(f'masked path is hidden in pi_safe_git: {p}')
        return rel

    validated_paths = [f':(literal){checked_path(p, root).as_posix()}' for p in raw_paths]
    # Object names resolve from the repository top (`<rev>:<path>`), not from the working folder.
    object_args = [f'{rev}:{checked_path(path, top).as_posix()}' for rev, path in object_specs]

    if subcommand == 'blame' and len(validated_paths) != 1:
        raise ValueError('git blame requires exactly one non-protected file in paths')

    bwrap_args = sandbox_args(top, node_home, patterns, writable=False, masks=git_masks, chdir=root)
    for k in ('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
              'GIT_NO_REPLACE_OBJECTS', 'GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS'):
        bwrap_args += ['--setenv', k, env[k]]

    cmd_args = [
        GIT_BIN, '--no-pager',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.pager=cat',
        '-c', 'color.ui=false',
        '-c', 'protocol.allow=never',
        subcommand,
    ]
    if subcommand in ('diff', 'log', 'show'):
        cmd_args += ['--no-ext-diff', '--no-textconv', '--no-color']
    if subcommand == 'log' and not any(a.startswith(('-n', '--max-count=')) or re.fullmatch(r'-\d+', a) for a in raw_args):
        cmd_args += ['-n', '50']
    cmd_args += raw_args
    cmd_args += object_args

    exclude_specs = []
    if subcommand != 'blame':
        for pat in patterns:
            exclude_specs.append(f':(exclude,glob){pat}')
            exclude_specs.append(f':(exclude,glob)**/{pat}')

    if validated_paths or exclude_specs:
        if not validated_paths and subcommand != 'blame':
            cmd_args += ['--', ':(literal).', *exclude_specs]
        else:
            cmd_args += ['--', *validated_paths, *exclude_specs]

    fd = os.memfd_create('pi-sandbox-git-args', flags=0)
    with os.fdopen(os.dup(fd), 'wb') as stream:
        stream.write(b'\0'.join(map(os.fsencode, bwrap_args)) + b'\0')
    os.lseek(fd, 0, os.SEEK_SET)
    os.execv(BWRAP, [BWRAP, '--args', str(fd), '--', *cmd_args])


OUTPUT_MOUNT = '/tmp/pi-tool-output'


def output_mount_args():
    """Mount the session's saved tool output (extensions/output-budget.ts) read-only, if there is one.

    Only a private session folder directly inside ~/.cache/pi-protected/tool-output is accepted, so the
    variable cannot expose any other host path to the sandbox.
    """
    raw = os.environ.get('PI_SANDBOX_OUTPUT_DIR')
    if not raw:
        return []
    base = (Path.home() / '.cache' / 'pi-protected' / 'tool-output').resolve()
    path = Path(raw)
    if not path.is_absolute() or path.is_symlink() or not path.name.startswith('s-'):
        raise ValueError('invalid tool output folder')
    real = path.resolve(strict=True)
    info = real.lstat()
    if (real.parent != base or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise ValueError('invalid tool output folder')
    return ['--ro-bind', str(real), OUTPUT_MOUNT]


def read_precomputed_masks(root):
    masks_fd = os.environ.get('PI_SANDBOX_MASKS_FD')
    if masks_fd is None:
        return None
    if masks_fd != '3':
        raise ValueError('invalid sandbox masks descriptor')
    check_mounts(root)
    with os.fdopen(3, 'rb') as mask_stream:
        payload = json.loads(mask_stream.read().decode('utf-8'))
    if not isinstance(payload, dict) or payload.get('root') != str(root) or not isinstance(payload.get('masks'), list):
        raise ValueError('invalid sandbox masks payload')
    precomputed = {}
    for item in payload['masks']:
        if not (isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and isinstance(item[1], bool)):
            raise ValueError('invalid sandbox mask entry')
        rel = Path(item[0])
        if rel.is_absolute() or not rel.parts or '..' in rel.parts or '.' in rel.parts:
            raise ValueError('invalid sandbox mask path')
        precomputed[root / rel] = item[1]
    return precomputed


def main():
    mode, cwd, *tail = sys.argv[1:]
    patterns = secret_patterns()
    root = workspace(cwd, patterns)
    if mode == '--check':
        if not os.access(BWRAP, os.X_OK):
            raise ValueError('bubblewrap is required; refusing to run without it')
        return
    if mode == '--inspect' and not tail:
        masks, collapsed = effective_masks(root, patterns)
        print(json.dumps({
            'collapsed': [str(path.relative_to(root)) for path in collapsed],
            'maskCount': len(masks),
        }))
        return
    if mode == '--scan-masks' and not tail:
        masks, collapsed = effective_masks(root, patterns)
        print(json.dumps({
            'root': str(root),
            'masks': [[str(path.relative_to(root)), is_dir] for path, is_dir in sorted(masks.items())],
            'collapsed': [str(path.relative_to(root)) for path in collapsed],
        }))
        return
    if mode == '--git' and len(tail) == 1:
        run_sandboxed_git(root, tail[0], patterns)
        return
    if mode == '--sessions' and len(tail) == 1:
        # Read-only session-log digests (host access mode, where the session folders are mounted).
        if access_mode() != 'host':
            raise ValueError('session logs are only readable in host access mode')
        args = sandbox_args(root, tail[0], patterns, writable=False)
        args += ['--ro-bind', str(HERE / 'session-digest.py'), '/opt/session-digest.py']
        fd = os.memfd_create('pi-sandbox-args', flags=0)
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(b'\0'.join(map(os.fsencode, args)) + b'\0')
        os.lseek(fd, 0, os.SEEK_SET)
        os.execv(BWRAP, [BWRAP, '--args', str(fd), '--', '/usr/bin/python3', '-I', '-B', '/opt/session-digest.py'])
    if mode in ('--lsp', '--data') and len(tail) == 1:
        # Read-only helpers: the Python language server (long-lived, stdio JSON-RPC) and the data
        # preview/SQL worker. Same masks and mounts as read-only tools; never writable.
        node_home = tail[0]
        args = sandbox_args(root, node_home, patterns, writable=False, masks=read_precomputed_masks(root))
        if mode == '--lsp':
            server = Path(node_home) / 'lib' / 'node_modules' / 'basedpyright' / 'langserver.index.js'
            if not server.is_file():
                raise ValueError('basedpyright is not installed (run install.sh)')
            entry = ['/opt/pi-node/bin/node', '/opt/pi-node/lib/node_modules/basedpyright/langserver.index.js', '--stdio']
        else:
            args += ['--ro-bind', str(HERE / 'data-tool.py'), '/opt/data-tool.py']
            runtime = HERE / 'data-runtime'
            if runtime.is_dir() and not runtime.is_symlink():
                args += ['--ro-bind', str(runtime), '/opt/pi-data']
            entry = ['/usr/bin/python3', '-I', '-B', '/opt/data-tool.py']
        fd = os.memfd_create('pi-sandbox-args', flags=0)
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(b'\0'.join(map(os.fsencode, args)) + b'\0')
        os.lseek(fd, 0, os.SEEK_SET)
        os.execv(BWRAP, [BWRAP, '--args', str(fd), '--', *entry])
    if mode not in ('--tool', '--shell') or not tail:
        raise ValueError('invalid sandbox operation')
    node_home, *command = tail
    precomputed_masks = read_precomputed_masks(root)
    args = sandbox_args(root, node_home, patterns,
                        writable=os.environ.get('PI_PROTECTED_WRITE_ROOT') == str(root),
                        masks=precomputed_masks)
    args += output_mount_args()
    entry = ['/opt/pi-node/bin/node', '/opt/tool-worker.mjs'] if mode == '--tool' else ['/bin/bash', '-c']
    fd = os.memfd_create('pi-sandbox-args', flags=0)
    with os.fdopen(os.dup(fd), 'wb') as stream:
        stream.write(b'\0'.join(map(os.fsencode, args)) + b'\0')
    os.lseek(fd, 0, os.SEEK_SET)
    os.execv(BWRAP, [BWRAP, '--args', str(fd), '--', *entry, *command])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(f'pi sandbox: {error}')
