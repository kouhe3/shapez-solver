import * as S from "../src/shape.js";
import * as P from "../src/plan.js";
import { shapeSVG } from "../src/render.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel, REWARD_BUILDINGS } from "../src/levels.js";
import { scanMap, scanForTypes, itemLabel } from "../src/map.js";
import { decodeSavegame } from "../src/savegame.js";
import { schematicSVG } from "../src/schematic.js";
import { neededShapes, requiredTypes, describeSource } from "../src/needs.js";
import { planCampaign } from "../src/campaign.js";

const BUILDING_LABELS = {
    cutter: "切割机",
    quadCutter: "四向切割机",
    rotaterCW: "旋转器 (顺时针)",
    rotaterCCW: "旋转器 (逆时针)",
    rotater180: "旋转器 (180°)",
    stacker: "堆叠器",
    painter: "上色器",
    quadPainter: "四色上色器",
};

const $ = (id) => document.getElementById(id);
const shapeInput = $("shape-input");
const solveBtn = $("solve-btn");
const shapeHint = $("shape-hint");
const preview = $("target-preview");
const statusEl = $("status");
const stepsEl = $("steps");
const resultMeta = $("result-meta");
const levelSet = $("level-set");
const levelPick = $("level-pick");
const levelHint = $("level-hint");
const buildingList = $("building-list");

let currentBuildings = new Set(ALL_BUILDINGS);
let lastResult = null;

/* ------------------------------------------------------------------ *
 * buildings
 * ------------------------------------------------------------------ */

