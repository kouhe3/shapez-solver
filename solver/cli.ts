#!/usr/bin/env bun
/**
 * shapez 通用机器求解器 CLI
 *
 *   bun run cli solve "RuCw--Cw:----Ru--"
 *   bun run cli solve "RuCw--Cw:----Ru--" --json
 *   bun run cli solve "Cu------" --level=demo:6
 *   bun run cli levels
 *   bun run cli render "RuCw--Cw"
 *   bun run cli check
 */

import * as S from "./src/shape.js";
import { shapeASCII } from "./src/render.js";
import { solve, ALL_BUILDINGS } from "./src/solver.js";
import type { SolveSuccess } from "./src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel } from "./src/levels.js";
import { scanMap, scanForTypes, itemLabel, availableResources } from "./src/map.js";
import { decodeSavegame, savegameMapInfo } from "./src/savegame.js";
import type { SavegameInfo, SavegamePoint } from "./src/savegame.js";
import { schematicSVG } from "./src/schematic.js";
import { neededShapes, requiredTypes, describeSource, NEED_SETS } from "./src/needs.js";
import type { NeedSet, NeedSetName, NeededShape } from "./src/needs.js";
import { planCampaign } from "./src/campaign.js";
import { formatRate, formatDuration, HUB_ENTRIES } from "./src/rates.js";
import { colorChains } from "./src/color.js";
import { planBom, expandPlanTree } from "./src/layout.js";
import { BUILDING_NAMES } from "./src/catalogue.js";
import { initRouterWasm } from "./src/router-engine.js";
import { validateSheet } from "./src/validate.js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        else flags.set(arg.slice(2), true);
    } else positional.push(arg);
}

/** `--k=v` holds a string, a bare `--k` holds `true` */
function flagString(name: string): string | undefined {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
}

/** numeric flags keep `Number(value)` semantics, so a bare `--k` counts as 1 */
function flagNumber(name: string): number | undefined {
    const value = flags.get(name);
    return value === undefined ? undefined : Number(value);
}

/** a `--set` the CLI knows; null keeps the raw string for the label */
function needSetConf(name: string): NeedSet | null {
    if (name === "demo" || name === "full") return NEED_SETS[name];
    return null;
}

/** `neededShapes` rejects an unknown set, and so does the CLI */
function needSetName(name: string): NeedSetName {
    if (name === "demo" || name === "full") return name;
    throw new Error(`unknown need set: ${name}`);
}

function printPlan(res: SolveSuccess): void {
    const flat = res.flat;
    console.log(`目标: ${S.hash(res.target)}`);
    console.log(`建筑数(成本): ${res.cost}   步骤: ${flat.steps.length}`);
    console.log("");
    const idWidth = Math.max(...flat.steps.map((s) => s.id.length));
    for (const step of flat.steps) {
        const inputs = step.inputs.map((i) => i.id).join(", ") || "-";
        const detail =
            step.node.op === "paint4"
                ? "按象限上色: " + step.node.colors.map((c) => c || "-").join("/")
                : step.detail;
        console.log(
            `  ${step.id.padEnd(idWidth)}  ${BUILDING_NAMES[step.op].padEnd(6)}  ${String(inputs).padEnd(9)}  ${String(
                detail
            ).padEnd(24)}  => ${step.outKey}`
        );
    }
    console.log("");
    const chains = colorChains(flat.steps);
    if (chains.length) {
        console.log("色料链（上色器的每个颜色入口一条，混色器不是 plan 步骤，但必须建）:");
        for (const chain of chains) {
            const ops = chain.ops.map((op) =>
                op.kind === "mixer" ? `混色器 ${op.parts.join("+")}=${op.color}` : `采矿机 ${op.color}`
            );
            console.log(`  ${chain.stepId} 颜色口${chain.slot}  ${chain.color}  ← ${ops.join(" → ")}`);
        }
        console.log("");
    }
    const bom = planBom(expandPlanTree(flat));
    console.log(`材料: ${bom.map((b) => `${b.zh}×${b.n}`).join("、")}`);
    console.log("");
    console.log(`最终产物: ${flat.final.outKey}`);
    console.log(`与目标一致: ${res.verification.ok ? "✓" : "✗"}`);
    if (!res.verification.ok) {
        for (const p of res.verification.problems) console.log("  ! " + p);
    }
}

