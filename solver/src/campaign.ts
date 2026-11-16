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
import { buildLayout, cellKey, createWorld, repairRoutingGaps, sizeColorSupply } from "./layout.js";
import type { BlockRect, Connection, Layout, LayoutColor, LayoutSource, Placement, PlanFrame, RoutingGap, Tile } from "./layout.js";
import { chainRate, bottleneck, HUB_ENTRIES, SOURCE_RATE, MINER_RATE, BELT_RATE } from "./rates.js";
import type { Bottleneck } from "./rates.js";
import { availableLevels, buildingsForLevel, FULL_LEVELS } from "./levels.js";
import type { Level } from "./levels.js";
import { patchMinerCapacity } from "./map.js";
import type { Patch } from "./map.js";
import { colorChains, isMixedColor } from "./color.js";
import type { ColorChain } from "./color.js";
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
    rate: number;
    limit: Bottleneck | null;
    /** colours the painters of this factory pull, one item per output item */
    colorPorts: ColorChar[];
    availableAt: number;
    /** items the game asks for, summed over every source that needs this shape */
    amount: number;
    /** 1 = every colour port owns a chain that keeps up; below that a source caps it */
    supplyFactor: number;
    effectiveRate: number;
    etaNominal: number;
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
    limitedShapes: number;
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
    throughput: CampaignThroughput;
}

/** the campaign sheet: one shared world, one hub, one frame per factory */
export type CampaignLayout = Omit<Layout, "steps" | "depth" | "plans"> & { plans: PlanFrame[] };

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
}

