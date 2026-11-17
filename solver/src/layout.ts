/**
 * The tile world a layout is built in: the geometry and ports of every part,
 * the state every factory on one map shares, and the router that turns a pair
 * of ports into a legal run of belts and tunnels.
 *
 *  - `BUILDING_INFO` + `portCells`/`portApproachCells` give the exact tile
 *    geometry straight from the game's building definitions,
 *  - `World`/`createWorld` hold what no single factory owns on its own,
 *  - `routeBelt`/`claimRoute`/`releaseRoute` search and commit belt runs,
 *  - `expandPlanTree`/`fuseCuts`/`planBom` read a solved plan.
 *
 * Placing the parts and laying the links between them is `placement.ts` (and
 * its `spots.ts` / `placement-links.ts` / `color-supply.ts` seams), which build
 * on this module and never the other way round.
 *
 * Port coordinates are in tile units relative to the building's top-left tile;
 * y grows downwards (screen/tile space, same as the game).
 */

import * as P from "./plan.js";
import { BUILDING_NAMES } from "./catalogue.js";
import type { BuildingKind } from "./catalogue.js";
import { colorChains } from "./color.js";
import type { ColorChain } from "./color.js";
import type { ColorChar } from "./shape.js";
import type { Patch } from "./map.js";
import { routerSearch } from "./router-engine.js";
import { createRouterLog, SyncMap, SyncSet, type RouterLog } from "./router-log.js";

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
    ins: Port[];
    outs: Port[];
}

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
    /**
     * Tiles the router may not cross: every wall, approach corridor and the
     * claims of the factory currently being laid out. Rebuilt per factory;
     * the router sees it through the world's dirty-cell log.
     */
    blocked: Set<number>;
    /** dirty-cell log for the router's resident copy of this world */
    router: RouterLog;
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
    /**
     * tile key → the hub entry tile this belt feeds. Every belt of a delivery
     * leg is tagged (and so is one that merges into such a leg), which is what
     * lets a later factory find a way into the hub instead of hunting for a
     * free entry tile.
     */
    hubBound: Map<number, number>;
    /** hub entry tile key → how many delivery legs share that entry belt */
    hubEntryLoad: Map<number, number>;
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
    /** index in `Layout.connections`; the campaign offsets it when it merges */
    connection?: number;
}

/** one factory on a campaign sheet */
export interface PlanFrame {
    index: number;
    code: string;
    bounds: BlockRect | null;
    buildings: number;
    rate: number;
}

/** how the router may lay one run */
export interface RouteOptions {
    /** a belt may cross a perpendicular belt through a tunnel */
    allowCross?: boolean;
    /**
     * Cross a **turn** belt too. A turn has no straight direction, so a tunnel
     * under it never runs along it: the game accepts it. The greedy build keeps
     * the conservative rule (it changes the whole plan); the repair pass turns
     * it on to get a boxed endpoint out of a pocket.
     */
    relaxCross?: boolean;
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
    /** filled with the blocked tiles that stopped the search (rip-up blame) */
    frontier?: Set<number> | null;
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
    /**
     * the hub entry this run feeds, tagged by the caller before claiming; every
     * belt of the run then points to that entry (`World.hubBound`)
     */
    entryKey: number | null;
}

/* ------------------------------------------------------------------ *
 * plan trees
 * ------------------------------------------------------------------ */

