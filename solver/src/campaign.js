/**
 * "All shapes you need" solver: solve every shape the campaign asks for and lay
 * the factories out on one shared map, all delivering into the same hub.
 *
 * The hub keeps a permanent record of every shape ever delivered — that is what
 * the in-game note "您生产过的所有图形都会被用于解锁升级" means — so the winning
 * plan is one factory cluster that produces the whole union, never a per-level
 * build that gets torn down again.
 */

import { solve } from "./solver.js";
import { buildLayout, createWorld, sizeColorSupply } from "./layout.js";
import { chainRate, bottleneck, HUB_SIDES, SOURCE_RATE, MINER_RATE, BELT_RATE } from "./rates.js";
import { availableLevels, DEMO_LEVELS } from "./levels.js";
import { patchMinerCapacity } from "./map.js";

/** the game building a plan op needs (a miner is always available) */
const OP_BUILDING = {
    base: null,
    cutHalf: "cutter",
    cutQuad: "quadCutter",
    rotate: "rotaterCW",
    stack: "stacker",
    paint: "painter",
    paint4: "quadPainter",
    mixer: "mixer",
};

/** mixed colours need a mixer chain, base colours only a miner */
const MIXED_COLORS = new Set(["y", "p", "c", "w"]);

/** bounding box of a factory, one tile of margin so frames do not touch buildings */
function boundsOf(buildings) {
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

/**
 * @param {object} args
 * @param {Array<{code: string, sources: Array<object>}>} args.shapes needed shapes, in build order
 * @param {Array} args.patches map patches (from map.js)
 * @param {{x:number,y:number}} args.hub hub tile origin
 * @param {number} [args.maxAttempts] search budget per shape
 * @param {Set<string>|null} [args.buildings] available buildings; null = all
 * @returns {{ok: boolean, entries: Array, layout: object, totals: object}}
 */
export function planCampaign({ shapes, patches, hub, maxAttempts = 30000, buildings = null, levels = DEMO_LEVELS }) {
    const world = createWorld({ hub, patches });
    const unlock = availableLevels(levels);
    const baseCodes = [...new Set(patches.filter((p) => p.item.kind === "shape").map((p) => p.item.code))];
    const entries = [];
    const plans = [];
    const allBuildings = [];
    const allConnections = [];
    const allSources = [];
    const missing = new Set();
    const bom = new Map();
    const colors = new Map();
    let beltEstimate = 0;
    let totalBuildings = 0;
    let failed = 0;
    let unbuildable = 0;

    shapes.forEach((need, i) => {
        const index = i + 1;
        const res = solve(need.code, { maxAttempts, baseCodes, ...(buildings ? { buildings } : {}) });
        if (!res.ok) {
            failed += 1;
            entries.push({
                index,
                code: need.code,
                ok: false,
                error: res.error,
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
        });
        for (const b of layout.buildings) b.plan = index;
        // miners sit far away on their deposit, so a factory frame only makes
        // sense around the processing block
        const processors = layout.buildings.filter((b) => b.kind !== "base");
        const bounds = processors.length ? boundsOf(processors) : null;
        // colour ports this factory pulls, one item per output item
        const colorPorts = [];
        for (const step of layout.steps) {
            if (step.op === "paint") colorPorts.push(step.node.color);
            else if (step.op === "paint4") {
                for (const c of step.node.colors) if (c && c !== "u") colorPorts.push(c);
            }
        }
        const rate = chainRate(layout.steps);
        // when the player can actually build this factory: the last building it
        // needs must be unlocked, and the shape itself must be asked for
        let availableAt = 1;
        for (const step of layout.steps) {
            const building = OP_BUILDING[step.op];
            const at = building ? unlock.get(building) : null;
            if (at && at > availableAt) availableAt = at;
        }
        for (const s of need.sources) {
            if (s.kind === "level" && s.level > availableAt) availableAt = s.level;
        }
        entries.push({
            index,
            code: need.code,
            ok: true,
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

    // ---- throughput: what each factory can deliver, and what is missing -----

    // every colour port of every painter pulls at its factory's chain rate
    const colorDemand = new Map();
    for (const e of entries) {
        if (!e.ok) continue;
        for (const color of e.colorPorts) colorDemand.set(color, (colorDemand.get(color) || 0) + e.rate);
    }
    const supply = sizeColorSupply(colorDemand);
    // what the layout actually built: one chain per colour port
    const builtSources = new Map();
    for (const b of allBuildings) {
        const m = /^color:([a-z]):/.exec(b.step || "");
        if (m) builtSources.set(m[1], (builtSources.get(m[1]) || 0) + 1);
    }
    const builtSourceCount = [...builtSources.values()].reduce((a, b) => a + b, 0);
    const demandSizedCount = [...supply.sources.values()].reduce((a, b) => a + b, 0);

    let limitedShapes = 0;
    for (const e of entries) {
        if (!e.ok) continue;
        e.amount = e.sources.reduce((sum, s) => sum + (s.required ?? s.amount ?? 0), 0);
        // every port owns a chain, so the only limit is a port that outruns a
        // single source (a 1/s quad painter port would need three miners)
        e.supplyFactor = e.rate > SOURCE_RATE ? SOURCE_RATE / e.rate : 1;
        e.effectiveRate = e.rate * e.supplyFactor;
        e.etaNominal = e.amount > 0 && e.rate > 0 ? e.amount / e.rate : 0;
        e.eta = e.amount > 0 && e.effectiveRate > 0 ? e.amount / e.effectiveRate : 0;
        if (e.supplyFactor < 0.999) limitedShapes += 1;
    }

    // colour sources the layout has to add: it currently builds exactly one
    // chain per colour, so anything above one source is a shortfall
    const colorGap = [];
    for (const [color, needCount] of supply.sources) {
        const have = builtSources.get(color) || 0;
        if (have >= needCount) continue;
        colorGap.push({ color, need: needCount, have, kind: MIXED_COLORS.has(color) ? "混色器" : "采矿机" });
    }
    colorGap.sort((a, b) => b.need - a.need);
    const extraSources = colorGap.reduce((sum, g) => sum + (g.need - g.have), 0);
    const demandTotal = [...colorDemand.values()].reduce((a, b) => a + b, 0);
    const supplyAvailable = builtSourceCount * SOURCE_RATE;

    // deposits are lossy: every miner needs a free neighbouring tile to eject
    // into, and one belt takes one tile, so a blocky deposit tops out well below
    // its cell count
    const minerCapacity = new Map();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const color = p.item.color;
        minerCapacity.set(color, (minerCapacity.get(color) || 0) + patchMinerCapacity(p));
    }
    const capacityGap = [];
    for (const [color, needCount] of supply.sources) {
        if (MIXED_COLORS.has(color)) continue; // mixers are not ground-limited
        const capacity = minerCapacity.get(color) || 0;
        if (needCount > capacity) capacityGap.push({ color, need: needCount, capacity });
    }

    // one belt per port: every extra belt leaving the same output slot needs a
    // splitter/balancer node in front of it
    const ports = new Map();
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
    const hubMerges = Math.max(0, hubInbound - HUB_SIDES);
    const balancerAt = unlock.get("balancer") || null;
    const tunnelAt = unlock.get("tunnel") || null;

    return {
        ok: failed === 0,
        entries,
        totals: {
            shapes: shapes.length,
            failed,
            unbuildable,
            buildings: totalBuildings,
            belts: beltEstimate,
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
            beltEstimate,
            bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
            plans,
        },
    };
}
