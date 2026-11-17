/**
 * Turns a solved plan into a buildable layout ("图纸"):
 *
 *  - picks a real resource patch for every extractor (shape + color),
 *  - places the processing buildings on a tile grid next to the hub,
 *  - computes the exact port positions from the game's building definitions,
 *  - emits connections (what feeds what) + belt-length estimates + BOM.
 *
 * The tile world itself — geometry, ports, world state and the router — lives
 * in `layout.ts`; this module only places parts in it and lays the belts.
 *
 * Port coordinates are in tile units relative to the building's top-left tile;
 * y grows downwards (screen/tile space, same as the game).
 */

import * as P from "./plan.js";
import { BUILDING_NAMES } from "./catalogue.js";
import { COLOR_NEEDS, colorChain } from "./color.js";
import type { ColorChar } from "./shape.js";
import type { MapItem, Patch } from "./map.js";
import {
    BUILDING_INFO,
    HUB_SIZE,
    cellKey,
    claimRoute,
    createWorld,
    expandPlanTree,
    fuseCuts,
    outputSlot,
    patchCellsByCentre,
    portApproachCells,
    portCells,
    portCentre,
    releaseRoute,
    rotatedSize,
    routeBelt,
    runFits,
} from "./layout.js";
import type {
    BlockRect,
    BomEntry,
    BuildingInfo,
    Connection,
    ConnectionDraft,
    ConnectionExtra,
    LayoutColor,
    LayoutSource,
    Placement,
    PlanTree,
    Rot,
    RouteResult,
    RoutingGap,
    Tile,
    World,
} from "./layout.js";

/* ------------------------------------------------------------------ *
 * tuning
 * ------------------------------------------------------------------ */

/**
 * The knobs the placement pass reads. Every default is the value the solver
 * ships with; `buildLayout` merges a caller's overrides over them, so a test
 * can widen a search box without touching anything else.
 */
export interface PlacementTuning {
    /**
     * Spots tried per part before it is dropped at the first spot that fits.
     * Each try is a full route search per input, so this is a search budget:
     * the first spot almost always routes, and a part that needs a turn finds
     * one within a row or two.
     */
    maxTries: number;
    /** smallest search box around a short link, in tiles */
    nearMarginFloor: number;
    /** largest search box around a short link, in tiles */
    nearMargin: number;
    /** second box a long link is searched in, in tiles */
    wideMargin: number;
    /** free row and column kept inside a factory window for belts */
    corridor: number;
    /** tiles between two machines of one row */
    machineGap: number;
    /** tiles between two factory windows */
    blockGap: number;
    /** rip-up rounds after the first build */
    ripRounds: number;
    /** belts one failed link may rip per round */
    ripPerRound: number;
    /** how many delivery legs one hub entry belt may carry */
    hubEntryLegs: number;
    /** colour ports one shared colour net fans a trunk out to */
    colorGroupSize: number;
}

export const DEFAULT_TUNING: PlacementTuning = {
    maxTries: 4,
    nearMarginFloor: 8,
    nearMargin: 20,
    wideMargin: 60,
    corridor: 2,
    machineGap: 2,
    blockGap: 4,
    ripRounds: 5,
    ripPerRound: 3,
    hubEntryLegs: 5,
    colorGroupSize: 5,
};

/* ------------------------------------------------------------------ *
 * what the placement pass needs on top of the tile world
 * ------------------------------------------------------------------ */

/** spots a mixer tries before it settles for the nearest spot that only fits */
const MIXER_TRIES = 8;

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

/** the tile a packed key stands for: the inverse of `cellKey` */
function tileOfKey(key: number): Tile {
    return { x: Math.floor(key / 8192) - 4096, y: (key % 8192) - 4096 };
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

/**
 * Block origin for one factory: the nearest window around `anchor` that no
 * deposit or existing building sits in, else the emptiest window seen.
 * `anchor` is a preferred window *origin*: the caller passes the hub itself
 * (legacy) or the deposit centroid minus half a window, so the miner belt —
 * the longest run in the factory — is as short as possible.
 * Windows may overlap each other — only the buildings packed into them have
 * to be disjoint — so the grid is fine grained and ordered by distance.
 */
function allocateBlock(world: World, width: number, height: number, gap: number, anchor: Tile = world.hub): BlockRect | null {
    // tile the map with one window per factory plus a lane between neighbours,
    // so a long belt can pass between two factories instead of through one
    const stepX = width + gap;
    const stepY = height + gap;
    const reach = 12;
    const legacy = anchor.x === world.hub.x && anchor.y === world.hub.y;
    const candidates: { dx: number; dy: number; d: number }[] = [];
    for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
            // the hub itself is occupied: the legacy path never tried it
            if (legacy && !dx && !dy) continue;
            candidates.push({ dx, dy, d: Math.abs(dx) * stepX + Math.abs(dy) * stepY });
        }
    }
    candidates.sort((a, b) => a.d - b.d || a.dx - b.dx || a.dy - b.dy);
    const originX = Math.round(anchor.x);
    const originY = Math.round(anchor.y);
    let best: BlockRect | null = null;
    let bestHits = Infinity;
    for (const c of candidates) {
        const x = originX + c.dx * stepX;
        const y = originY + c.dy * stepY;
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
 * The tile a factory should grow around: the average of the deposits its
 * extractors will sit on (nearest matching patch per base step). With no
 * deposits to anchor to — every base already placed, or a colour-only factory
 * — the hub is the fallback.
 */
function factoryAnchor(world: World, flat: PlanTree): Tile {
    const { hub } = world;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op !== "base") continue;
        const code = node.code || `${node.type}u${node.type}u${node.type}u${node.type}u`;
        let best: Patch | null = null;
        let bestD = Infinity;
        for (const patch of world.patches) {
            if (patch.item.kind !== "shape" || patch.item.code !== code) continue;
            const d = Math.hypot(patch.x - hub.x, patch.y - hub.y);
            if (d < bestD) {
                bestD = d;
                best = patch;
            }
        }
        if (!best) continue;
        sx += best.x;
        sy += best.y;
        n += 1;
    }
    return n ? { x: Math.round(sx / n), y: Math.round(sy / n) } : hub;
}

