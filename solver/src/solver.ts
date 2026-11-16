/**
 * General shapez machine planner.
 *
 * Given ANY target shape code it produces a building plan (extractor / cutter /
 * rotater / stacker / painter) whose final output hashes to the target.
 *
 * The planner is a cost-minimising recursive decomposition over the game's
 * real operations. `cost` is the search scalar, not the optimal-plan criterion;
 * the optimal plan is the delivery-rate × occupied-tile Pareto frontier
 * (`docs/adr/0001-optimal-plan-pareto.md`):
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
import type { ColorChar, Rotation, Shape, ShapeType } from "./shape.js";
import type { FlatPlan, PlanNode, Verification } from "./plan.js";

export const ALL_BUILDINGS = [
    "cutter",
    "quadCutter",
    "rotaterCW",
    "rotaterCCW",
    "rotater180",
    "stacker",
    "painter",
    "quadPainter",
] as const;

export type BuildingId = (typeof ALL_BUILDINGS)[number];

/** the rotations a rotater can produce — `Rotation` without the identity */
export type TurnDirection = Exclude<Rotation, "0">;

export const ROTATION_BUILDING: Record<TurnDirection, BuildingId> = {
    CW: "rotaterCW",
    CCW: "rotaterCCW",
    180: "rotater180",
};

/** rotating `rotate(shape, dir)` with `OPPOSITE[dir]` gives `shape` back */
export const OPPOSITE_ROTATION: Record<TurnDirection, Rotation> = { CW: "CCW", CCW: "CW", 180: "180" };

function permuteMask(mask: number, dir: TurnDirection): number {
    let out = 0;
    for (let q = 0; q < 4; q++) {
        let src: number;
        if (dir === "CW") src = (q + 3) % 4;
        else if (dir === "CCW") src = (q + 1) % 4;
        else src = (q + 2) % 4;
        if (mask & (1 << src)) out |= 1 << q;
    }
    return out;
}

function maskToQuadrants(mask: number): number[] {
    const out: number[] = [];
    for (let q = 0; q < 4; q++) if (mask & (1 << q)) out.push(q);
    return out;
}

function subsetMasks(layer: S.Layer): number[][] {
    // all non-empty subsets of the occupied quadrants
    const quads = [0, 1, 2, 3].filter((q) => layer[q]);
    const out: number[][] = [];
    const total = 1 << quads.length;
    for (let bits = 1; bits < total; bits++) {
        const subset: number[] = [];
        for (let i = 0; i < quads.length; i++) if (bits & (1 << i)) subset.push(quads[i]!);
        out.push(subset);
    }
    return out;
}

