/**
 * Renders a build layout as an SVG "build sheet" (图纸):
 * resource patches, the hub, every building with its ports, and the
 * material flow between them.
 */

import { COLOR_HEX, TYPE_NAMES_ZH } from "./shape.js";
import { BUILDING_INFO } from "./layout.js";

const COLORS_ZH_MAP = {
    r: "红",
    g: "绿",
    b: "蓝",
    y: "黄",
    p: "紫",
    c: "青",
    w: "白",
};

function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
    for (const p of patches || []) grow(p.x - 2, p.y - 2, 4, 4);

    // pick a tile size that keeps the sheet readable
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const t =
        opts.tile ??
        Math.max(8, Math.min(30, Math.floor(1150 / Math.max(spanX, spanY))));

    const width = Math.ceil((maxX - minX) * t + pad * 2);
    const height = Math.ceil((maxY - minY) * t + pad * 2);
    const px = (x) => (x - minX) * t + pad;
    const py = (y) => (y - minY) * t + pad;

    const out = [];
    out.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`
    );
    out.push(`<rect width="100%" height="100%" fill="#f4f6fb"/>`);

    // grid
    out.push(`<g stroke="#e3e8f2" stroke-width="1">`);
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
        out.push(`<line x1="${px(x)}" y1="${py(minY)}" x2="${px(x)}" y2="${py(maxY)}"/>`);
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
        out.push(`<line x1="${px(minX)}" y1="${py(y)}" x2="${px(maxX)}" y2="${py(y)}"/>`);
    }
    out.push(`</g>`);

    // resource patches
    if (patches) {
        for (const p of patches) {
            const isColor = p.item.kind === "color";
            const fill = isColor ? COLOR_HEX[p.item.color] || "#ccc" : "#d7dce8";
            const stroke = isColor ? "rgba(0,0,0,.25)" : "#aab2c4";
            const r = Math.max(3, (p.size || 2) * 0.9) * t;
            out.push(
                `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${r}" fill="${fill}" fill-opacity="0.55" stroke="${stroke}" stroke-dasharray="4 3"/>`
            );
            const label = isColor
                ? `${COLORS_ZH_MAP[p.item.color] || p.item.color}色`
                : `${TYPE_NAMES_ZH[p.item.code[0]] || p.item.code[0]}×4`;
            out.push(
                `<text x="${px(p.x)}" y="${py(p.y) + 4}" font-size="11" text-anchor="middle" fill="#4a4f5e">${esc(label)}</text>`
            );
        }
    }

    // hub
    out.push(
        `<rect x="${px(layout.hub.x)}" y="${py(layout.hub.y)}" width="${4 * t}" height="${4 * t}" rx="6" fill="#cfd6e4" stroke="#8b94a8"/>`
    );
    out.push(
        `<text x="${px(layout.hub.x + 2)}" y="${py(layout.hub.y + 2) + 5}" font-size="14" font-weight="600" text-anchor="middle" fill="#39404f">HUB</text>`
    );

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

    // buildings
    for (const b of layout.buildings) {
        const info = BUILDING_INFO[b.kind] || { w: 1, h: 1, zh: b.kind };
        const bw = b.w * t;
        const bh = b.h * t;
        const fill = b.kind === "base" ? "#f7e7c8" : b.kind === "paint" || b.kind === "paint4" ? "#f6dcec" : "#dbe9ff";
        const stroke = b.kind === "base" ? "#c9a24b" : b.kind === "paint" || b.kind === "paint4" ? "#c07ba4" : "#6f93cc";
        out.push(
            `<rect x="${px(b.x)}" y="${py(b.y)}" width="${bw - 2}" height="${bh - 2}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
        );
        out.push(
            `<text x="${px(b.x) + 4}" y="${py(b.y) + bh / 2 + 3}" font-size="10" fill="#2f3542">${esc(b.zh)}</text>`
        );
        // ports
        (info.ins || []).forEach((port, i) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            out.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="#2f3542"/>`);
            if (port.kind === "color") {
                const color = b.colors ? b.colors[i - 1] : null;
                if (color) {
                    out.push(
                        `<text x="${x}" y="${port.y === 0 ? y + 9 : y - 4}" font-size="9" text-anchor="middle" fill="${
                            COLOR_HEX[color] || "#4a4f5e"
                        }" stroke="#ffffff" stroke-width="2.5" paint-order="stroke">${esc(
                            COLORS_ZH_MAP[color] || color
                        )}</text>`
                    );
                }
            }
        });
        (info.outs || []).forEach((port, i) => {
            const x = px(b.x + port.x);
            const y = py(b.y + port.y);
            out.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="#4f9d68"/>`);
            if (info.outs.length > 1) {
                out.push(`<text x="${x + 5}" y="${y - 3}" font-size="8" fill="#3f7f55">#${i}</text>`);
            }
        });
        out.push(
            `<text x="${px(b.x) + 4}" y="${py(b.y) + bh - 4}" font-size="8" fill="#6a7180">${esc(b.stepId)}</text>`
        );
    }

    // legend
    const lx = 16;
    let ly = 22;
    out.push(`<g font-size="12" fill="#4a4f5e">`);
    out.push(`<text x="${lx}" y="${ly}" font-weight="600">图例</text>`);
    ly += 18;
    out.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="4" fill="#f7e7c8" stroke="#c9a24b"/><text x="${lx + 16}" y="${ly}">采矿机（落在矿脉上）</text>`);
    ly += 16;
    out.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="4" fill="#dbe9ff" stroke="#6f93cc"/><text x="${lx + 16}" y="${ly}">加工建筑</text>`);
    ly += 16;
    out.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="4" fill="#f6dcec" stroke="#c07ba4"/><text x="${lx + 16}" y="${ly}">上色器</text>`);
    ly += 16;
    out.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 12}" y2="${ly - 4}" stroke="#4f9d68" stroke-width="2"/><text x="${lx + 16}" y="${ly}">物料流向（按线铺传送带）</text>`);
    ly += 16;
    out.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="2.6" fill="#2f3542"/><text x="${lx + 16}" y="${ly}">输入口</text>`);
    ly += 16;
    out.push(`<circle cx="${lx + 5}" cy="${ly - 4}" r="2.6" fill="#4f9d68"/><text x="${lx + 16}" y="${ly}">输出口</text>`);
    out.push(`</g>`);

    // title
    out.push(
        `<text x="${width - 16}" y="24" font-size="13" text-anchor="end" fill="#6a7180">tile = ${t}px · 共 ${layout.buildings.length} 个建筑 · 传送带约 ${layout.beltEstimate} 格</text>`
    );

    out.push(
        `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4f9d68"/></marker></defs>`
    );
    out.push(`</svg>`);
    return out.join("");
}
