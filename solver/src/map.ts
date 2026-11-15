/**
 * Exact port of shapez.io's map chunk generator (src/js/game/map_chunk.js).
 *
 * The savegame only stores `map.seed`; every resource patch is derived from
 *   RNG(`${chunkX}|${chunkY}|${seed}`)
 * so the whole infinite map can be reproduced offline.
 *
 * lowerLayer[x][y] holds either
 *   { kind: "shape", code: "CuCuCuCu" }   (a full uncolored shape)
 *   { kind: "color", color: "r" }         (color fluid)
 */

import type { ColorChar, ShapeType } from "./shape.js";

export const MAP_CHUNK_SIZE = 16;

/* ------------------------------------------------------------------ *
 * deposits / patches
 * ------------------------------------------------------------------ */

/** a vein of one full uncolored shape, e.g. `CuCuCuCu` */
export interface ShapeDeposit {
    kind: "shape";
    code: string;
}

/** a color fluid vein */
export interface ColorDeposit {
    kind: "color";
    color: ColorChar;
}

export type MapItem = ShapeDeposit | ColorDeposit;

/**
 * One generated resource patch. `x`/`y` are map tiles (the mean of the drawn
 * tiles); the chunk-local centre, chunk coords, radius and drawn tiles are kept
 * for the schematic. Only `x`, `y` and `item` are required — the layout and the
 * tests also build patches by hand.
 */
export interface Patch {
    x: number;
    y: number;
    item: MapItem;
    localX?: number;
    localY?: number;
    chunkX?: number;
    chunkY?: number;
    size?: number;
    tiles?: number;
    cells?: Array<[number, number]>;
}

/** one generated chunk: the ore grid plus the patches drawn into it */
export interface Chunk {
    chunkX: number;
    chunkY: number;
    lower: (MapItem | null)[][];
    patches: Patch[];
}

/* ------------------------------------------------------------------ *
 * ALEA RNG (port of src/js/core/rng.js)
 * ------------------------------------------------------------------ */

function Mash(): (data: string | number) => number {
    let n = 0xefc8249d;
    return function (data: string | number): number {
        const text = data.toString();
        for (let i = 0; i < text.length; i++) {
            n += text.charCodeAt(i);
            let h = 0.02519603282416938 * n;
            n = h >>> 0;
            h -= n;
            h *= n;
            n = h >>> 0;
            h -= n;
            n += h * 0x100000000;
        }
        return (n >>> 0) * 2.3283064365386963e-10;
    };
}

function makeNewRng(seed: string | number): () => number {
    let c = 1;
    let mash = Mash();
    let s0 = mash(" ");
    let s1 = mash(" ");
    let s2 = mash(" ");
    s0 -= mash(seed);
    if (s0 < 0) s0 += 1;
    s1 -= mash(seed);
    if (s1 < 0) s1 += 1;
    s2 -= mash(seed);
    if (s2 < 0) s2 += 1;
    return function () {
        const t = 2091639 * s0 + c * 2.3283064365386963e-10;
        s0 = s1;
        s1 = s2;
        return (s2 = t - (c = t | 0));
    };
}

class RandomNumberGenerator {
    private readonly internalRng: () => number;

    constructor(seed: string | number) {
        this.internalRng = makeNewRng(seed);
    }

    next(): number {
        return this.internalRng();
    }

    choice<T>(array: readonly T[]): T {
        const index = this.nextIntRange(0, array.length);
        const value = array[index];
        if (value === undefined) throw new Error("RNG choice from an empty array");
        return value;
    }

    nextIntRange(min: number, max: number): number {
        return Math.floor(this.next() * (max - min) + min);
    }

