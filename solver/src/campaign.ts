/**
 * "All shapes you need" solver: solve every shape the campaign asks for and lay
 * the factories out on one shared map, all delivering into the same hub.
 *
 * The hub keeps a permanent record of every shape ever delivered — that is what
 * the in-game note "您生产过的所有图形都会被用于解锁升级" means — so the winning
 * plan is one factory cluster that produces the whole union, never a per-level
 * build that gets torn down again.
 */

import { solve, solve as solveWithAllBuildings, ALL_BUILDINGS } from "./solver.js";
import type { SolveSuccess } from "./solver.js";
import {
    BUILDING_INFO,
    HUB_SIZE,
    cellKey,
    claimRoute,
    createWorld,
    expandPlanTree,
    fuseCuts,
    patchCellsByCentre,
    portApproachCells,
    portCells,
    portCentre,
    releaseRoute,
    routeBeltDetailed,
    runFits,
} from "./layout.js";
import { buildLayout } from "./placement.js";
import type { Layout, PlacementTuning } from "./placement.js";
import { hubApproaches, hubBorderOf } from "./placement-links.js";
import { disposeRouterWorld } from "./router-engine.js";
import { colourGap, sizeColorSupply } from "./color-supply.js";
import { validateSheet } from "./validate.js";
import type {
    BeltHeading,
    BlockRect,
    BomEntry,
    Connection,
    LayoutColor,
    LayoutSource,
    Placement,
    PlanFrame,
    PlanTree,
    Rot,
    RouteResult,
    RoutingGap,
    Tile,
    TunnelSpan,
    World,
} from "./layout.js";
import { bottleneck, factoryRate, minerCount, HUB_ENTRIES, SOURCE_RATE, MINER_RATE, BELT_RATE } from "./rates.js";
import type { Bottleneck } from "./rates.js";
import { availableLevels, buildingsForLevel, FULL_LEVELS } from "./levels.js";
import type { Level } from "./levels.js";
import { patchMinerCapacity } from "./map.js";
import type { Patch } from "./map.js";
import { colorChain, colorChains, isMixedColor } from "./color.js";
import type { ColorChain } from "./color.js";
import { flatten } from "./plan.js";
import type { FlatPlan, PlanOp } from "./plan.js";
import type { ColorChar } from "./shape.js";
import type { NeededShape, ShapeSource } from "./needs.js";

/** the game building a plan op needs (a miner is always available) */
const OP_BUILDING: Record<PlanOp, string | null> = {
    base: null,
    cutHalf: "cutter",
    cutQuad: "quadCutter",
    rotate: "rotaterCW",
    stack: "stacker",
    paint: "painter",
    paint4: "quadPainter",
};

interface CampaignEntryBase {
    /** 1-based row number on the sheet */
    index: number;
    code: string;
    sources: ShapeSource[];
}

export interface CampaignOkEntry extends CampaignEntryBase {
    ok: true;
    status: "ok";
    cost: number;
    buildings: number;
    belts: number;
    bounds: BlockRect | null;
    missing: string[];
    /** one copy's delivery rate, once its miners are sized */
    rate: number;
    /** factories of this shape on the sheet */
    copies: number;
    /** every copy's delivery rate, items/s */
    totalRate: number;
    limit: Bottleneck | null;
    /** colours the painters of this factory pull, one item per output item */
    colorPorts: ColorChar[];
    availableAt: number;
    /** items the game asks for, summed over every source that needs this shape */
    amount: number;
    /** seconds to deliver `amount` at `totalRate` */
    eta: number;
}

export interface CampaignFailedEntry extends CampaignEntryBase {
    ok: false;
    status: "failed";
    /** the solver's reason; `undefined` only when a plan fails its own verification */
    error: string | undefined;
    buildings: number;
    belts: number;
    bounds: null;
}

export interface CampaignDeferredEntry extends CampaignEntryBase {
    ok: false;
    status: "deferred";
    availableAt: number;
    reason: string;
    buildings: number;
    belts: number;
    bounds: null;
}

export interface CampaignImpossibleEntry extends CampaignEntryBase {
    ok: false;
    status: "impossible";
    availableAt: null;
    reason: string;
    buildings: number;
    belts: number;
    bounds: null;
}

export type CampaignEntry = CampaignOkEntry | CampaignFailedEntry | CampaignDeferredEntry | CampaignImpossibleEntry;

/** items/s one colour has to produce, summed over every colour port of every painter */
export interface CampaignColorDemand {
    color: ColorChar;
    rate: number;
}

/** colour sources the drawn layout does not have yet */
export interface CampaignColorGap {
    color: ColorChar;
    need: number;
    have: number;
    kind: string;
}

/** mixers a deposit cannot hold: every miner needs a free neighbouring tile */
export interface CampaignCapacityGap {
    color: ColorChar;
    need: number;
    capacity: number;
}

export interface CampaignThroughput {
    beltRate: number;
    minerRate: number;
    sourceRate: number;
    colorDemand: CampaignColorDemand[];
    demandTotal: number;
    supplyAvailable: number;
    builtSourceCount: number;
    demandSizedCount: number;
    colorGap: CampaignColorGap[];
    extraSources: number;
    capacityGap: CampaignCapacityGap[];
    splitters: number;
    worstFanout: number;
    hubInbound: number;
    hubMerges: number;
    /** copies of every factory on the sheet */
    factories: number;
    /** items/s the sheet delivers into the hub */
    deliveredRate: number;
    /** items/s the 16 hub entries can take, upgrade level 1 */
    hubCapacity: number;
    /** seconds until the last needed shape is delivered */
    criticalEta: number;
    /** trash-can buildings on the sheet */
    trashCans: number;
    /** items/s those cans destroy (every unused cutter output) */
    wasteRate: number;
    balancerAt: number | null;
    tunnelAt: number | null;
}

export interface CampaignTotals {
    requested: number;
    shapes: number;
    failed: number;
    deferred: number;
    impossible: number;
    unbuildable: number;
    routingGaps: number;
    buildings: number;
    belts: number;
    untilLevel: number | null;
    /** the full layout could not route everything; this sheet is the classic one */
    classicFallback?: boolean;
    throughput: CampaignThroughput;
}

/**
 * The campaign sheet: one shared world, one hub, one frame per factory. This is
 * the module's whole drawing and reporting surface — the `World` the factories
 * share never leaves it.
 */
export interface SheetView {
    hub: Tile;
    buildings: Placement[];
    connections: Connection[];
    sources: LayoutSource[];
    colors: LayoutColor[];
    /** resources the map does not have */
    missing: string[];
    routingGaps: RoutingGap[];
    /** belt cells the drawing needs, tunnels counted twice */
    beltEstimate: number;
    bom: BomEntry[];
    /** one entry per factory */
    plans: PlanFrame[];
}

export interface CampaignOptions {
    /** needed shapes, in build order */
    shapes: readonly NeededShape[];
    /** map patches (from map.js) */
    patches: Patch[];
    /** hub tile origin */
    hub: Tile;
    /** search budget per shape */
    maxAttempts?: number;
    /** available buildings; null = all */
    buildings?: ReadonlySet<string> | null;
    /**
     * only plan factories buildable by this level, and never let the search use
     * a machine unlocked after it
     */
    untilLevel?: number | null;
    /** level table the unlock levels come from */
    levels?: readonly Level[];
    /** internal: build every factory in the classic one-miner/one-chain mode */
    classic?: boolean;
    /** internal: placement knobs for a classic retry variant */
    tuning?: Partial<PlacementTuning>;
}

