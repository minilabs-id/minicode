# Code audit — harness through terminal UI

Audited candidate: `e6e50a7`, package `minicode-ai@0.25.0`. Environment: Windows, Bun 1.4.3. Initial checkout clean. Only this report and `experiments/code-audit-e6e50a7.ts` were added; application code was not changed.

## Assessment

**Overall: 6.5/10.** The architecture has useful separation and substantial defensive engineering, but important guarantees vary between execution paths. In particular, a changed permission mode can fail to stop an already-authorized pending effect, background execution can use a different directory from the session workspace, and cancellation does not consistently reach active work. Terminal rendering is better defended than terminal input recovery.

These are qualitative engineering ratings, not a vulnerability score or release certification.

| Area | Score | Evidence and interpretation |
| --- | --- | --- |
| Architecture and layering | 8/10 | Kernel/application/UI separation, explicit composition and tested import boundaries. Several large stateful modules make cross-path invariants hard to maintain. |
| Harness and cancellation | 6/10 | Bounded retries, provider guards and effect barriers exist; revocation and abort guarantees differ by path. |
| Context and compaction | 6/10 | Shared budget formulas, loss markers and tool-pair retention; oversized retained turns can escape the compaction target. |
| Tools and security boundaries | 6/10 | Approval fingerprints, filesystem checks, sandbox refusal and subprocess environment scrubbing; cwd mismatch and OS-sandbox cancellation undermine consistency. |
| Persistence | 7/10, provisional | Transactional append-only checks, writer epochs, live-run shrink refusal and projection invalidation are strengths. Identity/timestamp semantics deserve redesign review. No crash-injection validation was performed. |
| UI rendering | 8/10 | Sanitization regressions, display-cell handling, incremental rendering and bounded transcript storage. Long-transcript eviction has an avoidable cache cost. |
| UI input and recovery | 5/10 | Malformed input can wedge the decoder; ordinary unsupported modified keys become Escape. |
| Testing | 7/10 | Typecheck/lint and 97 targeted tests pass, while independent probes reproduce missing scenarios. Passing tests do not establish all-path behavioral guarantees. |

## Method and limits

Read architecture and terminal-contract documentation, then inspected kernel dispatch, application permission/effect integration, executor scheduling, provider guards/router, context budgeting/compaction, subprocess execution and sandbox adapters, DNS validation, filesystem guards, history persistence, terminal input, rendering and transcript retention. Narrow parallel source reviews were cross-checked against callers/tests where findings were retained.

This is a deep targeted audit, not an exhaustive review of every file. Scheduler/daemon orchestration, all MCP/LSP integrations, real provider services, OS-specific PTY behavior and persistence crash recovery remain incompletely assessed. Native macOS/Linux sandbox execution was not available for runtime verification on this Windows host. No network attack or filesystem race exploit was attempted. The report distinguishes runtime reproduction, source-confirmed behavior, and design risks.

Validation:

- `bun run typecheck`: passed on the final probe code.
- `bun run lint`: passed on the unchanged application/test candidate, 708 files. The repository lint configuration excludes `experiments`; TypeScript includes it.
- Six selected test files: **84 pass, 0 fail, 297 assertions** — executor-abort, prompt-engine, ui-boundary, sanitize-render, provider-guards, tokenizer-registry.
- `test/context-budget.test.ts`: **13 pass, 0 fail, 59 assertions**.
- `bun run experiments/code-audit-e6e50a7.ts`: all characterization assertions passed and printed the observations described below.
- Full suite, coverage gate, package gate, live-provider benchmarks and the repository harness audit were not run. This audit does not certify release readiness.

The probe uses in-memory tools, a mocked fetch, and a mocked allowlist store for session tests. Its only real subprocess prints its working directory; both candidate directories are inside the workspace. It deliberately asserts current faulty behavior, so it should be converted into regression tests asserting corrected behavior during remediation. It is not a replacement for regression tests.

## Priority findings

Severity convention: **High** means a meaningful effect boundary or user-control failure under the stated trigger; **Medium** means a bounded reliability/functionality defect. A high rating does not imply remote exploitability.

### A1 — High: pending effects survive permission or work-mode revocation

Evidence: `src/app/session.ts:435–464`, runtime controls at `486–506`.

The effect barrier obtains an `allow` decision, awaits the no-progress detector and `beforeToolEffect`, verifies the approval fingerprint, and returns `allow`. It never checks whether permission/work mode changed during those awaits. The fingerprint verifies approved arguments/file state, not the current authorization policy.

**Reproduced:** an in-memory `write_file` receives approval in EXECUTE/auto, then `beforeToolEffect` switches to DISCUSS. The tool still executes once. Switching permission mode to readonly produces the same result. No actual file is written by the probe.

