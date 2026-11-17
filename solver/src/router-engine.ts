/**
 * wasm binding for the Rust belt router (`native/router`) — the only router
 * engine. `routeBelt` keeps the `World` and the claim/spans bookkeeping; this
 * module keeps the wasm side of the world in step with it.
 *
 * The router owns a resident copy of every search-relevant cell, one u32 per
 * tile:
 *
 *   bits 0-7    flags: bit0 blocked, bit1 exempt, bit2 tunnel cell
 *   bits 8-15   belt: 0 none, 1 "h", 2 "v", 3 "turn"
 *   bits 16-23  end: 0 none, else direction index + 1
 *   bits 24-31  under: bitmask of tunnel directions running underneath
 *
 * `World` stays authoritative in JS. Every mutation of a mirrored structure
 * marks its tile in `World.router.dirty` (see `router-log.ts`); each search
 * flushes just those tiles — a packed key and its packed word — and wasm
 * builds the search box from its own pages. Encoding the whole map per search
 * (the old JS cost) is gone.
 */
import type { Tile, World } from "./layout.js";
import type { RouterLog } from "./router-log.js";

interface WasmExports {
    memory: WebAssembly.Memory;
    alloc(size: number): number;
    dealloc(ptr: number, size: number): void;
    new_world(): number;
    free_world(id: number): void;
    route(
        worldId: number,
        cellsPtr: number,
        cellsLen: number,
        exemptPtr: number,
        exemptLen: number,
        width: number,
        height: number,
        minX: number,
        minY: number,
        startX: number,
        startY: number,
        goalX: number,
        goalY: number,
        flags: number,
        startDir: number,
        goalDir: number
    ): number;
    result_ptr(): number;
}

const F_ALLOW_CROSS = 1;
const F_RELAX_CROSS = 2;
const F_GOAL_JOIN = 4;
const F_FRONTIER = 8;

let wasm: WasmExports | null = null;
/** bumped by every `initRouterWasm`; ids from an older instance are stale */
let epoch = 0;

/** scratch buffers inside wasm memory, sized in u32 cells */
let cellPtr = 0;
let cellCap = 0;
let exemptPtr = 0;
let exemptCap = 0;

/** compile and instantiate the module; the caller owns loading the bytes */
export function initRouterWasm(bytes: Uint8Array | ArrayBuffer): void {
    // copy into a plain ArrayBuffer: a SharedArrayBuffer-backed view is not a
    // valid module source, and the typed-array slice keeps the type honest
    const source = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes.slice();
    const module = new WebAssembly.Module(source);
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as WasmExports;
    if (!exports.memory || typeof exports.route !== "function" || typeof exports.new_world !== "function") {
        throw new Error("router wasm: bad exports");
    }
    wasm = exports;
    epoch++;
    cellPtr = 0;
    cellCap = 0;
    exemptPtr = 0;
    exemptCap = 0;
}

export interface RouterSearchResult {
    /** null when no legal run exists */
    cells: Tile[] | null;
    phases: number[];
    headings: number[];
    /** popped states over every attempt of this search */
    states: number;
    attempts: number;
    /**
     * true when the search tried to step outside its box at least once. false
     * on a failure means the box's whole reachable component was exhausted:
     * no wider box can produce a run, so callers may skip their wider pass.
     */
    boxLimited: boolean;
    /** milliseconds spent flushing changed cells to wasm */
    flushMs: number;
    /** milliseconds inside the search (box build included) */
    searchMs: number;
}

export interface RouterRequest {
    world: World;
    start: Tile;
    goal: Tile;
    minX: number;
    minY: number;
    width: number;
    height: number;
    allowCross: boolean;
    relaxCross: boolean;
    goalMayJoin: boolean;
    exempt: ReadonlySet<number> | null;
    /** index into the router's direction table, negative for "no direction" */
    startDir: number;
    goalDir: number;
    frontier: Set<number> | null;
}

/** grow a wasm scratch buffer to hold `count` u32 cells */
function reserveScratch(kind: "cells" | "exempt", count: number): number {
    const engine = wasm!;
    const used = kind === "cells" ? cellCap : exemptCap;
    if (count <= used) return kind === "cells" ? cellPtr : exemptPtr;
    // double instead of exact so a growing map does not realloc every search
    const next = Math.max(count, used * 2, 64);
    const bytes = next * 4;
    const oldPtr = kind === "cells" ? cellPtr : exemptPtr;
    if (oldPtr !== 0) engine.dealloc(oldPtr, used * 4);
    const ptr = engine.alloc(bytes);
    if (ptr === 0) throw new Error("router wasm: alloc failed");
    if (kind === "cells") {
        cellPtr = ptr;
        cellCap = next;
    } else {
        exemptPtr = ptr;
        exemptCap = next;
    }
    return ptr;
}

/** the packed word the router stores for one tile */
function cellWord(world: World, key: number): number {
    let word = 0;
    if (world.walls.has(key) || world.approaches.has(key) || world.blocked.has(key)) word |= 1;
    if (world.tunnelCells.has(key)) word |= 4;
    const belt = world.belts.get(key);
    if (belt !== undefined) word |= (belt === "h" ? 1 : belt === "v" ? 2 : 3) << 8;
    const end = world.tunnelEnds.get(key);
    if (end !== undefined) word |= (end + 1) << 16;
    const under = world.tunnelUnder.get(key);
    if (under !== undefined) word |= under << 24;
    return word >>> 0;
}