    nextRange(min: number, max: number): number {
        return this.next() * (max - min) + min;
    }
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

/* ------------------------------------------------------------------ *
 * the generator
 * ------------------------------------------------------------------ */

const SHAPE_WEIGHT_ORDER = ["R", "C", "S", "W", "C", "R", "W", "S"];
// the game iterates the weights object; JS keeps string key insertion order,
// and the game inserts them in this exact order:
const WEIGHT_KEYS: readonly ShapeType[] = ["R", "C", "S", "W"];

function shapeCodeFromQuads(quads: readonly ShapeType[]): string {
    // getDefinitionFromSimpleShapes(subShapes) → one layer, uncolored
    return quads.map((t) => t + "u").join("");
}

export function generateChunk(seed: number, chunkX: number, chunkY: number): Chunk {
    const rng = new RandomNumberGenerator(`${chunkX}|${chunkY}|${seed}`);

    // lowerLayer[x][y] — the game allocates [mapChunkSize][mapChunkSize] but the
    // generator can write y === mapChunkSize (off-by-one in the original), so we
    // keep an extra row/column to stay faithful.
    const lower: (MapItem | null)[][] = Array.from({ length: MAP_CHUNK_SIZE + 1 }, () =>
        new Array<MapItem | null>(MAP_CHUNK_SIZE + 1).fill(null)
    );
    const patches: Patch[] = [];

    function internalGeneratePatch(
        patchSize: number,
        item: MapItem,
        overrideX: number | null = null,
        overrideY: number | null = null
    ): void {
        const border = Math.ceil(patchSize / 2 + 3);
        let patchX = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        let patchY = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        if (overrideX !== null) patchX = overrideX;
        if (overrideY !== null) patchY = overrideY;

        let sumX = 0;
        let sumY = 0;
        let patchesDrawn = 0;
        const cells: Array<[number, number]> = [];
        const numCircles = patchSize;

        for (let i = 0; i <= numCircles; ++i) {
            const circleRadius = Math.min(1 + i, patchSize);
            const circleRadiusSquare = circleRadius * circleRadius;
            const circleOffsetRadius = (numCircles - i) / 2 + 2;

            const circleScaleX = rng.nextRange(0.9, 1.1);
            const circleScaleY = rng.nextRange(0.9, 1.1);

            const circleX = patchX + rng.nextIntRange(-circleOffsetRadius, circleOffsetRadius);
            const circleY = patchY + rng.nextIntRange(-circleOffsetRadius, circleOffsetRadius);

            for (let dx = -circleRadius * circleScaleX - 2; dx <= circleRadius * circleScaleX + 2; ++dx) {
                for (let dy = -circleRadius * circleScaleY - 2; dy <= circleRadius * circleScaleY + 2; ++dy) {
                    const x = Math.round(circleX + dx);
                    const y = Math.round(circleY + dy);
                    if (x >= 0 && x < MAP_CHUNK_SIZE && y >= 0 && y <= MAP_CHUNK_SIZE) {
                        const originalDx = dx / circleScaleX;
                        const originalDy = dy / circleScaleY;
                        if (originalDx * originalDx + originalDy * originalDy <= circleRadiusSquare) {
                            // the guard above keeps x inside the [MAP_CHUNK_SIZE + 1]² grid
                            const row = lower[x]!;
                            if (!row[y]) {
                                row[y] = item;
                                cells.push([x + chunkX * MAP_CHUNK_SIZE, y + chunkY * MAP_CHUNK_SIZE]);
                                ++patchesDrawn;
                                sumX += x;
                                sumY += y;
                            }
                        }
                    }
                }
            }
        }

        patches.push({
            x: chunkX * MAP_CHUNK_SIZE + (patchesDrawn ? sumX / patchesDrawn : patchX),
            y: chunkY * MAP_CHUNK_SIZE + (patchesDrawn ? sumY / patchesDrawn : patchY),
            localX: patchesDrawn ? sumX / patchesDrawn : patchX,
            localY: patchesDrawn ? sumY / patchesDrawn : patchY,
            chunkX,
            chunkY,
            item,
            size: patchSize,
            tiles: patchesDrawn,
            cells,
        });
    }

    function internalGenerateRandomSubShape(weights: Record<ShapeType, number>): ShapeType {
        const keys = WEIGHT_KEYS.filter((k) => weights[k] !== undefined);
        const sum = keys.reduce((a, k) => a + weights[k], 0);
        const chosenNumber = rng.nextIntRange(0, sum - 1);
        let accumulated = 0;
        for (const key of keys) {
            if (accumulated + weights[key] > chosenNumber) return key;
            accumulated += weights[key];
        }
        return "C";
    }

    function internalGenerateColorPatch(colorPatchSize: number, distance: number): void {
        const availableColors: ColorChar[] = ["r", "g"];
        if (distance > 2) availableColors.push("b");
        internalGeneratePatch(colorPatchSize, { kind: "color", color: rng.choice(availableColors) });
    }

    function internalGenerateShapePatch(shapePatchSize: number, distance: number): void {
        const weights: Record<ShapeType, number> = {
            R: 100,
            C: Math.round(50 + clamp(distance * 2, 0, 50)),
            S: Math.round(20 + clamp(distance, 0, 30)),
            W: Math.round(6 + clamp(distance / 2, 0, 20)),
        };
        if (distance < 7) {
            weights.S = 0;
            weights.W = 0;
        }
        let subShapes: ShapeType[];
        if (distance < 10) {
            const a = internalGenerateRandomSubShape(weights);
            subShapes = [a, a, a, a];
        } else if (distance < 15) {
            const a = internalGenerateRandomSubShape(weights);
            const b = internalGenerateRandomSubShape(weights);
            subShapes = [a, a, b, b];
        } else {
            subShapes = [
                internalGenerateRandomSubShape(weights),
                internalGenerateRandomSubShape(weights),
                internalGenerateRandomSubShape(weights),
                internalGenerateRandomSubShape(weights),
            ];
        }
        let windmills = 0;
        for (const s of subShapes) if (s === "W") windmills++;
        if (windmills > 1) {
            subShapes[0] = "R";
            subShapes[1] = "R";
        }
        internalGeneratePatch(shapePatchSize, { kind: "shape", code: shapeCodeFromQuads(subShapes) });
    }

    function predefined(): boolean {
        if (chunkX === 0 && chunkY === 0) {
            internalGeneratePatch(2, { kind: "color", color: "r" }, 7, 7);
            return true;
        }
        if (chunkX === -1 && chunkY === 0) {
            internalGeneratePatch(2, { kind: "shape", code: "CuCuCuCu" }, MAP_CHUNK_SIZE - 9, 7);
            return true;
        }
        if (chunkX === 0 && chunkY === -1) {
            internalGeneratePatch(2, { kind: "shape", code: "RuRuRuRu" }, 5, MAP_CHUNK_SIZE - 7);
            return true;
        }
        if (chunkX === -1 && chunkY === -1) {
            internalGeneratePatch(2, { kind: "color", color: "g" });
            return true;
        }
        if (chunkX === 5 && chunkY === -2) {
            internalGeneratePatch(2, { kind: "shape", code: "SuSuSuSu" }, 5, MAP_CHUNK_SIZE - 7);
            return true;
        }
        return false;
    }

    if (!predefined()) {
        const chunkCenter = { x: chunkX + 0.5, y: chunkY + 0.5 };
        const distance = Math.round(Math.hypot(chunkCenter.x, chunkCenter.y));
        const colorPatchChance = 0.9 - clamp(distance / 25, 0, 1) * 0.5;
        if (rng.next() < colorPatchChance / 4) {
            const size = Math.max(2, Math.round(1 + clamp(distance / 8, 0, 4)));
            internalGenerateColorPatch(size, distance);
        }
        const shapePatchChance = 0.9 - clamp(distance / 25, 0, 1) * 0.5;
        if (rng.next() < shapePatchChance / 4) {
            const size = Math.max(2, Math.round(1 + clamp(distance / 8, 0, 4)));
            internalGenerateShapePatch(size, distance);
        }
    }

    return { chunkX, chunkY, lower, patches };
}

/* ------------------------------------------------------------------ *
 * world helpers
 * ------------------------------------------------------------------ */

export interface ScanOptions {
    chunkRadius?: number;
    originChunkX?: number;
    originChunkY?: number;
}

export function scanMap(
    seed: number,
    { chunkRadius = 5, originChunkX = 0, originChunkY = 0 }: ScanOptions = {}
): Patch[] {
    const patches: Patch[] = [];
    for (let cx = originChunkX - chunkRadius; cx <= originChunkX + chunkRadius; cx++) {
        for (let cy = originChunkY - chunkRadius; cy <= originChunkY + chunkRadius; cy++) {
            const chunk = generateChunk(seed, cx, cy);
            patches.push(...chunk.patches);
        }
    }
    return patches;
}

/**
 * How many miners a deposit can actually carry.
 *
 * A miner ejects on one side, and that side needs a free tile for a belt; one
 * belt takes one tile, so N miners need N distinct neighbouring tiles. A solid
 * 5×5 deposit is 25 tiles but only 20 tiles ring its border, so at most 20
 * miners fit — the rest would have nowhere to eject. A long thin deposit loses
 * almost nothing, a blocky one loses a lot. This is an upper bound: the real
 * count also depends on how the belts are routed out. (Chained miners, unlocked
 * at L11, share one output and skip this.)
 */
export function patchMinerCapacity(patch: Pick<Patch, "cells" | "tiles">): number {
    const cells = patch.cells;
    if (!cells || !cells.length) return patch.tiles || 0;
    const inside = new Set(cells.map(([x, y]) => `${x}|${y}`));
    const exits = new Set<string>();
    for (const [x, y] of cells) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
            const key = `${x + dx}|${y + dy}`;
            if (!inside.has(key)) exits.add(key);
        }
    }
    return Math.min(cells.length, exits.size);
}

