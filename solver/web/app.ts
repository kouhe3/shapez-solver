import * as S from "../src/shape.js";
import * as P from "../src/plan.js";
import { shapeSVG } from "../src/render.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";
import type { SolveResult } from "../src/solver.js";
import { levelsForVersion, buildingsForLevel } from "../src/levels.js";
import { scanMap, itemLabel } from "../src/map.js";
import type { Patch } from "../src/map.js";
import { decodeSavegame, savegameMapInfo } from "../src/savegame.js";
import {
    schematicSVG,
    KIND_COLOR,
    MAP_THEME,
    HUB_COLOR,
    INK,
    TUNNEL_SENDER,
    TUNNEL_RECEIVER,
} from "../src/schematic.js";
import type { NeedSetName } from "../src/needs.js";
import type { CampaignResult } from "../src/campaign.js";
import { colorChains } from "../src/color.js";
import { planBom, expandPlanTree, fuseCuts, fusedCost } from "../src/layout.js";
import type { BuildingKind, PlanTree } from "../src/layout.js";
import type { CampaignJob, CampaignReply } from "./worker.js";

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

/** layout building kinds, in the order the legend shows them */
const KIND_ORDER: BuildingKind[] = [
    "base",
    "cutHalf",
    "cutQuad",
    "rotate",
    "stack",
    "paint",
    "paint4",
    "mixer",
    "splitter",
    "merger",
    "trash",
];

const KIND_LABELS: Record<BuildingKind, string> = {
    base: "采矿机",
    cutHalf: "切割机",
    cutQuad: "四向切割机",
    rotate: "旋转器",
    stack: "堆叠器",
    paint: "上色器",
    paint4: "四色上色器",
    mixer: "混色器",
    splitter: "分流器",
    merger: "合并器",
    trash: "垃圾桶",
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
const recipeStage = mustGet<HTMLElement>("recipe-stage");
const recipeHint = mustGet<HTMLElement>("recipe-hint");
const sheetStage = mustGet<HTMLElement>("schematic-stage");
const sheetHint = mustGet<HTMLElement>("sheet-hint");
const sheetLegend = mustGet<HTMLElement>("sheet-legend");

let currentBuildings: Set<string> = new Set(ALL_BUILDINGS);
let lastResult: SolveResult | null = null;

/* ------------------------------------------------------------------ *
 * pan / zoom viewport
 * ------------------------------------------------------------------ */

interface PanZoom {
    fit(): void;
    zoomBy(factor: number): void;
}

interface PanZoomOptions {
    /** "height" fills the viewport height and pans sideways (a long single row) */
    mode?: "contain" | "height";
}

/**
 * Drag to pan, wheel to zoom around the cursor, double-click to fit.
 * The legend and zoom bar live next to the stage, so they stay put.
 */
function attachPanZoom(viewport: HTMLElement, stage: HTMLElement, opts: PanZoomOptions = {}): PanZoom {
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const apply = (): void => {
        stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    const naturalSize = (): { w: number; h: number } => {
        const svg = stage.querySelector("svg");
        if (!svg) return { w: 0, h: 0 };
        return { w: Number(svg.getAttribute("width")) || 0, h: Number(svg.getAttribute("height")) || 0 };
    };

    const fit = (): void => {
        const { w, h } = naturalSize();
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        if (!w || !h || !vw || !vh) return;
        const pad = 24;
        const byWidth = (vw - pad * 2) / w;
        const byHeight = (vh - pad * 2) / h;
        if (opts.mode === "height") {
            scale = Math.min(1, byHeight);
            tx = pad;
            ty = Math.max(pad, (vh - h * scale) / 2);
        } else {
            scale = Math.min(1, byWidth, byHeight);
            tx = (vw - w * scale) / 2;
            ty = (vh - h * scale) / 2;
        }
        apply();
    };

    const zoomAt = (factor: number, mx: number, my: number): void => {
        const next = Math.min(8, Math.max(0.02, scale * factor));
        tx = mx - (mx - tx) * (next / scale);
        ty = my - (my - ty) * (next / scale);
        scale = next;
        apply();
    };

    viewport.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            const rect = viewport.getBoundingClientRect();
            zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
        },
        { passive: false }
    );

    viewport.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        // without this the browser starts a text selection and drags it along
        event.preventDefault();
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add("dragging");
        document.body.classList.add("panning");
    });

    viewport.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        tx += event.clientX - lastX;
        ty += event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        apply();
    });

    const endDrag = (event: PointerEvent): void => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove("panning");
        viewport.classList.remove("dragging");
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
    viewport.addEventListener("dblclick", () => fit());

    new ResizeObserver(() => fit()).observe(viewport);

    return {
        fit,
        zoomBy: (factor: number) => zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2),
    };
}

