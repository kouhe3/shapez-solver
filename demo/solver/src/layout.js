/**
 * Turns a solved plan into a buildable layout ("图纸"):
 *
 *  - picks a real resource patch for every extractor (shape + color),
 *  - places the processing buildings on a tile grid next to the hub,
 *  - computes the exact port positions from the game's building definitions,
 *  - emits connections (what feeds what) + belt-length estimates + BOM.
 *
 * Port coordinates are in tile units relative to the building's top-left tile;
 * y grows downwards (screen/tile space, same as the game).
 */

import * as P from "./plan.js";

export const BUILDING_INFO = {
    base: {
        w: 1,
        h: 1,
        zh: "采矿机",
        ins: [],
        outs: [{ x: 0.5, y: 0 }],
    },
    rotate: {
        w: 1,
        h: 1,
        zh: "旋转器",
        ins: [{ x: 0.5, y: 1 }],
        outs: [{ x: 0.5, y: 0 }],
    },
    cutHalf: {
        w: 2,
        h: 1,
        zh: "切割机",
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
        ],
    },
    cutQuad: {
        w: 4,
        h: 1,
        zh: "四向切割机",
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
            { x: 2.5, y: 0 },
            { x: 3.5, y: 0 },
        ],
    },
    stack: {
        w: 2,
        h: 1,
        zh: "堆叠器",
        ins: [
            { x: 0.5, y: 1 },
            { x: 1.5, y: 1 },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
    paint: {
        w: 2,
        h: 1,
        zh: "上色器",
        ins: [
            { x: 0, y: 0.5 },
            { x: 1.5, y: 0, kind: "color" },
        ],
        outs: [{ x: 2, y: 0.5 }],
    },
    paint4: {
        w: 4,
        h: 1,
        zh: "四色上色器",
        ins: [
            { x: 0, y: 0.5 },
            { x: 0.5, y: 1, kind: "color" },
            { x: 1.5, y: 1, kind: "color" },
            { x: 2.5, y: 1, kind: "color" },
            { x: 3.5, y: 1, kind: "color" },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
};

/** how a plan node maps to a game building */
export function buildingKind(step) {
    return step.op; // base / rotate / cutHalf / cutQuad / stack / paint / paint4
}

/**
 * Ejector slot carrying this step's product. The cutter's two halves and the
 * quad cutter's four quadrants are bound to fixed slots by the game:
 * cutHalf slot 0 = {2,3}, slot 1 = {0,1}; cutQuad slot i = quadrant i.
 */
export function outputSlot(step) {
    if (!step || !step.node) return 0;
    if (step.node.op === "cutHalf") return step.node.side;
    if (step.node.op === "cutQuad") return step.node.quad;
    return 0;
}


/** approximate tiles occupied by a patch (the game draws them as overlapping circles) */
function patchCells(patch) {
    const r = Math.max(1.5, (patch.size || 2) * 0.9 + 0.5);
    const cells = [];
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
            if (dx * dx + dy * dy <= r * r) cells.push({ x: Math.round(patch.x) + dx, y: Math.round(patch.y) + dy });
        }
    }
    return cells;
}

const COLOR_NEEDS = { y: ["r", "g"], p: ["r", "b"], c: ["g", "b"], w: ["r", "g", "b"] };

/** the hub occupies a 4×4 tile block; belts may enter it on any side */
const HUB_SIZE = 4;

/**
 * Tile centre on the hub's border closest to (x, y) — where the last belt
 * enters the hub. Entry points sit on the border ring so the arrow lands on
 * the hub itself rather than inside it.
 */
function hubEntry(hub, x, y) {
    let best = { x: hub.x + 0.5, y: hub.y + 0.5 };
    let bestD = Infinity;
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) {
            if (dx !== 0 && dx !== HUB_SIZE - 1 && dy !== 0 && dy !== HUB_SIZE - 1) continue;
            const cx = hub.x + dx + 0.5;
            const cy = hub.y + dy + 0.5;
            const d = Math.abs(cx - x) + Math.abs(cy - y);
            if (d < bestD) {
                bestD = d;
                best = { x: cx, y: cy };
            }
        }
    }
    return best;
}

function cellKey(x, y) {
    return x + "|" + y;
}

/** tiles covered by a deposit, ordered from its centre outwards */
function patchCellsByCentre(patch) {
    return patchCells(patch)
        .map((c) => ({ x: c.x, y: c.y, d: Math.hypot(c.x - patch.x, c.y - patch.y) }))
        .sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
}

/**
 * Placement state shared by every factory on one map: which tiles are taken and
 * which belong to a deposit (only a miner may sit on a deposit tile).
 */
export function createWorld({ hub, patches }) {
    const occupied = new Set();
    const deposits = new Set();
    for (const p of patches) {
        for (const c of patchCells(p)) deposits.add(cellKey(c.x, c.y));
    }
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) occupied.add(cellKey(hub.x + dx, hub.y + dy));
    }
    return { hub, patches, occupied, deposits, blocks: [] };
}

