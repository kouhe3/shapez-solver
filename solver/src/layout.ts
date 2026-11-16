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

/**
 * How far a part is turned, in quarter turns clockwise — the game stores the
 * same thing as `rotation` in degrees (0/90/180/270) on its static map entity
 * and rotates the part's slots with it (`StaticMapEntityComponent`).
 */
export type Rot = 0 | 1 | 2 | 3;

/** footprint of a part after `rot` quarter turns (a 2×1 part becomes 1×2) */
export function rotatedSize(info: BuildingInfo, rot: Rot): { w: number; h: number } {
    return rot % 2 === 0 ? { w: info.w, h: info.h } : { w: info.h, h: info.w };
}

/**
 * Rotate a tile-space point by `rot` quarter turns clockwise, moving it from
 * the unrotated footprint's corner into the rotated footprint's corner.
 *
 * `Vector.rotateFastMultipleOf90` rotates about the origin and gives negative
 * coordinates for a 90° turn; the game then shifts the entity's bounds by the
 * same amount (`getTileSpaceBounds`). Doing the shift here keeps every point
 * non-negative relative to the placed footprint, which is what a layout wants.
 */
function rotatePoint(x: number, y: number, w: number, h: number, rot: Rot): [number, number] {
    switch (rot) {
        case 1:
            return [h - y, x];
        case 2:
            return [w - x, h - y];
        case 3:
            return [y, w - x];
        default:
            return [x, y];
    }
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
export type BuildingKind = P.PlanOp | "mixer" | "trash" | "splitter" | "merger";

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
    occupied: Set<number>;
    /** tiles belonging to a deposit; only a miner may sit on one */
    deposits: Set<number>;
    /** windows reserved for factories so far */
    blocks: BlockRect[];
    /** machine bodies and port tiles; never carry a belt */
    walls: Set<number>;
    /** tiles a belt must run through to reach a port; never built on */
    approaches: Set<number>;
    /** tile key → the belt already laid there */
    belts: Map<number, BeltHeading>;
    /** tiles where one belt passes under another through a tunnel */
    tunnelCells: Set<number>;
    /**
     * tile key → the direction index (see `ROUTE_DIRS`) of the tunnel end
     * sitting there. A tunnel end is a surface building: no belt shares its
     * tile, but another belt may pass underneath it.
     */
    tunnelEnds: Map<number, number>;
    /**
     * tile key → bitmask of the directions of the tunnels running underneath.
     * A tunnel end placed above a run of the same direction would hijack or
     * break that run's link, so the router refuses it.
     */
    tunnelUnder: Map<number, number>;
    /** outside tiles already claimed by a belt feeding the hub */
    hubApproaches: Set<number>;
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
    /** footprint width after `rot` quarter turns */
    w: number;
    h: number;
    /** quarter turns clockwise; ports and the belt approach turn with it */
    rot: Rot;
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
    /**
     * The item goes straight into the part standing on the ejector's target
     * tile: the game's ejector hands it to any acceptor there
     * (`systems/item_ejector.js`), so the link has no belt at all.
     */
    direct?: boolean;
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
    /** real tunnels: one per straight underground run */
    tunnels: number;
    tunnelCells: Tile[];
    /** the underground runs of `path`, the single source for the drawing */
    tunnelSpans: TunnelSpan[];
    beltTiles: number;
}

/**
 * One tunnel: the belt dives underground at `sender`, runs straight under
 * `cells` and surfaces at `receiver`. Both ends are 1×1 buildings facing `dx`,
 * `dy`; in the game a tunnel may span `undergroundBeltMaxTilesByTier[0]` = 5
 * tiles (so at most 4 tiles strictly between the two ends) and the belt must
 * enter and leave along the same direction.
 */
export interface TunnelSpan {
    sender: Tile;
    receiver: Tile;
    /** underground tiles between the two ends, in flow order */
    cells: Tile[];
    dx: number;
    dy: number;
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
    /** may colour ports of one factory share a net (splitter unlocked, L20)? */
    allowColourNet?: boolean;
}

