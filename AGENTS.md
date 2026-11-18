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
- Inside one target the memo returns the **same `PlanNode`** to several parents (the AST is a DAG), and `flatten` preserves that sharing. But `buildLayout` starts with `expandPlanTree(P.flatten(plan))` (`placement.ts:257`), which **copies every shared sub-plan**: one output slot feeds exactly one belt, splitters unlock only at L4, and parts are free (the copy loop in `expandPlanTree`, `layout.ts:987`). Reuse exists only during the search, never in the layout (F29).
- Colour production is **one chain per consumer port** (`buildColorChain`, `color-supply.ts:148`): two painter ports of the same colour grow two chains. `sizeColorSupply` only sizes demand and `colourGap` reports the shortfall (`color-supply.ts:46/78`). Factories share the map, the hub, deposits and belt lanes — never machines (F30).
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

- `BUILDING_INFO` (`layout.ts:404`) is the single source of tile geometry: ports in tile units, y down, multi-output index = `ItemEjector` slot index. Tests align it against upstream.
- `routeBelt` (`layout.ts:683`, the search itself in `routeBeltDetailed` `:655`) is a Dijkstra over `(tile, phase, heading)`; phases 0 = surface, 1–4 = underground, 5 = surfaced. `MAX_UNDERGROUND = 4` = tiles strictly between ends (the game's 5-tile tier-0 span). `TunnelSpan`s are derived after the search; `claimRoute` commits exactly the tested run.
- Tile keys are packed numbers `(x+4096)*8192+(y+4096)` (`cellKey`, `layout.ts:862`; inverse `tileOfKey` `:867`), ~16× faster than `"x|y"` strings for `World` lookups.
- One factory is four modules with one direction: `spots.ts` owns where a part may stand (`createTileClaims`: `blocked`, `fits`, `reserve`, `release`, `nearFits`, `placeNear`, `block`) plus the coarse decisions (`placeExtractor`, `allocateBlock`, `factoryAnchor`); `placement-links.ts` owns the belts (`createLinkScheduler`: `planLink`, `commitLink`, `rip` + `schedule`, the hub faces and trunk merges, the belt/entry owner maps) and the shared merge tree (`mergeSources`); `color-supply.ts` owns the colour demand and chains (`createColourSupply`, `buildColorChain`, `buildSharedColorNet`, `supplyFactoryColours`); `placement.ts` is the session that composes the three (`createPlacementSession`) and `buildLayout` the choreography that places rows, extractors, colour chains and trash cans through them. The tuned knobs live once in `PlacementTuning`: `maxTries`, the near/wide search boxes, `corridor`, `machineGap`, `blockGap`, the rip rounds and `colorGroupSize`; `buildLayout({ tuning })` merges overrides, so an experiment no longer edits the source.
- **Fan-out repair:** a fused group's member copy can leave two consumers reading one output port; `wireFanout` (in the placement session) puts a splitter chain in front of that port and the consumers read its two outputs instead (half rate per branch). The splitter's input faces the feed and shares its approach tile with it, so the spot search skips dead ends and stays bounded (F62).
- The hub is 4×4 with 16 outside entry tiles (`HUB_ENTRIES = 16` in `rates.ts:41`); see *Hub and sustained demand* below.
- `planCampaign` solves every need first, then allocates **copies**: one factory per shape is the floor, and a copy is added to the shape whose whole demand is furthest from done (`allocateCopies`) while the hub's 16 entry belts (2 items/s each) and the deposits can take it, stopping once a shape arrives within an hour. Each copy runs `buildLayout` in its own block (`allocateBlock`, `spots.ts`) and gets its own miners; the first copy keeps the bare `p<index>:` id prefix. An extra copy is a **paste** of the first copy: the processing chain (machines, trash cans, splitters, colour chains and the belts between them) moves verbatim to a free lattice slot and only the two map-dependent ends are searched again (miners onto veins, product into the hub); a paste with no room or no vein falls back to a normal layout. Factory windows are anchored at the factory's own ore (`factoryAnchor`), not at the hub: the miner run is the one belt that cannot be shortened later and it dominates the sheet (on the full set 52% of the links but 88% of the belt tiles). A miner turns through four rotations to find a free ejector side, so a vein whose edge is walled still takes a machine. First copies are laid **fastest first, then longest haul**: a 2/s mining outpost needs a hub entry of its own while a 0.25/s chain can share one, and a factory whose ore sits far away needs the empty map more than a short link does. **Routability is a hard constraint:** a factory is accepted only when its own links all routed and every vein was found, otherwise it is rolled back and rebuilt in a cheaper mode (no miner/colour merging, no shared colour net) and then at a shifted window (`blockShift`). A sheet that leaves a gap is rebuilt with **more room** (`LAYOUT_ATTEMPTS`: shipped knobs, then `corridor 4 / blockGap 12 / machineGap 3`, then `6 / 16 / 4`) — a crowded block is the usual cause, and the first attempt stays the shipped one, so a sheet that already routes is unchanged (`totals.widened`). Only a `validateSheet` violation (a tile claimed twice, an impossible span) voids the whole drawing, and that sheet is rebuilt in the classic one-miner/one-chain mode (`totals.classicFallback`). The CLI writes a drawing only when both checks pass (exit 1, no file, otherwise). Then placements / connections / colour chains / BOM are collected, `repairRoutingGaps` closes cross-factory gaps, and one belt/colour ledger is emitted. The repair has a **gap budget** (`repairWhen`): an attempt with more than three gaps is not repaired at all — a roomier attempt costs seconds where the rip-and-reroute cascade costs minutes (measured 2026-11-18: 749 s of repair on a six-gap sheet, 3 s for the next attempt, same drawing). One shared `World` for all factories, created and owned by this module; it never leaves the seam, and the wasm-side pages are freed with `disposeRouterWorld` when the sheet is done.
- `SheetView` (`campaign.ts:189`) is the sheet's whole interface: hub, buildings, connections, sources, colours, missing resources, routing gaps, belt count, BOM, one frame per factory. `Layout` stays the single-factory type — the sheet is not a fake `Layout` and carries no `world`.
- Whoever moves a run writes its derived fields (`path`, `tunnelSpans`, `tunnelCells`, `beltTiles`) — `buildLayout` and the repair pass alike. The sheet only sums `beltTiles`; nothing re-derives a path from the world. Colour sources are counted from `Placement.color` (miners and mixers), never from synthetic step ids.
- `validateSheet` (`solver/src/validate.ts`) answers "would this stand up in the game" from the drawing alone: span length and straight ends, port facing, hijack, crossings, and tile ownership (one belt, one tunnel end, one direction per tile). It re-derives every rule itself — never `routeBelt`'s state, never `World`; the census is its production adapter, and tests corrupt a real layout to prove it bites.
- Names are one table: `catalogue.ts` owns the three id spaces (`BuildingKind`, `PlanOp`, `BuildingId`), the ordered `BUILDING_KINDS` both legends draw, `BUILDING_NAMES`, and the unlock ids' `GAME_BUILDING_NAMES` (rotater variants derive from the base name). Drawings, BOM lines, bottleneck labels, the CLI and the UI read it; `BUILDING_INFO` carries geometry only, and `Placement.zh` is a copy filled from the catalogue when the sheet is built.
- `--until=N` is a **snapshot**, not an incremental build plan: factories above the cap are deferred and not laid out, nothing is reserved for them, and block positions come from greedy allocation over the set actually built (F35). Measured on the demo set: cap=1 lays out 2 blocks (coincidentally at their full-sheet positions), cap=5 moves `--CuCu--` from `[-63,-18]` to `[57,0]`.
- `beltEstimate` counts routed belt cells (tunnel ends count, underground cells do not). Belts, orientation, throughput and wire logic are **not modelled**; the rate numbers are estimates. The sheet does report what its belts carry (`beltLinks`, `beltUtilP50`, `beltSparseShare`, `beltOverloaded`, `beltCapacity`, `beltIdle`, `beltIdleShare`, `beltHeadroom`, `beltCritical`): flow is the producer's own rate (a miner 0.4/s, a merger the sum of its inputs up to 2/s), a link well under a belt means a slow machine behind it, and a merge point at 2/s is listed in `beltCritical` — full with no slack, one more source away from jamming. A link over 2/s is a merge that cannot work — congestion and sparsity are never reported as the same thing.

### Hub and sustained demand

- The hub's 16 entry slots accept **any** shape (`ItemAcceptor` filter is only `"shape"`), and its processing speed is unbounded (`getProcessorBaseSpeed(hub) = 1e30`). Delivered shapes accumulate forever in `storedShapes`; the current level goal reads `storedShapes[goal]`. Sharing an entry between products is therefore legal — "one product per entry" is a throughput policy, not a game rule (F31).
- The full game has **992 endgame upgrade tiers per track** (4 tracks; demo: none), each demanding sustained quantities of the preparement / final / rocket shapes (F32). Cumulative endgame demand is ≈ 9.9e9 items per track (Σ 70 000 + 20 000·i), ≈ **4e10 items** over 4 tracks — about 39 years at the 32/s hub ceiling, i.e. endless by design. `needs.ts` includes only the first endgame tier as a needed shape; sustained delivery rate is not modelled.
- Level 14 (belt reader) is the one `throughputOnly` goal: it checks the **current rate** (8/s), not stored stock, so it is the literal "keep it running" requirement (`ref/modes/levels.js:262-269`; `hub_goals.getCurrentGoalDelivered`).
- Blueprints (copy-paste) cost **stored** `CbCbCbRb:CwCwCwCw` (`4·n^1.1`, rounded) and the cost is deducted on placement (F33). That shape is also full level 12's goal, so the campaign already builds it.
- The solver allocates hub faces greedily (up to 6 free faces + 3 join faces per inbound link); when every entry is boxed in by belts laid earlier it merges the leg into a belt already bound for the hub (`World.hubBound`). `hubEntryLoad` is a **rate**, not a leg count: a leg joins only while the entry's load plus that leg's items/s stays within the 2/s belt (`claimRoute`/`releaseRoute` add and subtract `RouteResult.rate`), so a 0.25/s factory can share an entry eight ways. `hubMerges` counts the legs that had to merge. It builds no merger tree and reserves no entry per product (F34, F43).
- **Router:** `routeBelt` builds the search box in the Rust core (`native/router`) through `solver/src/router-engine.ts`; the JS router it replaced is gone (F49, F51). `solver/router.wasm` is a committed build product (`bun run build:router`). `cli all`, the test harness and `check:tunnels` load it synchronously at startup; `web/worker.ts` fetches `/router.wasm` before the first campaign. A missing wasm file is a hard error, not a silent JS fallback. The wasm side keeps a **resident copy** of every search-relevant tile in lazily allocated 64×64 pages (one little-endian u32 per cell: `flags | belt << 8 | end << 16 | under << 24`). `World` stays authoritative in JS: the tracked collections in `solver/src/router-log.ts` (`SyncMap`/`SyncSet` around belts, tunnelCells, tunnelEnds, tunnelUnder, walls, approaches and the per-session `blocked`) mark every changed tile, and each search flushes just those `(key, word)` pairs; wasm applies them, then builds the box from its pages. No per-search map encoding (F59). The search surface is `world.walls ∪ world.approaches ∪ world.blocked`: `createTileClaims` and the campaign repair rebuild `world.blocked` per session, and `planCampaign` frees the wasm-side world when the sheet is done. A failed search also reports whether it ever tried to step out of its box: `routeBeltDetailed` returns that verdict, a failure that never touched the edge is definitive, and both `placement-links` and the campaign repair skip their wider retry on it. The repair's wide box scales with the span (`min(240, 2·span + 40)`, floor 60) — a 480-tile box around a five-tile hop buys nothing (F58).

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
bun run test                   # 306 checks, 0 failure, ~1.5 s
bun run test:quick             # 271 checks, skips both level loops, ~1.2 s
bun run test --filter=router   # 32 checks, 274 skipped
bun run check:tunnels          # campaign tunnel legality; demo 0.3 s, full 10 s (F73 gap budget), not in verify
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
- `all` never exits non-zero for failed / impossible / deferred shapes — **except** a sheet with any routing gap or `validateSheet` violation: it refuses to write the drawing and exits 1. A bad `--until` exits 2.
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
- **Deliberate mutation and caching** (do not "clean these up" without measuring): `shape.__hash`, the `evalNode` WeakMap, `flatten`'s per-call WeakMap, `decompCache` / `compCache`, `Solver.pieceTables`, and `createPlacementSession`'s `blocked` / `reserve` / `release` bookkeeping.
- **No `async` inside `solver/src/`.** Only `cli.ts cmdCheck` is async (dynamic import + spawn); `server.ts` serves through `Bun.serve` and transpiles `web/app.ts` per request.
- **Map RNG order is fidelity-critical** (`map.ts`): reordering RNG calls changes every seed.

### Adding a machine

Touch all of:

1. `catalogue.ts`: the `BuildingKind` union, `BUILDING_KINDS` in legend order, `BUILDING_NAMES`; add the unlock id to `GAME_BUILDING_NAMES` when `ALL_BUILDINGS` grows — both records are exhaustive, so TS forces it.
2. `plan.ts`: node interface + union, cost-carrying builder, `evalNode` case, `flatten` detail case, `evalKey` case.
3. `solver.ts`: `ALL_BUILDINGS`, `ROTATION_BUILDING` if rotater-like (`hasRotation`), the gate checks in `planShape`.
4. `layout.ts`: `BUILDING_INFO` is an exhaustive `Record<BuildingKind,…>` so TS forces the geometry entry; extend `outputSlot` for multi-output machines.
5. `rates.ts`: exhaustive `STEP_RATE`.
6. `campaign.ts`: exhaustive `OP_BUILDING` + `levelOfPlan`; `levels.ts` `REWARD_BUILDINGS` / `availableLevels` for the unlock level.
7. `schematic.ts`: `KIND_COLOR` and `OVERLAY` — the drawing's own paint, not the vocabulary.

### Adding a decomposition strategy

Write `fn(shape): ShapePair[]` (pattern: `windowSplits` / `splitCandidates`), validate every pair with `S.stack` + `S.equals`, wrap with `P.stackNode`, register it in the `families` array (`solver.ts:700-703`; order = priority, first accepted candidate short-circuits). It only runs when `stacker && layers >= 2 && !best`. Respect `stats.aborted`; the memo needs no new key (target hash).

## Important Files

|File|Why it matters|
|---|---|
|`solver/src/shape.ts`|The algebra: parse (`:150`), hash (`:225`), cut (`:291-295`), stack (`:309`), paint (`:374`). A change propagates everywhere.|
|`solver/src/plan.ts`|Plan AST (`:31-88`), builders (`:102-129`), `evalNode` (`:137`), `flatten` (`:227`), `verifyPlan` (`:322`), `parseTarget` (`:338`), `planToJSON` (`:358`).|
|`solver/src/solver.ts`|Candidate families and budgets (`:199-200`), `planShape` (`:581`), `solve` (`:740`).|
|`solver/src/catalogue.ts`|`BuildingKind`, `BUILDING_KINDS`, `BUILDING_NAMES`, `GAME_BUILDING_NAMES`: the only place a machine gets a name.|
|`solver/src/layout.ts`|The tile world: `BUILDING_INFO` port table (`:395`), `routeBeltDetailed` (`:655`) / `routeBelt` (`:683`), `cellKey`/`tileOfKey` (`:862`), `patchCellsByCentre` (`:872`), `expandPlanTree` (`:987`), `planBom` (`:1029`); `createWorld` (`:882`) wires the tracked collections.|
|`solver/src/placement.ts`|One plan → one factory: `PlacementTuning` (`:54`, defaults `:84`), `PlacementSession` (`:121`), `createPlacementSession` (`:145`), `buildLayout` (`:243`). Composes the three seams below; no policy of its own.|
|`solver/src/spots.ts`|Where parts may stand: `createTileClaims` (`:63`: `blocked`, `fits`, `reserve`, `release`, `nearFits`, `placeNear`, `block`), `placeExtractor` (`:187`), `allocateBlock` (`:251`), `factoryAnchor` (`:297`).|
|`solver/src/placement-links.ts`|The belts of one factory: `createLinkScheduler` (`:144`) with `planLink` (`:238`), `commitLink` (`:413`), `rip` + `schedule` (`:531`), the hub faces and trunk merges.|
|`solver/src/color-supply.ts`|Colour demand and chains: `sizeColorSupply` (`:46`), `colourGap` (`:78`), `createColourSupply` (`:134`) → `buildColorChain` (`:148`), `buildSharedColorNet` (`:279`), `supplyFactoryColours` (`:382`).|
|`solver/src/recipe.ts`|The recipe diagram of a solved plan: `recipeDiagram` (`:76`) → cards (one per machine), feeds (outlet/colour/slot/`下层`·`上层`), machine-level waves and per-feed lanes. Pure; the SVG lives in `web/app.ts`.|
|`solver/src/campaign.ts`|`planCampaign` (`:282`), `SheetView` (`:188`): the sheet module — per-shape solve + layout, the world it owns, campaign-level repair (`repairRoutingGaps` `:784`), throughput, colour gaps, belt ledger.|
|`solver/src/validate.ts`|`validateSheet` + `VIOLATION_KINDS`: sheet legality from the drawing (spans, turns, port facing, hijack, tile ownership). Independent of `routeBelt` and `World`.|
|`solver/src/needs.ts`|Level + upgrade-tier shape requirements (`neededShapes`, `:152`). Feeds `cli all`.|
|`solver/src/levels.ts`|`DEMO_LEVELS` (`:54`), `FULL_LEVELS` (`:66`), unlock tables. The regression corpus.|
|`solver/src/map.ts`|Exact port of the game map generator (`scanMap` `:330`, `scanForTypes` `:404`, `nearestPatch` `:434`).|
|`solver/src/savegame.ts`|Savegame codec (`decodeSavegame` `:76`); writes a literal zero CRC, round-trip is not byte-identical.|
|`solver/src/schematic.ts`|Campaign SVG (`schematicSVG` `:183`), 3×3 chunk-overview representation.|
|`solver/src/router-engine.ts`|Resident-world wasm binding: world ids, the dirty-cell flush (`(key, word)` pairs), the search request/result and `disposeRouterWorld`; `initRouterWasm` lives here.|
|`solver/src/router-log.ts`|`RouterLog` + `SyncMap`/`SyncSet`: every mutation of a mirrored World structure marks its tile for the next flush.|
|`native/router/src/lib.rs`|Rust Dijkstra transcribed from the JS router it replaced (bucket ring, cut retry, frontier, box verdict) plus the resident 64×64 page grid, delta application and per-search box build.|
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
- `--filter=<regex>` selects checks whose **section name or label** matches (unanchored, OR). `--timings` prints `(N checks, M fail, X ms)` per section. `--quick` skips both corpus loops (34 sections → 32).
- **Covered:** shape codec + hashing, rotations, cut/stack, the `BUILDING_INFO` port table vs upstream slots, connection start slots, map determinism (seed 47742), savegame round-trip, tunnel-router legality, sheet legality (a legal layout, plus injected damage the checker must see), the three layout seams driven on their own (a walled link reports a gap and `schedule()` closes it after the wall is gone; two ports of one colour grow two chains; `colourGap` names the short colour), the recipe diagram (one card per machine, waves point right, only wave-skipping feeds get lanes, stack port labels, a mixed colour chain), needs/unlock logic, campaign placement, throughput rates, level 20, the 9 demo and 26 full levels, and the schematic representation.
- **Gaps to know:** the level suites assert only `ok` + `verification.ok`, never `cost` — optimality regressions pass silently (the product criterion is the Pareto frontier, ADR-0001, so `cost` is a proxy). `schematic.ts` and `recipe.ts` *are* covered; `web/app.ts` (the renderer), `server.ts`, `render.ts`, `cli.ts` and `setup-ref.ts` are not. The corpus loops increment failures outside `--filter`, so filtering neither hides nor speeds them up.
- **`bun run check:tunnels`** (demo 0.3 s; full 10 s) rebuilds the campaign for seed 47742 and hands the sheet to `validateSheet` — the rules live in `solver/src/validate.ts` and read the drawing only, never `World`: span ≤ 5 tiles, straight sender/receiver ends, no same-direction end inside a span (hijack/break), ends occupy their tile, no belt self-overlap, port-facing ends, and tile ownership (one belt, one end, one direction per tile). Floors the routed count (demo ≥ 44, full ≥ 390). Measured 2026-11-18: demo PASS (58 routed / 29 spans / 0 gaps, 0.25 s); full PASS (451 routed / 923 spans / 0 gaps, 10.2 s). The full check used to take >8 min because the campaign repair chewed on a six-gap sheet; the `repairWhen` gap budget (F73) took it to 10 s. Run after touching `routeBelt`, the repair pass or `validate.ts`.
- **`bun run check:filter`** (≈90 s) asserts the harness partition (per-section checks sum to the default total; `checks + skipped` equals it on every run), the `--timings` line count, and the exit codes of the no-match / bad-regex / bare / empty lanes. 35 sections. Run after touching `run-tests.ts`.
- **`bun run bench:key`** measures string vs packed-number tile keys: ratio ≈ 16-18×. Keep `World` keyed by numbers.
- **`bun run bench:router`** runs the synthetic routing corpus (default 64×64 / 80 nets / seed 7) on the wasm router; `bun run verify` runs all 306 checks on the same backend.
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
