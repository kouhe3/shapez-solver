/**
 * Renders a build layout as an SVG "build sheet" (图纸):
 * resource patches, the hub, every building with its ports, and the
 * material flow between them.
 */

import { COLOR_HEX, parse } from "./shape.js";
import { BUILDING_INFO } from "./layout.js";
import { shapeSVG } from "./render.js";
import { formatRate } from "./rates.js";

// Values taken from the game itself so the sheet matches what the player sees:
// themes/light.json for the map layer, MetaHubBuilding for the hub.
const MAP_THEME = {
    background: "#eceef2",
    resources: {
        shape: "#e0e2e8",
        r: "#f3bcb6",
        g: "#cfefa0",
        b: "#b2e0fa",
    },
};
const HUB_COLOR = "#eb5555";

function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Palette read off the game's own art (res/atlas0_hq.png) and its map view:
// building bodies are #dee1ea plates with #64666e ink, belts are solid
// #797a80 runs (#d2d4d9 ribbons once zoomed in).
const INK = {
    line: "#64666e",
    mid: "#91949e",
    face: "#f8f9ff",
    belt: "#797a80",
};

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * The colour the game paints each building in its map view
 * (MetaBuilding.getSilhouetteColor) — the same blocks the player sees when
 * zoomed out, so a colour is the machine's identity on this sheet too.
 */
const KIND_COLOR = {
    base: "#b37dcd",
    cutHalf: "#7dcda2",
    cutQuad: "#7dcda2",
    rotate: "#7dc6cd",
    stack: "#9fcd7d",
    paint: "#cd9b7d",
    paint4: "#cd9b7d",
    mixer: "#cdbb7d",
    trash: "#ed1d5d",
};

/** darken a #rrggbb by `k` (0..1) for the block's outline */
function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k));
    return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** filled triangle whose tip sits at (cx, cy) and points along `deg` (0 = +x, 90 = +y) */
function arrowHead(cx, cy, len, deg, fill = INK.line) {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const bx = cx - cos * len;
    const by = cy - sin * len;
    const hx = -sin * len * 0.55;
    const hy = cos * len * 0.55;
    return `<path d="M ${r2(cx)} ${r2(cy)} L ${r2(bx + hx)} ${r2(by + hy)} L ${r2(bx - hx)} ${r2(by - hy)} Z" fill="${fill}"/>`;
}

/** paint droplet */
function droplet(cx, cy, d, fill) {
    return `<path d="M ${r2(cx)} ${r2(cy - d * 0.58)} C ${r2(cx + d * 0.52)} ${r2(cy - d * 0.02)} ${r2(
        cx + d * 0.42
    )} ${r2(cy + d * 0.42)} ${r2(cx)} ${r2(cy + d * 0.42)} C ${r2(cx - d * 0.42)} ${r2(cy + d * 0.42)} ${r2(
        cx - d * 0.52
    )} ${r2(cy - d * 0.02)} ${r2(cx)} ${r2(cy - d * 0.58)} Z" fill="${fill}"/>`;
}

/**
 * The machine icon the game itself draws on the building, centred on (x, y)
 * inside a box of `size` px: drill = miner, scissors = cutter, four blades =
 * quad cutter, circular arrow = rotator, plates + arrow = stacker, roller +
 * droplet = painter, two merged circles = mixer.
 *
 * Text labels stay in the legend: a name label is larger than the tile itself
 * at these tile sizes, while the game's pictograms still read.
 */