/** every authoritative cell, for a fresh wasm world (first search or a reset) */
function markWorldDirty(world: World): void {
    const dirty = world.router.dirty;
    for (const key of world.belts.keys()) dirty.add(key);
    for (const key of world.tunnelCells) dirty.add(key);
    for (const key of world.tunnelEnds.keys()) dirty.add(key);
    for (const key of world.tunnelUnder.keys()) dirty.add(key);
    for (const key of world.blocked) dirty.add(key);
    for (const key of world.walls) dirty.add(key);
    for (const key of world.approaches) dirty.add(key);
}

/** allocate (or revive) the wasm-side world this `World` talks to */
function worldId(world: World): number {
    const engine = wasm!;
    const log: RouterLog = world.router;
    if (log.id !== null && log.epoch === epoch) return log.id;
    log.id = engine.new_world();
    log.epoch = epoch;
    markWorldDirty(world);
    return log.id;
}

/** write the dirty cells into wasm and hand back the pair buffer */
function flushDirty(world: World): { ptr: number; count: number } {
    const dirty = world.router.dirty;
    const count = dirty.size;
    if (count === 0) return { ptr: 0, count: 0 };
    const ptr = reserveScratch("cells", count * 2);
    const view = new Uint32Array(wasm!.memory.buffer, ptr, count * 2);
    let at = 0;
    for (const key of dirty) {
        view[at++] = key;
        view[at++] = cellWord(world, key);
    }
    dirty.clear();
    // `count` is pairs; wasm takes the entry count (key + word)
    return { ptr, count: count * 2 };
}

/** drop the wasm-side state of a world that will never be routed again */
export function disposeRouterWorld(world: World): void {
    const log = world.router;
    const id = log.id;
    log.id = null;
    log.epoch = 0;
    log.dirty.clear();
    if (id !== null && wasm !== null) wasm.free_world(id);
}

export function routerSearch(req: RouterRequest): RouterSearchResult {
    const engine = wasm;
    if (!engine) throw new Error("router wasm: not initialised");
    const { world, start, goal, minX, minY, width, height } = req;
    // The wasm entry takes the box as raw integers; `NaN`/0 would slip past
    // the buffer check below (NaN comparisons are false) and trap in `route`.
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`router: bad box ${width}×${height}`);
    }
    const id = worldId(world);

    const t0 = performance.now();
    const cells = flushDirty(world);
    const exempt = req.exempt;
    let exemptCount = 0;
    if (exempt !== null && exempt.size > 0) {
        exemptCount = exempt.size;
        const ptr = reserveScratch("exempt", exemptCount);
        const view = new Uint32Array(engine.memory.buffer, ptr, exemptCount);
        let at = 0;
        for (const key of exempt) view[at++] = key;
    }
    let flags = 0;
    if (req.allowCross) flags |= F_ALLOW_CROSS;
    if (req.relaxCross) flags |= F_RELAX_CROSS;
    if (req.goalMayJoin) flags |= F_GOAL_JOIN;
    if (req.frontier) flags |= F_FRONTIER;
    const t1 = performance.now();

    const ptr = engine.route(
        id,
        cells.ptr,
        cells.count,
        exemptPtr,
        exemptCount,
        width,
        height,
        minX,
        minY,
        start.x,
        start.y,
        goal.x,
        goal.y,
        flags,
        req.startDir,
        req.goalDir
    );
    const t2 = performance.now();

    // the call may have grown memory while building the answer
    const head = new DataView(engine.memory.buffer, ptr, 20);
    const pathLen = head.getUint32(0, true);
    const frontierLen = head.getUint32(4, true);
    const states = head.getUint32(8, true);
    const attempts = head.getUint32(12, true);
    const boxLimited = head.getUint32(16, true) !== 0;
    const view = new DataView(engine.memory.buffer, ptr, 20 + pathLen * 12 + frontierLen * 4);
    let off = 20 + pathLen * 12;
    if (req.frontier) {
        for (let i = 0; i < frontierLen; i++) {
            req.frontier.add(view.getUint32(off, true));
            off += 4;
        }
    }
    if (pathLen === 0) {
        return { cells: null, phases: [], headings: [], states, attempts, boxLimited, flushMs: t1 - t0, searchMs: t2 - t1 };
    }
    off = 20;
    const cellsOut: Tile[] = new Array(pathLen);
    const phases: number[] = new Array(pathLen);
    const headings: number[] = new Array(pathLen);
    for (let i = 0; i < pathLen; i++) {
        const index = view.getUint32(off, true);
        phases[i] = view.getUint32(off + 4, true);
        headings[i] = view.getUint32(off + 8, true);
        cellsOut[i] = { x: (index % width) + minX, y: Math.floor(index / width) + minY };
        off += 12;
    }
    return { cells: cellsOut, phases, headings, states, attempts, boxLimited, flushMs: t1 - t0, searchMs: t2 - t1 };
}
