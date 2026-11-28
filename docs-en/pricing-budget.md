# Pricing & Budget

## Offline prices + sync

25 built-in prices are available offline. For wider coverage, pull them yourself — there is **no automatic fetch** on the run path (the run path only reads the local cache so it adds no latency and leaks no usage patterns). `pricing sync` fetches via `fetchPinnedUrl`: the hostname is resolved once and the validated IP is pinned to the socket, redirects re-resolve with strict/no-cache DNS, private hosts are rejected, and there is no bypass through a proxy, connection pool, or redirect; responses are capped at 12 MiB. Sync stays explicit-only:

```bash
minicode pricing sync                 # pull the catalogue + prices from models.dev via fetchPinnedUrl (IP-pinned, explicit-only)
minicode pricing status               # active source + cache age + a (stale) marker when older than 1 day
minicode pricing show claude-sonnet-4-5
minicode pricing clear                # back to the built-ins
```

Matching is per segment (`/` and `:` separators), longest key wins. `deepseek/deepseek-chat:free` matches, `claude-sonnet-4-5` beats `claude-sonnet-4`, `my-gpt-4o-wrapper` does not match `gpt-4o`. A `:free` suffix is always $0 unless there is an explicit entry.

A single id often has different prices across providers (`qwen3-coder-plus` exists on 6 providers, two of them $0 due to subscriptions). The overlay drops free candidates when paid ones exist and then takes the **median**, so `--budget` does not treat everything as free. Opus is corrected from `$15/$75 -> $5/$25` (previously 3x too high, which broke budgets).

All figures are **estimates**: real cost depends on the provider, plan, and discounts.

## Budget

```bash
minicode --budget 0.50 "large task"
minicode --budget 0.05 --budget-strict "tight task"
```

- Yellow warning at 80%.
- Over budget: one-shot `exit(1)`, TUI breaks the loop, `exec` enforces it the same way as one-shot (there was once a bug where `exec` ignored `--budget`; fixed).
- The cap is also cut MID-TURN: a live cost watcher (`watchBudgetLimit` in `src/policy/usage.ts`, wired in `cli/setup.ts`) discards the running turn as soon as it goes over — previously the tool loop / self-heal cycles could spend without limit inside one turn. A budget abort carries the `budget_exceeded` kind identity (not a generic `aborted`) so it is distinguishable from a user Ctrl+C.
- Unknown cost (a model with no price) + ANY usage = fail-closed by DEFAULT: treated as over budget rather than ignored (it used to apply only under `--budget-strict`; the old behaviour silently disabled `--budget` for new models). Zero tokens (nothing spent yet, e.g. a new prompt pre-check) still passes.
- `--budget-strict` / `MINICODE_BUDGET_STRICT=1` = an explicit assertion of the fail-closed behaviour above (back-compat; identical to the default).
- Negative/NaN/Infinity prices from a local overlay are rejected during extraction (not as negative costs that reduce the total).
- Values under $1 display with 4 decimals (`$0.0601 > $0.0500`), not a misleading `$0.00`.
- `/status` and (opt-in `MINICODE_STATUSLINE=rich`) the spinner show cumulative tokens + session cost. Session cumulative is kept separate from per-turn (`get()` vs `getSession()`) — an old bug made `/cost` always 0 after the first turn.

## Reading the token numbers

`/status` shows FIVE numbers with different meanings — do not mix them up:

| Row | Source | Meaning |
|---|---|---|
| `Context` | kernel (`estimateSessionContext`) | Estimated size of the CURRENT window (what still fits and is processed) |
| `Turn` | `usage.get()` | Tokens of the LAST turn only (reset each turn) |
| `Input`/`Output` | provider usage events | Cumulative session usage per direction |
| `Total` | `usage.getSession()` | Session cumulative = Input + Output (never reset) |
| `Cost` | offline price table | Estimate, or `N/A` for an unknown model — **no fetch** |

Rule of thumb: large `Turn` + small `Context` = this turn is wasteful in a narrow window (time for `/clear` or a new session); large `Total` + `Cost: N/A` = a model without a price, so `--budget` is fail-closed (treated as over). The per-session token curve can be replayed from `.minicode/step-traces.jsonl` (the `totalTokens` column per line, monotonically increasing); `minicode stats` shows its peak (`Peak tok`).