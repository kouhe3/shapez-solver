/**
 * Synthetic routing benchmark: a bare grid with random block obstacles and a
 * fixed list of nets, routed one after another into the same world. No game
 * map, no savegame — just "can the router route this density".
 *
 *   bun work/bench-router.ts [--size=64] [--nets=80] [--seed=7]
 */
import { createWorld, routeBelt, type World } from "../solver/src/layout.ts";
import { initRouterWasm } from "../solver/src/router-engine.ts";
import { readFileSync } from "node:fs";

const arg = (name: string, fallback: number): number => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.slice(name.length + 3)) : fallback;
};

const SIZE = arg("size", 64);
const NETS = arg("nets", 80);
const SEED = arg("seed", 7);
const MODE = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "random";
const DISTINCT = arg("distinct", 0) === 1;
const DEBUG = arg("debug", 0) === 1;
initRouterWasm(readFileSync(new URL("../solver/router.wasm", import.meta.url)));

function mulberry32(a: number): () => number {
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const HALF = SIZE / 2;
const keyOf = (x: number, y: number): number => (x + 4096) * 8192 + (y + 4096);
const inGrid = (x: number, y: number): boolean => x >= -HALF && x < HALF && y >= -HALF && y < HALF;

interface Scenario {
    blocks: number;
    blockSize: number;
}

const SCENARIOS: Scenario[] = [
    { blocks: 0, blockSize: 0 },
    { blocks: 40, blockSize: 3 },
    { blocks: 40, blockSize: 5 },
    { blocks: 80, blockSize: 4 },
    { blocks: 160, blockSize: 3 },
    { blocks: 160, blockSize: 5 },
];

function run(scenario: Scenario, seed: number) {
    const rng = mulberry32(seed);
    const world: World = createWorld({ hub: { x: 0, y: 0 }, patches: [] });

    // random rectangular walls, roughly uniform over the grid
    for (let i = 0; i < scenario.blocks; i++) {
        const w = 1 + Math.floor(rng() * scenario.blockSize);
        const h = 1 + Math.floor(rng() * scenario.blockSize);
        const x0 = -HALF + Math.floor(rng() * (SIZE - w));
        const y0 = -HALF + Math.floor(rng() * (SIZE - h));
        for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
                if (inGrid(x0 + dx, y0 + dy)) world.walls.add(keyOf(x0 + dx, y0 + dy));
            }
        }
    }

    const free: { x: number; y: number }[] = [];
    for (let x = -HALF; x < HALF; x++) {
        for (let y = -HALF; y < HALF; y++) {
            if (!world.walls.has(keyOf(x, y))) free.push({ x, y });
        }
    }
    if (free.length < 2) return { scenario, routed: 0, gaps: 0, beltCells: 0, cost: 0, ms: 0, free: free.length };

    // endpoints are ports: a route may not swallow another net's terminal tile
    const nets: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    const blocked = new Set<number>(world.walls);
    for (let i = 0; i < NETS; i++) {
        const a = free[Math.floor(rng() * free.length)]!;
        const b = free[Math.floor(rng() * free.length)]!;
        if (a.x === b.x && a.y === b.y) continue;
        nets.push({ a, b });
        blocked.add(keyOf(a.x, a.y));
        blocked.add(keyOf(b.x, b.y));
    }

    const t0 = performance.now();
    let routed = 0;
    let cost = 0;
    for (const net of nets) {
        const run = routeBelt(world, blocked, net.a, net.b, { allowCross: true, margin: 20 });
        if (!run) continue;
        routed++;
        cost += run.cells.length;
    }
    const ms = performance.now() - t0;
    let beltCells = 0;
    for (const _ of world.belts) beltCells++;
    return { scenario, routed, gaps: nets.length - routed, beltCells, cost, ms, free: free.length };
}