export interface CampaignResult {
    /** every requested shape was planned, buildable and routed */
    ok: boolean;
    entries: CampaignEntry[];
    sheet: SheetView;
    totals: CampaignTotals;
}

/**
 * The level a factory can first exist on: the last machine it needs (including
 * the mixers behind every mixed paint colour) has to be unlocked, and the
 * shape itself has to be asked for. `Infinity` = a machine this version never
 * unlocks, so the factory can never be built — the demo ends before the
 * stacker.
 */
function levelOfPlan(
    flat: FlatPlan,
    sources: readonly ShapeSource[],
    chains: readonly ColorChain[],
    unlock: ReadonlyMap<string, number>,
): number {
    let at = 1;
    let never = false;
    const require = (building: string) => {
        const level = unlock.get(building);
        if (level === undefined) never = true;
        else if (level > at) at = level;
    };
    for (const step of flat.steps) {
        const building = OP_BUILDING[step.op];
        if (building) require(building);
    }
    // a mixed paint colour is a mixer chain the plan ops never mention
    for (const chain of chains) {
        for (const op of chain.ops) if (op.kind === "mixer") require("mixer");
    }
    for (const source of sources) {
        if (source.kind === "level" && source.level > at) at = source.level;
    }
    return never ? Infinity : at;
}

/** bounding box of a factory, one tile of margin so frames do not touch buildings */
function boundsOf(buildings: readonly Placement[]): BlockRect {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of buildings) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX - 1, y: minY - 1, w: maxX - minX + 2, h: maxY - minY + 2 };
}

/** what one copy of a factory costs the map */
export interface CopyItem {
    amount: number;
    rate: number;
    /** miners one copy needs, by deposit key (`shape:<code>` / `color:<c>`) */
    miners: ReadonlyMap<string, number>;
}

/**
 * Copies stop once a shape's whole demand arrives within an hour. The sheet is
 * meant to be built and played, not to spend the map on shaving minutes off a
 * small goal; the endgame shapes are days long at one copy, so this is what
 * makes the hub the binding limit there.
 */
const COPY_TARGET_SECONDS = 3600;

/** miners a deposit can hold, using the same cells `placeExtractor` reads */
function minerCapacityByItem(patches: readonly Patch[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of patches) {
        const key = p.item.kind === "shape" ? `shape:${p.item.code}` : `color:${p.item.color}`;
        const cells = patchCellsByCentre(p).map((c): [number, number] => [c.x, c.y]);
        // the cell count is an upper bound: the belts of the miners already on
        // the vein run across it, and every one they cover costs a port cell.
        // Measured on seed 47742 a vein takes about a third of its raw count
        // before a new miner finds no clear ejector side, so budget for that.
        out.set(key, (out.get(key) ?? 0) + Math.floor(patchMinerCapacity({ cells }) * 0.3));
    }
    return out;
}

/** the world state one factory build mutates, for a copy that has to be dropped */
interface WorldSnapshot {
    occupied: Set<number>;
    walls: Set<number>;
    approaches: Set<number>;
    belts: Map<number, BeltHeading>;
    tunnelCells: Set<number>;
    tunnelEnds: Map<number, number>;
    tunnelUnder: Map<number, number>;
    hubApproaches: Set<number>;
    hubBound: Map<number, number>;
    hubEntryLoad: Map<number, number>;
    blocks: number;
}

function snapshotWorld(world: World): WorldSnapshot {
    return {
        occupied: new Set(world.occupied),
        walls: new Set(world.walls),
        approaches: new Set(world.approaches),
        belts: new Map(world.belts),
        tunnelCells: new Set(world.tunnelCells),
        tunnelEnds: new Map(world.tunnelEnds),
        tunnelUnder: new Map(world.tunnelUnder),
        hubApproaches: new Set(world.hubApproaches),
        hubBound: new Map(world.hubBound),
        hubEntryLoad: new Map(world.hubEntryLoad),
        blocks: world.blocks.length,
    };
}

/**
 * Put the world back the way it was before a factory that turned out to have no
 * vein left was laid out. The tracked collections are cleared and refilled in
 * place, so every reverted cell still reaches the router's resident copy.
 */
function restoreWorld(world: World, saved: WorldSnapshot): void {
    const refillMap = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
        target.clear();
        for (const [key, value] of source) target.set(key, value);
    };
    const refillSet = <V>(target: Set<V>, source: Set<V>): void => {
        target.clear();
        for (const value of source) target.add(value);
    };
    refillSet(world.occupied, saved.occupied);
    refillSet(world.walls, saved.walls);
    refillSet(world.approaches, saved.approaches);
    refillMap(world.belts, saved.belts);
    refillSet(world.tunnelCells, saved.tunnelCells);
    refillMap(world.tunnelEnds, saved.tunnelEnds);
    refillMap(world.tunnelUnder, saved.tunnelUnder);
    refillSet(world.hubApproaches, saved.hubApproaches);
    refillMap(world.hubBound, saved.hubBound);
    refillMap(world.hubEntryLoad, saved.hubEntryLoad);
    world.blocks.length = saved.blocks;
}

/**
 * How many copies of every factory the map can take.
 *
 * One copy each is the floor. Beyond that, the next copy goes to the shape
 * whose remaining time is longest — the classic longest-job-first water fill —
 * until the hub's 16 entry belts (2 items/s each) or a deposit would overfill.
 * A shape with no demand (`amount` 0, e.g. a `--code` probe) never grows.
 *
 * The deposit check runs on the same cell model the layout uses: the miner
 * count for every base step, and the colour sources `sizeColorSupply` derives
 * from the painters' pull. A copy that would ask a vein for more miners than it
 * can hold is not built — the sheet stays buildable, and the hub is filled by
 * the factories the map can actually feed.
 */
export function allocateCopies(items: readonly CopyItem[], capacity: ReadonlyMap<string, number>): number[] {
    const copies = items.map(() => 1);
    const hubCapacity = HUB_ENTRIES * BELT_RATE;
    let total = items.reduce((sum, it) => sum + it.rate, 0);
    /** miners every copy chosen so far takes from each deposit */
    const used = new Map<string, number>();
    const add = (item: CopyItem, sign: number): void => {
        for (const [key, n] of item.miners) used.set(key, (used.get(key) ?? 0) + sign * n);
    };
    for (const item of items) add(item, +1);
    const overfills = (): boolean => {
        for (const [key, n] of used) if (n > (capacity.get(key) ?? 0)) return true;
        return false;
    };
    for (;;) {
        let pick = -1;
        let longest = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i]!;
            if (it.amount <= 0 || it.rate <= 0) continue;
            // a shape that already arrives inside the target is done: another
            // copy would only shave minutes off a job nobody is waiting on
            const eta = it.amount / (copies[i]! * it.rate);
            if (eta <= COPY_TARGET_SECONDS) continue;
            if (total + it.rate > hubCapacity + 1e-9) continue;
            add(it, +1);
            const fits = !overfills();
            add(it, -1);
            if (!fits) continue;
            if (eta > longest + 1e-9) {
                longest = eta;
                pick = i;
            }
        }
        if (pick < 0) break;
        add(items[pick]!, +1);
        copies[pick] = (copies[pick] ?? 1) + 1;
        total += items[pick]!.rate;
    }
    return copies;
}

/**
 * Plan every requested shape on one map, with routability as a hard constraint.
 *
 * A sheet with a red ✕ is a diagnostic, not a drawing to build from. When the
 * full layout (miners sized to their machines) leaves any link unrouted, the
 * sheet is rebuilt in the classic mode — one miner per base step, one colour
 * chain per port — which is the layout that routed before copies existed. The
 * caller can see the choice in `totals.classicFallback`; a gap is never hidden.
 */