/** a processor may only sit on bare ground */
function processorFree(world, x, y) {
    const k = cellKey(x, y);
    return !world.occupied.has(k) && !world.deposits.has(k);
}

/**
 * A miner takes one free tile of the nearest deposit that has one — several
 * factories (and several steps of one factory) may share a deposit.
 */
function placeExtractor(world, predicate, from) {
    const candidates = world.patches
        .filter((p) => predicate(p.item))
        .map((p) => ({ patch: p, distance: Math.hypot(p.x - from.x, p.y - from.y) }))
        .sort((a, b) => a.distance - b.distance);
    for (const { patch, distance } of candidates) {
        for (const cell of patchCellsByCentre(patch)) {
            if (world.occupied.has(cellKey(cell.x, cell.y))) continue;
            world.occupied.add(cellKey(cell.x, cell.y));
            return { patch, distance, x: cell.x, y: cell.y };
        }
    }
    return null;
}

function blockCollisions(world, x, y, width, height, limit = Infinity) {
    let hits = 0;
    for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++) {
            if (!processorFree(world, x + i, y + j)) {
                if (++hits >= limit) return hits;
            }
        }
    }
    return hits;
}

/**
 * Block origin for one factory: the nearest window around the hub that no
 * deposit or existing building sits in, else the emptiest window seen. Windows
 * may overlap each other — only the buildings packed into them have to be
 * disjoint — so the grid is fine grained and ordered by distance.
 */
function allocateBlock(world, width, height) {
    const { hub } = world;
    const stepX = 6;
    const stepY = 4;
    const reach = 12;
    const candidates = [];
    for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
            if (!dx && !dy) continue;
            candidates.push({ dx, dy, d: Math.abs(dx) * stepX + Math.abs(dy) * stepY });
        }
    }
    candidates.sort((a, b) => a.d - b.d || a.dx - b.dx || a.dy - b.dy);
    let best = null;
    let bestHits = Infinity;
    for (const c of candidates) {
        const x = hub.x + c.dx * stepX;
        const y = hub.y + c.dy * stepY;
        const hits = blockCollisions(world, x, y, width, height, bestHits);
        if (hits < bestHits) {
            bestHits = hits;
            best = { x, y, w: width, h: height };
            if (hits === 0) break;
        }
    }
    if (best) world.blocks.push(best);
    return best;
}

/**
 * @param {object} args
 * @param {object} args.plan   plan AST root
 * @param {Array} args.patches map patches (from map.js)
 * @param {{x:number,y:number}} args.hub hub tile origin
 * @param {object} [args.world] shared placement state; omit for a one-off layout
 * @param {string} [args.idPrefix] namespaces step ids when several plans share a world
 * @param {string} [args.tag] the target this layout builds (campaign sheets)
 */