const recipePz = attachPanZoom(mustGet<HTMLElement>("recipe-viewport"), recipeStage, { mode: "height" });
const sheetPz = attachPanZoom(mustGet<HTMLElement>("schematic"), sheetStage);

/* ------------------------------------------------------------------ *
 * views
 * ------------------------------------------------------------------ */

type ViewName = "recipe" | "sheet";

function setView(view: ViewName): void {
    for (const tab of document.querySelectorAll<HTMLButtonElement>("#view-tabs .tab")) {
        tab.classList.toggle("active", tab.dataset.view === view);
    }
    mustGet<HTMLElement>("view-recipe").hidden = view !== "recipe";
    mustGet<HTMLElement>("view-sheet").hidden = view !== "sheet";
    const pz = view === "recipe" ? recipePz : sheetPz;
    // the hidden viewport has no size, so fit once it is on screen
    requestAnimationFrame(() => pz.fit());
}

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

function renderLevelPick(): void {
    const levels = levelsForVersion(levelSet.value as NeedSetName);
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
    const levels = levelsForVersion(levelSet.value as NeedSetName);
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
    const levels = levelsForVersion(mustGet<HTMLSelectElement>("all-set").value as NeedSetName);
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
 * recipe graph: dependency waves
 * ------------------------------------------------------------------ */

const PLAN_NODE = { w: 180, h: 86 };
const COLOR_NODE = { w: 152, h: 54 };
const COL_GAP = 48;
const ROW_GAP = 10;
const PAD = 24;
const HEAD = 36;
/** an edge that skips a wave would run under cards, so it dodges below them on its own lane */
const LANE_STEP = 13;
const LANE_INSET = 16;

interface RecipeItem {
    id: string;
    kind: "plan" | "color";
    step?: P.PlanStep;
    color?: S.ColorChar;
    /** colour chains only: the painter port this chain feeds (`v16 端口2`) */
    owner?: string;
    title: string;
    detail: string;
    inputs: RecipeItem[];
    wave: number;
    isFinal: boolean;
}

interface ItemBox {
    item: RecipeItem;
    x: number;
    y: number;
    w: number;
    h: number;
}

function shortCode(code: string, max: number): string {
    return code.length > max ? `${code.slice(0, max - 1)}…` : code;
}

function sizeOf(item: RecipeItem): { w: number; h: number } {
    return item.kind === "plan" ? PLAN_NODE : COLOR_NODE;
}

/**
 * Plan steps plus the colour chains every painter port needs. A mixed colour
 * is real buildings (a mixer tree), so it belongs in the same dependency
 * graph; each port owns its own chain, matching what `buildLayout` places.
 */
function buildRecipeItems(flat: PlanTree): RecipeItem[] {
    // a quad cutter's quadrants and a cutter's two halves are output slots of
    // one machine: draw it once and hang every consumer off that card
    const fused = fuseCuts(flat);
    const aliases = new Map<string, P.PlanStep[]>();
    const repOf = new Map<string, string>();
    for (const step of fused.steps) {
        if (!step.fuseInto) continue;
        repOf.set(step.id, step.fuseInto);
        const list = aliases.get(step.fuseInto) || [];
        list.push(step);
        aliases.set(step.fuseInto, list);
    }
    const items: RecipeItem[] = [];
    const byId = new Map<string, RecipeItem>();

    for (const step of fused.steps) {
        if (step.fuseInto) continue;
        const extra = aliases.get(step.id) || [];
        const item: RecipeItem = {
            id: step.id,
            kind: "plan",
            step,
            title: `${step.id} · ${P.OP_LABELS[step.op] ?? step.op}`,
            detail: [step.detail, ...extra.map((s) => s.detail)].filter(Boolean).join(" · "),
            inputs: [],
            wave: 0,
            isFinal: step === fused.final,
        };
        byId.set(step.id, item);
        items.push(item);
    }
    for (const step of fused.steps) {
        if (step.fuseInto) continue;
        const item = byId.get(step.id);
        if (!item) continue;
        for (const input of step.inputs) {
            const from = byId.get(input.id) ?? byId.get(repOf.get(input.id) ?? "");
            if (from) item.inputs.push(from);
        }
    }

    for (const chain of colorChains(fused.steps)) {
        const paint = byId.get(chain.stepId);
        if (!paint) continue;
        const chainItems: RecipeItem[] = chain.ops.map((op, index) => {
            const item: RecipeItem = {
                id: `${chain.stepId}:${chain.slot}:${index}`,
                kind: "color",
                color: op.color,
                owner: `${chain.stepId} 端口${chain.slot}`,
                title: op.kind === "base" ? "采矿机" : "混色器",
                detail: op.kind === "base" ? `颜色 ${op.color}` : `${op.parts.join(" + ")} → ${op.color}`,
                inputs: [],
                wave: 0,
                isFinal: false,
            };
            items.push(item);
            return item;
        });
        chain.ops.forEach((op, index) => {
            if (op.kind !== "mixer") return;
            const to = chainItems[index];
            if (!to) return;
            for (const operand of op.operands) {
                const from = chainItems[operand];
                if (from) to.inputs.push(from);
            }
        });
        const last = chainItems[chainItems.length - 1];
        if (last) paint.inputs.push(last);
    }

    // lazy waves: every op sits as late as possible, just left of its first
    // consumer, and the final product is the rightmost column. One rule for
    // shape ops and colour chains alike.
    const consumers = new Map<RecipeItem, RecipeItem[]>();
    for (const item of items) {
        for (const input of item.inputs) {
            const list = consumers.get(input);
            if (list) list.push(item);
            else consumers.set(input, [item]);
        }
    }
    const distance = new Map<RecipeItem, number>();
    const depthOf = (item: RecipeItem): number => {
        const known = distance.get(item);
        if (known !== undefined) return known;
        const downstream = consumers.get(item) ?? [];
        const depth = downstream.length ? Math.max(...downstream.map((c) => depthOf(c) + 1)) : 0;
        distance.set(item, depth);
        return depth;
    };
    for (const item of items) depthOf(item);
    const maxDepth = Math.max(...items.map((item) => distance.get(item) ?? 0), 0);
    for (const item of items) item.wave = maxDepth - (distance.get(item) ?? 0);
    return items;
}

function recipeSVG(flat: PlanTree): string {
    const items = buildRecipeItems(flat);
    const order = new Map<RecipeItem, number>(items.map((item, i) => [item, i]));
    const maxWave = Math.max(...items.map((item) => item.wave), 0);
    const layers: RecipeItem[][] = [];
    for (let wave = 0; wave <= maxWave; wave++) layers.push([]);
    for (const item of items) layers[item.wave]?.push(item);
    for (const layer of layers) layer.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    const colHeights = layers.map(
        (layer) => layer.reduce((sum, item) => sum + sizeOf(item).h, 0) + Math.max(0, layer.length - 1) * ROW_GAP
    );
    // one row only: every wave sits to the right of the previous one
    const width = PAD * 2 + layers.length * PLAN_NODE.w + Math.max(0, layers.length - 1) * COL_GAP;
    const contentBottom = PAD + HEAD + Math.max(...colHeights, 0);

    const boxes = new Map<RecipeItem, ItemBox>();
    layers.forEach((layer, wave) => {
        const colX = PAD + wave * (PLAN_NODE.w + COL_GAP);
        let y = PAD + HEAD;
        for (const item of layer) {
            const size = sizeOf(item);
            boxes.set(item, { item, x: colX + (PLAN_NODE.w - size.w) / 2, y, w: size.w, h: size.h });
            y += size.h + ROW_GAP;
        }
    });

    const edges = renderRecipeEdges(items, boxes, contentBottom);
    const bottom = edges.laneCount
        ? contentBottom + LANE_INSET + (edges.laneCount - 1) * LANE_STEP + LANE_INSET
        : contentBottom;
    const height = bottom + PAD;

    const titles: string[] = [];
    const nodes: string[] = [];
    layers.forEach((layer, wave) => {
        const colX = PAD + wave * (PLAN_NODE.w + COL_GAP);
        titles.push(
            `<text x="${colX}" y="${PAD + 18}" font-size="11.5" font-weight="600" fill="#6b7280">` +
                `${wave === 0 ? "第 1 波 · 采矿" : `第 ${wave + 1} 波`}` +
                `<tspan font-weight="400" fill="#9aa3b5"> · ${layer.length} 项</tspan></text>`
        );
        for (const item of layer) {
            const box = boxes.get(item);
            if (!box) continue;
            nodes.push(item.kind === "plan" ? planNodeSVG(box) : colorNodeSVG(box));
        }
    });

    const colors = [...new Set(items.filter((i) => i.color).map((i) => i.color as S.ColorChar))];
    const markers = [
        `<marker id="recipe-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
            `<path d="M 0 0 L 8 4 L 0 8 z" fill="#b6c0d4"/></marker>`,
        ...colors.map(
            (c) =>
                `<marker id="recipe-arrow-${c}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
                `<path d="M 0 0 L 8 4 L 0 8 z" fill="${S.COLOR_HEX[c] ?? "#b6c0d4"}"/></marker>`
        ),
    ].join("");

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" ` +
        `viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="Segoe UI, Microsoft YaHei, sans-serif">` +
        `<defs>${markers}</defs>` +
        `<rect width="100%" height="100%" fill="#fbfcfe"/>` +
        `<g>${edges.markup}</g>` +
        `<g>${titles.join("")}</g>` +
        `<g>${nodes.join("")}</g>` +
        `</svg>`
    );
}

