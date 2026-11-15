/**
 * Harness self-check: `--filter` selection, `--timings` output, section partition.
 *
 *   bun run check:filter
 *
 * 判据：退出码 0 = 下面每一条都成立——
 * (1) 无参跑出 209 checks / 0 failure；
 * (2) 对每个 `beginSection` 名字用转义后的 `^名$` 过滤，每次 exit 0、0 failure、
 *     checks > 0、checks + skipped = 总数，且所有 section 的 checks 之和 = 总数
 *     （分区无重叠、无遗漏）；
 * (3) `--timings` 每个 section 恰好一行 `(N checks, M fail, X ms)`，全部 0 fail；
 * (4) 无命中的过滤器 exit 1，空 / 裸 `--filter` 与坏正则各 exit 2。
 *
 * 覆盖：`solver/test/run-tests.ts` 的默认 lane（含两段关卡语料循环）。
 * 不覆盖 `--quick` lane：那里语料循环不跑，两个语料 section 不存在，分区和
 * 小于总数。
 *
 * 失效条件：`beginSection` / footer 文案 / `--filter` 语义改动，或新增了不在
 * 任何 section 里的 check —— 本工具会红；先按新口径修工具，再改 F17。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RUNNER = join(ROOT, "solver", "test", "run-tests.ts");
const SECTIONS = [...readFileSync(RUNNER, "utf8").matchAll(/beginSection\("([^"]+)"\)/g)].map((m) => m[1]!);

interface Run {
    status: number;
    out: string;
}

function run(...args: string[]): Run {
    const proc = Bun.spawnSync([process.execPath, RUNNER, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { status: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() };
}

interface Footer {
    checks: number;
    failures: number;
    skipped: number;
}

function footer(out: string): Footer | null {
    const m = /(\d+) checks, (\d+) failure\(s\)(?:, (\d+) skipped)?/.exec(out);
    return m ? { checks: Number(m[1]), failures: Number(m[2]), skipped: Number(m[3] ?? 0) } : null;
}

/** regex-escape a section name so the anchored filter matches it literally */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let bad = 0;
function judge(ok: boolean, lane: string, detail: string): void {
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${lane} — ${detail}`);
}

const base = run();
const total = footer(base.out);
judge(
    base.status === 0 && total !== null && total.failures === 0 && total.skipped === 0,
    "default lane",
    total ? `exit=${base.status}, ${total.checks} checks / ${total.failures} failure(s)` : "no footer parsed"
);
const expected = total?.checks ?? 0;

let partition = 0;
for (const name of SECTIONS) {
    const res = run(`--filter=^${literal(name)}$`);
    const f = footer(res.out);
    partition += f?.checks ?? 0;
    judge(
        res.status === 0 && f !== null && f.failures === 0 && f.checks > 0 && f.checks + f.skipped === expected,
        name,
        f ? `${f.checks} checks + ${f.skipped} skipped` : "no footer parsed"
    );
}
judge(partition === expected, "section partition", `${partition} of ${expected} checks`);

const noMatch = run("--filter=__no_such_check__");
judge(noMatch.status === 1 && noMatch.out.includes("no check matched"), "no-match filter", `exit=${noMatch.status}`);
const badRegex = run("--filter=[");
judge(badRegex.status === 2, "bad regex", `exit=${badRegex.status}`);
const bare = run("--filter");
judge(bare.status === 2, "bare --filter", `exit=${bare.status}`);
const empty = run("--filter=");
judge(empty.status === 2, "empty --filter", `exit=${empty.status}`);

const timed = run("--timings");
const stats = timed.out.split("\n").filter((line) => /^ {2}\(\d+ checks, \d+ fail, [\d.]+ ms\)$/.test(line));
judge(
    timed.status === 0 && stats.length === SECTIONS.length && stats.every((line) => line.includes(", 0 fail,")),
    "--timings",
    `${stats.length}/${SECTIONS.length} section lines`
);

console.log(`\n${SECTIONS.length} sections, ${bad === 0 ? "every lane passes" : `${bad} failure(s)`}`);
process.exit(bad ? 1 : 0);
