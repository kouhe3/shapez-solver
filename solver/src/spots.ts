/**
 * Where parts may stand: the spot policy of one factory.
 *
 * A placement pass asks four things of the tile world — does this part fit
 * here, reserve it, give it back, find me a spot near an anchor — and the
 * router needs one derived set out of the same answers: the tiles no belt may
 * cross. Both live here so a rejected candidate and a blocked route agree on
 * what is taken.
 *
 * The factory window itself (`allocateBlock`), the deposit a factory grows
 * around (`factoryAnchor`) and the miner that takes a patch tile
 * (`placeExtractor`) are spot decisions too: they write the same bookkeeping,
 * just at a much coarser grain.
 */

import type { MapItem, Patch } from "./map.js";
import {
    BUILDING_INFO,
    cellKey,
    patchCellsByCentre,
    portApproachCells,
    portCells,
    rotatedSize,
} from "./layout.js";
import type { BlockRect, BuildingInfo, PlanTree, Rot, Tile, World } from "./layout.js";

/* ------------------------------------------------------------------ *
 * one factory's claims
 * ------------------------------------------------------------------ */

/** tiles one placement took, so a rejected candidate can be undone */
export interface Claim {
    cells: number[];
}

/** a processor may only sit on bare ground */
function processorFree(world: World, x: number, y: number): boolean {
    const k = cellKey(x, y);
    return !world.occupied.has(k) && !world.deposits.has(k);
}

export interface TileClaims {
    /**
     * What the router may not cross: every machine body, port and belt approach
     * on this map, earlier factories included. A part is tried in several spots
     * and turns while it is being placed, so the set follows the world instead
     * of being rebuilt for every search.
     */
    readonly blocked: Set<number>;
    /** can `info` stand at (x, y) turned `rot`? Reserves nothing */
    fits(info: BuildingInfo, x: number, y: number, rot: Rot): boolean;
    /** reserve every tile `info` needs; a rejected candidate is undone by `release` */
    reserve(info: BuildingInfo, x: number, y: number, rot: Rot): Claim;
    release(claim: Claim): void;
    /** first free spot for `info` around `anchor`, reserved */
    placeNear(info: BuildingInfo, anchor: Tile, rot?: Rot): Tile | null;
    /** every tile around `anchor` the part fits on, nearest ring first, unreserved */
    nearFits(info: BuildingInfo, anchor: Tile, rot: Rot): Generator<Tile>;
    /** keep these tiles off every later belt (a miner's claim, a trash can) */
    block(cells: Iterable<number>): void;
}

export function createTileClaims(world: World): TileClaims {
    const blocked = new Set<number>([...world.walls, ...world.approaches]);

    /** can `info` stand at (x, y) turned `rot`? Reserves nothing. */
    function fits(info: BuildingInfo, x: number, y: number, rot: Rot): boolean {
        const size = rotatedSize(info, rot);
        for (let dx = 0; dx < size.w; dx++) {
            for (let dy = 0; dy < size.h; dy++) {
                const key = cellKey(x + dx, y + dy);
                if (!processorFree(world, x + dx, y + dy)) return false;
                // a body over another part's port or approach would wall it in
                if (world.walls.has(key) || world.approaches.has(key)) return false;
            }
        }
        // a port cannot share a tile with another part's body, port or belt,
        // and the belt beyond it needs a clear tile to run through
        for (const c of [...portCells(info, x, y, rot), ...portApproachCells(info, x, y, rot)]) {
            const key = cellKey(c.x, c.y);
            if (world.walls.has(key) || world.belts.has(key) || world.tunnelEnds.has(key) || world.approaches.has(key)) return false;
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
                world.occupied.add(key);
                world.walls.add(key);
                blocked.add(key);
                cells.push(key);
            }
        }
        for (const c of portCells(info, x, y, rot)) {
            const key = cellKey(c.x, c.y);
            world.walls.add(key);
            blocked.add(key);
            cells.push(key);
        }
        for (const c of portApproachCells(info, x, y, rot)) {
            const key = cellKey(c.x, c.y);
            world.approaches.add(key);
            world.occupied.add(key);
            blocked.add(key);
            cells.push(key);
        }
        return { cells };
    }

    /** undo `reserve` — safe only while nothing else touched those tiles */
    function release(claim: Claim): void {
        for (const key of claim.cells) {
            world.occupied.delete(key);
            world.walls.delete(key);
            world.approaches.delete(key);
            blocked.delete(key);
        }
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

    /** keep these tiles off every later belt (a miner's claim, a trash can) */
    function block(cells: Iterable<number>): void {
        for (const key of cells) blocked.add(key);
    }

    return { blocked, fits, reserve, release, placeNear, nearFits, block };
}

/* ------------------------------------------------------------------ *
 * coarse spot decisions: mine, window, anchor
 * ------------------------------------------------------------------ */

export interface ExtractorSite {
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
export function placeExtractor(
    claims: TileClaims,
    world: World,
    predicate: (item: MapItem) => boolean,
    from: Tile
): ExtractorSite | null {
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
            claims.block(cells);
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
export function allocateBlock(
    world: World,
    width: number,
    height: number,
    gap: number,
    anchor: Tile = world.hub
): BlockRect | null {
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
export function factoryAnchor(world: World, flat: PlanTree): Tile {
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
