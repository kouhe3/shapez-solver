/**
 * Turns a solved plan into a buildable layout ("图纸"):
 *
 *  - picks a real resource patch for every extractor (shape + color),
 *  - places the processing buildings on a tile grid next to the hub,
 *  - computes the exact port positions from the game's building definitions,
 *  - emits connections (what feeds what) + belt-length estimates + BOM.
 *
 * Port coordinates are in tile units relative to the building's top-left tile;
 * y grows downwards (screen/tile space, same as the game).
 */

import * as S from "./shape.js";
import * as P from "./plan.js";
import { nearestPatch } from "./map.js";

export const BUILDING_INFO = {
    base: {
        w: 1,
        h: 1,
        zh: "采矿机",
        ins: [],
        outs: [{ x: 0.5, y: 0 }],
    },
    rotate: {
        w: 1,
        h: 1,
        zh: "旋转器",
        ins: [{ x: 0.5, y: 1 }],
        outs: [{ x: 0.5, y: 0 }],
    },
    cutHalf: {
        w: 2,
        h: 1,
        zh: "切割机",
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
        ],
    },
    cutQuad: {
        w: 4,
        h: 1,
        zh: "四向切割机",
        ins: [{ x: 0.5, y: 1 }],
        outs: [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
            { x: 2.5, y: 0 },
            { x: 3.5, y: 0 },
        ],
    },
    stack: {
        w: 2,
        h: 1,
        zh: "堆叠器",
        ins: [
            { x: 0.5, y: 1 },
            { x: 1.5, y: 1 },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
    paint: {
        w: 2,
        h: 1,
        zh: "上色器",
        ins: [
            { x: 0, y: 0.5 },
            { x: 1.5, y: 0, kind: "color" },
        ],
        outs: [{ x: 2, y: 0.5 }],
    },
    paint4: {
        w: 4,
        h: 1,
        zh: "四色上色器",
        ins: [
            { x: 0, y: 0.5 },
            { x: 0.5, y: 1, kind: "color" },
            { x: 1.5, y: 1, kind: "color" },
            { x: 2.5, y: 1, kind: "color" },
            { x: 3.5, y: 1, kind: "color" },
        ],
        outs: [{ x: 0.5, y: 0 }],
    },
};

/** how a plan node maps to a game building */
export function buildingKind(step) {
    return step.op; // base / rotate / cutHalf / cutQuad / stack / paint / paint4
}

/**
 * Ejector slot carrying this step's product. The cutter's two halves and the
 * quad cutter's four quadrants are bound to fixed slots by the game:
 * cutHalf slot 0 = {2,3}, slot 1 = {0,1}; cutQuad slot i = quadrant i.
 */
export function outputSlot(step) {
    if (!step || !step.node) return 0;
    if (step.node.op === "cutHalf") return step.node.side;
    if (step.node.op === "cutQuad") return step.node.quad;
    return 0;
}


/** approximate tiles occupied by a patch (the game draws them as overlapping circles) */
function patchCells(patch) {
    const r = Math.max(1.5, (patch.size || 2) * 0.9 + 0.5);
    const cells = [];
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
            if (dx * dx + dy * dy <= r * r) cells.push({ x: Math.round(patch.x) + dx, y: Math.round(patch.y) + dy });
        }
    }
    return cells;
}

const COLOR_NEEDS = { y: ["r", "g"], p: ["r", "b"], c: ["g", "b"], w: ["r", "g", "b"] };

/**
 * @param {object} args
 * @param {object} args.plan   plan AST root
 * @param {Array} args.patches map patches (from map.js)
 * @param {{x:number,y:number}} args.hub hub tile origin
 * @param {number} args.blockX factory block x
 */
