# Repository Guidelines

## Project Overview

Two artefacts in one repo:

1. `demo/` — an offline mirror of the official shapez.io **web DEMO**, build `8a79de52` (`1.5.7`). Prebuilt upstream bundle; not our code.
2. `solver/` — the **ALL SHAPE YOU NEED solver**. Input: a map seed (`bun run cli all 47742`). Output: one campaign sheet — tile-accurate building placements, port-to-port material flow and a BOM for every shape the campaign needs, all factories on one shared map delivering into the same hub.

The underlying solver still targets *arbitrary* shapes (single shapes remain available through `bun run cli solve`); the 26 full-game levels and 9 demo levels are only the regression corpus. Everything runs on **Bun ≥ 1.4.4** with **strict TypeScript**, **zero runtime dependencies** and **no build step**: `@types/bun` is the single devDependency, `bun check` is the type gate, and Bun executes the `.ts` sources directly (no bundler, no transpile step on disk).

## Architecture & Data Flow

Two loosely coupled halves live under `solver/src/`:

- **Shape algebra + planning (pure, no I/O):** `shape.ts` → `plan.ts` → `solver.ts`.
- **World/layout (reads savegames, writes SVG):** `savegame.ts`, `lz_factory.js` (vendored JS), `map.ts`, `layout.ts`, `schematic.ts`, `render.ts`.

### Solve pipeline

```
shape code string
  → P.parseTarget → S.parse              plan.ts:338, shape.ts:150
  → new Solver({buildings}).planShape    solver.ts:432
  → plan AST {op, cost, children}        plan.ts:81
  → P.verifyPlan → flatten → evalNode    plan.ts:322, :227, :137
  → S.equals / S.computeHash             shape.ts:229, :209
  → { ok, target, plan, flat, cost, verification, stats }
```

`verifyPlan` is the oracle: the emitted plan is **re-simulated** through the real stack/cut/paint semantics and compared to the target. Nothing is trusted because the search said so.

Blueprint path: `solve` → `scanMap` / `nearestPatch` (`map.ts`) → `buildLayout` (`layout.ts:571`) → `schematicSVG` (`schematic.ts:132`) → SVG file.

### Shape representation

- `shape = { layers, __hash? }`; `layer` = 4-element array of `cell | null`; `cell = { t, c }`.
- Quadrant order **q0=top-right, q1=bottom-right, q2=bottom-left, q3=top-left**; layer 0 is bottom, max 4 layers.
- Code format: 8 chars per layer, `--` = empty. Types `C R S W`; colors `r g b y p c w u` (`u` = uncolored).
- Quadrant subsets are 4-bit int masks.
- Ops are **copy-on-write** and return new shapes, except the memoised `shape.__hash` mutation.

### Plan model and search

- Plan node: `{ op, cost, children }`; `cost` = number of buildings, and `base` (a miner) costs **0**.
- Ops: `base`, `rotate`, `cutHalf(side)`, `cutQuad(quad)`, `stack(lower, upper)`, `paint(color)`, `paint4(colors[4])`.
- `Solver` is a stateful per-call instance: per-hash memo `Map`, `path` `Set` cycle guard, attempt counter.
- Candidate families, in order (inside `planShape`, `solver.ts:432`): base → atoms → paint / paint4 → rotations → prefix stacks → scaffold + cut → quadrant-window splits → full-combination fallback.
- **Every** split is validated with real `S.stack` + `S.equals` before recursing — no algebraic shortcuts.
- Failures are memoised only when no cycle was hit and the run was not aborted. Defaults: `maxAttempts 30000`, `splitCap 4000` (`solver.ts:102-103`).
- Building availability is gated by a `Set` (`--level=` / `buildings=` / UI checkboxes) via `has` / `hasRotation`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `solver/src/` | The whole solver core. Pure TypeScript, no I/O, no dependencies. |
| `solver/test/` | Custom zero-dep harness (`run-tests.ts`) and randomized `fuzz.ts`. |
| `solver/web/` | Browser UI: `index.html` + `app.ts`, importing `../src/*.ts` directly; `server.ts` serves it transpiled. |
| `demo/` | Prebuilt upstream DEMO mirror (41 files). `demo/v/8a79de52/` holds the bundle, atlas, fonts, audio. |
| `ref` | Gitignored symlink/junction → `vendor/shapez.io/src/js/game`. Read-only reference for upstream semantics; **never imported at runtime** (tests pass without it). |
| `vendor/shapez.io/` | Gitignored sparse clone of upstream, pinned to `8a79de52`. |
| `.agents/` | Vendored agent skills + checklists, pinned by `skills-lock.json`. Not project code. |