console.log(`grid ${SIZE}x${SIZE} · ${NETS} nets · seed ${SEED}\n`);
if (MODE === "factory" || MODE === "chain") {
    // factories as solid blocks; one root link per block into the hub, exactly
    // the campaign's shape. The knob is the corridor between blocks.
    const F = arg("blocks", 16);
    const BW = arg("blockw", 12);
    const BH = arg("blockh", 10);
    console.log(MODE === "chain" ? " gap  blk   root        chain      belts    ms" : " gap   blk  routed  gaps   belts    ms   avgLen");
    for (const gap of [2, 4, 6, 8, 12]) {
        const world = createWorld({ hub: { x: 0, y: 0 }, patches: [] });
        const step = Math.ceil(Math.sqrt(F));
        const pitchX = BW + gap;
        const pitchY = BH + gap;
        const blocks: { x: number; y: number }[] = [];
        for (let i = 0; i < F; i++) {
            const cx = (i % step) - (step - 1) / 2;
            const cy = Math.floor(i / step) - (Math.ceil(F / step) - 1) / 2;
            const x0 = Math.round(cx * pitchX);
            const y0 = Math.round(cy * pitchY);
            // never cover the hub footprint
            if (x0 < 4 && x0 + BW > -2 && y0 < 4 && y0 + BH > -2) continue;
            blocks.push({ x: x0, y: y0 });
            for (let dx = 0; dx < BW; dx++) {
                for (let dy = 0; dy < BH; dy++) world.walls.add(keyOf(x0 + dx, y0 + dy));
            }
        }

        const blocked = new Set<number>(world.walls);
        const nets: { a: { x: number; y: number }; b: { x: number; y: number }; kind: "root" | "chain" }[] = [];
        // the hub footprint is (0..3, 0..3); these are its outside ring tiles
        const entries = [
            { x: -1, y: -1 },
            { x: 0, y: -1 },
            { x: 1, y: -1 },
            { x: 2, y: -1 },
            { x: 3, y: -1 },
            { x: 4, y: -1 },
            { x: -1, y: 0 },
            { x: -1, y: 1 },
            { x: -1, y: 2 },
            { x: -1, y: 3 },
            { x: 4, y: 0 },
            { x: 4, y: 1 },
            { x: 4, y: 2 },
            { x: 4, y: 3 },
            { x: 0, y: 4 },
            { x: 1, y: 4 },
        ];
        // a receiver has to eject straight into the hub, so the last move is
        // fixed: towards the hub body. Without this an underground approach can
        // never finish, and a belt on the only free face seals the entry.
        const goalDirOf = (e: { x: number; y: number }): readonly [number, number] => {
            if (e.x === -1) return [1, 0];
            if (e.x === 4) return [-1, 0];
            if (e.y === -1) return [0, 1];
            return [0, -1];
        };
        const usedEntries = new Set<number>();
        for (const b of blocks) {
            const cx = b.x + BW / 2;
            const cy = b.y + BH / 2;
            const faceX = cx < 0 ? b.x + BW : b.x - 1;
            const faceY = Math.round(cy);
            const a = { x: faceX, y: faceY };
            let bestI = -1;
            let bestDist = Infinity;
            for (let i = 0; i < entries.length; i++) {
                if (DISTINCT && usedEntries.has(i)) continue;
                const e = entries[i]!;
                const d = Math.hypot(e.x - a.x, e.y - a.y);
                if (d < bestDist) {
                    bestDist = d;
                    bestI = i;
                }
            }
            if (bestI < 0) bestI = 0;
            const best = entries[bestI]!;
            usedEntries.add(bestI);
            nets.push({ a, b: best, kind: "root" });
            blocked.add(keyOf(a.x, a.y));
            blocked.add(keyOf(best.x, best.y));
        }

        // colour chains: one long link from each block to its neighbour, the
        // shape that fills the campaign's corridors
        if (MODE === "chain") {
            for (let i = 0; i < blocks.length; i++) {
                const b1 = blocks[i]!;
                const b2 = blocks[(i + 1) % blocks.length]!;
                const rightward = b2.x > b1.x;
                const a = { x: rightward ? b1.x + BW : b1.x - 1, y: b1.y + Math.floor(BH / 2) };
                const b = { x: rightward ? b2.x - 1 : b2.x + BW, y: b2.y + Math.floor(BH / 2) };
                nets.push({ a, b, kind: "chain" });
                blocked.add(keyOf(a.x, a.y));
                blocked.add(keyOf(b.x, b.y));
            }
        }

        const t0 = performance.now();
        let routed = 0;
        let chainRouted = 0;
        let chainTotal = 0;
        let rootRouted = 0;
        let rootTotal = 0;
        let cost = 0;
        for (const net of nets) {
            if (net.kind === "chain") chainTotal++;
            else rootTotal++;
            const gdir = net.kind === "root" ? goalDirOf(net.b) : null;
            const run = routeBelt(world, blocked, net.a, net.b, {
                allowCross: true,
                goalMayJoin: true,
                goalDir: gdir,
                margin: 20,
            });
            if (!run) {
                const wide = routeBelt(world, blocked, net.a, net.b, {
                    allowCross: true,
                    goalMayJoin: true,
                    goalDir: gdir,
                    margin: 60,
                });
                if (!wide) {
                    if (DEBUG) {
                        const around = (t: { x: number; y: number }): string =>
                            [
                                [1, 0],
                                [-1, 0],
                                [0, 1],
                                [0, -1],
                            ]
                                .map(([dx, dy]) => {
                                    const k = keyOf(t.x + dx!, t.y + dy!);
                                    return `${world.walls.has(k) ? "W" : world.belts.has(k) ? "B" : blocked.has(k) ? "X" : "."}`;
                                })
                                .join("");
                        console.log(
                            `  fail ${net.kind} (${net.a.x},${net.a.y})->(${net.b.x},${net.b.y}) ` +
                                `d=${Math.abs(net.a.x - net.b.x) + Math.abs(net.a.y - net.b.y)} ` +
                                `a[${around(net.a)}] b[${around(net.b)}] belts=${world.belts.size}`
                        );
                    }
                    continue;
                }
                routed++;
                if (net.kind === "chain") chainRouted++;
                else rootRouted++;
                cost += wide.cells.length;
                continue;
            }
            routed++;
            if (net.kind === "chain") chainRouted++;
            else rootRouted++;
            cost += run.cells.length;
        }
        const ms = performance.now() - t0;
        const avg = routed ? (cost / routed).toFixed(1) : "-";
        if (MODE === "chain") {
            console.log(
                `${String(gap).padStart(4)}  ${String(blocks.length).padStart(4)}  ` +
                    `${`${rootRouted}/${rootTotal}`.padStart(9)}  ${`${chainRouted}/${chainTotal}`.padStart(9)}  ` +
                    `${String(world.belts.size).padStart(6)}  ${ms.toFixed(0).padStart(5)}`
            );
            continue;
        }
        console.log(
            `${String(gap).padStart(4)}  ${String(blocks.length).padStart(5)}  ${String(routed).padStart(6)}  ` +
                `${String(nets.length - routed).padStart(4)}  ${String(world.belts.size).padStart(6)}  ` +
                `${ms.toFixed(0).padStart(5)}  ${avg.padStart(6)}`
        );
    }
    process.exit(0);
}

console.log("blocks   size   free   routed  gaps   beltCells  avgLen  ms");
for (const s of SCENARIOS) {
    const r = run(s, SEED);
    const avg = r.routed ? (r.cost / r.routed).toFixed(1) : "-";
    console.log(
        `${String(s.blocks).padStart(6)}  ${String(s.blockSize).padStart(4)}  ${String(r.free).padStart(5)}  ` +
            `${String(r.routed).padStart(6)}  ${String(r.gaps).padStart(4)}  ${String(r.beltCells).padStart(9)}  ` +
            `${avg.padStart(6)}  ${r.ms.toFixed(0).padStart(5)}`
    );
}