function machineGlyph(kind, x, y, size, colors) {
    const s = size;
    const ink = INK.line;
    const sw = Math.max(0.9, s * 0.09);
    const stroke = (d) =>
        `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;

    if (kind === "base") {
        // miner: the round drill with a cross that the game puts on the tile
        return (
            `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(s * 0.38)}" fill="${INK.face}" stroke="${ink}" stroke-width="${sw}"/>` +
            stroke(
                `M ${r2(x - s * 0.38)} ${r2(y)} L ${r2(x + s * 0.38)} ${r2(y)} M ${r2(x)} ${r2(y - s * 0.38)} L ${r2(
                    x
                )} ${r2(y + s * 0.38)}`
            )
        );
    }
    if (kind === "cutHalf") {
        // cutter: the game's scissors
        return (
            stroke(
                `M ${r2(x - s * 0.26)} ${r2(y + s * 0.34)} L ${r2(x + s * 0.17)} ${r2(y - s * 0.36)} M ${r2(
                    x + s * 0.26
                )} ${r2(y + s * 0.34)} L ${r2(x - s * 0.17)} ${r2(y - s * 0.36)}`
            ) +
            `<circle cx="${r2(x)}" cy="${r2(y + s * 0.02)}" r="${r2(Math.max(0.7, s * 0.06))}" fill="${ink}"/>` +
            `<circle cx="${r2(x - s * 0.28)}" cy="${r2(y + s * 0.36)}" r="${r2(s * 0.12)}" fill="${INK.face}" stroke="${ink}" stroke-width="${sw}"/>` +
            `<circle cx="${r2(x + s * 0.28)}" cy="${r2(y + s * 0.36)}" r="${r2(s * 0.12)}" fill="${INK.face}" stroke="${ink}" stroke-width="${sw}"/>`
        );
    }
    if (kind === "cutQuad") {
        // quad cutter: four blades leaving a centre hub, as the game draws it
        let arms = "";
        for (const deg of [45, 135, 225, 315]) {
            const a = (deg * Math.PI) / 180;
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            arms += stroke(
                `M ${r2(x + cos * s * 0.13)} ${r2(y + sin * s * 0.13)} L ${r2(x + cos * s * 0.4)} ${r2(
                    y + sin * s * 0.4
                )}`
            );
            arms += arrowHead(x + cos * s * 0.48, y + sin * s * 0.48, s * 0.2, deg);
        }
        return (
            `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(s * 0.12)}" fill="${INK.face}" stroke="${ink}" stroke-width="${sw}"/>` +
            arms
        );
    }
    if (kind === "rotate") {
        // rotator: the game's circular arrow
        const r = s * 0.33;
        const a0 = -Math.PI * 0.72;
        const a1 = Math.PI * 0.62;
        const pts = [];
        for (let i = 0; i <= 12; i++) {
            const a = a0 + ((a1 - a0) * i) / 12;
            pts.push(`${r2(x + Math.cos(a) * r)} ${r2(y + Math.sin(a) * r)}`);
        }
        const tipX = x + Math.cos(a1) * r;
        const tipY = y + Math.sin(a1) * r;
        return (
            `<path d="M ${pts.join(" L ")}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
            arrowHead(tipX + Math.cos(a1) * s * 0.04, tipY + Math.sin(a1) * s * 0.04, s * 0.26, (a1 * 180) / Math.PI + 90)
        );
    }
    if (kind === "stack") {
        // stacker: three plates lifting, with the game's lift arrow
        const pw = s * 0.6;
        const ph = Math.max(1.2, s * 0.15);
        let plates = "";
        for (let i = 0; i < 3; i++) {
            plates += `<rect x="${r2(x - s * 0.42 - pw / 2 + s * 0.02)}" y="${r2(
                y + (i - 1) * (ph + s * 0.09) - ph / 2
            )}" width="${r2(pw)}" height="${r2(ph)}" rx="${r2(ph * 0.45)}" fill="${i === 1 ? ink : INK.mid}"/>`;
        }
        const ax = x + s * 0.32;
        return (
            plates +
            stroke(`M ${r2(ax)} ${r2(y + s * 0.34)} L ${r2(ax)} ${r2(y - s * 0.24)}`) +
            arrowHead(ax, y - s * 0.34, s * 0.22, -90)
        );
    }
    if (kind === "paint") {
        // painter: the game's loaded paint roller, plus the colour it applies
        const color = (colors && colors.find((c) => c)) || "w";
        const hex = COLOR_HEX[color] || "#d8dce6";
        const rw = s * 0.46;
        const rh = Math.max(1.6, s * 0.2);
        const rx = x - s * 0.34;
        const ry = y - s * 0.36;
        return (
            `<rect x="${r2(rx)}" y="${r2(ry)}" width="${r2(rw)}" height="${r2(rh)}" rx="${r2(rh * 0.45)}" fill="${hex}" stroke="${ink}" stroke-width="${Math.max(0.7, sw * 0.7)}"/>` +
            stroke(`M ${r2(rx + rw)} ${r2(ry + rh / 2)} L ${r2(x + s * 0.3)} ${r2(ry + rh / 2)} L ${r2(x + s * 0.3)} ${r2(y + s * 0.06)}`) +
            droplet(x - s * 0.06, y + s * 0.3, s * 0.42, hex)
        );
    }
    if (kind === "mixer") {
        // mixer: two colours merging, as in the game
        return (
            `<circle cx="${r2(x - s * 0.19)}" cy="${r2(y + s * 0.18)}" r="${r2(s * 0.21)}" fill="${INK.mid}" fill-opacity="0.5" stroke="${ink}" stroke-width="${sw}"/>` +
            `<circle cx="${r2(x + s * 0.19)}" cy="${r2(y + s * 0.18)}" r="${r2(s * 0.21)}" fill="${INK.mid}" fill-opacity="0.5" stroke="${ink}" stroke-width="${sw}"/>` +
            stroke(`M ${r2(x)} ${r2(y - s * 0.02)} L ${r2(x)} ${r2(y - s * 0.24)}`) +
            arrowHead(x, y - s * 0.36, s * 0.22, -90)
        );
    }
    if (kind === "trash") {
        // trash can: the game's lid + tapered bin
        const w = s * 0.3;
        return (
            `<rect x="${r2(x - w * 1.15)}" y="${r2(y - s * 0.34)}" width="${r2(w * 2.3)}" height="${r2(
                Math.max(1.4, s * 0.12)
            )}" rx="${r2(s * 0.04)}" fill="${ink}"/>` +
            `<path d="M ${r2(x - w * 0.85)} ${r2(y - s * 0.18)} L ${r2(x + w * 0.85)} ${r2(y - s * 0.18)} L ${r2(
                x + w * 0.55
            )} ${r2(y + s * 0.34)} L ${r2(x - w * 0.55)} ${r2(y + s * 0.34)} Z" fill="${INK.face}" stroke="${ink}" stroke-width="${sw}" stroke-linejoin="round"/>` +
            stroke(
                `M ${r2(x - w * 0.26)} ${r2(y - s * 0.1)} L ${r2(x - w * 0.18)} ${r2(y + s * 0.24)} M ${r2(
                    x + w * 0.26
                )} ${r2(y - s * 0.1)} L ${r2(x + w * 0.18)} ${r2(y + s * 0.24)}`
            )
        );
    }
    // paint4: the roller plus one droplet per rail, dotted ring for an empty rail
    const slots = colors && colors.length ? colors : [null, null, null, null];
    const step = Math.min(s * 0.4, (s * 1.1) / Math.max(1, slots.length - 1 || 1));
    const drops = [];
    slots.forEach((color, i) => {
        const cx = x + (i - (slots.length - 1) / 2) * step;
        drops.push(
            color
                ? droplet(cx, y + s * 0.16, s * 0.5, COLOR_HEX[color] || "#d8dce6")
                : `<circle cx="${r2(cx)}" cy="${r2(y + s * 0.16)}" r="${r2(s * 0.1)}" fill="none" stroke="${ink}" stroke-width="${sw * 0.7}" stroke-dasharray="${r2(s * 0.09)} ${r2(s * 0.07)}"/>`
        );
    });
    return (
        `<rect x="${r2(x - s * 0.26)}" y="${r2(y - s * 0.4)}" width="${r2(s * 0.52)}" height="${r2(
            Math.max(1.4, s * 0.16)
        )}" rx="${r2(Math.max(0.7, s * 0.07))}" fill="${INK.mid}"/>` + drops.join("")
    );
}

