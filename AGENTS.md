# Repository Guidelines

## Project Overview

Two artefacts live in one repo:

1. `demo/` — an offline mirror of the official shapez.io **web DEMO**, build `8a79de52` (`1.5.7`). Prebuilt upstream bundle (28 tracked files, 20 MB); not our code.
2. `solver/` — the **ALL SHAPE YOU NEED solver**. Input: a map seed (`bun run cli all 47742`). Output: one campaign sheet — tile-accurate building placements, port-to-port material flow and a BOM for every shape the campaign needs, all factories on one shared map delivering into the same hub.

The solver still targets *arbitrary* shapes (`bun run cli solve <code>`); the 26 full-game levels and 9 demo levels are only the regression corpus. Everything runs on **Bun ≥ 1.4.4** with **strict TypeScript**, **zero runtime dependencies** and **no build step**: `@types/bun` is the single devDependency, `bun check` is the type gate, and Bun executes the `.ts` sources directly.

## Architecture & Data Flow

Two loosely coupled halves under `solver/src/`:

- **Shape algebra + planning (pure, no I/O):** `shape.ts` → `plan.ts` → `solver.ts`.
- **World/layout (reads savegames, writes SVG):** `savegame.ts`, `lz_factory.js` (vendored JS), `map.ts`, `layout.ts`, `schematic.ts`, `render.ts`.

### Solve pipeline

```text
shape code string
  → P.parseTarget                   plan.ts:338
  → S.parse                         shape.ts:150
  → new Solver(opts)                solver.ts:743
  → solver.planShape(target)        solver.ts:581
  → PlanNode DAG
  → P.verifyPlan (re-simulates)     plan.ts:322 → flatten :227 → evalNode :137
  → { ok, target, plan, flat, cost, verification, stats }
```

`planShape` is a memoised recursion keyed by the canonical shape hash (`S.hash` = the code string). Candidate families, in code order (`solver.ts:609-725`): base → atoms → whole-shape paint → paint4 → rotations → prefix stacks (`k` layers) → scaffold + `cutHalf` → general splits (`windowSplits`, then `splitCandidates`; gated on `stacker && layers >= 2 && !best`). Every stack candidate is validated with real `S.stack` + `S.equals`; atoms / paint / rotate / scaffold are trusted by construction. Budgets: `maxAttempts = 30000`, `splitCap = 4000` (`solver.ts:199-200`).

`verifyPlan` is the oracle: the emitted plan is **re-simulated** through the real stack / cut / paint semantics and hash-compared to the target. Nothing is trusted because the search said so.

### Reuse: absent by design (read this before "optimising" it)

- `solve()` builds a **fresh `Solver` per call** (`solver.ts:743`); `memo` / `path` / `cycleHits` are instance state. `planCampaign` calls `solve()` once per needed shape (`campaign.ts:272-275`): the same intermediate shape is solved and built once per factory (F28).
- Inside one target the memo returns the **same `PlanNode`** to several parents (the AST is a DAG), and `flatten` preserves that sharing. But `buildLayout` starts with `expandPlanTree(P.flatten(plan))` (`layout.ts:1244`), which **copies every shared sub-plan**: one output slot feeds exactly one belt, splitters unlock only at L4, and parts are free (`layout.ts:1144-1152`). Reuse exists only during the search, never in the layout (F29).
- Colour production is **one chain per consumer port** (`buildColorChain`, `layout.ts:1647-1655`): two painter ports of the same colour grow two chains. `planCampaign`'s `sizeColorSupply` only sizes demand (`campaign.ts:441`). Factories share the map, the hub, deposits and belt lanes — never machines (F30).
- Making reuse real means changing all three layers at once: cross-target memo + multi-consumer intermediates, a DAG-aware layout (splitter or shared sub-factory instead of `expandPlanTree`), and inter-factory belts. `docs/plans/routing-gaps.md` is the open plan in this area.

### Shape representation

