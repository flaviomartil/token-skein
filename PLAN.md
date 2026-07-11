# TokenSkein implementation plan

Last updated: 2026-07-11  
Target: a measurable, recoverable context-economy layer for GPT clients and Codex  
Current milestone: `0.1.0` experimental MVP

## Objective

Reduce avoidable input, output, and reasoning cost while preserving task correctness and access to exact source material. The system should combine the strongest reusable ideas from pxpipe, Headroom, RTK, Caveman, and the global Claude setup behind one local interface.

Success is not “small prompts at any cost.” Success means lower measured cost for the same accepted task result, with bounded latency, no hidden loss of exact data, and an immediate bypass path.

## Non-goals for the MVP

- claim a universal savings percentage;
- replace provider billing or cache accounting with tokenizer estimates;
- silently modify global Codex or Claude configuration;
- auto-approve arbitrary shell commands;
- send archived context to an external database;
- support every provider protocol before the Responses path is sound;
- make image OCR a substitute for exact source text.

## Principles

1. **Measure the whole task.** Include input, cached input, image input, output, reasoning, retries, latency, and retrieval calls.
2. **Recovery before deletion.** Store exact originals before replacing them with compact views.
3. **Preserve the hot tail.** Keep recent inputs and exact identifiers in text.
4. **Use separate gates.** Schema, text, image, style, effort, and shell optimizations can be independently bypassed.
5. **Fail open for model access, fail closed for permission.** A transform failure should not destroy context; a shell ambiguity should never gain approval.
6. **Prefer inspectable transforms.** Deterministic logic ships before opaque semantic compression.
7. **No savings claim without a baseline.** Estimated tokens guide experiments; provider usage proves economics.

## Work completed

### Phase 0 — source and setup audit: complete

- Inspected the installed pxpipe package and its MIT license.
- Inspected Headroom's compression, retrieval, MCP, schema handling, and Apache-2.0 notices.
- Inspected RTK's rewrite model, command filtering, hook behavior, and Apache-2.0 license.
- Read the relevant global `~/.claude/CLAUDE.md` policies, including Caveman safety bypasses, progressive context loading, RTK usage, and task-based routing.
- Confirmed the Codex custom Responses provider, MCP, global `AGENTS.md`, and hook surfaces available in the local setup.
- Chose Bun and TypeScript to match the surrounding personal toolchain.
- Replaced the colliding working name with **TokenSkein**: multiple optimization strands remain separate but are managed as one token skein.
- Checked the exact final name on 2026-07-11 across general web search, GitHub, npm, PyPI, crates.io, RubyGems, and NuGet before applying it. Availability can still change until a package or repository is registered.

Acceptance evidence: every upstream inspiration is mapped to an implementation decision or an explicit rejection, and third-party licenses are retained.

### Phase 1 — project foundation: complete

- Created the project at `~/projects/token-skein`.
- Added strict TypeScript configuration, Bun scripts, runtime dependencies, and test dependencies.
- Added layered JSON configuration with environment overrides.
- Added an `o200k` token estimator.
- Added Apache-2.0 project licensing and third-party notices.

Acceptance evidence: dependencies install, TypeScript resolves all modules, and configuration loads from defaults, file, environment, and call-site overrides.

### Phase 2 — Responses optimization gateway: complete for MVP

- Added a loopback Bun HTTP proxy with a configurable upstream.
- Added transparent forwarding for non-Responses endpoints.
- Added recursive tool-schema cleanup.
- Added concise-style instruction injection with technical and safety exceptions.
- Added heuristic reasoning-effort selection that respects an existing caller choice.
- Added request headers for bypass, vision, style, and effort overrides.
- Added automatic processing only for old `function_call_output` strings.
- Preserved a configurable recent input tail.
- Added health, statistics, and retrieval HTTP endpoints.
- Added a response header with estimated tokens saved.

Acceptance evidence: an end-to-end test sends a Responses request through the proxy to a mock upstream and inspects the transformed body and savings header.

### Phase 3 — recoverable compaction: complete for MVP

- Added a content-addressed `skein:<24 hex>` archive.
- Added gzip storage, TTL, lookup validation, expiry detection, statistics, and cleanup.
- Restricted store directories to `0700` and object/event files to `0600`.
- Added JSON-shape summarization for valid JSON.
- Added line deduplication, error/warning salience, head/tail retention, and line limits for text.
- Added redaction of common secrets in compacted views.
- Added an exact identifier sidecar for paths, URLs, UUIDs, hashes, environment-style constants, and error codes.
- Added query-based retrieval with neighboring lines.

