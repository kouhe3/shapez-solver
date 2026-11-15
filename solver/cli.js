#!/usr/bin/env node
/**
 * shapez 通用机器求解器 CLI
 *
 *   node cli.js solve "RuCw--Cw:----Ru--"
 *   node cli.js solve "RuCw--Cw:----Ru--" --json
 *   node cli.js solve "Cu------" --level=demo:6
 *   node cli.js levels
 *   node cli.js render "RuCw--Cw"
 *   node cli.js check
 */

import * as S from "./src/shape.js";
import * as P from "./src/plan.js";
import { shapeASCII } from "./src/render.js";
import { solve, ALL_BUILDINGS } from "./src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel } from "./src/levels.js";
import { scanMap, itemLabel, availableResources } from "./src/map.js";
import { decodeSavegame } from "./src/savegame.js";
import { buildLayout } from "./src/layout.js";
import { schematicSVG } from "./src/schematic.js";
import { neededShapes, describeSource, NEED_SETS } from "./src/needs.js";
import { planCampaign } from "./src/campaign.js";
import fs from "node:fs";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Map();
const positional = [];
for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        else flags.set(arg.slice(2), true);
    } else positional.push(arg);
}

function label(step) {
    const zh = P.OP_LABELS[step.op] || step.op;
    return zh;
}

function printPlan(res) {
    const flat = res.flat;
    console.log(`目标: ${S.hash(res.target)}`);
    console.log(`建筑数(成本): ${res.cost}   步骤: ${flat.steps.length}`);
    console.log("");
    const idWidth = Math.max(...flat.steps.map((s) => s.id.length));
    for (const step of flat.steps) {
        const inputs = step.inputs.map((i) => i.id).join(", ") || "-";
        const detail =
            step.op === "paint4"
                ? "按象限上色: " + step.node.colors.map((c) => c || "-").join("/")
                : step.detail;
        console.log(
            `  ${step.id.padEnd(idWidth)}  ${label(step).padEnd(6)}  ${String(inputs).padEnd(9)}  ${String(
                detail
            ).padEnd(24)}  => ${step.outKey}`
        );
    }
    console.log("");
    console.log(`最终产物: ${flat.final.outKey}`);
    console.log(`与目标一致: ${res.verification.ok ? "✓" : "✗"}`);
    if (!res.verification.ok) {
        for (const p of res.verification.problems) console.log("  ! " + p);
    }
}

function resolveBuildings() {
    const levelSpec = flags.get("level");
    if (levelSpec) {
        const [which, num] = String(levelSpec).split(":");
        const levels = which === "demo" ? DEMO_LEVELS : FULL_LEVELS;
        return buildingsForLevel(levels, Number(num));
    }
    if (flags.get("all")) return new Set(ALL_BUILDINGS);
    return new Set(ALL_BUILDINGS);
}

