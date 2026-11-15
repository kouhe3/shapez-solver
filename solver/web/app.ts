import * as S from "../src/shape.js";
import * as P from "../src/plan.js";
import { shapeSVG } from "../src/render.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";
import type { SolveResult } from "../src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel, REWARD_BUILDINGS } from "../src/levels.js";
import type { Level } from "../src/levels.js";
import { scanMap, scanForTypes, itemLabel } from "../src/map.js";
import type { Patch } from "../src/map.js";
import { decodeSavegame, savegameMapInfo } from "../src/savegame.js";
import { schematicSVG } from "../src/schematic.js";
import { neededShapes, requiredTypes, describeSource } from "../src/needs.js";
import type { NeedSetName } from "../src/needs.js";
import { planCampaign } from "../src/campaign.js";
import type { CampaignResult } from "../src/campaign.js";
import { formatRate, formatDuration } from "../src/rates.js";
import { colorChains } from "../src/color.js";
import { planBom, expandPlanTree } from "../src/layout.js";

const BUILDING_LABELS: Record<string, string> = {
    cutter: "切割机",
    quadCutter: "四向切割机",
    rotaterCW: "旋转器 (顺时针)",
    rotaterCCW: "旋转器 (逆时针)",
    rotater180: "旋转器 (180°)",
    stacker: "堆叠器",
    painter: "上色器",
    quadPainter: "四色上色器",
};

/** every id passed here exists in index.html; a missing one is a bug, not a state */
function mustGet<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`index.html 缺少 #${id} 元素`);
    return el as T;
}

const shapeInput = mustGet<HTMLInputElement>("shape-input");
const solveBtn = mustGet<HTMLButtonElement>("solve-btn");
const shapeHint = mustGet<HTMLElement>("shape-hint");
const preview = mustGet<HTMLElement>("target-preview");
const statusEl = mustGet<HTMLElement>("status");
const stepsEl = mustGet<HTMLElement>("steps");
const resultMeta = mustGet<HTMLElement>("result-meta");
const levelSet = mustGet<HTMLSelectElement>("level-set");
const levelPick = mustGet<HTMLSelectElement>("level-pick");
const levelHint = mustGet<HTMLElement>("level-hint");
const buildingList = mustGet<HTMLElement>("building-list");

let currentBuildings: Set<string> = new Set(ALL_BUILDINGS);
let lastResult: SolveResult | null = null;

/* ------------------------------------------------------------------ *
 * buildings
 * ------------------------------------------------------------------ */