interface EdgeSpec {
    from: ItemBox;
    to: ItemBox;
    side: "left" | "right" | "vertical";
    down: boolean;
    stroke: string;
    marker: string;
}

/**
 * Draws every dependency edge. Endpoints on one node side are spread apart —
 * outgoing above incoming — so an outgoing arrow never continues an incoming
 * one (that reads as a double-headed arrow).
 *
 * An edge that skips a wave would cross the cards of the column in between,
 * so it dives below the whole board on its own lane and climbs back up at the
 * target. One lane per such edge keeps them from drawing over each other.
 */
function renderRecipeEdges(
    items: RecipeItem[],
    boxes: Map<RecipeItem, ItemBox>,
    contentBottom: number
): { markup: string; laneCount: number } {
    const specs: EdgeSpec[] = [];
    for (const item of items) {
        const to = boxes.get(item);
        if (!to) continue;
        for (const input of item.inputs) {
            const from = boxes.get(input);
            if (!from) continue;
            const dx = to.x - from.x;
            const side: EdgeSpec["side"] = Math.abs(dx) < 1 ? "vertical" : dx > 0 ? "right" : "left";
            const color = input.color;
            specs.push({
                from,
                to,
                side,
                down: to.y > from.y,
                stroke: color ? (S.COLOR_HEX[color] ?? "#b6c0d4") : "#b6c0d4",
                marker: color ? `recipe-arrow-${color}` : "recipe-arrow",
            });
        }
    }

    const outGroups = new Map<string, number[]>();
    const inGroups = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, key: string, index: number): void => {
        const list = map.get(key);
        if (list) list.push(index);
        else map.set(key, [index]);
    };
    specs.forEach((spec, index) => {
        if (spec.side === "vertical") return;
        // group by the physical node side, not by the edge's travel direction:
        // a leftward edge leaves the source's left side and enters the
        // target's right side
        const fromSide = spec.side === "right" ? "right" : "left";
        const toSide = spec.side === "right" ? "left" : "right";
        add(outGroups, `${spec.from.item.id}|${fromSide}`, index);
        add(inGroups, `${spec.to.item.id}|${toSide}`, index);
    });

    const fraction = (rank: number, count: number, mixed: boolean, isOut: boolean): number => {
        if (!mixed) return rank / (count + 1);
        return isOut ? 0.16 + (0.28 * rank) / (count + 1) : 0.56 + (0.28 * rank) / (count + 1);
    };

    const laneOf = new Map<number, number>();
    specs.forEach((spec, index) => {
        if (spec.to.item.wave - spec.from.item.wave >= 2) laneOf.set(index, laneOf.size);
    });

    // lanes that share a gutter would stack their verticals on one pixel
    // column, so each gets its own stub offset inside that gutter
    const outStubs = new Map<number, number>();
    const inStubs = new Map<number, number>();
    const nextStub = (map: Map<number, number>, wave: number): number => {
        const n = map.get(wave) ?? 0;
        map.set(wave, n + 1);
        return Math.min(n, 7);
    };

    const paths = specs.map((spec, index) => {
        const { from, to, side, down, stroke, marker } = spec;
        if (side === "vertical") {
            const x = from.x + from.w / 2;
            const y1 = down ? from.y + from.h : from.y;
            const y2 = down ? to.y : to.y + to.h;
            const bend = Math.max(16, Math.abs(y2 - y1) * 0.5);
            return (
                `<path d="M ${x} ${y1} C ${x} ${y1 + (down ? bend : -bend)} ${x} ${y2 - (down ? bend : -bend)} ${x} ${y2}" ` +
                `fill="none" stroke="${stroke}" stroke-width="1.6" marker-end="url(#${marker})"/>`
            );
        }
        const rightward = side === "right";
        const fromSide = rightward ? "right" : "left";
        const toSide = rightward ? "left" : "right";
        const outList = outGroups.get(`${from.item.id}|${fromSide}`) ?? [];
        const inList = inGroups.get(`${to.item.id}|${toSide}`) ?? [];
        const fromInList = inGroups.get(`${from.item.id}|${fromSide}`) ?? [];
        const toOutList = outGroups.get(`${to.item.id}|${toSide}`) ?? [];
        const outRank = outList.indexOf(index) + 1;
        const inRank = inList.indexOf(index) + 1;
        const x1 = from.x + (rightward ? from.w : 0);
        const y1 = from.y + from.h * fraction(outRank, outList.length, fromInList.length > 0, true);
        const x2 = to.x + (rightward ? 0 : to.w);
        const y2 = to.y + to.h * fraction(inRank, inList.length, toOutList.length > 0, false);

        const lane = laneOf.get(index);
        if (lane !== undefined) {
            // the stub sits in the gutters beside the cards, so neither the
            // dive nor the climb touches a card
            const colRight = PAD + from.item.wave * (PLAN_NODE.w + COL_GAP) + PLAN_NODE.w;
            const colLeft = PAD + to.item.wave * (PLAN_NODE.w + COL_GAP);
            const xs = colRight + 8 + nextStub(outStubs, from.item.wave) * 5;
            const xt = colLeft - 8 - nextStub(inStubs, to.item.wave) * 5;
            const laneY = contentBottom + LANE_INSET + lane * LANE_STEP;
            const r = 4;
            const d =
                `M ${x1} ${y1} L ${xs - r} ${y1} Q ${xs} ${y1} ${xs} ${y1 + r} ` +
                `L ${xs} ${laneY - r} Q ${xs} ${laneY} ${xs + r} ${laneY} ` +
                `L ${xt - r} ${laneY} Q ${xt} ${laneY} ${xt} ${laneY - r} ` +
                `L ${xt} ${y2 + r} Q ${xt} ${y2} ${xt + r} ${y2} L ${x2} ${y2}`;
            return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" marker-end="url(#${marker})"/>`;
        }

        const bend = Math.max(24, Math.abs(x2 - x1) * 0.5) * (rightward ? 1 : -1);
        return (
            `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}" ` +
            `fill="none" stroke="${stroke}" stroke-width="1.6" marker-end="url(#${marker})"/>`
        );
    });
    return { markup: paths.join(""), laneCount: laneOf.size };
}