export function buildLayout({
    plan,
    patches,
    hub = { x: -2, y: -2 },
    blockWidth = 26,
    blockHeight = 12,
    world = null,
    idPrefix = "",
    tag = null,
}) {
    const shared = world || createWorld({ hub, patches });
    const flat = P.flatten(plan);
    // dependency depth
    const depth = new Map();
    const stepById = new Map(flat.steps.map((s) => [s.id, s]));
    for (const step of flat.steps) {
        let d = 0;
        for (const input of step.inputs) d = Math.max(d, (depth.get(input.id) || 0) + 1);
        depth.set(step.id, d);
    }

    function fit(info, x, y) {
        for (let dx = 0; dx < info.w; dx++) {
            for (let dy = 0; dy < info.h; dy++) if (!processorFree(shared, x + dx, y + dy)) return false;
        }
        for (let dx = 0; dx < info.w; dx++) {
            for (let dy = 0; dy < info.h; dy++) shared.occupied.add(cellKey(x + dx, y + dy));
        }
        return true;
    }

    const hasProcessors = flat.steps.some((s) => s.op !== "base");
    const block = hasProcessors ? allocateBlock(shared, blockWidth, blockHeight) : null;
    const blockX = block ? block.x : hub.x + 8;
    const blockY = block ? block.y : hub.y - 8;

    const buildings = [];
    const sources = [];
    const missing = new Set();

    // 1) place extractors on real patches
    for (const step of flat.steps) {
        if (step.op !== "base") continue;
        const type = step.node.type;
        const code = step.node.code || `${type}u${type}u${type}u${type}u`;
        const found = placeExtractor(shared, (item) => item.kind === "shape" && item.code === code, {
            x: hub.x + 2,
            y: hub.y + 2,
        });
        if (!found) {
            missing.add(`shape:${code}`);
            sources.push({ step, missing: `地图上找不到 ${code} 矿脉`, patch: null });
            continue;
        }
        sources.push({ step, patch: found.patch, distance: found.distance, x: found.x, y: found.y });
        buildings.push({
            step: step.id,
            stepId: idPrefix + step.id,
            kind: "base",
            zh: "采矿机",
            x: found.x,
            y: found.y,
            w: 1,
            h: 1,
            patch: found.patch,
            distance: found.distance,
        });
    }

    // 2) pack processors into rows, grouped by depth
    const byDepth = new Map();
    for (const step of flat.steps) {
        if (step.op === "base") continue;
        const d = depth.get(step.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d).push(step);
    }
    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 3;
        for (const step of steps) {
            const info = BUILDING_INFO[step.op];
            if (!info) continue;
            if (cx + info.w > blockX + blockWidth) {
                cx = blockX;
                cy += 3;
            }
            let placed = false;
            for (let attempt = 0; attempt < 200 && !placed; attempt++) {
                if (fit(info, cx, cy)) {
                    placed = true;
                } else {
                    cx += info.w + 1;
                    if (cx + info.w > blockX + blockWidth) {
                        cx = blockX;
                        cy += 3;
                    }
                }
            }
            if (!placed) continue;
            buildings.push({
                step: step.id,
                stepId: idPrefix + step.id,
                kind: step.op,
                zh: info.zh,
                x: cx,
                y: cy,
                w: info.w,
                h: info.h,
                detail: step.op === "paint4" ? step.node.colors.map((c) => c || "-").join("/") : step.detail,
                colors:
                    step.op === "paint4"
                        ? step.node.colors.map((c) => (c && c !== "u" ? c : null))
                        : step.op === "paint"
                        ? [step.node.color]
                        : undefined,
            });
            cx += info.w + 1;
        }
    }

    const buildingByStep = new Map(buildings.map((b) => [b.step, b]));

    // 3) connections + belt lengths
    const connections = [];
    let beltEstimate = 0;
    for (const step of flat.steps) {
        const target = buildingByStep.get(step.id);
        if (!target) continue;
        const tInfo = BUILDING_INFO[step.op];
        if (!tInfo) continue;
        step.inputs.forEach((input, i) => {
            const src = buildingByStep.get(input.id);
            if (!src) return;
            const sInfo = BUILDING_INFO[src.kind];
            const outSlot = outputSlot(stepById.get(input.id));
            const outPort = sInfo.outs[outSlot] || sInfo.outs[0];
            const inPort = tInfo.ins[i];
            if (!inPort) return;
            const x1 = src.x + outPort.x;
            const y1 = src.y + outPort.y;
            const x2 = target.x + inPort.x;
            const y2 = target.y + inPort.y;
            const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
            const beltTiles = Math.max(1, Math.round(len));
            beltEstimate += beltTiles;
            connections.push({
                from: src.stepId,
                to: target.stepId,
                slot: i,
                fromLabel: sInfo.zh,
                toLabel: tInfo.zh,
                outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: len,
                beltTiles,
            });
        });
    }

    // 3b) the finished product itself still has to be belted into the hub
    const rootBuilding = buildingByStep.get(flat.final.id);
    if (rootBuilding) {
        const rInfo = BUILDING_INFO[rootBuilding.kind];
        const outSlot = outputSlot(flat.final);
        const outPort = rInfo.outs[outSlot] || rInfo.outs[0];
        const x1 = rootBuilding.x + outPort.x;
        const y1 = rootBuilding.y + outPort.y;
        const entry = hubEntry(hub, x1, y1);
        const len = Math.abs(entry.x - x1) + Math.abs(entry.y - y1);
        const beltTiles = Math.max(1, Math.round(len));
        beltEstimate += beltTiles;
        connections.push({
            from: rootBuilding.stepId,
            to: "HUB",
            toHub: true,
            slot: null,
            fromLabel: rInfo.zh,
            toLabel: "枢纽",
            outSlot,
            outCount: rInfo.outs.length,
            x1,
            y1,
            x2: entry.x,
            y2: entry.y,
            length: len,
            beltTiles,
        });
    }

    // 4) colors: which ones are on the map, which need mixing
    const colorPatches = new Map();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const prev = colorPatches.get(p.item.color);
        if (!prev || Math.hypot(p.x - hub.x, p.y - hub.y) < Math.hypot(prev.x - hub.x, prev.y - hub.y)) {
            colorPatches.set(p.item.color, p);
        }
    }
    const paintColors = new Set();
    for (const step of flat.steps) {
        if (step.op === "paint") paintColors.add(step.node.color);
    }
    const colors = [...paintColors].map((c) => {
        const direct = colorPatches.get(c);
        if (direct) return { color: c, direct: true, patch: direct, mix: null };
        const mix = COLOR_NEEDS[c];
        return { color: c, direct: false, patch: null, mix };
    });

    const bom = new Map();
    for (const b of buildings) bom.set(b.zh, (bom.get(b.zh) || 0) + 1);

    return {
        hub,
        tag,
        block,
        world: shared,
        buildings,
        connections,
        sources,
        colors,
        missing: [...missing],
        beltEstimate,
        bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
        steps: flat.steps,
        depth,
    };
}
