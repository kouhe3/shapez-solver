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

export const TYPE_CHARS = ["C", "R", "S", "W"];
export const TYPE_NAMES = { C: "circle", R: "rect", S: "star", W: "windmill" };
export const TYPE_NAMES_ZH = { C: "圆", R: "方", S: "星", W: "风车" };

export const COLOR_CHARS = ["r", "g", "b", "y", "p", "c", "w", "u"];
export const COLOR_NAMES = {
    r: "red",
    g: "green",
    b: "blue",
    y: "yellow",
    p: "purple",
    c: "cyan",
    w: "white",
    u: "uncolored",
};
export const COLOR_NAMES_ZH = {
    r: "红",
    g: "绿",
    b: "蓝",
    y: "黄",
    p: "紫",
    c: "青",
    w: "白",
    u: "无色",
};
export const COLOR_HEX = {
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

/* ------------------------------------------------------------------ *
 * cells / shapes
 * ------------------------------------------------------------------ */

export function makeLayer() {
    return [null, null, null, null];
}

export function cell(t, c = "u") {
    return { t, c };
}

export function cloneCell(x) {
    return x ? { t: x.t, c: x.c } : null;
}

export function cloneShape(shape) {
    return { layers: shape.layers.map((layer) => layer.map(cloneCell)) };
}

export function emptyShape() {
    return { layers: [], __hash: "" };
}

export function isEntirelyEmpty(shape) {
    return shape.layers.length === 0;
}

export function cellPositions(shape) {
    const out = [];
    shape.layers.forEach((layer, layerIndex) => {
        layer.forEach((c, quad) => {
            if (c) out.push({ layer: layerIndex, quad });
        });
    });
    return out;
}

export function countCells(shape) {
    let n = 0;
    for (const layer of shape.layers) for (const c of layer) if (c) n++;
    return n;
}

export function getCell(shape, layer, quad) {
    const l = shape.layers[layer];
    return l ? l[quad] : null;
}

/* ------------------------------------------------------------------ *
 * parsing / hashing
 * ------------------------------------------------------------------ */

export class ShapeParseError extends Error {}

export function parse(code) {
    if (typeof code !== "string") throw new ShapeParseError("shape code must be a string");
    let text = code.trim();
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
            const typeChar = layerText[quad * 2];
            const colorChar = layerText[quad * 2 + 1];
            if (typeChar === "-") {
                if (colorChar !== "-") {
                    throw new ShapeParseError(
                        `layer ${layerIndex + 1} quadrant ${quad}: empty quadrant must be "--", got "-${colorChar}"`
                    );
                }
                continue;
            }
            if (!TYPE_CHARS.includes(typeChar)) {
                throw new ShapeParseError(
                    `layer ${layerIndex + 1} quadrant ${quad}: unknown shape "${typeChar}" (use C, R, S, W or -)`
                );
            }
            if (!COLOR_CHARS.includes(colorChar)) {
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
    const shape = { layers };
    shape.__hash = computeHash(shape);
    return shape;
}

export function tryParse(code) {
    try {
        return { ok: true, shape: parse(code) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export function computeHash(shape) {
    if (shape.__hash !== undefined) return shape.__hash;
    let out = "";
    for (let li = 0; li < shape.layers.length; li++) {
        if (li) out += ":";
        const layer = shape.layers[li];
        for (let q = 0; q < 4; q++) {
            const c = layer[q];
            out += c ? c.t + c.c : "--";
        }
    }
    shape.__hash = out;
    return out;
}

export function hash(shape) {
    return computeHash(shape);
}

export function equals(a, b) {
    return computeHash(a) === computeHash(b);
}

/* ------------------------------------------------------------------ *
 * operations (exact ports of the game's ShapeDefinition methods)
 * ------------------------------------------------------------------ */

function rotateWith(shape, map) {
    const layers = shape.layers.map((layer) => {
        const out = makeLayer();
        for (let q = 0; q < 4; q++) out[q] = cloneCell(layer[map[q]]);
        return out;
    });
    return { layers };
}

/** quadrants.unshift(quadrants[3]); quadrants.pop()  ->  [q3, q0, q1, q2] */
export function rotateCW(shape) {
    return rotateWith(shape, [3, 0, 1, 2]);
}

/** quadrants.push(quadrants[0]); quadrants.shift()  ->  [q1, q2, q3, q0] */
export function rotateCCW(shape) {
    return rotateWith(shape, [1, 2, 3, 0]);
}

/** quadrants.push(shift(), shift())  ->  [q2, q3, q0, q1] */
export function rotate180(shape) {
    return rotateWith(shape, [2, 3, 0, 1]);
}

export function rotate(shape, dir) {
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
export function filterQuadrants(shape, keep) {
    const layers = [];
    for (const layer of shape.layers) {
        const out = makeLayer();
        let any = false;
        for (const q of keep) {
            if (layer[q]) {
                out[q] = cloneCell(layer[q]);
                any = true;
            }
        }
        if (any) layers.push(out);
    }
    return { layers };
}

/** frameSemantics: [ {2,3} , {0,1} ] */
export function cutHalf(shape) {
    return [filterQuadrants(shape, [2, 3]), filterQuadrants(shape, [0, 1])];
}

export function cutQuad(shape) {
    return [0, 1, 2, 3].map((q) => filterQuadrants(shape, [q]));
}

/**
 * cloneAndStackWith — the game's stacker. `lower` stays untouched, `upper` is
 * shifted down until the smallest per-quadrant gap is exactly one layer.
 * Everything above 4 layers is truncated.
 */
export function stack(lower, upper) {
    if (isEntirelyEmpty(lower) || isEntirelyEmpty(upper)) {
        throw new Error("cannot stack an entirely empty shape");
    }
    const bottomHighest = [-1, -1, -1, -1];
    for (let li = lower.layers.length - 1; li >= 0; li--) {
        const layer = lower.layers[li];
        for (let q = 0; q < 4; q++) {
            if (layer[q] !== null && bottomHighest[q] < li) bottomHighest[q] = li;
        }
    }
    const topLowest = [4, 4, 4, 4];
    for (let li = 0; li < upper.layers.length; li++) {
        const layer = upper.layers[li];
        for (let q = 0; q < 4; q++) {
            if (layer[q] !== null && topLowest[q] > li) topLowest[q] = li;
        }
    }
    const gaps = [0, 1, 2, 3].map((q) => topLowest[q] - bottomHighest[q]);
    const smallestGap = Math.min(...gaps);
    const mergeAt = Math.max(1 - smallestGap, 0);

    const merged = lower.layers.map((layer) => layer.map(cloneCell));
    while (merged.length < mergeAt + upper.layers.length) merged.push(makeLayer());
    for (let li = 0; li < upper.layers.length; li++) {
        const target = merged[mergeAt + li];
        const src = upper.layers[li];
        for (let q = 0; q < 4; q++) {
            if (src[q]) {
                if (target[q]) throw new Error("stack collision");
                target[q] = cloneCell(src[q]);
            }
        }
    }
    merged.length = Math.min(merged.length, 4);
    return { layers: merged };
}

/** returns the layer offset the stacker uses (for diagnostics / planning) */
export function stackOffset(lower, upper) {
    const bottomHighest = [-1, -1, -1, -1];
    for (let li = lower.layers.length - 1; li >= 0; li--) {
        const layer = lower.layers[li];
        for (let q = 0; q < 4; q++) if (layer[q] && bottomHighest[q] < li) bottomHighest[q] = li;
    }
    const topLowest = [4, 4, 4, 4];
    for (let li = 0; li < upper.layers.length; li++) {
        const layer = upper.layers[li];
        for (let q = 0; q < 4; q++) if (layer[q] && topLowest[q] > li) topLowest[q] = li;
    }
    const gaps = [0, 1, 2, 3].map((q) => topLowest[q] - bottomHighest[q]);
    return Math.max(1 - Math.min(...gaps), 0);
}

export function paint(shape, color) {
    const layers = shape.layers.map((layer) =>
        layer.map((c) => (c ? { t: c.t, c: color } : null))
    );
    return { layers };
}

/** colors[i] === null keeps the current color of quadrant i */
export function paint4(shape, colors) {
    const layers = shape.layers.map((layer) =>
        layer.map((c, q) => (c ? { t: c.t, c: colors[q] || c.c } : null))
    );
    return { layers };
}

export function stripColors(shape) {
    const layers = shape.layers.map((layer) =>
        layer.map((c) => (c ? { t: c.t, c: "u" } : null))
    );
    return { layers };
}

/* ------------------------------------------------------------------ *
 * helpers used by the solver
 * ------------------------------------------------------------------ */

export function quadMask(shape) {
    const layer = shape.layers[0];
    let mask = 0;
    if (!layer) return 0;
    for (let q = 0; q < 4; q++) if (layer[q]) mask |= 1 << q;
    return mask;
}

export function isSingleLayer(shape) {
    return shape.layers.length === 1;
}

export function uniformColor(shape) {
    let color = null;
    for (const layer of shape.layers) {
        for (const c of layer) {
            if (!c) continue;
            if (color === null) color = c.c;
            else if (color !== c.c) return null;
        }
    }
    return color;
}

/**
 * Returns [c0,c1,c2,c3] (null for empty quadrants) when every quadrant uses a
 * single color across all its layers, otherwise null.
 */
export function quadUniformColors(shape) {
    const colors = [null, null, null, null];
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

export function allUncolored(shape) {
    for (const layer of shape.layers) for (const c of layer) if (c && c.c !== "u") return false;
    return true;
}

export function hasLayersAbove(shape, n) {
    return shape.layers.length > n;
}

/** which half (0 = {2,3}, 1 = {0,1}) contains every cell, or -1 */
export function confinedHalf(shape) {
    let right = false;
    let left = false;
    for (const layer of shape.layers) {
        if (layer[0] || layer[1]) left = true;
        if (layer[2] || layer[3]) right = true;
    }
    if (left && right) return -1;
    return right ? 0 : 1;
}

export function describeCell(c) {
    if (!c) return "空";
    return `${TYPE_NAMES_ZH[c.t]}${COLOR_NAMES_ZH[c.c]}`;
}

/** Human readable one-liner of a shape. */
export function describeShape(shape) {
    const parts = [];
    shape.layers.forEach((layer, li) => {
        const cells = [];
        for (let q = 0; q < 4; q++) if (layer[q]) cells.push(`q${q}:${describeCell(layer[q])}`);
        parts.push(`L${li} {${cells.join(", ")}}`);
    });
    return parts.join(" | ");
}
