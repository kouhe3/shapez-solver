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
import { SOURCE_RATE } from "./rates.js";

/**
 * Geometry of every part this solver places — port positions in tile units,
 * straight from the game's `ref/buildings/*.js`.
 *
 * The game ships 28 parts. The ones deliberately left out (balancer, tunnel,
 * storage, block, the sandbox-only producers, and the whole wire layer) and why
 * are listed in README under "零件清单".
 */
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
    mixer: {
        w: 2,
        h: 1,
        zh: "混色器",
        ins: [
            { x: 0.5, y: 1, kind: "color" },
            { x: 1.5, y: 1, kind: "color" },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
    // Not part of a plan: an unconnected output port backs up and stalls the
    // machine, so every unused cutter slot has to be vented. The game's trash
    // can (1×1, unlocked with the cutter at L1) accepts on all four sides.
    trash: {
        w: 1,
        h: 1,
        zh: "垃圾桶",
        ins: [
            { x: 0.5, y: 0 },
            { x: 1, y: 0.5 },
            { x: 0.5, y: 1 },
            { x: 0, y: 0.5 },
        ],
        outs: [],
    },
};

/** how a plan node maps to a game building */
export function buildingKind(step) {
    return step.op; // base / rotate / cutHalf / cutQuad / stack / paint / paint4
}

/** tiles the building's ports face — where its belts have to go */
export function portCells(info, x, y) {
    const cells = [];
    for (const port of [...(info.ins || []), ...(info.outs || [])]) {
        const px = x + port.x;
        const py = y + port.y;
        if (py === y) cells.push({ x: Math.floor(px), y: y - 1 });
        else if (py === y + info.h) cells.push({ x: Math.floor(px), y: y + info.h });
        else if (px === x) cells.push({ x: x - 1, y: Math.floor(py) });
        else cells.push({ x: x + info.w, y: Math.floor(py) });
    }
    return cells;
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

// The game mixes colors by OR-ing their red/green/blue bits (colors.js:
// enumColorMixingResults is built from the same bitfield table).
const COLOR_BITS = { u: 0, r: 1, g: 2, y: 3, b: 4, p: 5, c: 6, w: 7 };
const BITS_COLOR = ["u", "r", "g", "y", "b", "p", "c", "w"];

function mixColor(a, b) {
    return BITS_COLOR[(COLOR_BITS[a] || 0) | (COLOR_BITS[b] || 0)] || "u";
}

/**
 * How many colour sources a campaign needs, given what the painters pull.
 *
 * One source — a miner on a deposit, or one mixer — carries `SOURCE_RATE`
 * items/s. A mixed colour pushes its own inputs upstream: a mixer consumes
 * `SOURCE_RATE` of each input for every `SOURCE_RATE` it produces, and `w` is
 * built as mix(mix(r, g), b), so it consumes `y` and `b`.
 *
 * @param {Map<string, number>} demand items/s per colour, summed over every
 *   colour port of every painter
 * @returns {{need: Map<string, number>, sources: Map<string, number>}} how many
 *   items/s each colour has to produce, and how many sources that takes
 */
export function sizeColorSupply(demand) {
    const need = new Map(demand);
    const sources = new Map();
    const bump = (color, amount) => need.set(color, (need.get(color) || 0) + amount);
    const count = (amount) => Math.max(0, Math.ceil(amount / SOURCE_RATE - 1e-9));

    // `w` first: it is the only colour whose chain consumes another mixed
    // colour, so its demand has to reach `y` before `y` is counted.
    for (const color of ["w", "y", "p", "c"]) {
        const n = count(need.get(color) || 0);
        sources.set(color, n);
        if (!n) continue;
        for (const part of color === "w" ? ["y", "b"] : COLOR_NEEDS[color]) bump(part, n * SOURCE_RATE);
    }
    for (const color of ["r", "g", "b"]) sources.set(color, count(need.get(color) || 0));
    return { need, sources };
}

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
 * Turn a plan DAG into a tree by copying any sub-plan that feeds more than one
 * consumer.
 *
 * The search memoises identical sub-shapes, so the same node can hang under
 * several parents. In the game one output port feeds exactly one belt, so a
 * shared node would need a splitter — and splitters only unlock at L4. Parts are
 * free, so the legal answer is a second copy of that sub-plan.
 *
 * @param {{steps: Array, final: object}} flat a `plan.js` flatten result
 * @returns {{steps: Array, final: object}} a tree, inputs before their parent
 */
export function expandPlanTree(flat) {
    const byId = new Map(flat.steps.map((step) => [step.id, step]));
    const seen = new Map();
    const steps = [];
    const visit = (id) => {
        const src = byId.get(id);
        const n = (seen.get(id) || 0) + 1;
        seen.set(id, n);
        const inputs = src.inputs.map((input) => ({ ...input, id: visit(input.id).id }));
        const copy = { ...src, id: n === 1 ? id : `${id}#${n}`, inputs };
        steps.push(copy);
        return copy;
    };
    const final = visit(flat.final.id);
    return { steps, final };
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
    // one output port = one belt, so shared sub-plans get their own copy
    const flat = expandPlanTree(P.flatten(plan));
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

    const buildings = [];
    const sources = [];
    const missing = new Set();
    const connections = [];
    let beltEstimate = 0;
    /** colour chains are per consumer port, so their ids need to stay unique */
    let colorSerial = 0;

    /** first free spot for `info` around an anchor tile, nearest ring first */
    function placeNear(info, anchor) {
        for (let r = 0; r < 48; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    if (fit(info, anchor.x + dx, anchor.y + dy)) return { x: anchor.x + dx, y: anchor.y + dy };
                }
            }
        }
        return null;
    }

    /** one belt run between two ports; `extra` says what the link carries */
    function pushConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, extra = {}) {
        const outPort = srcInfo.outs[outSlot] || srcInfo.outs[0];
        const inPort = dstInfo.ins[inSlot];
        if (!outPort || !inPort) return;
        const x1 = srcBuilding.x + outPort.x;
        const y1 = srcBuilding.y + outPort.y;
        const x2 = dstBuilding.x + inPort.x;
        const y2 = dstBuilding.y + inPort.y;
        const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
        const beltTiles = Math.max(1, Math.round(len));
        beltEstimate += beltTiles;
        connections.push({
            from: srcBuilding.stepId,
            to: dstBuilding.stepId,
            slot: inSlot,
            fromLabel: srcInfo.zh,
            toLabel: dstInfo.zh,
            outSlot,
            outCount: srcInfo.outs.length,
            x1,
            y1,
            x2,
            y2,
            length: len,
            beltTiles,
            ...extra,
        });
    }

    /** colour feeds have no plan step: one chain head feeds one painter port */
    function pushColorConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot) {
        pushConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, { color: true });
    }

    /**
     * One colour chain per consumer port.
     *
     * A machine's output port takes exactly one belt, so one chain can feed one
     * painter and no more. Parts and ground are free in shapez, so the cheap
     * legal answer is to grow the chain again next to each painter instead of
     * splitting a shared one — and before the balancer unlock (L4) splitting is
     * impossible anyway. The chain is anchored at its consumer, so belts stay short.
     *
     * @param {string} color
     * @param {{x: number, y: number}} anchor tile to grow the chain around
     * @returns {{ok: boolean, color: string, building?: object, info?: object, outSlot?: number}|null}
     */
    function buildColorChain(color, anchor) {
        if (!color || color === "u") return null;
        const parts = COLOR_NEEDS[color];
        if (!parts) {
            const found = placeExtractor(shared, (item) => item.kind === "color" && item.color === color, anchor);
            if (!found) {
                missing.add(`颜色:${color}`);
                return { color, ok: false };
            }
            const serial = ++colorSerial;
            const b = {
                step: `color:${color}:miner#${serial}`,
                stepId: `${idPrefix}color:${color}:miner#${serial}`,
                kind: "base",
                zh: "采矿机",
                x: found.x,
                y: found.y,
                w: 1,
                h: 1,
                patch: found.patch,
                distance: found.distance,
                color,
            };
            buildings.push(b);
            sources.push({ step: null, patch: found.patch, distance: found.distance, x: found.x, y: found.y, color });
            for (const c of portCells(BUILDING_INFO.base, found.x, found.y)) shared.occupied.add(cellKey(c.x, c.y));
            return { color, ok: true, building: b, info: BUILDING_INFO.base, outSlot: 0 };
        }
        let acc = buildColorChain(parts[0], anchor);
        for (let i = 1; i < parts.length; i++) {
            const rhs = buildColorChain(parts[i], anchor);
            if (!acc || !rhs || !acc.ok || !rhs.ok) return { color, ok: false };
            const info = BUILDING_INFO.mixer;
            const pos = placeNear(info, anchor);
            if (!pos) {
                missing.add(`颜色:${color}`);
                return { color, ok: false };
            }
            const mixed = mixColor(acc.color, rhs.color);
            const serial = ++colorSerial;
            const b = {
                step: `color:${mixed}:mixer#${serial}`,
                stepId: `${idPrefix}color:${mixed}:mixer#${serial}`,
                kind: "mixer",
                zh: info.zh,
                x: pos.x,
                y: pos.y,
                w: info.w,
                h: info.h,
                detail: `${acc.color}+${rhs.color}`,
                colors: [acc.color, rhs.color],
            };
            buildings.push(b);
            for (const c of portCells(info, pos.x, pos.y)) shared.occupied.add(cellKey(c.x, c.y));
            pushColorConnection(acc.building, acc.info, acc.outSlot, b, info, 0);
            pushColorConnection(rhs.building, rhs.info, rhs.outSlot, b, info, 1);
            acc = { color: mixed, ok: true, building: b, info, outSlot: 0 };
        }
        return acc || { color, ok: false };
    }

    const paintColorsUsed = new Set();
    for (const step of flat.steps) {
        if (step.op === "paint") paintColorsUsed.add(step.node.color);
        else if (step.op === "paint4") for (const c of step.node.colors) if (c && c !== "u") paintColorsUsed.add(c);
    }

    const hasProcessors = flat.steps.some((s) => s.op !== "base");
    const block = hasProcessors ? allocateBlock(shared, blockWidth, blockHeight) : null;
    const blockX = block ? block.x : hub.x + 8;
    const blockY = block ? block.y : hub.y - 8;

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
        // a later factory must not take the tile this miner's belt leaves from
        for (const c of portCells(BUILDING_INFO.base, found.x, found.y)) shared.occupied.add(cellKey(c.x, c.y));
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
            for (const c of portCells(info, cx, cy)) shared.occupied.add(cellKey(c.x, c.y));
            cx += info.w + 1;
        }
    }

    const buildingByStep = new Map(buildings.map((b) => [b.step, b]));

    // 3) connections + belt lengths
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

    // 3c) colour belts: every painter input is fed by its colour chain
    for (const step of flat.steps) {
        if (step.op !== "paint" && step.op !== "paint4") continue;
        const painter = buildingByStep.get(step.id);
        if (!painter) continue;
        const info = BUILDING_INFO[step.op];
        const colors = step.op === "paint4" ? step.node.colors : [step.node.color];
        colors.forEach((color, i) => {
            if (!color || color === "u") return;
            // one chain per port, grown next to the painter that consumes it
            const chain = buildColorChain(color, { x: painter.x + info.w / 2, y: painter.y + info.h / 2 });
            if (!chain || !chain.ok) {
                missing.add(`颜色:${color}`);
                return;
            }
            pushColorConnection(chain.building, chain.info, chain.outSlot, painter, info, i + 1);
        });
    }

    // 3d) an output port with nowhere to go backs up and stalls the machine, so
    // every cutter slot the plan does not use gets a trash can. The game unlocks
    // the can together with the cutter at L1, so this is legal from the start.
    for (const step of flat.steps) {
        const info = BUILDING_INFO[step.op];
        if (!info || !info.outs || info.outs.length < 2) continue;
        const source = buildingByStep.get(step.id);
        if (!source) continue;
        const used = outputSlot(step);
        for (let slot = 0; slot < info.outs.length; slot++) {
            if (slot === used) continue;
            const port = info.outs[slot];
            const pos = placeNear(BUILDING_INFO.trash, {
                x: Math.floor(source.x + port.x),
                y: Math.floor(source.y + port.y),
            });
            if (!pos) {
                missing.add("垃圾桶");
                continue;
            }
            const can = {
                step: `trash:${step.id}:${slot}`,
                stepId: `${idPrefix}trash:${step.id}:${slot}`,
                kind: "trash",
                zh: "垃圾桶",
                x: pos.x,
                y: pos.y,
                w: 1,
                h: 1,
            };
            buildings.push(can);
            for (const cell of portCells(BUILDING_INFO.trash, pos.x, pos.y)) shared.occupied.add(cellKey(cell.x, cell.y));
            // feed the side of the can that faces the machine
            const px = source.x + port.x;
            const py = source.y + port.y;
            const cx = pos.x + 0.5;
            const cy = pos.y + 0.5;
            const inSlot = Math.abs(px - cx) > Math.abs(py - cy) ? (px < cx ? 3 : 1) : py < cy ? 0 : 2;
            pushConnection(source, info, slot, can, BUILDING_INFO.trash, inSlot, { waste: true });
        }
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
    const colors = [...paintColorsUsed].map((c) => {
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
