/**
 * Renders a build layout as an SVG "build sheet" (图纸):
 * resource patches, the hub, every building with its ports, and the
 * material flow between them.
 */

import { COLOR_HEX, parse } from "./shape.js";
import type { ColorChar, Shape } from "./shape.js";
import { BUILDING_INFO } from "./layout.js";
import type { BuildingKind, Connection, PlanFrame, Placement, Tile } from "./layout.js";
import type { Patch } from "./map.js";
import { shapeSVG } from "./render.js";
import { formatRate } from "./rates.js";

export interface SchematicLayout {
    hub: Tile;
    buildings: ReadonlyArray<Placement>;
    connections: ReadonlyArray<Connection>;
    beltEstimate: number;
    plans?: ReadonlyArray<PlanFrame> | null;
}

export interface SchematicOptions {
    tile?: number;
    minTile?: number;
    campaign?: boolean;
}

interface MapTheme {
    background: string;
    resources: { shape: string } & Partial<Record<ColorChar, string>>;
}

const ALL_KINDS: BuildingKind[] = [
    "base",
    "cutHalf",
    "cutQuad",
    "rotate",
    "stack",
    "paint",
    "paint4",
    "mixer",
    "trash",
];

// Values taken from the game itself so the sheet matches what the player sees:
// themes/light.json for the map layer, MetaHubBuilding for the hub.
const MAP_THEME: MapTheme = {
    background: "#eceef2",
    resources: {
        shape: "#e0e2e8",
        r: "#f3bcb6",
        g: "#cfefa0",
        b: "#b2e0fa",
    },
};
const HUB_COLOR = "#eb5555";

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function esc(text: string): string {
    return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Palette read off the game's own art (res/atlas0_hq.png) and its map view:
// building bodies are #dee1ea plates with #64666e ink; the chunk overview —
// the game's zoomed-out "thumbnail" view — paints belts in
// `themes/light.json` → `chunkOverview.beltColor` (#777).
const INK = {
    line: "#64666e",
    belt: "#777",
};

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The colour the game paints each building in its map view
 * (MetaBuilding.getSilhouetteColor) — the same blocks the player sees when
 * zoomed out, so a colour is the machine's identity on this sheet too.
 */
const KIND_COLOR: Record<string, string> = {
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
const OVERLAY: Record<string, readonly number[]> = {
    base: [1, 1, 1, 1, 0, 1, 1, 1, 1], // miner: ring around the drill hole
    trash: [1, 1, 0, 1, 1, 1, 0, 1, 1], // trash can: U with two open sides
};

/** the rotater's cut-out depends on its variant, not on its rotation here */
const ROTATER_OVERLAY: Record<string, readonly number[]> = {
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
function silhouette(
    kind: BuildingKind,
    detail: string | null | undefined,
    x: number,
    y: number,
    w: number,
    h: number
): string {
    const color = KIND_COLOR[kind] || "#dfe3ea";
    const matrix =
        kind === "rotate" ? ROTATER_OVERLAY[detail ?? "CW"] || ROTATER_OVERLAY.CW : OVERLAY[kind];
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

/** SVG path through the routed cells, with collinear runs collapsed */
function polylinePath(pts: Array<[number, number]>, x1: number, y1: number, x2: number, y2: number): string {
    const all: Array<[number, number]> = [[x1, y1], ...pts, [x2, y2]];
    const kept: Array<[number, number]> = [all[0]!];
    for (let i = 1; i < all.length; i++) {
        const b = all[i]!;
        const a = kept[kept.length - 1]!;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        if (kept.length >= 2) {
            const p = kept[kept.length - 2]!;
            if ((p[0] === a[0] && a[0] === b[0]) || (p[1] === a[1] && a[1] === b[1])) {
                kept[kept.length - 1] = b;
                continue;
            }
        }
        kept.push(b);
    }
    return kept.map(([x, y], i) => `${i ? "L" : "M"} ${r2(x)} ${r2(y)}`).join(" ");
}

export function schematicSVG(
    layout: SchematicLayout,
    patches: ReadonlyArray<Patch> | null | undefined,
    opts: SchematicOptions = {}
): string {
    const pad = 40;

    // bounds over buildings + patches + hub
    let minX = layout.hub.x;
    let minY = layout.hub.y;
    let maxX = layout.hub.x + 4;
    let maxY = layout.hub.y + 4;
    const grow = (x: number, y: number, w = 1, h = 1): void => {
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
    const plans = Array.isArray(layout.plans) ? layout.plans : [];
    const campaign = plans.length > 1;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    // 18 px per tile keeps the game pictograms legible on a campaign sheet;
    // below that the icons collapse into the body plate. The game's chunk
    // overview is 3 px per tile, so the automatic size snaps to that grid and
    // a 1/3-tile belt band lands on whole sheet pixels.
    const minTile = opts.minTile ?? (campaign ? 22 : 12);
    const autoTile = Math.max(minTile, Math.min(30, Math.floor(1150 / Math.max(spanX, spanY))));
    const t = opts.tile ?? Math.max(3, Math.round(autoTile / 3) * 3);

    const width = Math.ceil((maxX - minX) * t + pad * 2);
    const height = Math.ceil((maxY - minY) * t + pad * 2);
    const px = (x: number): number => (x - minX) * t + pad;
    const py = (y: number): number => (y - minY) * t + pad;

    const out: string[] = [];
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
    const drawnPatches: Patch[] = [];
    {
        const seen = new Set<string>();
        for (const p of patches || []) {
            const key = `${p.chunkX}|${p.chunkY}|${p.x.toFixed(2)}|${p.y.toFixed(2)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            drawnPatches.push(p);
        }
    }
    for (const p of drawnPatches) {
        const colorKey = p.item.kind === "color" ? p.item.color : null;
        const fill =
            (colorKey ? MAP_THEME.resources[colorKey] : undefined) || MAP_THEME.resources.shape;
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
        let shape: Shape;
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
        for (const plan of plans) {
            if (!plan.bounds) continue;
            const b = plan.bounds;
            out.push(`<rect x="${px(b.x)}" y="${py(b.y)}" width="${b.w * t}" height="${b.h * t}" rx="3"/>`);
        }
        out.push(`</g>`);
        const iconSize = Math.max(20, Math.min(32, t * 2.5));
        for (const plan of plans) {
            if (!plan.bounds) continue;
            const b = plan.bounds;
            let shape: Shape | null = null;
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

    // Tunnels: the chunk overview paints the sender as a blue block and the
    // receiver as a green one, each cut into the 3×3 shape
    // `getSpecialOverlayRenderMatrix` returns in
    // `ref/buildings/underground_belt.js:28-30,68-88`. Which tiles are one
    // underground run is the router's decision (`Connection.tunnelSpans`), not
    // the drawing's: a run may only be straight and span at most 5 tiles.
    const TUNNEL_SENDER = "#6d9dff";
    const TUNNEL_RECEIVER = "#71ff9c";
    // the two 3×3 matrices as tile-local (0..1) outlines; the flat bar faces
    // the other half of the tunnel
    const SENDER_BLOCK = "M 0 0 H 1 V 0.3333 H 0.6667 V 1 H 0.3333 V 0.3333 H 0 Z";
    const RECEIVER_BLOCK = "M 0 1 H 1 V 0.6667 H 0.6667 V 0 H 0.3333 V 0.6667 H 0 Z";
    /** the entity rotation that points the flat bar along the flow, as in
     *  `enumDirectionToAngle` (top=0, right=90, bottom=180, left=270) */
    const flowAngle = (vx: number, vy: number): number => (vy === -1 ? 0 : vx === 1 ? 90 : vy === 1 ? 180 : 270);
    const tunnelBlock = (cell: Tile, color: string, block: string, deg: number): string =>
        `<path d="${block}" fill="${color}" transform="translate(${r2(px(cell.x) + t / 2)} ${r2(
            py(cell.y) + t / 2
        )}) rotate(${deg}) scale(${r2(t)}) translate(-0.5 -0.5)"/>`;
    const tunnelBlocks: string[] = [];

    // Belts (under buildings): the chunk overview paints each belt tile as a
    // band of `chunkOverview.beltColor` exactly 1/3 of a tile wide —
    // square-ended, full-length into a port, elbow at a turn. Direction is read
    // off the machine tabs (socket = in, arrow = out). A tunneled tile carries
    // the belt underground, so it is not painted here; the tunnel blocks take
    // its place. A link with no legal route stays dashed red.
    out.push(
        `<g fill="none" stroke="${INK.belt}" stroke-width="${r2(t / 3)}" stroke-linecap="butt" stroke-linejoin="miter">`
    );
    for (const c of layout.connections) {
        if (!c.routed || !c.path) continue;
        const cells = c.path;
        const underground = new Set<number>();
        const ends = new Map<number, readonly [number, number]>();
        for (const span of c.tunnelSpans) {
            cells.forEach((p, i) => {
                if (span.cells.some((q) => q.x === p.x && q.y === p.y)) underground.add(i);
                if ((p.x === span.sender.x && p.y === span.sender.y) || (p.x === span.receiver.x && p.y === span.receiver.y)) {
                    ends.set(i, [span.dx, span.dy]);
                }
            });
            tunnelBlocks.push(tunnelBlock(span.sender, TUNNEL_SENDER, SENDER_BLOCK, flowAngle(span.dx, span.dy)));
            tunnelBlocks.push(tunnelBlock(span.receiver, TUNNEL_RECEIVER, RECEIVER_BLOCK, flowAngle(span.dx, span.dy)));
        }

        // belt runs: every tile that is neither underground nor a tunnel end.
        // A run stops half a tile before the tunnel end it feeds, so the band
        // meets the 3×3 block instead of showing through its holes.
        for (let i = 0; i < cells.length; i++) {
            if (underground.has(i) || ends.has(i)) continue;
            let j = i;
            while (j + 1 < cells.length && !underground.has(j + 1) && !ends.has(j + 1)) j++;
            const pts: Array<[number, number]> = [];
            if (i === 0) {
                pts.push([px(c.x1), py(c.y1)]);
            } else {
                const [dx, dy] = ends.get(i - 1)!;
                pts.push([px(cells[i]!.x + 0.5) - 0.5 * t * dx, py(cells[i]!.y + 0.5) - 0.5 * t * dy]);
            }
            for (let k = i; k <= j; k++) pts.push([px(cells[k]!.x + 0.5), py(cells[k]!.y + 0.5)]);
            if (j === cells.length - 1) {
                pts.push([px(c.x2), py(c.y2)]);
            } else {
                const [dx, dy] = ends.get(j + 1)!;
                pts.push([px(cells[j]!.x + 0.5) + 0.5 * t * dx, py(cells[j]!.y + 0.5) + 0.5 * t * dy]);
            }
            const first = pts[0]!;
            const last = pts[pts.length - 1]!;
            out.push(`<path d="${polylinePath(pts.slice(1, -1), first[0], first[1], last[0], last[1])}"/>`);
            i = j;
        }
    }
    out.push(`</g>`);
    // A link the router could not lay is not a belt. A dashed line there reads
    // as "lay a belt along this", and building that leaves a stub the game
    // refuses to accept while the machine feeding it jams on its first item —
    // so the two ports are marked instead, and nothing pretends to connect them.
    const brokenLinks = layout.connections.filter((c) => !c.routed);
    if (brokenLinks.length) {
        out.push(`<g fill="none" stroke="#d4544f" stroke-width="${r2(Math.max(1.6, t * 0.16))}" stroke-linecap="round">`);
        for (const c of brokenLinks) {
            for (const [x, y] of [
                [c.x1, c.y1],
                [c.x2, c.y2],
            ] as const) {
                const mx = px(x);
                const my = py(y);
                const r = t * 0.24;
                out.push(
                    `<path d="M ${r2(mx - r)} ${r2(my - r)} L ${r2(mx + r)} ${r2(my + r)} M ${r2(mx + r)} ${r2(
                        my - r
                    )} L ${r2(mx - r)} ${r2(my + r)}"/>`
                );
            }
        }
        out.push(`</g>`);
    }
    out.push(...tunnelBlocks);

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
    // annotation; the body itself is the game's. A turned part is drawn the way
    // the game turns it: sprite and ports rotate about the placed block's centre.
    for (const b of layout.buildings) {
        const info = BUILDING_INFO[b.kind];
        // sprite space: the part as the game defines it, centred on the placed block
        const cx = px(b.x) + (b.w * t) / 2;
        const cy = py(b.y) + (b.h * t) / 2;
        const ux = cx - (info.w * t) / 2;
        const uy = cy - (info.h * t) / 2;
        const deg = b.rot * 90;
        if (deg) out.push(`<g transform="rotate(${deg} ${r2(cx)} ${r2(cy)})">`);
        out.push(silhouette(b.kind, b.detail, ux, uy, info.w * t, info.h * t));
        // inputs: one socket per port. Outputs are left unmarked — the belt
        // band already leaves from the port, and a marker there reads as a
        // direction arrow lying on the belt. The trash can takes items on all
        // four sides, so its sockets would just be a ring of dots.
        const showPorts = b.kind !== "trash";
        (showPorts ? info.ins || [] : []).forEach((port, i) => {
            const x = ux + port.x * t;
            const y = uy + port.y * t;
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
        if (deg) out.push(`</g>`);
    }

    // legend on its own plate: long belt runs would otherwise cross the text
    const lx = 16;
    let ly = 30;
    const legend: string[] = [];
    legend.push(`<text x="${lx}" y="${ly}" font-weight="600">图例</text>`);
    ly += 18;
    const kindsInUse = ALL_KINDS.filter((kind) => layout.buildings.some((b) => b.kind === kind));
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
        `<rect x="${lx}" y="${ly - 9}" width="16" height="6" fill="${INK.belt}"/><text x="${lx + 22}" y="${ly}">传送带（1/3 格宽带）</text>`
    );
    ly += 18;
    legend.push(
        `<rect x="${lx + 1}" y="${ly - 9}" width="7" height="7" rx="1.5" fill="${INK.line}"/><text x="${lx + 22}" y="${ly}">输入口</text>`
    );
    ly += 18;
    legend.push(
        `<rect x="${lx + 1}" y="${ly - 10}" width="7" height="7" fill="${TUNNEL_SENDER}"/><rect x="${lx + 9}" y="${ly - 10}" width="7" height="7" fill="${TUNNEL_RECEIVER}"/><text x="${lx + 22}" y="${ly}">隧道：蓝=入口 绿=出口</text>`
    );
    if (brokenLinks.length) {
        ly += 12;
        legend.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#8a93a6">红色 ✕：端口没有合法走线，这条连接不存在</text>`);
    }
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
        } 个建筑${campaign ? ` · ${plans.length} 种图形` : ""} · 传送带约 ${layout.beltEstimate} 格</text>`
    );

    out.push(`</svg>`);
    return out.join("");
}
