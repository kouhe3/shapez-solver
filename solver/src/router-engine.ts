/**
 * wasm binding for the Rust belt router (`native/router`) — the only router
 * engine. `routeBelt` keeps the `World` and the claim/spans bookkeeping; this
 * module ships the search box to wasm.
 *
 * The four byte planes are the router's whole view of the map:
 *
 *   flags  bit0 blocked, bit1 exempt, bit2 tunnel cell
 *   belt   0 none, 1 "h", 2 "v", 3 "turn"
 *   end    0 none, else direction index + 1
 *   under  bitmask of tunnel directions running underneath
 *
 * Plane order in wasm memory is `flags, belt, end, under`, each
 * `width * height` bytes, indexed `(y - minY) * width + (x - minX)`.
 */
import type { Tile, World } from "./layout.js";

interface WasmExports {
    memory: WebAssembly.Memory;
    alloc(size: number): number;
    dealloc(ptr: number, size: number): void;
    route(
        input: number,
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

/** packed tile key, identical to `cellKey` in layout.ts */
const keyOf = (x: number, y: number): number => (x + 4096) * 8192 + (y + 4096);

let wasm: WasmExports | null = null;
let inputPtr = 0;
let inputCap = 0;

/** compile and instantiate the module; the caller owns loading the bytes */
export function initRouterWasm(bytes: Uint8Array | ArrayBuffer): void {
    // copy into a plain ArrayBuffer: a SharedArrayBuffer-backed view is not a
    // valid module source, and the typed-array slice keeps the type honest
    const source = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes.slice();
    const module = new WebAssembly.Module(source);
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as WasmExports;
    if (!exports.memory || typeof exports.route !== "function") {
        throw new Error("router wasm: bad exports");
    }
    wasm = exports;
    inputPtr = 0;
    inputCap = 0;
}

export interface RouterSearchResult {
    /** null when no legal run exists */
    cells: Tile[] | null;
    phases: number[];
    headings: number[];
    /** popped states over every attempt of this search */
    states: number;
    attempts: number;
    /** milliseconds spent writing the planes */
    encodeMs: number;
    /** milliseconds inside the search */
    searchMs: number;
}

export interface RouterRequest {
    world: World;
    blocked: ReadonlySet<number>;
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

export function routerSearch(req: RouterRequest): RouterSearchResult {
    const engine = wasm;
    if (!engine) throw new Error("router wasm: not initialised");
    const { world, blocked, start, goal, minX, minY, width, height } = req;
    const size = width * height;

    const t0 = performance.now();
    if (size * 4 > inputCap) {
        if (inputPtr !== 0) engine.dealloc(inputPtr, inputCap);
        inputPtr = engine.alloc(size * 4);
        inputCap = size * 4;
        if (inputPtr === 0) throw new Error("router wasm: alloc failed");
    }
    // `alloc` may have grown the heap, so the view is created after it
    const planes = new Uint8Array(engine.memory.buffer, inputPtr, size * 4);
    const exempt = req.exempt;
    const flagsPlane = planes.subarray(0, size);
    const beltPlane = planes.subarray(size, 2 * size);
    const endPlane = planes.subarray(2 * size, 3 * size);
    const underPlane = planes.subarray(3 * size, 4 * size);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        const wy = minY + y;
        for (let x = 0; x < width; x++) {
            const i = row + x;
            const key = keyOf(minX + x, wy);
            let f = 0;
            if (blocked.has(key)) f |= 1;
            if (exempt !== null && exempt.has(key)) f |= 2;
            if (world.tunnelCells.has(key)) f |= 4;
            flagsPlane[i] = f;
            const belt = world.belts.get(key);
            beltPlane[i] = belt === undefined ? 0 : belt === "h" ? 1 : belt === "v" ? 2 : 3;
            const end = world.tunnelEnds.get(key);
            endPlane[i] = end === undefined ? 0 : end + 1;
            underPlane[i] = world.tunnelUnder.get(key) ?? 0;
        }
    }
    let flags = 0;
    if (req.allowCross) flags |= F_ALLOW_CROSS;
    if (req.relaxCross) flags |= F_RELAX_CROSS;
    if (req.goalMayJoin) flags |= F_GOAL_JOIN;
    if (req.frontier) flags |= F_FRONTIER;
    const t1 = performance.now();

    const ptr = engine.route(
        inputPtr,
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
    const head = new DataView(engine.memory.buffer, ptr, 16);
    const pathLen = head.getUint32(0, true);
    const frontierLen = head.getUint32(4, true);
    const states = head.getUint32(8, true);
    const attempts = head.getUint32(12, true);
    const view = new DataView(engine.memory.buffer, ptr, 16 + pathLen * 12 + frontierLen * 4);
    let off = 16 + pathLen * 12;
    if (req.frontier) {
        for (let i = 0; i < frontierLen; i++) {
            req.frontier.add(view.getUint32(off, true));
            off += 4;
        }
    }
    if (pathLen === 0) {
        return { cells: null, phases: [], headings: [], states, attempts, encodeMs: t1 - t0, searchMs: t2 - t1 };
    }
    off = 16;
    const cells: Tile[] = new Array(pathLen);
    const phases: number[] = new Array(pathLen);
    const headings: number[] = new Array(pathLen);
    for (let i = 0; i < pathLen; i++) {
        const index = view.getUint32(off, true);
        phases[i] = view.getUint32(off + 4, true);
        headings[i] = view.getUint32(off + 8, true);
        cells[i] = { x: (index % width) + minX, y: Math.floor(index / width) + minY };
        off += 12;
    }
    return { cells, phases, headings, states, attempts, encodeMs: t1 - t0, searchMs: t2 - t1 };
}