function renderBuildings(): void {
    buildingList.innerHTML = "";
    for (const b of ALL_BUILDINGS) {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = currentBuildings.has(b);
        cb.dataset.building = b;
        cb.addEventListener("change", () => {
            if (cb.checked) currentBuildings.add(b);
            else currentBuildings.delete(b);
            updateSolveState();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(BUILDING_LABELS[b] || b));
        buildingList.appendChild(label);
    }
}

function setBuildings(set: Iterable<string>): void {
    currentBuildings = new Set(set);
    for (const cb of buildingList.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
        const building = cb.dataset.building;
        cb.checked = building !== undefined && currentBuildings.has(building);
    }
    updateSolveState();
}

/* ------------------------------------------------------------------ *
 * levels
 * ------------------------------------------------------------------ */

function levelsFor(setName: string): Level[] {
    return setName === "game" ? FULL_LEVELS : DEMO_LEVELS;
}

function renderLevelPick(): void {
    const levels = levelsFor(levelSet.value);
    levelPick.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— 选择关卡 —";
    levelPick.appendChild(placeholder);
    for (const lvl of levels) {
        const opt = document.createElement("option");
        opt.value = String(lvl.level);
        opt.textContent = `L${lvl.level}  ${lvl.shape}`;
        levelPick.appendChild(opt);
    }
    levelPick.value = "";
    levelHint.textContent = "选择关卡会自动填入目标，并把可用建筑限制为该关卡时已解锁的那些。";
}

function onLevelChange(): void {
    if (!levelPick.value) return;
    const levels = levelsFor(levelSet.value);
    const lvl = levels.find((l) => String(l.level) === levelPick.value);
    if (!lvl) return;
    shapeInput.value = lvl.shape;
    const buildings = buildingsForLevel(levels, lvl.level);
    setBuildings(buildings);
    levelHint.textContent =
        `第 ${lvl.level} 关需要 ${lvl.required} 个；可用建筑：` +
        ([...buildings].map((b) => BUILDING_LABELS[b] || b).join("、") || "仅采矿机");
    onInputChanged();
}

/** "全部关卡" plus every level of the selected need set */
function renderAllLevels(): void {
    const levels = levelsFor(mustGet<HTMLSelectElement>("all-set").value);
    const sel = mustGet<HTMLSelectElement>("all-until");
    const keep = sel.value;
    sel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部关卡";
    sel.appendChild(all);
    for (const lvl of levels) {
        const opt = document.createElement("option");
        opt.value = String(lvl.level);
        opt.textContent = `只画 L≤${lvl.level}`;
        sel.appendChild(opt);
    }
    sel.value = levels.some((lvl) => String(lvl.level) === keep) ? keep : "";
}

/* ------------------------------------------------------------------ *
 * input handling
 * ------------------------------------------------------------------ */

function onInputChanged(): void {
    const text = shapeInput.value.trim();
    preview.innerHTML = "";
    if (!text) {
        shapeInput.classList.remove("invalid");
        shapeHint.textContent = "输入 shape code，例如 RuCw--Cw:----Ru--";
        statusEl.className = "status idle";
        statusEl.textContent = "等待输入…";
        updateSolveState();
        return;
    }
    const parsed = S.tryParse(text);
    if (!parsed.ok) {
        shapeInput.classList.add("invalid");
        shapeHint.textContent = parsed.error;
        updateSolveState();
        return;
    }
    shapeInput.classList.remove("invalid");
    shapeHint.textContent = S.describeShape(parsed.shape);
    preview.innerHTML = shapeSVG(parsed.shape, 150);
    updateSolveState();
}

function updateSolveState(): void {
    const parsed = S.tryParse(shapeInput.value.trim());
    solveBtn.disabled = !parsed.ok;
}

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

function ioThumb(shape: S.Shape, caption: string): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "io-item";
    wrap.innerHTML = shapeSVG(shape, 46);
    const cap = document.createElement("span");
    cap.textContent = caption;
    wrap.appendChild(cap);
    return wrap;
}

