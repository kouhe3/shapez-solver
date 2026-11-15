/**
 * General shapez machine planner.
 *
 * Given ANY target shape code it produces a building plan (extractor / cutter /
 * rotater / stacker / painter) whose final output hashes to the target.
 *
 * The planner is a cost-optimal recursive decomposition over the game's real
 * operations:
 *
 *  1. base          - an uncolored full shape straight from an extractor
 *  2. atom          - one layer assembled from cut pieces (quarters/halves)
 *  3. paint         - paint the whole shape in one color
 *  4. paint4        - per-quadrant paint (quad painter)
 *  5. rotate        - rotate before/after assembly
 *  6. stack split   - B + T where stack(B,T) === target (prefix split)
 *  7. general split - B + T interleaving in the same layers (k=0 merges)
 *  8. scaffold/cut  - build a bigger shape, then cut the scaffold half away
 *
 * Every candidate is validated by simulating the real stacker, so a returned
 * plan always reproduces the target exactly.
 */

import * as S from "./shape.js";
import * as P from "./plan.js";

export const ALL_BUILDINGS = [
    "cutter",
    "quadCutter",
    "rotaterCW",
    "rotaterCCW",
    "rotater180",
    "stacker",
    "painter",
    "quadPainter",
];

export const ROTATION_BUILDING = {
    CW: "rotaterCW",
    CCW: "rotaterCCW",
    180: "rotater180",
};

/** rotating `rotate(shape, dir)` with `OPPOSITE[dir]` gives `shape` back */
export const OPPOSITE_ROTATION = { CW: "CCW", CCW: "CW", 180: "180" };

function permuteMask(mask, dir) {
    let out = 0;
    for (let q = 0; q < 4; q++) {
        let src;
        if (dir === "CW") src = (q + 3) % 4;
        else if (dir === "CCW") src = (q + 1) % 4;
        else src = (q + 2) % 4;
        if (mask & (1 << src)) out |= 1 << q;
    }
    return out;
}

function maskToQuadrants(mask) {
    const out = [];
    for (let q = 0; q < 4; q++) if (mask & (1 << q)) out.push(q);
    return out;
}

function subsetMasks(layer) {
    // all non-empty subsets of the occupied quadrants
    const quads = [0, 1, 2, 3].filter((q) => layer[q]);
    const out = [];
    const total = 1 << quads.length;
    for (let bits = 1; bits < total; bits++) {
        const subset = [];
        for (let i = 0; i < quads.length; i++) if (bits & (1 << i)) subset.push(quads[i]);
        out.push(subset);
    }
    return out;
}

function setPartitions(items) {
    if (items.length === 0) return [[]];
    const [first, ...rest] = items;
    const result = [];
    for (const partition of setPartitions(rest)) {
        // put `first` into an existing block
        for (let i = 0; i < partition.length; i++) {
            const next = partition.map((b, bi) => (bi === i ? [first, ...b] : b));
            result.push(next);
        }
        // or open a new block
        result.push([[first], ...partition]);
    }
    return result;
}

export class Solver {
    constructor(opts = {}) {
        this.buildings = new Set(opts.buildings || ALL_BUILDINGS);
        this.memo = new Map();
        this.path = new Set();
        this.pieceTables = new Map();
        this.attempts = 0;
        this.maxAttempts = opts.maxAttempts ?? 30000;
        this.splitCap = opts.splitCap ?? 4000;
        this.verbose = !!opts.verbose;
        this.debug = !!opts.debug;
        this.cycleHits = 0;
        this.stats = { planShapes: 0, splitCandidates: 0, stackTests: 0, aborted: false };
    }

    has(building) {
        return this.buildings.has(building);
    }

    hasRotation(dir) {
        return this.has(ROTATION_BUILDING[dir]);
    }

    /* ---------------- cut pieces ---------------- */

    pieceTable(type) {
        if (this.pieceTables.has(type)) return this.pieceTables.get(type);
        const nodes = new Map();
        const costs = new Map();
        nodes.set(15, P.baseNode(type));
        costs.set(15, 0);
        const queue = [15];
        while (queue.length) {
            queue.sort((a, b) => costs.get(a) - costs.get(b));
            const mask = queue.shift();
            const node = nodes.get(mask);
            const cost = costs.get(mask);
            const relax = (nextMask, nextNode) => {
                if (!nextMask) return;
                const known = costs.get(nextMask);
                if (known === undefined || known > cost + 1) {
                    costs.set(nextMask, cost + 1);
                    nodes.set(nextMask, nextNode);
                    queue.push(nextMask);
                }
            };
            for (const dir of ["CW", "CCW", "180"]) {
                if (!this.hasRotation(dir)) continue;
                const next = permuteMask(mask, dir);
                if (next !== mask) relax(next, P.rotateNode(dir, node));
            }
            if (this.has("cutter")) {
                relax(mask & 0b1100, P.cutHalfNode(0, node));
                relax(mask & 0b0011, P.cutHalfNode(1, node));
            }
            if (this.has("quadCutter")) {
                for (let q = 0; q < 4; q++) {
                    if (mask & (1 << q)) relax(1 << q, P.cutQuadNode(q, node));
                }
            }
        }
        this.pieceTables.set(type, { nodes, costs });
        return { nodes, costs };
    }