/** shape letters present in the deposits of a patch list */
export function depositTypes(patches: readonly Patch[]): Set<string> {
    const types = new Set<string>();
    for (const p of patches) {
        if (p.item.kind !== "shape") continue;
        for (let i = 0; i < p.item.code.length; i += 2) types.add(p.item.code.charAt(i));
    }
    return types;
}

/**
 * Scan outwards until every required shape letter has a deposit.
 *
 * The generator only starts to place `S` and `W` deposits some chunks away from
 * the hub (`weights.S/W = 0` below distance 7) and puts at most one windmill
 * quadrant into a patch, so a fixed radius misses them on some seeds. Doubling
 * the radius keeps the common case cheap and still finds them on every seed we
 * have seen; the caller gets the radius that worked and what is still missing.
 *
 * `types` are the shape letters the plan needs (C R S W); `startRadius` are the
 * chunks scanned first and `maxRadius` is the hard cap on the expansion.
 */
export interface ScanTypesOptions {
    /** shape letters the plan needs, e.g. `requiredTypes(shapes)` */
    types?: ReadonlySet<string>;
    startRadius?: number;
    maxRadius?: number;
}

export interface ScanResult {
    patches: Patch[];
    radius: number;
    missingTypes: string[];
}

export function scanForTypes(
    seed: number,
    { types, startRadius = 8, maxRadius = 32 }: ScanTypesOptions = {}
): ScanResult {
    const wanted = types ? [...new Set(types)] : [];
    let radius = Math.max(1, startRadius);
    let patches = scanMap(seed, { chunkRadius: radius });
    let have = depositTypes(patches);
    let missing = wanted.filter((t) => !have.has(t));
    while (missing.length && radius < maxRadius) {
        radius = Math.min(maxRadius, radius * 2);
        patches = scanMap(seed, { chunkRadius: radius });
        have = depositTypes(patches);
        missing = wanted.filter((t) => !have.has(t));
    }
    return { patches, radius, missingTypes: missing };
}