/** how the router may lay one run */
export interface RouteOptions {
    /** a belt may cross a perpendicular belt through a tunnel */
    allowCross?: boolean;
    /** extra tiles this link may enter although `blocked` lists them */
    exempt?: ReadonlySet<number> | null;
    /** the goal tile may already hold a belt: the run merges into it */
    goalMayJoin?: boolean;
    /** direction a sender sitting on the source port tile has to face */
    startDir?: readonly [number, number] | null;
    /** direction a receiver sitting on the goal port tile has to face */
    goalDir?: readonly [number, number] | null;
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
    /** the underground runs of `cells` */
    spans: TunnelSpan[];
    /** per cell: 0 = surface belt, 1..4 = underground, 5 = surfaced at the goal */
    phases: number[];
    /** per cell: index into the router's direction table */
    headings: number[];
    /** the last tile is a belt this run joins; claiming must leave it alone */
    joinsGoal: boolean;
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
    // 1×1 balancer variants (`ref/buildings/balancer.js`): the splitter takes
    // one belt in on the south edge and hands it to the north and east edges in
    // turn; the merger folds the south and east edges into one north output.
    // Both are one tile, so a chain of them packs into a corridor.
    splitter: {
        w: 1,
        h: 1,
        zh: "分流器",
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1, y: 0.5 },
        ],
    },
    merger: {
        w: 1,
        h: 1,
        zh: "合流器",
        ins: [
            { x: 0.5, y: 1 },
            { x: 1, y: 0.5 },
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

/**
 * The tile a port sits on, relative to the unrotated footprint's corner. A port
 * is defined on one edge of the part, so its tile is the one outside that edge.
 */
function portCellLocal(info: BuildingInfo, port: Port): Tile {
    if (port.y === 0) return { x: Math.floor(port.x), y: -1 };
    if (port.y === info.h) return { x: Math.floor(port.x), y: info.h };
    if (port.x === 0) return { x: -1, y: Math.floor(port.y) };
    return { x: info.w, y: Math.floor(port.y) };
}

/**
 * Turn a rotation-0 tile offset into the placed footprint's corner. The cell is
 * rotated as a whole: its centre goes through the same turn as the part, so a
 * 1×1 tile never lands on a tile boundary (`portCellLocal` only ever yields
 * integer cells with a half-tile centre).
 */
function rotateCell(local: Tile, info: BuildingInfo, rot: Rot): Tile {
    const [x, y] = rotatePoint(local.x + 0.5, local.y + 0.5, info.w, info.h, rot);
    return { x: Math.floor(x), y: Math.floor(y) };
}

/** continuous position of a port on the footprint, relative to its corner */
export function portCentre(info: BuildingInfo, port: Port, rot: Rot = 0): [number, number] {
    return rotatePoint(port.x, port.y, info.w, info.h, rot);
}

/** tiles the building's ports face — where its belts have to go */
export function portCells(info: BuildingInfo, x: number, y: number, rot: Rot = 0): Tile[] {
    const cells: Tile[] = [];
    for (const port of [...(info.ins || []), ...(info.outs || [])]) {
        const c = rotateCell(portCellLocal(info, port), info, rot);
        cells.push({ x: x + c.x, y: y + c.y });
    }
    return cells;
}

/**
 * The tile beyond each port — where the belt serving that port has to run.
 * Keeping it free is what makes a port connectable at all; a part placed there
 * would wall the port in.
 */
export function portApproachCells(info: BuildingInfo, x: number, y: number, rot: Rot = 0): Tile[] {
    const cells: Tile[] = [];
    for (const port of [...(info.ins || []), ...(info.outs || [])]) {
        const c = portCellLocal(info, port);
        // one more tile out, along the same edge
        const out = { x: c.x, y: c.y };
        if (c.y === -1) out.y = -2;
        else if (c.y === info.h) out.y = info.h + 1;
        else if (c.x === -1) out.x = -2;
        else out.x = info.w + 1;
        const r = rotateCell(out, info, rot);
        cells.push({ x: x + r.x, y: y + r.y });
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
 * Tier-0 tunnel range: `globalConfig.undergroundBeltMaxTilesByTier = [5, 9]`
 * (`vendor/shapez.io/src/js/core/config.js:91`) caps the distance between the
 * sender and the receiver at 5 tiles, so at most 4 tiles lie strictly between
 * them. The tier-2 tunnel is not modelled; 5 is the conservative bound.
 */
const MAX_UNDERGROUND = 4;

/** search phases: 0 surface, 1..MAX_UNDERGROUND underground, 5 receiver */
const PHASES = MAX_UNDERGROUND + 2;

/** Dijkstra "unvisited"; a 32-bit sentinel lets `dist` stay an Int32Array */
const ROUTE_INF = 0x7fffffff;

/**
 * Search scratch, grown monotonically and reused across calls. A full campaign
 * runs ~1.6k searches of up to 300k states; allocating and zeroing fresh
 * Int32Arrays for every one throws away gigabytes. Each attempt rewrites the
 * range it uses, so stale entries above it are never read.
 */
let SEARCH_DIST = new Int32Array(1 << 16);
let SEARCH_FROM = new Int32Array(1 << 16);

/** ring slots for the bucket queue: one search edge costs at most 6 */
const BUCKET_SLOTS = 7;

/**
 * Shortest legal belt run between two port tiles, as the game would lay it.
 *
 * Every cell has to stay off machines, the hub and other parts' ports. Running
 * into an existing belt or a tunnel end is only legal underground: the tunnel
 * crosses a belt at a right angle, and the game only hands the tunnel out at
 * L6, which the caller passes as `allowCross`. A tunnel may span at most
 * 5 tiles (tier 0, `undergroundBeltMaxTilesByTier[0]`), its two
 * ends must sit on a straight run, nothing with the same direction may sit
 * between them, and each end occupies its tile (no belt there). When no legal
 * run exists the link is reported as unroutable instead of being drawn as if
 * it worked.
 *
 * Turns cost 2 so the result reads as a few straight runs instead of a
 * staircase; crossing a belt costs 3 and a completed tunnel end another 2, so
 * the router prefers short, shallow tunnels.
 */
export function routeBelt(world: World, blocked: ReadonlySet<number>, start: Tile, goal: Tile, opts: RouteOptions = {}): RouteResult | null {
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

    // a belt path may not visit one tile twice: one tile holds one belt. The
    // cheapest run sometimes loops around a block to re-approach a tunnel end
    // from the right side; when it does, forbid that edge and search again.
    const forbidden = new Set<number>();
    let chosen: { cells: Tile[]; phases: number[]; headings: number[] } | null = null;
    for (let attempt = 0; attempt < 64 && !chosen; attempt++) {
        // state = (tile * PHASES + phase) * 4 + heading. phase 0 = surface belt,
        // 1..4 = under the ground with that many tiles already underground, 5 =
        // just surfaced at the receiver; the receiver has to go straight once.
        const totalStates = size * PHASES * 4;
        if (SEARCH_DIST.length < totalStates) {
            SEARCH_DIST = new Int32Array(totalStates);
            SEARCH_FROM = new Int32Array(totalStates);
        }
        const dist = SEARCH_DIST;
        const from = SEARCH_FROM;
        dist.fill(ROUTE_INF, 0, totalStates);
        from.fill(-1, 0, totalStates);
        // Dial's bucket queue as a ring: costs only ever rise and one edge
        // costs at most 6 (a turn plus a tunnel dive), so 7 buckets cover the
        // whole frontier and nothing has to be allocated per cost level.
        const ring: number[][] = Array.from({ length: BUCKET_SLOTS }, () => []);
        let maxCost = 0;
        const push = (state: number, cost: number): void => {
            ring[cost % BUCKET_SLOTS]!.push(state);
            if (cost > maxCost) maxCost = cost;
        };
        for (let d = 0; d < 4; d++) {
            const s = startIndex * PHASES * 4 + d;
            dist[s] = 0;
            push(s, 0);
        }
        const stateOf = (cell: number, phase: number, heading: number): number => (cell * PHASES + phase) * 4 + heading;
        const relax = (next: number, total: number, state: number): void => {
            if (total >= dist[next]!) return;
            dist[next] = total;
            from[next] = state;
            push(next, total);
        };

        /**
         * may the belt dive at `cell` (arrived with `heading`) facing `d`? A
         * sender on the source port has to face the machine's eject side; a
         * tunnel of the same direction already running underneath would
         * hijack (or break) its link.
         */
        const senderOk = (d: number, cell: number, heading: number, curKey: number): boolean => {
            const dir = ROUTE_DIRS[d]!;
            if (cell === startIndex) {
                const sd = opts.startDir;
                if (!sd || sd[0] !== dir[0] || sd[1] !== dir[1]) return false;
            } else if (d !== heading) {
                return false;
            }
            return (((world.tunnelUnder.get(curKey) || 0) >>> d) & 1) === 0;
        };

        let best = -1;
        search: for (let cost = 0; cost <= maxCost; cost++) {
            const bucket = ring[cost % BUCKET_SLOTS]!;
            while (bucket.length) {
                const state = bucket.pop();
                if (state === undefined) continue;
                if (dist[state] !== cost) continue;
                const cell = (state / (PHASES * 4)) | 0;
                const rest = state % (PHASES * 4);
                const phase = rest >> 2;
                const heading = rest & 3;
                if (cell === goalIndex) {
                    best = state;
                    break search;
                }
                const cx = (cell % width) + minX;
                const cy = ((cell / width) | 0) + minY;
                const curKey = cellKey(cx, cy);
                // a belt cannot step back onto the tile it just left: the two belts
                // would share one tile, which the game does not allow
                const prevCell = from[state]! >= 0 ? (from[state]! / (PHASES * 4)) | 0 : -1;

                if (phase === 0) {
                    for (let d = 0; d < 4; d++) {
                        if (forbidden.has(state * 4 + d)) continue;
                        const dir = ROUTE_DIRS[d]!;
                        const nx = cx + dir[0]!;
                        const ny = cy + dir[1]!;
                        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
                        const nk = cellKey(nx, ny);
                        if (indexOf(nx, ny) === prevCell) continue;
                        const isStart = nx === start.x && ny === start.y;
                        const isGoal = nx === goal.x && ny === goal.y;
                        if (!isStart && !isGoal && !(opts.exempt && opts.exempt.has(nk)) && blocked.has(nk)) continue;
                        const step = 1 + (d === heading ? 0 : 2);
                        const belt = world.belts.get(nk);
                        if (belt !== undefined) {
                            if (isGoal) {
                                // merging into the belt already entering the hub
                                if (opts.goalMayJoin) relax(stateOf(indexOf(nx, ny), 0, d), cost + step, state);
                                continue;
                            }
                            // the tunnel runs under a perpendicular belt, never along one
                            if (!opts.allowCross || belt !== (d < 2 ? "v" : "h")) continue;
                            if (world.tunnelCells.has(nk) || !senderOk(d, cell, heading, curKey)) continue;
                            relax(stateOf(indexOf(nx, ny), 1, d), cost + step + 3, state);
                            continue;
                        }
                        const endDir = world.tunnelEnds.get(nk);
                        if (endDir !== undefined) {
                            // the goal has to end on a belt or bare ground; a tunnel
                            // end is a building, so the run cannot finish there
                            if (isGoal) continue;
                            // an existing tunnel end is a building: pass under it only
                            if (!opts.allowCross || endDir === d || !senderOk(d, cell, heading, curKey)) continue;
                            relax(stateOf(indexOf(nx, ny), 1, d), cost + step + 3, state);
                            continue;
                        }
                        relax(stateOf(indexOf(nx, ny), 0, d), cost + step, state);
                    }
                    continue;
                }

                if (phase <= MAX_UNDERGROUND) {
                    // underground: straight on only
                    const d = heading;
                    if (forbidden.has(state * 4 + d)) continue;
                    const dir = ROUTE_DIRS[d]!;
                    const nx = cx + dir[0]!;
                    const ny = cy + dir[1]!;
                    if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
                    const nk = cellKey(nx, ny);
                    if (indexOf(nx, ny) === prevCell) continue;
                    const isStart = nx === start.x && ny === start.y;
                    const isGoal = nx === goal.x && ny === goal.y;
                    if (!isStart && !isGoal && !(opts.exempt && opts.exempt.has(nk)) && blocked.has(nk)) continue;
                    const nextPhase = phase + 1;
                    const belt = world.belts.get(nk);
                    const endDir = world.tunnelEnds.get(nk);
                    if (isGoal) {
                        // the run may surface on the goal port tile, but the receiver
                        // then has to eject straight into the machine
                        if (belt !== undefined || endDir !== undefined) continue;
                        const gd = opts.goalDir;
                        if (!gd || gd[0] !== dir[0] || gd[1] !== dir[1]) continue;
                        if ((((world.tunnelUnder.get(nk) || 0) >>> d) & 1) !== 0) continue;
                        relax(stateOf(indexOf(nx, ny), 5, d), cost + 1, state);
                        continue;
                    }
                    if (belt !== undefined) {
                        if (!opts.allowCross || belt !== (d < 2 ? "v" : "h")) continue;
                        if (world.tunnelCells.has(nk)) continue;
                        if (nextPhase > MAX_UNDERGROUND) continue;
                        relax(stateOf(indexOf(nx, ny), nextPhase, d), cost + 4, state);
                        continue;
                    }
                    if (endDir !== undefined) {
                        if (!opts.allowCross || endDir === d) continue;
                        if (nextPhase > MAX_UNDERGROUND) continue;
                        relax(stateOf(indexOf(nx, ny), nextPhase, d), cost + 4, state);
                        continue;
                    }
                    // free ground: the run may surface here or stay underground
                    if ((((world.tunnelUnder.get(nk) || 0) >>> d) & 1) === 0) {
                        relax(stateOf(indexOf(nx, ny), 5, d), cost + 1, state);
                    }
                    if (nextPhase <= MAX_UNDERGROUND) {
                        relax(stateOf(indexOf(nx, ny), nextPhase, d), cost + 1, state);
                    }
                    continue;
                }

                // receiver: one forced straight step onto a surface tile
                const d = heading;
                if (forbidden.has(state * 4 + d)) continue;
                const dir = ROUTE_DIRS[d]!;
                const nx = cx + dir[0]!;
                const ny = cy + dir[1]!;
                if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
                const nk = cellKey(nx, ny);
                if (indexOf(nx, ny) === prevCell) continue;
                const isStart = nx === start.x && ny === start.y;
                const isGoal = nx === goal.x && ny === goal.y;
                if (!isStart && !isGoal && !(opts.exempt && opts.exempt.has(nk)) && blocked.has(nk)) continue;
                const belt = world.belts.get(nk);
                if (belt !== undefined) {
                    if (isGoal && opts.goalMayJoin) relax(stateOf(indexOf(nx, ny), 0, d), cost + 1, state);
                    continue;
                }
                if (world.tunnelEnds.has(nk)) continue;
                relax(stateOf(indexOf(nx, ny), 0, d), cost + 1, state);
            }
        }
        if (best < 0) return null;

        const states: number[] = [];
        for (let state = best; state >= 0; state = from[state]!) states.push(state);
        states.reverse();
        const cells: Tile[] = states.map((state) => {
            const cell = Math.floor(state / (PHASES * 4));
            return { x: (cell % width) + minX, y: Math.floor(cell / width) + minY };
        });
        const phases = states.map((state) => (state % (PHASES * 4)) >> 2);
        const headings = states.map((state) => state & 3);
        const seen = new Set<number>();
        let cut = -1;
        for (let i = 0; i < states.length; i++) {
            const tile = Math.floor(states[i]! / (PHASES * 4));
            if (seen.has(tile)) {
                cut = i;
                break;
            }
            seen.add(tile);
        }
        if (cut < 0) {
            chosen = { cells, phases, headings };
            break;
        }
        forbidden.add(states[cut - 1]! * 4 + headings[cut]!);
    }
    if (!chosen) return null;
    const { cells, phases, headings } = chosen;

    const spans: TunnelSpan[] = [];
    const crossings: Tile[] = [];
    for (let i = 0; i < cells.length; i++) {
        if (phases[i]! < 1 || phases[i]! > MAX_UNDERGROUND) continue;
        let end = i;
        while (end + 1 < cells.length && phases[end + 1]! >= 1 && phases[end + 1]! <= MAX_UNDERGROUND) end++;
        const dir = ROUTE_DIRS[headings[i]!]!;
        spans.push({ sender: cells[i - 1]!, receiver: cells[end + 1]!, cells: cells.slice(i, end + 1), dx: dir[0]!, dy: dir[1]! });
        for (let k = i; k <= end; k++) {
            const c = cells[k]!;
            if (world.belts.has(cellKey(c.x, c.y))) crossings.push(c);
        }
        i = end;
    }
    const run: RouteResult = { cells, crossings, spans, phases, headings, joinsGoal: opts.goalMayJoin === true };
    if (!opts.dryRun) claimRoute(world, run);
    return run;
}

/**
 * Write a searched run into the world: both tunnel ends become buildings (no
 * belt, but passable underground), the underground tiles remember the direction
 * running beneath them, and every surface tile gets its belt.
 *
 * A plan is committed through here rather than by searching again, so the belt
 * a caller tested against the map is exactly the belt it gets.
 */
export function claimRoute(world: World, run: RouteResult): void {
    const ends = new Set<number>();
    for (const span of run.spans) {
        const d = ROUTE_DIRS.findIndex((dir) => dir[0] === span.dx && dir[1] === span.dy);
        for (const c of span.cells) {
            const key = cellKey(c.x, c.y);
            world.tunnelUnder.set(key, (world.tunnelUnder.get(key) || 0) | (1 << d));
            if (world.belts.has(key)) world.tunnelCells.add(key);
        }
        for (const end of [span.sender, span.receiver]) {
            const key = cellKey(end.x, end.y);
            world.tunnelEnds.set(key, d);
            world.occupied.add(key);
            ends.add(key);
        }
    }
    const { cells, phases } = run;
    for (let i = 0; i < cells.length; i++) {
        if (phases[i] !== 0) continue;
        const { x, y } = cells[i]!;
        const key = cellKey(x, y);
        if (ends.has(key)) continue;
        // a merge run joins a belt that already enters the hub; that tile is not ours
        if (run.joinsGoal && i === cells.length - 1) continue;
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
 * The entry tiles a belt can stand on to feed the hub: four per side, 16
 * total. A corner hub tile has one on each of its two outward sides. Two
 * belts cannot share one entry tile, so a campaign with more inbound belts
 * than that needs a merger.
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

/**
 * Packed tile key: `(x + 4096) * 8192 + (y + 4096)`.
 *
 * Numeric keys make the router's per-neighbour `Map`/`Set` lookups ~16× faster
 * than `"x|y"` strings (`bun run bench:key`, JSC). ±4096 tiles is far
 * outside any coordinate this tool reaches (map scan radius ≤ 32, campaign
 * blocks within a few hundred tiles). Exported so tests and the tunnel census
 * can address `World` containers directly.
 */
export function cellKey(x: number, y: number): number {
    return (x + 4096) * 8192 + (y + 4096);
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
    const occupied = new Set<number>();
    const deposits = new Set<number>();
    for (const p of patches) {
        for (const c of patchCells(p)) deposits.add(cellKey(c.x, c.y));
    }
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) occupied.add(cellKey(hub.x + dx, hub.y + dy));
    }
    // machine bodies and their port tiles never carry a belt; kept across
    // factories so a later route cannot cut through an earlier factory
    const walls = new Set<number>();
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
        approaches: new Set<number>(),
        /** tile → "h" | "v" | "turn": the belt already laid there */
        belts: new Map<number, BeltHeading>(),
        /** tiles where one belt passes under another through a tunnel */
        tunnelCells: new Set<number>(),
        /** tile → direction index of the tunnel end building sitting there */
        tunnelEnds: new Map<number, number>(),
        /** tile → bitmask of tunnel directions running underneath */
        tunnelUnder: new Map<number, number>(),
        /** outside tiles already claimed by a belt feeding the hub */
        hubApproaches: new Set<number>(),
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
    /** every tile the miner took: body, ejector port, approach */
    cells: number[];
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
                (c) =>
                    world.walls.has(cellKey(c.x, c.y)) ||
                    world.belts.has(cellKey(c.x, c.y)) ||
                    world.tunnelEnds.has(cellKey(c.x, c.y)) ||
                    world.approaches.has(cellKey(c.x, c.y))
            );
            if (blocked) continue;
            const cells = [cellKey(cell.x, cell.y)];
            world.occupied.add(cells[0]!);
            world.walls.add(cells[0]!);
            for (const c of portCells(BUILDING_INFO.base, cell.x, cell.y)) {
                const key = cellKey(c.x, c.y);
                world.walls.add(key);
                cells.push(key);
            }
            for (const c of portApproachCells(BUILDING_INFO.base, cell.x, cell.y)) {
                const key = cellKey(c.x, c.y);
                world.approaches.add(key);
                world.occupied.add(key);
                cells.push(key);
            }
            return { patch, distance, x: cell.x, y: cell.y, cells };
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

/** empty tiles between two factory windows: the lane a long belt travels in */
const BLOCK_GAP = 4;

/**
 * Block origin for one factory: the nearest window around the hub that no
 * deposit or existing building sits in, else the emptiest window seen. Windows
 * may overlap each other — only the buildings packed into them have to be
 * disjoint — so the grid is fine grained and ordered by distance.
 */
function allocateBlock(world: World, width: number, height: number): BlockRect | null {
    const { hub } = world;
    // tile the map with one window per factory plus a lane between neighbours,
    // so a long belt can pass between two factories instead of through one
    const stepX = width + BLOCK_GAP;
    const stepY = height + BLOCK_GAP;
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
    /** first base miner of the chain: where the next chain of the group grows */
    anchor?: Tile;
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
    allowColourNet = false,
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

    /** tiles one placement took, so a rejected candidate can be undone */
    interface Claim {
        cells: number[];
    }

    /**
     * What the router may not cross: every machine body, port and belt approach
     * on this map, earlier factories included. A part is tried in several spots
     * and turns while it is being placed, so the set follows `shared` instead of
     * being rebuilt for every search.
     */
    const blocked = new Set<number>([...shared.walls, ...shared.approaches]);
    const allowCross = allowTunnels !== false;

    /** can `info` stand at (x, y) turned `rot`? Reserves nothing. */
    function fits(info: BuildingInfo, x: number, y: number, rot: Rot): boolean {
        const size = rotatedSize(info, rot);
        for (let dx = 0; dx < size.w; dx++) {
            for (let dy = 0; dy < size.h; dy++) {
                const key = cellKey(x + dx, y + dy);
                if (!processorFree(shared, x + dx, y + dy)) return false;
                // a body over another part's port or approach would wall it in
                if (shared.walls.has(key) || shared.approaches.has(key)) return false;
            }
        }
        // a port cannot share a tile with another part's body, port or belt,
        // and the belt beyond it needs a clear tile to run through
        for (const c of [...portCells(info, x, y, rot), ...portApproachCells(info, x, y, rot)]) {
            const key = cellKey(c.x, c.y);
            if (shared.walls.has(key) || shared.belts.has(key) || shared.tunnelEnds.has(key) || shared.approaches.has(key)) return false;
        }
        return true;
    }

    /**
     * Reserve every tile `info` needs at (x, y) turned `rot`. The caller keeps
     * the claim: `release` undoes it when the part cannot be routed there.
     */
    function reserve(info: BuildingInfo, x: number, y: number, rot: Rot): Claim {
        const cells: number[] = [];
        const size = rotatedSize(info, rot);
        for (let dx = 0; dx < size.w; dx++) {
            for (let dy = 0; dy < size.h; dy++) {
                const key = cellKey(x + dx, y + dy);
                shared.occupied.add(key);
                shared.walls.add(key);
                blocked.add(key);
                cells.push(key);
            }
        }
        for (const c of portCells(info, x, y, rot)) {
            const key = cellKey(c.x, c.y);
            shared.walls.add(key);
            blocked.add(key);
            cells.push(key);
        }
        for (const c of portApproachCells(info, x, y, rot)) {
            const key = cellKey(c.x, c.y);
            shared.approaches.add(key);
            shared.occupied.add(key);
            blocked.add(key);
            cells.push(key);
        }
        return { cells };
    }

    /** undo `reserve` — safe only while nothing else touched those tiles */
    function release(claim: Claim): void {
        for (const key of claim.cells) {
            shared.occupied.delete(key);
            shared.walls.delete(key);
            shared.approaches.delete(key);
            blocked.delete(key);
        }
    }

    const buildings: Placement[] = [];
    const sources: LayoutSource[] = [];
    const missing = new Set<string>();
    const connections: Connection[] = [];
    const routingGaps: RoutingGap[] = [];
    let beltEstimate = 0;
    /** colour chains are per consumer port, so their ids need to stay unique */
    let colorSerial = 0;

    /**
     * First free spot for `info` around an anchor tile, nearest ring first.
     * Only the colour chains use this; a mixer gains nothing from a turn, so
     * `rot` defaults to the part as the game defines it.
     */
    function placeNear(info: BuildingInfo, anchor: Tile, rot: Rot = 0): Tile | null {
        // anchors are often a building centre (half tiles); every part must sit
        // on whole tiles or its ports land between two grid cells
        const ax = Math.floor(anchor.x);
        const ay = Math.floor(anchor.y);
        for (let r = 0; r < 48; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    if (!fits(info, ax + dx, ay + dy, rot)) continue;
                    reserve(info, ax + dx, ay + dy, rot);
                    return { x: ax + dx, y: ay + dy };
                }
            }
        }
        return null;
    }

    /** one link resolved against the map, before anything is claimed */
    interface LinkPlan {
        draft: ConnectionDraft;
        start: Tile;
        goal: Tile;
        /** the outside tile this link claims at the hub, when it goes there */
        hubTile: Tile | null;
        /** the searched run: `null` when no legal one exists */
        path: RouteResult | null;
    }

    /**
     * A dry search. The short box covers any link inside one factory; a wide box
     * is only worth its cost for the long hub runs, and two of them per failed
     * candidate is what makes a big campaign crawl.
     */
    const searchRoute = (
        start: Tile,
        goal: Tile,
        join: boolean,
        exempt: ReadonlySet<number> | null,
        startDir: readonly [number, number] | null,
        goalDir: readonly [number, number] | null,
        wide: boolean
    ): RouteResult | null => {
        // a short link inside one factory only needs a small box: searching ±20
        // tiles around it costs 7× more and finds the same run
        const span = Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y);
        const near = routeBelt(shared, blocked, start, goal, {
            allowCross,
            goalMayJoin: join,
            exempt,
            startDir,
            goalDir,
            margin: Math.max(8, Math.min(20, span)),
            dryRun: true,
        });
        if (near || !wide) return near;
        return routeBelt(shared, blocked, start, goal, {
            allowCross,
            goalMayJoin: join,
            exempt,
            startDir,
            goalDir,
            margin: 60,
            dryRun: true,
        });
    };

    /**
     * Resolve a link — the ports turn with their parts, the hub face is picked —
     * and ask the router whether a legal run exists, without claiming a tile.
     * A hub run walks down the faces from nearest to farthest: the closest one
     * is often boxed in by belts of the factories placed before this one.
     */
    function planLink(q: QueuedLink): LinkPlan | null {
        const src = q.srcBuilding;
        const sInfo = q.srcInfo;
        const outPort = sInfo.outs[q.outSlot] || sInfo.outs[0];
        if (!outPort) return null;
        const [ox, oy] = portCentre(sInfo, outPort, src.rot);
        const x1 = src.x + ox;
        const y1 = src.y + oy;
        const sCells = portCells(sInfo, src.x, src.y, src.rot);
        const sApproach = portApproachCells(sInfo, src.x, src.y, src.rot);
        const start = sCells[sInfo.ins.length + q.outSlot];
        if (!start) return null;
        const startApproach = sApproach[sInfo.ins.length + q.outSlot] || null;

        // a part standing on the ejector's target tile takes the item directly,
        // so there is no run to search and nothing to lay
        if (q.extra.direct && !q.toHub) {
            const dst = q.dstBuilding;
            const dInfo = q.dstInfo;
            const inPort = dInfo.ins[q.inSlot];
            if (!inPort) return null;
            const [ix, iy] = portCentre(dInfo, inPort, dst.rot);
            const x2 = dst.x + ix;
            const y2 = dst.y + iy;
            const draft: ConnectionDraft = {
                from: src.stepId,
                to: dst.stepId,
                toHub: false,
                merged: false,
                slot: q.inSlot,
                fromLabel: sInfo.zh,
                toLabel: dInfo.zh,
                outSlot: q.outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
                ...q.extra,
            };
            return {
                draft,
                start,
                goal: start,
                hubTile: null,
                path: { cells: [], crossings: [], spans: [], phases: [], headings: [], joinsGoal: false },
            };
        }

        /** finish one candidate end: exempt its ports, search, build the draft */
        const finish = (
            goal: Tile,
            x2: number,
            y2: number,
            to: string,
            toLabel: string,
            slot: number | null,
            mergeInto: boolean,
            hubTile: Tile | null,
            goalApproach: Tile | null
        ): LinkPlan => {
            const exempt = new Set<number>();
            for (const cell of [start, goal, startApproach, goalApproach, hubTile]) {
                if (cell) exempt.add(cellKey(cell.x, cell.y));
            }
            // a sender / receiver on the port tile itself only works when it
            // faces straight out of / into the machine
            const startDir = startApproach
                ? ([Math.sign(startApproach.x - start.x), Math.sign(startApproach.y - start.y)] as const)
                : null;
            const goalDir = goalApproach ? ([Math.sign(goal.x - goalApproach.x), Math.sign(goal.y - goalApproach.y)] as const) : null;
            const path = searchRoute(
                start,
                goal,
                mergeInto,
                exempt,
                startDir,
                goalDir,
                Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y) > 24
            );
            const draft: ConnectionDraft = {
                from: src.stepId,
                to,
                toHub: !!q.toHub,
                merged: mergeInto,
                slot,
                fromLabel: sInfo.zh,
                toLabel,
                outSlot: q.outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
                ...q.extra,
            };
            return { draft, start, goal, hubTile, path };
        };

        if (q.toHub) {
            const faces = hubApproaches(hub)
                .map((t) => ({ ...t, d: Math.abs(t.x - x1) + Math.abs(t.y - y1) }))
                .sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
            // a face another factory claimed is taken, and one a belt already runs
            // over can no longer end a run; merging may join a belt instead.
            // Only the nearest few faces are worth a search each: on a crowded
            // hub every extra face costs a full Dijkstra and rarely helps.
            const candidates: { tile: Tile; join: boolean }[] = [];
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (!shared.hubApproaches.has(key) && !shared.belts.has(key) && candidates.length < 6) {
                    candidates.push({ tile: t, join: false });
                }
            }
            let merges = 0;
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (shared.hubApproaches.has(key) && shared.belts.has(key) && merges++ < 3) {
                    candidates.push({ tile: t, join: true });
                }
            }
            if (!candidates.length) for (const t of faces) candidates.push({ tile: t, join: false });
            let first: LinkPlan | null = null;
            for (const { tile, join } of candidates) {
                const border = hubBorderOf(hub, tile);
                const plan = finish(
                    { x: tile.x, y: tile.y },
                    border.x + 0.5,
                    border.y + 0.5,
                    "HUB",
                    "中心",
                    null,
                    join,
                    { x: tile.x, y: tile.y },
                    null
                );
                if (plan.path) return plan;
                if (!first) first = plan;
            }
            return first;
        }

        const dst = q.dstBuilding;
        const dInfo = q.dstInfo;
        const inPort = dInfo.ins[q.inSlot];
        if (!inPort) return null;
        const [ix, iy] = portCentre(dInfo, inPort, dst.rot);
        const goal = portCells(dInfo, dst.x, dst.y, dst.rot)[q.inSlot]!;
        const goalApproach = portApproachCells(dInfo, dst.x, dst.y, dst.rot)[q.inSlot] || null;
        return finish(goal, dst.x + ix, dst.y + iy, dst.stepId, dInfo.zh, q.inSlot, false, null, goalApproach);
    }

    /**
     * Lay a planned run. An unroutable link is reported as a gap instead of
     * being drawn as if a belt could carry items there — a stub end blocks the
     * machine that feeds it.
     */
    function commitLink(plan: LinkPlan): boolean {
        if (plan.hubTile) shared.hubApproaches.add(cellKey(plan.hubTile.x, plan.hubTile.y));
        const path = plan.path;
        if (!path) {
            routingGaps.push({
                from: plan.draft.from,
                to: plan.draft.to,
                fromLabel: plan.draft.fromLabel,
                toLabel: plan.draft.toLabel,
                start: plan.start,
                goal: plan.goal,
            });
            connections.push({ ...plan.draft, routed: false, path: null, tunnels: 0, tunnelCells: [], tunnelSpans: [], beltTiles: 0 });
            return false;
        }
        // the run was searched on this very world a moment ago: write it as tested
        claimRoute(shared, path);
        // every path tile is a belt or a tunnel end; the underground tiles are
        // neither, and the two ends of each tunnel are counted once each
        const underground = path.spans.reduce((n, span) => n + span.cells.length, 0);
        const beltTiles = path.cells.length - underground;
        beltEstimate += beltTiles;
        connections.push({
            ...plan.draft,
            routed: true,
            path: path.cells,
            tunnels: path.spans.length,
            tunnelCells: path.crossings,
            tunnelSpans: path.spans,
            beltTiles,
        });
        return true;
    }

    /** a belt between two placed parts; `extra` marks colour / waste runs */
    function shapeLink(
        src: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dst: Placement,
        dstInfo: BuildingInfo,
        inSlot: number,
        extra: ConnectionExtra = {}
    ): QueuedLink {
        return { srcBuilding: src, srcInfo, outSlot, dstBuilding: dst, dstInfo, inSlot, extra };
    }

    /** the product of the plan's root, belted into the hub */
    function hubLinkOf(src: Placement): QueuedLink {
        return {
            toHub: true,
            srcBuilding: src,
            srcInfo: BUILDING_INFO[src.kind],
            outSlot: outputSlot(stepById.get(src.step)),
            dstBuilding: null,
            dstInfo: null,
            inSlot: null,
            extra: {},
        };
    }

    /** plan a link and lay it; `false` when no legal run exists */
    function layLink(q: QueuedLink): boolean {
        const plan = planLink(q);
        return plan ? commitLink(plan) : false;
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
                    rot: 0,
                    patch: found.patch,
                    distance: found.distance,
                    color: op.color,
                };
                buildings.push(b);
                sources.push({ step: null, patch: found.patch, distance: found.distance, x: found.x, y: found.y, color: op.color });
                for (const key of found.cells) blocked.add(key);
                built.push({
                    color: op.color,
                    ok: true,
                    building: b,
                    info: BUILDING_INFO.base,
                    outSlot: 0,
                    anchor: { x: found.x, y: found.y },
                });
                continue;
            }
            const left = built[op.operands[0]!];
            const right = built[op.operands[1]!];
            if (!left || !right) return { color, ok: false };
            const info = BUILDING_INFO.mixer;
            // the mixer sits between its two operand miners, not beside the
            // painter it feeds: anchoring it at the consumer made both operand
            // belts cross the map (30 of the 67 colour gaps were miner→mixer)
            // and crowded the factory; the midpoint shortens the tree and the
            // long final run is a single belt per colour port
            const pos = placeNear(
                info,
                {
                    x: Math.round((left.building.x + right.building.x) / 2),
                    y: Math.round((left.building.y + right.building.y) / 2),
                },
                0
            );
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
                rot: 0,
                detail: `${left.color}+${right.color}`,
                colors: [left.color, right.color],
            };
            buildings.push(b);
            layLink(shapeLink(left.building, left.info, left.outSlot, b, info, 0, { color: true }));
            layLink(shapeLink(right.building, right.info, right.outSlot, b, info, 1, { color: true }));
            built.push({ color: op.color, ok: true, building: b, info, outSlot: 0, anchor: left.anchor });
        }
        return built.at(-1) || { color, ok: false };
    }

    /**
     * One colour net for several ports of the same factory.
     *
     * A chain delivers 0.4 items/s, exactly one port's demand, so the group
     * still grows one chain per port. The chains are grown at the *same*
     * production point (the first one's output), merged pairwise into one
     * trunk, and split back into one belt per port inside the block. That is
     * where the belts are saved: k long runs become one long trunk plus short
     * merge/split links.
     */
    function buildSharedColorNet(
        color: ColorChar,
        ports: { painter: Placement; info: BuildingInfo; slot: number }[],
        anchor: Tile
    ): void {
        const first = buildColorChain(color, anchor);
        if (!first || !first.ok) {
            missing.add(`颜色:${color}`);
            return;
        }
        const chains: BuiltColorChain[] = [first];
        const production = first.anchor ?? { x: first.building.x, y: first.building.y };
        for (let i = 1; i < ports.length; i++) {
            const chain = buildColorChain(color, production);
            if (!chain || !chain.ok) {
                missing.add(`颜色:${color}`);
                return;
            }
            chains.push(chain);
        }

        // pairwise merge, nearest the production cluster
        let level: BuiltColorChain[] = chains;
        while (level.length > 1) {
            const next: BuiltColorChain[] = [];
            for (let i = 0; i < level.length; i += 2) {
                const a = level[i]!;
                const b = level[i + 1];
                if (!b) {
                    next.push(a);
                    continue;
                }
                const info = BUILDING_INFO.merger;
                const spot = placeNear(
                    info,
                    { x: Math.round((a.building.x + b.building.x) / 2), y: Math.round((a.building.y + b.building.y) / 2) },
                    0
                );
                if (!spot) return;
                const merger: Placement = {
                    step: `merger:${color}#${++colorSerial}`,
                    stepId: `${idPrefix}merger:${color}#${colorSerial}`,
                    kind: "merger",
                    zh: info.zh,
                    x: spot.x,
                    y: spot.y,
                    w: 1,
                    h: 1,
                    rot: 0,
                };
                buildings.push(merger);
                if (!layLink(shapeLink(a.building, a.info, a.outSlot, merger, info, 0, { color: true }))) return;
                if (!layLink(shapeLink(b.building, b.info, b.outSlot, merger, info, 1, { color: true }))) return;
                next.push({ ok: true, color, building: merger, info, outSlot: 0 });
            }
            level = next;
        }

        // one splitter per extra port: out0 feeds a port, out1 passes the trunk on
        let prev = level[0]!;
        for (let i = 0; i < ports.length - 1; i++) {
            const port = ports[i]!;
            const info = BUILDING_INFO.splitter;
            // sit two tiles outside the port and face the outlet at it, so the
            // last run is a two-tile belt instead of a lap around the block
            const cells = portCells(port.info, port.painter.x, port.painter.y, port.painter.rot);
            const approaches = portApproachCells(port.info, port.painter.x, port.painter.y, port.painter.rot);
            const portCell = cells[port.slot]!;
            const approach = approaches[port.slot]!;
            const out = { x: Math.sign(approach.x - portCell.x), y: Math.sign(approach.y - portCell.y) };
            const anchor = { x: approach.x + out.x, y: approach.y + out.y };
            // out0 has to point back at the port: north/south/east/west = 0/2/3/1
            const rot: Rot = out.y === 1 ? 0 : out.y === -1 ? 2 : out.x === 1 ? 3 : 1;
            const spot = placeNear(info, anchor, rot);
            if (!spot) return;
            const splitter: Placement = {
                step: `splitter:${color}#${++colorSerial}`,
                stepId: `${idPrefix}splitter:${color}#${colorSerial}`,
                kind: "splitter",
                zh: info.zh,
                x: spot.x,
                y: spot.y,
                w: 1,
                h: 1,
                rot,
            };
            buildings.push(splitter);
            if (!layLink(shapeLink(prev.building, prev.info, prev.outSlot, splitter, info, 0, { color: true }))) return;
            layLink(shapeLink(splitter, info, 0, port.painter, port.info, port.slot, { color: true }));
            prev = { ok: true, color, building: splitter, info, outSlot: 1 };
        }
        const last = ports.at(-1)!;
        layLink(shapeLink(prev.building, prev.info, prev.outSlot, last.painter, last.info, last.slot, { color: true }));
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

    /** placed parts, by plan step id; links resolve their two ends through it */
    const buildingByStep = new Map<string, Placement>();

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
        const miner: Placement = {
            step: step.id,
            stepId: idPrefix + step.id,
            kind: "base",
            zh: "采矿机",
            x: found.x,
            y: found.y,
            w: 1,
            h: 1,
            rot: 0,
            patch: found.patch,
            distance: found.distance,
        };
        buildings.push(miner);
        buildingByStep.set(step.id, miner);
        // the extractor reserved straight into the world; the router has to see it
        for (const key of found.cells) blocked.add(key);
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
    /** the game turns a part by 90° at a time; 0 is the orientation it ships in */
    const ROTATIONS: readonly Rot[] = [0, 1, 2, 3];
    /**
     * Spots tried per part before it is dropped at the first spot that fits.
     * Each try is a full route search per input, so this is a search budget:
     * the first spot almost always routes, and a part that needs a turn finds
     * one within a row or two.
     */
    const MAX_TRIES = 4;
    let reservedY: number | null = null;
    /**
     * the root's belt into the hub was already attempted with its placement —
     * attempted, not necessarily routed: a failed attempt is committed as a
     * gap, and laying it a second time would report the same gap twice
     */
    let rootPlanned = false;

    /** every link a step's inputs need, against the placement being tried */
    function inputLinks(step: P.PlanStep, placement: Placement, info: BuildingInfo): QueuedLink[] {
        const links: QueuedLink[] = [];
        step.inputs.forEach((input, i) => {
            const src = buildingByStep.get(input.id);
            if (!src || !info.ins[i]) return;
            links.push(shapeLink(src, BUILDING_INFO[src.kind], outputSlot(stepById.get(input.id)), placement, info, i));
        });
        return links;
    }

    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 4;
        for (const step of steps) {
            const info = BUILDING_INFO[step.op];
            if (!info) continue;
            const node = step.node;
            const detail = node.op === "paint4" ? node.colors.map((c) => c || "-").join("/") : step.detail;
            const colors =
                node.op === "paint4"
                    ? node.colors.map((c) => (c && c !== "u" ? c : null))
                    : node.op === "paint"
                    ? [node.color]
                    : undefined;
            /** the root also has to reach the hub, so its belt joins the choice */
            const root = step.id === flat.final.id;
            const make = (x: number, y: number, rot: Rot): Placement => {
                const size = rotatedSize(info, rot);
                return {
                    step: step.id,
                    stepId: idPrefix + step.id,
                    kind: step.op,
                    zh: info.zh,
                    x,
                    y,
                    w: size.w,
                    h: size.h,
                    rot,
                    detail,
                    colors,
                };
            };

            let chosen: Placement | null = null;
            let fallback: Placement | null = null;
            let tries = 0;
            let scanning = true;
            for (let guard = 0; scanning && guard < 4096; guard++) {
                if (cy !== reservedY) {
                    reserveCorridor(cy);
                    reservedY = cy;
                }
                if (cx + info.w > blockX + packWidth) {
                    cx = blockX;
                    cy += 4;
                    continue;
                }
                for (const rot of ROTATIONS) {
                    if (cx + rotatedSize(info, rot).w > blockX + packWidth) continue;
                    if (!fits(info, cx, cy, rot)) continue;
                    if (!fallback) fallback = make(cx, cy, rot);
                    if (tries >= MAX_TRIES) {
                        scanning = false;
                        break;
                    }
                    tries += 1;
                    // stand the part there, then ask the router whether its own
                    // inputs and — for the root — the hub can all be reached
                    const placement = make(cx, cy, rot);
                    const links = inputLinks(step, placement, info);
                    const toHub = root ? hubLinkOf(placement) : null;
                    const claim = reserve(info, cx, cy, rot);
                    const plans = links.map(planLink);
                    const hubPlan = toHub ? planLink(toHub) : null;
                    const batch: (LinkPlan | null)[] = toHub ? [...plans, hubPlan] : plans;
                    // one tile holds one belt: two runs of this part may not share one
                    const taken = new Set<number>();
                    let clash = false;
                    for (const plan of batch) {
                        if (!plan?.path) continue;
                        for (const cell of plan.path.cells) {
                            const key = cellKey(cell.x, cell.y);
                            if (taken.has(key)) clash = true;
                            taken.add(key);
                        }
                    }
                    if (clash || batch.some((plan) => plan === null || plan.path === null)) {
                        release(claim);
                        continue;
                    }
                    chosen = placement;
                    scanning = false;
                    for (const plan of batch) if (plan) commitLink(plan);
                    if (toHub) rootPlanned = true;
                    break;
                }
                if (!scanning) break;
                cx += info.w + 1;
            }

            let placement = chosen;
            if (!placement && fallback) {
                // nothing routed from any spot: keep the first that fits, lay
                // what still lays, and let the rest surface as reported gaps
                placement = fallback;
                reserve(info, placement.x, placement.y, placement.rot);
                for (const q of inputLinks(step, placement, info)) layLink(q);
                if (root) {
                    layLink(hubLinkOf(placement));
                    rootPlanned = true;
                }
            }
            if (!placement) continue;
            buildings.push(placement);
            buildingByStep.set(step.id, placement);
            cx = placement.x + placement.w + 1;
        }
    }

    // 3b) a bare miner is the whole plan: the placement loop never sees the
    // root step, so its hub belt is laid here
    if (!rootPlanned) {
        const rootBuilding = buildingByStep.get(flat.final.id);
        if (rootBuilding) layLink(hubLinkOf(rootBuilding));
    }

    // 3c) colour belts. Ports of the same colour in one factory share a net: a
    // chain feeds one port (0.4/s), so the group keeps one chain per port, but
    // the chains merge into one trunk at the production end and a splitter row
    // fans it back out inside the block. Merging at the consumer end would save
    // nothing: the chains still start at their own miners, so the long belts
    // would merely end at a merger instead of a painter.
    const colourPorts = new Map<ColorChar, { painter: Placement; info: BuildingInfo; slot: number }[]>();
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op !== "paint" && node.op !== "paint4") continue;
        const painter = buildingByStep.get(step.id);
        if (!painter) continue;
        const info = BUILDING_INFO[step.op];
        const colors: readonly (ColorChar | null)[] = node.op === "paint4" ? node.colors : [node.color];
        colors.forEach((color, i) => {
            if (!color || color === "u") return;
            const list = colourPorts.get(color) ?? [];
            list.push({ painter, info, slot: i + 1 });
            colourPorts.set(color, list);
        });
    }
    for (const [color, ports] of colourPorts) {
        // a belt carries 2 items/s and one port pulls 0.4, so five ports per trunk
        for (let start = 0; start < ports.length; start += 5) {
            const chunk = ports.slice(start, start + 5);
            const head = chunk[0]!;
            const anchor = { x: head.painter.x + head.info.w + 3, y: head.painter.y };
            if (chunk.length < 3 || !allowColourNet) {
                const chain = buildColorChain(color, anchor);
                if (!chain || !chain.ok) {
                    missing.add(`颜色:${color}`);
                    continue;
                }
                layLink(shapeLink(chain.building, chain.info, chain.outSlot, head.painter, head.info, head.slot, { color: true }));
                continue;
            }
            buildSharedColorNet(color, chunk, anchor);
        }
    }

    // 3d) an output port with nowhere to go backs up and stalls the machine, so
    // every cutter slot the plan does not use gets a trash can. The ejector hands
    // the item to whatever acceptor stands on the tile in front of it
    // (`systems/item_ejector.js`), so the can goes exactly there: no belt, and no
    // way for the last link of a crowded factory to be left unroutable.
    for (const step of flat.steps) {
        const info = BUILDING_INFO[step.op];
        if (!info || !info.outs || info.outs.length < 2) continue;
        const source = buildingByStep.get(step.id);
        if (!source) continue;
        const used = outputSlot(step);
        const cells = portCells(info, source.x, source.y, source.rot);
        const approaches = portApproachCells(info, source.x, source.y, source.rot);
        for (let slot = 0; slot < info.outs.length; slot++) {
            if (slot === used) continue;
            const cell = cells[info.ins.length + slot];
            if (!cell) continue;
            const can: Placement = {
                step: `trash:${step.id}:${slot}`,
                stepId: `${idPrefix}trash:${step.id}:${slot}`,
                kind: "trash",
                zh: "垃圾桶",
                x: cell.x,
                y: cell.y,
                w: 1,
                h: 1,
                rot: 0,
            };
            buildings.push(can);
            shared.occupied.add(cellKey(cell.x, cell.y));
            shared.walls.add(cellKey(cell.x, cell.y));
            blocked.add(cellKey(cell.x, cell.y));
            // the side of the can the machine ejects into: opposite the port's
            // outward direction, so it is the side facing the body
            const approach = approaches[info.ins.length + slot];
            const outX = approach ? Math.sign(approach.x - cell.x) : 0;
            const outY = approach ? Math.sign(approach.y - cell.y) : -1;
            const inSlot = outY === -1 ? 2 : outY === 1 ? 0 : outX === -1 ? 1 : 3;
            layLink(shapeLink(source, info, slot, can, BUILDING_INFO.trash, inSlot, { waste: true, direct: true }));
        }
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