function resolveBuildings(): Set<string> {
    const levelSpec = flagString("level");
    if (levelSpec) {
        const [which, num] = levelSpec.split(":");
        const levels = which === "demo" ? DEMO_LEVELS : FULL_LEVELS;
        return buildingsForLevel(levels, Number(num));
    }
    if (flags.get("all")) return new Set(ALL_BUILDINGS);
    return new Set(ALL_BUILDINGS);
}

function cmdSolve(): void {
    const code = positional[0];
    if (!code) {
        console.error("用法: bun run cli solve <shape-code> [--json] [--level=demo:6]");
        process.exit(2);
    }
    const buildings = resolveBuildings();
    const t0 = Date.now();
    const res = solve(code, { buildings });
    const ms = Date.now() - t0;
    if (flags.get("json")) {
        console.log(
            JSON.stringify(
                {
                    ok: res.ok,
                    target: S.hash(res.target),
                    cost: res.cost,
                    error: res.error,
                    stats: res.stats,
                    ms,
                    colors: {
                        chains: colorChains(res.flat ? res.flat.steps : []),
                        bom: res.flat ? planBom(expandPlanTree(res.flat)) : [],
                    },
                    steps: res.flat
                        ? res.flat.steps.map((s) => ({
                              id: s.id,
                              op: s.op,
                              building: BUILDING_NAMES[s.op],
                              inputs: s.inputs.map((i) => i.id),
                              detail: s.detail,
                              out: s.outKey,
                          }))
                        : null,
                },
                null,
                2
            )
        );
        return;
    }
    if (!res.ok) {
        console.error(`无法求解: ${res.error}`);
        if (flags.get("verbose")) console.error(JSON.stringify(res.stats));
        process.exit(1);
    }
    printPlan(res);
    console.log(`\n用时 ${ms} ms`);
}

function cmdRender(): void {
    const code = positional[0];
    if (!code) {
        console.error("用法: bun run cli render <shape-code>");
        process.exit(2);
    }
    const parsed = S.tryParse(code);
    if (!parsed.ok) {
        console.error(parsed.error);
        process.exit(1);
    }
    console.log(S.hash(parsed.shape));
    console.log(shapeASCII(parsed.shape));
    console.log("");
    console.log(S.describeShape(parsed.shape));
}

function cmdLevels(): void {
    const levels = flags.get("game") ? FULL_LEVELS : DEMO_LEVELS;
    for (const lvl of levels) {
        const buildings = buildingsForLevel(levels, lvl.level);
        console.log(
            `L${String(lvl.level).padStart(2)}  ${lvl.shape.padEnd(48)} x${String(lvl.required).padEnd(6)}  buildings=${[
                ...buildings,
            ].join(",") || "(none)"}`
        );
    }
}

async function cmdCheck(): Promise<void> {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(process.execPath, [path.join(import.meta.dir, "test/run-tests.ts")], {
        stdio: "inherit",
    });
    process.exit(res.status || 0);
}

/** seed + hub position read from a savegame */
interface SaveMapContext extends SavegameInfo {
    savePath: string;
}

/** seed + hub position given on the command line */
interface SeedMapContext {
    seed: number;
    hub: SavegamePoint;
    dump: null;
}

type MapContext = SaveMapContext | SeedMapContext;

