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
import type { ColorChain } from "./color.js";
import type { ColorChar } from "./shape.js";
import type { MapItem, Patch } from "./map.js";

/* ------------------------------------------------------------------ *
 * geometry (port tables, tiles)
 * ------------------------------------------------------------------ */

/** a tile on the map grid; y grows downwards, like the game's tile space */
export interface Tile {
    x: number;
    y: number;
}

/** one connection point, in tiles relative to the building's top-left tile */
export interface Port {
    x: number;
    y: number;
    /** a paint colour enters here instead of a shape */
    kind?: "color";
}

/** geometry and ports of one game part */
export interface BuildingInfo {
    w: number;
    h: number;
    zh: string;
    ins: Port[];
    outs: Port[];
}

/** every part this solver places: a plan op, a mixer, or a trash can */
export type BuildingKind = P.PlanOp | "mixer" | "trash";

/* ------------------------------------------------------------------ *
 * the map: deposits and the shared placement state
 * ------------------------------------------------------------------ */

/** which way a laid belt runs */
export type BeltHeading = "h" | "v" | "turn";

/** a reserved factory window: its origin and size in tiles */
export interface BlockRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** placement state shared by every factory on one map */
export interface World {
    hub: Tile;
    patches: Patch[];
    /** tiles taken by a building, a port or an approach corridor */
    occupied: Set<string>;
    /** tiles belonging to a deposit; only a miner may sit on one */
    deposits: Set<string>;
    /** windows reserved for factories so far */
    blocks: BlockRect[];
    /** machine bodies and port tiles; never carry a belt */
    walls: Set<string>;
    /** tiles a belt must run through to reach a port; never built on */
    approaches: Set<string>;
    /** tile key → the belt already laid there */
    belts: Map<string, BeltHeading>;
    /** tiles where one belt passes under another through a tunnel */
    tunnelCells: Set<string>;
    /** outside tiles already claimed by a belt feeding the hub */
    hubApproaches: Set<string>;
}

/** what `createWorld` needs to know about a map */
export interface WorldInit {
    hub: Tile;
    patches: Patch[];
}

/* ------------------------------------------------------------------ *
 * what a layout reports
 * ------------------------------------------------------------------ */

/** one building placed on the map */
export interface Placement {
    /** plan step id, or a synthetic "color:…"/"trash:…" id when no step owns it */
    step: string;
    stepId: string;
    kind: BuildingKind;
    zh: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** slot/product note shown in the drawing (paint4: "r/-/b/-") */
    detail?: string;
    /** the colour of every colour input port; `null` = that port is unused */
    colors?: (ColorChar | null)[];
    /** deposit this miner sits on */
    patch?: Patch;
    distance?: number;
    /** the colour this miner or mixer produces */
    color?: ColorChar;
    /** campaign sheet: which factory this part belongs to (1-based) */
    plan?: number;
}

/** where one resource comes from */
export interface LayoutSource {
    /** the plan step this miner extracts for; `null` for a colour chain's miner */
    step: P.PlanStep | null;
    patch: Patch | null;
    distance?: number;
    /** why this source is not on the map */
    missing?: string;
    x?: number;
    y?: number;
    color?: ColorChar;
}

/** a colour the layout paints with, found as a deposit */
export interface LayoutColorDeposit {
    color: ColorChar;
    direct: true;
    patch: Patch;
    mix: null;
}

/** a colour the layout paints with, mixed from base colours */
export interface LayoutColorMix {
    color: ColorChar;
    direct: false;
    patch: null;
    /** base colours to mix; a base colour the map lacks has no recipe at all */
    mix: readonly ColorChar[] | undefined;
}

/** a colour the layout paints with, and where it comes from */
export type LayoutColor = LayoutColorDeposit | LayoutColorMix;

/** one line of the bill of materials */
export interface BomEntry {
    zh: string;
    n: number;
}

/** metadata a caller attaches to a link it queues */
export interface ConnectionExtra {
    /** this belt carries a paint colour, not a shape */
    color?: boolean;
    /** this belt vents an unused cutter slot into a trash can */
    waste?: boolean;
}

/** a link before the router ran: everything but the run itself */
export interface ConnectionDraft extends ConnectionExtra {
    /** source building id */
    from: string;
    /** destination building id, or "HUB" */
    to: string;
    toHub: boolean;
    /** the hub leg had to join a belt already entering the hub */
    merged: boolean;
    /** destination input slot; `null` for the hub leg */
    slot: number | null;
    fromLabel: string;
    toLabel: string;
    outSlot: number;
    outCount: number;
    /** port coordinates in tiles — where the belt starts and ends */
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** port-to-port Manhattan distance */
    length: number;
}