function planNodeSVG(box: ItemBox): string {
    const { item, x, y, w } = box;
    const step = item.step;
    if (!step) return "";
    const detail =
        step.node.op === "paint4"
            ? step.node.colors
                  .map((c, i) => (c && c !== "u" ? `端口${i + 1} ${c}` : ""))
                  .filter(Boolean)
                  .join(" · ")
            : item.detail;
    const code = shortCode(step.outKey, 18);
    const fill = item.isFinal ? "#f2faf5" : "#ffffff";
    const stroke = item.isFinal ? "#4f9d68" : "#dfe3ec";
    return (
        `<g><title>${step.outKey}\n${item.title}</title>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${PLAN_NODE.h}" rx="10" fill="${fill}" stroke="${stroke}" ` +
        `stroke-width="${item.isFinal ? 2 : 1}"/>` +
        `<text x="${x + 12}" y="${y + 20}" font-size="12" font-weight="600" fill="#2b2f3a">${item.title}</text>` +
        `<g transform="translate(${x + 12} ${y + 28})">${shapeSVG(step.out, 42, { background: false })}</g>` +
        `<text x="${x + 62}" y="${y + 46}" font-size="10" fill="#6b7280" font-family="ui-monospace, Consolas, monospace">${code}</text>` +
        `<text x="${x + 62}" y="${y + 62}" font-size="9.5" fill="#9aa3b5">cost ${step.cost}</text>` +
        `<text x="${x + w - 10}" y="${y + PLAN_NODE.h - 9}" font-size="9.5" text-anchor="end" fill="#9aa3b5">${detail}</text>` +
        `</g>`
    );
}