- `shape = { layers, __hash? }`; `layer` = 4-element array of `cell | null`; `cell = { t, c }`.
- Quadrant order **q0=top-right, q1=bottom-right, q2=bottom-left, q3=top-left**; layer 0 is bottom, max 4 layers.
- Code format: 8 chars per layer, `--` = empty, layers joined by `:`. Types `C R S W`; colours `r g b y p c w u` (`u` = uncolored).
- `hash()` returns the canonical code and caches it in `__hash`; `equals` compares hashes. Transforms return hash-less shapes; `cloneShape` deliberately drops the cache.

### Plan model and search

- Nodes (`plan.ts:31-88`): variants of `{ op, cost, … }`. Ops: `base rotate cutHalf cutQuad stack paint paint4`.
- `cost` = number of non-miner buildings (`base` costs 0). It is the search scalar, **not** the optimal-plan criterion (ADR-0001).
- `Solver` is stateful per call: `memo`, `path` (cycle guard), `cycleHits`, `stats`, `attempts`.
- Failures are memoised only when no cycle was hit and the run was not aborted (`solver.ts:730-731`).
- Building availability is gated by a `Set` (`--level=`, `buildings=` / UI checkboxes) via `has` / `hasRotation`.
- `SolveSuccess.ok` may be `false` (verification failed) while still carrying a plan; `planCampaign` records that as `failed` with `error: undefined`.

### World, layout and campaign