/** one belt link between two ports, or from a port into the hub */
export interface Connection extends ConnectionDraft {
    routed: boolean;
    /** the laid belt tiles, start to goal; `null` when no legal run exists */
    path: Tile[] | null;
    tunnels: number;
    tunnelCells: Tile[];
    beltTiles: number;
}

/** a link the router could not lay */
export interface RoutingGap {
    from: string;
    to: string;
    fromLabel: string;
    toLabel: string;
    /** endpoint tiles of the failed link, when both could be found */
    start?: Tile;
    goal?: Tile;
    /** campaign sheet: which factory the failed link belongs to */
    plan?: number;
}

/** one factory on a campaign sheet */
export interface PlanFrame {
    index: number;
    code: string;
    bounds: BlockRect | null;
    buildings: number;
    rate: number;
}

/** what `buildLayout` reports */
export interface Layout {
    hub: Tile;
    /** the shape this layout builds (campaign sheets) */
    tag: string | null;
    block: BlockRect | null;
    world: World;
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
    steps: P.PlanStep[];
    /** dependency depth per step id */
    depth: Map<string, number>;
    /** campaign sheets only: one entry per factory */
    plans?: PlanFrame[];
}

/** what `buildLayout` takes */
export interface BuildLayoutArgs {
    /** plan AST root */
    plan: P.PlanNode;
    /** map deposits (`map.js`) */
    patches: Patch[];
    /** hub tile origin */
    hub?: Tile;
    blockWidth?: number;
    blockHeight?: number;
    /** shared placement state; omit for a one-off layout */
    world?: World | null;
    /** namespaces step ids when several plans share a world */
    idPrefix?: string;
    /** the target this layout builds (campaign sheets) */
    tag?: string | null;
    /** may a belt cross another one (tunnel unlocked)? Before L6 every crossing is illegal */
    allowTunnels?: boolean;
}

/** how the router may lay one run */
export interface RouteOptions {
    /** a belt may cross a perpendicular belt through a tunnel */
    allowCross?: boolean;
    /** extra tiles this link may enter although `blocked` lists them */
    exempt?: ReadonlySet<string> | null;
    /** the goal tile may already hold a belt: the run merges into it */
    goalMayJoin?: boolean;
    /** plan only: do not claim the tiles */
    dryRun?: boolean;
    /** how far outside the two endpoints the router may search */
    margin?: number;
}

/** the belt run the router found */
export interface RouteResult {
    /** every tile of the run, start to goal */
    cells: Tile[];
    /** tiles where this run passes under an existing belt */
    crossings: Tile[];
}

/** items/s each colour has to produce, and how many sources that takes */
export interface ColorSupply {
    need: Map<ColorChar, number>;
    sources: Map<ColorChar, number>;
}

/* ------------------------------------------------------------------ *
 * plan trees
 * ------------------------------------------------------------------ */

/** the part of a step a tree copy has to rewrite */
export interface PlanStepLink {
    id: string;
    op: P.PlanOp;
    inputs: readonly { id: string }[];
}

/** a flattened plan seen only as ids and inputs: all a tree copy reads */
export interface PlanTreeLike {
    steps: PlanStepLink[];
    final: { id: string };
}

/** the whole of every step, inputs before their parent */
export interface PlanTree {
    steps: P.PlanStep[];
    final: P.PlanStep;
}

/**
 * Geometry of every part this solver places — port positions in tile units,
 * straight from the game's `ref/buildings/*.js`.
 *
 * The game ships 28 parts. The ones deliberately left out (balancer, tunnel,
 * storage, block, the sandbox-only producers, and the whole wire layer) and why
 * are listed in README under "零件清单".
 */
