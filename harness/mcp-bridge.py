#!/usr/bin/python3
"""Isolated Bubblewrap Unix-socket bridge for allowlisted protected Pi MCP servers."""
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sandbox  # noqa: E402

BWRAP = '/usr/bin/bwrap'
ENV_KEY_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
FORBIDDEN_ENV_KEYS = {'HOME', 'TMPDIR', 'LD_PRELOAD', 'LD_AUDIT', 'BASH_ENV', 'ENV'}
FORBIDDEN_HOME_PARTS = {
    '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.pi', '.codex',
    '.password-store', '.netrc', '.git-credentials', '.config', '.cache',
}


def read_json_line_fd0(limit=65536):
    buf = bytearray()
    while len(buf) <= limit:
        chunk = os.read(0, 1)
        if not chunk:
            break
        if chunk == b'\n':
            return buf.decode('utf-8')
        buf.extend(chunk)
    raise ValueError('invalid or oversized MCP bridge specification')


def peer_uid(sock):
    fmt = '3i'
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize(fmt))
    _pid, uid, _gid = struct.unpack(fmt, creds)
    return uid


def validate_ro_path(raw_path, workspace_root, home_root, patterns):
    if not isinstance(raw_path, str) or not raw_path or '\x00' in raw_path or len(raw_path) > 1024:
        raise ValueError('invalid MCP path')
    expanded = Path(raw_path).expanduser()
    resolved = expanded.resolve(strict=True)

    forbidden_roots = {
        Path('/'), Path('/home'), home_root, Path('/tmp'), Path('/var'),
        Path('/root'), Path('/proc'), Path('/sys'), Path('/dev'), Path('/run'),
    }
    if resolved in forbidden_roots or str(resolved) == '/etc/shadow':
        raise ValueError(f'MCP bridge refuses broad or sensitive host path: {resolved}')

    if resolved == workspace_root or resolved.is_relative_to(workspace_root):
        raise ValueError(f'MCP bridge refuses workspace path: {resolved}')
    if resolved.is_dir() and resolved != Path('/usr') and workspace_root.is_relative_to(resolved):
        raise ValueError(f'MCP bridge refuses ancestor of workspace: {resolved}')
    if resolved.is_dir() and home_root.is_relative_to(resolved):
        raise ValueError(f'MCP bridge refuses ancestor of home directory: {resolved}')

    if resolved.is_relative_to(home_root):
        rel = resolved.relative_to(home_root)
        if not rel.parts or rel.parts[0] in FORBIDDEN_HOME_PARTS:
            raise ValueError(f'MCP bridge refuses private home path: {resolved}')
        if rel.parts[:3] in (('.local', 'state', 'pi-protected'), ('.local', 'lib', 'pi-protected')):
            raise ValueError(f'MCP bridge refuses protected Pi state path: {resolved}')
        check_parts = rel.parts
    elif resolved.is_relative_to(Path('/tmp')):
        check_parts = resolved.relative_to(Path('/tmp')).parts
    else:
        check_parts = (resolved.name,)

    for part in check_parts:
        if part == '.git' or any(sandbox.fnmatch.fnmatchcase(part, pat) for pat in patterns):
            raise ValueError(f'MCP bridge refuses secret-matching path: {resolved}')

    return resolved


def resolve_server_command(command, node_home, workspace_root, home_root, patterns):
    if not isinstance(command, str) or not command.strip() or '\x00' in command or len(command) > 1024:
        raise ValueError('invalid MCP server command')
    cmd = command.strip()
    if '/' not in cmd:
        for search_dir in (node_home / 'bin', Path('/usr/bin'), Path('/bin')):
            cand = search_dir / cmd
            if cand.exists() and os.access(cand, os.X_OK):
                resolved = validate_ro_path(str(cand), workspace_root, home_root, patterns)
                if not resolved.is_file():
                    raise ValueError(f'MCP command is not a regular file: {resolved}')
                return resolved
        raise ValueError(f'MCP command not found in system or Node PATH: {cmd}')

    resolved = validate_ro_path(cmd, workspace_root, home_root, patterns)
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ValueError(f'MCP command must be an executable regular file: {resolved}')
    return resolved