export function planCampaign(options: CampaignOptions): CampaignResult {
    if (options.classic) return planCampaignOnce(options);
    const full = planCampaignOnce(options);
    if (full.totals.routingGaps === 0 && validateSheet(full.sheet).length === 0) return full;
    // the full layout leaves a link unrouted or a tile claimed twice: rebuild in
    // the classic factory style (one miner per base, one chain per port). The
    // caller refuses to draw this sheet as well unless it is clean.
    const classic = planCampaignOnce({ ...options, classic: true });
    classic.totals.classicFallback = true;
    return classic;
}

/** one build attempt; see `planCampaign` for the fallback */
function planCampaignOnce({
    shapes,
    patches,
    hub,
    maxAttempts = 30000,
    buildings = null,
    untilLevel = null,
    levels = FULL_LEVELS,
    classic = false,
    tuning,
}: CampaignOptions): CampaignResult {
    const world = createWorld({ hub, patches });
    const unlock = availableLevels(levels);
    const tunnelAt = unlock.get("tunnel") || null;
    // before L6 belts cannot cross at all, so routing must go around
    const allowTunnels = untilLevel == null || (tunnelAt !== null && untilLevel >= tunnelAt);
    // a shared colour net needs the splitter, which the game hands out at L20
    const splitterAt = unlock.get("splitter") || null;
    const allowColourNet = splitterAt !== null && (untilLevel == null || untilLevel >= splitterAt);
    // joining several miners or colour chains into one belt needs the merger
    const mergerAt = unlock.get("merger") || null;
    const allowMerge = !classic && mergerAt !== null && (untilLevel == null || untilLevel >= mergerAt);
    // never plan with a machine this version does not hand out — the demo
    // simply has no stacker — and cap that at the requested level as well
    const last = levels[levels.length - 1];
    const lastLevel = last ? last.level : 0;
    const cap = buildingsForLevel(levels, untilLevel ?? lastLevel + 1);
    const allowed = new Set([...(buildings ?? ALL_BUILDINGS)].filter((building) => cap.has(building)));
    const baseCodes = [...new Set(patches.flatMap((p) => (p.item.kind === "shape" ? [p.item.code] : [])))];
    const entries: CampaignEntry[] = [];
    const plans: PlanFrame[] = [];
    const allBuildings: Placement[] = [];
    const allConnections: Connection[] = [];
    const allSources: LayoutSource[] = [];
    const missing = new Set<string>();
    const bom = new Map<string, number>();
    const colors = new Map<ColorChar, LayoutColor>();
    let beltEstimate = 0;
    let totalBuildings = 0;
    let trashCans = 0;
    let wasteRate = 0;
    let failed = 0;
    let deferred = 0;
    let impossible = 0;
    let unbuildable = 0;
    const gapList: RoutingGap[] = [];

    /** one buildable need, prepared before any layout so copies can be sized */
    interface PreparedNeed {
        index: number;
        need: NeededShape;
        res: SolveSuccess;
        /** the flat plan every copy lays out */
        flat: PlanTree;
        /** items/s one copy delivers once its miners are sized */
        rate: number;
        amount: number;
        colorPorts: ColorChar[];
        /** miners one copy needs, by deposit key */
        miners: Map<string, number>;
        availableAt: number;
        copies: number;
    }
    const prepared: (PreparedNeed | null)[] = shapes.map(() => null);
    /** a row that needs no layout: failed, deferred or impossible */
    const rows: (CampaignEntry | null)[] = shapes.map(() => null);

    shapes.forEach((need, i) => {
        const index = i + 1;
        const search = { maxAttempts, baseCodes, buildings: allowed };
        let res = solve(need.code, search);
        if (!res.ok) {
            // the cap can make a shape unsolvable because its machine is still
            // locked; a plan that only uses unlocked machines is legal even if
            // the narrower search missed it, and an uncapped plan that needs a
            // machine this version lacks says why
            const free = solveWithAllBuildings(need.code, { maxAttempts, baseCodes });
            if (free.ok) {
                const freeAt = levelOfPlan(free.flat, need.sources, colorChains(free.flat.steps), unlock);
                if (freeAt === Infinity) {
                    impossible += 1;
                    rows[i] = {
                        index,
                        code: need.code,
                        ok: false,
                        status: "impossible",
                        availableAt: null,
                        reason: "本版本没有它需要的机器（试玩版没有堆叠器）",
                        sources: need.sources,
                        buildings: 0,
                        belts: 0,
                        bounds: null,
                    };
                    return;
                }
                if (untilLevel != null && freeAt > untilLevel) {
                    deferred += 1;
                    rows[i] = {
                        index,
                        code: need.code,
                        ok: false,
                        status: "deferred",
                        availableAt: freeAt,
                        reason: `需要 L${freeAt}`,
                        sources: need.sources,
                        buildings: 0,
                        belts: 0,
                        bounds: null,
                    };
                    return;
                }
                res = free;
            }
        }
        if (!res.ok) {
            failed += 1;
            rows[i] = {
                index,
                code: need.code,
                ok: false,
                status: "failed",
                error: res.error,
                sources: need.sources,
                buildings: 0,
                belts: 0,
                bounds: null,
            };
            return;
        }
        const chains = colorChains(res.flat.steps);
        const availableAt = levelOfPlan(res.flat, need.sources, chains, unlock);
        if (availableAt === Infinity) {
            impossible += 1;
            rows[i] = {
                index,
                code: need.code,
                ok: false,
                status: "impossible",
                availableAt: null,
                reason: "本版本没有它需要的机器（试玩版没有堆叠器）",
                sources: need.sources,
                buildings: 0,
                belts: 0,
                bounds: null,
            };
            return;
        }
        if (untilLevel != null && availableAt > untilLevel) {
            deferred += 1;
            rows[i] = {
                index,
                code: need.code,
                ok: false,
                status: "deferred",
                availableAt,
                reason: `需要 L${availableAt}`,
                sources: need.sources,
                buildings: 0,
                belts: 0,
                bounds: null,
            };
            return;
        }
        // the same flat plan `buildLayout` lays out, so the rate and the colour
        // ports are known before the first copy exists
        const flat = expandPlanTree(fuseCuts(flatten(res.plan)));
        const colorPorts: ColorChar[] = [];
        for (const step of flat.steps) {
            if (step.op === "paint" && step.node.op === "paint") colorPorts.push(step.node.color);
            else if (step.op === "paint4" && step.node.op === "paint4") {
                for (const c of step.node.colors) if (c && c !== "u") colorPorts.push(c);
            }
        }
        const rate = factoryRate(flat.steps, allowMerge);
        const miners = new Map<string, number>();
        for (const step of flat.steps) {
            const node = step.node;
            if (node.op !== "base") continue;
            const code = node.code || `${node.type}u${node.type}u${node.type}u${node.type}u`;
            const key = `shape:${code}`;
            miners.set(key, (miners.get(key) ?? 0) + (allowMerge ? minerCount(rate) : 1));
        }
        // one chain per colour port; a port that pulls more than 0.4/s gets
        // several, and each chain starts at the base miners its recipe names
        const chainsPerPort = allowMerge ? Math.max(1, Math.ceil(rate / SOURCE_RATE - 1e-9)) : 1;
        for (const color of colorPorts) {
            for (const op of colorChain(color)) {
                if (op.kind !== "base") continue;
                const key = `color:${op.color}`;
                miners.set(key, (miners.get(key) ?? 0) + chainsPerPort);
            }
        }
        prepared[i] = {
            index,
            need,
            res,
            flat,
            rate,
            amount: need.sources.reduce((sum, s) => sum + ("required" in s ? s.required : s.amount), 0),
            colorPorts,
            miners,
            availableAt,
            copies: 1,
        };
    });

    // ---- copies: fill the hub, longest job first -----------------------------
    //
    // One factory is one chain, so a stacker factory delivers 0.25 items/s and
    // a 25 000-item goal takes days. The hub is the shared limit — 16 entries ×
    // 2 items/s — so copies go to whichever shape is furthest from done until
    // the next copy would overfill it. One copy each is the floor; a campaign
    // whose single copies already exceed the hub reports the shortfall instead
    // of dropping factories.
    const buildable = prepared.filter((p): p is PreparedNeed => p !== null);
    const copyCounts = allocateCopies(
        buildable.map((p) => ({ amount: p.amount, rate: p.rate, miners: p.miners })),
        minerCapacityByItem(patches)
    );
    buildable.forEach((p, k) => (p.copies = copyCounts[k]!));

    /** record one accepted factory in the sheet's running totals */
    const collect = (prep: PreparedNeed, layout: Layout): void => {
        for (const gap of layout.routingGaps) {
            gapList.push({ ...gap, plan: prep.index, connection: allConnections.length + (gap.connection ?? -1) });
        }
        for (const b of layout.buildings) b.plan = prep.index;
        allBuildings.push(...layout.buildings);
        allConnections.push(...layout.connections);
        allSources.push(...layout.sources);
        for (const m of layout.missing) missing.add(m);
        for (const b of layout.bom) bom.set(b.zh, (bom.get(b.zh) || 0) + b.n);
        for (const color of layout.colors) if (!colors.has(color.color)) colors.set(color.color, color);
        beltEstimate += layout.beltEstimate;
        totalBuildings += layout.buildings.length;
        const cans = layout.buildings.filter((b) => b.kind === "trash").length;
        trashCans += cans;
        // one unused cutter slot vents at the factory's own rate
        wasteRate += cans * layout.rate;
    };

    /**
     * Build one copy into the shared world. The floor is kept even when a link
     * fails (the wrapper then falls back to the classic sheet); an extra copy is
     * optional and is rolled back unless it is completely clean.
     */
    const buildCopy = (prep: PreparedNeed, c: number): Layout | null => {
        // the first copy keeps the bare prefix: a one-copy sheet has the same
        // ids it always had
        const idPrefix = c === 0 ? `p${prep.index}:` : `p${prep.index}:c${c + 1}:`;
        const saved = c > 0 ? snapshotWorld(world) : null;
        const layout = buildLayout({
            plan: prep.res.plan,
            patches,
            hub,
            world,
            idPrefix,
            allowTunnels,
            allowColourNet,
            allowMerge,
            legacyHub: classic,
            tuning,
        });
        if (saved && (layout.missing.length || layout.routingGaps.length)) {
            restoreWorld(world, saved);
            return null;
        }
        collect(prep, layout);
        return layout;
    };

    // one copy of every shape first, then the duplicates: a vein goes to the
    // factory the campaign cannot do without before a second copy of another
    const built: Layout[][] = shapes.map(() => []);
    for (const prep of buildable) {
        const first = buildCopy(prep, 0);
        if (first) built[prep.index - 1]!.push(first);
    }
    for (const prep of buildable) {
        const first = built[prep.index - 1]![0];
        if (!first || first.missing.length || first.routingGaps.length) continue;
        for (let c = 1; c < prep.copies; c++) {
            const next = buildCopy(prep, c);
            if (!next) break;
            built[prep.index - 1]!.push(next);
        }
    }

    for (let i = 0; i < shapes.length; i++) {
        const prep = prepared[i];
        if (!prep) {
            entries.push(rows[i]!);
            continue;
        }
        const layouts = built[i]!;
        prep.copies = layouts.length;
        // miners sit far away on their deposit, so a factory frame only makes
        // sense around the processing block
        const processors = layouts.flatMap((l) => l.buildings.filter((b) => b.kind !== "base"));
        const bounds = processors.length ? boundsOf(processors) : null;
        const missingOf = [...new Set(layouts.flatMap((l) => l.missing))];
        const totalRate = layouts.reduce((sum, l) => sum + l.rate, 0);
        const buildings = layouts.reduce((n, l) => n + l.buildings.length, 0);
        const belts = layouts.reduce((n, l) => n + l.beltEstimate, 0);
        entries.push({
            index: prep.index,
            code: prep.need.code,
            ok: true,
            status: "ok",
            cost: prep.res.cost,
            buildings,
            belts,
            bounds,
            missing: missingOf,
            sources: prep.need.sources,
            rate: layouts[0]!.rate,
            copies: prep.copies,
            totalRate,
            limit: bottleneck(prep.flat.steps),
            colorPorts: prep.colorPorts,
            availableAt: prep.availableAt,
            amount: prep.amount,
            eta: prep.amount > 0 && totalRate > 0 ? prep.amount / totalRate : 0,
        });
        if (missingOf.length) unbuildable += 1;
        for (let c = 0; c < layouts.length; c++) {
            const layout = layouts[c]!;
            const own = layout.buildings.filter((b) => b.kind !== "base");
            plans.push({
                index: prep.index,
                code: prep.need.code,
                bounds: own.length ? boundsOf(own) : null,
                buildings: layout.buildings.length,
                rate: layout.rate,
                copy: c + 1,
            });
        }
    }

    // ---- campaign-level repair: gaps the per-factory pass could not see -----
    //
    // A belt laid for one factory can seal a port another factory still needs;
    // the per-factory rip-up only blames its own belts, so those cross-factory
    // deadlocks survive. The repair pass replays the failing links on the
    // finished map, rips the belts blocking their endpoints, reroutes those
    // belts' owners and repeats. It is a no-op when every link routed.
    const repair = repairRoutingGaps({
        world,
        connections: allConnections,
        buildings: allBuildings,
        sources: allSources,
        allowTunnels,
        hubRepair: true,
        legacyHub: classic,
    });
    if (repair.fixed > 0) {
        // belts moved: a gap the pass closed is no longer a gap, and every
        // factory's belt count follows the belts that ended up on the map
        for (let i = gapList.length - 1; i >= 0; i--) {
            const conn = gapList[i]!.connection;
            if (conn !== undefined && conn >= 0 && allConnections[conn]!.routed) gapList.splice(i, 1);
        }
        const planOfStep = new Map(allBuildings.map((b): [string, number | undefined] => [b.stepId, b.plan]));
        const beltsByPlan = new Map<number, number>();
        for (const conn of allConnections) {
            if (!conn.routed) continue;
            const plan = planOfStep.get(conn.from);
            if (plan === undefined) continue;
            beltsByPlan.set(plan, (beltsByPlan.get(plan) ?? 0) + conn.beltTiles);
        }
        for (const e of entries) e.belts = beltsByPlan.get(e.index) ?? 0;
    }
    // every connection carries its own belt count, moved or not: the sheet
    // adds them up once instead of re-deriving the run it already stored
    beltEstimate = repair.beltTiles;

    // ---- throughput: what each factory can deliver, and what is missing -----

    // every colour port of every painter pulls at its factory's chain rate, and
    // every copy repeats that pull
    const colorDemand = new Map<ColorChar, number>();
    for (const e of entries) {
        if (!e.ok) continue;
        for (const color of e.colorPorts) colorDemand.set(color, (colorDemand.get(color) || 0) + e.rate * e.copies);
    }
    const supply = sizeColorSupply(colorDemand);
    // what the layout actually built: one chain per colour port, and every
    // machine on a chain carries the colour it puts out
    const builtSources = new Map<ColorChar, number>();
    for (const b of allBuildings) {
        if (b.color === undefined) continue;
        builtSources.set(b.color, (builtSources.get(b.color) || 0) + 1);
    }
    const builtSourceCount = [...builtSources.values()].reduce((a, b) => a + b, 0);
    const demandSizedCount = [...supply.sources.values()].reduce((a, b) => a + b, 0);

    let factories = 0;
    let deliveredRate = 0;
    let criticalEta = 0;
    for (const e of entries) {
        if (!e.ok) continue;
        factories += e.copies;
        deliveredRate += e.totalRate;
        if (e.eta > criticalEta) criticalEta = e.eta;
    }

    // colour sources the layout has to add: it currently builds exactly one
    // chain per colour, so anything above one source is a shortfall
    const colorGap: CampaignColorGap[] = colourGap(supply, builtSources);
    const extraSources = colorGap.reduce((sum, g) => sum + (g.need - g.have), 0);
    const demandTotal = [...colorDemand.values()].reduce((a, b) => a + b, 0);
    const supplyAvailable = builtSourceCount * SOURCE_RATE;

    // deposits are lossy: every miner needs a free neighbouring tile to eject
    // into, and one belt takes one tile, so a blocky deposit tops out well below
    // its cell count
    const minerCapacity = new Map<ColorChar, number>();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const color = p.item.color;
        minerCapacity.set(color, (minerCapacity.get(color) || 0) + patchMinerCapacity(p));
    }
    const capacityGap: CampaignCapacityGap[] = [];
    for (const [color, needCount] of supply.sources) {
        if (isMixedColor(color)) continue; // mixers are not ground-limited
        const capacity = minerCapacity.get(color) || 0;
        if (needCount > capacity) capacityGap.push({ color, need: needCount, capacity });
    }

    // one belt per port: every extra belt leaving the same output slot needs a
    // splitter/balancer node in front of it
    const ports = new Map<string, number>();
    for (const c of allConnections) {
        if (c.toHub) continue;
        const key = `${c.from}|${c.outSlot}`;
        ports.set(key, (ports.get(key) || 0) + 1);
    }
    let splitters = 0;
    let worstFanout = 0;
    for (const n of ports.values()) {
        if (n > 1) splitters += n - 1;
        worstFanout = Math.max(worstFanout, n);
    }
    const hubInbound = allConnections.filter((c) => c.toHub).length;
    // a leg that could not reach an entry merged into a belt already bound for
    // one; counting the legs that had to be true is honest even when the sheet
    // needs fewer than `HUB_ENTRIES` entries
    const hubMerges = allConnections.filter((c) => c.toHub && c.merged).length;
    const balancerAt = unlock.get("balancer") || null;

    const result: CampaignResult = {
        ok: failed === 0 && deferred === 0 && impossible === 0 && gapList.length === 0,
        entries,
        totals: {
            requested: shapes.length,
            shapes: entries.filter((e) => e.status === "ok").length,
            failed,
            deferred,
            impossible,
            unbuildable,
            routingGaps: gapList.length,
            buildings: totalBuildings,
            belts: beltEstimate,
            untilLevel,
            throughput: {
                beltRate: BELT_RATE,
                minerRate: MINER_RATE,
                sourceRate: SOURCE_RATE,
                colorDemand: [...colorDemand.entries()].map(([color, rate]) => ({ color, rate })),
                demandTotal,
                supplyAvailable,
                builtSourceCount,
                demandSizedCount,
                colorGap,
                extraSources,
                capacityGap,
                splitters,
                worstFanout,
                hubInbound,
                hubMerges,
                factories,
                deliveredRate,
                hubCapacity: HUB_ENTRIES * BELT_RATE,
                criticalEta,
                trashCans,
                wasteRate,
                balancerAt,
                tunnelAt,
            },
        },
        sheet: {
            hub,
            buildings: allBuildings,
            connections: allConnections,
            sources: allSources,
            colors: [...colors.values()],
            missing: [...missing],
            routingGaps: gapList,
            beltEstimate,
            bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
            plans,
        },
    };
    // the sheet carries no world: hand the wasm-side pages back
    disposeRouterWorld(world);
    return result;
}