export const BUILDING_INFO: Record<BuildingKind, BuildingInfo> = {
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
export function buildingKind(step: P.PlanStep): P.PlanOp {
    return step.op; // base / rotate / cutHalf / cutQuad / stack / paint / paint4
}

/** tiles the building's ports face — where its belts have to go */
export function portCells(info: BuildingInfo, x: number, y: number): Tile[] {
    const cells: Tile[] = [];
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
export function portApproachCells(info: BuildingInfo, x: number, y: number): Tile[] {
    const cells: Tile[] = [];
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
export function outputSlot(step: P.PlanStep | null | undefined): number {
    if (!step || !step.node) return 0;
    if (step.node.op === "cutHalf") return step.node.side;
    if (step.node.op === "cutQuad") return step.node.quad;
    return 0;
}

const ROUTE_DIRS: readonly (readonly [number, number])[] = [
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
 */
export function routeBelt(world: World, blocked: ReadonlySet<string>, start: Tile, goal: Tile, opts: RouteOptions = {}): RouteResult | null {
    const margin = opts.margin ?? 20;
    const minX = Math.min(start.x, goal.x) - margin;
    const maxX = Math.max(start.x, goal.x) + margin;
    const minY = Math.min(start.y, goal.y) - margin;
    const maxY = Math.max(start.y, goal.y) + margin;
    const width = maxX - minX + 1;
    const size = width * (maxY - minY + 1);
    const indexOf = (x: number, y: number): number => (y - minY) * width + (x - minX);
    const startIndex = indexOf(start.x, start.y);
    const goalIndex = indexOf(goal.x, goal.y);

    // state = tile * 4 + heading; the heading is what makes a turn cost extra
    const dist = new Float64Array(size * 4).fill(Infinity);
    const from = new Int32Array(size * 4).fill(-1);
    const buckets: number[][] = [];
    const push = (state: number, cost: number): void => {
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
            if (state === undefined) continue;
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
                const dir = ROUTE_DIRS[d];
                if (!dir) continue;
                const nx = cx + dir[0];
                const ny = cy + dir[1];
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
                if (total < dist[next]!) {
                    dist[next] = total;
                    from[next] = state;
                    push(next, total);
                }
            }
        }
    }
    if (best < 0) return null;

    const cells: Tile[] = [];
    for (let state = best; state >= 0; state = from[state]!) {
        const cell = state >> 2;
        cells.push({ x: (cell % width) + minX, y: Math.floor(cell / width) + minY });
    }
    cells.reverse();
    if (opts.dryRun) {
        return { cells, crossings: cells.filter(({ x, y }) => world.belts.has(cellKey(x, y))) };
    }

    // claim the run: a tile that already holds a belt is a tunnel crossing
    const crossings: Tile[] = [];
    for (let i = 0; i < cells.length; i++) {
        const { x, y } = cells[i]!;
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
        let heading: BeltHeading;
        if (cells.length === 1) heading = "h";
        else if (i === 0) heading = cells[1]!.y === cells[0]!.y ? "h" : "v";
        else if (i === cells.length - 1) heading = cells[i]!.y === cells[i - 1]!.y ? "h" : "v";
        else if (cells[i - 1]!.y === cells[i + 1]!.y) heading = "h";
        else if (cells[i - 1]!.x === cells[i + 1]!.x) heading = "v";
        else heading = "turn";
        world.belts.set(key, heading);
        world.occupied.add(key);
    }
    return { cells, crossings };
}


/** approximate tiles occupied by a patch (the game draws them as overlapping circles) */
function patchCells(patch: Patch): Tile[] {
    const r = Math.max(1.5, (patch.size || 2) * 0.9 + 0.5);
    const cells: Tile[] = [];
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
 */
export function sizeColorSupply(demand: ReadonlyMap<ColorChar, number>): ColorSupply {
    const need = new Map<ColorChar, number>(demand);
    const sources = new Map<ColorChar, number>();
    const bump = (color: ColorChar, amount: number): Map<ColorChar, number> =>
        need.set(color, (need.get(color) || 0) + amount);
    const count = (amount: number): number => Math.max(0, Math.ceil(amount / SOURCE_RATE - 1e-9));

    // `w` first: it is the only colour whose chain consumes another mixed
    // colour, so its demand has to reach `y` before `y` is counted.
    for (const color of ["w", "y", "p", "c"] as const) {
        const n = count(need.get(color) || 0);
        sources.set(color, n);
        if (!n) continue;
        for (const part of color === "w" ? (["y", "b"] as const) : COLOR_NEEDS[color]!) bump(part, n * SOURCE_RATE);
    }
    for (const color of ["r", "g", "b"] as const) sources.set(color, count(need.get(color) || 0));
    return { need, sources };
}

/** the hub occupies a 4×4 tile block; belts may enter it on any side */
const HUB_SIZE = 4;

/**
 * The tiles a belt can stand on to feed the hub: one per side of every border
 * tile (16 total). Two belts cannot share one — each border tile takes one
 * belt — so a campaign with more factories than that needs a merger.
 */
function hubApproaches(hub: Tile): Tile[] {
    const out: Tile[] = [];
    for (let i = 0; i < HUB_SIZE; i++) {
        out.push({ x: hub.x + i, y: hub.y - 1 });
        out.push({ x: hub.x + i, y: hub.y + HUB_SIZE });
        out.push({ x: hub.x - 1, y: hub.y + i });
        out.push({ x: hub.x + HUB_SIZE, y: hub.y + i });
    }
    return out;
}

/** the border tile an outside approach feeds; its centre is where the belt ends */
function hubBorderOf(hub: Tile, tile: Tile): Tile {
    if (tile.y < hub.y) return { x: tile.x, y: hub.y };
    if (tile.y >= hub.y + HUB_SIZE) return { x: tile.x, y: hub.y + HUB_SIZE - 1 };
    if (tile.x < hub.x) return { x: hub.x, y: tile.y };
    return { x: hub.x + HUB_SIZE - 1, y: tile.y };
}

function cellKey(x: number, y: number): string {
    return x + "|" + y;
}

/** tiles covered by a deposit, ordered from its centre outwards */
function patchCellsByCentre(patch: Patch): (Tile & { d: number })[] {
    return patchCells(patch)
        .map((c) => ({ x: c.x, y: c.y, d: Math.hypot(c.x - patch.x, c.y - patch.y) }))
        .sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
}

/**
 * Placement state shared by every factory on one map: which tiles are taken and
 * which belong to a deposit (only a miner may sit on a deposit tile).
 */
export function createWorld({ hub, patches }: WorldInit): World {
    const occupied = new Set<string>();
    const deposits = new Set<string>();
    for (const p of patches) {
        for (const c of patchCells(p)) deposits.add(cellKey(c.x, c.y));
    }
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) occupied.add(cellKey(hub.x + dx, hub.y + dy));
    }
    // machine bodies and their port tiles never carry a belt; kept across
    // factories so a later route cannot cut through an earlier factory
    const walls = new Set<string>();
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
        approaches: new Set<string>(),
        /** tile → "h" | "v" | "turn": the belt already laid there */
        belts: new Map<string, BeltHeading>(),
        /** tiles where one belt passes under another through a tunnel */
        tunnelCells: new Set<string>(),
        /** outside tiles already claimed by a belt feeding the hub */
        hubApproaches: new Set<string>(),
    };
}

