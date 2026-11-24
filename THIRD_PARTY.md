# Third-party code and services

## Included in this repository

| Path | Project | Version | Licence |
|---|---|---|---|
| `harness/extensions/pi-plan/` | [pi-plan](https://github.com/zx06/pi-packages/tree/main/packages/plan), from `zx06/pi-packages` | 0.2.0 (vendored; may include local changes) | MIT, © 2026 pi-packages contributors. See `harness/extensions/pi-plan/LICENSE`. |
| `harness/patch-pi-bundle.py` (quoted fragments) | [Pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`), by Mario Zechner | 1.6.0 | MIT. The patcher contains short excerpts of Pi's bundled JavaScript, used to find and replace text in your installed copy. |

## Used but not included

| Component | Licence | How it is used |
|---|---|---|
| [Pi coding agent](https://github.com/earendil-works/pi) | MIT | The agent this project extends. You install it yourself; `install.sh` patches the installed bundle on your machine. |
| [basedpyright](https://github.com/DetachHead/basedpyright) | MIT | Installed by `install.sh` with npm, for `pi_safe_code` |
| [DuckDB](https://github.com/duckdb/duckdb) (Python package) | MIT | Installed by `install.sh` with uv, for `pi_safe_data` |
| [Bubblewrap](https://github.com/containers/bubblewrap) | LGPL-2.0-or-later | System binary (`/usr/bin/bwrap`), run as a separate process |

## Online services

- `pi_safe_web_search` sends queries to DuckDuckGo's HTML endpoint, then to Mwmbl's public API, then (only with
  your own key) to the Brave Search API.
- `pi_safe_web_fetch` downloads the public URLs the agent asks for.

You are responsible for following each service's terms of use. `pi-signoff --no-web` and `pi-signoff --no-fetch` turn these
tools off.
