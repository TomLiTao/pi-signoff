#!/usr/bin/env bash
# Install pi-signoff into ~/.local/lib/pi-protected and link ~/.local/bin/pi-signoff.
# PI_SIGNOFF_AS_PI=1 also links ~/.local/bin/pi (an existing link to this install is kept up to date).
# Safe to re-run. Never replaces a real file with a link.
# PI_SKIP_RUNTIMES=1 skips the optional helper runtimes (basedpyright, DuckDB).
# PI_NODE_HOME=/path/to/node-prefix selects the Node install that holds Pi (default: found automatically).
set -euo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROTECTED="$HOME/.local/lib/pi-protected"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_PACKAGE=lib/node_modules/@earendil-works/pi-coding-agent
TESTED_PI=1.6.0

# The Node prefix must hold bin/node and the global Pi package: the sandbox mounts it at /opt/pi-node and
# runs bin/node from there. Self-contained installs (official tarball, nvm, fnm, volta) all qualify.
find_node_home() {
  local candidate root
  for candidate in "${PI_NODE_HOME:-}" "$HOME/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64"; do
    [ -n "$candidate" ] && [ -x "$candidate/bin/node" ] && [ -d "$candidate/$PI_PACKAGE" ] && { printf '%s\n' "$candidate"; return; }
  done
  if command -v npm >/dev/null && root=$(npm root -g 2>/dev/null) && [ -d "$root/@earendil-works/pi-coding-agent" ]; then
    candidate=$(cd "$root/../.." && pwd -P)
    [ -x "$candidate/bin/node" ] && { printf '%s\n' "$candidate"; return; }
  fi
  return 1
}

if ! NODE_HOME=$(find_node_home); then
  echo "pi-signoff: no Node install with Pi found." >&2
  echo "Install Pi with 'npm install -g @earendil-works/pi-coding-agent@$TESTED_PI' using a self-contained Node" >&2
  echo "(official tarball, nvm, fnm or volta), or set PI_NODE_HOME to that Node's prefix." >&2
  exit 1
fi
PI_VERSION=$("$NODE_HOME/bin/node" -p 'require(process.argv[1]).version' "$NODE_HOME/$PI_PACKAGE/package.json")
echo "Pi $PI_VERSION in $NODE_HOME"
[ "$PI_VERSION" = "$TESTED_PI" ] || echo "warning: tested with Pi $TESTED_PI; the bundle patches may not apply to $PI_VERSION (see /doctor)" >&2
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
  have=$("$NODE_HOME/bin/node" -p 'require(process.argv[1]).version' "$NODE_HOME/lib/node_modules/basedpyright/package.json" 2>/dev/null || true)
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
  echo "pi-signoff: $NODE_HOME/bin/pi is missing; reinstall Pi into that Node." >&2
  exit 1
fi
for tool in /usr/bin/bwrap /usr/bin/python3 /usr/bin/git; do
  [ -x "$tool" ] || { echo "pi-signoff: missing $tool" >&2; exit 1; }
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
# bin/pi reads the Node prefix from here (it is not part of the manifest, so /doctor ignores it).
printf '%s\n' "$NODE_HOME" > "$PROTECTED/node-home"
chmod 600 "$PROTECTED/node-home"
install_agent_runtimes
# The bundle patches (trust notice, openable file links) live in the installed Pi; reapply after any Pi update.
/usr/bin/python3 -I "$PROTECTED/patch-pi-bundle.py" apply "$NODE_HOME" \
  || echo "warning: a Pi bundle patch was not applied (see /doctor)" >&2
link "$PROTECTED/pi" "$HOME/.local/bin/pi-signoff"
# Shadowing the stock `pi` command is opt-in; a `pi` link that already points here stays current.
if [ "${PI_SIGNOFF_AS_PI:-0}" = 1 ] || [ "$(readlink "$HOME/.local/bin/pi" 2>/dev/null)" = "$PROTECTED/pi" ]; then
  link "$PROTECTED/pi" "$HOME/.local/bin/pi"
fi

# Recommended Pi settings (default model, long idle timeout, telemetry off). Never overwrites yours.
if [ ! -e "$PI_AGENT_DIR/settings.json" ]; then
  install -D -m 600 "$R/config/pi-settings.json" "$PI_AGENT_DIR/settings.json"
  echo "$PI_AGENT_DIR/settings.json: installed recommended settings (config/pi-settings.json)"
else
  echo "$PI_AGENT_DIR/settings.json exists; left unchanged (compare with config/pi-settings.json)"
fi
[ -s "$PI_AGENT_DIR/auth.json" ] || echo "next: sign in to a model provider (run pi-signoff, then /login)"
