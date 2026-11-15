/**
 * Renders a build layout as an SVG "build sheet" (图纸):
 * resource patches, the hub, every building with its ports, and the
 * material flow between them.
 */

import { COLOR_HEX, parse } from "./shape.js";
import { BUILDING_INFO } from "./layout.js";
import { shapeSVG } from "./render.js";

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

/** ink per machine family, so the icons stay readable on their tile fills */
const GLYPH_INK = {
    base: "#b8862f",
    cutHalf: "#4a6fa5",
    cutQuad: "#4a6fa5",
    rotate: "#4a6fa5",
    stack: "#4a6fa5",
    paint: "#a85f8e",
    paint4: "#a85f8e",
    mixer: "#8a7a45",
};

/** paint droplet */
function droplet(cx, cy, d, fill) {
    return `<path d="M ${cx} ${cy - d * 0.58} C ${cx + d * 0.52} ${cy - d * 0.02} ${cx + d * 0.42} ${cy + d * 0.42} ${cx} ${cy + d * 0.42} C ${cx - d * 0.42} ${cy + d * 0.42} ${cx - d * 0.52} ${cy - d * 0.02} ${cx} ${cy - d * 0.58} Z" fill="${fill}"/>`;
}

/**
 * Flat machine icon centred on (x, y) inside a box of `size` px.
 *
 * A name label is larger than the tile itself at the campaign tile sizes
 * (8–14 px), so the sheet identifies machines by shape: drill = miner, blade
 * = cutter, gear = rotator, two bars + arrow = stacker, droplet = painter.
 */