Impact: an API integration that revokes authority while the barrier is awaiting cannot rely on the revocation preventing a pending effect. The TUI currently freezes normal mode-switch keys while busy (`src/ui/tui/app.ts:729–753`), so the probe establishes the session API race, not that this is reachable by pressing Tab during a busy TUI turn.

Recommendation: version the session's authorization state. Bind authorization to its version and synchronously validate it at the final dispatch boundary after asynchronous preparation. If it changed, deny/re-evaluate using a deliberate policy that does not silently reuse stale approval or unexpectedly prompt twice. A mode change should invalidate affected queued grants.

Acceptance test: pause the barrier, revoke permissions, release it, and assert zero effects; cover both work mode and permission mode, including queued concurrent tools.

### A2 — High: background commands default to the launcher's directory

Evidence: `src/tools/bash.ts:350–375`, `startBackground` at `252–268`; foreground uses `effectiveCwd` at `444`.

When the tool receives no `cwd` argument, `resolvedCwd` is undefined. The foreground path uses `resolvedCwd ?? sessionRoot`, but background execution passes `resolvedCwd` directly to spawn. The subprocess inherits `process.cwd()`.

**Reproduced:** context cwd `D:\Github\minicode\docs`, no tool cwd argument, background `cd`. Output is `D:\Github\minicode`.

Impact: relative commands run against a directory different from the session workspace used for authorization. This can read or modify the wrong project. It matters when session cwd differs from process cwd, including embedding/multiple-workspace scenarios.

Recommendation: pass `effectiveCwd` to `startBackground` and centralize the spawn specification shared by execution modes.

Acceptance test: use different launcher/session directories inside a test fixture and verify both foreground and background default to the session directory. Cover relative explicit cwd too.

### A3 — High: OS sandbox processes do not observe turn cancellation

Evidence: `src/tools/bash.ts:405–419`; `src/sandbox/os.ts:61–65`, `163–208`.

The OS adapter accepts timeout/env/network options but no AbortSignal. The bash caller passes no signal and performs no post-execution abort check. The subprocess is detached, and explicit process-group termination occurs on timeout. Docker, by comparison, receives `ctx.signal` and checks it after return.

**Source-confirmed; native runtime verification not performed on Windows.** Cancelling a turn does not itself stop an already-running Seatbelt/bubblewrap command; it may continue mutating permitted workspace files until completion or timeout. An executor abort race can return control while the process continues.

Recommendation: use a shared subprocess lifecycle contract with signal propagation, already-aborted handling, process-group termination/escalation, listener cleanup and distinct abort/timeout outcomes. Apply it to bash and code execution callers.

Acceptance test on macOS/Linux: abort a sandboxed process with a child, verify both terminate, and verify the command cannot perform a delayed workspace write after cancellation is acknowledged.

### A4 — High: malformed CSI/SS3 can permanently block keyboard decoding

Evidence: `src/ui/input/prompt-engine.ts:559–609`, lone-Escape flush at `619–627`.

For an invalid byte inside a CSI/SS3 sequence, parsing stops without consuming the malformed prefix. The full buffer stays pending. Only a single Escape is flushed by the timeout path, so later bytes repeatedly hit the same invalid position.

**Reproduced:** feed `ESC [ Ctrl+C`, then `hello`, Escape and Ctrl+D. No keys are emitted and all ten bytes remain pending. Continued input grows the retained buffer.

Impact: input routed through this decoder, including its recovery keys, becomes unavailable. This is an input availability defect; the audit does not claim remote provider output can directly inject bytes into stdin.

Recommendation: distinguish incomplete valid prefixes from malformed sequences. Consume/resynchronize invalid prefixes while preserving subsequent independently decodable control keys. Bound pending sequence length and define recovery for abandoned sequences.

Acceptance tests: invalid-byte cases at every chunk boundary; assert subsequent text/abort/quit decodes, pending memory stays bounded, and valid split sequences still work. Property/fuzz tests are especially suitable here.

### A5 — Medium: unsupported modified keys become Escape

Evidence: `src/ui/input/prompt-engine.ts:825–826`; UI Escape actions at `src/ui/tui/app.ts:701–719`, abort escalation at `602–615`.

**Reproduced:** Ctrl+Up encoded as `\x1b[1;5A` decodes as `esc`. Unrecognized CSI sequences fall into this behavior.

Impact: a navigation key may clear an idle draft, abort a busy turn, or participate in repeated-abort escalation. Popup/selection state can intercept Escape, so the exact effect depends on UI state.

Recommendation: explicitly decode supported modified keys; return `ignore` for well-formed unsupported sequences. Only an actual standalone Escape should initiate Escape behavior. Update terminal-contract documentation and protection tests when semantics change.

Acceptance test: feed unsupported modified navigation and terminal report sequences through both decoder and TUI; assert draft preservation and no abort/quit request.

### A6 — Medium: abort latency depends on executor batch classification