function renderBuildings() {
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

function setBuildings(set) {
    currentBuildings = new Set(set);
    for (const cb of buildingList.querySelectorAll("input[type=checkbox]")) {
        cb.checked = currentBuildings.has(cb.dataset.building);
    }
    updateSolveState();
}

/* ------------------------------------------------------------------ *
 * levels
 * ------------------------------------------------------------------ */

function levelsFor(setName) {
    return setName === "game" ? FULL_LEVELS : DEMO_LEVELS;
}

function renderLevelPick() {
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

function onLevelChange() {
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

/* ------------------------------------------------------------------ *
 * input handling
 * ------------------------------------------------------------------ */

function onInputChanged() {
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

function updateSolveState() {
    const parsed = S.tryParse(shapeInput.value.trim());
    solveBtn.disabled = !parsed.ok;
}

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

function ioThumb(shape, caption) {
    const wrap = document.createElement("div");
    wrap.className = "io-item";
    wrap.innerHTML = shapeSVG(shape, 46);
    const cap = document.createElement("span");
    cap.textContent = caption;
    wrap.appendChild(cap);
    return wrap;
}

function renderPlan(res) {
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

    const counts = new Map();
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
            step.op === "paint4"
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

    lastResult = res;
}

/* ------------------------------------------------------------------ *
 * solving
 * ------------------------------------------------------------------ */

async function doSolve() {
    const parsed = S.tryParse(shapeInput.value.trim());
    if (!parsed.ok) return;
    solveBtn.disabled = true;
    statusEl.className = "status busy";
    statusEl.textContent = "正在推理生产方案…";
    stepsEl.innerHTML = "";
    resultMeta.innerHTML = "";

    // let the browser paint the busy state before the (synchronous) search
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    let res;
    try {
        res = solve(parsed.shape, {
            buildings: new Set(currentBuildings),
            maxAttempts: 30000,
        });
    } catch (e) {
        statusEl.className = "status err";
        statusEl.textContent = "求解异常: " + e.message;
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
shapeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSolve();
});
solveBtn.addEventListener("click", doSolve);
levelSet.addEventListener("change", renderLevelPick);
levelPick.addEventListener("change", onLevelChange);
$("reset-buildings").addEventListener("click", () => setBuildings(new Set(ALL_BUILDINGS)));

renderBuildings();
renderLevelPick();
shapeInput.value = "RuCw--Cw:----Ru--";
onInputChanged();

/* ------------------------------------------------------------------ *
 * seed → campaign sheet
 * ------------------------------------------------------------------ */

let gameCtx = null;

async function openDb(name) {
    return await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error || new Error("indexeddb error"));
    });
}

function getAll(store, method, arg) {
    return new Promise((res, rej) => {
        const r = store[method](arg);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

async function readGameSave() {
    let db;
    try {
        db = await openDb("app_storage");
    } catch (e) {
        throw new Error("读不到 app_storage：需要和游戏同源打开本页（http://127.0.0.1:8087/solver/web/）");
    }
    if (!db.objectStoreNames.contains("files")) throw new Error("存档库结构不认识（不是 shapez 的 app_storage）");
    const store = db.transaction("files", "readonly").objectStore("files");
    const keys = await getAll(store, "getAllKeys");
    const key = keys
        .map(String)
        .filter((k) => k.startsWith("savegame-"))
        .sort()
        .pop();
    if (!key) throw new Error("没有找到存档（先在游戏里 PLAY 存一个档）");
    const record = await getAll(store, "get", key);
    const { payload } = decodeSavegame(record.contents);
    const dump = payload.dump || payload;
    const seed = dump.map && dump.map.seed;
    if (typeof seed !== "number") throw new Error("存档里没有地图种子");
    let hub = { x: -2, y: -2 };
    for (const e of dump.entities || []) {
        const sm = e && e.components && e.components.StaticMapEntity;
        if (sm && sm.code === 26 && sm.origin) hub = sm.origin;
    }
    // wide enough that every shape type the campaign needs (windmill/star
    // deposits only exist far out) is on the map
    const patches = scanMap(seed, { chunkRadius: 8 });
    return {
        seed,
        hub,
        level: dump.hubGoals && dump.hubGoals.level,
        patches,
        key,
    };
}

function renderMapSummary() {
    const el = $("map-summary");
    const meta = $("map-meta");
    meta.innerHTML = "";
    if (!gameCtx) {
        el.textContent = "";
        return;
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

async function onLoadSave() {
    const btn = $("load-save-btn");
    btn.disabled = true;
    try {
        gameCtx = await readGameSave();
        $("seed-input").value = String(gameCtx.seed);
        renderMapSummary();
    } catch (e) {
        $("map-summary").textContent = e.message;
        gameCtx = null;
    } finally {
        btn.disabled = false;
    }
}

/**
 * Map the drawing button works on: the seed field is the input, and a loaded
 * save only contributes its real hub position when its seed matches.
 */
function mapContext() {
    const seed = Number($("seed-input").value);
    if (!Number.isInteger(seed) || seed < 0 || seed > 999999) throw new Error("地图种子应是 0–999999 的整数");
    const hub = gameCtx && gameCtx.seed === seed ? gameCtx.hub : { x: -2, y: -2 };
    return { seed, hub };
}

function renderCampaign(res, meta) {
    const el = $("placement");
    el.innerHTML = "";
    const makeCard = (title) => {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `<h3>${title}</h3>`;
        el.appendChild(card);
        return card;
    };

    const tableCard = makeCard(
        `全部需求图形（${res.totals.shapes} 种${meta && meta.seed !== undefined ? ` · 种子 ${meta.seed}` : ""}）`
    );
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>#</th><th>图形</th><th>建筑</th><th>传送带</th><th>来源</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const e of res.entries) {
        const tr = document.createElement("tr");
        const why = e.sources.map(describeSource).join(" / ");
        if (!e.ok) {
            tr.innerHTML = `<td>${e.index}</td><td><code>${e.code}</code></td><td colspan="2">无法求解</td><td>${
                e.error || ""
            }</td>`;
        } else {
            const gap = e.missing.length
                ? ` ⚠ 缺 ${e.missing.map((m) => m.replace(/^shape:/, "")).join(", ")}`
                : "";
            tr.innerHTML = `<td>${e.index}</td><td><code>${e.code}</code></td><td>${e.buildings}</td><td>${e.belts}</td><td>${why}${gap}</td>`;
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableCard.appendChild(table);

    const bomCard = makeCard("材料 / 颜色");
    const lines = [];
    lines.push(`合计 ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格`);
    lines.push(`建筑：${res.layout.bom.map((b) => `${b.zh}×${b.n}`).join("、")}`);
    for (const c of res.layout.colors) {
        lines.push(
            c.direct
                ? `颜色 ${c.color}：地图上有矿脉 (${c.patch.x.toFixed(0)},${c.patch.y.toFixed(0)})`
                : `颜色 ${c.color}：无直接矿脉，需混合 ${c.mix.join("+")}`
        );
    }
    for (const m of res.layout.missing) lines.push(`⚠ 缺失资源：${m}`);
    bomCard.innerHTML += `<div style="line-height:1.9;font-size:12.5px">${lines.join("<br/>")}</div>`;
}

async function onAll() {
    const btn = $("all-btn");
    btn.disabled = true;
    const box = $("schematic");
    const status = $("all-status");
    status.textContent = "";
    box.innerHTML = `<div style="padding:16px;color:#6b7280">求解全部需求图形中…</div>`;
    await new Promise((r) => setTimeout(r, 30));
    try {
        const ctx = mapContext();
        const set = $("all-set").value;
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
            buildings: new Set(currentBuildings),
        });
        const usedPatches = [];
        for (const s of res.layout.sources) if (s.patch) usedPatches.push(s.patch);
        for (const c of res.layout.colors) if (c.patch) usedPatches.push(c.patch);
        box.innerHTML = schematicSVG(res.layout, usedPatches, { campaign: true });
        renderCampaign(res, { set, seed: ctx.seed, radius: scan.radius });
        status.textContent =
            `种子 ${ctx.seed} · 扫描半径 ${scan.radius} chunk · ` +
            (res.totals.failed ? `${res.totals.failed} 种无法求解 · ` : "") +
            `${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格` +
            (scan.missingTypes.length ? ` · ⚠ 缺 ${scan.missingTypes.join("/")} 矿脉` : "");
    } catch (e) {
        box.innerHTML = `<div style="padding:16px;color:#a5342f">${e.message}</div>`;
        $("placement").innerHTML = "";
    } finally {
        btn.disabled = false;
    }
}

$("load-save-btn").addEventListener("click", onLoadSave);
$("all-btn").addEventListener("click", onAll);