def build_bwrap_args(spec):
    import json
    if not isinstance(spec, dict):
        raise ValueError('MCP spec must be a JSON object')

    patterns = sandbox.secret_patterns()
    home_root = Path.home().resolve(strict=True)
    workspace_root = Path(spec.get('workspace', '')).resolve(strict=True)
    node_home = Path(spec.get('nodeHome', '')).resolve(strict=True)
    if not node_home.is_dir():
        raise ValueError('invalid nodeHome for MCP bridge')

    cmd_real = resolve_server_command(spec.get('command'), node_home, workspace_root, home_root, patterns)

    raw_args = spec.get('args') or []
    if not isinstance(raw_args, list) or len(raw_args) > 64:
        raise ValueError('invalid MCP args')
    cmd_args = []
    for arg in raw_args:
        if not isinstance(arg, str) or '\x00' in arg or len(arg) > 4096:
            raise ValueError('invalid MCP argument')
        cmd_args.append(arg)

    network = bool(spec.get('network', False))

    raw_ro = spec.get('roBind') or []
    if not isinstance(raw_ro, list) or len(raw_ro) > 16:
        raise ValueError('invalid MCP roBind list')
    ro_paths = [validate_ro_path(item, workspace_root, home_root, patterns) for item in raw_ro]

    raw_env = spec.get('env') or {}
    if not isinstance(raw_env, dict) or len(raw_env) > 64:
        raise ValueError('invalid MCP env object')
    declared_env = {}
    for k, v in raw_env.items():
        if not isinstance(k, str) or not ENV_KEY_RE.fullmatch(k) or k in FORBIDDEN_ENV_KEYS:
            raise ValueError(f'disallowed MCP environment variable name: {k}')
        if not isinstance(v, str) or '\x00' in v or len(v) > 16384:
            raise ValueError(f'invalid MCP environment variable value for {k}')
        declared_env[k] = v

    bwrap = [
        '--unshare-all', '--unshare-user', '--disable-userns',
        *(['--share-net'] if network else []),
        '--die-with-parent', '--new-session', '--clearenv', '--chdir', '/',
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/sbin', '/sbin',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
        '--dev', '/dev', '--proc', '/proc',
        '--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/run',
        '--ro-bind', str(node_home), '/opt/pi-node',
    ]

    for name in ('passwd', 'group', 'ld.so.cache'):
        bwrap += ['--ro-bind-try', '/etc/' + name, '/etc/' + name]

    if network:
        for net_path in (
            '/etc/ssl/certs', '/etc/ca-certificates', '/etc/resolv.conf',
            '/etc/nsswitch.conf', '/etc/hosts', '/run/systemd/resolve',
        ):
            bwrap += ['--ro-bind-try', net_path, net_path]

    mounted_dirs = [Path('/usr')]
    for ro_path in ro_paths:
        bwrap += ['--ro-bind', str(ro_path), str(ro_path)]
        if ro_path.is_dir():
            mounted_dirs.append(ro_path)
            masks, _ = sandbox.effective_masks(ro_path, patterns)
            empty_dirs = {p for p, is_dir in masks.items() if is_dir}
            for masked, is_dir in sorted(masks.items()):
                if not empty_dirs.intersection(masked.parents):
                    if is_dir:
                        bwrap += ['--tmpfs', str(masked), '--remount-ro', str(masked)]
                    else:
                        bwrap += ['--ro-bind', str(HERE / 'empty-secret'), str(masked)]

    if cmd_real == node_home or cmd_real.is_relative_to(node_home):
        cmd_in_sandbox = Path('/opt/pi-node') / cmd_real.relative_to(node_home)
    else:
        cmd_in_sandbox = cmd_real
        if not any(cmd_real == d or cmd_real.is_relative_to(d) for d in mounted_dirs):
            bwrap += ['--ro-bind', str(cmd_real), str(cmd_real)]

    bwrap += [
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'TMPDIR', '/tmp',
        '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'PATH', '/opt/pi-node/bin:/usr/bin:/bin',
    ]
    for k, v in declared_env.items():
        bwrap += ['--setenv', k, v]

    return bwrap, [str(cmd_in_sandbox), *cmd_args]


