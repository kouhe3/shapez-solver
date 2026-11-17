/**
 * wasm binding for the Rust belt router (`native/router`) — the only router
 * engine. `routeBelt` keeps the `World` and the claim/spans bookkeeping; this
 * module ships the search box to wasm.
 *
 * One u32 per cell is the router's whole view of the map, indexed
 * `(y - minY) * width + (x - minX)` and packed little-endian:
 *
 *   bits 0-7    flags: bit0 blocked, bit1 exempt, bit2 tunnel cell
 *   bits 8-15   belt: 0 none, 1 "h", 2 "v", 3 "turn"
 *   bits 16-23  end: 0 none, else direction index + 1
 *   bits 24-31  under: bitmask of tunnel directions running underneath
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
    /**
     * true when the search tried to step outside its box at least once. false
     * on a failure means the box's whole reachable component was exhausted:
     * no wider box can produce a run, so callers may skip their wider pass.
     */
    boxLimited: boolean;
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
    // The wasm entry takes the box as raw integers; `NaN`/0 would slip past
    // the buffer check below (NaN comparisons are false) and trap in `route`.
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`router: bad box ${width}×${height}`);
    }

    const t0 = performance.now();
    if (size * 4 > inputCap) {
        if (inputPtr !== 0) engine.dealloc(inputPtr, inputCap);
        inputPtr = engine.alloc(size * 4);
        inputCap = size * 4;
        if (inputPtr === 0) throw new Error("router wasm: alloc failed");
    }
    // `alloc` may have grown the heap, so the view is created after it. One
    // little-endian u32 per cell: flags | belt << 8 | end << 16 | under << 24.
    const words = new Uint32Array(engine.memory.buffer, inputPtr, size);
    const exempt = req.exempt;
    /** box index of a packed tile key, or -1 when it sits outside the box */
    const indexInBox = (key: number): number => {
        const ix = Math.floor(key / 8192) - 4096 - minX;
        if (ix < 0 || ix >= width) return -1;
        const iy = (key % 8192) - 4096 - minY;
        if (iy < 0 || iy >= height) return -1;
        return iy * width + ix;
    };
    // The map is sparse: most tiles carry nothing at all. Walking the six
    // structures beats one Set/Map lookup per box cell as soon as the box is
    // bigger than the number of entries, which is exactly the wide boxes
    // where encoding used to cost the most.
    const entries =
        blocked.size +
        (exempt === null ? 0 : exempt.size) +
        world.tunnelCells.size +
        world.belts.size +
        world.tunnelEnds.size +
        world.tunnelUnder.size;
    if (size > entries) {
        words.fill(0);
        for (const key of blocked) {
            const i = indexInBox(key);
            if (i >= 0) words[i] = (words[i] ?? 0) | 1;
        }
        if (exempt !== null) {
            for (const key of exempt) {
                const i = indexInBox(key);
                if (i >= 0) words[i] = (words[i] ?? 0) | 2;
            }
        }
        for (const key of world.tunnelCells) {
            const i = indexInBox(key);
            if (i >= 0) words[i] = (words[i] ?? 0) | 4;
        }
        for (const [key, heading] of world.belts) {
            const i = indexInBox(key);
            if (i >= 0) words[i] = (words[i] ?? 0) | ((heading === "h" ? 1 : heading === "v" ? 2 : 3) << 8);
        }
        for (const [key, dir] of world.tunnelEnds) {
            const i = indexInBox(key);
            if (i >= 0) words[i] = (words[i] ?? 0) | ((dir + 1) << 16);
        }
        for (const [key, under] of world.tunnelUnder) {
            const i = indexInBox(key);
            if (i >= 0) words[i] = (words[i] ?? 0) | (under << 24);
        }
    } else {
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
                const belt = world.belts.get(key);
                const end = world.tunnelEnds.get(key);
                words[i] =
                    f |
                    ((belt === undefined ? 0 : belt === "h" ? 1 : belt === "v" ? 2 : 3) << 8) |
                    ((end === undefined ? 0 : end + 1) << 16) |
                    ((world.tunnelUnder.get(key) ?? 0) << 24);
            }
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
        return { cells: null, phases: [], headings: [], states, attempts, boxLimited, encodeMs: t1 - t0, searchMs: t2 - t1 };
    }
    off = 20;
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
    return { cells, phases, headings, states, attempts, boxLimited, encodeMs: t1 - t0, searchMs: t2 - t1 };
}
