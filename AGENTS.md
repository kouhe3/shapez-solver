# Repository Guidelines

## Project Overview

Two artefacts in one repo:

1. `demo/` — an offline mirror of the official shapez.io **web DEMO**, build `8a79de52` (`1.5.7`). Prebuilt upstream bundle; not our code.
2. `solver/` — the **ALL SHAPE YOU NEED solver**. Input: a map seed (`node cli.js all 47742`). Output: one campaign sheet — tile-accurate building placements, port-to-port material flow and a BOM for every shape the campaign needs, all factories on one shared map delivering into the same hub.

The underlying solver still targets *arbitrary* shapes (single shapes remain available through `node cli.js solve`); the 26 full-game levels and 9 demo levels are only the regression corpus. Everything runs on bare Node with **zero dependencies, no build step, no package manager**.

## Architecture & Data Flow

Two loosely coupled halves live under `solver/src/`:

- **Shape algebra + planning (pure, no I/O):** `shape.js` → `plan.js` → `solver.js`.
- **World/layout (reads savegames, writes SVG):** `savegame.js`, `lz_factory.js`, `map.js`, `layout.js`, `schematic.js`, `render.js`.

### Solve pipeline

```
shape code string
  → P.parseTarget → S.parse              plan.js:230, shape.js:110
  → new Solver({buildings}).planShape    solver.js:367
  → plan AST {op, cost, children}        plan.js:1-10
  → P.verifyPlan → flatten → evalNode    plan.js:214, :132, :63
  → S.equals / S.computeHash             shape.js:186, :167
  → { ok, target, plan, flat, cost, verification, stats }
```

`verifyPlan` is the oracle: the emitted plan is **re-simulated** through the real stack/cut/paint semantics and compared to the target. Nothing is trusted because the search said so.

Blueprint path: `solve` → `scanMap` / `nearestPatch` (`map.js`) → `buildLayout` (`layout.js:128`) → `schematicSVG` (`schematic.js:24`) → SVG file.

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
- Candidate families, in order (`solver.js:394-505`): base → atoms → paint / paint4 → rotations → prefix stacks → scaffold + cut → quadrant-window splits → full-combination fallback.
- **Every** split is validated with real `S.stack` + `S.equals` before recursing — no algebraic shortcuts.
- Failures are memoised only when no cycle was hit and the run was not aborted. Defaults: `maxAttempts 30000`, `splitCap 4000` (`solver.js:100-101`).
- Building availability is gated by a `Set` (`--level=` / `buildings=` / UI checkboxes) via `has` / `hasRotation`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `solver/src/` | The whole solver core. Pure ESM, no I/O, no dependencies. |
| `solver/test/` | Custom zero-dep harness (`run-tests.js`) and randomized `fuzz.js`. |
| `solver/web/` | Browser UI: static ESM importing `../src/*.js` directly. |
| `demo/` | Prebuilt upstream DEMO mirror (41 files). `demo/v/8a79de52/` holds the bundle, atlas, fonts, audio. |
| `demo/solver/` | **Generated copy** of `solver/{src,web}`; exists so the UI is same-origin with the game's IndexedDB. |
| `ref` | Gitignored symlink/junction → `vendor/shapez.io/src/js/game`. Read-only reference for upstream semantics; **never imported at runtime** (tests pass without it). |
| `vendor/shapez.io/` | Gitignored sparse clone of upstream, pinned to `8a79de52`. |
| `.agents/` | Vendored agent skills + checklists, pinned by `skills-lock.json`. Not project code. |

## Development Commands

Run from `solver/` unless noted.

```bash
# Verification (the gate)
node test/run-tests.js          # 127 checks, seconds
node test/run-tests.js --quick  # 92 checks, skips both level loops
node cli.js check               # spawns test/run-tests.js; cwd must be solver/
node test/fuzz.js --n=40 --seed=1234 --budget=30000

# Solve / inspect
node cli.js solve "RuCw--Cw:----Ru--" --json
node cli.js solve "Cu------" --level=demo:6    # only buildings unlocked by that level
node cli.js render "RuCw--Cw"                  # canonical code + ASCII layers
node cli.js levels --game

# Map / campaign sheet
node cli.js map --seed=47742 --radius=3
node cli.js map --save=../savegame.bin --radius=2

# Every shape the campaign asks for (levels + upgrade tiers), one shared map/HUB
# seed is the input; the vein scan widens until every needed shape letter exists
node cli.js all 47742 --out=plan-all.svg
node cli.js all 47742 --set=full

# UI + API
node server.js --port=8099   # /web/index.html, GET /api/solve, static under solver/
```