export function buildLayout({ plan, patches, hub = { x: -2, y: -2 }, blockX = 3, blockY = -10, blockWidth = 26 }) {
    const flat = P.flatten(plan);
    // dependency depth
    const depth = new Map();
    const stepById = new Map(flat.steps.map((s) => [s.id, s]));
    for (const step of flat.steps) {
        let d = 0;
        for (const input of step.inputs) d = Math.max(d, (depth.get(input.id) || 0) + 1);
        depth.set(step.id, d);
    }

    const occupied = new Set();
    const key = (x, y) => x + "|" + y;

    function fit(info, x, y) {
        for (let dx = 0; dx < info.w; dx++) {
            for (let dy = 0; dy < info.h; dy++) if (occupied.has(key(x + dx, y + dy))) return false;
        }
        for (let dx = 0; dx < info.w; dx++) {
            for (let dy = 0; dy < info.h; dy++) occupied.add(key(x + dx, y + dy));
        }
        return true;
    }

    // pick a factory block origin that avoids resource patches
    const blockW = blockWidth;
    const blockH = 3 * 4; // up to 4 depth rows
    const candidates = [
        { x: hub.x + 6, y: hub.y - 6 },
        { x: hub.x + 6, y: hub.y + 4 },
        { x: hub.x - 14, y: hub.y - 6 },
        { x: hub.x - 14, y: hub.y + 4 },
        { x: hub.x + 2, y: hub.y - 14 },
        { x: hub.x + 2, y: hub.y + 8 },
    ];
    let block = candidates[0];
    let bestHits = Infinity;
    for (const c of candidates) {
        let hits = 0;
        for (const p of patches) {
            for (const cell of patchCells(p)) {
                if (cell.x >= c.x && cell.x < c.x + blockW && cell.y >= c.y && cell.y < c.y + blockH) hits++;
            }
        }
        if (hits < bestHits) {
            bestHits = hits;
            block = c;
        }
    }
    blockX = block.x;
    blockY = block.y;

    // reserve the hub
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) occupied.add(key(hub.x + dx, hub.y + dy));

    const buildings = [];
    const sources = [];
    const missing = new Set();

    // 1) place extractors on real patches
    for (const step of flat.steps) {
        if (step.op !== "base") continue;
        const type = step.node.type;
        const code = `${type}u${type}u${type}u${type}u`;
        const found = nearestPatch(
            patches,
            (item) => item.kind === "shape" && item.code === code,
            { x: hub.x + 2, y: hub.y + 2 }
        );
        if (!found) {
            missing.add(`shape:${code}`);
            sources.push({ step, missing: `地图上找不到 ${code} 矿脉`, patch: null });
            continue;
        }
        const px = Math.round(found.patch.x);
        const py = Math.round(found.patch.y);
        sources.push({ step, patch: found.patch, distance: found.distance, x: px, y: py });
        buildings.push({
            stepId: step.id,
            kind: "base",
            zh: "采矿机",
            x: px,
            y: py,
            w: 1,
            h: 1,
            patch: found.patch,
            distance: found.distance,
        });
    }

    // keep processors off the resource patches
    for (const p of patches) {
        for (const cell of patchCells(p)) occupied.add(key(cell.x, cell.y));
    }

    // 2) pack processors into rows, grouped by depth
    const byDepth = new Map();
    for (const step of flat.steps) {
        if (step.op === "base") continue;
        const d = depth.get(step.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d).push(step);
    }
    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 3;
        for (const step of steps) {
            const info = BUILDING_INFO[step.op];
            if (!info) continue;
            if (cx + info.w > blockX + blockWidth) {
                cx = blockX;
                cy += 3;
            }
            let placed = false;
            for (let attempt = 0; attempt < 200 && !placed; attempt++) {
                if (fit(info, cx, cy)) {
                    placed = true;
                } else {
                    cx += info.w + 1;
                    if (cx + info.w > blockX + blockWidth) {
                        cx = blockX;
                        cy += 3;
                    }
                }
            }
            if (!placed) continue;
            buildings.push({
                stepId: step.id,
                kind: step.op,
                zh: info.zh,
                x: cx,
                y: cy,
                w: info.w,
                h: info.h,
                detail: step.op === "paint4" ? step.node.colors.map((c) => c || "-").join("/") : step.detail,
                colors:
                    step.op === "paint4"
                        ? step.node.colors.map((c) => (c && c !== "u" ? c : null))
                        : step.op === "paint"
                        ? [step.node.color]
                        : undefined,
            });
            cx += info.w + 1;
        }
    }

    const buildingByStep = new Map(buildings.map((b) => [b.stepId, b]));

    // 3) connections + belt lengths
    const connections = [];
    let beltEstimate = 0;
    for (const step of flat.steps) {
        const target = buildingByStep.get(step.id);
        if (!target) continue;
        const tInfo = BUILDING_INFO[step.op];
        if (!tInfo) continue;
        step.inputs.forEach((input, i) => {
            const src = buildingByStep.get(input.id);
            if (!src) return;
            const sInfo = BUILDING_INFO[src.kind];
            const outSlot = outputSlot(stepById.get(input.id));
            const outPort = sInfo.outs[outSlot] || sInfo.outs[0];
            const inPort = tInfo.ins[i];
            if (!inPort) return;
            const x1 = src.x + outPort.x;
            const y1 = src.y + outPort.y;
            const x2 = target.x + inPort.x;
            const y2 = target.y + inPort.y;
            const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
            beltEstimate += Math.max(1, len);
            connections.push({
                from: src.stepId,
                to: target.stepId,
                slot: i,
                fromLabel: sInfo.zh,
                toLabel: tInfo.zh,
                outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: len,
            });
        });
    }

    // 4) colors: which ones are on the map, which need mixing
    const colorPatches = new Map();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const prev = colorPatches.get(p.item.color);
        if (!prev || Math.hypot(p.x - hub.x, p.y - hub.y) < Math.hypot(prev.x - hub.x, prev.y - hub.y)) {
            colorPatches.set(p.item.color, p);
        }
    }
    const paintColors = new Set();
    for (const step of flat.steps) {
        if (step.op === "paint") paintColors.add(step.node.color);
    }
    const colors = [...paintColors].map((c) => {
        const direct = colorPatches.get(c);
        if (direct) return { color: c, direct: true, patch: direct, mix: null };
        const mix = COLOR_NEEDS[c];
        return { color: c, direct: false, patch: null, mix };
    });

    const bom = new Map();
    for (const b of buildings) bom.set(b.zh, (bom.get(b.zh) || 0) + 1);

    return {
        hub,
        buildings,
        connections,
        sources,
        colors,
        missing: [...missing],
        beltEstimate,
        bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
        steps: flat.steps,
        depth,
    };
}