    pieceNode(type, mask) {
        const { nodes } = this.pieceTable(type);
        return nodes.get(mask) || null;
    }

    /* ---------------- single layer atoms ---------------- */

    atomCandidates(shape) {
        if (shape.layers.length !== 1) return [];
        const layer = shape.layers[0];
        const occupied = [0, 1, 2, 3].filter((q) => layer[q]);
        if (!occupied.length) return [];
        const out = [];
        for (const blocks of setPartitions(occupied)) {
            let ok = true;
            const nodes = [];
            for (const block of blocks) {
                const first = layer[block[0]];
                if (!block.every((q) => layer[q].t === first.t && layer[q].c === first.c)) {
                    ok = false;
                    break;
                }
                let mask = 0;
                for (const q of block) mask |= 1 << q;
                let node = this.pieceNode(first.t, mask);
                if (!node) {
                    ok = false;
                    break;
                }
                if (first.c !== "u") {
                    if (!this.has("painter")) {
                        ok = false;
                        break;
                    }
                    node = P.paintNode(first.c, node);
                }
                nodes.push(node);
            }
            if (!ok || !nodes.length) continue;
            if (nodes.length === 1) {
                out.push(nodes[0]);
                continue;
            }
            if (!this.has("stacker")) continue;
            let acc = nodes[0];
            for (let i = 1; i < nodes.length; i++) acc = P.stackNode(acc, nodes[i]);
            out.push(acc);
        }
        return out;
    }

    /* ---------------- general (merging) splits ---------------- */

    /**
     * The "floating piece" family used by the real game solutions (level 20 logo,
     * level 26 rocket): the bottom piece keeps the cells of a quadrant subset over
     * a prefix of the layers, everything else goes into the upper piece.
     */
    windowSplits(shape) {
        const L = shape.layers.length;
        const out = [];
        for (let mask = 1; mask < 15; mask++) {
            // bottom must start at layer 0
            let startsAtZero = false;
            for (let q = 0; q < 4; q++) {
                if (mask & (1 << q) && shape.layers[0][q]) startsAtZero = true;
            }
            if (!startsAtZero) continue;
            let maxPrefix = 0;
            while (maxPrefix < L) {
                let any = false;
                for (let q = 0; q < 4; q++) {
                    if (mask & (1 << q) && shape.layers[maxPrefix][q]) any = true;
                }
                if (!any) break;
                maxPrefix++;
            }
            for (let b = 0; b < maxPrefix; b++) {
                const bLayers = [];
                const tLayers = [];
                for (let li = 0; li < L; li++) {
                    const src = shape.layers[li];
                    const bLayer = S.makeLayer();
                    const tLayer = S.makeLayer();
                    for (let q = 0; q < 4; q++) {
                        if (!src[q]) continue;
                        const toBottom = li <= b && mask & (1 << q);
                        if (toBottom) bLayer[q] = S.cloneCell(src[q]);
                        else tLayer[q] = S.cloneCell(src[q]);
                    }
                    if (li <= b) bLayers.push(bLayer);
                    tLayers.push(tLayer);
                }
                // trim empty layers from the top of both pieces
                while (bLayers.length && bLayers[bLayers.length - 1].every((c) => !c)) bLayers.pop();
                // T starts at its first non-empty layer
                let firstT = tLayers.findIndex((l) => l.some((c) => c));
                if (firstT < 0) continue;
                const tPart = tLayers.slice(firstT);
                while (tPart.length && tPart[tPart.length - 1].every((c) => !c)) tPart.pop();
                if (!bLayers.length || !tPart.length) continue;
                if (bLayers.some((l) => l.every((c) => !c))) continue;
                if (tPart.some((l) => l.every((c) => !c))) continue;
                if (bLayers.length > 4 || tPart.length > 4) continue;
                out.push({ lower: { layers: bLayers }, upper: { layers: tPart } });
            }
        }
        return out;
    }