/** seed + hub position either from a savegame file, --seed or a positional seed */
function loadMapContext(seedOverride?: string): MapContext {
    const savePath = flags.get("save");
    if (savePath) {
        const raw = fs.readFileSync(String(savePath), "utf8");
        const { payload } = decodeSavegame(raw);
        return { ...savegameMapInfo(payload), savePath: String(savePath) };
    }
    const seedFlag = seedOverride ?? flags.get("seed");
    if (seedFlag === undefined) {
        console.error("需要地图种子：bun run cli all <seed>（或 --seed=<n> / --save=<savegame.bin>）");
        process.exit(2);
    }
    return { seed: Number(seedFlag), hub: { x: -2, y: -2 }, dump: null };
}

function cmdMap(): void {
    const ctx = loadMapContext();
    const radius = flagNumber("radius") ?? 3;
    const patches = scanMap(ctx.seed, { chunkRadius: radius });
    const hubX = ctx.hub.x + 2;
    const hubY = ctx.hub.y + 2;
    patches.sort((a, b) => Math.hypot(a.x - hubX, a.y - hubY) - Math.hypot(b.x - hubX, b.y - hubY));
    console.log(`seed=${ctx.seed}  hub=(${ctx.hub.x},${ctx.hub.y})  chunkRadius=${radius}`);
    for (const p of patches) {
        const d = Math.hypot(p.x - hubX, p.y - hubY);
        console.log(
            `  (${p.x.toFixed(1).padStart(7)},${p.y.toFixed(1).padStart(7)})  d=${d.toFixed(1).padStart(5)}  ${itemLabel(
                p.item
            ).padEnd(10)} size=${p.size} tiles=${p.tiles}`
        );
    }
    const res = availableResources(patches);
    console.log("\n可用基础形状:", [...res.shapes.keys()].join(", ") || "(无)");
    console.log("可用颜色:", [...res.colors.keys()].join(", ") || "(无)");
    if (flags.get("json")) {
        console.log(JSON.stringify({ seed: ctx.seed, hub: ctx.hub, patches }, null, 2));
    }
}

/** terminal column width: CJK glyphs take two cells */
function displayWidth(text: string | number): number {
    let n = 0;
    for (const ch of String(text)) {
        n += /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
    }
    return n;
}

function pad(text: string | number, width: number): string {
    const s = String(text);
    const w = displayWidth(s);
    return w >= width ? s : s + " ".repeat(width - w);
}

