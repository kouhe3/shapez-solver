/**
 * Fuzz: build random shapes with legal game operations, then ask the solver to
 * rebuild them. Any failure means the planner is missing a decomposition for a
 * shape that IS producible.
 *
 *   node test/fuzz.js [--n=40] [--seed=1234] [--budget=30000]
 */

import * as S from "../src/shape.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";

const args = process.argv.slice(2);
const flag = (name: string, dflt: number): string | number => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? (hit.split("=")[1] ?? "") : dflt;
};
const N = Number(flag("n", 40));
const SEED = Number(flag("seed", 1234));
const BUDGET = Number(flag("budget", 30000));

// xorshift32
let state = SEED >>> 0 || 1;
function rnd(): number {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
/** bias towards the shapes created later in the chain (they are the complex ones) */
const pickIdx = (len: number): number => Math.floor(rnd() * rnd() * len);

const TYPES: readonly S.ShapeType[] = ["C", "R", "S", "W"];
const COLORS: readonly S.ColorChar[] = ["r", "g", "b", "y", "p", "c", "w"];

function randomProducible(): S.Shape {
    const pool: S.Shape[] = [{ t: pick(TYPES), c: "u" }].map((base): S.Shape => {
        const layer: S.Layer = [0, 1, 2, 3].map(() => ({ t: base.t, c: "u" }));
        return { layers: [layer] };
    });
    const ops = 4 + Math.floor(rnd() * 7);
    for (let i = 0; i < ops; i++) {
        const op = Math.floor(rnd() * 10);
        if (op < 2) {
            const idx = pickIdx(pool.length);
            pool[idx] = S.rotate(pool[idx]!, pick(["CW", "CCW", "180"]));
        } else if (op < 4) {
            const idx = pickIdx(pool.length);
            const [a, b] = S.cutHalf(pool[idx]!);
            if (!S.isEntirelyEmpty(a)) pool.push(a);
            if (!S.isEntirelyEmpty(b)) pool.push(b);
        } else if (op < 5) {
            const idx = pickIdx(pool.length);
            pool[idx] = S.paint(pool[idx]!, pick(COLORS));
        } else {
            if (pool.length < 2) continue;
            const i = pickIdx(pool.length);
            // stacking a shape onto itself is the reliable way to grow layers
            let j = rnd() < 0.55 ? i : pickIdx(pool.length);
            try {
                const merged = S.stack(pool[i]!, pool[j]!);
                if (merged.layers.length <= 4) pool.push(merged);
            } catch (e) {
                /* collision — skip */
            }
        }
        if (pool.length > 24) pool.splice(0, pool.length - 24);
    }
    // grow depth on purpose so the solver sees 3-4 layer targets too
    for (let t = 0; t < 2; t++) {
        const deep = pool.reduce((a, b) => (b.layers.length > a.layers.length ? b : a));
        const other = pool[Math.floor(rnd() * pool.length)]!;
        try {
            const merged = S.stack(deep, other);
            if (merged.layers.length <= 4 && merged.layers.length > deep.layers.length) {
                pool.push(merged);
            }
        } catch (e) {
            /* skip */
        }
    }
    // target = the deepest/most complex shape we produced
    let best = pool[0]!;
    let bestScore = -1;
    for (const shape of pool) {
        const score = shape.layers.length * 100 + S.countCells(shape);
        if (score >= bestScore) {
            bestScore = score;
            best = shape;
        }
    }
    return best;
}

let failures = 0;
let totalMs = 0;
console.log(`fuzz: n=${N} seed=${SEED} budget=${BUDGET}`);
for (let i = 0; i < N; i++) {
    const target = randomProducible();
    const targetKey = S.hash(target);
    const t0 = Date.now();
    const res = solve(target, { buildings: ALL_BUILDINGS, maxAttempts: BUDGET });
    const ms = Date.now() - t0;
    totalMs += ms;
    if (!res.ok) {
        failures++;
        console.log(`  [FAIL] ${targetKey}  (${ms} ms) ${res.error}`);
        console.log(`         ${S.describeShape(target)}`);
    } else if (!res.verification.ok) {
        failures++;
        console.log(`  [BAD ] ${targetKey} verification failed`);
    } else {
        process.stdout.write(`  [ok] ${targetKey.padEnd(52)} cost=${String(res.cost).padStart(2)} ${ms}ms\n`);
    }
}
console.log(`\n${N - failures}/${N} producible shapes rebuilt, ${totalMs} ms total`);
process.exit(failures ? 1 : 0);