/** the part of a step a tree copy has to rewrite */
export interface PlanStepLink {
    id: string;
    op: P.PlanOp;
    inputs: readonly { id: string }[];
    /** this step's product is another output slot of `fuseInto`'s cutter */
    fuseInto?: string;
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
        ins: [],
        outs: [{ x: 0.5, y: 0 }],
    },
    rotate: {
        w: 1,
        h: 1,
        ins: [{ x: 0.5, y: 1 }],
        outs: [{ x: 0.5, y: 0 }],
    },
    cutHalf: {
        w: 2,
        h: 1,
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
        ],
    },
    cutQuad: {
        w: 4,
        h: 1,
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
        ins: [
            { x: 0.5, y: 1 },
            { x: 1.5, y: 1 },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
    paint: {
        w: 2,
        h: 1,
        ins: [
            { x: 0, y: 0.5 },
            { x: 1.5, y: 0, kind: "color" },
        ],
        outs: [{ x: 2, y: 0.5 }],
    },
    paint4: {
        w: 4,
        h: 1,
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
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1, y: 0.5 },
        ],
    },
    merger: {
        w: 1,
        h: 1,
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

/** the run a search found, before spans/crossings are derived from it */
interface ChosenRun {
    cells: Tile[];
    phases: number[];
    headings: number[];
}

/** direction tuple → index into `ROUTE_DIRS`; negative when it has no match */
function directionIndex(dir: readonly [number, number] | null | undefined): number {
    if (!dir) return -1;
    const i = ROUTE_DIRS.findIndex((d) => d[0] === dir[0] && d[1] === dir[1]);
    return i < 0 ? -2 : i;
}

export interface RouteOutcome {
    /** null when no legal run exists */
    run: RouteResult | null;
    /**
     * Whether the search ever wanted to leave its box. On a null `run`,
     * `false` means the box's whole reachable component was exhausted: the
     * link is impossible for *any* box size while the map stands as it is, so
     * a wider retry is pure waste.
     */
    boxLimited: boolean;
}

/**
 * Shortest legal belt run between two port tiles, as the game would lay it.
 *
 * Every cell has to stay off machines, the hub and other parts' ports. Running
 * into an existing belt or a tunnel end is only legal underground: the tunnel
 * crosses a belt at a right angle (a turn belt has no direction, so the repair
 * pass may cross it too — `relaxCross`; the greedy build keeps the stricter
 * rule), and the game only hands the tunnel out at L6, which the caller passes
 * as `allowCross`. A tunnel may span at most
 * 5 tiles (tier 0, `undergroundBeltMaxTilesByTier[0]`), its two
 * ends must sit on a straight run, nothing with the same direction may sit
 * between them, and each end occupies its tile (no belt there). When no legal
 * run exists the link is reported as unroutable instead of being drawn as if
 * it worked.
 *
 * A run may pass under a machine: only the two ends of a tunnel are buildings,
 * the tiles between them hold no entity, and `checkCanPlaceEntity` in
 * `ref/logic.js` only looks at the surface tile. So the surface may dive at
 * any free tile and stay under for the whole phase budget; it just may not
 * come back up under a building (a receiver would share that tile).
 *
 * Turns cost 2 so the result reads as a few straight runs instead of a
 * staircase; crossing a belt costs 3 and a completed tunnel end another 2, so
 * the router prefers short, shallow tunnels.
 */
export function routeBeltDetailed(world: World, start: Tile, goal: Tile, opts: RouteOptions = {}): RouteOutcome {
    const margin = opts.margin ?? 20;
    const minX = Math.min(start.x, goal.x) - margin;
    const minY = Math.min(start.y, goal.y) - margin;
    const width = Math.abs(goal.x - start.x) + 2 * margin + 1;
    const height = Math.abs(goal.y - start.y) + 2 * margin + 1;
    const res = routerSearch({
        world,
        start,
        goal,
        minX,
        minY,
        width,
        height,
        allowCross: opts.allowCross === true,
        relaxCross: opts.relaxCross === true,
        goalMayJoin: opts.goalMayJoin === true,
        exempt: opts.exempt ?? null,
        startDir: directionIndex(opts.startDir),
        goalDir: directionIndex(opts.goalDir),
        frontier: opts.frontier ?? null,
    });
    const boxLimited = res.boxLimited;
    if (!res.cells) return { run: null, boxLimited };
    return { run: finishRun(world, { cells: res.cells, phases: res.phases, headings: res.headings }, opts), boxLimited };
}

/** `routeBeltDetailed(...).run` for callers that do not act on the box verdict */
export function routeBelt(world: World, start: Tile, goal: Tile, opts: RouteOptions = {}): RouteResult | null {
    return routeBeltDetailed(world, start, goal, opts).run;
}

/** derive spans/crossings and (unless `dryRun`) claim the searched run */
function finishRun(world: World, chosen: ChosenRun, opts: RouteOptions): RouteResult {
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
    const run: RouteResult = { cells, crossings, spans, phases, headings, joinsGoal: opts.goalMayJoin === true, entryKey: null };
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
/** the heading a run writes on surface cell `i` */
function beltHeadingOf(cells: readonly Tile[], i: number): BeltHeading {
    if (cells.length === 1) return "h";
    if (i === 0) return cells[1]!.y === cells[0]!.y ? "h" : "v";
    if (i === cells.length - 1) return cells[i]!.y === cells[i - 1]!.y ? "h" : "v";
    if (cells[i - 1]!.y === cells[i + 1]!.y) return "h";
    if (cells[i - 1]!.x === cells[i + 1]!.x) return "v";
    return "turn";
}

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
        world.belts.set(key, beltHeadingOf(cells, i));
        world.occupied.add(key);
        // the whole run leads to the hub: tag it so later factories can merge in
        if (run.entryKey !== null) world.hubBound.set(key, run.entryKey);
    }
    if (run.entryKey !== null) world.hubEntryLoad.set(run.entryKey, (world.hubEntryLoad.get(run.entryKey) ?? 0) + 1);
}

