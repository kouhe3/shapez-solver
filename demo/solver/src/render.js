/**
 * Shape rendering: game-accurate SVG (same geometry as ShapeDefinition.draw)
 * plus a compact ASCII fallback for the terminal.
 *
 * Quadrants on screen:  [q3 q0]
 *                       [q2 q1]
 */

import { COLOR_HEX, TYPE_NAMES_ZH, COLOR_NAMES_ZH } from "./shape.js";

const OUTLINE = "#4a4c5a";
const OUTLINE_WIDTH = 0.55;
const BACKGROUND = "#e3e8f3";
const BACKGROUND_STROKE = "#c7cddd";

function cellPath(cell, layerScale) {
    const dims = 10 * layerScale;
    const x0 = -5;
    const y0 = 5 - dims;
    const inward = dims * 0.4;
    switch (cell.t) {
        case "R":
            return `<rect x="${x0}" y="${y0}" width="${dims}" height="${dims}"/>`;
        case "S":
            return `<path d="M ${x0} ${y0 + inward} L ${x0 + dims} ${y0} L ${
                x0 + dims - inward
            } ${y0 + dims} L ${x0} ${y0 + dims} Z"/>`;
        case "W":
            return `<path d="M ${x0} ${y0 + inward} L ${x0 + dims} ${y0} L ${
                x0 + dims
            } ${y0 + dims} L ${x0} ${y0 + dims} Z"/>`;
        case "C": {
            // canvas draws: center -> (line to) top of arc -> quarter arc -> center.
            // SVG's A starts at the current point, so start at the top of the arc.
            const r = dims;
            const cx = x0;
            const cy = y0 + dims; // the quadrant's inner corner
            return `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx + r} ${cy} L ${cx} ${cy} Z"/>`;
        }
        default:
            return "";
    }
}

const QUAD_OFFSET = [
    [1, -1], // q0 top-right
    [1, 1], // q1 bottom-right
    [-1, 1], // q2 bottom-left
    [-1, -1], // q3 top-left
];

/**
 * @param {object} shape
 * @param {number} size pixel size
 * @param {object} opts {background: boolean}
 */
export function shapeSVG(shape, size = 120, opts = {}) {
    const scale = size / 23;
    const parts = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">`
    );
    parts.push(`<g transform="translate(${size / 2} ${size / 2}) scale(${scale})">`);
    if (opts.background !== false) {
        parts.push(
            `<circle cx="0" cy="0" r="11.5" fill="${BACKGROUND}" stroke="${BACKGROUND_STROKE}" stroke-width="0.5"/>`
        );
    }
    shape.layers.forEach((layer, layerIndex) => {
        const layerScale = Math.max(0.1, 0.9 - layerIndex * 0.22);
        for (let q = 0; q < 4; q++) {
            const cell = layer[q];
            if (!cell) continue;
            const [dx, dy] = QUAD_OFFSET[q];
            parts.push(
                `<g transform="translate(${dx * 5} ${dy * 5}) rotate(${q * 90})" fill="${
                    COLOR_HEX[cell.c] || COLOR_HEX.u
                }" stroke="${OUTLINE}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="round">`
            );
            parts.push(cellPath(cell, layerScale));
            parts.push(`</g>`);
        }
    });
    parts.push(`</g></svg>`);
    return parts.join("");
}

export function dataUriSVG(shape, size = 120, opts = {}) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(shapeSVG(shape, size, opts));
}

/* ------------------------------------------------------------------ *
 * ASCII
 * ------------------------------------------------------------------ */

function cellText(cell) {
    if (!cell) return "·";
    const type = cell.t;
    const color = cell.c === "u" ? "" : cell.c;
    return (type + color).padEnd(2, " ");
}

export function shapeASCII(shape) {
    const lines = [];
    shape.layers.forEach((layer, li) => {
        const label = `L${li}`;
        lines.push(`${label}   ${cellText(layer[3])}│${cellText(layer[0])}`);
        lines.push(`    ──┼──`);
        lines.push(`    ${cellText(layer[2])}│${cellText(layer[1])}`);
        if (li < shape.layers.length - 1) lines.push(`    (上一层之上)`);
    });
    return lines.join("\n");
}

/** [["Ru","Cw"],["·","Cw"]] style grid, handy in tables */
export function shapeGrid(shape) {
    const out = [];
    shape.layers.forEach((layer) => {
        out.push([cellText(layer[3]).trim() || "·", cellText(layer[0]).trim() || "·"]);
        out.push([cellText(layer[2]).trim() || "·", cellText(layer[1]).trim() || "·"]);
    });
    return out;
}

export function describeCellShort(cell) {
    if (!cell) return "空";
    return `${TYPE_NAMES_ZH[cell.t]}${cell.c === "u" ? "（未上色）" : COLOR_NAMES_ZH[cell.c]}`;
}

/* ------------------------------------------------------------------ *
 * world map / stacker order helpers (for docs and the UI legend)
 * ------------------------------------------------------------------ */

export const QUADRANT_LEGEND = [
    { q: 0, name: "右上 (q0)" },
    { q: 1, name: "右下 (q1)" },
    { q: 2, name: "左下 (q2)" },
    { q: 3, name: "左上 (q3)" },
];