function renderPlan(res: SolveResult): void {
    stepsEl.innerHTML = "";
    resultMeta.innerHTML = "";

    if (!res.ok) {
        statusEl.className = "status err";
        statusEl.textContent = res.error || "无法生成方案";
        return;
    }

    const aborted = res.stats && res.stats.aborted;
    statusEl.className = "status ok";
    statusEl.textContent = aborted
        ? `已找到并验证方案（搜索引擎达到预算，可能是次优解；用时 ${res.stats.planShapes} 个状态）`
        : "已生成方案，并通过模拟器验证 ✓";

    const chipCost = document.createElement("span");
    chipCost.className = "chip";
    chipCost.textContent = `建筑数 ${res.cost}`;
    const chipSteps = document.createElement("span");
    chipSteps.className = "chip";
    chipSteps.textContent = `步骤 ${res.flat.steps.length}`;
    const chipOk = document.createElement("span");
    chipOk.className = "chip good";
    chipOk.textContent = res.verification.ok ? "校验通过" : "校验失败";
    resultMeta.append(chipCost, chipSteps, chipOk);

    const counts = new Map<P.PlanOp, number>();
    for (const step of res.flat.steps) {
        if (step.op === "base") continue;
        counts.set(step.op, (counts.get(step.op) || 0) + 1);
    }
    for (const [op, n] of counts) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `${P.OP_LABELS[op] || op} ×${n}`;
        resultMeta.appendChild(chip);
    }

    for (const step of res.flat.steps) {
        const card = document.createElement("div");
        card.className = "step";

        const idEl = document.createElement("div");
        idEl.className = "id";
        idEl.textContent = step.id;

        const body = document.createElement("div");
        const title = document.createElement("div");
        title.className = "op";
        title.textContent = P.OP_LABELS[step.op] || step.op;
        const detail = document.createElement("div");
        detail.className = "detail";
        detail.textContent =
            step.node.op === "paint4"
                ? "按象限上色：" + step.node.colors.map((c) => c || "-").join(" / ")
                : step.detail || "";
        const io = document.createElement("div");
        io.className = "io";
        step.inputs.forEach((input, i) => {
            if (i > 0) {
                const arrow = document.createElement("span");
                arrow.className = "arrow";
                arrow.textContent = step.op === "stack" ? "⤒" : "+";
                io.appendChild(arrow);
            }
            io.appendChild(ioThumb(input.out, input.id));
        });
        body.append(title, detail, io);

        const outWrap = document.createElement("div");
        outWrap.className = "out";
        outWrap.innerHTML = shapeSVG(step.out, 62);
        const code = document.createElement("code");
        code.textContent = step.outKey;
        outWrap.appendChild(code);

        card.append(idEl, body, outWrap);
        stepsEl.appendChild(card);
    }

    const final = document.createElement("div");
    final.className = "final";
    final.innerHTML = `
      <div class="left">
        ${shapeSVG(res.flat.finalShape, 74)}
        <div>
          <div class="title">最终产物 · 与目标一致</div>
          <code>${res.flat.final.outKey}</code>
        </div>
      </div>`;
    const copy = document.createElement("button");
    copy.textContent = "复制方案 JSON";
    copy.className = "ghost";
    copy.addEventListener("click", async () => {
        const data = P.planToJSON(res.plan);
        try {
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            copy.textContent = "已复制 ✓";
            setTimeout(() => (copy.textContent = "复制方案 JSON"), 1500);
        } catch {
            copy.textContent = "复制失败";
        }
    });
    final.appendChild(copy);
    stepsEl.appendChild(final);

    const chains = colorChains(res.flat.steps);
    if (chains.length) {
        const head = document.createElement("div");
        head.className = "status ok";
        head.style.marginTop = "14px";
        head.textContent = "色料供应：每个上色口一条链；混色器不是 plan 步骤，但不建就出不了这个颜色";
        stepsEl.appendChild(head);
        for (const chain of chains) {
            const row = document.createElement("div");
            row.className = "step";
            row.style.gridTemplateColumns = "120px 1fr";
            const id = document.createElement("div");
            id.className = "id";
            id.textContent = `${chain.stepId} 颜色口${chain.slot}`;
            const body = document.createElement("div");
            const title = document.createElement("div");
            title.className = "op";
            title.textContent = `颜色 ${chain.color}`;
            const detail = document.createElement("div");
            detail.className = "detail";
            detail.textContent = chain.ops
                .map((op) => (op.kind === "mixer" ? `混色器 ${op.parts.join("+")}` : `采矿机 ${op.color}`))
                .join(" → ");
            body.append(title, detail);
            row.append(id, body);
            stepsEl.appendChild(row);
        }
    }
    const bomChip = document.createElement("span");
    bomChip.className = "chip";
    bomChip.textContent = `材料 ${planBom(expandPlanTree(res.flat))
        .map((b) => `${b.zh}×${b.n}`)
        .join("、")}`;
    resultMeta.appendChild(bomChip);

    lastResult = res;
}

/* ------------------------------------------------------------------ *
 * solving
 * ------------------------------------------------------------------ */

async function doSolve(): Promise<void> {
    const parsed = S.tryParse(shapeInput.value.trim());
    if (!parsed.ok) return;
    solveBtn.disabled = true;
    statusEl.className = "status busy";
    statusEl.textContent = "正在推理生产方案…";
    stepsEl.innerHTML = "";
    resultMeta.innerHTML = "";

    // let the browser paint the busy state before the (synchronous) search
    await new Promise<void>((r) => setTimeout(r, 30));
    const t0 = performance.now();
    let res: SolveResult;
    try {
        res = solve(parsed.shape, {
            buildings: new Set(currentBuildings),
            maxAttempts: 30000,
        });
    } catch (e) {
        statusEl.className = "status err";
        statusEl.textContent = "求解异常: " + (e instanceof Error ? e.message : String(e));
        solveBtn.disabled = false;
        return;
    }
    const ms = Math.round(performance.now() - t0);
    if (res.ok) {
        const meta = document.createElement("span");
        meta.className = "chip";
        meta.textContent = `${ms} ms`;
        renderPlan(res);
        resultMeta.appendChild(meta);
    } else {
        renderPlan(res);
    }
    solveBtn.disabled = false;
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

shapeInput.addEventListener("input", onInputChanged);
shapeInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") doSolve();
});
solveBtn.addEventListener("click", doSolve);
levelSet.addEventListener("change", renderLevelPick);
levelPick.addEventListener("change", onLevelChange);
mustGet<HTMLButtonElement>("reset-buildings").addEventListener("click", () => setBuildings(new Set(ALL_BUILDINGS)));
mustGet<HTMLSelectElement>("all-set").addEventListener("change", renderAllLevels);