def serve(socket_path_str):
    import json
    if not os.access(BWRAP, os.X_OK):
        raise ValueError('bubblewrap is required for MCP bridges')

    sock_path = Path(socket_path_str)
    parent = sock_path.parent
    st_parent = os.lstat(parent)
    if not stat.S_ISDIR(st_parent.st_mode) or stat.S_ISLNK(st_parent.st_mode):
        raise ValueError('MCP socket directory must be a non-symlink directory')
    if st_parent.st_uid != os.getuid() or (st_parent.st_mode & 0o077) != 0:
        raise ValueError('MCP socket directory must be private (0700) and owned by current user')

    spec = json.loads(read_json_line_fd0())
    bwrap_args, exec_argv = build_bwrap_args(spec)

    if sock_path.exists():
        sock_path.unlink()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old_umask = os.umask(0o077)
    try:
        server.bind(str(sock_path))
    finally:
        os.umask(old_umask)
    os.chmod(sock_path, 0o600)
    server.listen(16)
    server.setblocking(False)

    children = []
    stopping = False

    def handle_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    sel = selectors.DefaultSelector()
    sel.register(server, selectors.EVENT_READ, data='accept')
    sel.register(0, selectors.EVENT_READ, data='stdin')

    sys.stdout.write('READY\n')
    sys.stdout.flush()

    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    try:
        while not stopping:
            events = sel.select(timeout=0.5)
            children[:] = [p for p in children if p.poll() is None]
            for key, _mask in events:
                if key.data == 'stdin':
                    data = os.read(0, 4096)
                    if not data:
                        stopping = True
                        break
                elif key.data == 'accept':
                    try:
                        conn, _ = server.accept()
                    except OSError:
                        continue
                    try:
                        if peer_uid(conn) != os.getuid():
                            conn.close()
                            continue
                        memfd = os.memfd_create('pi-mcp-bwrap', flags=0)
                        try:
                            with os.fdopen(os.dup(memfd), 'wb') as stream:
                                stream.write(b'\0'.join(map(os.fsencode, bwrap_args)) + b'\0')
                            os.lseek(memfd, 0, os.SEEK_SET)
                            proc = subprocess.Popen(
                                [BWRAP, '--args', str(memfd), '--', *exec_argv],
                                stdin=conn.fileno(),
                                stdout=conn.fileno(),
                                stderr=devnull_fd,
                                pass_fds=(memfd,),
                                close_fds=True,
                                start_new_session=True,
                            )
                            children.append(proc)
                        finally:
                            os.close(memfd)
                    finally:
                        conn.close()
    finally:
        os.close(devnull_fd)
        sel.close()
        server.close()
        try:
            sock_path.unlink()
        except OSError:
            pass
        for proc in children:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    proc.terminate()
        for proc in children:
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    proc.kill()


def write_all_fd(fd, data):
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        written = os.write(fd, view[offset:])
        offset += written


def connect(socket_path_str):
    st = os.lstat(socket_path_str)
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
        raise ValueError('MCP socket is missing or not owned by current user')

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path_str)
    if peer_uid(sock) != os.getuid():
        sock.close()
        raise ValueError('MCP socket peer uid mismatch')

    def pump_stdin():
        try:
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    try:
                        sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    return
                sock.sendall(chunk)
        except OSError:
            try:
                sock.close()
            except OSError:
                pass

    reader = threading.Thread(target=pump_stdin, daemon=True)
    reader.start()
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            write_all_fd(1, chunk)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('--serve', '--connect'):
        sys.exit('pi mcp-bridge: invalid arguments')
    mode, sock_path = sys.argv[1], sys.argv[2]
    if mode == '--serve':
        serve(sock_path)
    else:
        connect(sock_path)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(f'pi mcp-bridge: {error}')