## Development Commands

Run from the repo root; every script below is defined in `package.json`. Inside `solver/`, the bare forms `bun cli.ts …` and `bun test/run-tests.ts …` work as well.

```bash
# Setup + type gate
bun install                     # once: the single devDependency (@types/bun)
bun check                       # Bun's built-in TypeScript checker; no typescript package

# Verification
bun run test                    # 209 checks, seconds
bun run test:quick              # 174 checks, skips both level loops
bun run test --filter=router    # only matching sections/labels; no match exits 1
bun run verify                  # bun check + the full suite
bun run check:tunnels           # campaign tunnel legality (demo + full, ~10 s)
bun run check:filter            # harness self-check: --filter/--timings/section partition (~40 s)
bun run bench:key               # tile-key microbenchmark: packed numbers vs "x|y" (~3 s)
bun run fuzz --n=40 --seed=1234 --budget=30000

# Solve / inspect
bun run cli solve "RuCw--Cw:----Ru--" --json
bun run cli solve "Cu------" --level=demo:6    # only buildings unlocked by that level
bun run cli render "RuCw--Cw"                  # canonical code + ASCII layers
bun run cli levels --game

# Map / campaign sheet
bun run cli map --seed=47742 --radius=3
bun run cli map --save=savegame.bin --radius=2

# Every shape the campaign asks for (levels + upgrade tiers), one shared map/HUB
# seed is the input; the vein scan widens until every needed shape letter exists
bun run cli all 47742 --out=plan-all.svg
bun run cli all 47742 --set=full

# UI + API
bun run serve                # Bun.serve: /web/index.html, GET /api/solve, static under solver/
```

One-off entry points:

```bash
bun setup-ref.ts      # sparse-clone vendor/shapez.io + recreate ref/ (rerun on every machine)
bash fetch-demo.sh    # re-download demo/ from shapez.io (network)
cd demo && python -m http.server 8087   # DEMO only; the solver UI runs on solver/server.ts
```

`bun run cli check` is the CLI alias for the harness (it spawns the Bun runtime with `solver/test/run-tests.ts` resolved from `import.meta.dir`, so it works from any cwd); `bun run test` is canonical. There is no lint/format step; `bun check` (script name `typecheck`) is the only static gate.

CLI gotcha: `solve` **ignores `--budget`** (`cli.ts:104` passes only `buildings`). Budget is wired in `all` (`--budget`), `fuzz.ts`, and the server's `?budget=` param. To widen the search for a plain solve, call `solve(code, { maxAttempts })` directly.

## Code Conventions & Common Patterns