export function itemLabel(item: MapItem | null | undefined): string {
    if (!item) return "空";
    if (item.kind === "shape") return item.code;
    return "颜色:" + item.color;
}

export interface NearestPatch {
    patch: Patch;
    distance: number;
}

/** nearest patch of a given predicate */
export function nearestPatch(
    patches: readonly Patch[],
    predicate: (item: MapItem) => boolean,
    from: { x: number; y: number } = { x: 0, y: 0 }
): NearestPatch | null {
    let best: Patch | null = null;
    let bestDist = Infinity;
    for (const p of patches) {
        if (!predicate(p.item)) continue;
        const d = Math.hypot(p.x - from.x, p.y - from.y);
        if (d < bestDist) {
            bestDist = d;
            best = p;
        }
    }
    return best ? { patch: best, distance: bestDist } : null;
}

export interface AvailableResources {
    shapes: Map<string, Patch>;
    colors: Map<string, Patch>;
}

/** list of distinct available base shapes / colors near the hub */
export function availableResources(patches: readonly Patch[]): AvailableResources {
    const shapes = new Map<string, Patch>();
    const colors = new Map<string, Patch>();
    for (const p of patches) {
        const map = p.item.kind === "shape" ? shapes : colors;
        const key = p.item.kind === "shape" ? p.item.code : p.item.color;
        const prev = map.get(key);
        if (!prev || Math.hypot(p.x, p.y) < Math.hypot(prev.x, prev.y)) map.set(key, p);
    }
    return { shapes, colors };
}