/* ------------------------------------------------------------------ *
 * the sheet's own repair pass
 * ------------------------------------------------------------------ */

interface RepairRoutingArgs {
    world: World;
    connections: Connection[];
    buildings: readonly Placement[];
    sources?: readonly LayoutSource[];
    allowTunnels?: boolean;
    /** replay unrouted delivery legs onto the hub (off in classic mode) */
    hubRepair?: boolean;
    /** classic mode: an entry takes 5 legs, not 2 items/s */
    legacyHub?: boolean;
    /** whole-map rip-up passes before giving up */
    rounds?: number;
    /** rip-up rounds inside one failing link */
    cascades?: number;
    /** belts ripped per round, and how far from an endpoint they must be */
    maxRip?: number;
    near?: number;
}

interface RepairRoutingReport {
    /** connections that were gaps when the pass started and are routed now */
    fixed: number;
    /** connections still unrouted after the pass */
    remaining: number;
    /** belt cells over every routed connection, after the pass settled */
    beltTiles: number;
}

/** the whole belt layer plus the connection table, for a round that regresses */
interface RepairSnapshot {
    belts: Map<number, BeltHeading>;
    tunnelCells: Set<number>;
    tunnelEnds: Map<number, number>;
    tunnelUnder: Map<number, number>;
    hubBound: Map<number, number>;
    hubEntryLoad: Map<number, number>;
    hubApproaches: Set<number>;
    walls: Set<number>;
    approaches: Set<number>;
    blocked: Set<number>;
    connections: {
        routed: boolean;
        path: Tile[] | null;
        tunnels: number;
        tunnelCells: Tile[];
        tunnelSpans: TunnelSpan[];
        beltTiles: number;
        merged: boolean;
        entryKey?: number | null;
    }[];
    /** a turned/moved miner lives on the placement itself, not in the world */
    placements: { x: number; y: number; rot: Rot; patch?: Patch; distance?: number }[];
    sources: { x?: number; y?: number; patch: Patch | null; distance?: number }[];
}

