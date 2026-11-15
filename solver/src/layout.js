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
import { COLOR_NEEDS, COLOR_OP_LABELS, colorChain, colorChains } from "./color.js";

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
 * The tile beyond each port — where the belt serving that port has to run.
 * Keeping it free is what makes a port connectable at all; a part placed there
 * would wall the port in.
 */
export function portApproachCells(info, x, y) {
    const cells = [];
    for (const port of [...(info.ins || []), ...(info.outs || [])]) {
        const px = x + port.x;
        const py = y + port.y;
        if (py === y) cells.push({ x: Math.floor(px), y: y - 2 });
        else if (py === y + info.h) cells.push({ x: Math.floor(px), y: y + info.h + 1 });
        else if (px === x) cells.push({ x: x - 2, y: Math.floor(py) });
        else cells.push({ x: x + info.w + 1, y: Math.floor(py) });
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

const ROUTE_DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

/**
 * Shortest legal belt run between two port tiles, as the game would lay it.
 *
 * Every cell has to stay off machines, the hub and other parts' ports. Running
 * into an existing belt is only legal with a tunnel: the two belts must cross
 * at a right angle, and the game only hands the tunnel out at L6, which the
 * caller passes as `allowCross`. When no legal run exists the link is reported
 * as unroutable instead of being drawn as if it worked.
 *
 * Turns cost 2 so the result reads as a few straight runs instead of a
 * staircase; crossings cost 3 (the tunnel plus the extra tile).
 *
 * @param {object} world shared world; `belts` maps a tile to "h"|"v"|"turn"
 * @param {Set<string>} blocked machine, hub and port tiles
 * @param {{x:number,y:number}} start output port tile
 * @param {{x:number,y:number}} goal input port tile
 * @param {{allowCross?: boolean, margin?: number}} [opts]
 * @returns {{cells: Array<{x:number,y:number}>, crossings: Array<{x:number,y:number}>}|null}
 */
export function routeBelt(world, blocked, start, goal, opts = {}) {
    const margin = opts.margin ?? 20;
    const minX = Math.min(start.x, goal.x) - margin;
    const maxX = Math.max(start.x, goal.x) + margin;
    const minY = Math.min(start.y, goal.y) - margin;
    const maxY = Math.max(start.y, goal.y) + margin;
    const width = maxX - minX + 1;
    const size = width * (maxY - minY + 1);
    const indexOf = (x, y) => (y - minY) * width + (x - minX);
    const startIndex = indexOf(start.x, start.y);
    const goalIndex = indexOf(goal.x, goal.y);

    // state = tile * 4 + heading; the heading is what makes a turn cost extra
    const dist = new Float64Array(size * 4).fill(Infinity);
    const from = new Int32Array(size * 4).fill(-1);
    const buckets = [];
    const push = (state, cost) => {
        (buckets[cost] || (buckets[cost] = [])).push(state);
    };
    for (let d = 0; d < 4; d++) {
        dist[startIndex * 4 + d] = 0;
        push(startIndex * 4 + d, 0);
    }

    let best = -1;
    search: for (let cost = 0; cost < buckets.length; cost++) {
        const bucket = buckets[cost];
        if (!bucket) continue;
        while (bucket.length) {
            const state = bucket.pop();
            if (dist[state] !== cost) continue;
            const cell = state >> 2;
            const heading = state & 3;
            if (cell === goalIndex) {
                best = state;
                break search;
            }
            const cx = (cell % width) + minX;
            const cy = Math.floor(cell / width) + minY;
            for (let d = 0; d < 4; d++) {
                const nx = cx + ROUTE_DIRS[d][0];
                const ny = cy + ROUTE_DIRS[d][1];
                if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
                const endpoint = (nx === start.x && ny === start.y) || (nx === goal.x && ny === goal.y);
                const free = endpoint || (opts.exempt && opts.exempt.has(cellKey(nx, ny)));
                if (!free && blocked.has(cellKey(nx, ny))) continue;
                const joinsGoal = opts.goalMayJoin && nx === goal.x && ny === goal.y;
                let step = 1 + (d === heading ? 0 : 2);
                const belt = world.belts.get(cellKey(nx, ny));
                if (belt && !joinsGoal) {
                    // the tunnel runs under a perpendicular belt, never along one
                    const across = d < 2 ? "v" : "h";
                    if (!opts.allowCross || belt !== across || world.tunnelCells.has(cellKey(nx, ny))) continue;
                    step += 3;
                }
                const next = indexOf(nx, ny) * 4 + d;
                const total = cost + step;
                if (total < dist[next]) {
                    dist[next] = total;
                    from[next] = state;
                    push(next, total);
                }
            }
        }
    }
    if (best < 0) return null;

    const cells = [];
    for (let state = best; state >= 0; state = from[state]) {
        const cell = state >> 2;
        cells.push({ x: (cell % width) + minX, y: Math.floor(cell / width) + minY });
    }
    cells.reverse();
    if (opts.dryRun) {
        return { cells, crossings: cells.filter(({ x, y }) => world.belts.has(cellKey(x, y))) };
    }

    // claim the run: a tile that already holds a belt is a tunnel crossing
    const crossings = [];
    for (let i = 0; i < cells.length; i++) {
        const { x, y } = cells[i];
        const key = cellKey(x, y);
        if (world.belts.has(key)) {
            // the merge case joins the belt already entering the hub; no tunnel
            if (opts.goalMayJoin && i === cells.length - 1) continue;
            if (!world.tunnelCells.has(key)) {
                world.tunnelCells.add(key);
                crossings.push({ x, y });
            }
            continue;
        }
        let heading;
        if (cells.length === 1) heading = "h";
        else if (i === 0) heading = cells[1].y === cells[0].y ? "h" : "v";
        else if (i === cells.length - 1) heading = cells[i].y === cells[i - 1].y ? "h" : "v";
        else if (cells[i - 1].y === cells[i + 1].y) heading = "h";
        else if (cells[i - 1].x === cells[i + 1].x) heading = "v";
        else heading = "turn";
        world.belts.set(key, heading);
        world.occupied.add(key);
    }
    return { cells, crossings };
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
 * The tiles a belt can stand on to feed the hub: one per side of every border
 * tile (16 total). Two belts cannot share one — each border tile takes one
 * belt — so a campaign with more factories than that needs a merger.
 */
function hubApproaches(hub) {
    const out = [];
    for (let i = 0; i < HUB_SIZE; i++) {
        out.push({ x: hub.x + i, y: hub.y - 1 });
        out.push({ x: hub.x + i, y: hub.y + HUB_SIZE });
        out.push({ x: hub.x - 1, y: hub.y + i });
        out.push({ x: hub.x + HUB_SIZE, y: hub.y + i });
    }
    return out;
}

/** the border tile an outside approach feeds; its centre is where the belt ends */
function hubBorderOf(hub, tile) {
    if (tile.y < hub.y) return { x: tile.x, y: hub.y };
    if (tile.y >= hub.y + HUB_SIZE) return { x: tile.x, y: hub.y + HUB_SIZE - 1 };
    if (tile.x < hub.x) return { x: hub.x, y: tile.y };
    return { x: hub.x + HUB_SIZE - 1, y: tile.y };
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
    // machine bodies and their port tiles never carry a belt; kept across
    // factories so a later route cannot cut through an earlier factory
    const walls = new Set();
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) walls.add(cellKey(hub.x + dx, hub.y + dy));
    }
    return {
        hub,
        patches,
        occupied,
        deposits,
        blocks: [],
        walls,
        /** tiles a belt must run through to reach a port; never built on */
        approaches: new Set(),
        /** tile → "h" | "v" | "turn": the belt already laid there */
        belts: new Map(),
        /** tiles where one belt passes under another through a tunnel */
        tunnelCells: new Set(),
        /** outside tiles already claimed by a belt feeding the hub */
        hubApproaches: new Set(),
    };
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
            // its ejector tile and the tile behind it must be clear
            const blocked = [...portCells(BUILDING_INFO.base, cell.x, cell.y), ...portApproachCells(BUILDING_INFO.base, cell.x, cell.y)].some(
                (c) => world.walls.has(cellKey(c.x, c.y)) || world.belts.has(cellKey(c.x, c.y)) || world.approaches.has(cellKey(c.x, c.y))
            );
            if (blocked) continue;
            world.occupied.add(cellKey(cell.x, cell.y));
            world.walls.add(cellKey(cell.x, cell.y));
            for (const c of portCells(BUILDING_INFO.base, cell.x, cell.y)) world.walls.add(cellKey(c.x, c.y));
            for (const c of portApproachCells(BUILDING_INFO.base, cell.x, cell.y)) {
                world.approaches.add(cellKey(c.x, c.y));
                world.occupied.add(cellKey(c.x, c.y));
            }
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
    // tile the map with one window per factory plus a four-tile gap, so two
    // neighbouring factories never share a belt corridor
    const stepX = width + 4;
    const stepY = height + 4;
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
 * Machines a flattened plan has to be built from: a miner per base step, one
 * processor per step, a trash can for every cutter output the plan does not
 * use, and the whole colour chain of every painter colour port. Same counting
 * as `buildLayout`'s BOM, so a single-shape recipe and a campaign factory
 * report the same machine list.
 *
 * @param {{steps: Array}} flat a flattened (ideally `expandPlanTree`d) plan
 * @param {Array} [chains] colour chains of those steps
 * @returns {Array<{zh: string, n: number}>}
 */
export function planBom(flat, chains = colorChains(flat.steps)) {
    const bom = new Map();
    const add = (zh, n = 1) => bom.set(zh, (bom.get(zh) || 0) + n);
    for (const step of flat.steps) {
        const info = BUILDING_INFO[step.op];
        if (!info) continue;
        add(info.zh);
        if (info.outs.length > 1) add(BUILDING_INFO.trash.zh, info.outs.length - 1);
    }
    for (const chain of chains) {
        for (const op of chain.ops) add(op.kind === "mixer" ? COLOR_OP_LABELS.mixer : COLOR_OP_LABELS.base);
    }
    return [...bom.entries()].map(([zh, n]) => ({ zh, n }));
}

/**
 * @param {object} args
 * @param {object} args.plan   plan AST root
 * @param {Array} args.patches map patches (from map.js)
 * @param {{x:number,y:number}} args.hub hub tile origin
 * @param {object} [args.world] shared placement state; omit for a one-off layout
 * @param {string} [args.idPrefix] namespaces step ids when several plans share a world
 * @param {string} [args.tag] the target this layout builds (campaign sheets)
 * @param {boolean} [args.allowTunnels] may a belt cross another one (tunnel
 *   unlocked)? Before L6 every crossing is illegal and must be routed around
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
    allowTunnels = true,
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
        // a port cannot share a tile with another part's body, port or belt,
        // and the belt beyond it needs a clear tile to run through
        for (const c of [...portCells(info, x, y), ...portApproachCells(info, x, y)]) {
            const key = cellKey(c.x, c.y);
            if (shared.walls.has(key) || shared.belts.has(key) || shared.approaches.has(key)) return false;
        }
        for (let dx = 0; dx < info.w; dx++) {
            for (let dy = 0; dy < info.h; dy++) {
                shared.occupied.add(cellKey(x + dx, y + dy));
                shared.walls.add(cellKey(x + dx, y + dy));
            }
        }
        for (const c of portCells(info, x, y)) shared.walls.add(cellKey(c.x, c.y));
        for (const c of portApproachCells(info, x, y)) {
            shared.approaches.add(cellKey(c.x, c.y));
            shared.occupied.add(cellKey(c.x, c.y));
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
        // anchors are often a building centre (half tiles); every part must sit
        // on whole tiles or its ports land between two grid cells
        const ax = Math.floor(anchor.x);
        const ay = Math.floor(anchor.y);
        for (let r = 0; r < 48; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    if (fit(info, ax + dx, ay + dy)) return { x: ax + dx, y: ay + dy };
                }
            }
        }
        return null;
    }

    /**
     * Links wait for the router: every part is placed first, so the belt a
     * connection needs can avoid all of them instead of cutting through the
     * machines that are placed after it.
     */
    const queued = [];
    function queueConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, extra = {}) {
        queued.push({ srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, extra });
    }

    /** colour feeds have no plan step: one chain head feeds one painter port */
    function pushColorConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot) {
        queueConnection(srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, { color: true });
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
        // the mix tree comes from color.js, so the recipe the CLI prints and
        // the buildings placed here can never drift apart
        const built = [];
        for (const op of colorChain(color)) {
            if (op.kind === "base") {
                const found = placeExtractor(shared, (item) => item.kind === "color" && item.color === op.color, anchor);
                if (!found) {
                    missing.add(`颜色:${op.color}`);
                    return { color, ok: false };
                }
                const serial = ++colorSerial;
                const b = {
                    step: `color:${op.color}:miner#${serial}`,
                    stepId: `${idPrefix}color:${op.color}:miner#${serial}`,
                    kind: "base",
                    zh: "采矿机",
                    x: found.x,
                    y: found.y,
                    w: 1,
                    h: 1,
                    patch: found.patch,
                    distance: found.distance,
                    color: op.color,
                };
                buildings.push(b);
                sources.push({ step: null, patch: found.patch, distance: found.distance, x: found.x, y: found.y, color: op.color });
                for (const c of portCells(BUILDING_INFO.base, found.x, found.y)) shared.occupied.add(cellKey(c.x, c.y));
                built.push({ color: op.color, ok: true, building: b, info: BUILDING_INFO.base, outSlot: 0 });
                continue;
            }
            const left = built[op.operands[0]];
            const right = built[op.operands[1]];
            if (!left || !right) return { color, ok: false };
            const info = BUILDING_INFO.mixer;
            const pos = placeNear(info, anchor);
            if (!pos) {
                missing.add(`颜色:${op.color}`);
                return { color, ok: false };
            }
            const serial = ++colorSerial;
            const b = {
                step: `color:${op.color}:mixer#${serial}`,
                stepId: `${idPrefix}color:${op.color}:mixer#${serial}`,
                kind: "mixer",
                zh: info.zh,
                x: pos.x,
                y: pos.y,
                w: info.w,
                h: info.h,
                detail: `${left.color}+${right.color}`,
                colors: [left.color, right.color],
            };
            buildings.push(b);
            for (const c of portCells(info, pos.x, pos.y)) shared.occupied.add(cellKey(c.x, c.y));
            pushColorConnection(left.building, left.info, left.outSlot, b, info, 0);
            pushColorConnection(right.building, right.info, right.outSlot, b, info, 1);
            built.push({ color: op.color, ok: true, building: b, info, outSlot: 0 });
        }
        return built.at(-1) || { color, ok: false };
    }

    const paintColorsUsed = new Set();
    for (const step of flat.steps) {
        if (step.op === "paint") paintColorsUsed.add(step.node.color);
        else if (step.op === "paint4") for (const c of step.node.colors) if (c && c !== "u") paintColorsUsed.add(c);
    }

    // rows of processors, grouped by depth; the reserved window has to be tall
    // enough for every row plus the corridor row between them
    const CORRIDOR = 2;
    const packWidth = blockWidth - CORRIDOR;
    const byDepth = new Map();
    for (const step of flat.steps) {
        if (step.op === "base") continue;
        const d = depth.get(step.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d).push(step);
    }
    let extraRows = 0;
    for (const steps of byDepth.values()) {
        let width = 0;
        // two tiles between machines: adjacent ports would share one tile
        for (const step of steps) width += (BUILDING_INFO[step.op]?.w || 1) + 2;
        extraRows += Math.max(0, Math.ceil(width / packWidth) - 1);
    }
    const lastDepth = byDepth.size ? Math.max(...byDepth.keys()) : 0;
    const neededHeight = Math.max(blockHeight, (lastDepth + extraRows) * 4 + 6);
    const hasProcessors = byDepth.size > 0;
    const block = hasProcessors ? allocateBlock(shared, blockWidth, neededHeight) : null;
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

    // 2) pack processors into rows, grouped by depth. One free row between two
    // rows and a two-tile column on the right stay empty: they are the cells a
    // belt can travel through, because every other free cell around a machine
    // is one of its own ports and must stay reserved for its own link.
    const reserveCorridor = (cy) => {
        for (let x = blockX; x < blockX + blockWidth; x++) shared.occupied.add(cellKey(x, cy + 2));
        for (let x = blockX + packWidth; x < blockX + blockWidth; x++) {
            for (let y = cy - 1; y <= cy + 2; y++) shared.occupied.add(cellKey(x, y));
        }
    };
    let reservedY = null;
    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 4;
        for (const step of steps) {
            const info = BUILDING_INFO[step.op];
            if (!info) continue;
            if (cx + info.w > blockX + packWidth) {
                cx = blockX;
                cy += 4;
            }
            if (cy !== reservedY) {
                reserveCorridor(cy);
                reservedY = cy;
            }
            let placed = false;
            for (let attempt = 0; attempt < 200 && !placed; attempt++) {
                if (fit(info, cx, cy)) {
                    placed = true;
                } else {
                    cx += info.w + 1;
                    if (cx + info.w > blockX + packWidth) {
                        cx = blockX;
                        cy += 4;
                        if (cy !== reservedY) {
                            reserveCorridor(cy);
                            reservedY = cy;
                        }
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

    // 3) queue the shape links; the router lays them after every part is placed
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
            if (!tInfo.ins[i]) return;
            queueConnection(src, sInfo, outSlot, target, tInfo, i);
        });
    }

    // 3b) the finished product still has to be belted into the hub
    const rootBuilding = buildingByStep.get(flat.final.id);
    if (rootBuilding) {
        const rInfo = BUILDING_INFO[rootBuilding.kind];
        const outSlot = outputSlot(flat.final);
        queued.push({
            srcBuilding: rootBuilding,
            srcInfo: rInfo,
            outSlot,
            dstBuilding: null,
            dstInfo: null,
            inSlot: null,
            extra: {},
            toHub: true,
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
            const chain = buildColorChain(color, { x: painter.x + info.w + 3, y: painter.y });
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
            queueConnection(source, info, slot, can, BUILDING_INFO.trash, inSlot, { waste: true });
        }
    }

    // 5) route every queued link on the tile grid. Every machine body and port
    // tile of every factory is off-limits (the world keeps them, so a later
    // factory cannot cut through an earlier one); a belt may only enter/leave
    // through the two port tiles of its own link, and crossing an existing
    // belt needs a tunnel.
    // a route may not cut through another port's approach corridor either
    const blocked = new Set([...shared.walls, ...shared.approaches]);
    const allowCross = allowTunnels !== false;
    const routingGaps = [];
    const route = (start, goal, join = false, exempt = null) =>
        routeBelt(shared, blocked, start, goal, { allowCross, goalMayJoin: join, exempt, margin: 20 }) ||
        routeBelt(shared, blocked, start, goal, { allowCross, goalMayJoin: join, exempt, margin: 60 });

    for (const q of queued) {
        const outPort = q.srcInfo.outs[q.outSlot] || q.srcInfo.outs[0];
        const x1 = q.srcBuilding.x + outPort.x;
        const y1 = q.srcBuilding.y + outPort.y;
        let goal;
        let x2;
        let y2;
        let mergeInto = false;
        if (q.toHub) {
            const approaches = hubApproaches(hub)
                .map((t) => ({ ...t, d: Math.abs(t.x - x1) + Math.abs(t.y - y1) }))
                .sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
            const free = approaches.find((t) => !shared.hubApproaches.has(cellKey(t.x, t.y)));
            const pick = free || approaches[0];
            shared.hubApproaches.add(cellKey(pick.x, pick.y));
            mergeInto = !free;
            const border = hubBorderOf(hub, pick);
            x2 = border.x + 0.5;
            y2 = border.y + 0.5;
            goal = { x: pick.x, y: pick.y };
        } else {
            const inPort = q.dstInfo.ins[q.inSlot];
            if (!inPort) continue;
            x2 = q.dstBuilding.x + inPort.x;
            y2 = q.dstBuilding.y + inPort.y;
            goal = portCells(q.dstInfo, q.dstBuilding.x, q.dstBuilding.y)[q.inSlot];
        }
        const start = portCells(q.srcInfo, q.srcBuilding.x, q.srcBuilding.y)[q.srcInfo.ins.length + q.outSlot];
        const startApproach = portApproachCells(q.srcInfo, q.srcBuilding.x, q.srcBuilding.y)[q.srcInfo.ins.length + q.outSlot];
        const goalApproach = q.toHub ? null : portApproachCells(q.dstInfo, q.dstBuilding.x, q.dstBuilding.y)[q.inSlot];
        const exempt = new Set();
        for (const cell of [start, goal, startApproach, goalApproach]) if (cell) exempt.add(cellKey(cell.x, cell.y));
        const path = start && goal ? route(start, goal, mergeInto, exempt) : null;
        const connection = {
            from: q.srcBuilding.stepId,
            to: q.toHub ? "HUB" : q.dstBuilding.stepId,
            toHub: !!q.toHub,
            merged: mergeInto,
            slot: q.toHub ? null : q.inSlot,
            fromLabel: q.srcInfo.zh,
            toLabel: q.toHub ? "枢纽" : q.dstInfo.zh,
            outSlot: q.outSlot,
            outCount: q.srcInfo.outs.length,
            x1,
            y1,
            x2,
            y2,
            length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
            ...q.extra,
        };
        if (!path) {
            routingGaps.push({
                from: connection.from,
                to: connection.to,
                fromLabel: connection.fromLabel,
                toLabel: connection.toLabel,
                start,
                goal,
            });
            connections.push({ ...connection, routed: false, path: null, tunnels: 0, tunnelCells: [], beltTiles: 0 });
            continue;
        }
        const beltTiles = path.cells.length + 2 * path.crossings.length;
        beltEstimate += beltTiles;
        connections.push({
            ...connection,
            routed: true,
            path: path.cells,
            tunnels: path.crossings.length,
            tunnelCells: path.crossings,
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
        routingGaps,
        beltEstimate,
        bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
        steps: flat.steps,
        depth,
    };
}
