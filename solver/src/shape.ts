/**
 * shapez.io shape model — mirrors the game's ShapeDefinition semantics (v1.5.x).
 *
 * Quadrant order follows the game: 0 = top-right, 1 = bottom-right,
 * 2 = bottom-left, 3 = top-left.
 *
 *   +----+----+
 *   | q3 | q0 |
 *   +----+----+
 *   | q2 | q1 |
 *   +----+----+
 *
 * Short key: layers joined by ":", each layer is 8 chars = 4 x (type, color).
 *   "RuCw--Cw" -> q0 = R/u, q1 = C/w, q2 = -, q3 = C/w
 */

export const TYPE_CHARS = ["C", "R", "S", "W"] as const;
export type ShapeType = (typeof TYPE_CHARS)[number];

export const TYPE_NAMES: Record<ShapeType, string> = {
    C: "circle",
    R: "rect",
    S: "star",
    W: "windmill",
};
export const TYPE_NAMES_ZH: Record<ShapeType, string> = { C: "圆", R: "方", S: "星", W: "风车" };

export const COLOR_CHARS = ["r", "g", "b", "y", "p", "c", "w", "u"] as const;
export type ColorChar = (typeof COLOR_CHARS)[number];

export const COLOR_NAMES: Record<ColorChar, string> = {
    r: "red",
    g: "green",
    b: "blue",
    y: "yellow",
    p: "purple",
    c: "cyan",
    w: "white",
    u: "uncolored",
};
export const COLOR_NAMES_ZH: Record<ColorChar, string> = {
    r: "红",
    g: "绿",
    b: "蓝",
    y: "黄",
    p: "紫",
    c: "青",
    w: "白",
    u: "无色",
};
export const COLOR_HEX: Record<ColorChar, string> = {
    r: "#ff666a",
    g: "#78ff66",
    b: "#66a7ff",
    y: "#fcf52a",
    p: "#dd66ff",
    c: "#00fcff",
    w: "#ffffff",
    u: "#aaaaaa",
};

export const FULL_QUAD_MASK = 0b1111;

/** type guard for parse() and the planner's deposit validation */
export function isTypeChar(value: string): value is ShapeType {
    return (TYPE_CHARS as readonly string[]).includes(value);
}