function colorNodeSVG(box: ItemBox): string {
    const { item, x, y, w } = box;
    const color = item.color ?? "u";
    const hex = S.COLOR_HEX[color] ?? "#dfe3ea";
    return (
        `<g><title>${item.title} ${item.detail}</title>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${COLOR_NODE.h}" rx="9" fill="#ffffff" stroke="${hex}" stroke-width="1.6"/>` +
        `<rect x="${x + 10}" y="${y + 15}" width="24" height="24" rx="6" fill="${hex}" stroke="#64666e" stroke-width="1"/>` +
        `<text x="${x + 42}" y="${y + 23}" font-size="11.5" font-weight="600" fill="#2b2f3a">${item.title}</text>` +
        `<text x="${x + 42}" y="${y + 39}" font-size="10" fill="#6b7280">${item.detail}</text>` +
        `<text x="${x + w - 8}" y="${y + 22}" font-size="9" text-anchor="end" fill="#9aa3b5">${item.owner ?? ""}</text>` +
        `</g>`
    );
}

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

function renderPlan(res: SolveResult): void {
    stepsEl.innerHTML = "";
    resultMeta.innerHTML = "";
    recipeStage.innerHTML = "";
    recipeHint.hidden = false;

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

    const fused = fuseCuts(res.flat);
    const chipCost = document.createElement("span");
    chipCost.className = "chip";
    chipCost.textContent = `建筑数 ${fusedCost(fused, res.cost)}`;
    const chipSteps = document.createElement("span");
    chipSteps.className = "chip";
    chipSteps.textContent = `步骤 ${fused.steps.filter((step) => !step.fuseInto).length}`;
    const chipOk = document.createElement("span");
    chipOk.className = "chip good";
    chipOk.textContent = res.verification.ok ? "校验通过" : "校验失败";
    resultMeta.append(chipCost, chipSteps, chipOk);

    const counts = new Map<P.PlanOp, number>();
    for (const step of fused.steps) {
        if (step.op === "base" || step.fuseInto) continue;
        counts.set(step.op, (counts.get(step.op) || 0) + 1);
    }
    for (const [op, n] of counts) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = `${P.OP_LABELS[op] || op} ×${n}`;
        resultMeta.appendChild(chip);
    }

    recipeStage.innerHTML = recipeSVG(fused);
    recipeHint.hidden = true;
    recipePz.fit();

    const bomChip = document.createElement("span");
    bomChip.className = "chip";
    bomChip.textContent = `材料 ${planBom(expandPlanTree(fused))
        .map((b) => `${b.zh}×${b.n}`)
        .join("、")}`;
    resultMeta.appendChild(bomChip);

    const copy = document.createElement("button");
    copy.textContent = "复制方案 JSON";
    copy.className = "ghost small";
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
    stepsEl.appendChild(copy);

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
    recipeStage.innerHTML = "";
    recipeHint.hidden = false;

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
for (const tab of document.querySelectorAll<HTMLButtonElement>("#view-tabs .tab")) {
    tab.addEventListener("click", () => setView((tab.dataset.view as ViewName) ?? "recipe"));
}
mustGet<HTMLButtonElement>("zoom-out").addEventListener("click", () => sheetPz.zoomBy(1 / 1.3));
mustGet<HTMLButtonElement>("zoom-in").addEventListener("click", () => sheetPz.zoomBy(1.3));
mustGet<HTMLButtonElement>("zoom-fit").addEventListener("click", () => sheetPz.fit());

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

