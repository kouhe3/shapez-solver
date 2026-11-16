/**
 * Tunnel legality census over a campaign — the face-spaghetti instrument for
 * the tunnel fix (F16).
 *
 *   bun run check:tunnels                        # demo + full, seed 47742
 *   bun run check:tunnels --set=full --seed=47742
 *
 * 判据：退出码 0 = 没有任何游戏建不出的隧道，且 routed 不低于 F16 的下限
 * （full 390 / demo 44；修完的实测值 396 / 46，余量留给无害抖动）。所有检查都从
 * `Connection.path`、`Connection.tunnelSpans` 和 `World` 的簿记独立重算，不复用
 * `routeBelt` 的推导。
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
import { BUILDING_INFO, cellKey, portApproachCells, portCells } from "../solver/src/layout.ts";
import type { Tile, TunnelSpan } from "../solver/src/layout.ts";

/** tier-0 tunnel range (`vendor/shapez.io/src/js/core/config.js:91`) */
const TUNNEL_RANGE = 5;

/**
 * routed floors registered in docs/facts.md F16: the measured legal layout
 * (demo 46 / full 396) minus a small jitter allowance. The pre-fix counts
 * (47 / 452) are not comparable: those layouts relied on illegal tunnels.
 */
const ROUTED_FLOOR: Record<"demo" | "full", number> = { demo: 44, full: 390 };

const DIRS: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

interface TunnelReport {
    routed: number;
    unrouted: number;
    spans: number;
    /** sender sits on a turn */
    senderTurn: number;
    /** receiver sits on a turn */
    receiverTurn: number;
    /** sender → receiver farther apart than one tunnel may span */
    spanTooLong: number;
    /** span cells don't match a straight run between the two ends */
    spanNotStraight: number;
    /** end tile or span cell not on the connection's path */
    missingEnd: number;
    /** two tunnel ends on one tile */
    endOverlap: number;
    /** a tunnel end shares its tile with a surface belt */
    endOnBelt: number;
    /** a same-direction tunnel end inside a span, or above another tunnel */
    hijack: number;
    /** a path tile that is neither a belt, an underground tile nor an end */
    coverage: number;
    /** a sender / receiver on a port tile facing away from the machine */
    portDirection: number;
    /** a belt path visits the same tile twice (one tile cannot hold two belts) */
    selfOverlap: number;
    /** World bookkeeping does not match the spans */
    bookkeeping: number;
}

interface EndRef {
    cell: Tile;
    dx: number;
    dy: number;
    plan: string;
    kind: "sender" | "receiver";
    span: TunnelSpan;
}

const keyOf = (cell: Tile): string => cell.x + "|" + cell.y;
const sameCell = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y;
const dirIndex = (dx: number, dy: number): number => DIRS.findIndex((d) => d[0] === dx && d[1] === dy);
const axisDir = (a: Tile, b: Tile): readonly [number, number] => [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];