/** a processor may only sit on bare ground */
function processorFree(world: World, x: number, y: number): boolean {
    const k = cellKey(x, y);
    return !world.occupied.has(k) && !world.deposits.has(k);
}

interface ExtractorSite {
    patch: Patch;
    distance: number;
    x: number;
    y: number;
}

/**
 * A miner takes one free tile of the nearest deposit that has one — several
 * factories (and several steps of one factory) may share a deposit.
 */
function placeExtractor(world: World, predicate: (item: MapItem) => boolean, from: Tile): ExtractorSite | null {
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

function blockCollisions(world: World, x: number, y: number, width: number, height: number, limit = Infinity): number {
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
function allocateBlock(world: World, width: number, height: number): BlockRect | null {
    const { hub } = world;
    // tile the map with one window per factory plus a four-tile gap, so two
    // neighbouring factories never share a belt corridor
    const stepX = width + 4;
    const stepY = height + 4;
    const reach = 12;
    const candidates: { dx: number; dy: number; d: number }[] = [];
    for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
            if (!dx && !dy) continue;
            candidates.push({ dx, dy, d: Math.abs(dx) * stepX + Math.abs(dy) * stepY });
        }
    }
    candidates.sort((a, b) => a.d - b.d || a.dx - b.dx || a.dy - b.dy);
    let best: BlockRect | null = null;
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
 * Inputs come before their parent.
 */
export function expandPlanTree(flat: PlanTree): PlanTree;
export function expandPlanTree(flat: PlanTreeLike): PlanTreeLike;
export function expandPlanTree(flat: PlanTreeLike): PlanTreeLike {
    const byId = new Map<string, PlanStepLink>(flat.steps.map((step): [string, PlanStepLink] => [step.id, step]));
    const seen = new Map<string, number>();
    const steps: PlanStepLink[] = [];
    const visit = (id: string): PlanStepLink => {
        const src = byId.get(id)!;
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
 */
export function planBom(flat: PlanTree, chains: ColorChain[] = colorChains(flat.steps)): BomEntry[] {
    const bom = new Map<string, number>();
    const add = (zh: string, n = 1): Map<string, number> => bom.set(zh, (bom.get(zh) || 0) + n);
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

/** one colour chain grown next to its consumer */
interface BuiltColorChain {
    ok: true;
    color: ColorChar;
    building: Placement;
    info: BuildingInfo;
    outSlot: number;
}

/** a colour chain that could not be built: the map lacks a deposit */
type ColorChainOutcome = BuiltColorChain | { ok: false; color: ColorChar };

/** a link waiting for the router; every part is placed before any belt is laid */
type QueuedLink =
    | {
          toHub: true;
          srcBuilding: Placement;
          srcInfo: BuildingInfo;
          outSlot: number;
          dstBuilding: null;
          dstInfo: null;
          inSlot: null;
          extra: ConnectionExtra;
      }
    | {
          toHub?: false;
          srcBuilding: Placement;
          srcInfo: BuildingInfo;
          outSlot: number;
          dstBuilding: Placement;
          dstInfo: BuildingInfo;
          inSlot: number;
          extra: ConnectionExtra;
      };

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
}: BuildLayoutArgs): Layout {
    const shared = world || createWorld({ hub, patches });
    // one output port = one belt, so shared sub-plans get their own copy
    const flat = expandPlanTree(P.flatten(plan));
    // dependency depth
    const depth = new Map<string, number>();
    const stepById = new Map<string, P.PlanStep>(flat.steps.map((s): [string, P.PlanStep] => [s.id, s]));
    for (const step of flat.steps) {
        let d = 0;
        for (const input of step.inputs) d = Math.max(d, (depth.get(input.id) || 0) + 1);
        depth.set(step.id, d);
    }

    function fit(info: BuildingInfo, x: number, y: number): boolean {
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

    const buildings: Placement[] = [];
    const sources: LayoutSource[] = [];
    const missing = new Set<string>();
    const connections: Connection[] = [];
    let beltEstimate = 0;
    /** colour chains are per consumer port, so their ids need to stay unique */
    let colorSerial = 0;

    /** first free spot for `info` around an anchor tile, nearest ring first */
    function placeNear(info: BuildingInfo, anchor: Tile): Tile | null {
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
    const queued: QueuedLink[] = [];
    function queueConnection(
        srcBuilding: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dstBuilding: Placement,
        dstInfo: BuildingInfo,
        inSlot: number,
        extra: ConnectionExtra = {}
    ): void {
        queued.push({ srcBuilding, srcInfo, outSlot, dstBuilding, dstInfo, inSlot, extra });
    }

    /** colour feeds have no plan step: one chain head feeds one painter port */
    function pushColorConnection(
        srcBuilding: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dstBuilding: Placement,
        dstInfo: BuildingInfo,
        inSlot: number
    ): void {
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
     */
    function buildColorChain(color: ColorChar, anchor: Tile): ColorChainOutcome | null {
        if (!color || color === "u") return null;
        // the mix tree comes from color.js, so the recipe the CLI prints and
        // the buildings placed here can never drift apart
        const built: BuiltColorChain[] = [];
        for (const op of colorChain(color)) {
            if (op.kind === "base") {
                const found = placeExtractor(shared, (item) => item.kind === "color" && item.color === op.color, anchor);
                if (!found) {
                    missing.add(`颜色:${op.color}`);
                    return { color, ok: false };
                }
                const serial = ++colorSerial;
                const b: Placement = {
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
            const left = built[op.operands[0]!];
            const right = built[op.operands[1]!];
            if (!left || !right) return { color, ok: false };
            const info = BUILDING_INFO.mixer;
            const pos = placeNear(info, anchor);
            if (!pos) {
                missing.add(`颜色:${op.color}`);
                return { color, ok: false };
            }
            const serial = ++colorSerial;
            const b: Placement = {
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

    const paintColorsUsed = new Set<ColorChar>();
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op === "paint") paintColorsUsed.add(node.color);
        else if (node.op === "paint4") for (const c of node.colors) if (c && c !== "u") paintColorsUsed.add(c);
    }

    // rows of processors, grouped by depth; the reserved window has to be tall
    // enough for every row plus the corridor row between them
    const CORRIDOR = 2;
    const packWidth = blockWidth - CORRIDOR;
    const byDepth = new Map<number, P.PlanStep[]>();
    for (const step of flat.steps) {
        if (step.op === "base") continue;
        const d = depth.get(step.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d)!.push(step);
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
        const node = step.node;
        if (node.op !== "base") continue;
        const type = node.type;
        const code = node.code || `${type}u${type}u${type}u${type}u`;
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
    const reserveCorridor = (cy: number): void => {
        for (let x = blockX; x < blockX + blockWidth; x++) shared.occupied.add(cellKey(x, cy + 2));
        for (let x = blockX + packWidth; x < blockX + blockWidth; x++) {
            for (let y = cy - 1; y <= cy + 2; y++) shared.occupied.add(cellKey(x, y));
        }
    };
    let reservedY: number | null = null;
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
            const node = step.node;
            buildings.push({
                step: step.id,
                stepId: idPrefix + step.id,
                kind: step.op,
                zh: info.zh,
                x: cx,
                y: cy,
                w: info.w,
                h: info.h,
                detail: node.op === "paint4" ? node.colors.map((c) => c || "-").join("/") : step.detail,
                colors:
                    node.op === "paint4"
                        ? node.colors.map((c) => (c && c !== "u" ? c : null))
                        : node.op === "paint"
                        ? [node.color]
                        : undefined,
            });
            for (const c of portCells(info, cx, cy)) shared.occupied.add(cellKey(c.x, c.y));
            cx += info.w + 1;
        }
    }

    const buildingByStep = new Map<string, Placement>(buildings.map((b): [string, Placement] => [b.step, b]));

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
        const node = step.node;
        if (node.op !== "paint" && node.op !== "paint4") continue;
        const painter = buildingByStep.get(step.id);
        if (!painter) continue;
        const info = BUILDING_INFO[step.op];
        const colors: readonly (ColorChar | null)[] = node.op === "paint4" ? node.colors : [node.color];
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
            const port = info.outs[slot]!;
            const pos = placeNear(BUILDING_INFO.trash, {
                x: Math.floor(source.x + port.x),
                y: Math.floor(source.y + port.y),
            });
            if (!pos) {
                missing.add("垃圾桶");
                continue;
            }
            const can: Placement = {
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
    const blocked = new Set<string>([...shared.walls, ...shared.approaches]);
    const allowCross = allowTunnels !== false;
    const routingGaps: RoutingGap[] = [];
    const route = (start: Tile, goal: Tile, join = false, exempt: ReadonlySet<string> | null = null): RouteResult | null =>
        routeBelt(shared, blocked, start, goal, { allowCross, goalMayJoin: join, exempt, margin: 20 }) ||
        routeBelt(shared, blocked, start, goal, { allowCross, goalMayJoin: join, exempt, margin: 60 });

    for (const q of queued) {
        const outPort = q.srcInfo.outs[q.outSlot] || q.srcInfo.outs[0];
        if (!outPort) continue;
        const x1 = q.srcBuilding.x + outPort.x;
        const y1 = q.srcBuilding.y + outPort.y;
        let goal: Tile | undefined;
        let x2: number;
        let y2: number;
        let mergeInto = false;
        if (q.toHub) {
            const approaches = hubApproaches(hub)
                .map((t) => ({ ...t, d: Math.abs(t.x - x1) + Math.abs(t.y - y1) }))
                .sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
            const free = approaches.find((t) => !shared.hubApproaches.has(cellKey(t.x, t.y)));
            const pick = free || approaches[0]!;
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
        const exempt = new Set<string>();
        for (const cell of [start, goal, startApproach, goalApproach]) if (cell) exempt.add(cellKey(cell.x, cell.y));
        const path = start && goal ? route(start, goal, mergeInto, exempt) : null;
        const connection: ConnectionDraft = {
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
    const colorPatches = new Map<ColorChar, Patch>();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const prev = colorPatches.get(p.item.color);
        if (!prev || Math.hypot(p.x - hub.x, p.y - hub.y) < Math.hypot(prev.x - hub.x, prev.y - hub.y)) {
            colorPatches.set(p.item.color, p);
        }
    }
    const colors: LayoutColor[] = [...paintColorsUsed].map((c) => {
        const direct = colorPatches.get(c);
        if (direct) return { color: c, direct: true, patch: direct, mix: null };
        const mix = COLOR_NEEDS[c];
        return { color: c, direct: false, patch: null, mix };
    });

    const bom = new Map<string, number>();
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