/** endpoints of one connection, rebuilt from the placements */
interface RepairEnds {
    start: Tile;
    startApproach: Tile;
    goal: Tile;
    goalApproach: Tile;
    startDir: readonly [number, number] | null;
    goalDir: readonly [number, number] | null;
}

function connectionEnds(conn: Connection, byStep: ReadonlyMap<string, Placement>): RepairEnds | null {
    if (conn.toHub || conn.direct) return null;
    const src = byStep.get(conn.from);
    const dst = byStep.get(conn.to);
    if (!src || !dst) return null;
    const sInfo = BUILDING_INFO[src.kind];
    const dInfo = BUILDING_INFO[dst.kind];
    if (!sInfo || !dInfo) return null;
    const sCells = portCells(sInfo, src.x, src.y, src.rot);
    const sApps = portApproachCells(sInfo, src.x, src.y, src.rot);
    const dCells = portCells(dInfo, dst.x, dst.y, dst.rot);
    const dApps = portApproachCells(dInfo, dst.x, dst.y, dst.rot);
    const out = (sInfo.ins || []).length + conn.outSlot;
    const start = sCells[out];
    const startApproach = sApps[out];
    const slot = conn.slot ?? 0;
    const goal = dCells[slot];
    const goalApproach = dApps[slot];
    if (!start || !startApproach || !goal || !goalApproach) return null;
    return {
        start,
        startApproach,
        goal,
        goalApproach,
        startDir: [Math.sign(startApproach.x - start.x), Math.sign(startApproach.y - start.y)],
        goalDir: [Math.sign(goal.x - goalApproach.x), Math.sign(goal.y - goalApproach.y)],
    };
}