    splitCandidates(shape) {
        const L = shape.layers.length;
        const out = [];
        if (L < 2) return out;
        let produced = 0;
        const limit = this.splitCap;
        for (let k = 0; k < L; k++) {
            for (let m = 1; m <= Math.min(4, L - k); m++) {
                if (k === 0 && m === L) continue;
                const options = [];
                let total = 1;
                for (let i = k; i < k + m; i++) {
                    const opts = subsetMasks(shape.layers[i]);
                    options.push(opts);
                    total *= Math.max(opts.length, 1);
                }
                if (total > limit * 4) continue;
                const choice = new Array(options.length).fill(0);
                const emit = () => {
                    produced++;
                    const bLayers = [];
                    const tLayers = [];
                    for (let li = 0; li < L; li++) {
                        const layer = shape.layers[li];
                        if (li < k || li >= k + m) {
                            bLayers.push(layer.map(S.cloneCell));
                            continue;
                        }
                        const tQuads = options[li - k][choice[li - k]];
                        const bLayer = S.makeLayer();
                        const tLayer = S.makeLayer();
                        for (let q = 0; q < 4; q++) {
                            if (!layer[q]) continue;
                            if (tQuads.indexOf(q) >= 0) tLayer[q] = S.cloneCell(layer[q]);
                            else bLayer[q] = S.cloneCell(layer[q]);
                        }
                        bLayers.push(bLayer);
                        tLayers.push(tLayer);
                    }
                    while (bLayers.length && bLayers[bLayers.length - 1].every((c) => !c)) bLayers.pop();
                    while (tLayers.length && tLayers[tLayers.length - 1].every((c) => !c)) tLayers.pop();
                    if (!bLayers.length || !tLayers.length) return;
                    if (bLayers.some((l) => l.every((c) => !c))) return;
                    if (tLayers.some((l) => l.every((c) => !c))) return;
                    if (bLayers.length > 4 || tLayers.length > 4) return;
                    out.push({ lower: { layers: bLayers }, upper: { layers: tLayers } });
                };
                const rec = (depth) => {
                    if (produced >= limit) return true;
                    if (depth === options.length) {
                        emit();
                        return produced >= limit;
                    }
                    for (let i = 0; i < options[depth].length; i++) {
                        choice[depth] = i;
                        if (rec(depth + 1)) return true;
                    }
                    return false;
                };
                if (rec(0)) return out;
            }
        }
        return out;
    }

    /* ---------------- scaffold for cut targets ---------------- */

    addScaffold(shape, quad, mode, colorMode) {
        const L = shape.layers.length;
        const layers = shape.layers.map((l) => l.map(S.cloneCell));
        let first = null;
        for (const c of shape.layers[0]) if (c) { first = c; break; }
        if (!first) return null;
        const fill = mode === "column" ? Array.from({ length: L }, (_, i) => i)
            : mode === "first" ? [0]
            : [L - 1];
        for (const li of fill) {
            if (layers[li][quad]) return null;
            let t = first.t;
            let c = "u";
            if (colorMode === "match") {
                const sameLayer = shape.layers[li].find((x) => x);
                if (sameLayer) {
                    t = sameLayer.t;
                    c = sameLayer.c;
                }
            } else if (colorMode === "firstColor") {
                c = first.c;
            }
            layers[li][quad] = { t, c };
        }
        if (layers.some((l) => l.every((c) => !c))) return null;
        const out = { layers };
        if (S.equals(out, shape)) return null;
        return out;
    }

    /* ---------------- main recursive planner ---------------- */