function legendRow(color: string, label: string): string {
    return `<div class="row"><span class="sw" style="background:${color}"></span>${label}</div>`;
}

/** pinned to the sheet's top-left corner: only what this drawing actually uses */
function renderSheetLegend(res: CampaignResult): void {
    const kinds = new Set<BuildingKind>(res.layout.buildings.map((b) => b.kind));
    const parts: string[] = ["<h4>建筑</h4>"];
    for (const kind of KIND_ORDER) {
        if (!kinds.has(kind)) continue;
        parts.push(legendRow(KIND_COLOR[kind] ?? "#dfe3ea", KIND_LABELS[kind]));
    }
    const res0 = MAP_THEME.resources;
    parts.push(`<div class="sep"></div><h4>资源</h4>`);
    parts.push(legendRow(res0.shape, "形状矿脉"));
    parts.push(legendRow(res0.r ?? res0.shape, "红色矿脉"));
    parts.push(legendRow(res0.g ?? res0.shape, "绿色矿脉"));
    parts.push(legendRow(res0.b ?? res0.shape, "蓝色矿脉"));
    parts.push(`<div class="sep"></div><h4>设施</h4>`);
    parts.push(legendRow(HUB_COLOR, "中心"));
    parts.push(legendRow(INK.belt, "传送带"));
    parts.push(legendRow(TUNNEL_SENDER, "隧道入口"));
    parts.push(legendRow(TUNNEL_RECEIVER, "隧道出口"));
    sheetLegend.innerHTML = parts.join("");
    sheetLegend.hidden = false;
}