/* ------------------------------------------------------------------ *
 * the placement session
 * ------------------------------------------------------------------ */

/** tiles one placement took, so a rejected candidate can be undone */
export interface Claim {
    cells: number[];
}

/** one link resolved against the map, before anything is claimed */
export interface LinkPlan {
    draft: ConnectionDraft;
    start: Tile;
    goal: Tile;
    /** the outside tile this link claims at the hub, when it goes there */
    hubTile: Tile | null;
    /** the searched run: `null` when no legal one exists */
    path: RouteResult | null;
}

/** one colour chain grown next to its consumer */
export interface BuiltColorChain {
    ok: true;
    color: ColorChar;
    building: Placement;
    info: BuildingInfo;
    outSlot: number;
    /** first base miner of the chain: where the next chain of the group grows */
    anchor?: Tile;
}

/** a colour chain that could not be built: the map lacks a deposit */
export type ColorChainOutcome = BuiltColorChain | { ok: false; color: ColorChar };

/** a link waiting for the router; every part is placed before any belt is laid */
export type QueuedLink =
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

/** what `createPlacementSession` needs to know */
export interface PlacementArgs {
    world: World;
    hub: Tile;
    /** the flat plan's steps by id, for `hubLinkOf` */
    stepById: ReadonlyMap<string, P.PlanStep>;
    allowTunnels?: boolean;
    /** partial overrides merged over `DEFAULT_TUNING` */
    tuning?: Partial<PlacementTuning>;
    /** namespaces the synthetic ids the colour chains hand out */
    idPrefix?: string;
}

/**
 * Everything one plan needs while it is being laid out: the parts placed, the
 * tiles they own, the links between them and the rip-up pass — behind one
 * factory, so `buildLayout`'s choreography and a test drive the same state.
 */
export interface PlacementSession {
    /** the resolved knobs; the choreography reads `corridor`, `machineGap`, … */
    readonly tuning: PlacementTuning;
    /** the parts placed so far, in placement order (the drawing and BOM order) */
    readonly buildings: Placement[];
    /** where every resource comes from */
    readonly sources: LayoutSource[];
    /** resources the map does not have */
    readonly missing: Set<string>;
    /** one entry per link laid or reported */
    readonly connections: Connection[];
    readonly routingGaps: RoutingGap[];
    /** belt cells the drawing needs, tunnels counted twice */
    readonly beltEstimate: number;

    /** can `info` stand at (x, y) turned `rot`? Reserves nothing */
    fits(info: BuildingInfo, x: number, y: number, rot: Rot): boolean;
    /** reserve every tile `info` needs; a rejected candidate is undone by `release` */
    reserve(info: BuildingInfo, x: number, y: number, rot: Rot): Claim;
    release(claim: Claim): void;
    /** first free spot for `info` around `anchor`, reserved */
    placeNear(info: BuildingInfo, anchor: Tile, rot?: Rot): Tile | null;
    /** keep these tiles off every later belt (a miner's claim, a trash can) */
    block(cells: Iterable<number>): void;
    /** name the building a plan step id resolves to */
    bind(stepId: string, placement: Placement): void;
    buildingOf(stepId: string): Placement | undefined;
    /** every link a step's inputs need, against the placement being tried */
    inputLinks(step: P.PlanStep, placement: Placement, info: BuildingInfo): QueuedLink[];
    planLink(q: QueuedLink): LinkPlan | null;
    commitLink(plan: LinkPlan, q: QueuedLink, replace?: number): boolean;
    /** a belt between two placed parts; `extra` marks colour / waste runs */
    shapeLink(
        src: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dst: Placement,
        dstInfo: BuildingInfo,
        inSlot: number,
        extra?: ConnectionExtra
    ): QueuedLink;
    /** the product of the plan's root, belted into the hub */
    hubLinkOf(src: Placement): QueuedLink;
    /** plan a link and lay it; `false` when no legal run exists */
    layLink(q: QueuedLink): boolean;
    /** undo one laid run so the rip-up pass can route it again */
    rip(index: number): void;
    /** rip-up and reroute: run once every part is placed */
    schedule(): void;
    /** one colour chain per consumer port */
    buildColorChain(color: ColorChar, anchor: Tile): ColorChainOutcome | null;
    /** one colour net for several ports of the same factory */
    buildSharedColorNet(
        color: ColorChar,
        ports: { painter: Placement; info: BuildingInfo; slot: number }[],
        anchor: Tile
    ): void;
}