- **Strict TypeScript, executed by Bun.** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `module: Preserve`, `moduleResolution: bundler`, `allowImportingTsExtensions` and `noEmit`; `bun check` type-checks `solver/**/*.ts` + `setup-ref.ts` and nothing is emitted. `package.json` sets `"type": "module"` so the sources stay strict ESM.
- Style: 4 spaces, double quotes, semicolons, K&R braces, trailing commas. This mirrors upstream's Prettier config, but **nothing enforces it** here and lines run longer than upstream's `printWidth`. Exception: `solver/src/lz_factory.js` is extracted third-party LZ-String code (one 4 KB line) — never reformat it.
- Naming: `camelCase` functions/vars, `PascalCase` classes (`Solver`, `ShapeParseError`), `UPPER_SNAKE` constants and data tables.
- **Error contracts (do not unify):**
  - `parse()` throws `ShapeParseError`; `tryParse()` returns `{ ok, error }`.
  - Invariant violations throw; *search* misses return `null` (a candidate just doesn't apply).
  - An unsolvable target is **not** an exception: `solve()` returns `{ ok: false, error, stats }`.
  - CLI prints to stderr and exits `2` on usage errors, `1` on failure.
- **Deliberate mutation and caching** exists in a few hot spots: `shape.__hash`, WeakMap `evalCache` / `flatten` memo, `decompCache` / `compCache`, and `buildLayout` overwriting its `blockX/blockY` params. Do not "clean these up" without measuring.
- No `async` inside `solver/src/`. Only `cli.ts cmdCheck` is async (dynamic `import("node:child_process")` + `spawnSync`); `server.ts` serves through `Bun.serve` and transpiles `web/app.ts` per request.
- Language split: code, comments and docstrings are **English**; user-facing CLI/UI strings and labels are **Chinese** (`OP_LABELS`, `zh` fields). `OP_LABELS_EN` holds the English op names.

### Adding a machine

Touch all of: a node builder + `evalNode` case + `flatten` case + `OP_LABELS` + `evalKey` in `plan.ts`; `BUILDING_INFO` (and `outputSlot` if multi-output) in `layout.ts`; `ALL_BUILDINGS` / `ROTATION_BUILDING`, a `has()` gate and a candidate family in `solver.ts`. `schematic.ts` needs nothing — it renders from `BUILDING_INFO`.

### Adding a decomposition strategy

Write a `Solver` method that returns `{ lower, upper }` (pattern: `windowSplits` / `splitCandidates`), validate with `S.stack` + `S.equals`, then push it into the `families` array at `solver.ts:550` and emit with `P.stackNode`.

## Important Files

| File | Why it matters |
| --- | --- |
| `solver/src/shape.ts` | The algebra. A change here propagates through solver, plan, layout and every test. |
| `solver/src/plan.ts` | Plan AST (`:81` `PlanNode`), evaluation, and the verification oracle (`:137` `evalNode`, `:227` `flatten`, `:322` `verifyPlan`). |
| `solver/src/solver.ts` | Search order and budgets (`:102-103`), `planShape` (`:432`), family list (`:550`). |
| `solver/src/layout.ts` | `BUILDING_INFO` port table (`:25`) — single source of tile geometry; then packing, BOM, belt routing. `World` containers are keyed by packed-number tiles (`cellKey`, exported for tests and the census). |
| `solver/src/needs.ts` | Level + upgrade-tier shape requirements, derived from upstream `modes/regular.js`. Feeds `cli.ts all`. |
| `solver/src/campaign.ts` | Solves every needed shape and packs all factories onto one shared world/hub. |
| `solver/src/levels.ts` | `DEMO_LEVELS`, `FULL_LEVELS`, `REWARD_BUILDINGS`. The regression corpus; new targets go here and are auto-covered. |
| `solver/test/run-tests.ts` | Harness plus **all** expectations as inline literals. |
| `solver/cli.ts`, `solver/server.ts` | User-facing surfaces; `--k=v` flags only, parsed after the subcommand, unknown flags ignored. |
| `solver/src/savegame.ts` | `"\x01" + LZ-String-base64("crc32-…" + inline JSON)` decoding. |
| `solver/src/lz_factory.js` + `lz_factory.d.ts` | Vendored upstream LZ-String (one 4 KB line) and its type declaration. Never edited. |
| `package.json`, `tsconfig.json` | Scripts (`check`/`test`/`verify`/`fuzz`/`cli`/`serve`) and the strict compiler options; `bun.lock` pins `@types/bun`. |
| `README.md` | Canonical reference: shape semantics, port table, algorithm families, known limits. |

## Runtime/Tooling Preferences

- **Bun ≥ 1.4.4.** TypeScript sources run directly: no build step, no bundler, no `typescript` npm package. `bun check` is the type gate.
- **Zero runtime dependencies is a hard constraint**: only `node:` builtins and relative imports. `@types/bun` (the single devDependency, pinned in `bun.lock`) is types only and adds no runtime code.
- Python 3 only for `python -m http.server` when serving `demo/`.
- `git` + network needed for `setup-ref.ts` (sparse clone) and `fetch-demo.sh`.
- Windows: `ref` is a directory junction, handled by `setup-ref.ts`; don't create it by hand.
- Generated / never committed: `vendor/`, `ref`, `*.log`, `tree.json`, `savegame.raw.json`, `savegame.json`, `preview-cu.svg`, `solver/tmp-sg.mjs`.
- Generated but **tracked** (regenerate + commit when source changes): `demo/**`, `plan-all.svg`, `savegame.bin`.

## Testing & QA

- Custom harness, no framework (`bun test` is not used): `check(label, actual, expected)` (deep equality via `JSON.stringify`, `run-tests.ts:86`) and `checkTrue` (`:98`). Sections print as `== … ==` (`beginSection`); footer is `N checks, M failure(s)[, N skipped]` (`:931`); exit `1` on any failure. `--filter=<regex>` keeps only checks whose section name or label matches (a filter that matches nothing exits `1`; empty/bare `--filter` and bad regex exit `2`); `--timings` prints one `(N checks, M fail, X ms)` line per section.
- Suite size: 209 checks via `bun run test`, 174 via `bun run test:quick` (both level loops skipped).
- Covered: shape codec and hashing, rotations, cut/stack, the `BUILDING_INFO` port table against upstream slot indices, connection start slots, map determinism (seed `47742`), savegame round-trip, 9 demo levels, 26 full levels.
- **Gap to know about:** the level suites assert only `ok` + `verification.ok`, never `cost`. Optimality regressions pass silently — add a cost assertion when you change search order or family priority.
- Uncovered by tests: `schematic.ts`, `render.ts`, `server.ts`, `web/app.ts`. Verify those by actually starting `bun run serve` and loading `/web/index.html`.
- **Tunnel legality gate:** `bun run check:tunnels` (`tools/check-tunnels.ts`) rebuilds the campaign for seed 47742 and independently re-derives every tunnel: span ≤ 5 tiles, straight sender/receiver ends, no same-direction end inside a span (hijack/break), ends occupy their tile, no belt self-overlap, port-facing ends. It also floors the routed count (demo 44 / full 390; measured 46 / 396). Slow (~10 s), so it is not part of `verify`; run it after touching `routeBelt`, `World` bookkeeping or `schematic.ts`. The campaign build is dominated by `routeBelt`; `Map`/`Set` lookups on packed-number tile keys are ~16× faster than on `"x|y"` strings (`bun run bench:key`, F19/F20 in `docs/facts.md`), so keep `World` keyed by numbers.
- **Harness self-check:** `bun run check:filter` (`tools/check-test-filter.ts`) runs one anchored `--filter=^section$` per `beginSection` and asserts the partition (per-section checks sum to the default total; `checks + skipped` equals it on every run), the `--timings` line count, and the exit codes of the no-match / bad-regex / bare / empty lanes. Slow (~40 s), so it is not part of `verify`; run it after touching `run-tests.ts`.
- No CI, no coverage tool, no snapshots, no golden SVG comparison. `bun run test` is the entire quality gate; `bun run verify` chains `bun check` in front of it; `bun run check:tunnels` is the campaign-level legality gate.
- Extend in the obvious place: new algebra case → new `== … ==` block with `check`; new targets → `solver/src/levels.ts`; randomized checking → `fuzz.ts`.
- CLI exit-code nuance: `solve --json` prints its payload and exits `0` **even when `ok` is false**. Parse the JSON, don't rely on the exit code.

### Domain constraints — do not "fix" these

- Some targets are **genuinely unsolvable** in-game (e.g. `Cu------:--Cu----:----Cu--`). The stacker needs quadrant overlap to lift a layer; the solver correctly reports `ok: false`.
- `aborted` means the attempt budget ran out; the plan may be suboptimal. It is not a bug to raise the budget.
- Belts, orientation, throughput and wire logic are **not modelled**; `beltEstimate` is an estimate.
- shapez 1.5.7 has no importable blueprint string, so this project emits coordinates + port-accurate connections instead. Don't go looking for an import format.

## Agent skills

### Issue tracker

Issues live as markdown under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