Evidence: `src/policy/executor.ts:137–175`, `245–277`; kernel tool invocation in `vendor/minicore/src/core/executor.ts`.

Mixed/read batches and keyed write workers await an in-flight `runCall` without racing cancellation. The unkeyed write path explicitly races AbortSignal.

**Reproduced:** an in-memory tool pauses on a manually released promise and ignores AbortSignal. After abort, read-only, keyed-write and mixed batches remain unsettled; unkeyed-write execution settles before the tool is released. The probe then releases every tool to avoid leaving dangling work.

Impact: user cancellation can hang behind noncooperative extension tools in some executor paths. A fast return alone does not prove the underlying effect stopped.

Recommendation: define cancellation semantics once for every executor path. Track outstanding operations until actual completion, keep locks until underlying effects end, and record unresolved effects as unknown. Do not merely add Promise.race everywhere and prematurely release exclusion or start replacement work over still-running effects.

Acceptance tests: the complete batch/queue/running matrix, plus assertions for no late side effects after termination, no lock overlap, no leaked promises/listeners, and truthful outcome state.

### A7 — Medium: compaction can return far above its target

Evidence: `src/policy/compaction.ts:93–110`, `245–254`, `280–295`.

The active-turn fallback is selected by unchanged message count. If earlier turns are removed but the retained latest turn is still oversized, that fallback is skipped. `fitSummaryToTokenBudget` then returns the oversized tail when it alone exceeds the target, and the bounding function performs no final check after mechanical fallback.

**Reproduced:** five messages containing an older exchange and a current tool result compact to three messages. Target: **4,096 tokens**. Returned estimate using the production estimator: **27,023 tokens**.

Impact: compaction reports a reduced history without establishing admission feasibility. Downstream admission/recovery may reject or need another pass; this probe does not claim an oversized request necessarily reaches a provider. A later pass may succeed, which still leaves an avoidable recovery cycle.

Recommendation: measure token feasibility after every fallback. If the protected tail is too large, compact completed activity within the active turn while preserving pending tool-call invariants and authoritative user constraints, or return an explicit cannot-fit result. Use a progress bound and distinguish message reduction from actual token reduction.

Acceptance test: multiple older turns plus one oversized latest turn, as well as tool-result pairs, image payloads, multilingual text and irreducible current instructions. Assert the final target or an explicit failure state.

### A8 — Medium: tokenizer disable flag does not prevent fetching

Evidence: `src/policy/tokenizer-registry.ts:43–44`, `74–99`; session startup call at `src/app/session.ts:550`.

`getCachedTokenizer` respects `MINICODE_TOKENIZERS=0`, but `loadTokenizer` treats that null result as a cache miss and continues to download. Successful parsing also attempts to populate memory/disk cache.

**Reproduced with mocked fetch:** disabled flag plus a recognized qwen model results in one fetch call. The mock returns 404, avoiding network/cache mutation. The successful-write path is established from source, not exercised.

Impact: an operator opt-out does not prevent network activity, download cost or cache-write attempts.

Recommendation: enforce the disabled flag at the top of the loader before any cache/network work. Consider deduplicating concurrent loads and making tokenizer loading an explicit background service with cancellation and diagnostics.

Acceptance test: when disabled, zero fetch and filesystem operations for recognized models, regardless of existing cache state.

## Design risks and additional critique

### Network validation is not a complete SSRF boundary

`src/tools/web_fetch.ts:109–146` acknowledges that DNS checking and connection resolution are separate. Redirect targets are validated and all DNS answers are checked for private addresses, which are meaningful protections. However, calls omit `strict: true`; lookup failure/timeout returns false in `src/lib/net.ts:113–121`, allowing fetch to proceed. DNS rebinding between validation and connection remains possible in the design.

This is a source-confirmed limitation, not a reproduced private-network request. Recommendation: fail closed for tool-facing DNS validation and use a connection mechanism bound to approved addresses while preserving correct hostname/TLS validation; validate every redirect through the same mechanism. Exercise synthetic resolver transitions in tests rather than probing real private services. Shell regex guards likewise should be described as heuristics; strong containment belongs to a functioning OS/container sandbox.

### Budget contracts contradict both the implementation and intentional tests

`src/policy/context-budget.ts:57–68` says reserve must never exceed 40%, but `test/context-budget.test.ts:42–46` intentionally gives the 4,096 floor precedence. At an 8,192 window, reserve is 4,096, compact trigger 2,458, warning 0 and blocking limit 1,096. This is a deliberate small-model usability tradeoff, not an unnoticed test omission.

Separately, the monotonicity statement at `context-budget.ts:95–98` is false at the 64,000 threshold: default compact trigger falls from **31,200** at 63,999 to **31,000** at 64,000. This is a low-severity formula/contract inconsistency.

