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

export const MAP_CHUNK_SIZE = 16;

/* ------------------------------------------------------------------ *
 * ALEA RNG (port of src/js/core/rng.js)
 * ------------------------------------------------------------------ */

function Mash() {
    let n = 0xefc8249d;
    return function (data) {
        data = data.toString();
        for (let i = 0; i < data.length; i++) {
            n += data.charCodeAt(i);
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

function makeNewRng(seed) {
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
    constructor(seed) {
        this.internalRng = makeNewRng(seed);
    }
    next() {
        return this.internalRng();
    }
    choice(array) {
        const index = this.nextIntRange(0, array.length);
        return array[index];
    }
    nextIntRange(min, max) {
        return Math.floor(this.next() * (max - min) + min);
    }
    nextRange(min, max) {
        return this.next() * (max - min) + min;
    }
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/* ------------------------------------------------------------------ *
 * the generator
 * ------------------------------------------------------------------ */

const SHAPE_WEIGHT_ORDER = ["R", "C", "S", "W", "C", "R", "W", "S"];
// the game iterates the weights object; JS keeps string key insertion order,
// and the game inserts them in this exact order:
const WEIGHT_KEYS = ["R", "C", "S", "W"];

function shapeCodeFromQuads(quads) {
    // getDefinitionFromSimpleShapes(subShapes) → one layer, uncolored
    return quads.map((t) => t + "u").join("");
}

/**
 * @param {number} seed
 * @param {number} chunkX
 * @param {number} chunkY
 */
export function generateChunk(seed, chunkX, chunkY) {
    const rng = new RandomNumberGenerator(`${chunkX}|${chunkY}|${seed}`);

    // lowerLayer[x][y] — the game allocates [mapChunkSize][mapChunkSize] but the
    // generator can write y === mapChunkSize (off-by-one in the original), so we
    // keep an extra row/column to stay faithful.
    const lower = Array.from({ length: MAP_CHUNK_SIZE + 1 }, () =>
        new Array(MAP_CHUNK_SIZE + 1).fill(null)
    );
    const patches = [];

    function internalGeneratePatch(patchSize, item, overrideX = null, overrideY = null) {
        const border = Math.ceil(patchSize / 2 + 3);
        let patchX = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        let patchY = rng.nextIntRange(border, MAP_CHUNK_SIZE - border - 1);
        if (overrideX !== null) patchX = overrideX;
        if (overrideY !== null) patchY = overrideY;

        let sumX = 0;
        let sumY = 0;
        let patchesDrawn = 0;
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
                            if (!lower[x][y]) {
                                lower[x][y] = item;
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
        });
    }

    function internalGenerateRandomSubShape(weights) {
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

    function internalGenerateColorPatch(colorPatchSize, distance) {
        const availableColors = ["r", "g"];
        if (distance > 2) availableColors.push("b");
        internalGeneratePatch(colorPatchSize, { kind: "color", color: rng.choice(availableColors) });
    }

    function internalGenerateShapePatch(shapePatchSize, distance) {
        let weights = {
            R: 100,
            C: Math.round(50 + clamp(distance * 2, 0, 50)),
            S: Math.round(20 + clamp(distance, 0, 30)),
            W: Math.round(6 + clamp(distance / 2, 0, 20)),
        };
        if (distance < 7) {
            weights.S = 0;
            weights.W = 0;
        }
        let subShapes;
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

    function predefined() {
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

export function scanMap(seed, { chunkRadius = 5, originChunkX = 0, originChunkY = 0 } = {}) {
    const patches = [];
    for (let cx = originChunkX - chunkRadius; cx <= originChunkX + chunkRadius; cx++) {
        for (let cy = originChunkY - chunkRadius; cy <= originChunkY + chunkRadius; cy++) {
            const chunk = generateChunk(seed, cx, cy);
            patches.push(...chunk.patches);
        }
    }
    return patches;
}

export function itemLabel(item) {
    if (!item) return "空";
    if (item.kind === "shape") return item.code;
    return "颜色:" + item.color;
}

/** nearest patch of a given predicate */
export function nearestPatch(patches, predicate, from = { x: 0, y: 0 }) {
    let best = null;
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

/** list of distinct available base shapes / colors near the hub */
export function availableResources(patches) {
    const shapes = new Map();
    const colors = new Map();
    for (const p of patches) {
        const map = p.item.kind === "shape" ? shapes : colors;
        const key = p.item.kind === "shape" ? p.item.code : p.item.color;
        const prev = map.get(key);
        if (!prev || Math.hypot(p.x, p.y) < Math.hypot(prev.x, prev.y)) map.set(key, p);
    }
    return { shapes, colors };
}