    planShape(shape) {
        const key = S.hash(shape);
        if (this.memo.has(key)) return this.memo.get(key);
        if (this.path.has(key)) {
            this.cycleHits++;
            return null;
        }
        if (this.attempts++ > this.maxAttempts) {
            this.stats.aborted = true;
            return null;
        }
        const cycleHitsBefore = this.cycleHits;
        this.stats.planShapes++;
        this.path.add(key);
        let best = null;
        const consider = (node) => {
            if (node && this.debug) {
                const out = P.evalNode(node);
                if (!S.equals(out, shape)) {
                    console.log(
                        `INVARIANT ${node.op}: plan gives ${S.hash(out)} but shape is ${key}`
                    );
                }
            }
            if (node && (!best || node.cost < best.cost)) best = node;
        };
        try {
            /* 1. base */
            if (shape.layers.length === 1) {
                const layer = shape.layers[0];
                const t = layer[0] && layer[0].t;
                if (
                    t &&
                    S.TYPE_CHARS.includes(t) &&
                    layer.every((c) => c && c.t === t && c.c === "u")
                ) {
                    consider(P.baseNode(t));
                }
                /* 2. atoms */
                for (const node of this.atomCandidates(shape)) consider(node);
            }

            /* 3. whole-shape paint */
            const uniform = S.uniformColor(shape);
            if (uniform && uniform !== "u") {
                if (this.has("painter")) {
                    const geo = S.stripColors(shape);
                    const sub = this.planShape(geo);
                    if (sub) consider(P.paintNode(uniform, sub));
                }
            } else if (!uniform) {
                const quadColors = S.quadUniformColors(shape);
                if (quadColors && quadColors.some((c) => c && c !== "u") && this.has("quadPainter")) {
                    const geo = S.stripColors(shape);
                    const sub = this.planShape(geo);
                    if (sub) {
                        consider(
                            P.paint4Node(
                                quadColors.map((c) => (c && c !== "u" ? c : null)),
                                sub
                            )
                        );
                    }
                }
            }

            /* 4. rotations */
            for (const dir of ["CW", "CCW", "180"]) {
                if (!this.hasRotation(dir)) continue;
                const rotated = S.rotate(shape, dir);
                if (S.hash(rotated) === key) continue;
                const sub = this.planShape(rotated);
                if (sub) consider(P.rotateNode(OPPOSITE_ROTATION[dir], sub));
            }

            /* 5. prefix stacks */
            if (this.has("stacker")) {
                const L = shape.layers.length;
                for (let k = 1; k < L; k++) {
                    const lower = { layers: shape.layers.slice(0, k).map((l) => l.map(S.cloneCell)) };
                    const upper = { layers: shape.layers.slice(k).map((l) => l.map(S.cloneCell)) };
                    let merged;
                    this.stats.stackTests++;
                    try {
                        merged = S.stack(lower, upper);
                    } catch (e) {
                        continue;
                    }
                    if (!S.equals(merged, shape)) continue;
                    const subLower = this.planShape(lower);
                    if (!subLower) continue;
                    const subUpper = this.planShape(upper);
                    if (!subUpper) continue;
                    consider(P.stackNode(subLower, subUpper));
                }
            }

            /* 6. build a scaffold shape, then cut it in half */
            if (this.has("cutter")) {
                const half = S.confinedHalf(shape);
                if (half !== -1) {
                    const discarded = half === 0 ? [0, 1] : [2, 3];
                    for (const quad of discarded) {
                        for (const mode of ["column", "first", "last"]) {
                            for (const colorMode of ["u", "match", "firstColor"]) {
                                const scaffolded = this.addScaffold(shape, quad, mode, colorMode);
                                if (!scaffolded) continue;
                                const sub = this.planShape(scaffolded);
                                if (sub) consider(P.cutHalfNode(half, sub));
                            }
                        }
                    }
                }
            }

            /* 7. general splits that merge into the same layers (expensive, last resort) */
            if (this.has("stacker") && shape.layers.length >= 2 && !best) {
                const families = [
                    () => this.windowSplits(shape),
                    () => this.splitCandidates(shape),
                ];
                for (const family of families) {
                    if (best || this.stats.aborted) break;
                    for (const candidate of family()) {
                        if (this.stats.aborted) break;
                        this.stats.splitCandidates++;
                        let merged;
                        this.stats.stackTests++;
                        try {
                            merged = S.stack(candidate.lower, candidate.upper);
                        } catch (e) {
                            continue;
                        }
                        if (!S.equals(merged, shape)) continue;
                        const subLower = this.planShape(candidate.lower);
                        if (!subLower) continue;
                        const subUpper = this.planShape(candidate.upper);
                        if (!subUpper) continue;
                        consider(P.stackNode(subLower, subUpper));
                        if (best) break;
                    }
                }
            }
        } finally {
            this.path.delete(key);
        }
        // A failure is only final when no cycle guard influenced this subtree.
        if (best) this.memo.set(key, best);
        else if (!this.stats.aborted && this.cycleHits === cycleHitsBefore) this.memo.set(key, null);
        return best;
    }
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

export function solve(codeOrShape, opts = {}) {
    const target = P.parseTarget(codeOrShape);
    if (S.isEntirelyEmpty(target)) throw new Error("target shape is empty");
    const solver = new Solver(opts);
    const root = solver.planShape(target);
    if (!root) {
        return {
            ok: false,
            target,
            error: solver.stats.aborted
                ? "求解超出预算（shape 过于复杂或当前建筑集不足）"
                : "没有找到可行方案：该 shape 很可能受 shapez 的堆叠规则限制而无法建造（层与层之间要有重叠象限来撑开高度），也可能需要更大的搜索预算",
            stats: solver.stats,
            solver,
        };
    }
    const verification = P.verifyPlan(root, target);
    return {
        ok: verification.ok,
        target,
        plan: root,
        flat: P.flatten(root),
        cost: root.cost,
        verification,
        stats: solver.stats,
        solver,
    };
}