Acceptance evidence: tests confirm exact retrieval, queried retrieval, content deduplication, expiry, and compaction references.

### Phase 4 — visual lane: implemented, evaluation pending

- Added dense monospace PNG rendering with bounded page count.
- Added explicit model allowlisting.
- Added minimum source size and estimated break-even ratio gates.
- Added a text marker and archive reference alongside visual pages.
- Disabled the lane by default.

Acceptance evidence today: rendering and gate behavior are unit-tested. Release evidence still required: model-specific A/B results showing lower billed input cost without unacceptable correctness loss.

### Phase 5 — MCP and shell lanes: complete for MVP

- Added MCP tools for compression, exact/queried retrieval, and statistics.
- Used high-level MCP server APIs, Zod validation, and structured content.
- Added a Codex `PreToolUse` adapter for recognized `Bash` events.
- Added an opt-in, inspection-only command allowlist plus destructive, compound, substitution, redirect, and dangerous-flag rejection.
- Added optional `rtk rewrite` delegation.
- Added a post-execution output filter that retains more diagnostic lines on failure and archives exact output.
- Added Codex provider, MCP, hook, and optional `AGENTS.md` integration artifacts without mutating global files.

Acceptance evidence: hook tests verify safe rewrites and rejection of destructive or compound commands; shell compaction uses the same recovery store.

### Phase 6 — documentation: complete

- Added this execution plan with status, method, gates, risks, and backlog.
- Added a README with installation, operation, architecture, decisions, feature mapping, limitations, and security boundaries.
- Added both Mermaid and editable Excalidraw architecture diagrams.
- Added source/license attribution.

Acceptance evidence: documentation describes only implemented behavior as current and separates estimates from verified economics.

## Verification snapshot

The 0.1.0 implementation was verified on 2026-07-11 with:

- strict TypeScript `tsc --noEmit` success;
- 11 passing Bun tests, 0 failures, and 49 assertions across six test files;
- an end-to-end proxy request through a mock Responses upstream;
- an MCP initialize and `tools/list` stdio handshake exposing all three tools;
- CLI version, help, and Codex-snippet smoke tests;
- JSON, unique-ID, element-count, and Excalifont checks for the editable Excalidraw diagram;
- relative documentation-link validation;
- a case-insensitive stale-name scan after the TokenSkein rename.

The test suite proves implementation behavior, not real provider savings. The latter remains the gate for milestones 0.2 and 0.3.

## Remaining roadmap

### Milestone 0.2 — trustworthy economics: next

| Task | How | Done when |
|---|---|---|
| Provider usage capture | Parse completed Responses usage fields and streaming terminal events without logging content | Input, cached input, image, output, and reasoning usage are stored per request |
| Price catalog | Version model pricing and attach an “unknown price” state rather than guessing | Cost is calculated only for models with dated pricing metadata |
| Baseline IDs | Correlate baseline and optimized runs by fixture, model, and configuration hash | Every savings result identifies its comparable baseline |
| Cache-aware accounting | Separate prompt-cache read/write economics from uncached input | Reports do not count cached tokens as full-price savings |
| Streaming metrics | Tee SSE streams and inspect only terminal metadata | First-byte latency and streaming behavior remain within the release budget |

### Milestone 0.3 — quality evaluation

| Task | How | Done when |
|---|---|---|
| Fixture suite | Collect representative code search, build logs, test failures, JSON, diffs, docs, and exact-string tasks | Fixtures include benign, failure, secret-bearing, and adversarial cases |
| Mode matrix | Run baseline, schema-only, text-only, vision-only, RTK-only, and combined modes | Each result records quality, cost, latency, retries, and retrievals |
| Exactness grader | Assert required paths, hashes, line numbers, commands, and error messages | No accepted mode loses required exact strings |
| Task grader | Use executable tests or deterministic assertions before model grading | Savings cannot compensate for a failed task |
| Regression thresholds | Establish per-lane budgets instead of one global percentage | CI rejects statistically meaningful quality or cost regressions |

Proposed release gates:

- zero destructive commands auto-approved by the hook corpus;
- zero secrets in compacted views for the maintained redaction corpus;
- 100% recovery of archived originals before TTL expiry;
- no reduction in executable task pass rate against baseline;
- vision lane enabled by default only for a model/content class with positive median cost savings and a non-inferior correctness interval;
- proxy p95 transform overhead below the agreed local latency budget;
- any unsupported or unpriced model reports “unknown,” not synthetic savings.