/**
 * Undo one `claimRoute`: remove the belt cells, tunnel ends and tunnel-under
 * directions that run wrote, so the router can find another way and the run can
 * be laid again. `occupied` is a union of machines, corridors and belts, so it
 * is left alone — a ripped cell simply stays reserved for buildings.
 */
/** is every tile of this run still free? a restore may not overwrite a belt */
export function runFits(world: World, run: RouteResult): boolean {
    const ends = new Set<number>();
    for (const span of run.spans) {
        for (const end of [span.sender, span.receiver]) ends.add(cellKey(end.x, end.y));
    }
    for (let i = 0; i < run.cells.length; i++) {
        if (run.phases[i] !== 0) continue;
        const cell = run.cells[i]!;
        const key = cellKey(cell.x, cell.y);
        if (ends.has(key)) continue;
        if (run.joinsGoal && i === run.cells.length - 1) {
            // the belt this run merged into has to be there still
            if (!world.belts.has(key)) return false;
            continue;
        }
        if (world.belts.has(key) || world.tunnelEnds.has(key)) return false;
    }
    for (const span of run.spans) {
        const d = ROUTE_DIRS.findIndex((dir) => dir[0] === span.dx && dir[1] === span.dy);
        for (const cell of span.cells) {
            const key = cellKey(cell.x, cell.y);
            if (((world.tunnelUnder.get(key) || 0) >>> d) & 1) return false;
        }
        for (const end of [span.sender, span.receiver]) {
            const key = cellKey(end.x, end.y);
            if (world.tunnelEnds.has(key) || world.belts.has(key)) return false;
        }
    }
    return true;
}