/** the run behind a connection, rebuilt well enough for `releaseRoute` */
function connectionRun(conn: Connection): RouteResult | null {
    if (!conn.path || conn.path.length === 0) return null;
    const under = new Set<number>();
    for (const span of conn.tunnelSpans) for (const c of span.cells) under.add(cellKey(c.x, c.y));
    return {
        cells: conn.path,
        crossings: conn.tunnelCells,
        spans: conn.tunnelSpans,
        phases: conn.path.map((c) => (under.has(cellKey(c.x, c.y)) ? 1 : 0)),
        headings: conn.path.map(() => 0),
        joinsGoal: conn.merged,
        entryKey: conn.entryKey ?? null,
        rate: conn.rate,
    };
}

function applyRun(conn: Connection, run: RouteResult): void {
    const underground = run.spans.reduce((n, span) => n + span.cells.length, 0);
    conn.routed = true;
    conn.path = run.cells;
    conn.tunnels = run.spans.length;
    conn.tunnelCells = run.crossings;
    conn.tunnelSpans = run.spans;
    conn.beltTiles = run.cells.length - underground;
    conn.entryKey = run.entryKey;
}

/**
 * Campaign-level rip-up and reroute.
 *
 * Each factory is routed greedily while it is built, so a belt laid for an
 * earlier factory can seal a port that only a later link needs. That deadlock
 * spans two `buildLayout` calls, and the per-factory pass cannot see it — its
 * blame only knows the belts of its own factory. This pass runs once on the
 * finished map, replays the failing links, rips the belts that block their
 * endpoints (the nearest few from `routeBelt`'s frontier), reroutes those belts'
 * owners and repeats until it stops making progress. Visiting order, victim
 * order and every cap are fixed, so the result is reproducible.
 *
 * A miner is the one endpoint the pass may still turn or move: it is 1×1, it
 * carries a single link, and the game lets it face any side. A processor carries
 * several links and is never touched here.
 *
 * Whoever moves a run writes the run's derived fields: `commit` goes through
 * `applyRun`, so `path`, `tunnelSpans`, `tunnelCells` and `beltTiles` always
 * describe what is on the map, and the sheet never re-derives them.
 */