renderBuildings();
renderLevelPick();
renderAllLevels();
shapeInput.value = "RuCw--Cw:----Ru--";
onInputChanged();

/* ------------------------------------------------------------------ *
 * seed → campaign sheet
 * ------------------------------------------------------------------ */

interface GameContext {
    seed: number;
    hub: { x: number; y: number };
    level?: number;
    patches: Patch[];
    name?: string;
}

let gameCtx: GameContext | null = null;

/**
 * Decode an uploaded savegame file. Accepts shapez's raw client-storage dump
 * ("\x01" + LZ-String, i.e. savegame-*.bin), a {"save": "..."} JSON wrapper,
 * or an already-decoded dump JSON.
 */
function decodeSaveText(text: string): unknown {
    if (text.trimStart().startsWith("{")) {
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch (e) {
            throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
        }
        // JSON.parse gives no type: the wrapper is either {save} or a decoded dump
        const wrapper = json as { save?: unknown; dump?: unknown; map?: unknown };
        if (typeof wrapper.save === "string") return decodeSavegame(wrapper.save).payload;
        if (wrapper.dump || wrapper.map) return json;
        throw new Error("JSON 里没有 save（原始存档）或 dump（解码后的存档）");
    }
    try {
        return decodeSavegame(text).payload;
    } catch (e) {
        throw new Error(`不是可识别的 shapez 存档（${e instanceof Error ? e.message : String(e)}）`);
    }
}

async function readSaveFile(file: File): Promise<GameContext> {
    const payload = decodeSaveText(await file.text());
    const info = savegameMapInfo(payload);
    // wide enough that every shape type the campaign needs (windmill/star
    // deposits only exist far out) is on the map
    const patches = scanMap(info.seed, { chunkRadius: 8 });
    return { seed: info.seed, hub: info.hub, level: info.level, patches, name: file.name };
}

function renderMapSummary(): void {
    const el = mustGet<HTMLElement>("map-summary");
    const meta = mustGet<HTMLElement>("map-meta");
    meta.innerHTML = "";
    if (!gameCtx) {
        el.textContent = "";
        return;
    }
    if (gameCtx.name) {
        const chipFile = document.createElement("span");
        chipFile.className = "chip";
        chipFile.textContent = gameCtx.name;
        meta.appendChild(chipFile);
    }
    const chipSeed = document.createElement("span");
    chipSeed.className = "chip";
    chipSeed.textContent = `seed ${gameCtx.seed}`;
    const chipLevel = document.createElement("span");
    chipLevel.className = "chip";
    chipLevel.textContent = `第 ${gameCtx.level} 关`;
    const chipHub = document.createElement("span");
    chipHub.className = "chip";
    chipHub.textContent = `中心 (${gameCtx.hub.x},${gameCtx.hub.y})`;
    meta.append(chipSeed, chipLevel, chipHub);

    const hx = gameCtx.hub.x + 2;
    const hy = gameCtx.hub.y + 2;
    const list = [...gameCtx.patches]
        .sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy))
        .slice(0, 10);
    el.innerHTML =
        "最近的矿脉：" +
        list
            .map(
                (p) =>
                    `<code>(${p.x.toFixed(0)},${p.y.toFixed(0)}) ${itemLabel(p.item)} · ${Math.hypot(
                        p.x - hx,
                        p.y - hy
                    ).toFixed(0)} 格</code>`
            )
            .join(" · ");
}