### Milestone 0.4 — smarter context selection

- Add session-aware history collapse using item relationships and age, not array position alone.
- Add structured reducers for test runners, compilers, Git diffs, directory listings, and search output.
- Add MCP resources for `skein://<reference>` reads and metadata inspection.
- Add local full-text indexing for large archives while retaining content-addressed objects as the source of truth.
- Add a “retrieve before retry” policy so the model fetches omitted details instead of repeating expensive tools.
- Add model- and language-specific effort routing trained from measured outcomes.
- Add visual-content classifiers that reject secrets, source code requiring exact punctuation, low-contrast pages, and poor density.

### Milestone 0.5 — operational hardening

- Add transactional `install`, `doctor`, `verify`, and `uninstall` commands for Codex.
- Detect the active Codex shell tool shape and install only compatible hooks.
- Add process supervision examples and readiness checks.
- Add optional encrypted-at-rest storage with key-management guidance.
- Add bounded archive quotas and least-recently-used cleanup.
- Add concurrency and partial-write stress tests.
- Add request size limits, timeouts, and explicit local authentication if non-loopback binding is ever supported.
- Add dependency and license scanning in CI.

### Milestone 1.0 — supported local product

- Stable configuration schema with migrations.
- Reproducible benchmark report for supported models.
- Small local dashboard for measured cost, quality, latency, cache behavior, and retrieval frequency.
- Documented compatibility matrix for Codex versions and Responses transports.
- Stable install/uninstall lifecycle and rollback.
- Multi-provider work considered only as separate protocol adapters with their own evaluation suites.

## Evaluation design

Each fixture should run the following matrix with the same model snapshot and deterministic settings where available:

| Mode | Schema | Text archive | Vision | RTK/shell | Style | Effort router |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | off | off | off | off | off | off |
| Schema | on | off | off | off | off | off |
| Recoverable text | on | on | off | off | off | off |
| Visual | on | on | on | off | off | off |
| Shell | on | on | off | on | off | off |
| Policy | on | on | off | off | on | on |
| Combined | on | on | gated | on | on | on |

Record:

- provider input, cached-input, image-input, reasoning, and output usage;
- estimated and billed cost under a dated price version;
- transform, first-byte, and end-to-end latency;
- executable task result;
- exact-string precision and recall;
- number and size of recovery calls;
- retries or repeated tools;
- archive bytes and expiry behavior;
- model, snapshot, config hash, fixture revision, and run seed.

The key comparison is whole-task cost at equal quality. A transform that saves the first prompt but causes another tool call, retry, or incorrect edit is a loss.

## Risks and controls

| Risk | Current control | Planned control |
|---|---|---|
| Image tokens cost more than text | Disabled by default, allowlist, break-even estimate | Provider usage calibration per model/detail mode |
| OCR loses punctuation or identifiers | Text marker, identifier sidecar, exact archive | Exactness classifier and hard fixture gates |
| Compression hides the decisive line | Error salience, head/tail, recovery reference | Structured reducers and retrieval-before-retry |
| Archive contains secrets | Loopback default, local permissions, TTL | Optional encryption and quotas |
| Style policy changes behavior | Narrow instruction with explicit bypasses | Output-quality A/B and per-request disable |
| Effort router undershoots | Respect caller choice; explicit header override | Outcome-trained routing and fallback policy |
| Hook expands permission | Safe allowlist and compound/destructive rejection | Compatibility corpus and formal command parser |
| Metrics exaggerate savings | Label estimates; count style overhead | Provider usage and cache-aware dollar reports |
| Global setup becomes bloated | Optional short `AGENTS.md` fragment | Generated minimal profiles by task class |
| Upstream/protocol drift | Thin proxy and bypass header | Versioned compatibility tests |

## Porting method

For each source feature:

1. identify the economic mechanism, not just the implementation;
2. verify its license and preserve attribution;
3. define where it belongs: proxy, MCP, shell, prompt policy, or measurement;
4. reimplement the smallest useful behavior in TypeScript;
5. place lossy or model-dependent behavior behind an independent switch;
6. add a recovery or bypass path;
7. test safety and transformation boundaries;
8. benchmark against an unmodified baseline;
9. promote to a default only after cost and quality gates pass.

## Definition of done

TokenSkein reaches 1.0 when a new machine can install it transactionally, Codex can use it through a documented supported configuration, every transform has a bypass, omitted exact content is recoverable, costs come from provider usage and versioned prices, benchmarks are reproducible, supported modes meet quality gates, and uninstall restores the prior configuration.