export interface CampaignResult {
    /** every requested shape was planned, buildable and routed */
    ok: boolean;
    entries: CampaignEntry[];
    layout: CampaignLayout;
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

/** plan every requested shape on one map; `ok` = all planned, buildable and routed */
export function planCampaign({
    shapes,
    patches,
    hub,
    maxAttempts = 30000,
    buildings = null,
    untilLevel = null,
    levels = FULL_LEVELS,
}: CampaignOptions): CampaignResult {
    const world = createWorld({ hub, patches });
    const unlock = availableLevels(levels);
    const tunnelAt = unlock.get("tunnel") || null;
    // before L6 belts cannot cross at all, so routing must go around
    const allowTunnels = untilLevel == null || (tunnelAt !== null && untilLevel >= tunnelAt);
    // a shared colour net needs the splitter, which the game hands out at L20
    const splitterAt = unlock.get("splitter") || null;
    const allowColourNet = splitterAt !== null && (untilLevel == null || untilLevel >= splitterAt);
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
    let failed = 0;
    let deferred = 0;
    let impossible = 0;
    let unbuildable = 0;
    const gapList: RoutingGap[] = [];

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
                    entries.push({
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
                    });
                    return;
                }
                if (untilLevel != null && freeAt > untilLevel) {
                    deferred += 1;
                    entries.push({
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
                    });
                    return;
                }
                res = free;
            }
        }
        if (!res.ok) {
            failed += 1;
            entries.push({
                index,
                code: need.code,
                ok: false,
                status: "failed",
                error: res.error,
                sources: need.sources,
                buildings: 0,
                belts: 0,
                bounds: null,
            });
            return;
        }
        const chains = colorChains(res.flat.steps);
        const availableAt = levelOfPlan(res.flat, need.sources, chains, unlock);
        if (availableAt === Infinity) {
            impossible += 1;
            entries.push({
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
            });
            return;
        }
        if (untilLevel != null && availableAt > untilLevel) {
            deferred += 1;
            entries.push({
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
            });
            return;
        }
        const layout = buildLayout({
            plan: res.plan,
            patches,
            hub,
            world,
            idPrefix: `p${index}:`,
            tag: need.code,
            allowTunnels,
            allowColourNet,
        });
        for (const gap of layout.routingGaps) {
            gapList.push({ ...gap, plan: index, connection: allConnections.length + (gap.connection ?? -1) });
        }
        for (const b of layout.buildings) b.plan = index;
        // miners sit far away on their deposit, so a factory frame only makes
        // sense around the processing block
        const processors = layout.buildings.filter((b) => b.kind !== "base");
        const bounds = processors.length ? boundsOf(processors) : null;
        // colour ports this factory pulls, one item per output item
        const colorPorts: ColorChar[] = [];
        for (const step of layout.steps) {
            if (step.op === "paint" && step.node.op === "paint") colorPorts.push(step.node.color);
            else if (step.op === "paint4" && step.node.op === "paint4") {
                for (const c of step.node.colors) if (c && c !== "u") colorPorts.push(c);
            }
        }
        const rate = chainRate(layout.steps);
        // every port owns a chain, so the only limit is a port that outruns a
        // single source (a 1/s quad painter port would need three miners)
        const amount = need.sources.reduce((sum, s) => sum + ("required" in s ? s.required : s.amount), 0);
        const supplyFactor = rate > SOURCE_RATE ? SOURCE_RATE / rate : 1;
        const effectiveRate = rate * supplyFactor;
        const etaNominal = amount > 0 && rate > 0 ? amount / rate : 0;
        const eta = amount > 0 && effectiveRate > 0 ? amount / effectiveRate : 0;
        entries.push({
            index,
            code: need.code,
            ok: true,
            status: "ok",
            cost: res.cost,
            buildings: layout.buildings.length,
            belts: layout.beltEstimate,
            bounds,
            missing: layout.missing,
            sources: need.sources,
            rate,
            limit: bottleneck(layout.steps),
            colorPorts,
            availableAt,
            amount,
            supplyFactor,
            effectiveRate,
            etaNominal,
            eta,
        });
        if (layout.missing.length) unbuildable += 1;
        plans.push({ index, code: need.code, bounds, buildings: layout.buildings.length, rate });

        allBuildings.push(...layout.buildings);
        allConnections.push(...layout.connections);
        allSources.push(...layout.sources);
        for (const m of layout.missing) missing.add(m);
        for (const b of layout.bom) bom.set(b.zh, (bom.get(b.zh) || 0) + b.n);
        for (const c of layout.colors) if (!colors.has(c.color)) colors.set(c.color, c);
        beltEstimate += layout.beltEstimate;
        totalBuildings += layout.buildings.length;
    });

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
    });
    if (repair.fixed > 0) {
        // belts moved: the gap list, the crossing lists and every belt count
        // have to follow the final world
        for (let i = gapList.length - 1; i >= 0; i--) {
            const conn = gapList[i]!.connection;
            if (conn !== undefined && conn >= 0 && allConnections[conn]!.routed) gapList.splice(i, 1);
        }
        for (const conn of allConnections) {
            if (!conn.routed || !conn.tunnelSpans.length) continue;
            conn.tunnelCells = conn.tunnelSpans.flatMap((span) => span.cells).filter((cell) => world.belts.has(cellKey(cell.x, cell.y)));
        }
        beltEstimate = 0;
        for (const conn of allConnections) {
            if (!conn.routed || !conn.path) continue;
            beltEstimate += conn.path.length - conn.tunnelSpans.reduce((n, span) => n + span.cells.length, 0);
        }
        const planOfStep = new Map(allBuildings.map((b): [string, number | undefined] => [b.stepId, b.plan]));
        const beltsByPlan = new Map<number, number>();
        for (const conn of allConnections) {
            if (!conn.routed || !conn.path) continue;
            const plan = planOfStep.get(conn.from);
            if (plan === undefined) continue;
            beltsByPlan.set(plan, (beltsByPlan.get(plan) ?? 0) + conn.path.length - conn.tunnelSpans.reduce((n, span) => n + span.cells.length, 0));
        }
        for (const e of entries) e.belts = beltsByPlan.get(e.index) ?? 0;
    }

    // ---- throughput: what each factory can deliver, and what is missing -----

    // every colour port of every painter pulls at its factory's chain rate
    const colorDemand = new Map<ColorChar, number>();
    for (const e of entries) {
        if (!e.ok) continue;
        for (const color of e.colorPorts) colorDemand.set(color, (colorDemand.get(color) || 0) + e.rate);
    }
    const supply = sizeColorSupply(colorDemand);
    // what the layout actually built: one chain per colour port
    const builtSources = new Map<string, number>();
    for (const b of allBuildings) {
        const m = /^color:([a-z]):/.exec(b.step || "");
        const key = m ? m[1] : undefined;
        if (key) builtSources.set(key, (builtSources.get(key) || 0) + 1);
    }
    const builtSourceCount = [...builtSources.values()].reduce((a, b) => a + b, 0);
    const demandSizedCount = [...supply.sources.values()].reduce((a, b) => a + b, 0);

    let limitedShapes = 0;
    for (const e of entries) {
        if (!e.ok) continue;
        if (e.supplyFactor < 0.999) limitedShapes += 1;
    }

    // colour sources the layout has to add: it currently builds exactly one
    // chain per colour, so anything above one source is a shortfall
    const colorGap: CampaignColorGap[] = [];
    for (const [color, needCount] of supply.sources) {
        const have = builtSources.get(color) || 0;
        if (have >= needCount) continue;
        colorGap.push({ color, need: needCount, have, kind: isMixedColor(color) ? "混色器" : "采矿机" });
    }
    colorGap.sort((a, b) => b.need - a.need);
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

    return {
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
                limitedShapes,
                balancerAt,
                tunnelAt,
            },
        },
        layout: {
            hub,
            tag: null,
            block: null,
            world,
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
}
