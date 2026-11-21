# Contributing

License **MIT** (see `LICENSE`). Public contributions are welcome. Active practice: **Indonesian comments** that explain *why* (not *what*); technical terms stay English.

## Dev setup

```bash
git clone https://github.com/minilabs-id/minicode && cd minicode
bun install
bun test              # offline/hermetic; live & docker are skipped automatically
bun x tsc --noEmit
bun run lint
bun run gate:coverage
```

Requires `bun >= 1.1.13` (`bun:sqlite` does not run on Node; the code also uses
`AbortSignal.any()`, absent in Bun 1.0.x — `minicode` fails fast with a version
message when the runtime is too old).

Dev install notes:

- `@lydell/node-pty` is PINNED EXACTLY in `bun.lock` (not a caret): it is a
  native module with per-platform prebuilds, used only for PTY tests; the next
  beta upgrade must re-validate the PTY probe on Linux + Windows. Deliberately a
  devDependency so a user's `bun add -g` install does not download test-only
  native binaries.
- PTY is unavailable on some Windows machines (ConPTY) — PTY tests are REALLY
  SKIPPED via `test.skipIf` (not a fake pass, see F1 in the CHANGELOG); Linux CI
  instead FAILS when PTY is expected-available but cannot be opened.

## Gate (this order, all green before finishing)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Coverage rises -> raise the minimum in `scripts/coverage-gate.ts` (as of 2026-10-25 the minimum is **87 funcs / 86 lines** — a threshold, not a measured result — + 19 per-file floors for critical modules; funcs raised 86 -> 87 at P13.5). The coverage threshold is keyed to the FAST suite (`bun test` in CI); slow/stochastic gates must not raise the threshold.

## Fast vs slow gate (F4.2)

```bash
bun run gate:fast   # tsc + lint + test + coverage + pack + bash + bench:smoke + audit:harness + gate:telemetry (per commit/CI)
```

Slow/stochastic gates (docker sandbox) stay in `slow.yml` — their failure is an investigation signal, not a PR rejection. The per-commit CI (`ci.yml`) only runs the deterministic ones.

### Package size budget (5,000 KiB)

`bun run gate:pack` measures the tarball size (`npm pack --dry-run`, KiB) and refuses when it **exceeds 5,000 KiB (4.9 MiB)**. The single figure lives in `scripts/pack-budget.ts` — one source for the gate and the tests, so the two cannot drift. This limit is a **regression alarm** (catching `node_modules`/`test` leaking in), not a size target to chase.

The 5,000 KiB limit was approved by the owner on 2026-11-19 (re-baselined from 4,608 KiB after the v7.32–v7.41 total audit: actual package 4,709 KiB / 331 files, ~290 KiB margin). Do not raise the budget without new evidence and owner approval; measure runtime and prunable non-runtime files first.

Other gates:

```bash
bun run gate:bash      # attack-pattern corpus + legitimate commands (auto & allowlist) -> 0 bypass / 0 over-block
                       # the counts are printed by the probe itself; do not copy them into documents
bun run bench:smoke    # fake, CI-safe
bun run vendor:check   # MiniCore provenance (soft; vendor host-editable since v0.16.0)
```

## Layer boundaries (enforced by `test/ui-boundary.test.ts`)

- `cli/` may import `src/ui/` and `src/`; non-ui `src/` is **forbidden** to import `src/ui/`; `src/ui/` is **forbidden** to import `cli/`, non-ui `src/`, `#minicore`.
- Cross-layer wiring goes through DI from the composition root (`cli/index.ts`, `cli/setup.ts`): `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Without injection the default is always deny / fail-closed.
- `providers -> config` one-way (provisioning in `src/providers/provision.ts`, `src/config.ts` is pure IO).
- `src/ui/screens/` screens = pure views (props + callbacks), controllers in `cli/`.
- The non-interactive path is shell-first (append-only scrollback); interactive sessions are ALWAYS the alternate-screen TUI (terminal invariant #1, no linear option).
- Changing cross-layer structure/dependencies -> must update `docs/architecture.md`.

## Code rules

- The upstream kernel `vendor/minicore/src/core/*` is frozen. Approved host overlays live in `scripts/vendor-overlays/` and are applied by `bun run vendor:minicore`; do not edit the vendor tree or `VENDOR.md` by hand. Need a new seam? First prove it cannot be a Tool/Provider/Policy, add a test, then pin it through the generator.
- Limits are centralised in `src/constants.ts` (`LIMITS`) — no scattered magic numbers.
- Every spawn goes through `sanitizeSpawnEnv`; every file write through `atomicWriteText`.
- One source for the ANSI pattern: `ANSI_PATTERN`/`stripAnsi` in `src/ui/render/theme.ts`.
- Production code has zero `as any` / `as never`.
- `c`/`glyphs` in `src/ui/render/theme.ts` are **runtime getters** — never store them in a module-scope `const`.
- Terminal width = columns, not characters: use `displayWidth` etc. from `src/ui/render/width.ts` (CJK/emoji = 2 columns).
- Model/tool/file text is untrusted input: `sanitizeAnsi` first.
- Tool `cwd` comes from `ToolContext.cwd`, not `process.cwd()`.
- Line endings LF, UTF-8 without BOM, `biome` format (2 spaces, 100 columns, double quotes). `bun run format` then `bun run lint` before committing.
- **Line endings are LF across every layer**: committed blobs are always LF (`.gitattributes`: `*.ts text eol=lf`), the formatter asks for LF (`biome.json`: `lineEnding: "lf"`), and editors write LF (`.editorconfig`: `end_of_line = lf`). The working tree must be LF too: on Windows with `core.autocrlf=true`, an old checkout can leave CRLF that is **invisible to `git diff`** (git normalises on comparison) but **visible to `biome check`** as hundreds of format diagnostics. `git checkout-index -f`/a fresh `git clone` restores an LF working tree. `test/helpers/source-eol.ts` normalises EOL for semantic assertions, not to paper over git problems.
- Do not write machine figures into markdown (let CI/the command produce them). If you find a stale figure, correct it and mention the correction.
- Tests: every security/correctness fix carries a regression test that **fails on the old code**. Two-path tools (e.g. `grep`) are tested on both paths. `prompt-engine` fuzzing lives in `test/fuzz-prompt.test.ts`.
- Do not commit unless asked; never commit secrets. Before committing: `git status`, `git diff`, `git log --oneline -10`; stage only what you mean to.