Repo root:

```bash
node setup-ref.mjs    # sparse-clone vendor/shapez.io + recreate ref/ (rerun on every machine)
bash fetch-demo.sh    # re-download demo/ from shapez.io (network)
bash sync-ui.sh       # copy solver/{src,web} -> demo/solver (TRACKED; see below)
cd demo && python -m http.server 8087   # demo at /, solver UI at /solver/web/
```

There are no npm scripts, no `npm install`, and no lint/format step.

CLI gotcha: `solve` **ignores `--budget`** (`cli.js:98` passes only `buildings`). Budget is wired in `all` (`--budget`), `fuzz.js`, and the server's `?budget=` param. To widen the search for a plain solve, call `solve(code, { maxAttempts })` directly.

## Code Conventions & Common Patterns

- **ESM everywhere.** No `package.json` and no `"type": "module"` exists, so `node cli.js` relies on Node's *module syntax detection* — requires **Node ≥ 20.19** (≥ 22.7 recommended). Verified on `v24.22.3`. Adding a `package.json` without `"type": "module"` silently breaks every entry point.
- Style: 4 spaces, double quotes, semicolons, K&R braces, trailing commas. This mirrors upstream's Prettier config, but **nothing enforces it** here and lines run longer than upstream's `printWidth`. Exception: `solver/src/lz_factory.js` is extracted third-party LZ-String code (one 4 KB line) — never reformat it.
- Naming: `camelCase` functions/vars, `PascalCase` classes (`Solver`, `ShapeParseError`), `UPPER_SNAKE` constants and data tables.
- **Error contracts (do not unify):**
  - `parse()` throws `ShapeParseError`; `tryParse()` returns `{ ok, error }`.
  - Invariant violations throw; *search* misses return `null` (a candidate just doesn't apply).
  - An unsolvable target is **not** an exception: `solve()` returns `{ ok: false, error, stats }`.
  - CLI prints to stderr and exits `2` on usage errors, `1` on failure.
- **Deliberate mutation and caching** exists in a few hot spots: `shape.__hash`, WeakMap `evalCache` / `flatten` memo, `decompCache` / `compCache`, and `buildLayout` overwriting its `blockX/blockY` params. Do not "clean these up" without measuring.
- No `async` inside `solver/src/`. Only `cli.js cmdCheck` is async (dynamic `import("node:child_process")` + `spawnSync`); `server.js` uses callback `fs.readFile`.
- Language split: code, comments and docstrings are **English**; user-facing CLI/UI strings and labels are **Chinese** (`OP_LABELS`, `zh` fields). `OP_LABELS_EN` holds the English op names.

### Adding a machine

Touch all of: a node builder + `evalNode` case + `flatten` case + `OP_LABELS` + `evalKey` in `plan.js`; `BUILDING_INFO` (and `outputSlot` if multi-output) in `layout.js`; `ALL_BUILDINGS` / `ROTATION_BUILDING`, a `has()` gate and a candidate family in `solver.js`. `schematic.js` needs nothing — it renders from `BUILDING_INFO`.

### Adding a decomposition strategy

Write a `Solver` method that returns `{ lower, upper }` (pattern: `windowSplits` / `splitCandidates`), validate with `S.stack` + `S.equals`, then push it into the `families` array at `solver.js:484` and emit with `P.stackNode`.

## Important Files

| File | Why it matters |
| --- | --- |
| `solver/src/shape.js` | The algebra. A change here propagates through solver, plan, layout and every test. |
| `solver/src/plan.js` | Plan AST, evaluation, and the verification oracle (`:63` `evalNode`, `:132` `flatten`, `:214` `verifyPlan`). |
| `solver/src/solver.js` | Search order and budgets (`:100`), `planShape` (`:367`), family list (`:484`). |
| `solver/src/layout.js` | `BUILDING_INFO` port table (`:17`) — single source of tile geometry; then packing, BOM, belt estimate. |
| `solver/src/needs.js` | Level + upgrade-tier shape requirements, derived from upstream `modes/regular.js`. Feeds `cli.js all`. |
| `solver/src/campaign.js` | Solves every needed shape and packs all factories onto one shared world/hub. |
| `solver/src/levels.js` | `DEMO_LEVELS`, `FULL_LEVELS`, `REWARD_BUILDINGS`. The regression corpus; new targets go here and are auto-covered. |
| `solver/test/run-tests.js` | Harness plus **all** expectations as inline literals. |
| `solver/cli.js`, `solver/server.js` | User-facing surfaces; `--k=v` flags only, parsed after the subcommand, unknown flags ignored. |
| `solver/src/savegame.js` | `"\x01" + LZ-String-base64("crc32-…" + inline JSON)` decoding. |
| `demo/solver/**` | Generated mirror — never hand-edit; run `bash sync-ui.sh`. |
| `README.md` | Canonical reference: shape semantics, port table, algorithm families, known limits. |

## Runtime/Tooling Preferences

- **Node ≥ 20.19** (22.7+ recommended). No package manager, bundler, transpiler, or TypeScript.
- **Zero runtime dependencies is a hard constraint**: only `node:` builtins and relative imports. Adding an npm package breaks the "clone and run" model.
- Python 3 only for `python -m http.server` when serving `demo/`.
- `git` + network needed for `setup-ref.mjs` (sparse clone) and `fetch-demo.sh`.
- Windows: `ref` is a directory junction, handled by `setup-ref.mjs`; don't create it by hand.
- Generated / never committed: `vendor/`, `ref`, `*.log`, `tree.json`, `savegame.raw.json`, `savegame.json`, `preview-cu.svg`, `solver/tmp-sg.mjs`.
- Generated but **tracked** (regenerate + commit when source changes): `demo/**` including `demo/solver/**`, `plan-all.svg`, `savegame.bin`.

## Testing & QA

- Custom harness, no framework: `check(label, actual, expected)` (deep equality via `JSON.stringify`, `run-tests.js:19-26`) and `checkTrue` (`:28-34`). Sections print as `== … ==`; footer is `N checks, M failure(s)`; exit `1` on any failure.
- Covered: shape codec and hashing, rotations, cut/stack, the `BUILDING_INFO` port table against upstream slot indices, connection start slots, map determinism (seed `47742`), savegame round-trip, 9 demo levels, 26 full levels.
- **Gap to know about:** the level suites assert only `ok` + `verification.ok`, never `cost`. Optimality regressions pass silently — add a cost assertion when you change search order or family priority.
- Uncovered by tests: `schematic.js`, `render.js`, `server.js`, `web/app.js`. Verify those by actually starting `node server.js` and loading `/web/index.html`.
- No CI, no coverage tool, no snapshots, no golden SVG comparison. `node test/run-tests.js` is the entire quality gate.
- Extend in the obvious place: new algebra case → new `== … ==` block with `check`; new targets → `src/levels.js`; randomized checking → `fuzz.js`.
- CLI exit-code nuance: `solve --json` prints its payload and exits `0` **even when `ok` is false**. Parse the JSON, don't rely on the exit code.

### Domain constraints — do not "fix" these

- Some targets are **genuinely unsolvable** in-game (e.g. `Cu------:--Cu----:----Cu--`). The stacker needs quadrant overlap to lift a layer; the solver correctly reports `ok: false`.
- `aborted` means the attempt budget ran out; the plan may be suboptimal. It is not a bug to raise the budget.
- Belts, orientation, throughput and wire logic are **not modelled**; `beltEstimate` is an estimate.
- shapez 1.5.7 has no importable blueprint string, so this project emits coordinates + port-accurate connections instead. Don't go looking for an import format.