function setPartitions(items: readonly number[]): number[][][] {
    const first = items[0];
    if (first === undefined) return [[]];
    const rest = items.slice(1);
    const result: number[][][] = [];
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

/** one cut piece of a deposit: the quadrant mask it covers and the plan that yields it */
export interface PatchPiece {
    mask: number;
    node: PlanNode;
    cost: number;
}

/** all quadrant masks reachable for one shape type, with their cheapest plan */
export interface PieceTable {
    nodes: Map<number, PlanNode>;
    costs: Map<number, number>;
}

/** the two halves a stacker joins */
export interface ShapePair {
    lower: Shape;
    upper: Shape;
}

export interface SolverOptions {
    /** building ids the plan may use — defaults to `ALL_BUILDINGS` */
    buildings?: Iterable<string> | null;
    /** deposit shape codes from the scanned map, e.g. "RuRuWuWu" */
    baseCodes?: Iterable<string> | null;
    maxAttempts?: number;
    splitCap?: number;
    verbose?: boolean;
    debug?: boolean;
}

export interface SolverStats {
    planShapes: number;
    splitCandidates: number;
    stackTests: number;
    aborted: boolean;
}

/** no plan was found; `error` says why */
export interface SolveFailure {
    ok: false;
    target: Shape;
    error: string;
    stats: SolverStats;
    solver: Solver;
    /**
     * never present on a failure — declared so callers can read them from the
     * union without narrowing first (the CLI's JSON output does)
     */
    plan?: undefined;
    flat?: undefined;
    cost?: undefined;
    verification?: undefined;
}

export interface SolveSuccess {
    /**
     * mirrors `verification.ok`, hence `boolean` and not `true`: a plan that
     * fails its own verification is still returned so callers can report it
     */
    ok: boolean;
    target: Shape;
    plan: PlanNode;
    flat: FlatPlan;
    cost: number;
    verification: Verification;
    stats: SolverStats;
    solver: Solver;
    /** never present on a success — symmetric with `SolveFailure` */
    error?: undefined;
}

export type SolveResult = SolveSuccess | SolveFailure;

export class Solver {
    buildings: Set<string>;
    memo: Map<string, PlanNode | null>;
    path: Set<string>;
    pieceTables: Map<ShapeType, PieceTable>;
    baseCodes: string[];
    patchPieces: Map<ShapeType, Map<number, PatchPiece>>;
    attempts: number;
    maxAttempts: number;
    splitCap: number;
    verbose: boolean;
    debug: boolean;
    cycleHits: number;
    stats: SolverStats;

    constructor(opts: SolverOptions = {}) {
        this.buildings = new Set(opts.buildings || ALL_BUILDINGS);
        this.memo = new Map();
        this.path = new Set();
        this.pieceTables = new Map();
        this.baseCodes = [...new Set(opts.baseCodes || [])];
        this.patchPieces = this.buildPatchPieces(this.baseCodes);
        this.attempts = 0;
        this.maxAttempts = opts.maxAttempts ?? 30000;
        this.splitCap = opts.splitCap ?? 4000;
        this.verbose = !!opts.verbose;
        this.debug = !!opts.debug;
        this.cycleHits = 0;
        this.stats = { planShapes: 0, splitCandidates: 0, stackTests: 0, aborted: false };
    }

    has(building: string): boolean {
        return this.buildings.has(building);
    }

    hasRotation(dir: TurnDirection): boolean {
        return this.has(ROTATION_BUILDING[dir]);
    }

    /** is a pure 4-quadrant deposit of this type actually on the map? */
    hasBase(type: ShapeType): boolean {
        if (!this.baseCodes.length) return true;
        return this.baseCodes.includes(`${type}u${type}u${type}u${type}u`);
    }

    /* ---------------- cut pieces ---------------- */

    /**
     * Atoms the map itself supplies. Every deposit is a 4-quadrant shape —
     * including mixed ones such as "RuRuRuWu" — so a miner plus the right cut is
     * a legal starting point for any quadrant that appears in a deposit. Without
     * this the planner can only start from a uniform "XXXX" deposit, which makes
     * shapes needing a windmill or star quadrant unplannable.
     *
     * @param codes deposit shape codes from the scanned map
     */
    buildPatchPieces(codes: string[]): Map<ShapeType, Map<number, PatchPiece>> {
        const byType = new Map<ShapeType, Map<number, PatchPiece>>();
        const add = (type: ShapeType, mask: number, node: PlanNode, cost: number): void => {
            let table = byType.get(type);
            if (!table) {
                table = new Map();
                byType.set(type, table);
            }
            const known = table.get(mask);
            if (!known || known.cost > cost) table.set(mask, { mask, node, cost });
        };
        for (const code of codes) {
            let shape: Shape;
            try {
                shape = S.parse(code);
            } catch {
                continue;
            }
            if (shape.layers.length !== 1) continue;
            const layer = shape.layers[0];
            if (!layer) continue;
            if (!layer.every((c): c is S.Cell => c !== null && c.c === "u" && S.isTypeChar(c.t))) {
                continue;
            }
            const types: ShapeType[] = layer.map((c) => c.t);
            const firstType = types[0];
            if (firstType === undefined) continue;
            const base = P.baseNode(firstType, code);
            if (types.every((t) => t === firstType)) add(firstType, 15, base, 0);
            if (this.has("cutter")) {
                for (const [side, mask] of [
                    [0, 0b1100],
                    [1, 0b0011],
                ] as const) {
                    const qs = [0, 1, 2, 3].filter((q) => mask & (1 << q));
                    const firstQuad = qs[0];
                    if (firstQuad === undefined) continue;
                    const halfType = types[firstQuad];
                    if (halfType === undefined) continue;
                    if (qs.every((q) => types[q] === halfType)) {
                        add(halfType, mask, P.cutHalfNode(side, base), 1);
                    }
                }
            }
            if (this.has("quadCutter")) {
                for (let q = 0; q < 4; q++) {
                    const quadType = types[q];
                    if (quadType === undefined) continue;
                    add(quadType, 1 << q, P.cutQuadNode(q, base), 1);
                }
            }
        }
        return byType;
    }

    pieceTable(type: ShapeType): PieceTable {
        const cached = this.pieceTables.get(type);
        if (cached) return cached;
        const nodes = new Map<number, PlanNode>();
        const costs = new Map<number, number>();
        const seed = (mask: number, node: PlanNode, cost: number): void => {
            const known = costs.get(mask);
            if (known === undefined || known > cost) {
                costs.set(mask, cost);
                nodes.set(mask, node);
            }
        };
        if (this.hasBase(type)) seed(15, P.baseNode(type), 0);
        for (const piece of this.patchPieces.get(type)?.values() ?? []) {
            seed(piece.mask, piece.node, piece.cost);
        }
        const queue = [...nodes.keys()];
        while (queue.length) {
            // every mask in the queue was seeded with a node and a cost above
            queue.sort((a, b) => costs.get(a)! - costs.get(b)!);
            const mask = queue.shift()!;
            const node = nodes.get(mask)!;
            const cost = costs.get(mask)!;
            const relax = (nextMask: number, nextNode: PlanNode): void => {
                if (!nextMask) return;
                const known = costs.get(nextMask);
                if (known === undefined || known > cost + 1) {
                    costs.set(nextMask, cost + 1);
                    nodes.set(nextMask, nextNode);
                    queue.push(nextMask);
                }
            };
            for (const dir of ["CW", "CCW", "180"] as const) {
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

    pieceNode(type: ShapeType, mask: number): PlanNode | null {
        const { nodes } = this.pieceTable(type);
        return nodes.get(mask) || null;
    }

    /* ---------------- single layer atoms ---------------- */

    atomCandidates(shape: Shape): PlanNode[] {
        if (shape.layers.length !== 1) return [];
        const layer = shape.layers[0];
        if (!layer) return [];
        const occupied = [0, 1, 2, 3].filter((q) => layer[q]);
        if (!occupied.length) return [];
        const out: PlanNode[] = [];
        for (const blocks of setPartitions(occupied)) {
            let ok = true;
            const nodes: PlanNode[] = [];
            for (const block of blocks) {
                const firstQuad = block[0];
                const first = firstQuad === undefined ? null : layer[firstQuad];
                if (!first) {
                    ok = false;
                    break;
                }
                const uniform = block.every((q) => {
                    const c = layer[q];
                    return c !== null && c !== undefined && c.t === first.t && c.c === first.c;
                });
                if (!uniform) {
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
            const firstNode = nodes[0];
            if (!firstNode) continue;
            if (nodes.length === 1) {
                out.push(firstNode);
                continue;
            }
            if (!this.has("stacker")) continue;
            let acc = firstNode;
            for (let i = 1; i < nodes.length; i++) acc = P.stackNode(acc, nodes[i]!);
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
    windowSplits(shape: Shape): ShapePair[] {
        const L = shape.layers.length;
        const out: ShapePair[] = [];
        for (let mask = 1; mask < 15; mask++) {
            // bottom must start at layer 0
            const topLayer = shape.layers[0];
            if (!topLayer) continue;
            let startsAtZero = false;
            for (let q = 0; q < 4; q++) {
                if (mask & (1 << q) && topLayer[q]) startsAtZero = true;
            }
            if (!startsAtZero) continue;
            let maxPrefix = 0;
            while (maxPrefix < L) {
                const layer = shape.layers[maxPrefix];
                if (!layer) break;
                let any = false;
                for (let q = 0; q < 4; q++) {
                    if (mask & (1 << q) && layer[q]) any = true;
                }
                if (!any) break;
                maxPrefix++;
            }
            for (let b = 0; b < maxPrefix; b++) {
                const bLayers: S.Layer[] = [];
                const tLayers: S.Layer[] = [];
                for (let li = 0; li < L; li++) {
                    const src = shape.layers[li];
                    if (!src) continue;
                    const bLayer = S.makeLayer();
                    const tLayer = S.makeLayer();
                    for (let q = 0; q < 4; q++) {
                        const cell = src[q];
                        if (!cell) continue;
                        const toBottom = li <= b && mask & (1 << q);
                        if (toBottom) bLayer[q] = S.cloneCell(cell);
                        else tLayer[q] = S.cloneCell(cell);
                    }
                    if (li <= b) bLayers.push(bLayer);
                    tLayers.push(tLayer);
                }
                // trim empty layers from the top of both pieces
                while (bLayers.length && bLayers.at(-1)?.every((c) => !c)) bLayers.pop();
                // T starts at its first non-empty layer
                let firstT = tLayers.findIndex((l) => l.some((c) => c));
                if (firstT < 0) continue;
                const tPart = tLayers.slice(firstT);
                while (tPart.length && tPart.at(-1)?.every((c) => !c)) tPart.pop();
                if (!bLayers.length || !tPart.length) continue;
                if (bLayers.some((l) => l.every((c) => !c))) continue;
                if (tPart.some((l) => l.every((c) => !c))) continue;
                if (bLayers.length > 4 || tPart.length > 4) continue;
                out.push({ lower: { layers: bLayers }, upper: { layers: tPart } });
            }
        }
        return out;
    }

    splitCandidates(shape: Shape): ShapePair[] {
        const L = shape.layers.length;
        const out: ShapePair[] = [];
        if (L < 2) return out;
        let produced = 0;
        const limit = this.splitCap;
        for (let k = 0; k < L; k++) {
            for (let m = 1; m <= Math.min(4, L - k); m++) {
                if (k === 0 && m === L) continue;
                const options: number[][][] = [];
                let total = 1;
                for (let i = k; i < k + m; i++) {
                    const layer = shape.layers[i];
                    if (!layer) continue;
                    const opts = subsetMasks(layer);
                    options.push(opts);
                    total *= Math.max(opts.length, 1);
                }
                if (total > limit * 4) continue;
                const choice: number[] = new Array(options.length).fill(0);
                const emit = (): void => {
                    produced++;
                    const bLayers: S.Layer[] = [];
                    const tLayers: S.Layer[] = [];
                    for (let li = 0; li < L; li++) {
                        const layer = shape.layers[li];
                        if (!layer) continue;
                        if (li < k || li >= k + m) {
                            bLayers.push(layer.map(S.cloneCell));
                            continue;
                        }
                        // in-window layers: options[li - k] holds this layer's subsets
                        const tQuads = options[li - k]![choice[li - k]!]!;
                        const bLayer = S.makeLayer();
                        const tLayer = S.makeLayer();
                        for (let q = 0; q < 4; q++) {
                            const cell = layer[q];
                            if (!cell) continue;
                            if (tQuads.indexOf(q) >= 0) tLayer[q] = S.cloneCell(cell);
                            else bLayer[q] = S.cloneCell(cell);
                        }
                        bLayers.push(bLayer);
                        tLayers.push(tLayer);
                    }
                    while (bLayers.length && bLayers.at(-1)?.every((c) => !c)) bLayers.pop();
                    while (tLayers.length && tLayers.at(-1)?.every((c) => !c)) tLayers.pop();
                    if (!bLayers.length || !tLayers.length) return;
                    if (bLayers.some((l) => l.every((c) => !c))) return;
                    if (tLayers.some((l) => l.every((c) => !c))) return;
                    if (bLayers.length > 4 || tLayers.length > 4) return;
                    out.push({ lower: { layers: bLayers }, upper: { layers: tLayers } });
                };
                const rec = (depth: number): boolean => {
                    if (produced >= limit) return true;
                    if (depth === options.length) {
                        emit();
                        return produced >= limit;
                    }
                    const subsets = options[depth];
                    if (!subsets) return false;
                    for (let i = 0; i < subsets.length; i++) {
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

    addScaffold(
        shape: Shape,
        quad: number,
        mode: "column" | "first" | "last",
        colorMode: "u" | "match" | "firstColor"
    ): Shape | null {
        const L = shape.layers.length;
        const layers: S.Layer[] = shape.layers.map((l) => l.map(S.cloneCell));
        const topLayer = shape.layers[0];
        if (!topLayer) return null;
        let first: S.Cell | null = null;
        for (const c of topLayer) if (c) { first = c; break; }
        if (!first) return null;
        const fill = mode === "column" ? Array.from({ length: L }, (_, i) => i)
            : mode === "first" ? [0]
            : [L - 1];
        for (const li of fill) {
            const layer = layers[li];
            if (!layer) continue;
            if (layer[quad]) return null;
            let t: ShapeType = first.t;
            let c: ColorChar = "u";
            if (colorMode === "match") {
                const sameLayer = shape.layers[li]?.find((x) => x);
                if (sameLayer) {
                    t = sameLayer.t;
                    c = sameLayer.c;
                }
            } else if (colorMode === "firstColor") {
                c = first.c;
            }
            layer[quad] = { t, c };
        }
        if (layers.some((l) => l.every((c) => !c))) return null;
        const out: Shape = { layers };
        if (S.equals(out, shape)) return null;
        return out;
    }

    /* ---------------- main recursive planner ---------------- */

    planShape(shape: Shape): PlanNode | null {
        const key = S.hash(shape);
        if (this.memo.has(key)) return this.memo.get(key) ?? null;
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
        let best: PlanNode | null = null;
        const consider = (node: PlanNode | null): void => {
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
                const t = layer?.[0]?.t;
                if (
                    t &&
                    S.isTypeChar(t) &&
                    layer &&
                    layer.every((c) => c !== null && c.t === t && c.c === "u") &&
                    this.hasBase(t)
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
            for (const dir of ["CW", "CCW", "180"] as const) {
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
                    const lower: Shape = { layers: shape.layers.slice(0, k).map((l) => l.map(S.cloneCell)) };
                    const upper: Shape = { layers: shape.layers.slice(k).map((l) => l.map(S.cloneCell)) };
                    let merged: Shape;
                    this.stats.stackTests++;
                    try {
                        merged = S.stack(lower, upper);
                    } catch {
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
                if (half === 0 || half === 1) {
                    const discarded = half === 0 ? [0, 1] : [2, 3];
                    for (const quad of discarded) {
                        for (const mode of ["column", "first", "last"] as const) {
                            for (const colorMode of ["u", "match", "firstColor"] as const) {
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
                const families: (() => ShapePair[])[] = [
                    () => this.windowSplits(shape),
                    () => this.splitCandidates(shape),
                ];
                for (const family of families) {
                    if (best || this.stats.aborted) break;
                    for (const candidate of family()) {
                        if (this.stats.aborted) break;
                        this.stats.splitCandidates++;
                        let merged: Shape;
                        this.stats.stackTests++;
                        try {
                            merged = S.stack(candidate.lower, candidate.upper);
                        } catch {
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

export function solve(codeOrShape: string | Shape, opts: SolverOptions = {}): SolveResult {
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