export function createPlacementSession({
    world: shared,
    hub,
    stepById,
    allowTunnels = true,
    tuning: overrides = {},
    idPrefix = "",
}: PlacementArgs): PlacementSession {
    const tuning: PlacementTuning = { ...DEFAULT_TUNING, ...overrides };

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
    /** placed parts, by plan step id; links resolve their two ends through it */
    const buildingByStep = new Map<string, Placement>();
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
        for (const spot of nearFits(info, anchor, rot)) {
            reserve(info, spot.x, spot.y, rot);
            return spot;
        }
        return null;
    }

    /**
     * Every tile around `anchor` the part fits on, nearest ring first, without
     * reserving any of them. A caller that has to try several spots reserves one
     * at a time so `fits` still sees the ones it rejected as free.
     */
    function* nearFits(info: BuildingInfo, anchor: Tile, rot: Rot): Generator<Tile> {
        // anchors are often a building centre (half tiles); every part must sit
        // on whole tiles or its ports land between two grid cells
        const ax = Math.floor(anchor.x);
        const ay = Math.floor(anchor.y);
        for (let r = 0; r < 48; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    if (!fits(info, ax + dx, ay + dy, rot)) continue;
                    yield { x: ax + dx, y: ay + dy };
                }
            }
        }
    }

    /**
     * A dry search. The short box covers any link inside one factory; a wide box
     * is only worth its cost for the long hub runs, and two of them per failed
     * candidate is what makes a big campaign crawl.
     */
    /** when set, every search records the blocked tiles it ran into */
    let blameFrontier: Set<number> | null = null;

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
            frontier: blameFrontier,
            margin: Math.max(tuning.nearMarginFloor, Math.min(tuning.nearMargin, span)),
            dryRun: true,
        });
        if (near || !wide) return near;
        return routeBelt(shared, blocked, start, goal, {
            allowCross,
            goalMayJoin: join,
            exempt,
            startDir,
            goalDir,
            frontier: blameFrontier,
            margin: tuning.wideMargin,
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
                fromLabel: BUILDING_NAMES[src.kind],
                toLabel: BUILDING_NAMES[dst.kind],
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
                path: { cells: [], crossings: [], spans: [], phases: [], headings: [], joinsGoal: false, entryKey: null },
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
            goalApproach: Tile | null,
            /** the hub side an entry tile feeds: a run may tunnel up onto it */
            goalDirOverride: readonly [number, number] | null = null
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
            const goalDir =
                goalDirOverride ??
                (goalApproach ? ([Math.sign(goal.x - goalApproach.x), Math.sign(goal.y - goalApproach.y)] as const) : null);
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
                fromLabel: BUILDING_NAMES[src.kind],
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
            const candidates: { tile: Tile; join: boolean; entry: boolean }[] = [];
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (!shared.hubApproaches.has(key) && !shared.belts.has(key) && candidates.length < 6) {
                    candidates.push({ tile: t, join: false, entry: true });
                }
            }
            let merges = 0;
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (shared.hubApproaches.has(key) && shared.belts.has(key) && merges++ < 3) {
                    candidates.push({ tile: t, join: true, entry: true });
                }
            }
            // every entry can be boxed in by the belts of factories laid before
            // this one. Two belts may point into one tile, so the leg can still
            // merge into a belt that already runs to the hub; one entry belt
            // carries 2 items/s, which bounds how many legs it may feed.
            for (const tile of hubTrunkCells(x1, y1, 6)) candidates.push({ tile, join: true, entry: false });

            if (!candidates.length) for (const t of faces) candidates.push({ tile: t, join: false, entry: true });
            let first: LinkPlan | null = null;
            for (const { tile, join, entry } of candidates) {
                const border = hubBorderOf(hub, tile);
                // an entry tile is a hub claim; a trunk merge ends on a belt that
                // already runs into the hub and claims nothing
                const plan = finish(
                    { x: tile.x, y: tile.y },
                    entry ? border.x + 0.5 : tile.x + 0.5,
                    entry ? border.y + 0.5 : tile.y + 0.5,
                    "HUB",
                    "中心",
                    null,
                    join,
                    entry ? { x: tile.x, y: tile.y } : null,
                    null,
                    // the entry belt has to point into the hub, so a run may
                    // surface onto the entry tile from a tunnel underneath the
                    // belts that box the hub in
                    entry ? [Math.sign(border.x - tile.x), Math.sign(border.y - tile.y)] : null
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
        return finish(goal, dst.x + ix, dst.y + iy, dst.stepId, BUILDING_NAMES[dst.kind], q.inSlot, false, null, goalApproach);
    }

    /** the run behind every connection index, for rip-up */
    const laid: ({ q: QueuedLink; run: RouteResult; hubTile: Tile | null } | undefined)[] = [];
    /** belt tile key → connection index */
    const beltOwner = new Map<number, number>();
    /** links whose search failed: the rip-up pass retries them */
    const failed: { q: QueuedLink; index: number }[] = [];
    /** the gap behind each connection index; a successful retry clears it */
    const gapOf: (RoutingGap | undefined)[] = [];
    /** the link behind each connection index, so a leftover can be retried */
    const queuedOf = new Map<number, QueuedLink>();
    /** the last run laid for each connection index, so a failed rip can be undone */
    const lastPlan = new Map<number, LinkPlan>();
    /** hub entry tile key → the connection that claimed it */
    const hubClaimOwner = new Map<number, number>();

    /**
     * Belts that already carry items into the hub, nearest to `(x, y)` first.
     *
     * Two belts may point into one tile, so a leg that finds every entry boxed
     * in by the belts of earlier factories can still merge into one that is on
     * its way there. An entry belt carries 2 items/s and the fattest factory
     * root pulls 0.4, so a trunk stops taking legs once its entry reached
     * `tuning.hubEntryLegs` — without that cap every factory could chain onto
     * the first belt and the sheet would claim a rate the game cannot carry.
     */
    function hubTrunkCells(x: number, y: number, limit: number): Tile[] {
        const out: { tile: Tile; d: number }[] = [];
        for (const [key, entry] of shared.hubBound) {
            if ((shared.hubEntryLoad.get(entry) ?? 0) >= tuning.hubEntryLegs) continue;
            // an entry tile is offered by the face loop together with its claim
            if (shared.hubApproaches.has(key)) continue;
            const tile = tileOfKey(key);
            out.push({ tile, d: Math.abs(tile.x - x) + Math.abs(tile.y - y) });
        }
        out.sort((a, b) => a.d - b.d || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
        return out.slice(0, limit).map((e) => e.tile);
    }

    /**
     * Lay a planned run. An unroutable link is reported as a gap instead of
     * being drawn as if a belt could carry items there — a stub end blocks the
     * machine that feeds it.
     */
    function commitLink(plan: LinkPlan, q: QueuedLink, replace = -1): boolean {
        if (plan.hubTile) {
            const key = cellKey(plan.hubTile.x, plan.hubTile.y);
            shared.hubApproaches.add(key);
            if (!hubClaimOwner.has(key)) hubClaimOwner.set(key, replace >= 0 ? replace : connections.length);
        }
        const path = plan.path;
        const index = replace >= 0 ? replace : connections.length;
        queuedOf.set(index, q);
        if (!path) {
            gapOf[index] = {
                from: plan.draft.from,
                to: plan.draft.to,
                fromLabel: plan.draft.fromLabel,
                toLabel: plan.draft.toLabel,
                start: plan.start,
                goal: plan.goal,
                connection: index,
            };
            connections[index] = { ...plan.draft, routed: false, path: null, tunnels: 0, tunnelCells: [], tunnelSpans: [], beltTiles: 0 };
            laid[index] = undefined;
            failed.push({ q, index });
            return false;
        }
        gapOf[index] = undefined;
        // a delivery leg feeds the entry it claimed, or — merged into a trunk —
        // the entry that trunk already belongs to; the tag has to be on the run
        // before it is claimed
        const tail = path.cells[path.cells.length - 1];
        const joined = path.joinsGoal && tail ? shared.hubBound.get(cellKey(tail.x, tail.y)) : undefined;
        path.entryKey = plan.hubTile ? cellKey(plan.hubTile.x, plan.hubTile.y) : joined ?? null;
        // the run was searched on this very world a moment ago: write it as tested
        claimRoute(shared, path);
        // every path tile is a belt or a tunnel end; the underground tiles are
        // neither, and the two ends of each tunnel are counted once each
        const underground = path.spans.reduce((n, span) => n + span.cells.length, 0);
        const beltTiles = path.cells.length - underground;
        beltEstimate += beltTiles;
        connections[index] = {
            ...plan.draft,
            routed: true,
            path: path.cells,
            tunnels: path.spans.length,
            tunnelCells: path.crossings,
            tunnelSpans: path.spans,
            beltTiles,
        };
        laid[index] = { q, run: path, hubTile: plan.hubTile };
        lastPlan.set(index, plan);
        for (const c of path.cells) beltOwner.set(cellKey(c.x, c.y), index);
        for (const span of path.spans) {
            beltOwner.set(cellKey(span.sender.x, span.sender.y), index);
            beltOwner.set(cellKey(span.receiver.x, span.receiver.y), index);
        }
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
        return plan ? commitLink(plan, q) : false;
    }

    /** keep these tiles off every later belt (a miner's claim, a trash can) */
    function block(cells: Iterable<number>): void {
        for (const key of cells) blocked.add(key);
    }

    /** name the building a plan step id resolves to (a fused cutter has aliases) */
    function bind(stepId: string, placement: Placement): void {
        buildingByStep.set(stepId, placement);
    }

    function buildingOf(stepId: string): Placement | undefined {
        return buildingByStep.get(stepId);
    }

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
                    zh: BUILDING_NAMES.base,
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
            const midpoint = {
                x: Math.round((left.building.x + right.building.x) / 2),
                y: Math.round((left.building.y + right.building.y) / 2),
            };
            // a spot that merely fits can wall both operand belts in — that is
            // where the last miner→mixer gaps came from — so take the nearest
            // spot both operands can actually reach, and only fall back to the
            // plain nearest fit when none of them routes
            let pos: Tile | null = null;
            let tried = 0;
            for (const candidate of nearFits(info, midpoint, 0)) {
                if (tried++ >= MIXER_TRIES) break;
                const claim = reserve(info, candidate.x, candidate.y, 0);
                const probe: Placement = {
                    step: "",
                    stepId: "",
                    kind: "mixer",
                    zh: BUILDING_NAMES.mixer,
                    x: candidate.x,
                    y: candidate.y,
                    w: info.w,
                    h: info.h,
                    rot: 0,
                };
                const feeds = [
                    planLink(shapeLink(left.building, left.info, left.outSlot, probe, info, 0, { color: true })),
                    planLink(shapeLink(right.building, right.info, right.outSlot, probe, info, 1, { color: true })),
                ];
                // one tile holds one belt: the two operand runs may not cross
                const taken = new Set<number>();
                let clash = false;
                for (const plan of feeds) {
                    if (!plan?.path) continue;
                    for (const cell of plan.path.cells) {
                        const key = cellKey(cell.x, cell.y);
                        if (taken.has(key)) clash = true;
                        taken.add(key);
                    }
                }
                if (!clash && feeds.every((plan) => plan?.path)) {
                    pos = candidate;
                    break; // its reservation stays, the mixer goes here
                }
                release(claim);
            }
            pos ??= placeNear(info, midpoint, 0);
            if (!pos) {
                missing.add(`颜色:${op.color}`);
                return { color, ok: false };
            }
            const serial = ++colorSerial;
            const b: Placement = {
                step: `color:${op.color}:mixer#${serial}`,
                stepId: `${idPrefix}color:${op.color}:mixer#${serial}`,
                kind: "mixer",
                zh: BUILDING_NAMES.mixer,
                x: pos.x,
                y: pos.y,
                w: info.w,
                h: info.h,
                rot: 0,
                detail: `${left.color}+${right.color}`,
                color: op.color,
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
                    zh: BUILDING_NAMES.merger,
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
                zh: BUILDING_NAMES.splitter,
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

    /** undo one laid run so the rip-up pass can route it again */
    const rip = (index: number): void => {
        const entry = laid[index];
        if (!entry) return;
        /** every tile this run held, so a merge aimed at one of them can follow */
        const held = new Set<number>(entry.run.cells.map((c) => cellKey(c.x, c.y)));
        releaseRoute(shared, entry.run);
        for (const c of entry.run.cells) beltOwner.delete(cellKey(c.x, c.y));
        for (const span of entry.run.spans) {
            beltOwner.delete(cellKey(span.sender.x, span.sender.y));
            beltOwner.delete(cellKey(span.receiver.x, span.receiver.y));
        }
        // a ripped hub leg frees the entry it claimed — otherwise the entry stays
        // "taken" while nothing feeds it and no later leg may claim it
        if (entry.hubTile) {
            const key = cellKey(entry.hubTile.x, entry.hubTile.y);
            if (hubClaimOwner.get(key) === index) {
                hubClaimOwner.delete(key);
                shared.hubApproaches.delete(key);
            }
        }
        const underground = entry.run.spans.reduce((n, span) => n + span.cells.length, 0);
        beltEstimate -= entry.run.cells.length - underground;
        laid[index] = undefined;
        connections[index] = { ...connections[index]!, routed: false, path: null, tunnels: 0, tunnelCells: [], tunnelSpans: [], beltTiles: 0 };
        failed.push({ q: entry.q, index });
        // a leg that merged into a belt of this run now points into nothing:
        // rip it too so the rip-up pass can find it another way in
        for (let i = 0; i < connections.length; i++) {
            const merged = connections[i]!;
            if (i === index || !merged.toHub || !merged.merged || !merged.routed || !merged.path) continue;
            const tail = merged.path[merged.path.length - 1];
            if (tail && held.has(cellKey(tail.x, tail.y))) rip(i);
        }
    };

    /**
     * Rip-up and reroute. A failed link blames the belts its search ran into;
     * rip the worst offenders, retry the link, and let the ripped ones try
     * again next round. Deterministic and bounded: fixed visiting order, fixed
     * cap — no randomness, so the sheet stays reproducible.
     */
    function schedule(): void {
        let queue = failed.splice(0);
        for (let round = 0; round < tuning.ripRounds && queue.length; round++) {
            const next: { q: QueuedLink; index: number }[] = [];
            for (const item of queue) {
                const blame = new Set<number>();
                // the retry doubles as the blame run: it records what stopped it
                blameFrontier = blame;
                const retry = planLink(item.q);
                blameFrontier = null;
                if (retry?.path) {
                    commitLink(retry, item.q, item.index);
                    continue;
                }
                const counts = new Map<number, number>();
                for (const key of blame) {
                    const owner = beltOwner.get(key);
                    if (owner === undefined || owner === item.index) continue;
                    counts.set(owner, (counts.get(owner) ?? 0) + 1);
                }
                const victims = [...counts.entries()].sort((l, r) => r[1] - l[1] || l[0] - r[0]).slice(0, tuning.ripPerRound);
                if (!victims.length) {
                    next.push(item);
                    continue;
                }
                for (const [index] of victims) rip(index);
                const after = planLink(item.q);
                if (after?.path) commitLink(after, item.q, item.index);
                else next.push(item);
            }
            queue = [...next, ...failed.splice(0)];
        }
        // a rip late in the cascade frees corridors the last retries never saw: try
        // the leftovers once more against the finished world. This only adds runs,
        // so it can never turn a laid belt into a gap.
        for (let sweep = 0; sweep < 4; sweep++) {
            let fixed = 0;
            for (let i = 0; i < connections.length; i++) {
                if (connections[i]!.routed) continue;
                const q = queuedOf.get(i);
                if (!q) continue;
                const plan = planLink(q);
                if (plan?.path && commitLink(plan, q, i)) fixed += 1;
            }
            if (!fixed) break;
        }
        // a rip that never found a way back would leave a link silently missing: the
        // sheet draws a cross for it while the CLI summary counts no gap. Put the
        // last run back wherever its tiles are still free, and report a gap only
        // when they are not — a rip may move a belt, never quietly drop one.
        for (let i = 0; i < connections.length; i++) {
            if (connections[i]!.routed) continue;
            const saved = lastPlan.get(i);
            const q = queuedOf.get(i);
            if (saved?.path && q && runFits(shared, saved.path) && commitLink(saved, q, i)) continue;
            if (!gapOf[i] && saved) {
                gapOf[i] = {
                    from: saved.draft.from,
                    to: saved.draft.to,
                    fromLabel: saved.draft.fromLabel,
                    toLabel: saved.draft.toLabel,
                    start: saved.start,
                    goal: saved.goal,
                    connection: i,
                };
            }
        }
        routingGaps.length = 0;
        for (const gap of gapOf) if (gap) routingGaps.push(gap);
        // a ripped belt can take away an over-belt another run was crossing under,
        // so every recorded crossing is refreshed from the final world
        for (const conn of connections) {
            if (!conn.routed || !conn.tunnelSpans || !conn.tunnelSpans.length) continue;
            conn.tunnelCells = conn.tunnelSpans
                .flatMap((span) => span.cells)
                .filter((cell) => shared.belts.has(cellKey(cell.x, cell.y)));
        }
    }

    return {
        tuning,
        buildings,
        sources,
        missing,
        connections,
        routingGaps,
        get beltEstimate(): number {
            return beltEstimate;
        },
        fits,
        reserve,
        release,
        placeNear,
        block,
        bind,
        buildingOf,
        inputLinks,
        planLink,
        commitLink,
        shapeLink,
        hubLinkOf,
        layLink,
        rip,
        schedule,
        buildColorChain,
        buildSharedColorNet,
    };
}

/* ------------------------------------------------------------------ *
 * what a layout reports
 * ------------------------------------------------------------------ */

/** what `buildLayout` reports */
export interface Layout {
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
    steps: P.PlanStep[];
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
    /** may a belt cross another one (tunnel unlocked)? Before L6 every crossing is illegal */
    allowTunnels?: boolean;
    /** may colour ports of one factory share a net (splitter unlocked, L20)? */
    allowColourNet?: boolean;
    /** placement knobs; anything left out keeps its `DEFAULT_TUNING` value */
    tuning?: Partial<PlacementTuning>;
}

export function buildLayout({
    plan,
    patches,
    hub = { x: -2, y: -2 },
    blockWidth = 26,
    blockHeight = 12,
    world = null,
    idPrefix = "",
    allowTunnels = true,
    allowColourNet = false,
    tuning: tuningOverrides = {},
}: BuildLayoutArgs): Layout {
    const shared = world || createWorld({ hub, patches });
    // one output port = one belt, so shared sub-plans get their own copy
    const flat = expandPlanTree(fuseCuts(P.flatten(plan)));
    // dependency depth
    const depth = new Map<string, number>();
    const stepById = new Map<string, P.PlanStep>(flat.steps.map((s): [string, P.PlanStep] => [s.id, s]));
    for (const step of flat.steps) {
        let d = 0;
        for (const input of step.inputs) d = Math.max(d, (depth.get(input.id) || 0) + 1);
        depth.set(step.id, d);
    }
    // every part and belt of this factory goes through the session
    const session = createPlacementSession({ world: shared, hub, stepById, allowTunnels, idPrefix, tuning: tuningOverrides });
    const { tuning } = session;
    /** fused cutters: alias step id → the rep's id (and back) */
    const aliasOf = new Map<string, string[]>();
    for (const step of flat.steps) {
        if (!step.fuseInto) continue;
        const list = aliasOf.get(step.fuseInto) || [];
        list.push(step.id);
        aliasOf.set(step.fuseInto, list);
    }
    /** how many belts a step's product feeds; a fused group's shared input counts once per building */
    const consumersOf = new Map<string, number>();
    for (const step of flat.steps) {
        for (const input of step.inputs) consumersOf.set(input.id, (consumersOf.get(input.id) || 0) + 1);
    }

    const paintColorsUsed = new Set<ColorChar>();
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op === "paint") paintColorsUsed.add(node.color);
        else if (node.op === "paint4") for (const c of node.colors) if (c && c !== "u") paintColorsUsed.add(c);
    }

    // rows of processors, grouped by depth; the reserved window has to be tall
    // enough for every row plus the corridor row between them
    const packWidth = blockWidth - tuning.corridor;
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
        for (const step of steps) width += (BUILDING_INFO[step.op]?.w || 1) + tuning.machineGap;
        extraRows += Math.max(0, Math.ceil(width / packWidth) - 1);
    }
    const lastDepth = byDepth.size ? Math.max(...byDepth.keys()) : 0;
    const neededHeight = Math.max(blockHeight, (lastDepth + extraRows) * 4 + 6);
    const hasProcessors = byDepth.size > 0;
    // grow the window around this factory's own deposits, not the hub: the
    // miner belt is the one run that cannot be shortened afterwards. A shared
    // colour net (L20) packs tightly enough that a moved window loses splits,
    // so those factories keep the old hub-anchored window.
    let anchor: Tile = shared.hub;
    if (!allowColourNet) {
        const centroid = factoryAnchor(shared, flat);
        anchor = {
            x: Math.round(centroid.x - blockWidth / 2),
            y: Math.round(centroid.y - neededHeight / 2),
        };
    }
    const block = hasProcessors ? allocateBlock(shared, blockWidth, neededHeight, tuning.blockGap, anchor) : null;
    const blockX = block ? block.x : hub.x + 8;
    const blockY = block ? block.y : hub.y - 8;

    // 1) place extractors on real patches
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op !== "base") continue;
        const type = node.type;
        const code = node.code || `${type}u${type}u${type}u${type}u`;
        // with a deposit-anchored window the mineral should also be the one
        // nearest that window; a shared colour net keeps the legacy search
        // around the hub so its packing stays bit-identical
        const minerFrom = allowColourNet
            ? { x: hub.x + 2, y: hub.y + 2 }
            : { x: blockX + blockWidth / 2, y: blockY + neededHeight / 2 };
        const found = placeExtractor(shared, (item) => item.kind === "shape" && item.code === code, minerFrom);
        if (!found) {
            session.missing.add(`shape:${code}`);
            session.sources.push({ step, missing: `地图上找不到 ${code} 矿脉`, patch: null });
            continue;
        }
        session.sources.push({ step, patch: found.patch, distance: found.distance, x: found.x, y: found.y });
        const miner: Placement = {
            step: step.id,
            stepId: idPrefix + step.id,
            kind: "base",
            zh: BUILDING_NAMES.base,
            x: found.x,
            y: found.y,
            w: 1,
            h: 1,
            rot: 0,
            patch: found.patch,
            distance: found.distance,
        };
        session.buildings.push(miner);
        session.bind(step.id, miner);
        // the extractor reserved straight into the world; the router has to see it
        session.block(found.cells);
    }

    // 2) pack processors into rows, grouped by depth. One free row between two
    // rows and a two-tile column on the right stay empty: they are the cells a
    // belt can travel through, because every other free cell around a machine
    // is one of its own ports and must stay reserved for its own link.
    const reserveCorridor = (cy: number): void => {
        for (let x = blockX; x < blockX + blockWidth; x++) shared.occupied.add(cellKey(x, cy + tuning.corridor));
        for (let x = blockX + packWidth; x < blockX + blockWidth; x++) {
            for (let y = cy - 1; y <= cy + tuning.corridor; y++) shared.occupied.add(cellKey(x, y));
        }
    };
    /** the game turns a part by 90° at a time; 0 is the orientation it ships in */
    const ROTATIONS: readonly Rot[] = [0, 1, 2, 3];
    let reservedY: number | null = null;
    /**
     * the root's belt into the hub was already attempted with its placement —
     * attempted, not necessarily routed: a failed attempt is committed as a
     * gap, and laying it a second time would report the same gap twice
     */
    let rootPlanned = false;

    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 4;
        for (const step of steps) {
            // a fused cut step is another output slot of a cutter placed for
            // its rep; it gets no building of its own
            if (step.fuseInto) continue;
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
                    zh: BUILDING_NAMES[step.op],
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
                    if (!session.fits(info, cx, cy, rot)) continue;
                    if (!fallback) fallback = make(cx, cy, rot);
                    if (tries >= tuning.maxTries) {
                        scanning = false;
                        break;
                    }
                    tries += 1;
                    // stand the part there, then ask the router whether its own
                    // inputs and — for the root — the hub can all be reached
                    const placement = make(cx, cy, rot);
                    const links = session.inputLinks(step, placement, info);
                    const toHub = root ? session.hubLinkOf(placement) : null;
                    const claim = session.reserve(info, cx, cy, rot);
                    const plans = links.map((q) => session.planLink(q));
                    const hubPlan = toHub ? session.planLink(toHub) : null;
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
                        session.release(claim);
                        continue;
                    }
                    chosen = placement;
                    scanning = false;
                    for (let k = 0; k < batch.length; k++) {
                        const plan = batch[k];
                        if (!plan) continue;
                        session.commitLink(plan, k < links.length ? links[k]! : toHub!);
                    }
                    if (toHub) rootPlanned = true;
                    break;
                }
                if (!scanning) break;
                cx += info.w + tuning.machineGap;
            }

            let placement = chosen;
            if (!placement && fallback) {
                // nothing routed from any spot: keep the first that fits, lay
                // what still lays, and let the rest surface as reported gaps
                placement = fallback;
                session.reserve(info, placement.x, placement.y, placement.rot);
                for (const q of session.inputLinks(step, placement, info)) session.layLink(q);
                if (root) {
                    session.layLink(session.hubLinkOf(placement));
                    rootPlanned = true;
                }
            }
            if (!placement) continue;
            session.buildings.push(placement);
            session.bind(step.id, placement);
            for (const alias of aliasOf.get(step.id) || []) session.bind(alias, placement);
            cx = placement.x + placement.w + 1;
        }
    }

    // 3b) a bare miner is the whole plan: the placement loop never sees the
    // root step, so its hub belt is laid here
    if (!rootPlanned) {
        const rootBuilding = session.buildingOf(flat.final.id);
        if (rootBuilding) session.layLink(session.hubLinkOf(rootBuilding));
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
        const painter = session.buildingOf(step.id);
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
        for (let start = 0; start < ports.length; start += tuning.colorGroupSize) {
            const chunk = ports.slice(start, start + tuning.colorGroupSize);
            const head = chunk[0]!;
            const anchor = { x: head.painter.x + head.info.w + 3, y: head.painter.y };
            if (chunk.length < 2 || !allowColourNet) {
                // One chain per port: a chain carries exactly one port's 0.4/s
                // and one output port takes one belt, so two ports of the same
                // colour need two chains — building one and linking only the
                // head would leave the second port with no colour at all.
                // Before the L20 splitter the merge cannot fan a trunk back
                // out, so this is also the early-level path for k ≥ 2. Only
                // the first chain anchors at its port; the next grows at that
                // chain's production point, so its miners land in the same
                // deposit cluster instead of crowding the factory block.
                let production = anchor;
                for (const port of chunk) {
                    const chain = session.buildColorChain(color, production);
                    if (!chain || !chain.ok) {
                        session.missing.add(`颜色:${color}`);
                        break;
                    }
                    if (
                        !session.layLink(
                            session.shapeLink(chain.building, chain.info, chain.outSlot, port.painter, port.info, port.slot, {
                                color: true,
                            })
                        )
                    ) {
                        break;
                    }
                    production = chain.anchor ?? production;
                }
                continue;
            }
            session.buildSharedColorNet(color, chunk, anchor);
        }
    }

    // 3d) an output port with nowhere to go backs up and stalls the machine, so
    // every cutter slot the plan does not use gets a trash can. The ejector hands
    // the item to whatever acceptor stands on the tile in front of it
    // (`systems/item_ejector.js`), so the can goes exactly there: no belt, and no
    // way for the last link of a crowded factory to be left unroutable.
    for (const step of flat.steps) {
        // a fused sibling has no building of its own: its slot is handled here
        if (step.fuseInto) continue;
        const info = BUILDING_INFO[step.op];
        if (!info || !info.outs || info.outs.length < 2) continue;
        const source = session.buildingOf(step.id);
        if (!source) continue;
        // every slot a consumer belts away: the rep's own, plus a fused
        // sibling's when that sibling's product is used
        const used = new Set<number>([outputSlot(step)]);
        for (const alias of aliasOf.get(step.id) || []) {
            const aliasStep = stepById.get(alias);
            if (aliasStep && consumersOf.get(alias)) used.add(outputSlot(aliasStep));
        }
        const cells = portCells(info, source.x, source.y, source.rot);
        const approaches = portApproachCells(info, source.x, source.y, source.rot);
        for (let slot = 0; slot < info.outs.length; slot++) {
            if (used.has(slot)) continue;
            const cell = cells[info.ins.length + slot];
            if (!cell) continue;
            const can: Placement = {
                step: `trash:${step.id}:${slot}`,
                stepId: `${idPrefix}trash:${step.id}:${slot}`,
                kind: "trash",
                zh: BUILDING_NAMES.trash,
                x: cell.x,
                y: cell.y,
                w: 1,
                h: 1,
                rot: 0,
            };
            session.buildings.push(can);
            shared.occupied.add(cellKey(cell.x, cell.y));
            shared.walls.add(cellKey(cell.x, cell.y));
            session.block([cellKey(cell.x, cell.y)]);
            // the side of the can the machine ejects into: opposite the port's
            // outward direction, so it is the side facing the body
            const approach = approaches[info.ins.length + slot];
            const outX = approach ? Math.sign(approach.x - cell.x) : 0;
            const outY = approach ? Math.sign(approach.y - cell.y) : -1;
            const inSlot = outY === -1 ? 2 : outY === 1 ? 0 : outX === -1 ? 1 : 3;
            session.layLink(session.shapeLink(source, info, slot, can, BUILDING_INFO.trash, inSlot, { waste: true, direct: true }));
        }
    }

    // 3e) rip up what a failed link ran into and let both sides try again
    session.schedule();

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
    for (const b of session.buildings) bom.set(b.zh, (bom.get(b.zh) || 0) + 1);

    return {
        hub,
        buildings: session.buildings,
        connections: session.connections,
        sources: session.sources,
        colors,
        missing: [...session.missing],
        routingGaps: session.routingGaps,
        beltEstimate: session.beltEstimate,
        bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
        steps: flat.steps,
    };
}