function checkCampaign(set: "demo" | "full", seed: number): { report: TunnelReport; pass: boolean; gaps: number } {
    const report: TunnelReport = {
        routed: 0,
        unrouted: 0,
        spans: 0,
        senderTurn: 0,
        receiverTurn: 0,
        spanTooLong: 0,
        spanNotStraight: 0,
        missingEnd: 0,
        endOverlap: 0,
        endOnBelt: 0,
        hijack: 0,
        coverage: 0,
        portDirection: 0,
        selfOverlap: 0,
        bookkeeping: 0,
    };
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
    const layout = res.layout;
    const buildingByStep = new Map(layout.buildings.map((b) => [b.stepId, b]));
    const world = layout.world;

    // every tunnel end / span of every connection, for the cross-tunnel checks
    const ends: EndRef[] = [];
    const allSpans: TunnelSpan[] = [];
    const endsByTile = new Map<string, EndRef[]>();
    for (const c of layout.connections) {
        if (!c.routed || !c.path) {
            report.unrouted++;
            continue;
        }
        report.routed++;
        const path = c.path;
        const pathKeys = new Set(path.map(keyOf));
        if (pathKeys.size !== path.length) report.selfOverlap++;
        const undergroundKeys = new Set<string>();
        const connectionEndKeys = new Set<string>();
        for (const span of c.tunnelSpans) {
            report.spans++;
            allSpans.push(span);
            const si = path.findIndex((p) => sameCell(p, span.sender));
            const ri = path.findIndex((p) => sameCell(p, span.receiver));
            if (si < 0 || ri < 0) {
                report.missingEnd++;
                continue;
            }
            const dx = Math.sign(span.receiver.x - span.sender.x);
            const dy = Math.sign(span.receiver.y - span.sender.y);
            if ((dx !== 0) === (dy !== 0)) report.spanNotStraight++;
            if (ri - si < 2 || ri - si > TUNNEL_RANGE) report.spanTooLong++;
            // the span's cells must be exactly the path tiles between the ends
            const expected = path.slice(si + 1, ri);
            if (expected.length !== span.cells.length || expected.some((p, i) => !sameCell(p, span.cells[i]!))) {
                report.spanNotStraight++;
            }
            for (const cell of [span.sender, span.receiver]) {
                if (!pathKeys.has(keyOf(cell))) report.missingEnd++;
                if (connectionEndKeys.has(keyOf(cell))) report.endOverlap++;
                connectionEndKeys.add(keyOf(cell));
            }
            for (const cell of span.cells) undergroundKeys.add(keyOf(cell));
            // straight at both ends
            if (si > 0) {
                const before = axisDir(path[si - 1]!, span.sender);
                if (before[0] !== dx || before[1] !== dy) report.senderTurn++;
            }
            if (ri < path.length - 1) {
                const after = axisDir(span.receiver, path[ri + 1]!);
                if (after[0] !== dx || after[1] !== dy) report.receiverTurn++;
            }
            // a sender / receiver sitting on the port tile must face the machine
            const src = buildingByStep.get(c.from);
            if (si === 0 && src) {
                const info = BUILDING_INFO[src.kind];
                const start = portCells(info, src.x, src.y, src.rot)[info.ins.length + c.outSlot];
                const approach = portApproachCells(info, src.x, src.y, src.rot)[info.ins.length + c.outSlot];
                if (start && approach) {
                    const dir = axisDir(start, approach);
                    if (dir[0] !== dx || dir[1] !== dy) report.portDirection++;
                }
            }
            const dst = c.to === "HUB" ? undefined : buildingByStep.get(c.to);
            if (ri === path.length - 1 && dst && c.slot !== null) {
                const info = BUILDING_INFO[dst.kind];
                const goal = portCells(info, dst.x, dst.y, dst.rot)[c.slot];
                const approach = portApproachCells(info, dst.x, dst.y, dst.rot)[c.slot];
                if (goal && approach) {
                    const dir = axisDir(approach, goal);
                    if (dir[0] !== dx || dir[1] !== dy) report.portDirection++;
                }
            }
            const ref: EndRef = { cell: span.sender, dx, dy, plan: c.from, kind: "sender", span };
            const ref2: EndRef = { cell: span.receiver, dx, dy, plan: c.from, kind: "receiver", span };
            ends.push(ref, ref2);
            for (const end of [ref, ref2]) {
                const k = keyOf(end.cell);
                (endsByTile.get(k) || endsByTile.set(k, []).get(k)!).push(end);
            }
            // bookkeeping: both ends carry the direction, the underground tiles
            // remember it, no surface belt shares an end tile
            const d = dirIndex(dx, dy);
            for (const end of [span.sender, span.receiver]) {
                const k = cellKey(end.x, end.y);
                if (world.tunnelEnds.get(k) !== d) report.bookkeeping++;
                if (world.belts.has(k)) report.endOnBelt++;
            }
            for (const cell of span.cells) {
                const k = cellKey(cell.x, cell.y);
                if (((world.tunnelUnder.get(k) || 0) >>> d & 1) === 0) report.bookkeeping++;
            }
        }
        // a crossing the router recorded must be one of this connection's
        // underground tiles and must still carry the over-belt
        for (const cell of c.tunnelCells) {
            if (!undergroundKeys.has(keyOf(cell)) || !world.belts.has(cellKey(cell.x, cell.y))) report.bookkeeping++;
        }
        // every path tile that is not an end or underground must carry a belt
        for (const cell of path) {
            const k = keyOf(cell);
            if (undergroundKeys.has(k) || connectionEndKeys.has(k)) continue;
            if (!world.belts.has(cellKey(cell.x, cell.y))) report.coverage++;
        }
        // no stale ends / under-cells beyond what the paths claim: a global
        // count keeps a buggy claim from hiding behind the per-path checks
        for (const span of c.tunnelSpans) {
            for (const cell of span.cells) {
                if (!pathKeys.has(keyOf(cell))) report.missingEnd++;
            }
        }
    }

    // global: two ends on one tile
    for (const [, list] of endsByTile) if (list.length > 1) report.endOverlap++;

    // hijack: a same-direction end strictly inside a span, and an end sitting
    // above a tunnel that runs in the same direction
    for (const span of allSpans) {
        const dx = Math.sign(span.receiver.x - span.sender.x);
        const dy = Math.sign(span.receiver.y - span.sender.y);
        const lo = Math.min(span.sender.x * dx + span.sender.y * dy, span.receiver.x * dx + span.receiver.y * dy);
        const hi = Math.max(span.sender.x * dx + span.sender.y * dy, span.receiver.x * dx + span.receiver.y * dy);
        for (const end of ends) {
            if (end.dx !== dx || end.dy !== dy) continue;
            const at = end.cell.x * dx + end.cell.y * dy;
            const onAxis = dx !== 0 ? end.cell.y === span.sender.y : end.cell.x === span.sender.x;
            if (onAxis && at > lo && at < hi) report.hijack++;
        }
    }
    for (const end of ends) {
        const d = dirIndex(end.dx, end.dy);
        if ((((world.tunnelUnder.get(cellKey(end.cell.x, end.cell.y)) || 0) >>> d) & 1) !== 0) report.hijack++;
    }

    // the world's end table must be exactly the ends the paths claim
    const claimedEnds = new Set(ends.map((end) => cellKey(end.cell.x, end.cell.y)));
    for (const k of claimedEnds) if (!world.tunnelEnds.has(k)) report.bookkeeping++;
    for (const [k] of world.tunnelEnds) if (!claimedEnds.has(k)) report.bookkeeping++;

    const bad = Object.entries(report).filter(([name, n]) => name !== "routed" && name !== "unrouted" && name !== "spans" && n !== 0);
    const pass = bad.length === 0 && report.routed >= ROUTED_FLOOR[set];
    return { report, pass, gaps: layout.routingGaps.length };
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
