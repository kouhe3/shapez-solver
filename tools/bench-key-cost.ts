/**
 * Tile-key lookup benchmark: packed numbers vs `"x|y"` strings.
 *
 *   bun run bench:key
 *
 * 判据：同进程内先字符串后数字、两边都已预热 —— `ratio = string / number`；
 * 当前 Bun 1.4.4 / JSC 实测约 16×，低于 5× 就说明引擎变了、数字键的收益假设要重估。
 *
 * 覆盖：单进程热缓存下的 `Map.get` + `Set.has`，1024 个坐标聚成 ~4k 个键、
 * 各 20000 轮读；这就是 `routeBelt` 每邻居查找的形态（见 `solver/src/layout.ts`
 * 的 `cellKey`）。
 * 不覆盖：GC 压力、多线程、真实路由负载 —— 端到端耗时看 `bun run check:tunnels`
 * 的墙钟（F19：full 集 9.0 s）。
 *
 * 失效条件：JSC / Bun 的小版本变化、键分布变化 → 重跑并把新比值写进
 * `docs/facts.md`，再决定 `World` 的键表示是否还值得保持数字。
 */
const N = 4000;
const READS = 20_000_000;
const smap = new Map<string, number>();
const nmap = new Map<number, number>();
const sset = new Set<string>();
const nset = new Set<number>();
for (let i = 0; i < N; i++) {
    const x = (i % 100) - 50;
    const y = Math.floor(i / 100) - 50;
    const sk = x + "|" + y;
    const nk = (x + 4096) * 8192 + (y + 4096);
    smap.set(sk, i);
    nmap.set(nk, i);
    if (i % 3 === 0) {
        sset.add(sk);
        nset.add(nk);
    }
}
const coords: number[] = [];
for (let i = 0; i < 1024; i++) coords.push((i % 100) - 50, Math.floor(i / 100) - 50);

function benchString(): number {
    let acc = 0;
    for (let r = 0; r < READS / 1024; r++) {
        for (let i = 0; i < 1024; i++) {
            const x = coords[i * 2]!;
            const y = coords[i * 2 + 1]!;
            const k = x + "|" + y;
            acc += smap.get(k) ?? 0;
            if (sset.has(k)) acc++;
        }
    }
    return acc;
}
function benchNumber(): number {
    let acc = 0;
    for (let r = 0; r < READS / 1024; r++) {
        for (let i = 0; i < 1024; i++) {
            const x = coords[i * 2]!;
            const y = coords[i * 2 + 1]!;
            const k = (x + 4096) * 8192 + (y + 4096);
            acc += nmap.get(k) ?? 0;
            if (nset.has(k)) acc++;
        }
    }
    return acc;
}

// warm both, then time
benchString();
benchNumber();
const t0 = performance.now();
const a = benchString();
const t1 = performance.now();
const b = benchNumber();
const t2 = performance.now();
if (a !== b) throw new Error(`benchmark mismatch: ${a} vs ${b}`);
console.log(`string: ${(t1 - t0).toFixed(0)} ms`);
console.log(`number: ${(t2 - t1).toFixed(0)} ms`);
console.log(`ratio string/number: ${((t1 - t0) / (t2 - t1)).toFixed(2)}x`);