function machineGlyph(kind, x, y, size, colors) {
    const s = size;
    const ink = GLYPH_INK[kind] || "#4a6fa5";
    const sw = Math.max(1, s * 0.1);
    const box = (cx, cy, w, h, rx = s * 0.06) =>
        `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${rx}" fill="#f7fbff" stroke="${ink}" stroke-width="${sw * 0.8}"/>`;

    if (kind === "base") {
        return (
            `<path d="M ${x - s * 0.36} ${y - s * 0.34} L ${x + s * 0.36} ${y - s * 0.34} L ${x} ${y + s * 0.16} Z" fill="${ink}"/>` +
            `<rect x="${x - s * 0.42}" y="${y + s * 0.2}" width="${s * 0.84}" height="${s * 0.18}" rx="${s * 0.06}" fill="${ink}"/>`
        );
    }
    if (kind === "cutHalf") {
        return (
            box(x - s * 0.27, y, s * 0.34, s * 0.58) +
            box(x + s * 0.27, y, s * 0.34, s * 0.58) +
            `<rect x="${x - s * 0.04}" y="${y - s * 0.48}" width="${s * 0.08}" height="${s * 0.96}" rx="${s * 0.03}" fill="${ink}"/>`
        );
    }
    if (kind === "cutQuad") {
        return (
            box(x - s * 0.21, y - s * 0.21, s * 0.3, s * 0.3, s * 0.04) +
            box(x + s * 0.21, y - s * 0.21, s * 0.3, s * 0.3, s * 0.04) +
            box(x - s * 0.21, y + s * 0.21, s * 0.3, s * 0.3, s * 0.04) +
            box(x + s * 0.21, y + s * 0.21, s * 0.3, s * 0.3, s * 0.04)
        );
    }
    if (kind === "rotate") {
        const teeth = [];
        for (let i = 0; i < 6; i++) {
            const a = (i * Math.PI) / 3;
            const tx = x + Math.cos(a) * s * 0.3;
            const ty = y + Math.sin(a) * s * 0.3;
            teeth.push(
                `<rect x="${tx - s * 0.08}" y="${ty - s * 0.08}" width="${s * 0.16}" height="${s * 0.16}" rx="${s * 0.03}" fill="${ink}" transform="rotate(${i * 60} ${tx} ${ty})"/>`
            );
        }
        return `<circle cx="${x}" cy="${y}" r="${s * 0.26}" fill="#f7fbff" stroke="${ink}" stroke-width="${sw}"/>${teeth.join("")}`;
    }
    if (kind === "stack") {
        return (
            `<rect x="${x - s * 0.42}" y="${y - s * 0.42}" width="${s * 0.84}" height="${s * 0.2}" rx="${s * 0.05}" fill="${ink}" fill-opacity="0.85"/>` +
            `<rect x="${x - s * 0.42}" y="${y + s * 0.22}" width="${s * 0.84}" height="${s * 0.2}" rx="${s * 0.05}" fill="${ink}" fill-opacity="0.85"/>` +
            `<path d="M ${x} ${y - s * 0.16} L ${x} ${y + s * 0.14} M ${x - s * 0.11} ${y + s * 0.03} L ${x} ${y + s * 0.16} L ${x + s * 0.11} ${y + s * 0.03}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
        );
    }
    if (kind === "paint") {
        const color = (colors && colors.find((c) => c)) || "w";
        return droplet(x, y, s * 0.9, COLOR_HEX[color] || "#d8dce6");
    }
    if (kind === "mixer") {
        return (
            `<circle cx="${x - s * 0.2}" cy="${y + s * 0.16}" r="${s * 0.17}" fill="${ink}"/>` +
            `<circle cx="${x + s * 0.2}" cy="${y + s * 0.16}" r="${s * 0.17}" fill="${ink}"/>` +
            `<path d="M ${x} ${y + s * 0.06} L ${x} ${y - s * 0.34} M ${x - s * 0.12} ${
                y - s * 0.2
            } L ${x} ${y - s * 0.36} L ${x + s * 0.12} ${y - s * 0.2}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
        );
    }
    // paint4: one droplet per rail that has a colour, dotted ring for an empty rail
    const slots = colors && colors.length ? colors : [null, null, null, null];
    const step = s * 0.34;
    const drops = [];
    slots.forEach((color, i) => {
        const cx = x + (i - (slots.length - 1) / 2) * step;
        drops.push(
            color
                ? droplet(cx, y, s * 0.62, COLOR_HEX[color] || "#d8dce6")
                : `<circle cx="${cx}" cy="${y + s * 0.05}" r="${s * 0.11}" fill="none" stroke="${ink}" stroke-width="${sw * 0.7}" stroke-dasharray="${s * 0.1} ${s * 0.08}"/>`
        );
    });
    return drops.join("");
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
    const minTile = opts.minTile ?? (campaign ? 12 : 8);
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
        }
    }

    // connections first (under buildings)
    out.push(`<g fill="none" stroke="#4f9d68" stroke-width="2" marker-end="url(#arrow)">`);
    for (const c of layout.connections) {
        const x1 = px(c.x1);
        const y1 = py(c.y1);
        const x2 = px(c.x2);
        const y2 = py(c.y2);
        const midY = (y1 + y2) / 2;
        out.push(
            `<path d="M ${x1} ${y1} L ${(x1 + x2) / 2} ${y1} L ${(x1 + x2) / 2} ${y2} L ${x2} ${y2}"/>`
        );
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

    // buildings
    for (const b of layout.buildings) {
        const info = BUILDING_INFO[b.kind] || { w: 1, h: 1, zh: b.kind };
        const bw = b.w * t;
        const bh = b.h * t;
        const fill =
            b.kind === "base"
                ? "#f7e7c8"
                : b.kind === "paint" || b.kind === "paint4"
                ? "#f6dcec"
                : b.kind === "mixer"
                ? "#f4edda"
                : "#dbe9ff";
        const stroke =
            b.kind === "base"
                ? "#c9a24b"
                : b.kind === "paint" || b.kind === "paint4"
                ? "#c07ba4"
                : b.kind === "mixer"
                ? "#c9b77a"
                : "#6f93cc";
        out.push(
            `<rect x="${px(b.x)}" y="${py(b.y)}" width="${bw - 2}" height="${bh - 2}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
        );
        const glyph = Math.max(6, Math.min(18, Math.min(bw - 6, bh - 6) * 0.78));
        out.push(machineGlyph(b.kind, px(b.x) + bw / 2, py(b.y) + bh / 2, glyph, b.colors));
        // ports
        (info.ins || []).forEach((port, i) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            const color = port.kind === "color" && b.colors ? b.colors[i - 1] : null;
            out.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${color ? COLOR_HEX[color] || "#2f3542" : "#2f3542"}"/>`);
        });
        (info.outs || []).forEach((port) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            out.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="#4f9d68"/>`);
        });
    }

    // legend on its own plate: long belt runs would otherwise cross the text
    const lx = 16;
    let ly = 30;
    const legend = [];
    legend.push(`<text x="${lx}" y="${ly}" font-weight="600">图例</text>`);
    ly += 18;
    const kindsInUse = ["base", "cutHalf", "cutQuad", "rotate", "stack", "paint", "paint4", "mixer"].filter((kind) =>
        layout.buildings.some((b) => b.kind === kind)
    );
    for (const kind of kindsInUse) {
        const sample = kind === "paint4" ? ["r", "g", "b", "y"] : kind === "paint" ? ["r"] : null;
        legend.push(machineGlyph(kind, lx + 7, ly - 4, 14, sample));
        legend.push(`<text x="${lx + 20}" y="${ly}">${esc(BUILDING_INFO[kind].zh)}</text>`);
        ly += 16;
    }
    legend.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 12}" y2="${ly - 4}" stroke="#4f9d68" stroke-width="2"/><text x="${lx + 16}" y="${ly}">物料流向（按线铺传送带）</text>`);
    ly += 16;
    legend.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="2.6" fill="#2f3542"/><text x="${lx + 16}" y="${ly}">输入口</text>`);
    ly += 16;
    legend.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="2.6" fill="#4f9d68"/><text x="${lx + 16}" y="${ly}">输出口</text>`);
    ly += 14;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">隧道：2 格（交叉处，从别的带下穿过）</text>`);
    ly += 12;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">平衡器：2×1（两条带并进一个口）</text>`);
    out.push(
        `<rect x="8" y="8" width="214" height="${ly + 6 - 8}" rx="8" fill="#f4f6fb" fill-opacity="0.94" stroke="#dfe5f0"/>`
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

    out.push(
        `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4f9d68"/></marker></defs>`
    );
    out.push(`</svg>`);
    return out.join("");
}