export function releaseRoute(world: World, run: RouteResult): void {
    const ends = new Set<number>();
    for (const span of run.spans) {
        const d = ROUTE_DIRS.findIndex((dir) => dir[0] === span.dx && dir[1] === span.dy);
        if (d < 0) continue;
        for (const c of span.cells) {
            const key = cellKey(c.x, c.y);
            const mask = (world.tunnelUnder.get(key) || 0) & ~(1 << d);
            if (mask) {
                world.tunnelUnder.set(key, mask);
            } else {
                world.tunnelUnder.delete(key);
                // the cell only counts as a crossing while something runs beneath
                world.tunnelCells.delete(key);
            }
        }
        for (const end of [span.sender, span.receiver]) {
            const key = cellKey(end.x, end.y);
            if (world.tunnelEnds.get(key) === d) world.tunnelEnds.delete(key);
            ends.add(key);
        }
    }
    const { cells, phases } = run;
    for (let i = 0; i < cells.length; i++) {
        if (phases[i] !== 0) continue;
        const key = cellKey(cells[i]!.x, cells[i]!.y);
        if (ends.has(key)) continue;
        // a merge run never owned the belt it joined
        if (run.joinsGoal && i === cells.length - 1) continue;
        if (world.belts.get(key) !== beltHeadingOf(cells, i)) continue;
        world.belts.delete(key);
        if (run.entryKey !== null) world.hubBound.delete(key);
    }
    if (run.entryKey !== null) {
        const left = (world.hubEntryLoad.get(run.entryKey) ?? 1) - 1;
        if (left > 0) world.hubEntryLoad.set(run.entryKey, left);
        else world.hubEntryLoad.delete(run.entryKey);
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

/** the hub occupies a 4×4 tile block; belts may enter it on any side */
export const HUB_SIZE = 4;

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

/** the tile a packed key stands for: the inverse of `cellKey` */
export function tileOfKey(key: number): Tile {
    return { x: Math.floor(key / 8192) - 4096, y: (key % 8192) - 4096 };
}

/** tiles covered by a deposit, ordered from its centre outwards */
export function patchCellsByCentre(patch: Patch): (Tile & { d: number })[] {
    return patchCells(patch)
        .map((c) => ({ x: c.x, y: c.y, d: Math.hypot(c.x - patch.x, c.y - patch.y) }))
        .sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
}

/**
 * Placement state shared by every factory on one map: which tiles are taken and
 * which belong to a deposit (only a miner may sit on a deposit tile).
 */
export function createWorld({ hub, patches }: WorldInit): World {
    const router = createRouterLog();
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
    const walls = new SyncSet(router);
    for (let dx = 0; dx < HUB_SIZE; dx++) {
        for (let dy = 0; dy < HUB_SIZE; dy++) walls.add(cellKey(hub.x + dx, hub.y + dy));
    }
    return {
        hub,
        patches,
        blocked: new SyncSet(router),
        router,
        occupied,
        deposits,
        blocks: [],
        walls,
        /** tiles a belt must run through to reach a port; never built on */
        approaches: new SyncSet(router),
        /** tile → "h" | "v" | "turn": the belt already laid there */
        belts: new SyncMap<BeltHeading>(router),
        /** tiles where one belt passes under another through a tunnel */
        tunnelCells: new SyncSet(router),
        /** tile → direction index of the tunnel end building sitting there */
        tunnelEnds: new SyncMap<number>(router),
        /** tile → bitmask of tunnel directions running underneath */
        tunnelUnder: new SyncMap<number>(router),
        /** outside tiles already claimed by a belt feeding the hub */
        hubApproaches: new Set<number>(),
        hubBound: new Map<number, number>(),
        hubEntryLoad: new Map<number, number>(),
    };
}

/**
 * Fuse cut steps that are different output slots of one machine.
 *
 * A quad cutter ejects all four quadrants in the same cycle and a cutter has a
 * slot per half, so two steps that cut the same shape into different slots are
 * one machine, not two. The later step is marked `fuseInto` the first: the
 * layout places one cutter and links each consumer from its own slot.
 *
 * A slot with more than one consumer stays split: one output port feeds one
 * belt, so that product still needs a second copy of the sub-plan.
 */
export function fuseCuts(flat: PlanTree): PlanTree {
    const consumers = new Map<string, number>();
    for (const step of flat.steps) {
        for (const input of step.inputs) consumers.set(input.id, (consumers.get(input.id) || 0) + 1);
    }
    const groups = new Map<string, P.PlanStep[]>();
    for (const step of flat.steps) {
        if (step.op !== "cutQuad" && step.op !== "cutHalf") continue;
        const input = step.inputs[0];
        if (!input) continue;
        const key = `${step.op}|${input.id}`;
        const list = groups.get(key) || [];
        list.push(step);
        groups.set(key, list);
    }
    const fuseInto = new Map<string, string>();
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        if (new Set(list.map((step) => outputSlot(step))).size < 2) continue;
        if (list.some((step) => (consumers.get(step.id) || 0) > 1)) continue;
        const rep = list[0]!;
        for (const step of list.slice(1)) fuseInto.set(step.id, rep.id);
    }
    if (!fuseInto.size) return flat;
    return {
        ...flat,
        steps: flat.steps.map((step) =>
            fuseInto.has(step.id) ? { ...step, fuseInto: fuseInto.get(step.id) } : step
        ),
    };
}

/** plan cost once a fused cutter counts as one machine instead of one per slot */
export function fusedCost(flat: PlanTree, cost: number): number {
    let aliases = 0;
    for (const step of flat.steps) if (step.fuseInto) aliases += 1;
    return cost - aliases;
}

/**
 * Turn a plan DAG into a tree by copying any sub-plan whose *output slot*
 * feeds more than one consumer.
 *
 * The search memoises identical sub-shapes, so the same node can hang under
 * several parents. In the game one output port feeds exactly one belt, so a
 * shared slot would need a splitter — and splitters only unlock at L20. Parts
 * are free, so the legal answer is a second copy of that sub-plan.
 *
 * Different slots of one fused cutter are not a second consumer of the shape:
 * `fuseCuts` marks them, and they share the cutter and its input sub-plan.
 * Inputs come before their parent.
 */
export function expandPlanTree(flat: PlanTree): PlanTree;
export function expandPlanTree(flat: PlanTreeLike): PlanTreeLike;
export function expandPlanTree(flat: PlanTreeLike): PlanTreeLike {
    const byId = new Map<string, PlanStepLink>(flat.steps.map((step): [string, PlanStepLink] => [step.id, step]));
    const copied = new Map<string, PlanStepLink>();
    const seen = new Map<string, number>();
    const steps: PlanStepLink[] = [];
    /**
     * `from` + `port` name the input edge, not the consumer step: a fused
     * cutter's members are one building with one input, so both edges share
     * one copy of the source, while a stacker that takes one shape on both
     * inputs still gets one copy per port.
     */
    const visit = (id: string, from: string, port: number): PlanStepLink => {
        const key = `${id}|${from}|${port}`;
        const known = copied.get(key);
        if (known) return known;
        const src = byId.get(id)!;
        const n = (seen.get(id) || 0) + 1;
        seen.set(id, n);
        const copyId = n === 1 ? id : `${id}#${n}`;
        const group = src.fuseInto ?? copyId;
        const copy: PlanStepLink = {
            ...src,
            id: copyId,
            inputs: src.inputs.map((input, i) => ({ ...input, id: visit(input.id, group, i).id })),
        };
        copied.set(key, copy);
        steps.push(copy);
        return copy;
    };
    const final = visit(flat.final.id, flat.final.id, 0);
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
    const consumers = new Map<string, number>();
    const aliases = new Map<string, string[]>();
    for (const step of flat.steps) {
        for (const input of step.inputs) consumers.set(input.id, (consumers.get(input.id) || 0) + 1);
        if (!step.fuseInto) continue;
        const list = aliases.get(step.fuseInto) || [];
        list.push(step.id);
        aliases.set(step.fuseInto, list);
    }
    for (const step of flat.steps) {
        if (step.fuseInto) continue;
        const info = BUILDING_INFO[step.op];
        if (!info) continue;
        add(BUILDING_NAMES[step.op]);
        if (info.outs.length > 1) {
            // only the slots somebody belts away are used; a fused cutter can
            // have two or more of them
            let used = consumers.get(step.id) ? 1 : 0;
            for (const alias of aliases.get(step.id) || []) if (consumers.get(alias)) used += 1;
            add(BUILDING_NAMES.trash, info.outs.length - used);
        }
    }
    for (const chain of chains) {
        for (const op of chain.ops) add(op.kind === "mixer" ? BUILDING_NAMES.mixer : BUILDING_NAMES.base);
    }
    return [...bom.entries()].map(([zh, n]) => ({ zh, n }));
}