export function schematicSVG(layout, patches, opts = {}) {
    const pad = 40;

    // bounds over buildings + patches + hub
    let minX = layout.hub.x;
    let minY = layout.hub.y;
    let maxX = layout.hub.x + 4;
    let maxY = layout.hub.y + 4;
    const grow = (x, y, w = 1, h = 1) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
    };
    for (const b of layout.buildings) grow(b.x - 1, b.y - 1, b.w + 2, b.h + 2);
    for (const p of patches || []) {
        if (p.cells && p.cells.length) {
            for (const [x, y] of p.cells) grow(x, y);
        } else {
            grow(p.x - 2, p.y - 2, 4, 4);
        }
    }

    // pick a tile size that keeps the sheet readable
    const campaign = Array.isArray(layout.plans) && layout.plans.length > 1;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    // 18 px per tile keeps the game pictograms legible on a campaign sheet;
    // below that the icons collapse into the body plate.
    const minTile = opts.minTile ?? (campaign ? 22 : 12);
    const t = opts.tile ?? Math.max(minTile, Math.min(30, Math.floor(1150 / Math.max(spanX, spanY))));

    const width = Math.ceil((maxX - minX) * t + pad * 2);
    const height = Math.ceil((maxY - minY) * t + pad * 2);
    const px = (x) => (x - minX) * t + pad;
    const py = (y) => (y - minY) * t + pad;

    const out = [];
    out.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`
    );
    out.push(`<rect width="100%" height="100%" fill="${MAP_THEME.background}"/>`);

    // grid
    out.push(`<g stroke="#e3e8f2" stroke-width="1">`);
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
        out.push(`<line x1="${px(x)}" y1="${py(minY)}" x2="${px(x)}" y2="${py(maxY)}"/>`);
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
        out.push(`<line x1="${px(minX)}" y1="${py(y)}" x2="${px(maxX)}" y2="${py(y)}"/>`);
    }
    out.push(`</g>`);

    // Resource patches: the game paints every deposit tile with the theme
    // resource colour at half opacity, then stamps the item icon in the middle.
    // The same patch reaches us once per miner, so draw each one only once.
    const drawnPatches = [];
    {
        const seen = new Set();
        for (const p of patches || []) {
            const key = `${p.chunkX}|${p.chunkY}|${p.x.toFixed(2)}|${p.y.toFixed(2)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            drawnPatches.push(p);
        }
    }
    for (const p of drawnPatches) {
        const fill = MAP_THEME.resources[p.item.kind === "color" ? p.item.color : "shape"] || MAP_THEME.resources.shape;
        out.push(`<g fill="${fill}" fill-opacity="0.5">`);
        if (p.cells && p.cells.length) {
            for (const [x, y] of p.cells) {
                out.push(`<rect x="${px(x)}" y="${py(y)}" width="${t}" height="${t}"/>`);
            }
        } else {
            const r = Math.max(3, (p.size || 2) * 0.9) * t;
            out.push(`<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${r}"/>`);
        }
        out.push(`</g>`);
    }
    // zoomed-out overlay: one game-accurate shape icon per shape patch
    for (const p of drawnPatches) {
        if (p.item.kind !== "shape") continue;
        let shape;
        try {
            shape = parse(p.item.code);
        } catch {
            continue;
        }
        const d = Math.max(18, t * 2.6);
        out.push(
            `<g transform="translate(${px(p.x) - d / 2} ${py(p.y) - d / 2})">${shapeSVG(shape, d, { background: false })}</g>`
        );
    }

    // one framed block per factory, identified by its target shape icon
    if (campaign) {
        out.push(`<g fill="none" stroke="#aab5c9" stroke-dasharray="3 3">`);
        for (const plan of layout.plans) {
            if (!plan.bounds) continue;
            const b = plan.bounds;
            out.push(`<rect x="${px(b.x)}" y="${py(b.y)}" width="${b.w * t}" height="${b.h * t}" rx="3"/>`);
        }
        out.push(`</g>`);
        const iconSize = Math.max(20, Math.min(32, t * 2.5));
        for (const plan of layout.plans) {
            if (!plan.bounds) continue;
            const b = plan.bounds;
            let shape;
            try {
                shape = parse(plan.code);
            } catch {
                shape = null;
            }
            if (!shape) continue;
            const ix = px(b.x);
            const iy = Math.max(2, py(b.y) - iconSize - 1);
            out.push(`<g transform="translate(${ix} ${iy})">${shapeSVG(shape, iconSize)}</g>`);
            if (plan.rate) {
                out.push(
                    `<text x="${r2(ix + iconSize + 3)}" y="${r2(iy + iconSize - 2)}" font-size="10" fill="#6a7180">${formatRate(
                        plan.rate
                    )}</text>`
                );
            }
        }
    }

    // Belts first (under buildings): one solid run per link, in the grey the
    // game uses for belts on the map. Direction is read off the machine tabs
    // (socket = in, arrow = out) instead of arrowheads on every run.
    out.push(
        `<g fill="none" stroke="${INK.belt}" stroke-width="${r2(Math.max(1.5, t * 0.14))}" stroke-linecap="round" stroke-linejoin="round">`
    );
    for (const c of layout.connections) {
        const x1 = px(c.x1);
        const y1 = py(c.y1);
        const x2 = px(c.x2);
        const y2 = py(c.y2);
        const midX = (x1 + x2) / 2;
        out.push(`<path d="M ${r2(x1)} ${r2(y1)} L ${r2(midX)} ${r2(y1)} L ${r2(midX)} ${r2(y2)} L ${r2(x2)} ${r2(y2)}"/>`);
    }
    out.push(`</g>`);

    // hub: the game's red 4×4 building with its "中心" badge, above the belts
    {
        const hx = px(layout.hub.x);
        const hy = py(layout.hub.y);
        const hs = 4 * t;
        out.push(
            `<rect x="${hx}" y="${hy}" width="${hs}" height="${hs}" rx="${t * 0.3}" fill="${HUB_COLOR}" stroke="#d04a4a" stroke-width="1"/>`
        );
        const fs = Math.max(9, Math.min(16, hs * 0.28));
        const pw = fs * 2.5;
        const ph = fs * 1.6;
        out.push(
            `<rect x="${hx + hs / 2 - pw / 2}" y="${hy + hs / 2 - ph / 2}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="#ffffff"/>`
        );
        out.push(
            `<text x="${hx + hs / 2}" y="${hy + hs / 2 + fs * 0.36}" font-size="${fs}" text-anchor="middle" fill="#3a3a3a">中心</text>`
        );
    }

    // Buildings: the flat colour block the game paints in its map view, with
    // the machine's own pictogram on top, a socket on every input and an arrow
    // tab on every output.
    for (const b of layout.buildings) {
        const info = BUILDING_INFO[b.kind] || { w: 1, h: 1, zh: b.kind };
        const bx = px(b.x);
        const by = py(b.y);
        const bw = b.w * t;
        const bh = b.h * t;
        const color = KIND_COLOR[b.kind] || "#dfe3ea";
        out.push(
            `<rect x="${r2(bx)}" y="${r2(by)}" width="${r2(bw)}" height="${r2(bh)}" rx="${r2(
                t * 0.12
            )}" fill="${color}" stroke="${shade(color, 0.84)}" stroke-width="${r2(Math.max(1, t * 0.05))}"/>`
        );
        const glyph = Math.min(bw, bh) * 0.66;
        out.push(machineGlyph(b.kind, bx + bw / 2, by + bh / 2, glyph, b.colors));
        // ports: in = socket, out = arrow tab pointing away from the body.
        // The trash can takes items on all four sides, so its markers would
        // just be a ring of dots — the belt lines already show where it feeds.
        const showPorts = b.kind !== "trash";
        (showPorts ? info.ins || [] : []).forEach((port, i) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            const color = port.kind === "color" && b.colors ? b.colors[i - 1] : null;
            const ps = Math.max(2.2, t * 0.22);
            if (color) {
                out.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(ps * 0.6)}" fill="${COLOR_HEX[color] || INK.line}"/>`);
            } else {
                out.push(
                    `<rect x="${r2(x - ps / 2)}" y="${r2(y - ps / 2)}" width="${r2(ps)}" height="${r2(
                        ps
                    )}" rx="${r2(ps * 0.22)}" fill="${INK.line}"/>`
                );
            }
        });
        (showPorts ? info.outs || [] : []).forEach((port) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            const dx = port.x - b.w / 2;
            const dy = port.y - b.h / 2;
            const deg = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : -90;
            const a = (deg * Math.PI) / 180;
            out.push(arrowHead(x + Math.cos(a) * t * 0.14, y + Math.sin(a) * t * 0.14, t * 0.3, deg));
        });
    }

    // legend on its own plate: long belt runs would otherwise cross the text
    const lx = 16;
    let ly = 30;
    const legend = [];
    legend.push(`<text x="${lx}" y="${ly}" font-weight="600">图例</text>`);
    ly += 18;
    const kindsInUse = ["base", "cutHalf", "cutQuad", "rotate", "stack", "paint", "paint4", "mixer", "trash"].filter((kind) =>
        layout.buildings.some((b) => b.kind === kind)
    );
    for (const kind of kindsInUse) {
        const sample = kind === "paint4" ? ["r", "g", "b", "y"] : kind === "paint" ? ["r"] : null;
        // the same block + pictogram the drawing uses, so the legend is a key
        const color = KIND_COLOR[kind] || "#dfe3ea";
        legend.push(
            `<rect x="${lx + 1}" y="${ly - 12}" width="24" height="14" rx="2" fill="${color}" stroke="${shade(
                color,
                0.84
            )}" stroke-width="1"/>`
        );
        legend.push(machineGlyph(kind, lx + 13, ly - 5, 11, sample));
        legend.push(`<text x="${lx + 30}" y="${ly}">${esc(BUILDING_INFO[kind].zh)}</text>`);
        ly += 18;
    }
    legend.push(
        `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 16}" y2="${ly - 4}" stroke="${INK.belt}" stroke-width="5" stroke-linecap="round"/><text x="${lx + 22}" y="${ly}">传送带走向（沿线铺设）</text>`
    );
    ly += 18;
    legend.push(
        `<rect x="${lx + 1}" y="${ly - 9}" width="7" height="7" rx="1.5" fill="${INK.line}"/><text x="${lx + 22}" y="${ly}">输入口</text>`
    );
    ly += 16;
    legend.push(`${arrowHead(lx + 10, ly - 5, 9, 0)}<text x="${lx + 22}" y="${ly}">输出口</text>`);
    ly += 14;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">隧道：2 格（交叉处，从别的带下穿过）</text>`);
    ly += 12;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">平衡器：2×1（两条带并进一个口）</text>`);
    ly += 12;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">产能按游戏额定速度，升级等级 1</text>`);
    out.push(
        `<rect x="8" y="8" width="214" height="${ly + 6 - 8}" rx="8" fill="#f4f6fb" stroke="#dfe5f0"/>`
    );
    out.push(`<g font-size="12" fill="#4a4f5e">`);
    out.push(...legend);
    out.push(`</g>`);

    // title
    out.push(
        `<text x="${width - 16}" y="24" font-size="13" text-anchor="end" fill="#6a7180">tile = ${t}px · 共 ${
            layout.buildings.length
        } 个建筑${campaign ? ` · ${layout.plans.length} 种图形` : ""} · 传送带约 ${layout.beltEstimate} 格</text>`
    );

    out.push(`</svg>`);
    return out.join("");
}
