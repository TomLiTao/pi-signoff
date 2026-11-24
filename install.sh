#!/usr/bin/env bash
# Install pi-plan-gate (Protected Pi) into ~/.local/lib/pi-protected and link ~/.local/bin/pi.
# Safe to re-run. Refuses to replace a real ~/.local/bin/pi that is not a symlink.
# PI_SKIP_RUNTIMES=1 skips the optional helper runtimes (basedpyright, DuckDB).
set -euo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Must match NODE_HOME in bin/pi: the Node install whose global modules hold @earendil-works/pi-coding-agent.
NODE_HOME="$HOME/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64"
PROTECTED="$HOME/.local/lib/pi-protected"
BASE=harness

BASEDPYRIGHT_VERSION=1.40.2
DUCKDB_VERSION=2.0.1

link() {  # link <target> <link-path>
  local target=$1 path=$2
  mkdir -p "$(dirname "$path")"
  if [ -L "$path" ]; then
    ln -sfn "$target" "$path"
  elif [ -e "$path" ]; then
    echo "skip: $path exists and is not a symlink (move it aside first)" >&2; return
  else
    ln -s "$target" "$path"
  fi
  echo "$path -> $target"
}

# Pinned helper runtimes for pi_safe_code (basedpyright, in the Node install mounted read-only into the
# sandbox) and pi_safe_data (DuckDB for the system Python, mounted at /opt/pi-data).
install_agent_runtimes() {
  [ "${PI_SKIP_RUNTIMES:-0}" = 1 ] && return 0
  local have
  have=$(PATH="$NODE_HOME/bin:$PATH" node -p "require('$NODE_HOME/lib/node_modules/basedpyright/package.json').version" 2>/dev/null || true)
  if [ "$have" != "$BASEDPYRIGHT_VERSION" ] && [ -x "$NODE_HOME/bin/npm" ]; then
    echo "installing basedpyright $BASEDPYRIGHT_VERSION (pi_safe_code)"
    PATH="$NODE_HOME/bin:$PATH" npm install -g --no-fund --no-audit "basedpyright@$BASEDPYRIGHT_VERSION" >/dev/null \
      || echo "warning: could not install basedpyright; pi_safe_code will be unavailable" >&2
  fi
  local runtime="$PROTECTED/data-runtime" stamp
  stamp="$runtime/.version-$DUCKDB_VERSION-$(/usr/bin/python3 -c 'import sys; print(sys.version_info[0], sys.version_info[1], sep=".")')"
  if [ ! -e "$stamp" ] && command -v uv >/dev/null; then
    echo "installing DuckDB $DUCKDB_VERSION for /usr/bin/python3 (pi_safe_data)"
    local tmp
    tmp=$(mktemp -d "$PROTECTED/.data-runtime.XXXXXX")
    if uv pip install --quiet --target "$tmp" --python /usr/bin/python3 "duckdb==$DUCKDB_VERSION"; then
      touch "$tmp/${stamp##*/}"
      chmod -R go-rwx "$tmp"
      rm -rf "$runtime"
      mv "$tmp" "$runtime"
    else
      rm -rf "$tmp"
      echo "warning: could not install DuckDB; pi_safe_data previews work, but Parquet and SQL do not" >&2
    fi
  fi
}

if [ ! -x "$NODE_HOME/bin/pi" ]; then
  echo "pi-plan-gate: Pi not found at $NODE_HOME/bin/pi." >&2
  echo "Install @earendil-works/pi-coding-agent 1.6.x into that Node, or edit NODE_HOME here and in bin/pi." >&2
  exit 1
fi
for tool in /usr/bin/bwrap /usr/bin/python3 /usr/bin/git; do
  [ -x "$tool" ] || { echo "pi-plan-gate: missing $tool" >&2; exit 1; }
done

core=(sandbox.py protected-checkpoint.py mcp-bridge.py tool-worker.mjs write-guard.json empty-secret web-search.py
      web-fetch.py data-tool.py patch-pi-bundle.py session-digest.py)
mapfile -t extensions < <(cd "$R/$BASE/extensions" && ls -1 -- *.ts)
mapfile -t plan < <(cd "$R/$BASE/extensions" && find pi-plan -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name LICENSE \) | sort)

install -d -m 700 "$PROTECTED"
(
  # The manifest lets /doctor compare the installed copy with this checkout.
  manifest=$(mktemp "$PROTECTED/.install-source.XXXXXX")
  trap 'rm -f -- "$manifest"' EXIT
  printf '%s\0' "$R" "${manifest##*/}" > "$manifest"
  install -m 700 "$R/bin/pi" "$PROTECTED/pi"
  printf '%s\0' bin/pi pi >> "$manifest"
  for file in "${core[@]}"; do
    install -m 600 "$R/$BASE/$file" "$PROTECTED/$file"
    printf '%s\0' "$BASE/$file" "$file" >> "$manifest"
  done
  for file in "${extensions[@]}" "${plan[@]}"; do
    install -D -m 600 "$R/$BASE/extensions/$file" "$PROTECTED/$file"
    printf '%s\0' "$BASE/extensions/$file" "$file" >> "$manifest"
  done
  mv -fT -- "$manifest" "$PROTECTED/install-source"
)
install_agent_runtimes
# The bundle patches (trust notice, openable file links) live in the installed Pi; reapply after any Pi update.
/usr/bin/python3 -I "$PROTECTED/patch-pi-bundle.py" apply "$NODE_HOME" \
  || echo "warning: a Pi bundle patch was not applied (see /doctor)" >&2
link "$PROTECTED/pi" "$HOME/.local/bin/pi"