Recommendation: specify supported minimum windows and feasible reserve/buffer precedence. Use continuous formulas or document the discontinuity. Test boundary neighborhoods and ordering properties across the supported domain, not just a handful of common window sizes.

### Compacted working memory and durable event identity are coupled

`src/session/persistence.ts:3678–3754` deletes/reinserts history transactionally. Identity is adopted only for identical messages at the same position. Thus `[A,B,C] -> [summary,C]` gives retained C a new ID and no run attribution. Even same-position adopted messages receive `now` because original timestamps are not selected.

These behaviors are source-confirmed; the same-position identity rule is intentionally tested in `test/history-event-id.test.ts:243–259`. Treat this as a design decision to reconsider, not an accidental corruption claim. Transactionality, epoch validation, live-run refusal and projection invalidation are good safeguards.

Ideal direction: preserve immutable execution events separately from the bounded model-context projection. Let a compacted projection reference source IDs/ranges and carry its own creation time, rather than replacing historical identity. If retained events keep their IDs, decide explicitly whether their occurrence timestamps must survive. This is a migration requiring compatibility and recovery tests, not a small refactor.

### Transcript eviction repeatedly invalidates reusable work

`src/ui/tui/transcript.ts:1646–1679` shifts multiple arrays and clears the whole row cache when the transcript exceeds its retention cap. Once at the cap, each appended logical row incurs shifts and invalidates still-retained projections.

This is a source-level performance concern; no frame-latency regression was benchmarked. Rendering already uses cell diffs, width-aware graphemes and projection caches, so the local optimization should preserve that architecture. A deque/ring buffer plus cache keys based on stable row IDs can avoid reindexing costs. Benchmark sustained append at the cap, resize and scroll, not only startup or short transcripts.

### Maintainability: too many paths own pieces of the same guarantee

The strongest defects are inconsistencies between adjacent paths: permission approval versus post-await dispatch, foreground versus background cwd, Docker versus OS cancellation, and keyed versus unkeyed executor abort. Large files amplify this: persistence is about 4,100 lines, TUI app about 1,870 and transcript about 1,684 in this candidate.

File size alone is not a defect. The useful decomposition is by invariant: one authorization snapshot/validation mechanism, one subprocess lifecycle adapter, one tool outcome model, and one terminal input decoder with explicit malformed/unsupported states. Avoid splitting files cosmetically while leaving shared invariants duplicated.

For UI semantics, distinguish abort requested, process stopping, stopped, and outcome unknown. Do not let an acknowledgement of a signal imply that every effect has ceased. The input recovery defects should be fixed before additional popup polish. Screen-reader and real-terminal accessibility were not exercised; they need dedicated evaluation rather than an unsupported score claim.

## Strengths worth preserving

- Architectural import boundaries are enforced in tests; UI avoids importing the kernel or business layer directly.
- Permission decisions fail closed when the application receives a non-allow value, and approval grants bind arguments/file fingerprints to the effect boundary.
- Filesystem helpers include canonical containment, sensitive-path checks, no-follow behavior and descriptor identity/hardlink checks. General race concerns were not promoted to vulnerabilities without caller-level proof.
- Provider router avoids fallback after substantive output, reducing duplicate text/tool risks. Kernel explicitly handles length, abort and error finish reasons; an initial concern about those being ignored was ruled out in caller review.
- Subprocess outputs are capped; environments and output are scrubbed; background jobs have session ownership checks; explicit sandbox requests refuse silent downgrade by default.
- Persistence protects append-only prefixes and coordinates history/run cursor updates transactionally.
- Terminal sanitization and Unicode cell handling have focused regression coverage. Transcript retention and pending text limits address unbounded growth.

## Recommended order of work

1. **Repair user-control and effect boundaries:** A1 permission revocation, A2 background cwd, A3 OS cancellation, A4 malformed input and A5 unsupported-key handling. Add regression tests at public session/tool/UI boundaries. Update the terminal contract for changed key behavior.
2. **Unify cancellation and outcomes:** A6 through a shared lifecycle; require explicit unknown outcomes when effects cannot be proven stopped. Validate actual subprocess termination and lock safety, not only quick promise rejection.
3. **Make context and configuration contracts truthful:** A7 compaction feasibility, A8 tokenizer opt-out, explicit small-window policy and threshold tests.
4. **Strengthen the architecture incrementally:** shared process execution specification, authority versioning, stable transcript IDs and eventual separation of durable events from model-context projections. Tighten DNS validation with a transport-level strategy.
5. **Validate the repaired candidate:** focused reproductions converted to regression tests, then the current repository gate sequence, supported-platform process/PTY checks and long-session performance scenarios. All release claims must refer to the same tested candidate.

The immediate goal should be making existing guarantees consistent across paths. That will improve trust and maintainability more than adding more special cases to the current branches.
