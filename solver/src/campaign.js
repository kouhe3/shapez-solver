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
import { buildLayout, createWorld } from "./layout.js";

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
export function planCampaign({ shapes, patches, hub, maxAttempts = 30000, buildings = null }) {
    const world = createWorld({ hub, patches });
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
        });
        if (layout.missing.length) unbuildable += 1;
        plans.push({ index, code: need.code, bounds, buildings: layout.buildings.length });

        allBuildings.push(...layout.buildings);
        allConnections.push(...layout.connections);
        allSources.push(...layout.sources);
        for (const m of layout.missing) missing.add(m);
        for (const b of layout.bom) bom.set(b.zh, (bom.get(b.zh) || 0) + b.n);
        for (const c of layout.colors) if (!colors.has(c.color)) colors.set(c.color, c);
        beltEstimate += layout.beltEstimate;
        totalBuildings += layout.buildings.length;
    });

    return {
        ok: failed === 0,
        entries,
        totals: { shapes: shapes.length, failed, unbuildable, buildings: totalBuildings, belts: beltEstimate },
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