function repairRoutingGaps({
    world,
    connections,
    buildings,
    sources = [],
    allowTunnels = true,
    hubRepair = true,
    legacyHub = false,
    rounds = 6,
    cascades = 6,
    maxRip = 3,
    near = 6,
}: RepairRoutingArgs): RepairRoutingReport {
    const byStep = new Map(buildings.map((b): [string, Placement] => [b.stepId, b]));
    // each session owns `world.blocked`: rebuild it from the walls this map
    // accumulated, so the router's resident copy sees one blocked layer
    const blocked = world.blocked;
    blocked.clear();
    for (const key of world.walls) blocked.add(key);
    for (const key of world.approaches) blocked.add(key);
    const allowCross = allowTunnels !== false;
    /** the repair's second phase may cross a turn belt; the build never does */
    let relaxCross = false;
    const tileOf = (key: number): Tile => ({ x: Math.floor(key / 8192) - 4096, y: (key % 8192) - 4096 });
    const unrouted = (): number[] => {
        const out: number[] = [];
        for (let i = 0; i < connections.length; i++) if (!connections[i]!.routed) out.push(i);
        return out;
    };
    const beltTotal = (): number => {
        let n = 0;
        for (const conn of connections) if (conn.routed) n += conn.beltTiles;
        return n;
    };

    /**
     * The two boxes a repair search may use. The wide one exists to let a
     * *long* delivery detour around other factories, so it scales with the
     * span instead of being a fixed 240: a 480-tile box around a five-tile
     * hop costs millions of states and, measured on the full campaign, never
     * changed the answer — a 60-tile detour is already a dozen times the
     * link's own length.
     */
    const nearMargin = 60;
    const wideMarginFor = (start: Tile, goal: Tile): number => {
        const span = Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y);
        return Math.max(nearMargin, Math.min(240, 2 * span + 40));
    };

    function search(
        start: Tile,
        goal: Tile,
        exempt: ReadonlySet<number>,
        startDir: RepairEnds["startDir"],
        goalDir: RepairEnds["goalDir"],
        frontier?: Set<number>,
        join = false
    ): RouteResult | null {
        const wide = wideMarginFor(start, goal);
        for (const margin of wide > nearMargin ? [nearMargin, wide] : [nearMargin]) {
            const { run, boxLimited } = routeBeltDetailed(world, start, goal, {
                allowCross,
                relaxCross,
                dryRun: true,
                exempt,
                startDir,
                goalDir,
                frontier,
                margin,
                goalMayJoin: join,
            });
            if (run) return run;
            // the search exhausted every tile it could reach without touching
            // the box edge, so the wide pass would re-walk the same dead
            // component — a gap that no box size repairs while the map stands
            if (!boxLimited) return null;
        }
        return null;
    }

    function endsSearch(ends: RepairEnds, frontier?: Set<number>): RouteResult | null {
        const exempt = new Set<number>([
            cellKey(ends.start.x, ends.start.y),
            cellKey(ends.goal.x, ends.goal.y),
            cellKey(ends.startApproach.x, ends.startApproach.y),
            cellKey(ends.goalApproach.x, ends.goalApproach.y),
        ]);
        return search(ends.start, ends.goal, exempt, ends.startDir, ends.goalDir, frontier);
    }

    function find(index: number, frontier?: Set<number>): RouteResult | null {
        const conn = connections[index]!;
        if (conn.routed) return null;
        const ends = connectionEnds(conn, byStep);
        if (!ends) return null;
        return endsSearch(ends, frontier);
    }

    /** the start port of a delivery leg, or null when its factory is gone */
    function hubStart(conn: Connection): { start: Tile; startDir: readonly [number, number] } | null {
        const src = byStep.get(conn.from);
        if (!src) return null;
        const info = BUILDING_INFO[src.kind];
        const cells = portCells(info, src.x, src.y, src.rot);
        const apps = portApproachCells(info, src.x, src.y, src.rot);
        const slot = info.ins.length + conn.outSlot;
        const start = cells[slot];
        const approach = apps[slot];
        if (!start || !approach) return null;
        return { start, startDir: [Math.sign(approach.x - start.x), Math.sign(approach.y - start.y)] };
    }

    /**
     * A delivery leg the build could not route. The generic repair cannot see
     * these — their goal is a hub tile or a belt already bound for one, not a
     * machine port — so they are replayed here: first onto a free entry face
     * (pointing into the hub), then into any entry belt with rate headroom
     * (two belts may point into one tile).
     */
    function findHub(index: number, frontier?: Set<number>): RouteResult | null {
        const conn = connections[index]!;
        if (!conn.toHub || conn.routed) return null;
        const from = hubStart(conn);
        if (!from) return null;
        const rate = conn.rate ?? 1;
        const exemptFor = (goal: Tile): Set<number> =>
            new Set([cellKey(from.start.x, from.start.y), cellKey(goal.x, goal.y)]);
        const faces = hubApproaches(world.hub)
            .map((tile) => ({ tile, d: Math.abs(tile.x - from.start.x) + Math.abs(tile.y - from.start.y) }))
            .sort((a, b) => a.d - b.d || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
        for (const { tile } of faces) {
            const key = cellKey(tile.x, tile.y);
            if (world.hubApproaches.has(key) || world.belts.has(key)) continue;
            const border = hubBorderOf(world.hub, tile);
            const run = search(
                from.start,
                tile,
                exemptFor(tile),
                from.startDir,
                [Math.sign(border.x - tile.x), Math.sign(border.y - tile.y)],
                frontier
            );
            if (!run) continue;
            run.entryKey = key;
            run.rate = rate;
            return run;
        }
        for (const [key, entry] of world.hubBound) {
            const load = world.hubEntryLoad.get(entry) ?? 0;
            if (legacyHub ? load >= 5 : load + rate > BELT_RATE + 1e-9) continue;
            if (world.hubApproaches.has(key)) continue;
            const tile = tileOf(key);
            const run = search(from.start, tile, exemptFor(tile), from.startDir, null, frontier, true);
            if (!run) continue;
            run.entryKey = entry;
            run.rate = rate;
            return run;
        }
        return null;
    }

    function commit(index: number, run: RouteResult): void {
        const conn = connections[index]!;
        const old = connectionRun(conn);
        if (old) releaseRoute(world, old);
        claimRoute(world, run);
        applyRun(conn, run);
        if (conn.toHub) {
            // a fresh entry was claimed, or the leg merged into an entry belt
            conn.merged = run.joinsGoal;
            if (!run.joinsGoal && run.entryKey !== null) world.hubApproaches.add(run.entryKey);
            const tail = run.cells.at(-1);
            if (tail) {
                conn.x2 = tail.x + 0.5;
                conn.y2 = tail.y + 0.5;
            }
        }
    }

    /** the run each ripped connection had, so a free old path can come back */
    const rippedRuns = new Map<number, RouteResult>();

    function rip(index: number): void {
        const conn = connections[index]!;
        const old = connectionRun(conn);
        if (!old) return;
        rippedRuns.set(index, old);
        releaseRoute(world, old);
        conn.routed = false;
        conn.path = null;
        conn.beltTiles = 0;
    }

    function owners(): Map<number, number> {
        const out = new Map<number, number>();
        for (let i = 0; i < connections.length; i++) {
            const conn = connections[i]!;
            if (!conn.routed || !conn.path || conn.toHub) continue;
            for (const c of conn.path) out.set(cellKey(c.x, c.y), i);
        }
        return out;
    }

    /**
     * Turn the miner feeding `index` to another side (or move it to another tile
     * of its deposit) and try the link from there. Only the old port / approach
     * reservations are released; the body stays put unless the turn fails.
     */
    function retryMiner(index: number): boolean {
        const conn = connections[index]!;
        const ends = connectionEnds(conn, byStep);
        const src = byStep.get(conn.from);
        if (!ends || !src || src.kind !== "base") return false;
        const info = BUILDING_INFO.base;
        const oldRot = src.rot;
        const oldX = src.x;
        const oldY = src.y;
        const oldBody = cellKey(oldX, oldY);
        const release = (cells: readonly Tile[], approach: boolean): void => {
            for (const c of cells) {
                const key = cellKey(c.x, c.y);
                world.walls.delete(key);
                if (approach) world.approaches.delete(key);
                world.occupied.delete(key);
                blocked.delete(key);
            }
        };
        const claim = (cells: readonly Tile[], approach: boolean): void => {
            for (const c of cells) {
                const key = cellKey(c.x, c.y);
                if (approach) world.approaches.add(key);
                else world.walls.add(key);
                world.occupied.add(key);
                blocked.add(key);
            }
        };
        const oldPorts = portCells(info, oldX, oldY, oldRot);
        const oldApps = portApproachCells(info, oldX, oldY, oldRot);
        /** stand the miner at (x, y) turned `rot` and try its link from there */
        const tryAt = (x: number, y: number, rot: Rot): boolean => {
            const ports = portCells(info, x, y, rot);
            const apps = portApproachCells(info, x, y, rot);
            const start = ports[0];
            const approach = apps[0];
            if (!start || !approach) return false;
            const free = [start, approach].every((c) => {
                const key = cellKey(c.x, c.y);
                return !world.walls.has(key) && !world.belts.has(key) && !world.tunnelEnds.has(key) && !world.approaches.has(key);
            });
            if (!free) return false;
            claim(ports, false);
            claim(apps, true);
            const prev = { x: src.x, y: src.y, rot: src.rot };
            src.x = x;
            src.y = y;
            src.rot = rot;
            const dir: readonly [number, number] = [Math.sign(approach.x - start.x), Math.sign(approach.y - start.y)];
            const exempt = new Set<number>([cellKey(start.x, start.y), cellKey(ends.goal.x, ends.goal.y), cellKey(approach.x, approach.y), cellKey(ends.goalApproach.x, ends.goalApproach.y)]);
            const run = search(start, ends.goal, exempt, dir, ends.goalDir);
            if (!run) {
                src.x = prev.x;
                src.y = prev.y;
                src.rot = prev.rot;
                release(ports, false);
                release(apps, true);
                return false;
            }
            commit(index, run);
            // the drawing starts the belt at the port centre
            const [ox, oy] = portCentre(info, info.outs![0]!, rot);
            conn.x1 = x + ox;
            conn.y1 = y + oy;
            for (const source of sources) {
                if (source.step?.id === src.step && source.x === oldX && source.y === oldY) {
                    source.x = x;
                    source.y = y;
                }
            }
            return true;
        };
        release(oldPorts, false);
        release(oldApps, true);
        for (let rot = 0; rot < 4; rot++) if (tryAt(oldX, oldY, rot as Rot)) return true;
        // every side is boxed in: move the body to another tile of the deposit.
        // A miner is 1×1 and only its own link leaves it, so nothing else breaks.
        const tryMove = (cell: Tile): boolean => {
            const nextBody = cellKey(cell.x, cell.y);
            if (world.occupied.has(nextBody)) return false;
            world.occupied.delete(oldBody);
            world.walls.delete(oldBody);
            world.occupied.add(nextBody);
            world.walls.add(nextBody);
            for (let rot = 0; rot < 4; rot++) if (tryAt(cell.x, cell.y, rot as Rot)) return true;
            world.occupied.delete(nextBody);
            world.walls.delete(nextBody);
            world.occupied.add(oldBody);
            world.walls.add(oldBody);
            return false;
        };
        const patch = src.patch;
        if (patch) {
            for (const cell of patchCellsByCentre(patch)) {
                if (cell.x === oldX && cell.y === oldY) continue;
                if (tryMove(cell)) return true;
            }
            // that vein may be too crowded: any patch of the same item is valid
            const item = patch.item;
            for (const other of world.patches) {
                if (other === patch) continue;
                const same =
                    item.kind === "shape"
                        ? other.item.kind === "shape" && other.item.code === item.code
                        : other.item.kind === "color" && other.item.color === item.color;
                if (!same) continue;
                for (const cell of patchCellsByCentre(other)) {
                    if (!tryMove(cell)) continue;
                    src.patch = other;
                    src.distance = Math.hypot(other.x - (world.hub.x + 2), other.y - (world.hub.y + 2));
                    for (const source of sources) {
                        if (source.step?.id !== src.step || source.x !== cell.x || source.y !== cell.y) continue;
                        source.patch = other;
                        source.distance = src.distance;
                    }
                    return true;
                }
            }
        }
        src.x = oldX;
        src.y = oldY;
        src.rot = oldRot;
        claim(oldPorts, false);
        claim(oldApps, true);
        return false;
    }

    const initial = unrouted();
    if (initial.length === 0) return { fixed: 0, remaining: 0, beltTiles: beltTotal() };
    const before = initial.length;
    const snapshot = (): RepairSnapshot => ({
        belts: new Map(world.belts),
        tunnelCells: new Set(world.tunnelCells),
        tunnelEnds: new Map(world.tunnelEnds),
        tunnelUnder: new Map(world.tunnelUnder),
        hubBound: new Map(world.hubBound),
        hubEntryLoad: new Map(world.hubEntryLoad),
        hubApproaches: new Set(world.hubApproaches),
        walls: new Set(world.walls),
        approaches: new Set(world.approaches),
        blocked: new Set(blocked),
        connections: connections.map((c) => ({
            routed: c.routed,
            path: c.path,
            tunnels: c.tunnels,
            tunnelCells: c.tunnelCells,
            tunnelSpans: c.tunnelSpans,
            beltTiles: c.beltTiles,
            merged: c.merged,
            entryKey: c.entryKey,
        })),
        placements: buildings.map((b) => ({ x: b.x, y: b.y, rot: b.rot, patch: b.patch, distance: b.distance })),
        sources: sources.map((s) => ({ x: s.x, y: s.y, patch: s.patch, distance: s.distance })),
    });
    const restore = (saved: RepairSnapshot): void => {
        const refill = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
            target.clear();
            for (const [key, value] of source) target.set(key, value);
        };
        const reset = <V>(target: Set<V>, source: Set<V>): void => {
            target.clear();
            for (const value of source) target.add(value);
        };
        refill(world.belts, saved.belts);
        reset(world.tunnelCells, saved.tunnelCells);
        refill(world.tunnelEnds, saved.tunnelEnds);
        refill(world.tunnelUnder, saved.tunnelUnder);
        refill(world.hubBound, saved.hubBound);
        refill(world.hubEntryLoad, saved.hubEntryLoad);
        reset(world.hubApproaches, saved.hubApproaches);
        reset(world.walls, saved.walls);
        reset(world.approaches, saved.approaches);
        reset(blocked, saved.blocked);
        connections.forEach((conn, i) => {
            const save = saved.connections[i]!;
            conn.routed = save.routed;
            conn.path = save.path;
            conn.tunnels = save.tunnels;
            conn.tunnelCells = save.tunnelCells;
            conn.tunnelSpans = save.tunnelSpans;
            conn.beltTiles = save.beltTiles;
            conn.merged = save.merged;
            conn.entryKey = save.entryKey;
        });
        buildings.forEach((b, i) => {
            const save = saved.placements[i]!;
            b.x = save.x;
            b.y = save.y;
            b.rot = save.rot;
            b.patch = save.patch;
            b.distance = save.distance;
        });
        sources.forEach((s, i) => {
            const save = saved.sources[i]!;
            s.x = save.x;
            s.y = save.y;
            s.patch = save.patch;
            s.distance = save.distance;
        });
    };
    let best = snapshot();
    let bestCount = initial.length;
    // strict first: it stays with how the build lays belts. The relaxed turn
    // crossing only runs for whatever the strict pass could not reach.
    for (const relaxed of [false, true]) {
        relaxCross = relaxed;
        for (let round = 0; round < rounds; round++) {
            const todo = unrouted();
            let touched = 0;
            const ripped = new Set<number>();
            for (const index of todo) {
                // one search answers both "is it routable" and "who blocks it":
                // the frontier is filled on failure, so a second identical
                // search per round would only burn the same states again
                const frontier = new Set<number>();
                const direct =
                    hubRepair && connections[index]!.toHub ? findHub(index, frontier) : find(index, frontier);
                if (direct) {
                    commit(index, direct);
                    touched += 1;
                    continue;
                }
                const conn = connections[index]!;
                const ends = connectionEnds(conn, byStep);
                // a hub leg has no machine goal, but its blockers can still be
                // ripped: score them against the hub itself
                const hubFrom = hubRepair && !ends && conn.toHub ? hubStart(conn) : null;
                if (!ends && !hubFrom) {
                    if (retryMiner(index)) touched += 1;
                    continue;
                }
                const nearStart = ends?.start ?? hubFrom!.start;
                const nearGoal = ends?.goal ?? { x: world.hub.x + HUB_SIZE / 2, y: world.hub.y + HUB_SIZE / 2 };
                let done = false;
                for (let cascade = 0; cascade < cascades && !done; cascade++) {
                    // `frontier` comes from the failure above (or from the
                    // search at the end of the previous cascade)
                    const own = owners();
                    const scores = new Map<number, { hits: number; d: number }>();
                    for (const key of frontier) {
                        const owner = own.get(key);
                        if (owner === undefined || owner === index) continue;
                        const tile = tileOf(key);
                        const d = Math.min(
                            Math.abs(tile.x - nearStart.x) + Math.abs(tile.y - nearStart.y),
                            Math.abs(tile.x - nearGoal.x) + Math.abs(tile.y - nearGoal.y)
                        );
                        const cur = scores.get(owner);
                        if (!cur) scores.set(owner, { hits: 1, d });
                        else {
                            cur.hits += 1;
                            cur.d = Math.min(cur.d, d);
                        }
                    }
                    const victims = [...scores.entries()]
                        .filter(([, v]) => v.d <= near)
                        .sort((a, b) => a[1].d - b[1].d || b[1].hits - a[1].hits || a[0] - b[0])
                        .slice(0, maxRip);
                    if (!victims.length) break;
                    for (const [victim] of victims) {
                        rip(victim);
                        ripped.add(victim);
                        touched += 1;
                    }
                    frontier.clear();
                    const run = ends ? find(index, frontier) : findHub(index, frontier);
                    if (run) {
                        commit(index, run);
                        touched += 1;
                        done = true;
                    }
                }
                if (!done && retryMiner(index)) touched += 1;
            }
            // every ripped belt has to come back: search first, then its old path
            for (const victim of ripped) {
                const conn = connections[victim]!;
                if (conn.routed) continue;
                const back = find(victim);
                if (back) {
                    commit(victim, back);
                    continue;
                }
                const old = rippedRuns.get(victim);
                if (old && runFits(world, old)) {
                    claimRoute(world, old);
                    applyRun(conn, old);
                }
            }
            const remaining = unrouted().length;
            if (remaining < bestCount) {
                best = snapshot();
                bestCount = remaining;
            }
            if (remaining === 0 || touched === 0) break;
        }
        if (bestCount === 0) break;
        if (unrouted().length > bestCount) restore(best);
    }
    // land on the best state: a later round may have traded links for the same
    // count, and the caller's gap list / belt counts must match the drawn belts
    restore(best);
    const fixed = before - bestCount;
    if (fixed > 0) {
        // a ripped belt can take away the over-belt another run was crossing
        // under, so every recorded crossing is refreshed from the final world
        for (const conn of connections) {
            if (!conn.routed || !conn.tunnelSpans.length) continue;
            conn.tunnelCells = conn.tunnelSpans.flatMap((span) => span.cells).filter((cell) => world.belts.has(cellKey(cell.x, cell.y)));
        }
    }
    return { fixed, remaining: bestCount, beltTiles: beltTotal() };
}
