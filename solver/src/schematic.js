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

/**
 * The 3×3 sub-tile cut-out the game paints for parts whose map silhouette is
 * not a plain rectangle (`getSpecialOverlayRenderMatrix` in
 * `ref/buildings/{miner,rotater,trash}.js`). Row-major, 1 = filled with the
 * part's silhouette colour; the rest shows the ground through.
 */
const OVERLAY = {
    base: [1, 1, 1, 1, 0, 1, 1, 1, 1], // miner: ring around the drill hole
    trash: [1, 1, 0, 1, 1, 1, 0, 1, 1], // trash can: U with two open sides
};

/** the rotater's cut-out depends on its variant, not on its rotation here */
const ROTATER_OVERLAY = {
    CW: [0, 1, 1, 1, 1, 0, 0, 1, 1],
    CCW: [1, 1, 0, 0, 1, 1, 1, 1, 0],
    180: [1, 1, 0, 1, 1, 1, 0, 1, 1],
};

/**
 * The block the game draws for this part in its map view: a flat
 * silhouette-colour rectangle, cut into the part's own 3×3 shape where it has
 * one. Nothing is invented here — no pictograms, no outlines, no rounded
 * corners; the colour and the cut-out are the game's identity for the part.
 */
function silhouette(kind, detail, x, y, w, h) {
    const color = KIND_COLOR[kind] || "#dfe3ea";
    const matrix = kind === "rotate" ? ROTATER_OVERLAY[detail] || ROTATER_OVERLAY.CW : OVERLAY[kind];
    if (!matrix) {
        return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${color}"/>`;
    }
    const cw = w / 3;
    const ch = h / 3;
    let out = "";
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            if (!matrix[col + row * 3]) continue;
            out += `<rect x="${r2(x + col * cw)}" y="${r2(y + row * ch)}" width="${r2(cw + 0.4)}" height="${r2(
                ch + 0.4
            )}" fill="${color}"/>`;
        }
    }
    return out;
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

/** SVG path through the routed cells, with collinear runs collapsed */
function polylinePath(pts, x1, y1, x2, y2) {
    const all = [[x1, y1], ...pts, [x2, y2]];
    const kept = [all[0]];
    for (let i = 1; i < all.length; i++) {
        const b = all[i];
        const a = kept[kept.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        if (kept.length >= 2) {
            const p = kept[kept.length - 2];
            if ((p[0] === a[0] && a[0] === b[0]) || (p[1] === a[1] && a[1] === b[1])) {
                kept[kept.length - 1] = b;
                continue;
            }
        }
        kept.push(b);
    }
    return kept.map(([x, y], i) => `${i ? "L" : "M"} ${r2(x)} ${r2(y)}`).join(" ");
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

    // Belts first (under buildings): the exact polyline the router laid, in the
    // grey the game uses for belts on the map. Direction is read off the
    // machine tabs (socket = in, arrow = out). A link with no legal route is
    // dashed red instead of pretending a belt could go there.
    out.push(
        `<g fill="none" stroke="${INK.belt}" stroke-width="${r2(Math.max(1.5, t * 0.14))}" stroke-linecap="round" stroke-linejoin="round">`
    );
    for (const c of layout.connections) {
        if (!c.routed || !c.path) continue;
        const pts = c.path.map((p) => [px(p.x + 0.5), py(p.y + 0.5)]);
        out.push(`<path d="${polylinePath(pts, px(c.x1), py(c.y1), px(c.x2), py(c.y2))}"/>`);
    }
    out.push(`</g>`);
    out.push(
        `<g fill="none" stroke="#d4544f" stroke-width="${r2(Math.max(1.5, t * 0.14))}" stroke-dasharray="${r2(
            Math.max(4, t * 0.4)
        )} ${r2(Math.max(3, t * 0.3))}" stroke-linecap="round">`
    );
    for (const c of layout.connections) {
        if (c.routed) continue;
        const x1 = px(c.x1);
        const y1 = py(c.y1);
        const x2 = px(c.x2);
        const y2 = py(c.y2);
        const midX = (x1 + x2) / 2;
        out.push(`<path d="M ${r2(x1)} ${r2(y1)} L ${r2(midX)} ${r2(y1)} L ${r2(midX)} ${r2(y2)} L ${r2(x2)} ${r2(y2)}"/>`);
    }
    out.push(`</g>`);
    // tunnel crossings: a white notch where one belt passes under another
    for (const c of layout.connections) {
        for (const cell of c.tunnelCells || []) {
            const size = Math.max(3, t * 0.32);
            out.push(
                `<rect x="${r2(px(cell.x + 0.5) - size / 2)}" y="${r2(py(cell.y + 0.5) - size / 2)}" width="${r2(
                    size
                )}" height="${r2(size)}" rx="1" fill="#f8f9ff" stroke="${INK.belt}" stroke-width="1"/>`
            );
        }
    }

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

    // Buildings: the exact flat block the game paints in its map view
    // (silhouette colour + the part's own 3×3 cut-out), plus a socket on every
    // input and an arrow tab on every output. The ports are the sheet's own
    // annotation; the body itself is the game's.
    for (const b of layout.buildings) {
        const info = BUILDING_INFO[b.kind] || { w: 1, h: 1, zh: b.kind };
        const bx = px(b.x);
        const by = py(b.y);
        const bw = b.w * t;
        const bh = b.h * t;
        out.push(silhouette(b.kind, b.detail, bx, by, bw, bh));
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
        // the same map-view block the drawing uses, so the legend is a key
        if (OVERLAY[kind] || kind === "rotate") {
            legend.push(silhouette(kind, "CW", lx + 2, ly - 14, 13, 13));
        } else {
            legend.push(
                `<rect x="${lx + 1}" y="${ly - 13}" width="24" height="13" fill="${KIND_COLOR[kind] || "#dfe3ea"}"/>`
            );
        }
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
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">白色小方块：隧道（两条带交叉）</text>`);
    ly += 12;
    legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">红色虚线：布线失败（端口被堵住）</text>`);
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