- `BUILDING_INFO` (`layout.ts:443`) is the single source of tile geometry: ports in tile units, y down, multi-output index = `ItemEjector` slot index. Tests align it against upstream.
- `routeBelt` (`layout.ts:693`) is a Dijkstra over `(tile, phase, heading)`; phases 0 = surface, 1–4 = underground, 5 = surfaced. `MAX_UNDERGROUND = 4` = tiles strictly between ends (the game's 5-tile tier-0 span). `TunnelSpan`s are derived after the search; `claimRoute` commits exactly the tested run.
- Tile keys are packed numbers `(x+4096)*8192+(y+4096)` (`cellKey`, `layout.ts:957`), ~16× faster than `"x|y"` strings for `World` lookups.
- The hub is 4×4 with 16 outside entry tiles (`HUB_ENTRIES = 16` in `rates.ts:41`); see *Hub and sustained demand* below.
- `planCampaign` (`campaign.ts:282`): per need → `solve` → `buildLayout` in its own block (`allocateBlock`, `layout.ts:1096`) → collect placements / connections / colour chains / BOM → campaign-level repair (`repairRoutingGaps`, `campaign.ts:784`) → one belt/colour ledger. One shared `World` for all factories, created and owned by this module; it never leaves the seam.
- `SheetView` (`campaign.ts:188`) is the sheet's whole interface: hub, buildings, connections, sources, colours, missing resources, routing gaps, belt count, BOM, one frame per factory. `Layout` stays the single-factory type — the sheet is not a fake `Layout` and carries no `world`.
- Whoever moves a run writes its derived fields (`path`, `tunnelSpans`, `tunnelCells`, `beltTiles`) — `buildLayout` and the repair pass alike. The sheet only sums `beltTiles`; nothing re-derives a path from the world. Colour sources are counted from `Placement.color` (miners and mixers), never from synthetic step ids.
- `validateSheet` (`solver/src/validate.ts`) answers "would this stand up in the game" from the drawing alone: span length and straight ends, port facing, hijack, crossings, and tile ownership (one belt, one tunnel end, one direction per tile). It re-derives every rule itself — never `routeBelt`'s state, never `World`; the census is its production adapter, and tests corrupt a real layout to prove it bites.
- `--until=N` is a **snapshot**, not an incremental build plan: factories above the cap are deferred and not laid out, nothing is reserved for them, and block positions come from greedy allocation over the set actually built (F35). Measured on the demo set: cap=1 lays out 2 blocks (coincidentally at their full-sheet positions), cap=5 moves `--CuCu--` from `[-63,-18]` to `[57,0]`.
- `beltEstimate` counts routed belt cells (tunnel ends count, underground cells do not). Belts, orientation, throughput and wire logic are **not modelled**; the rate numbers are estimates.

### Hub and sustained demand

- The hub's 16 entry slots accept **any** shape (`ItemAcceptor` filter is only `"shape"`), and its processing speed is unbounded (`getProcessorBaseSpeed(hub) = 1e30`). Delivered shapes accumulate forever in `storedShapes`; the current level goal reads `storedShapes[goal]`. Sharing an entry between products is therefore legal — "one product per entry" is a throughput policy, not a game rule (F31).
- The full game has **992 endgame upgrade tiers per track** (4 tracks; demo: none), each demanding sustained quantities of the preparement / final / rocket shapes (F32). Cumulative endgame demand is ≈ 9.9e9 items per track (Σ 70 000 + 20 000·i), ≈ **4e10 items** over 4 tracks — about 39 years at the 32/s hub ceiling, i.e. endless by design. `needs.ts` includes only the first endgame tier as a needed shape; sustained delivery rate is not modelled.
- Level 14 (belt reader) is the one `throughputOnly` goal: it checks the **current rate** (8/s), not stored stock, so it is the literal "keep it running" requirement (`ref/modes/levels.js:262-269`; `hub_goals.getCurrentGoalDelivered`).
- Blueprints (copy-paste) cost **stored** `CbCbCbRb:CwCwCwCw` (`4·n^1.1`, rounded) and the cost is deducted on placement (F33). That shape is also full level 12's goal, so the campaign already builds it.
- The solver allocates hub faces greedily (up to 6 free faces + 3 join faces per inbound link); when every entry is boxed in by belts laid earlier it merges the leg into a belt already bound for the hub (`World.hubBound`; at most `HUB_ENTRY_LEGS = 5` legs share one entry belt, which is what the 2/s belt rate allows). `hubMerges` counts the legs that had to merge. It builds no merger tree and reserves no entry per product (F34, F43).
- **Router:** `routeBelt` snapshots the search box and searches in the Rust core (`native/router`) through `solver/src/router-engine.ts`; the JS router it replaced is gone (F49, F51). `solver/router.wasm` is a committed build product (`bun run build:router`). `cli all`, the test harness and `check:tunnels` load it synchronously at startup; `web/worker.ts` fetches `/router.wasm` before the first campaign. A missing wasm file is a hard error, not a silent JS fallback.

## Key Directories

|Path|Purpose|
|---|---|
|`solver/src/`|The whole solver core: shape algebra, planning, layout, map/savegame codecs. Pure TS, no I/O except map/savegame decoding.|
|`solver/test/`|Custom zero-dep harness (`run-tests.ts`) and randomized `fuzz.ts`.|
|`solver/web/`|Browser UI: `index.html` + `app.ts`, importing `../src/*.js` directly; `server.ts` serves it transpiled.|
|`solver/cli.ts`, `solver/server.ts`|User-facing surfaces (`--k=v` flags only, parsed after the subcommand).|
|`native/router/`|Rust belt-router crate; `src/lib.rs` is the Dijkstra, built to `solver/router.wasm`.|
|`solver/router.wasm`|Tracked wasm build of `native/router`; regenerate with `bun run build:router`.|
|`tools/`|Tracked instruments: tunnel legality, harness self-check, tile-key benchmark.|
|`demo/`|Prebuilt upstream DEMO mirror; must be served from its own docroot (absolute `/v/` URLs).|
|`docs/`|`facts.md` ledger, `plans/`, `adr/`, `agents/` skill config. Root `README.md` and `GLOSSARY.md` are canonical references.|
|`ref`|Junction/symlink → `vendor/shapez.io/src/js/game`; read-only upstream reference, never imported at runtime.|
|`work/`|Gitignored one-off probes, profiles and large SVG artefacts.|
|`vendor/`|Gitignored sparse clone of upstream, pinned to `8a79de52`.|

## Development Commands

Run from the repo root; every script below is defined in `package.json`.

```bash
# Setup + gates
bun install                    # once: the single devDependency (@types/bun)
bun run verify                 # bun check + full suite — primary gate (~2 s)
bun run test                   # 261 checks, 0 failure, ~2.1 s
bun run test:quick             # 226 checks, skips both level loops, ~1.3 s
bun run test --filter=router   # 32 checks, 229 skipped
bun run check:tunnels          # campaign tunnel legality, ~20 s full (not in verify)
bun run check:filter           # harness self-check, ~48 s (not in verify)
bun run bench:key              # tile-key microbenchmark, ~3 s (ratio ~16-18x)
bun run build:router           # cargo: rebuild solver/router.wasm
bun run bench:router           # synthetic routing benchmark (the wasm router)

# Solve / inspect
bun run cli solve "RuCw--Cw:----Ru--" --json
bun run cli solve "Cu------" --level=demo:6
bun run cli render "RuCw--Cw"
bun run cli levels --game
bun run cli map --seed=47742 --radius=3
bun run cli map --save=savegame.bin --radius=2

# Campaign sheet: every shape the campaign asks for, one shared map / hub
bun run cli all 47742 --out=plan-all.svg       # demo set (default)
bun run cli all 47742 --set=full               # full game set

# UI + API
bun run serve                  # Bun.serve on 127.0.0.1:8099 (--port to change)
```

One-off entry points:

```bash
bun setup-ref.ts               # sparse-clone vendor/shapez.io at the pinned commit + recreate ref/
bash fetch-demo.sh             # re-download demo/ from shapez.io (28 files, 20 MB)
cd demo && python -m http.server 8087   # DEMO only; the solver UI runs on solver/server.ts
```

Gotchas:

- `bun test` does **not** work — the suite is a custom script. Use `bun run test` (or `bun run cli check`).
- `solve` **ignores `--budget`** (`cli.ts:133` passes only `buildings`). Budget is honoured by `all`, `fuzz.ts` and the server's `?budget=`.
- `solve --json` prints its payload and exits **0 even when `ok:false`**; parse the JSON, not the exit code.
- `all` never exits non-zero for failed / impossible / deferred shapes; only a bad `--until` exits 2.
- `map --json` appends JSON *after* the human text — it is not a pure JSON stream.
- The belt router is wasm. `solver/router.wasm` must exist (it is tracked; rebuild with `bun run build:router` after changing `native/router`). The browser worker fetches `/router.wasm` from `solver/server.ts`, which serves it as `application/wasm`.

## Code Conventions & Common Patterns

- **Strict TypeScript executed by Bun.** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `module: Preserve`, `moduleResolution: bundler`, `allowImportingTsExtensions`, `noEmit`. `bun check` covers `solver/**/*.ts`, `tools/**/*.ts` and `setup-ref.ts`; nothing is emitted.
- **Style:** 4 spaces, double quotes, semicolons, K&R braces, trailing commas. Nothing enforces it; lines run long. Exception: `solver/src/lz_factory.js` is extracted third-party LZ-String code (one 4 KB line) — never reformat it.
- **Line endings:** LF everywhere. `.gitattributes` sets `* text=auto eol=lf` (binaries pinned), so `git add` normalizes CRLF on commit and checkout writes LF; never hand-convert line endings.
- **Naming:** `camelCase` functions/vars, `PascalCase` classes (`Solver`, `ShapeParseError`), `UPPER_SNAKE` constants and data tables.
- **Language split:** code, comments and docstrings are **English**; user-facing CLI/UI strings and labels are **Chinese** (`OP_LABELS`, `zh` fields, glossary vocabulary). `OP_LABELS_EN` holds English op names.
- **Error contracts (do not unify):**
  - `parse()` throws `ShapeParseError`; `tryParse()` returns `{ ok, error }`.
  - Invariant violations throw; *search* misses return `null`.
  - An unsolvable target is **not** an exception: `solve()` returns `{ ok: false, error, stats }`.
  - CLI prints to stderr and exits `2` on usage errors, `1` on failure.
- **Deliberate mutation and caching** (do not "clean these up" without measuring): `shape.__hash`, the `evalNode` WeakMap, `flatten`'s per-call WeakMap, `decompCache` / `compCache`, `Solver.pieceTables`, and `buildLayout`'s `blocked` / `reserve` / `release` bookkeeping.
- **No `async` inside `solver/src/`.** Only `cli.ts cmdCheck` is async (dynamic import + spawn); `server.ts` serves through `Bun.serve` and transpiles `web/app.ts` per request.
- **Map RNG order is fidelity-critical** (`map.ts`): reordering RNG calls changes every seed.

### Adding a machine

Touch all of:

1. `plan.ts`: node interface + union (`31-88`), cost-carrying builder (`102-129`), `evalNode` case (`137-177`), labels (`183-201`), `flatten` detail case (`245-273`), `evalKey` case (`290-308`).
2. `solver.ts`: `ALL_BUILDINGS` (`30-39`), `ROTATION_BUILDING` if rotater-like (`46-50` / `hasRotation`), the gate checks in `planShape`.
3. `layout.ts`: `BUILDING_INFO` is an exhaustive `Record<BuildingKind,…>` so TS forces the entry (`413-508`); extend `outputSlot` for multi-output machines (`578-583`).
4. `rates.ts`: exhaustive `STEP_RATE` (`44-53`) and `KIND_ZH` (`56-65`).
5. `campaign.ts`: exhaustive `OP_BUILDING` (`27-35`) + `levelOfPlan` (`192-217`); `levels.ts` `REWARD_BUILDINGS` / `availableLevels` for the unlock level.
6. `schematic.ts`: hand lists `ALL_KINDS` (`34-44`), `KIND_COLOR` (`87-97`, fallback `131`), `OVERLAY` (`105-108`).

### Adding a decomposition strategy

Write `fn(shape): ShapePair[]` (pattern: `windowSplits` / `splitCandidates`), validate every pair with `S.stack` + `S.equals`, wrap with `P.stackNode`, register it in the `families` array (`solver.ts:700-703`; order = priority, first accepted candidate short-circuits). It only runs when `stacker && layers >= 2 && !best`. Respect `stats.aborted`; the memo needs no new key (target hash).

## Important Files

|File|Why it matters|
|---|---|
|`solver/src/shape.ts`|The algebra: parse (`:150`), hash (`:225`), cut (`:291-295`), stack (`:309`), paint (`:374`). A change propagates everywhere.|
|`solver/src/plan.ts`|Plan AST (`:31-88`), builders (`:102-129`), `evalNode` (`:137`), `flatten` (`:227`), `verifyPlan` (`:322`), `parseTarget` (`:338`), `planToJSON` (`:358`).|
|`solver/src/solver.ts`|Candidate families and budgets (`:199-200`), `planShape` (`:581`), `solve` (`:740`).|
|`solver/src/layout.ts`|`BUILDING_INFO` port table (`:443`), `routeBelt` (`:693`), `patchCellsByCentre` (`:967`), `allocateBlock` (`:1096`), `expandPlanTree` (`:1226`), `buildLayout` (`:1336`), `buildColorChain` (`:1864`). One factory per call.|
|`solver/src/campaign.ts`|`planCampaign` (`:282`), `SheetView` (`:188`): the sheet module — per-shape solve + layout, the world it owns, campaign-level repair (`repairRoutingGaps` `:784`), throughput, colour gaps, belt ledger.|
|`solver/src/validate.ts`|`validateSheet` + `VIOLATION_KINDS`: sheet legality from the drawing (spans, turns, port facing, hijack, tile ownership). Independent of `routeBelt` and `World`.|
|`solver/src/needs.ts`|Level + upgrade-tier shape requirements (`neededShapes`, `:152`). Feeds `cli all`.|
|`solver/src/levels.ts`|`DEMO_LEVELS` (`:54`), `FULL_LEVELS` (`:66`), unlock tables. The regression corpus.|
|`solver/src/map.ts`|Exact port of the game map generator (`scanMap` `:330`, `scanForTypes` `:404`, `nearestPatch` `:434`).|
|`solver/src/savegame.ts`|Savegame codec (`decodeSavegame` `:76`); writes a literal zero CRC, round-trip is not byte-identical.|
|`solver/src/schematic.ts`|Campaign SVG (`schematicSVG` `:183`), 3×3 chunk-overview representation.|
|`solver/src/router-engine.ts`|Router engine contract + box snapshot; `initRouterWasm` lives here.|
|`native/router/src/lib.rs`|Rust Dijkstra transcribed from the JS router it replaced (bucket ring, cut retry, frontier).|
|`tools/bench-router.ts`|Synthetic router benchmark over `routeBelt`.|
|`solver/test/run-tests.ts`|Harness plus **all** expectations as inline literals.|
|`tools/check-tunnels.ts`|Census adapter: rebuilds the campaign, hands the sheet to `validateSheet`, counts each kind and enforces the routed floors (demo ≥44, full ≥390).|
|`tools/check-test-filter.ts`|Self-check of the harness filter/timings/section partition.|
|`solver/cli.ts`, `solver/server.ts`|User-facing surfaces and exit codes.|
|`package.json`, `tsconfig.json`, `bun.lock`|Scripts, strict compiler options, the single pinned devDependency.|
|`README.md`, `GLOSSARY.md`|Canonical semantics, port table, known limits; glossary vocabulary (中心, 入口格, 可建, 成本, 优解…).|

## Runtime/Tooling Preferences

- **Bun ≥ 1.4.4** (installed 1.4.4+38afee6c8). TypeScript sources run directly: no build step, no bundler, no `typescript` package.
- **Zero runtime dependencies is a hard constraint**: only `node:` builtins and relative imports. `@types/bun` is types only. `bun.lock` resolves from `registry.npmmirror.com`. The Rust router adds no npm dependency: `solver/router.wasm` is a committed artifact, and cargo is only needed to rebuild it.
- `bun check` is Bun's own checker (~50 ms), not tsc. Do not "fix" it by installing `typescript`.
- Import specifiers: `solver/**` imports `./x.js` (Bun resolves to `.ts`); `tools/**` and `setup-ref.ts` import `.ts` directly. Both styles are intentional.
- The web UI imports the solver **in the browser** and solves on the main thread (`app.ts:348-351`); it never calls `/api/solve`. The API is a separate headless surface.
- `solver/server.ts` transpiles `web/app.ts` and every `/src/*.js` request **per request, with no cache**; static root is `solver/`, host hard-wired to `127.0.0.1`, default port 8099 (`--port` is prefix-matched, so `--portx` also "works").
- `demo/` cannot be served by `bun run serve` (absolute `/v/` URLs), and `fetch-demo.sh` overwrites **tracked** files.
- `setup-ref.ts` needs `git` + network; a failed pin fetch only warns, so the checkout can silently drift off `8a79de52`.
- **Generated artifacts:** `demo/**`, `plan-all.svg` and `savegame.bin` are tracked on purpose — regenerate and commit them when their source changes. Everything else under `work/`, `plan-*.svg`, `savegame.json`, `tree.json`, `vendor/`, `ref`, `node_modules/` is ignored.
- No CI, no coverage tool, no snapshots, no golden-SVG comparison.

## Testing & QA

- **Custom harness, no framework** (`bun test` is not used). `check(label, actual, expected)` is `JSON.stringify` deep-equality — object **key order matters**, `undefined` props vanish. `checkTrue(label, cond, detail)`. Sections print as `== … ==`; the footer is `N checks, M failure(s)[, N skipped]`.
- **Exit codes:** `0` pass; `1` any failure **or** a filter that matched nothing; `2` for a bare/empty `--filter` or a bad regex (pre-flight).
- `--filter=<regex>` selects checks whose **section name or label** matches (unanchored, OR). `--timings` prints `(N checks, M fail, X ms)` per section. `--quick` skips both corpus loops (26 sections → 24).
- **Covered:** shape codec + hashing, rotations, cut/stack, the `BUILDING_INFO` port table vs upstream slots, connection start slots, map determinism (seed 47742), savegame round-trip, tunnel-router legality, sheet legality (a legal layout, plus injected damage the checker must see), needs/unlock logic, campaign placement, throughput rates, level 20, the 9 demo and 26 full levels, and the schematic representation.
- **Gaps to know:** the level suites assert only `ok` + `verification.ok`, never `cost` — optimality regressions pass silently (the product criterion is the Pareto frontier, ADR-0001, so `cost` is a proxy). `schematic.ts` *is* covered; `web/app.ts`, `server.ts`, `render.ts`, `cli.ts` and `setup-ref.ts` are not. The corpus loops increment failures outside `--filter`, so filtering neither hides nor speeds them up.
- **`bun run check:tunnels`** (≈20 s full) rebuilds the campaign for seed 47742 and hands the sheet to `validateSheet` — the rules live in `solver/src/validate.ts` and read the drawing only, never `World`: span ≤ 5 tiles, straight sender/receiver ends, no same-direction end inside a span (hijack/break), ends occupy their tile, no belt self-overlap, port-facing ends, and tile ownership (one belt, one end, one direction per tile). Floors the routed count (demo ≥ 44, full ≥ 390). Measured 2026-11-17: demo 48 routed / 21 spans; full 801 routed / 1819 spans, 0 gaps, 0 violations. Run after touching `routeBelt`, the repair pass or `validate.ts`.
- **`bun run check:filter`** (≈50 s) asserts the harness partition (per-section checks sum to the default total; `checks + skipped` equals it on every run), the `--timings` line count, and the exit codes of the no-match / bad-regex / bare / empty lanes. 29 sections. Run after touching `run-tests.ts`.
- **`bun run bench:key`** measures string vs packed-number tile keys: ratio ≈ 16-18×. Keep `World` keyed by numbers.
- **`bun run bench:router`** runs the synthetic routing corpus (default 64×64 / 80 nets / seed 7) on the wasm router; `bun run verify` runs all 261 checks on the same backend.
- **`bun run fuzz --n=40 --seed=1234 --budget=30000`** rebuilds randomly generated producible shapes; the default run is ~25 ms, so raise `--n` / `--budget` before quoting it as evidence.

### Domain constraints — do not "fix" these

- Some targets are **genuinely unsolvable** in-game (e.g. `Cu------:--Cu----:----Cu--`): the stacker needs quadrant overlap to lift a layer. `ok:false` is correct.
- `aborted` means the attempt budget ran out. It is a budget marker, **not** an optimality proof, and raising the budget is not a bug fix (ADR-0001).
- **Optimal plan = Pareto frontier** of delivery rate (items/s into the hub) vs occupied tiles; the ceiling is 16 hub entries × 2/s = 32/s. `cost` (building count) is the search scalar, not the criterion. Today no frontier is emitted.
- Reuse across shapes/factories does not exist and is not an oversight (F28-F30); see the Architecture section before proposing it.
- Belts, orientation, throughput and wire logic are **not modelled**; `beltEstimate` and the rate figures are estimates.
- shapez 1.5.7 has no importable blueprint string, so this project emits coordinates + port-accurate connections instead. Don't go looking for an import format.
- A routing ✕ is recorded honestly and never faked into a route.

## Agent skills

### Issue tracker

Issues live as markdown under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Face Spaghetti

台账 / 探测目录 / 仪器 / 门禁落点见 `docs/agents/face-spaghetti.md`；开工前先读它。
