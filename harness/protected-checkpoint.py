#!/usr/bin/python3
"""Snapshot and restore files visible to protected Pi, without running Git filters or hooks."""
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile

# The launcher runs Python in isolated mode; this directory contains installed, trusted code.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox import is_protected, secret_patterns, workspace, workspace_masks

REF_PREFIX = 'refs/pi-protected-checkpoints/'
MAX_REFS_PER_ROOT = 50


class Checkpoint:
    def __init__(self, path):
        self.patterns = secret_patterns()
        self.root = workspace(path, self.patterns)
        self.env = {key: val for key, val in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0',
                        GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1')
        self.git = ['/usr/bin/git', '--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null',
                    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                    '-c', 'commit.gpgSign=false', '-c', 'color.ui=false', '-C', str(self.root)]
        top = self.run('rev-parse', '--show-toplevel', check=False)
        if top.returncode:
            raise ValueError('not in a Git worktree')
        self.top = Path(os.fsdecode(top.stdout.removesuffix(b'\n'))).resolve()
        self.scope = str(self.root.relative_to(self.top))
        self.git[-1] = str(self.top)

    def run(self, *args, check=True, env=None, **kwargs):
        result = subprocess.run(self.git + list(args), env=self.env if env is None else env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
        if check and result.returncode:
            raise ValueError(f'{args[0]} failed: {result.stderr.decode(errors="replace").strip()}')
        return result

    def _has_nested_git_parent(self, path):
        current = path.parent
        while current != self.root and current.is_relative_to(self.root):
            if os.path.lexists(current / '.git'):
                return True
            current = current.parent
        return False

    def _has_symlink_parent(self, path):
        relative = path.relative_to(self.root)
        current = self.root
        for part in relative.parts[:-1]:
            current = current / part
            if os.path.lexists(current) and current.is_symlink():
                return True
        return False

    def _is_untouchable(self, path, masks):
        if path == self.root or not path.is_relative_to(self.root):
            return True
        relative = path.relative_to(self.root)
        if any(part in ('..', '.') or is_protected(part, self.patterns) for part in relative.parts):
            return True
        if path in masks or any(parent in masks for parent in path.parents):
            return True
        if self._has_symlink_parent(path) or self._has_nested_git_parent(path):
            return True
        if os.path.lexists(path) and not path.is_symlink() and path.is_dir() and os.path.lexists(path / '.git'):
            return True
        return False

    def snapshot(self, tmp):
        masks = workspace_masks(self.root, self.patterns)
        paths = self.run('ls-files', '--cached', '--others', '--exclude-standard', '-z',
                         '--', self.scope).stdout.split(b'\0')
        entries = []
        for name in sorted(set(paths) - {b''}):
            path = self.top / os.fsdecode(name)
            if self._is_untouchable(path, masks):
                continue
            # Never read through a directory symlink, or hash the referent of a file symlink.
            if path.parent.resolve() != path.parent:
                continue
            try:
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    mode = b'120000'
                    oid = self.run('hash-object', '-w', '--stdin', input=os.readlink(os.fsencode(path))).stdout
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(fd, 'rb') as file:
                        opened = os.fstat(file.fileno())
                        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                            continue
                        mode = b'100755' if opened.st_mode & stat.S_IXUSR else b'100644'
                        oid = self.run('hash-object', '-w', '--stdin', stdin=file).stdout
                else:
                    continue
            except FileNotFoundError:
                continue  # A tracked deletion is represented by the absent entry.
            entries.append(mode + b' ' + oid.strip() + b'\t' + name + b'\0')

        # Start with an empty index. Unrelated paths and masked content never enter this tree.
        index_env = dict(self.env, GIT_INDEX_FILE=str(Path(tmp) / 'index'))
        self.run('update-index', '-z', '--index-info', env=index_env, input=b''.join(entries))
        return self.run('write-tree', env=index_env).stdout.decode().strip()

    def _create_ref(self, label='checkpoint', keep=MAX_REFS_PER_ROOT):
        with tempfile.TemporaryDirectory(prefix='pi-ckpt-') as tmp:
            tree = self.snapshot(tmp)
            now = datetime.datetime.now(datetime.timezone.utc)
            stamp = now.strftime('%Y%m%d-%H%M%S')
            suffix = f'{now.microsecond // 16:04x}{secrets.token_hex(2)}'
            ref = f'{REF_PREFIX}{stamp}-{suffix}'
            commit = self.run('-c', 'user.name=pi-checkpoint', '-c', 'user.email=pi-checkpoint@localhost',
                              'commit-tree', tree, '-m', f'Protected Pi {label} ({self.root})').stdout.decode().strip()
            self.run('update-ref', ref, commit)
        if keep is not None:
            self.prune(keep)
        return ref

    def create(self):
        print(self._create_ref())

    def refs_for_root(self):
        marker = f'({self.root})'
        out = self.run('for-each-ref', '--sort=-refname', '--format=%(refname) %(contents:subject)', REF_PREFIX).stdout
        matched = []
        for line in out.decode('utf-8', errors='replace').splitlines():
            if ' ' not in line:
                continue
            ref, subject = line.split(' ', 1)
            if subject.endswith(marker):
                matched.append(ref)
        return matched

    def prune(self, keep=MAX_REFS_PER_ROOT):
        if keep < 1:
            raise ValueError('keep must be positive')
        pinned = os.environ.get('PI_PROTECTED_CHECKPOINT_REF')
        refs = self.refs_for_root()
        kept = 0
        for ref in refs:
            if ref == pinned:
                continue
            if kept < keep:
                kept += 1
                continue
            self.run('update-ref', '-d', ref, check=False)

    @staticmethod
    def validate_ref(ref):
        if not re.fullmatch(re.escape(REF_PREFIX) + r'\d{8}-\d{6}-[0-9a-f]{8}', ref):
            raise ValueError('invalid protected checkpoint ref')

    def verify(self, ref):
        self.validate_ref(ref)
        if self.run('cat-file', '-t', ref).stdout != b'commit\n':
            raise ValueError('protected checkpoint is not a commit')

    def _tree_entries(self, ref):
        raw = self.run('ls-tree', '-r', '-z', ref, '--', self.scope).stdout
        entries = {}
        for record in raw.split(b'\0'):
            if not record:
                continue
            header, repo_rel = record.split(b'\t', 1)
            mode, obj_type, oid = header.split(b' ')
            if obj_type == b'commit':
                continue
            entries[repo_rel] = (mode, oid.decode('ascii'))
        return entries

    def restore(self, ref):
        self.verify(ref)
        safety_ref = self._create_ref(label='safety checkpoint')
        masks = workspace_masks(self.root, self.patterns)
        target_entries = self._tree_entries(ref)

        # Remove non-ignored, non-masked files under self.root added since `ref`.
        current_candidates = set(
            self.run('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', self.scope).stdout.split(b'\0')
        ) - {b''}
        dirs_to_prune = set()
        for repo_rel in sorted(current_candidates - set(target_entries)):
            path = self.top / os.fsdecode(repo_rel)
            if self._is_untouchable(path, masks):
                continue
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                continue
            path.unlink(missing_ok=True)
            dirs_to_prune.add(path.parent)

        # Restore modified or deleted files from `ref`.
        for repo_rel, (mode, oid) in sorted(target_entries.items()):
            path = self.top / os.fsdecode(repo_rel)
            if self._is_untouchable(path, masks):
                continue
            # Ensure parent directories exist and contain no directory symlinks.
            rel_parts = path.relative_to(self.root).parts[:-1]
            cur_dir = self.root
            skip = False
            for part in rel_parts:
                cur_dir = cur_dir / part
                if os.path.lexists(cur_dir):
                    if cur_dir.is_symlink() or not cur_dir.is_dir():
                        skip = True
                        break
                else:
                    cur_dir.mkdir(mode=0o755)
            if skip:
                continue
            blob = self.run('cat-file', 'blob', oid).stdout
            if mode == b'120000':
                tmp_link = path.parent / f'.pi-restore-{secrets.token_hex(6)}'
                os.symlink(blob, os.fsencode(tmp_link))
                try:
                    os.replace(tmp_link, path)
                except Exception:
                    tmp_link.unlink(missing_ok=True)
                    raise
            elif mode in (b'100644', b'100755'):
                perm = 0o755 if mode == b'100755' else 0o644
                tmp_file = path.parent / f'.pi-restore-{secrets.token_hex(6)}'
                fd = os.open(tmp_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, perm)
                try:
                    with os.fdopen(fd, 'wb') as handle:
                        handle.write(blob)
                        os.fchmod(handle.fileno(), perm)
                    os.replace(tmp_file, path)
                except Exception:
                    tmp_file.unlink(missing_ok=True)
                    raise

        # Clean up directories emptied by removing added files, stopping at self.root.
        for candidate in sorted(dirs_to_prune, key=lambda p: -len(p.parts)):
            cur = candidate
            while cur != self.root and cur.is_relative_to(self.root):
                if self._is_untouchable(cur, masks):
                    break
                try:
                    cur.rmdir()
                except OSError:
                    break
                cur = cur.parent

        print(safety_ref)

    def review(self, ref, *, summary=False, file=None, limit=16 * 1024, raw=False):
        self.validate_ref(ref)
        selection = self.scope
        if file is not None:
            relative = Path(file)
            if relative.is_absolute() or not relative.parts or '..' in relative.parts:
                raise ValueError('expected a file or directory relative to the launch folder')
            selection = str(Path(self.scope) / relative)
        interactive = (summary or file is not None) and not raw
        with tempfile.TemporaryDirectory(prefix='pi-ckpt-review-') as tmp:
            objects = os.fsdecode(self.run('rev-parse', '--path-format=absolute', '--git-path', 'objects').stdout.removesuffix(b'\n'))
            scratch = Path(tmp) / 'objects'
            scratch.mkdir()
            review_env = dict(
                self.env,
                GIT_OBJECT_DIRECTORY=str(scratch),
                GIT_ALTERNATE_OBJECT_DIRECTORIES=json.dumps(objects, ensure_ascii=False),
            )
            old_env = self.env
            self.env = review_env
            try:
                tree = self.snapshot(tmp)
                args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
                        '--no-relative', '--submodule=short', '--name-status' if summary else '--patch',
                        ref, tree, '--', selection]
                truncated = False
                if interactive or raw:
                    with subprocess.Popen(self.git + args, env=self.env, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL) as child:
                        data = child.stdout.read(limit + 1)
                        truncated = len(data) > limit
                        if truncated:
                            child.terminate()
                        elif child.wait() != 0:
                            raise ValueError('could not compare with the launch checkpoint')
                    if raw:
                        diff = data[:limit].decode(errors='replace') if truncated else data.decode(errors='replace')
                        payload = {'patch': diff, 'truncated': truncated}
                        if truncated and file is None:
                            names_raw = self.run('diff', '--no-renames', '--name-only', '-z', ref, tree, '--', self.scope).stdout
                            scope_prefix = '' if self.scope == '.' else f'{self.scope}/'
                            groups_set = set()
                            for item in names_raw.split(b'\0'):
                                if not item:
                                    continue
                                rel_repo = os.fsdecode(item)
                                if scope_prefix:
                                    if not rel_repo.startswith(scope_prefix):
                                        continue
                                    rel_launch = rel_repo[len(scope_prefix):]
                                else:
                                    rel_launch = rel_repo
                                parts = Path(rel_launch).parts
                                if parts:
                                    groups_set.add(parts[0])
                            payload['groups'] = sorted(groups_set)
                        sys.stdout.write(json.dumps(payload))
                        return
                    print('Changes since launch (includes edits from outside Pi):')
                else:
                    data = self.run(*args).stdout
                    print(f'\nPi: changes since {ref}:')
                if data:
                    diff = data[:limit].decode(errors='replace') if truncated else data.decode(errors='replace')
                    # Do not allow file contents to emit terminal control sequences.
                    sys.stdout.write(re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]', lambda m: f'\\x{ord(m[0]):02x}', diff))
                    if truncated:
                        print('\n[Output truncated]')
                else:
                    print('No checkpointed file changes.')
            finally:
                self.env = old_env


    def numstat(self, ref, max_files=200):
        """Print JSON line counts for files that differ between REF and the current workspace."""
        self.validate_ref(ref)
        with tempfile.TemporaryDirectory(prefix='pi-ckpt-numstat-') as tmp:
            objects = os.fsdecode(self.run('rev-parse', '--path-format=absolute', '--git-path', 'objects').stdout.removesuffix(b'\n'))
            scratch = Path(tmp) / 'objects'
            scratch.mkdir()
            old_env = self.env
            self.env = dict(
                self.env,
                GIT_OBJECT_DIRECTORY=str(scratch),
                GIT_ALTERNATE_OBJECT_DIRECTORIES=json.dumps(objects, ensure_ascii=False),
            )
            try:
                tree = self.snapshot(tmp)
                raw = self.run('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative',
                               '--numstat', '-z', ref, tree, '--', self.scope).stdout
            finally:
                self.env = old_env
        scope_prefix = '' if self.scope == '.' else f'{self.scope}/'
        files = []
        for record in raw.split(b'\0'):
            if not record:
                continue
            parts = record.split(b'\t', 2)
            if len(parts) != 3:
                continue
            added, removed, name = parts
            rel = os.fsdecode(name)
            if scope_prefix:
                if not rel.startswith(scope_prefix):
                    continue
                rel = rel[len(scope_prefix):]
            binary = added == b'-' or removed == b'-'
            files.append({
                'path': re.sub(r'[\x00-\x1f\x7f-\x9f]', '?', rel),
                'added': 0 if binary else int(added),
                'removed': 0 if binary else int(removed),
                'binary': binary,
            })
        total = len(files)
        sys.stdout.write(json.dumps({'files': files[:max_files], 'total': total}))

    def has_changes(self, ref):
        self.validate_ref(ref)
        with tempfile.TemporaryDirectory(prefix='pi-ckpt-check-') as tmp:
            objects = os.fsdecode(self.run('rev-parse', '--path-format=absolute', '--git-path', 'objects').stdout.removesuffix(b'\n'))
            scratch = Path(tmp) / 'objects'
            scratch.mkdir()
            review_env = dict(
                self.env,
                GIT_OBJECT_DIRECTORY=str(scratch),
                GIT_ALTERNATE_OBJECT_DIRECTORIES=json.dumps(objects, ensure_ascii=False),
            )
            old_env = self.env
            self.env = review_env
            try:
                tree = self.snapshot(tmp)
                res = self.run('diff', '--quiet', '--no-ext-diff', '--no-textconv', ref, tree, '--', self.scope, check=False)
                if res.returncode not in (0, 1):
                    raise ValueError('could not compare workspace with checkpoint')
                print('changed' if res.returncode == 1 else 'clean')
            finally:
                self.env = old_env

    def export_tree(self, ref, dest):
        self.verify(ref)
        dest_path = Path(dest)
        if not dest_path.is_absolute():
            raise ValueError('worktree destination must be an absolute path')
        parent = dest_path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent_stat = parent.lstat()
        if not stat.S_ISDIR(parent_stat.st_mode) or parent_stat.st_uid != os.getuid() or (parent_stat.st_mode & 0o077):
            raise ValueError('worktree parent must be a private user-owned directory')
        resolved_dest = parent.resolve() / dest_path.name
        if resolved_dest == self.root or resolved_dest.is_relative_to(self.root):
            raise ValueError('worktree destination must be outside the workspace')
        resolved_dest.mkdir(mode=0o700)
        try:
            target_entries = self._tree_entries(ref)
            scope_prefix = '' if self.scope == '.' else f'{self.scope}/'
            for repo_rel_bytes, (mode, oid) in sorted(target_entries.items()):
                repo_rel = os.fsdecode(repo_rel_bytes)
                if scope_prefix:
                    if not repo_rel.startswith(scope_prefix):
                        continue
                    rel_str = repo_rel[len(scope_prefix):]
                else:
                    rel_str = repo_rel
                rel = Path(rel_str)
                if not rel.parts or any(part in ('..', '.') or is_protected(part, self.patterns) for part in rel.parts):
                    continue
                cur = resolved_dest
                skip = False
                for part in rel.parts[:-1]:
                    cur = cur / part
                    if os.path.lexists(cur):
                        if cur.is_symlink() or not cur.is_dir():
                            skip = True
                            break
                    else:
                        cur.mkdir(mode=0o755)
                if skip:
                    continue
                out_file = resolved_dest / rel
                blob = self.run('cat-file', 'blob', oid).stdout
                if mode == b'120000':
                    os.symlink(blob, os.fsencode(out_file))
                elif mode in (b'100644', b'100755'):
                    perm = 0o755 if mode == b'100755' else 0o644
                    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, perm)
                    with os.fdopen(fd, 'wb') as handle:
                        handle.write(blob)
                        os.fchmod(handle.fileno(), perm)

            wt_git = ['/usr/bin/git', '--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null',
                      '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', str(resolved_dest)]
            subprocess.run(wt_git + ['init', '-q'], env=self.env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            with tempfile.TemporaryDirectory(prefix='pi-wt-init-') as tmp:
                wt_ckpt = Checkpoint(resolved_dest)
                base_tree = wt_ckpt.snapshot(tmp)
                commit = wt_ckpt.run('-c', 'user.name=pi-worktree', '-c', 'user.email=pi-worktree@localhost',
                                     'commit-tree', base_tree, '-m', 'Protected Pi worktree base').stdout.decode().strip()
                wt_ckpt.run('update-ref', 'HEAD', commit)
            print(str(resolved_dest))
        except Exception:
            import shutil
            shutil.rmtree(resolved_dest, ignore_errors=True)
            raise

    def worktree_diff(self):
        with tempfile.TemporaryDirectory(prefix='pi-wt-diff-') as tmp:
            tree = self.snapshot(tmp)
            data = self.run('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
                            '--full-index', 'HEAD', tree).stdout
            sys.stdout.buffer.write(data)

    def apply_patch(self, patch_path):
        patch_file = Path(patch_path)
        fd = os.open(patch_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or (st.st_mode & 0o077):
                raise ValueError('patch file must be a private single-link regular file')
            patch_bytes = handle.read(4 * 1024 * 1024 + 1)
        if len(patch_bytes) > 4 * 1024 * 1024:
            raise ValueError('patch exceeds 4 MiB limit')
        if not patch_bytes.strip():
            raise ValueError('patch is empty')

        # Inspect paths touched by the patch before taking checkpoint or applying.
        stat_res = self.run('apply', '--numstat', '-z', '-', input=patch_bytes)
        records = [item for item in stat_res.stdout.split(b'\0') if item]
        masks = workspace_masks(self.root, self.patterns)
        for rec in records:
            parts = rec.split(b'\t', 2)
            rel_raw = os.fsdecode(parts[-1])
            rel_path = Path(rel_raw)
            if rel_path.is_absolute() or not rel_path.parts or '..' in rel_path.parts:
                raise ValueError(f'unsafe path in patch: {rel_raw}')
            full_target = self.root / rel_path
            if self._is_untouchable(full_target, masks):
                raise ValueError(f'patch touches protected or masked path: {rel_raw}')

        safety_ref = self._create_ref(label='pre-apply checkpoint')
        apply_args = ['apply', '--3way', '--no-unsafe-paths']
        if self.scope != '.':
            apply_args.append(f'--directory={self.scope}')
        apply_args.append('-')
        # Run with temporary index copy so host .git/index is never mutated by --3way!
        with tempfile.TemporaryDirectory(prefix='pi-apply-') as tmp:
            tmp_index = Path(tmp) / 'index'
            real_index = Path(os.fsdecode(self.run('rev-parse', '--path-format=absolute', '--git-path', 'index').stdout.removesuffix(b'\n')))
            if real_index.exists():
                tmp_index.write_bytes(real_index.read_bytes())
            apply_env = dict(self.env, GIT_INDEX_FILE=str(tmp_index))
            res = self.run(*apply_args, env=apply_env, input=patch_bytes, check=False)
            if res.returncode != 0:
                # Fall back to direct working-tree apply check if --3way fails on untracked base blobs
                res2 = self.run(*[a for a in apply_args if a != '--3way'], env=apply_env, input=patch_bytes, check=False)
                if res2.returncode != 0:
                    err = (res.stderr or res2.stderr).decode(errors='replace').strip()
                    raise ValueError(f'patch did not apply cleanly: {err}')
        print(safety_ref)


def main():
    action, path, *args = sys.argv[1:]
    checkpoint = Checkpoint(path)
    if action == 'create' and not args:
        checkpoint.create()
    elif action == 'list' and not args:
        print('\n'.join(checkpoint.refs_for_root()))
    elif action == 'prune' and len(args) <= 1:
        checkpoint.prune(int(args[0]) if args else MAX_REFS_PER_ROOT)
    elif action == 'verify' and len(args) == 1:
        checkpoint.verify(args[0])
    elif action == 'restore' and len(args) == 1:
        checkpoint.restore(args[0])
    elif action == 'export' and len(args) == 2:
        checkpoint.export_tree(args[0], args[1])
    elif action == 'worktree-diff' and not args:
        checkpoint.worktree_diff()
    elif action == 'apply-patch' and len(args) == 1:
        checkpoint.apply_patch(args[0])
    elif action == 'has-changes' and len(args) == 1:
        checkpoint.has_changes(args[0])
    elif action == 'numstat' and len(args) == 1:
        checkpoint.numstat(args[0])
    elif action in ('review', 'summary') and len(args) == 1:
        checkpoint.review(args[0], summary=action == 'summary')
    elif action == 'raw-diff' and (len(args) == 2 or len(args) == 3):
        checkpoint.review(args[0], limit=int(args[1]), file=args[2] if len(args) == 3 else None, raw=True)
    elif action == 'patch' and len(args) == 2:
        checkpoint.review(args[0], file=args[1])
    else:
        raise ValueError('expected create/list/worktree-diff DIR, prune DIR [KEEP], verify/restore/review/summary DIR REF, export DIR REF DEST, apply-patch DIR PATCH, or patch DIR REF PATH')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(f'pi checkpoint: {error}')
