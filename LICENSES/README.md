# Third-party attribution

TokenSkein is an independent Bun/TypeScript implementation that combines selected mechanisms from several tools. The project source is Apache-2.0; the root [LICENSE](../LICENSE) contains the complete Apache License 2.0 text.

| Project | Upstream inspected | License | Adapted concepts |
|---|---|---|---|
| pxpipe / claude-image-proxy | `teamchong/pxpipe` and the locally installed `pxpipe-proxy` package | MIT | Dense text-to-PNG rendering, model allowlisting, economic gate, recent exact-text tail |
| Headroom | `headroom-ai/headroom` and the locally installed Python package | Apache-2.0 | Compress-cache-retrieve, TTL archive, targeted recovery, MCP interface, tool-schema cleanup |
| RTK | `rtk-ai/rtk` and the local checkout | Apache-2.0 | Optional command rewrite, safe hook boundary, compact shell output |
| Global Claude setup | User-owned `~/.claude/CLAUDE.md` | User-owned configuration | Concise style with safety bypass, progressive disclosure, task-complexity routing |

Retained files:

- [pxpipe-MIT.txt](pxpipe-MIT.txt) — complete pxpipe MIT license;
- [headroom-NOTICE.txt](headroom-NOTICE.txt) — Headroom's upstream notice, including its optional dependency notices;
- [../NOTICE](../NOTICE) — combined attribution and modification notice.

RTK and Headroom use Apache-2.0, whose full terms are already provided by the root license. Their copyright and origin notices are retained in `NOTICE`.

Runtime dependencies have their own license files under their installed packages and are not vendored into this repository.