function cmdSolve() {
    const code = positional[0];
    if (!code) {
        console.error("用法: node cli.js solve <shape-code> [--json] [--level=demo:6]");
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
                    steps: res.flat
                        ? res.flat.steps.map((s) => ({
                              id: s.id,
                              op: s.op,
                              building: P.OP_LABELS[s.op],
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

function cmdRender() {
    const code = positional[0];
    if (!code) {
        console.error("用法: node cli.js render <shape-code>");
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

function cmdLevels() {
    const list = flags.get("demo") ? DEMO_LEVELS : flags.get("game") ? FULL_LEVELS : [...DEMO_LEVELS];
    for (const lvl of list) {
        const buildings = buildingsForLevel(DEMO_LEVELS === list ? DEMO_LEVELS : FULL_LEVELS, lvl.level);
        console.log(
            `L${String(lvl.level).padStart(2)}  ${lvl.shape.padEnd(48)} x${String(lvl.required).padEnd(6)}  buildings=${[
                ...buildings,
            ].join(",") || "(none)"}`
        );
    }
}

async function cmdCheck() {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(process.execPath, ["./test/run-tests.js"], { stdio: "inherit" });
    process.exit(res.status || 0);
}

/** seed + hub position either from a savegame file or --seed */
function loadMapContext() {
    const savePath = flags.get("save");
    if (savePath) {
        const raw = fs.readFileSync(String(savePath), "utf8");
        const { payload } = decodeSavegame(raw);
        const dump = payload.dump || payload;
        const seed = (dump.map && dump.map.seed) ?? null;
        if (seed === null) throw new Error("savegame has no map seed");
        let hub = { x: -2, y: -2 };
        for (const e of dump.entities || []) {
            const sm = e.components && e.components.StaticMapEntity;
            if (sm && sm.code === 26 && sm.origin) hub = sm.origin;
        }
        return { seed, hub, dump, savePath };
    }
    const seedFlag = flags.get("seed");
    if (seedFlag === undefined) {
        console.error("需要 --save=<savegame.bin> 或 --seed=<number>");
        process.exit(2);
    }
    return { seed: Number(seedFlag), hub: { x: -2, y: -2 }, dump: null };
}

function cmdMap() {
    const ctx = loadMapContext();
    const radius = Number(flags.get("radius") ?? 3);
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

function cmdBlueprint() {
    const code = positional[0];
    if (!code) {
        console.error("用法: node cli.js blueprint <shape-code> --save=<savegame.bin> [--radius=4] [--out=plan.svg]");
        process.exit(2);
    }
    const ctx = loadMapContext();
    const radius = Number(flags.get("radius") ?? 4);
    const patches = scanMap(ctx.seed, { chunkRadius: radius });
    const buildings = flags.get("level") ? resolveBuildings() : new Set(ALL_BUILDINGS);
    const baseCodes = [...new Set(patches.filter((p) => p.item.kind === "shape").map((p) => p.item.code))];
    const res = solve(code, { buildings, baseCodes, maxAttempts: Number(flags.get("budget") ?? 30000) });
    if (!res.ok) {
        console.error(`无法求解: ${res.error}`);
        process.exit(1);
    }
    const layout = buildLayout({ plan: res.plan, patches, hub: ctx.hub });
    console.log(`目标: ${S.hash(res.target)}  建筑数 ${layout.buildings.length}`);
    console.log(`\n放置清单 (tile 坐标, 右下为 +x/+y):`);
    for (const b of layout.buildings) {
        const extra = b.kind === "base" ? `  矿脉 ${itemLabel(b.patch && b.patch.item)}  距离 ${b.distance.toFixed(1)}` : b.detail ? `  ${b.detail}` : "";
        console.log(`  (${String(b.x).padStart(4)},${String(b.y).padStart(4)})  ${b.zh.padEnd(6)}  ${b.stepId}${extra}`);
    }
    console.log(`\n物料流 (来源 → 目标, 传送带格数):`);
    for (const c of layout.connections) {
        const out = c.outCount > 1 ? ` 输出#${c.outSlot}` : "";
        const dest = c.toHub ? "HUB (枢纽)" : `${c.to} (${c.toLabel}) 输入#${c.slot}`;
        console.log(`  ${c.from} (${c.fromLabel})${out} → ${dest}   ${c.beltTiles} 格`);
    }
    console.log(`\n建筑清单: ${layout.bom.map((b) => `${b.zh}×${b.n}`).join(", ")}`);
    console.log(`传送带约 ${layout.beltEstimate} 格`);
    for (const c of layout.colors) {
        if (c.direct) console.log(`颜色 ${c.color}: 地图上有矿脉 (${c.patch.x.toFixed(1)},${c.patch.y.toFixed(1)})`);
        else console.log(`颜色 ${c.color}: 无直接矿脉，需混合 ${c.mix.join("+")}`);
    }
    for (const m of layout.missing) console.log(`缺失资源: ${m}`);
    const outPath = flags.get("out");
    const usedPatches = [];
    for (const s of layout.sources) if (s.patch) usedPatches.push(s.patch);
    for (const c of layout.colors) if (c.patch) usedPatches.push(c.patch);
    const svg = schematicSVG(layout, usedPatches);
    if (outPath) {
        fs.writeFileSync(String(outPath), svg, "utf8");
        console.log(`\n图纸已写入 ${outPath}`);
    }
}

/** terminal column width: CJK glyphs take two cells */
function displayWidth(text) {
    let n = 0;
    for (const ch of String(text)) {
        n += /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
    }
    return n;
}

function pad(text, width) {
    const s = String(text);
    const w = displayWidth(s);
    return w >= width ? s : s + " ".repeat(width - w);
}

function cmdAll() {
    const set = String(flags.get("set") ?? "demo");
    const custom = flags.get("code") ?? positional[0];
    const shapes = custom
        ? String(custom)
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((code) => ({ code, sources: [] }))
        : neededShapes({ set });

    const ctx = loadMapContext();
    const radius = Number(flags.get("radius") ?? 8);
    const patches = scanMap(ctx.seed, { chunkRadius: radius });
    const res = planCampaign({
        shapes,
        patches,
        hub: ctx.hub,
        maxAttempts: Number(flags.get("budget") ?? 30000),
        buildings: flags.get("level") ? resolveBuildings() : null,
    });

    if (flags.get("json")) {
        console.log(
            JSON.stringify(
                {
                    set: custom ? "custom" : set,
                    seed: ctx.seed,
                    hub: ctx.hub,
                    totals: res.totals,
                    entries: res.entries,
                    bom: res.layout.bom,
                    colors: res.layout.colors.map((c) =>
                        c.direct
                            ? { color: c.color, direct: true, patch: { x: c.patch.x, y: c.patch.y } }
                            : { color: c.color, direct: false, mix: c.mix }
                    ),
                    missing: res.layout.missing,
                    belts: res.layout.beltEstimate,
                },
                null,
                2
            )
        );
    } else {
        const label = NEED_SETS[set] ? NEED_SETS[set].label : set;
        console.log(`全部需求图形（${label}）: ${shapes.length} 种\n`);
        console.log(` ${pad("#", 4)}${pad("图形", 28)}${pad("建筑", 6)}${pad("传送带", 8)}来源`);
        for (const e of res.entries) {
            const why = e.sources.map(describeSource).join(" / ");
            if (!e.ok) {
                console.log(` ${pad(e.index, 4)}${pad(e.code, 28)}${pad("-", 6)}${pad("-", 8)}无法求解: ${e.error}`);
                continue;
            }
            const gap = e.missing.length ? `  ⚠ 缺矿脉 ${e.missing.map((m) => m.replace(/^shape:/, "")).join(", ")}` : "";
            console.log(` ${pad(e.index, 4)}${pad(e.code, 28)}${pad(e.buildings, 6)}${pad(e.belts, 8)}${why}${gap}`);
        }
        console.log(
            `\n合计: ${res.totals.shapes} 种 · ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格` +
                (res.totals.failed ? ` · ${res.totals.failed} 种无法求解` : "") +
                (res.totals.unbuildable ? ` · ${res.totals.unbuildable} 种缺矿脉` : "")
        );
        console.log(`材料: ${res.layout.bom.map((b) => `${b.zh}×${b.n}`).join(", ")}`);
        for (const c of res.layout.colors) {
            if (c.direct) console.log(`颜色 ${c.color}: 地图上有矿脉 (${c.patch.x.toFixed(0)},${c.patch.y.toFixed(0)})`);
            else console.log(`颜色 ${c.color}: 无直接矿脉，需混合 ${c.mix.join("+")}`);
        }
        for (const m of res.layout.missing) console.log(`缺失资源: ${m}`);
    }

    const outPath = flags.get("out");
    if (outPath) {
        const usedPatches = [];
        for (const s of res.layout.sources) if (s.patch) usedPatches.push(s.patch);
        for (const c of res.layout.colors) if (c.patch) usedPatches.push(c.patch);
        fs.writeFileSync(String(outPath), schematicSVG(res.layout, usedPatches, { campaign: true }), "utf8");
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
    case "blueprint":
        cmdBlueprint();
        break;
    case "all":
        cmdAll();
        break;
    default:
        console.log(`shapez 通用机器求解器

命令:
  solve <shape>     生成生产该 shape 的建筑方案
  render <shape>    打印 shape 的形状与说明
  levels            列出游戏关卡目标(默认 demo)
  check             运行回归测试(单元 + 全关卡)
  map               读取地图(矿脉/颜色)  --save=<savegame.bin> 或 --seed=N
  blueprint <shape> 输出放置清单 + SVG 图纸
  all               一次解出所有需要的图形(关卡+升级), 共用地图与 HUB

选项:
  --json            输出机器可读的 JSON
  --level=demo:6    只使用该关卡时已解锁的建筑
  --demo|--game     配合 levels 使用
  --save=<file>     shapez 存档 (.bin, IndexedDB 里的原始内容)
  --seed=<n>        直接用地图种子
  --radius=<n>      扫描的 chunk 半径
  --out=<file.svg>  blueprint: 输出图纸
  --set=demo|full   all: 需求集合 (默认 demo)
  --code=A,B,C      all: 只解指定图形
`);
}
