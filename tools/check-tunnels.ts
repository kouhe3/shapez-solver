/**
 * Tunnel legality census over a campaign — the face-spaghetti instrument for
 * the tunnel fix (F16).
 *
 *   bun run check:tunnels                        # demo + full, seed 47742
 *   bun run check:tunnels --set=full --seed=47742
 *
 * 判据：退出码 0 = 图纸没有任何违规，且 routed 不低于 F16 的下限
 * （full 390 / demo 44；修完的实测值 396 / 46，余量留给无害抖动）。
 *
 * 本工具只做三件事：重建整张战役图、把图纸交给 `solver/src/validate.ts`、
 * 汇总每个 kind 的条数与阈值。规则本身（跨度、两端同向、劫持、端口朝向、
 * 地格归属唯一）全部由那个 module 独立重算，不复用 `routeBelt` 的推导，也不读
 * `World`——它是 sheet module 的私有状态，不是接口的一部分。
 *
 * 覆盖：种子 47742、中心 (-2,-2)、扫描半径 8（demo）/10（full），与
 * `bun run cli all 47742` 的默认一致；tier-0 隧道（两端间距 ≤ 5 格，
 * `undergroundBeltMaxTilesByTier[0]`）；sender / receiver 前后同向；隧道口
 * 占格、不压在地表带上；跨度内不得有同向隧道口（劫持/截断）；端口方向。
 * 从建筑物下方穿过的 run 是合法的（只有两端是建筑，中间格没有实体，
 * `ref/logic.js` 的 `checkCanPlaceEntity` 只看地表格），所以跨度内的机器格
 * 不算违规；隧道口仍然不得落在机器格上（它们必须是地表可放置格）。
 * 不覆盖：tier-2 隧道、带速/拥堵。
 *
 * 失效条件：游戏版本或 `undergroundBeltMaxTilesByTier` 变化、需求集变化、
 * 隧道画法/簿记字段改名 → 重跑并更新 F16 的基线；本工具的数字是快照。
 */
import { planCampaign } from "../solver/src/campaign.ts";
import { neededShapes, requiredTypes } from "../solver/src/needs.ts";
import { scanForTypes } from "../solver/src/map.ts";
import { ALL_BUILDINGS } from "../solver/src/solver.ts";
import { DEMO_LEVELS, FULL_LEVELS } from "../solver/src/levels.ts";
import { initRouterWasm } from "../solver/src/router-engine.ts";
import { VIOLATION_KINDS, validateSheet } from "../solver/src/validate.ts";
import type { ViolationKind } from "../solver/src/validate.ts";
import { readFileSync } from "node:fs";

initRouterWasm(readFileSync(new URL("../solver/router.wasm", import.meta.url)));

/**
 * routed floors registered in docs/facts.md F16: the measured legal layout
 * (demo 46 / full 396) minus a small jitter allowance. The pre-fix counts
 * (47 / 452) are not comparable: those layouts relied on illegal tunnels.
 */
const ROUTED_FLOOR: Record<"demo" | "full", number> = { demo: 44, full: 390 };

type TunnelReport = { routed: number; unrouted: number; spans: number } & Record<ViolationKind, number>;

function checkCampaign(set: "demo" | "full", seed: number): { report: TunnelReport; pass: boolean; gaps: number } {
    const shapes = neededShapes({ set });
    const scan = scanForTypes(seed, { types: requiredTypes(shapes), startRadius: set === "full" ? 10 : 8, maxRadius: 32 });
    const res = planCampaign({
        shapes,
        patches: scan.patches,
        hub: { x: -2, y: -2 },
        buildings: new Set(ALL_BUILDINGS),
        untilLevel: null,
        levels: set === "demo" ? DEMO_LEVELS : FULL_LEVELS,
    });
    const sheet = res.sheet;

    const counts = {} as Record<ViolationKind, number>;
    for (const kind of VIOLATION_KINDS) counts[kind] = 0;
    const report: TunnelReport = { routed: 0, unrouted: 0, spans: 0, ...counts };
    for (const conn of sheet.connections) {
        if (!conn.routed || !conn.path) {
            report.unrouted++;
            continue;
        }
        report.routed++;
        report.spans += conn.tunnelSpans.length;
    }
    for (const violation of validateSheet(sheet)) report[violation.kind] += 1;

    const bad = Object.entries(report).filter(([name, n]) => name !== "routed" && name !== "unrouted" && name !== "spans" && n !== 0);
    const pass = bad.length === 0 && report.routed >= ROUTED_FLOOR[set];
    return { report, pass, gaps: sheet.routingGaps.length };
}

const setConf = process.argv.find((a) => a.startsWith("--set="));
const seedConf = process.argv.find((a) => a.startsWith("--seed="));
const seed = seedConf ? Number(seedConf.slice("--seed=".length)) : 47742;
const sets: Array<"demo" | "full"> = setConf
    ? [setConf.slice("--set=".length) as "demo" | "full"]
    : ["demo", "full"];

let failed = false;
for (const set of sets) {
    if (set !== "demo" && set !== "full") {
        console.error(`unknown set: ${set}`);
        process.exit(2);
    }
    const started = Date.now();
    const { report, pass, gaps } = checkCampaign(set, seed);
    const bad = Object.entries(report).filter(([name, n]) => name !== "routed" && name !== "unrouted" && name !== "spans" && n !== 0);
    console.log(`${pass ? "PASS" : "FAIL"} ${set} seed=${seed} routed=${report.routed} floor=${ROUTED_FLOOR[set]} gaps=${gaps} spans=${report.spans} (${Date.now() - started} ms)`);
    for (const [name, n] of bad) console.log(`  ${name}=${n}`);
    if (!pass) failed = true;
}
process.exit(failed ? 1 : 0);