async function onLoadSave(): Promise<void> {
    const input = mustGet<HTMLInputElement>("save-file");
    const file = input.files?.[0];
    if (!file) return;
    try {
        const loaded = await readSaveFile(file);
        gameCtx = loaded;
        mustGet<HTMLInputElement>("seed-input").value = String(loaded.seed);
        const untilPick = mustGet<HTMLSelectElement>("all-until");
        const level = loaded.level;
        if (level && [...untilPick.options].some((o) => Number(o.value) === level)) {
            untilPick.value = String(level);
        }
        renderMapSummary();
    } catch (e) {
        gameCtx = null;
        renderMapSummary();
        mustGet<HTMLElement>("map-summary").textContent = `${file.name}：${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * Map the drawing button works on: the seed field is the input, and a loaded
 * save only contributes its real hub position when its seed matches.
 */
function mapContext(): { seed: number; hub: { x: number; y: number } } {
    const seed = Number(mustGet<HTMLInputElement>("seed-input").value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 999999) throw new Error("地图种子应是 0–999999 的整数");
    const hub = gameCtx && gameCtx.seed === seed ? gameCtx.hub : { x: -2, y: -2 };
    return { seed, hub };
}

interface CampaignMeta {
    set: NeedSetName;
    seed?: number;
    radius: number;
}

function renderCampaign(res: CampaignResult, meta: CampaignMeta): void {
    const el = mustGet<HTMLElement>("placement");
    el.innerHTML = "";
    const makeCard = (title: string): HTMLDivElement => {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `<h3>${title}</h3>`;
        el.appendChild(card);
        return card;
    };

    const scope = res.totals.untilLevel ? ` · 只画 L≤${res.totals.untilLevel}` : "";
    const tableCard = makeCard(
        `全部需求图形（需求 ${res.totals.requested} 种${scope}）：${res.totals.shapes} 种可建${
            meta && meta.seed !== undefined ? ` · 种子 ${meta.seed}` : ""
        }`
    );
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>#</th><th>图形</th><th>建筑</th><th>传送带</th><th>产能</th><th>交付</th><th>可建</th><th>来源</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const e of res.entries) {
        const tr = document.createElement("tr");
        const why = e.sources.map(describeSource).join(" / ");
        if (e.status === "deferred" || e.status === "impossible") {
            const at = e.status === "deferred" ? `L${e.availableAt}+` : "不可建";
            tr.innerHTML = `<td>${e.index}</td><td><code>${e.code}</code></td><td colspan="4">${e.reason}</td><td>${at}</td><td>${why}</td>`;
        } else if (!e.ok) {
            tr.innerHTML = `<td>${e.index}</td><td><code>${e.code}</code></td><td colspan="4">无法求解</td><td>${
                e.error || ""
            }</td>`;
        } else {
            const gap = e.missing.length
                ? ` ⚠ 缺 ${e.missing.map((m) => m.replace(/^shape:/, "")).join(", ")}`
                : "";
            tr.innerHTML = `<td>${e.index}</td><td><code>${e.code}</code></td><td>${e.buildings}</td><td>${
                e.belts
            }</td><td>${formatRate(e.effectiveRate)}</td><td>${formatDuration(e.eta)}</td><td>L${
                e.availableAt
            }</td><td>${why}${gap}</td>`;
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableCard.appendChild(table);

    const bomCard = makeCard("材料 / 颜色");
    const lines: string[] = [];
    lines.push(`合计 ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格`);
    lines.push(`建筑：${res.layout.bom.map((b) => `${b.zh}×${b.n}`).join("、")}`);
    for (const c of res.layout.colors) {
        // a base colour the map lacks has no recipe, and this expression has
        // always thrown on it; `!` keeps that instead of inventing output
        lines.push(
            c.direct
                ? `颜色 ${c.color}：地图上有矿脉 (${c.patch.x.toFixed(0)},${c.patch.y.toFixed(0)})`
                : `颜色 ${c.color}：无直接矿脉，需混合 ${c.mix ? c.mix.join("+") : "—"}`
        );
    }
    for (const m of res.layout.missing) lines.push(`⚠ 缺失资源：${m}`);
    const perf = res.totals.throughput;
    lines.push(
        `产能（游戏额定速度 · 升级 1）：传送带 ${perf.beltRate}/s、采矿机 ${perf.minerRate}/s、色料源 ${perf.sourceRate}/s`
    );
    if (perf.demandTotal > 0) {
        lines.push(
            `色料：每口一链共 ${perf.builtSourceCount} 台（需求 ${perf.demandTotal.toFixed(2)}/s，供给 ${perf.supplyAvailable.toFixed(
                2
            )}/s）；按需求只需 ${perf.demandSizedCount} 台 —— L4 后共享色料厂能省 ${
                perf.builtSourceCount - perf.demandSizedCount
            } 台，代价是要自己接分流`
        );
    }
    if (perf.extraSources > 0) {
        lines.push(
            `色料源缺口：还需 ${perf.extraSources} 台（${perf.colorGap
                .map((g) => `${g.color} ${g.have}→${g.need} ${g.kind}`)
                .join("、")}）`
        );
    }
    for (const g of perf.capacityGap) {
        lines.push(`⚠ 矿脉放不下：${g.color} 需要 ${g.need} 台，图上可达上限 ${g.capacity} 台`);
    }
    lines.push(
        `运输缺口：分流节点 ${perf.splitters} 个（最坏一个出口 ${perf.worstFanout} 条）、中心并带 ${perf.hubMerges} 个（${perf.hubInbound} 条带进 12 个面）`
    );
    if (res.totals.routingGaps) {
        lines.push(`⚠ 布线失败 ${res.totals.routingGaps} 条：端口被别的建筑堵住（图纸上用红色虚线标出）`);
    }
    if (perf.balancerAt) lines.push(`平衡器 L${perf.balancerAt} 解锁：在此之前不能分叉/汇合，中心最多 12 条带`);
    if (perf.tunnelAt) lines.push(`隧道 L${perf.tunnelAt} 解锁：在此之前走线不能交叉`);
    bomCard.innerHTML += `<div style="line-height:1.9;font-size:12.5px">${lines.join("<br/>")}</div>`;
}

async function onAll(): Promise<void> {
    const btn = mustGet<HTMLButtonElement>("all-btn");
    btn.disabled = true;
    const box = mustGet<HTMLElement>("schematic");
    const status = mustGet<HTMLElement>("all-status");
    status.textContent = "";
    box.innerHTML = `<div style="padding:16px;color:#6b7280">求解全部需求图形中…</div>`;
    await new Promise<void>((r) => setTimeout(r, 30));
    try {
        const ctx = mapContext();
        const set = mustGet<HTMLSelectElement>("all-set").value as NeedSetName;
        const untilPick = mustGet<HTMLSelectElement>("all-until");
        const untilLevel = untilPick.value ? Number(untilPick.value) : null;
        const shapes = neededShapes({ set });
        const scan = scanForTypes(ctx.seed, {
            types: requiredTypes(shapes),
            startRadius: set === "full" ? 10 : 8,
            maxRadius: 32,
        });
        const res = planCampaign({
            shapes,
            patches: scan.patches,
            hub: ctx.hub,
            buildings: new Set(ALL_BUILDINGS),
            untilLevel,
            levels: set === "full" ? FULL_LEVELS : DEMO_LEVELS,
        });
        const usedPatches: Patch[] = [];
        for (const s of res.layout.sources) if (s.patch) usedPatches.push(s.patch);
        for (const c of res.layout.colors) if (c.patch) usedPatches.push(c.patch);
        box.innerHTML = schematicSVG(res.layout, usedPatches, { campaign: true });
        renderCampaign(res, { set, seed: ctx.seed, radius: scan.radius });
        status.textContent =
            `种子 ${ctx.seed} · 扫描半径 ${scan.radius} chunk · ` +
            (res.totals.failed ? `${res.totals.failed} 种无法求解 · ` : "") +
            (res.totals.deferred ? `${res.totals.deferred} 种要更高关卡 · ` : "") +
            (res.totals.impossible ? `${res.totals.impossible} 种本版本没有对应机器 · ` : "") +
            `${res.totals.shapes} 种可建 · ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格` +
            (scan.missingTypes.length ? ` · ⚠ 缺 ${scan.missingTypes.join("/")} 矿脉` : "");
    } catch (e) {
        box.innerHTML = `<div style="padding:16px;color:#a5342f">${e instanceof Error ? e.message : String(e)}</div>`;
        mustGet<HTMLElement>("placement").innerHTML = "";
    } finally {
        btn.disabled = false;
    }
}

mustGet<HTMLInputElement>("save-file").addEventListener("change", onLoadSave);
mustGet<HTMLButtonElement>("all-btn").addEventListener("click", onAll);
