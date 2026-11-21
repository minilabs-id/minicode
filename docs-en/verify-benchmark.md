# Verify & Benchmark

## Auto-verify & self-heal

`--verify` auto-detects the command (`typecheck` -> `test` -> `tsconfig`) or uses `MINICODE_VERIFY_CMD` / `verifyCommand` from config.

Flow: the baseline is tested first (if red, a Health-Check note is attached to the initial prompt) -> main run -> verify -> on failure the agent fixes it (max 3 cycles). Error output is wrapped in a fence so it cannot become prompt injection.

Shadow-git checkpoints: a per-turn snapshot as a tree SHA (O(delta), no file cap, `HEAD`/index untouched, refs point at *trees* so nothing appears in `git log`). `.gitignore` is honoured. Non-repo fallback snapshots files.

Repo-map: per-file symbols (regex, 9 languages) cached in `.minicode/repomap.json` and injected into the system prompt. Tree-sitter is not used — measured reasons in `extractSymbolsAsync` (`src/repo/repomap.ts`).

v0.33 adds a `perf-no-quadratic` guard: reasoning ingest into the right sidebar is incremental (O(n) rather than O(n²)), enforced by `test/perf-no-quadratic.test.ts`.

The secret scrubber redacts `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, and `api_key=...` before text reaches the LLM.

## Benchmark

```bash
bun run bench                            # requires a provider (real resolve rate)
bun run bench:smoke                      # --fake, for CI
bun run bench --tasks path/to/tasks.json # external tasks (SWE-bench format)
bun run audit:harness                    # deterministic checks, no API key (pass/fail/advisory counts printed by the command)
bun run bench --runs 2                   # median of 2 runs
bun bench/runner.ts --fake --memory off  # without RAG/auto-memory
bun bench/runner.ts --fake --memory on   # with RAG + seeded memory
bun bench/runner.ts --provider vyceai-com --model 'vyceai-com::deepseek-v4-flash' --max-steps 6 --timeout 90000  # costly live run: pin provider+model+limit
bun bench/runner.ts --judge-model 'vyceai-com::deepseek-v4-flash-lr'  # score the explanation (the model MUST differ from the actor)
bun run gate:eval                        # lock the battery thresholds (min resolve-rate, max median tokens)
bun run gate:eval --results bench/live.json --min-rate 0.8 --max-median-tokens 8000 --allow-partial
bun bench/eval-gate.ts --results bench/results.json --min-rate 1 --max-median-tokens 5000 --observe-tokens  # observation: tokens do not fail (first 2-3 runs before thresholds are locked)
```

CI runs `test/eval-gate.test.ts` to test the evaluator deterministically
without a provider, then runs the `gate:eval` CLI against the `bench:smoke`
output and checks that fake results are rejected. `bench:smoke` only tests the
harness wiring; only results explicitly labelled `fake: false` can be scored, so
fake results or old artefacts without provider provenance are declared not
evidence of quality. Live quality evaluation must still use stored results from
a real provider, plus the budget/provider chosen by the operator. PR and publish
CI do not run paid providers or use model secrets; live evaluation stays manual
because the result, model, and budget must be chosen explicitly by the operator.

The deterministic score uses the actual total steps of all runs against the
total step limit provided. This value comes from `usage.steps` when the run
completes, or the `step:started` events if the run ends in error; the configured
limit is no longer used as a substitute for actual steps.

Metrics: resolve rate, steps, tokens, cost, duration, memoryHits + the delta vs the previous run. Results in `bench/results.json` (`--out` for another path). Each failed run carries a class (`VERIFY_FAIL`/`MAX_STEPS`/`NO_PROGRESS`/`ABORT`) + a global distribution at the end of the run; the methodology card + observation log live in `bench/HARNESS-CARD.md`.

Every run uses its own hermetic `MINICODE_HOME` (no DB/memory/global session leaks between runs and no touching the operator's `~/.minicode`). A task may carry `seedMemory`: facts seeded into that run's memory — the `follow-convention` task only passes if the agent reads those facts, so `bun bench/runner.ts --memory on` vs `--memory off` measures the value of memory differentially (not as a claim).

`tasks.json` format:

```json
[
  {
    "id": "fix-issue-1",
    "prompt": "Fix the bug in buggy.ts",
    "files": [{ "path": "buggy.ts", "content": "export function f(){ return 1 }" }],
    "verify": ["export function f()", "!return 1"]
  }
]
```

SWE-bench Lite: `bench/swebench.ts` + `bench/swebench_lite_20.jsonl` (20 real instances, 12 repos, base_commit spot-checked) + `bench/docker/` (5 Python 3.6-3.10 images + `manifest.json` + `--docker`). The harness applies `test_patch` first (without it the score is fiction). A real run is recorded at 0/20 (`nemotron-3.5-lightning-free`, 25 steps) with environment-validity caveats (Python 3.14 vs the 2022 era) — a comparable score needs per-instance Docker.

Adversarial experiments (separate from the default gate):

```bash
bun experiments/bash-bypass-probe.ts  # denylist posture (0 bypass = pass)
```