/** type guard for parse() */
export function isColorChar(value: string): value is ColorChar {
    return (COLOR_CHARS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * cells / shapes
 * ------------------------------------------------------------------ */

export interface Cell {
    t: ShapeType;
    c: ColorChar;
}

/** four quadrant slots, `null` = empty */
export type Layer = (Cell | null)[];

export interface Shape {
    layers: Layer[];
    /** memoised short key; a shape without it is hashed on demand */
    __hash?: string;
}

export type Rotation = "0" | "CW" | "CCW" | "180";

export function makeLayer(): Layer {
    return [null, null, null, null];
}

export function cell(t: ShapeType, c: ColorChar = "u"): Cell {
    return { t, c };
}

export function cloneCell(x: Cell | null | undefined): Cell | null {
    return x ? { t: x.t, c: x.c } : null;
}

export function cloneShape(shape: Shape): Shape {
    return { layers: shape.layers.map((layer) => layer.map(cloneCell)) };
}

export function emptyShape(): Shape {
    return { layers: [], __hash: "" };
}

export function isEntirelyEmpty(shape: Shape): boolean {
    return shape.layers.length === 0;
}

export interface IndexedCell {
    layer: number;
    quad: number;
}

export function cellPositions(shape: Shape): IndexedCell[] {
    const out: IndexedCell[] = [];
    shape.layers.forEach((layer, layerIndex) => {
        layer.forEach((c, quad) => {
            if (c) out.push({ layer: layerIndex, quad });
        });
    });
    return out;
}

export function countCells(shape: Shape): number {
    let n = 0;
    for (const layer of shape.layers) for (const c of layer) if (c) n++;
    return n;
}

export function getCell(shape: Shape, layer: number, quad: number): Cell | null {
    const l = shape.layers[layer];
    return l ? (l[quad] ?? null) : null;
}

/* ------------------------------------------------------------------ *
 * parsing / hashing
 * ------------------------------------------------------------------ */

export class ShapeParseError extends Error {}

export function parse(code: string): Shape {
    if (typeof code !== "string") throw new ShapeParseError("shape code must be a string");
    const text = code.trim();
    if (!text) throw new ShapeParseError("empty shape code");
    // Allow deliberately empty layers in between? The game rejects them, so we do too.
    const parts = text.split(":");
    if (parts.length < 1 || parts.length > 4) {
        throw new ShapeParseError(`expected 1-4 layers, got ${parts.length}`);
    }
    const layers = parts.map((layerText, layerIndex) => {
        if (layerText.length !== 8) {
            throw new ShapeParseError(
                `layer ${layerIndex + 1} must be 8 characters (4 x shape+color), got ${layerText.length}`
            );
        }
        const layer = makeLayer();
        let any = false;
        for (let quad = 0; quad < 4; quad++) {
            const typeChar = layerText.charAt(quad * 2);
            const colorChar = layerText.charAt(quad * 2 + 1);
            if (typeChar === "-") {
                if (colorChar !== "-") {
                    throw new ShapeParseError(
                        `layer ${layerIndex + 1} quadrant ${quad}: empty quadrant must be "--", got "-${colorChar}"`
                    );
                }
                continue;
            }
            if (!isTypeChar(typeChar)) {
                throw new ShapeParseError(
                    `layer ${layerIndex + 1} quadrant ${quad}: unknown shape "${typeChar}" (use C, R, S, W or -)`
                );
            }
            if (!isColorChar(colorChar)) {
                throw new ShapeParseError(
                    `layer ${layerIndex + 1} quadrant ${quad}: unknown color "${colorChar}" (use r,g,b,y,p,c,w,u)`
                );
            }
            layer[quad] = { t: typeChar, c: colorChar };
            any = true;
        }
        if (!any) throw new ShapeParseError(`layer ${layerIndex + 1} is completely empty`);
        return layer;
    });
    const shape: Shape = { layers };
    shape.__hash = computeHash(shape);
    return shape;
}

export type ParseResult = { ok: true; shape: Shape } | { ok: false; error: string };

export function tryParse(code: string): ParseResult {
    try {
        return { ok: true, shape: parse(code) };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export function computeHash(shape: Shape): string {
    if (shape.__hash !== undefined) return shape.__hash;
    let out = "";
    for (let li = 0; li < shape.layers.length; li++) {
        if (li) out += ":";
        const layer = shape.layers[li];
        if (!layer) continue;
        for (let q = 0; q < 4; q++) {
            const c = layer[q];
            out += c ? c.t + c.c : "--";
        }
    }
    shape.__hash = out;
    return out;
}

export function hash(shape: Shape): string {
    return computeHash(shape);
}

export function equals(a: Shape, b: Shape): boolean {
    return computeHash(a) === computeHash(b);
}

/* ------------------------------------------------------------------ *
 * operations (exact ports of the game's ShapeDefinition methods)
 * ------------------------------------------------------------------ */

function rotateWith(shape: Shape, map: readonly number[]): Shape {
    const layers = shape.layers.map((layer) => {
        const out = makeLayer();
        for (let q = 0; q < 4; q++) out[q] = cloneCell(layer[map[q] ?? q]);
        return out;
    });
    return { layers };
}

/** quadrants.unshift(quadrants[3]); quadrants.pop()  ->  [q3, q0, q1, q2] */
export function rotateCW(shape: Shape): Shape {
    return rotateWith(shape, [3, 0, 1, 2]);
}

/** quadrants.push(quadrants[0]); quadrants.shift()  ->  [q1, q2, q3, q0] */
export function rotateCCW(shape: Shape): Shape {
    return rotateWith(shape, [1, 2, 3, 0]);
}

/** quadrants.push(shift(), shift())  ->  [q2, q3, q0, q1] */
export function rotate180(shape: Shape): Shape {
    return rotateWith(shape, [2, 3, 0, 1]);
}

export function rotate(shape: Shape, dir: Rotation): Shape {
    if (dir === "CW") return rotateCW(shape);
    if (dir === "CCW") return rotateCCW(shape);
    if (dir === "180") return rotate180(shape);
    if (dir === "0") return cloneShape(shape);
    throw new Error("unknown rotation " + dir);
}

/**
 * cloneFilteredByQuadrants — keeps the given quadrants and drops layers that
 * become completely empty (layer indices compact, exactly like the game).
 */
export function filterQuadrants(shape: Shape, keep: readonly number[]): Shape {
    const layers: Layer[] = [];
    for (const layer of shape.layers) {
        const out = makeLayer();
        let any = false;
        for (const q of keep) {
            const c = layer[q];
            if (c) {
                out[q] = cloneCell(c);
                any = true;
            }
        }
        if (any) layers.push(out);
    }
    return { layers };
}

/** frameSemantics: [ {2,3} , {0,1} ] */
export function cutHalf(shape: Shape): [Shape, Shape] {
    return [filterQuadrants(shape, [2, 3]), filterQuadrants(shape, [0, 1])];
}

export function cutQuad(shape: Shape): [Shape, Shape, Shape, Shape] {
    return [
        filterQuadrants(shape, [0]),
        filterQuadrants(shape, [1]),
        filterQuadrants(shape, [2]),
        filterQuadrants(shape, [3]),
    ];
}

/**
 * cloneAndStackWith — the game's stacker. `lower` stays untouched, `upper` is
 * shifted down until the smallest per-quadrant gap is exactly one layer.
 * Everything above 4 layers is truncated.
 */
export function stack(lower: Shape, upper: Shape): Shape {
    if (isEntirelyEmpty(lower) || isEntirelyEmpty(upper)) {
        throw new Error("cannot stack an entirely empty shape");
    }
    const bottomHighest = [-1, -1, -1, -1];
    for (let li = lower.layers.length - 1; li >= 0; li--) {
        const layer = lower.layers[li];
        if (!layer) continue;
        for (let q = 0; q < 4; q++) {
            if (layer[q] !== null && (bottomHighest[q] ?? -1) < li) bottomHighest[q] = li;
        }
    }
    const topLowest = [4, 4, 4, 4];
    for (let li = 0; li < upper.layers.length; li++) {
        const layer = upper.layers[li];
        if (!layer) continue;
        for (let q = 0; q < 4; q++) {
            if (layer[q] !== null && (topLowest[q] ?? 4) > li) topLowest[q] = li;
        }
    }
    const gaps = [0, 1, 2, 3].map((q) => (topLowest[q] ?? 4) - (bottomHighest[q] ?? -1));
    const smallestGap = Math.min(...gaps);
    const mergeAt = Math.max(1 - smallestGap, 0);

    const merged = lower.layers.map((layer) => layer.map(cloneCell));
    while (merged.length < mergeAt + upper.layers.length) merged.push(makeLayer());
    for (let li = 0; li < upper.layers.length; li++) {
        const target = merged[mergeAt + li];
        if (!target) throw new Error("stack layer out of range");
        const src = upper.layers[li];
        if (!src) continue;
        for (let q = 0; q < 4; q++) {
            const c = src[q];
            if (c) {
                if (target[q]) throw new Error("stack collision");
                target[q] = cloneCell(c);
            }
        }
    }
    merged.length = Math.min(merged.length, 4);
    return { layers: merged };
}

/** returns the layer offset the stacker uses (for diagnostics / planning) */
export function stackOffset(lower: Shape, upper: Shape): number {
    const bottomHighest = [-1, -1, -1, -1];
    for (let li = lower.layers.length - 1; li >= 0; li--) {
        const layer = lower.layers[li];
        if (!layer) continue;
        for (let q = 0; q < 4; q++) {
            if (layer[q] && (bottomHighest[q] ?? -1) < li) bottomHighest[q] = li;
        }
    }
    const topLowest = [4, 4, 4, 4];
    for (let li = 0; li < upper.layers.length; li++) {
        const layer = upper.layers[li];
        if (!layer) continue;
        for (let q = 0; q < 4; q++) {
            if (layer[q] && (topLowest[q] ?? 4) > li) topLowest[q] = li;
        }
    }
    const gaps = [0, 1, 2, 3].map((q) => (topLowest[q] ?? 4) - (bottomHighest[q] ?? -1));
    return Math.max(1 - Math.min(...gaps), 0);
}

export function paint(shape: Shape, color: ColorChar): Shape {
    const layers = shape.layers.map((layer) => layer.map((c) => (c ? { t: c.t, c: color } : null)));
    return { layers };
}

/** colors[i] === null keeps the current color of quadrant i */
export function paint4(shape: Shape, colors: readonly (ColorChar | null)[]): Shape {
    const layers = shape.layers.map((layer) =>
        layer.map((c, q) => (c ? { t: c.t, c: colors[q] || c.c } : null))
    );
    return { layers };
}

export function stripColors(shape: Shape): Shape {
    const layers = shape.layers.map((layer) => layer.map((c) => (c ? { t: c.t, c: "u" as const } : null)));
    return { layers };
}

/* ------------------------------------------------------------------ *
 * helpers used by the solver
 * ------------------------------------------------------------------ */

export function quadMask(shape: Shape): number {
    const layer = shape.layers[0];
    let mask = 0;
    if (!layer) return 0;
    for (let q = 0; q < 4; q++) if (layer[q]) mask |= 1 << q;
    return mask;
}

export function isSingleLayer(shape: Shape): boolean {
    return shape.layers.length === 1;
}

export function uniformColor(shape: Shape): ColorChar | null {
    let color: ColorChar | null = null;
    for (const layer of shape.layers) {
        for (const c of layer) {
            if (!c) continue;
            if (color === null) color = c.c;
            else if (color !== c.c) return null;
        }
    }
    return color;
}

export type QuadColors = [ColorChar | null, ColorChar | null, ColorChar | null, ColorChar | null];

/**
 * Returns [c0,c1,c2,c3] (null for empty quadrants) when every quadrant uses a
 * single color across all its layers, otherwise null.
 */
export function quadUniformColors(shape: Shape): QuadColors | null {
    const colors: QuadColors = [null, null, null, null];
    const seen = [false, false, false, false];
    for (const layer of shape.layers) {
        for (let q = 0; q < 4; q++) {
            const c = layer[q];
            if (!c) continue;
            if (!seen[q]) {
                seen[q] = true;
                colors[q] = c.c;
            } else if (colors[q] !== c.c) {
                return null;
            }
        }
    }
    return colors;
}

export function allUncolored(shape: Shape): boolean {
    for (const layer of shape.layers) for (const c of layer) if (c && c.c !== "u") return false;
    return true;
}

export function hasLayersAbove(shape: Shape, n: number): boolean {
    return shape.layers.length > n;
}

/** which half (0 = {2,3}, 1 = {0,1}) contains every cell, or -1 */
export function confinedHalf(shape: Shape): number {
    let right = false;
    let left = false;
    for (const layer of shape.layers) {
        if (layer[0] || layer[1]) left = true;
        if (layer[2] || layer[3]) right = true;
    }
    if (left && right) return -1;
    return right ? 0 : 1;
}

export function describeCell(c: Cell | null | undefined): string {
    if (!c) return "空";
    return `${TYPE_NAMES_ZH[c.t]}${COLOR_NAMES_ZH[c.c]}`;
}

/** Human readable one-liner of a shape. */
export function describeShape(shape: Shape): string {
    const parts: string[] = [];
    shape.layers.forEach((layer, li) => {
        const cells: string[] = [];
        for (let q = 0; q < 4; q++) if (layer[q]) cells.push(`q${q}:${describeCell(layer[q])}`);
        parts.push(`L${li} {${cells.join(", ")}}`);
    });
    return parts.join(" | ");
}