function cmdAll(): void {
    initRouterWasm(fs.readFileSync(new URL("./router.wasm", import.meta.url)));
    const set = String(flags.get("set") ?? "demo");
    const setConf = needSetConf(set);
    const untilLevel = flagNumber("until") ?? null;
    if (untilLevel !== null && (!Number.isInteger(untilLevel) || untilLevel < 1)) {
        console.error("--until 需要正整数关卡号，例如 --until=9");
        process.exit(2);
    }
    // `bun run cli all 47742` — the seed is the whole input of the campaign sheet
    const positionalSeed = positional[0] !== undefined && /^\d+$/.test(positional[0]) ? positional[0] : undefined;
    const custom = flags.get("code") ?? (positionalSeed ? undefined : positional[0]);
    const shapes: NeededShape[] = custom
        ? String(custom)
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((code) => ({ code, sources: [] }))
        : neededShapes({ set: needSetName(set) });

    const ctx = loadMapContext(positionalSeed);
    const fixedRadius = flags.has("radius") ? flagNumber("radius") : null;
    const scan = scanForTypes(ctx.seed, {
        types: requiredTypes(shapes),
        startRadius: fixedRadius ?? (set === "full" ? 10 : 8),
        maxRadius: fixedRadius ?? 32,
    });
    const patches = scan.patches;
    const res = planCampaign({
        shapes,
        patches,
        hub: ctx.hub,
        maxAttempts: flagNumber("budget") ?? 30000,
        buildings: flags.get("level") ? resolveBuildings() : null,
        untilLevel,
        levels: setConf ? setConf.levels : undefined,
    });
    if (flags.get("json")) {
        console.log(
            JSON.stringify(
                {
                    set: custom ? "custom" : set,
                    seed: ctx.seed,
                    hub: ctx.hub,
                    untilLevel,
                    radius: scan.radius,
                    missingTypes: scan.missingTypes,
                    totals: res.totals,
                    entries: res.entries,
                    bom: res.sheet.bom,
                    colors: res.sheet.colors.map((c) =>
                        c.direct
                            ? { color: c.color, direct: true, patch: { x: c.patch.x, y: c.patch.y } }
                            : { color: c.color, direct: false, mix: c.mix }
                    ),
                    missing: res.sheet.missing,
                    routingGaps: res.sheet.routingGaps,
                    belts: res.sheet.beltEstimate,
                    throughput: res.totals.throughput,
                },
                null,
                2
            )
        );
    } else {
        const label = setConf ? setConf.label : set;
        const scope = untilLevel === null ? "" : ` · 只画 L≤${untilLevel} 可建的`;
        console.log(`种子 ${ctx.seed} · 扫描半径 ${scan.radius} chunk · 中心 (${ctx.hub.x},${ctx.hub.y})`);
        console.log(`全部需求图形（${label}${scope}）: ${res.totals.shapes} 种可建 / ${shapes.length} 种需求\n`);
        console.log(
            ` ${pad("#", 4)}${pad("图形", 28)}${pad("副本", 6)}${pad("建筑", 6)}${pad("传送带", 8)}${pad("产能", 9)}${pad(
                "交付",
                8
            )}${pad("可建", 6)}来源`
        );
        for (const e of res.entries) {
            const why = e.sources.map(describeSource).join(" / ");
            if (e.status === "deferred" || e.status === "impossible") {
                const at = e.status === "deferred" ? `L${e.availableAt}+` : "不可建";
                console.log(
                    ` ${pad(e.index, 4)}${pad(e.code, 28)}${pad("-", 6)}${pad("-", 6)}${pad("-", 8)}${pad("-", 9)}${pad(
                        "-",
                        8
                    )}${pad(at, 6)} ${e.reason}${why ? ` · ${why}` : ""}`
                );
                continue;
            }
            if (!e.ok) {
                console.log(
                    ` ${pad(e.index, 4)}${pad(e.code, 28)}${pad("-", 6)}${pad("-", 6)}${pad("-", 8)}${pad("-", 9)}${pad(
                        "-",
                        8
                    )}${pad("-", 6)}无法求解: ${e.error}`
                );
                continue;
            }
            const gap = e.missing.length ? `  ⚠ 缺矿脉 ${e.missing.map((m) => m.replace(/^shape:/, "")).join(", ")}` : "";
            console.log(
                ` ${pad(e.index, 4)}${pad(e.code, 28)}${pad(e.copies, 6)}${pad(e.buildings, 6)}${pad(e.belts, 8)}${pad(
                    formatRate(e.totalRate),
                    9
                )}${pad(formatDuration(e.eta), 8)}${pad(`L${e.availableAt}`, 6)}${why}${gap}`
            );
        }
        console.log(
            `\n合计: ${res.totals.shapes} 种可建 · ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格` +
                (res.totals.failed ? ` · ${res.totals.failed} 种无法求解` : "") +
                (res.totals.deferred ? ` · ${res.totals.deferred} 种要更高关卡` : "") +
                (res.totals.impossible ? ` · ${res.totals.impossible} 种本版本没有对应机器` : "") +
                (res.totals.unbuildable ? ` · ${res.totals.unbuildable} 种缺矿脉` : "")
        );
        const perf = res.totals.throughput;
        console.log(
            `总产能: ${perf.deliveredRate.toFixed(2)}/s（${perf.factories} 座工厂）· 中心上限 ${perf.hubCapacity}/s · 全部交付需 ${formatDuration(perf.criticalEta)}`
        );
        console.log(`损耗: ${perf.trashCans} 个垃圾桶 · 丢弃 ${perf.wasteRate.toFixed(2)}/s（未用的切割口）`);
        console.log(
            `额定速度（升级等级 1）: 传送带 ${perf.beltRate}/s · 采矿机 ${perf.minerRate}/s · 色料源 ${perf.sourceRate}/s`
        );
        if (res.totals.classicFallback) {
            console.log("布局说明: 满载布局存在布线失败，已退回经典布局（每 base 一矿机、每色口一链）以保证 0 布线失败");
        }
        if (res.totals.widened) {
            console.log("布局说明: 紧凑布局有链路布不通，已用更宽的车间间距重建，优先保证 0 布线失败");
        }
        if (perf.demandTotal > 0) {
            console.log(
                `色料: 每口一链共 ${perf.builtSourceCount} 台（需求 ${perf.demandTotal.toFixed(2)}/s，供给 ${perf.supplyAvailable.toFixed(
                    2
                )}/s）· 按需求只需 ${perf.demandSizedCount} 台；L4 后共享色料厂能省 ${
                    perf.builtSourceCount - perf.demandSizedCount
                } 台，代价是要自己接分流`
            );
        }
        if (perf.extraSources > 0) {
            console.log(
                `色料源缺口: 还需 ${perf.extraSources} 台（${perf.colorGap
                    .map((g) => `${g.color} ${g.have}→${g.need} ${g.kind}`)
                    .join("、")}）`
            );
        }
        for (const g of perf.capacityGap) {
            console.log(
                `⚠ 矿脉放不下: ${g.color} 需要 ${g.need} 台矿机，图上可达上限 ${g.capacity} 台 —— 升采矿等级，或等 L11 链式采矿机`
            );
        }
        console.log(
            `运输缺口: 同一出口挂多条带要 ${perf.splitters} 个分流节点（最坏一个口 ${perf.worstFanout} 条）；中心 ${perf.hubInbound} 条带入 ${HUB_ENTRIES} 个入口格，要 ${perf.hubMerges} 个并带`
        );
        console.log(
            `皮带账单: ${perf.beltLinks} 条链路 · 中位负载 ${(perf.beltUtilP50 * 100).toFixed(1)}% · 低于 25% 占 ${(
                perf.beltSparseShare * 100
            ).toFixed(0)}% · 超载 ${perf.beltOverloaded} 条 · 闲置 ${perf.beltIdle.toFixed(0)}/${perf.beltCapacity.toFixed(
                0
            )}/s（${(perf.beltIdleShare * 100).toFixed(0)}%）· 合并点余量 ${perf.beltHeadroom.toFixed(2)}/s · ${(
                perf.deliveredRate > 0 ? res.totals.belts / perf.deliveredRate : 0
            ).toFixed(0)} 格每 item/s`
        );
        if (perf.beltCritical.length) {
            const byWhere = new Map<string, number>();
            for (const point of perf.beltCritical) byWhere.set(point.where, (byWhere.get(point.where) ?? 0) + 1);
            const plans = [...new Set(perf.beltCritical.map((p) => p.plan).filter((p): p is number => p !== null))].sort(
                (a, b) => a - b
            );
            console.log(
                `临界合并点: ${perf.beltCritical.length} 处（${[...byWhere].map(([w, n]) => `${w}×${n}`).join("、")}）` +
                    `——余量 0，再加一份就堵` +
                    (plans.length ? `；涉及计划 ${plans.join("、")}` : "")
            );
        }
        if (res.totals.routingGaps) {
            console.log(
                `⚠ 布线失败 ${res.totals.routingGaps} 条：端口被别的建筑堵住，图纸上用红色 ✕ 标出（${res.sheet.routingGaps
                    .map((g) => `${g.fromLabel}→${g.toLabel}`)
                    .join("、")}）`
            );
        }
        if (perf.balancerAt) {
            console.log(`平衡器 L${perf.balancerAt} 解锁：在此之前不能分叉/汇合，中心最多进 ${HUB_ENTRIES} 条带`);
        }
        if (perf.tunnelAt) console.log(`隧道 L${perf.tunnelAt} 解锁：在此之前走线不能交叉`);
        for (const t of scan.missingTypes) {
            console.log(`⚠ 半径 ${scan.radius} 内没有 ${t} 矿脉：需要它的图形无法建造`);
        }
        console.log(`材料: ${res.sheet.bom.map((b) => `${b.zh}×${b.n}`).join(", ")}`);
        for (const c of res.sheet.colors) {
            if (c.direct) console.log(`颜色 ${c.color}: 地图上有矿脉 (${c.patch.x.toFixed(0)},${c.patch.y.toFixed(0)})`);
            else console.log(`颜色 ${c.color}: 无直接矿脉，需混合 ${c.mix ? c.mix.join("+") : "—"}`);
        }
        for (const m of res.sheet.missing) console.log(`缺失资源: ${m}`);
    }

    const outPath = flags.get("out") ?? (flags.get("json") ? null : `plan-${ctx.seed}.svg`);
    const violations = validateSheet(res.sheet);
    if (res.totals.routingGaps > 0 || violations.length > 0) {
        // the sheet has a red ✕ or an illegal tile: it is a diagnostic, not a
        // drawing to build from, so no file is written and the command fails
        const kinds = [...new Set(violations.map((v) => v.kind))].join("、");
        const labels = res.sheet.routingGaps.map((g) => `${g.fromLabel}→${g.toLabel}`).join("、");
        console.error(
            `\n拒绝生成图纸：${res.totals.routingGaps} 条链路布线失败` +
                (violations.length ? `、${violations.length} 条几何违规（${kinds}）` : "") +
                (labels ? `（${labels}）` : "") +
                `。这是求解器的布局缺陷，不是游戏限制。`
        );
        process.exitCode = 1;
    } else if (outPath) {
        const usedPatches = [];
        for (const s of res.sheet.sources) if (s.patch) usedPatches.push(s.patch);
        for (const c of res.sheet.colors) if (c.patch) usedPatches.push(c.patch);
        fs.writeFileSync(String(outPath), schematicSVG(res.sheet, usedPatches, { campaign: true }), "utf8");
        console.log(`\n图纸已写入 ${outPath}`);
    }
}