let campaignWorker: Worker | null = null;
let campaignJobId = 0;

/** one campaign per worker; the page thread never blocks on a solve */
function solveCampaignInWorker(job: CampaignJob): Promise<CampaignReply> {
    campaignWorker ??= new Worker("./worker.js", { type: "module" });
    const worker = campaignWorker;
    const id = ++campaignJobId;
    const { promise, resolve, reject } = Promise.withResolvers<CampaignReply>();
    const onMessage = (event: MessageEvent): void => {
        const data = event.data as { id: number; ok: boolean; value?: CampaignReply; error?: string };
        if (data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        if (data.ok && data.value) resolve(data.value);
        else reject(new Error(data.error || "求解失败"));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, job });
    return promise;
}

async function onAll(): Promise<void> {
    const btn = mustGet<HTMLButtonElement>("all-btn");
    btn.disabled = true;
    const status = mustGet<HTMLElement>("all-status");
    status.textContent = "";
    sheetStage.innerHTML = "";
    sheetLegend.hidden = true;
    sheetHint.hidden = false;
    sheetHint.textContent = "求解全部需求图形中…";
    await new Promise<void>((r) => setTimeout(r, 30));
    try {
        const ctx = mapContext();
        const set = mustGet<HTMLSelectElement>("all-set").value as NeedSetName;
        const untilPick = mustGet<HTMLSelectElement>("all-until");
        const untilLevel = untilPick.value ? Number(untilPick.value) : null;
        // the solve runs in a worker: a cold full sheet takes tens of seconds
        // and would freeze the page thread
        const { result: res, radius, missingTypes } = await solveCampaignInWorker({
            seed: ctx.seed,
            hub: ctx.hub,
            set,
            untilLevel,
        });
        const usedPatches: Patch[] = [];
        for (const s of res.layout.sources) if (s.patch) usedPatches.push(s.patch);
        for (const c of res.layout.colors) if (c.patch) usedPatches.push(c.patch);
        sheetStage.innerHTML = schematicSVG(res.layout, usedPatches, { campaign: true });
        sheetHint.hidden = true;
        renderSheetLegend(res);
        sheetPz.fit();
        status.textContent =
            `种子 ${ctx.seed} · 扫描半径 ${radius} chunk · ` +
            (res.totals.failed ? `${res.totals.failed} 种无法求解 · ` : "") +
            (res.totals.deferred ? `${res.totals.deferred} 种要更高关卡 · ` : "") +
            (res.totals.impossible ? `${res.totals.impossible} 种本版本没有对应机器 · ` : "") +
            `${res.totals.shapes} 种可建 · ${res.totals.buildings} 个建筑 · 传送带约 ${res.totals.belts} 格` +
            (missingTypes.length ? ` · ⚠ 缺 ${missingTypes.join("/")} 矿脉` : "");
    } catch (e) {
        sheetStage.innerHTML = "";
        sheetHint.hidden = false;
        sheetHint.textContent = e instanceof Error ? e.message : String(e);
    } finally {
        btn.disabled = false;
    }
}

mustGet<HTMLInputElement>("save-file").addEventListener("change", onLoadSave);
mustGet<HTMLButtonElement>("all-btn").addEventListener("click", onAll);

setView("recipe");