switch (command) {
    case "solve":
        cmdSolve();
        break;
    case "render":
        cmdRender();
        break;
    case "levels":
        cmdLevels();
        break;
    case "check":
        await cmdCheck();
        break;
    case "map":
        cmdMap();
        break;
    case "all":
        cmdAll();
        break;
    default:
        console.log(`shapez ALL SHAPE YOU NEED 求解器

输入一个地图种子，解出整条战役需要的所有图形，输出一张共用同一张地图、
同一个中心的图纸（建筑坐标 + 物料流 + 材料表）。

  bun run cli all 47742                  # → plan-47742.svg（DEMO 需求表 26 种）
  bun run cli all 47742 --set=full       # 完整版需求表 34 种
  bun run cli all 47742 --until=9        # 只画第 9 关时能建的产线
  bun run cli all --save=../savegame.bin # 用存档里的真实种子和中心

其他命令:
  solve <shape>     单个 shape → 建筑方案（步骤 + 复算校验）
  map               列出种子附近的矿脉与颜色
  render <shape>    打印 shape 的形状与说明
  levels            列出游戏关卡目标(默认 demo)
  check             运行回归测试(单元 + 全关卡)

选项:
  --set=demo|full   all: 需求集合 (默认 demo)
  --out=<file.svg>  all: 图纸路径 (默认 plan-<seed>.svg)
  --radius=<n>      扫描的 chunk 半径 (默认自动扩展，直到需要的矿脉出现)
  --seed=<n>        地图种子 (all 也可直接写位置参数)
  --save=<file>     shapez 存档 (.bin, IndexedDB 里的原始内容)，取真实种子/中心
  --until=<n>       all: 只画第 n 关时已解锁的产线（同时限制可用建筑）
  --level=demo:6    solve: 只使用该关卡时已解锁的建筑
  --json            输出机器可读的 JSON
  --code=A,B,C      all: 只解指定图形
`);
}
