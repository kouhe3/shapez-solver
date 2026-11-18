/**
 * Colour supply: how much colour a campaign needs, and the chains that make it.
 *
 * A painting port pulls colour at its factory's rate; a miner or a mixer
 * carries one colour source's worth. Those two numbers decide how many
 * machines a colour needs, which is what `sizeColorSupply` answers — the same
 * sizing the CLI prints as the colour shortfall. The chains themselves are
 * grown here too: one chain per consumer port (an output port takes exactly
 * one belt), merged into a trunk at the production end when the factory may
 * share a net.
 *
 * Placing the machines and laying their belts is the placement session's job;
 * this module only decides *what* a colour port needs and hands the decision
 * over as spot + link calls.
 */

import { COLOR_NEEDS, colorChain, isMixedColor } from "./color.js";
import { BUILDING_NAMES } from "./catalogue.js";
import { BUILDING_INFO, cellKey, portApproachCells, portCells } from "./layout.js";
import { SOURCE_RATE } from "./rates.js";
import { placeExtractor } from "./spots.js";
import { mergeSources } from "./placement-links.js";
import type { ColorChar } from "./shape.js";
import type { BuildingInfo, LayoutSource, Placement, PlanTree, Tile, World } from "./layout.js";
import type { TileClaims } from "./spots.js";
import type { LinkScheduler } from "./placement-links.js";
import type { PlacementTuning } from "./placement.js";

/* ------------------------------------------------------------------ *
 * sizing: what the campaign needs
 * ------------------------------------------------------------------ */

/** items/s each colour has to produce, and how many sources that takes */
export interface ColorSupply {
    need: Map<ColorChar, number>;
    sources: Map<ColorChar, number>;
}

/**
 * How many colour sources a campaign needs, given what the painters pull.
 *
 * One source — a miner on a deposit, or one mixer — carries `SOURCE_RATE`
 * items/s. A mixed colour pushes its own inputs upstream: a mixer consumes
 * `SOURCE_RATE` of each input for every `SOURCE_RATE` it produces, and `w` is
 * built as mix(mix(r, g), b), so it consumes `y` and `b`.
 */
export function sizeColorSupply(demand: ReadonlyMap<ColorChar, number>): ColorSupply {
    const need = new Map<ColorChar, number>(demand);
    const sources = new Map<ColorChar, number>();
    const bump = (color: ColorChar, amount: number): Map<ColorChar, number> =>
        need.set(color, (need.get(color) || 0) + amount);
    const count = (amount: number): number => Math.max(0, Math.ceil(amount / SOURCE_RATE - 1e-9));

    // `w` first: it is the only colour whose chain consumes another mixed
    // colour, so its demand has to reach `y` before `y` is counted.
    for (const color of ["w", "y", "p", "c"] as const) {
        const n = count(need.get(color) || 0);
        sources.set(color, n);
        if (!n) continue;
        for (const part of color === "w" ? (["y", "b"] as const) : COLOR_NEEDS[color]!) bump(part, n * SOURCE_RATE);
    }
    for (const color of ["r", "g", "b"] as const) sources.set(color, count(need.get(color) || 0));
    return { need, sources };
}

/** one colour the drawing falls short of: how many it needs, how many it built */
export interface ColourSourceGap {
    color: ColorChar;
    need: number;
    have: number;
    kind: "混色器" | "采矿机";
}

/**
 * The colours the drawing does not carry yet. The layout builds one chain per
 * consumer port, so a colour above one source is a shortfall the sheet has to
 * report instead of pretending the rate is met.
 */
export function colourGap(supply: ColorSupply, built: ReadonlyMap<ColorChar, number>): ColourSourceGap[] {
    const gaps: ColourSourceGap[] = [];
    for (const [color, need] of supply.sources) {
        const have = built.get(color) || 0;
        if (have >= need) continue;
        gaps.push({ color, need, have, kind: isMixedColor(color) ? "混色器" : "采矿机" });
    }
    gaps.sort((a, b) => b.need - a.need);
    return gaps;
}

/* ------------------------------------------------------------------ *
 * production: the chains one factory grows
 * ------------------------------------------------------------------ */

/** spots a mixer tries before it settles for the nearest spot that only fits */
const MIXER_TRIES = 8;

/** one colour chain grown next to its consumer */
export interface BuiltColorChain {
    ok: true;
    color: ColorChar;
    building: Placement;
    info: BuildingInfo;
    outSlot: number;
    /** first base miner of the chain: where the next chain of the group grows */
    anchor?: Tile;
}

/** a colour chain that could not be built: the map lacks a deposit */
export type ColorChainOutcome = BuiltColorChain | { ok: false; color: ColorChar };

/** what the colour supply needs from the placement pass */
export interface ColourSeam {
    readonly world: World;
    /** placed parts, in placement order: chains add their machines here */
    readonly buildings: Placement[];
    /** where every resource comes from */
    readonly sources: LayoutSource[];
    /** resources the map does not have */
    readonly missing: Set<string>;
    readonly claims: TileClaims;
    readonly links: LinkScheduler;
    /** the building a plan step id resolves to */
    buildingOf(stepId: string): Placement | undefined;
}

export interface ColourSupply {
    /** one colour chain per consumer port */
    buildColorChain(color: ColorChar, anchor: Tile): ColorChainOutcome | null;
    /** one colour net for several ports of the same factory */
    buildSharedColorNet(
        color: ColorChar,
        ports: { painter: Placement; info: BuildingInfo; slot: number }[],
        anchor: Tile,
        perPort: number
    ): void;
    /** every colour port of a factory, fed the way its unlock level allows */
    supplyFactoryColours(flat: PlanTree, allowColourNet: boolean, rate?: number, allowMerge?: boolean): void;
}

export function createColourSupply(seam: ColourSeam, tuning: PlacementTuning, idPrefix: string): ColourSupply {
    const { world, claims, links } = seam;
    /** colour chains are per consumer port, so their ids need to stay unique */
    let colorSerial = 0;

    /**
     * One colour chain per consumer port.
     *
     * A machine's output port takes exactly one belt, so one chain can feed one
     * painter and no more. Parts and ground are free in shapez, so the cheap
     * legal answer is to grow the chain again next to each painter instead of
     * splitting a shared one — and before the balancer unlock (L4) splitting is
     * impossible anyway. The chain is anchored at its consumer, so belts stay short.
     */
    function buildColorChain(color: ColorChar, anchor: Tile): ColorChainOutcome | null {
        if (!color || color === "u") return null;
        // the mix tree comes from color.js, so the recipe the CLI prints and
        // the buildings placed here can never drift apart
        const built: BuiltColorChain[] = [];
        for (const op of colorChain(color)) {
            if (op.kind === "base") {
                const found = placeExtractor(claims, world, (item) => item.kind === "color" && item.color === op.color, anchor);
                if (!found) {
                    seam.missing.add(`颜色:${op.color}`);
                    return { color, ok: false };
                }
                const serial = ++colorSerial;
                const b: Placement = {
                    step: `color:${op.color}:miner#${serial}`,
                    stepId: `${idPrefix}color:${op.color}:miner#${serial}`,
                    kind: "base",
                    zh: BUILDING_NAMES.base,
                    x: found.x,
                    y: found.y,
                    w: 1,
                    h: 1,
                    rot: found.rot,
                    patch: found.patch,
                    distance: found.distance,
                    color: op.color,
                };
                seam.buildings.push(b);
                seam.sources.push({ step: null, patch: found.patch, distance: found.distance, x: found.x, y: found.y, color: op.color });
                built.push({
                    color: op.color,
                    ok: true,
                    building: b,
                    info: BUILDING_INFO.base,
                    outSlot: 0,
                    anchor: { x: found.x, y: found.y },
                });
                continue;
            }
            const left = built[op.operands[0]!];
            const right = built[op.operands[1]!];
            if (!left || !right) return { color, ok: false };
            const info = BUILDING_INFO.mixer;
            // the mixer sits between its two operand miners, not beside the
            // painter it feeds: anchoring it at the consumer made both operand
            // belts cross the map (30 of the 67 colour gaps were miner→mixer)
            // and crowded the factory; the midpoint shortens the tree and the
            // long final run is a single belt per colour port
            const midpoint = {
                x: Math.round((left.building.x + right.building.x) / 2),
                y: Math.round((left.building.y + right.building.y) / 2),
            };
            // a spot that merely fits can wall both operand belts in — that is
            // where the last miner→mixer gaps came from — so take the nearest
            // spot both operands can actually reach, and only fall back to the
            // plain nearest fit when none of them routes
            let pos: Tile | null = null;
            let tried = 0;
            for (const candidate of claims.nearFits(info, midpoint, 0)) {
                if (tried++ >= MIXER_TRIES) break;
                const claim = claims.reserve(info, candidate.x, candidate.y, 0);
                const probe: Placement = {
                    step: "",
                    stepId: "",
                    kind: "mixer",
                    zh: BUILDING_NAMES.mixer,
                    x: candidate.x,
                    y: candidate.y,
                    w: info.w,
                    h: info.h,
                    rot: 0,
                };
                const feeds = [
                    links.planLink(links.shapeLink(left.building, left.info, left.outSlot, probe, info, 0, { color: true })),
                    links.planLink(links.shapeLink(right.building, right.info, right.outSlot, probe, info, 1, { color: true })),
                ];
                // one tile holds one belt: the two operand runs may not cross
                const taken = new Set<number>();
                let clash = false;
                for (const plan of feeds) {
                    if (!plan?.path) continue;
                    for (const cell of plan.path.cells) {
                        const key = cellKey(cell.x, cell.y);
                        if (taken.has(key)) clash = true;
                        taken.add(key);
                    }
                }
                if (!clash && feeds.every((plan) => plan?.path)) {
                    pos = candidate;
                    break; // its reservation stays, the mixer goes here
                }
                claims.release(claim);
            }
            pos ??= claims.placeNear(info, midpoint, 0);
            if (!pos) {
                seam.missing.add(`颜色:${op.color}`);
                return { color, ok: false };
            }
            const serial = ++colorSerial;
            const b: Placement = {
                step: `color:${op.color}:mixer#${serial}`,
                stepId: `${idPrefix}color:${op.color}:mixer#${serial}`,
                kind: "mixer",
                zh: BUILDING_NAMES.mixer,
                x: pos.x,
                y: pos.y,
                w: info.w,
                h: info.h,
                rot: 0,
                detail: `${left.color}+${right.color}`,
                color: op.color,
                colors: [left.color, right.color],
            };
            seam.buildings.push(b);
            links.layLink(links.shapeLink(left.building, left.info, left.outSlot, b, info, 0, { color: true }));
            links.layLink(links.shapeLink(right.building, right.info, right.outSlot, b, info, 1, { color: true }));
            built.push({ color: op.color, ok: true, building: b, info, outSlot: 0, anchor: left.anchor });
        }
        return built.at(-1) || { color, ok: false };
    }

    /**
     * One colour net for several ports of the same factory.
     *
     * A chain delivers 0.4 items/s, exactly one port's demand, so the group
     * still grows one chain per port. The chains are grown at the *same*
     * production point (the first one's output), merged pairwise into one
     * trunk, and split back into one belt per port inside the block. That is
     * where the belts are saved: k long runs become one long trunk plus short
     * merge/split links.
     */
    function buildSharedColorNet(
        color: ColorChar,
        ports: { painter: Placement; info: BuildingInfo; slot: number }[],
        anchor: Tile,
        perPort: number
    ): void {
        const chains: BuiltColorChain[] = [];
        let production = anchor;
        for (let p = 0; p < ports.length; p++) {
            for (let i = 0; i < perPort; i++) {
                const chain = buildColorChain(color, production);
                if (!chain || !chain.ok) {
                    seam.missing.add(`颜色:${color}`);
                    return;
                }
                chains.push(chain);
                // the old net built every chain at the first chain's production
                // point; advancing the anchor each time moved the whole colour
                // cluster and changed the factory's belts around it
                if (chains.length === 1) production = chain.anchor ?? production;
            }
        }

        // pairwise merge, nearest the production cluster. A port that pulls
        // more than one source needs several chains joined into one belt.
        const merged = mergeSources(
            claims,
            links,
            chains.map((c) => ({ building: c.building, info: c.info, outSlot: c.outSlot })),
            () => ({ step: `merger:${color}#${++colorSerial}`, stepId: `${idPrefix}merger:${color}#${colorSerial}` }),
            seam.buildings
        );
        if (merged.merged < chains.length) {
            seam.missing.add(`颜色:${color}`);
            return;
        }

        // one splitter per extra port: out0 feeds a port, out1 passes the trunk on
        let prev = merged.root;
        const lastPort = ports.at(-1)!;
        for (const port of ports.slice(0, -1)) {
            const info = BUILDING_INFO.splitter;
            // sit two tiles outside the port and face the outlet at it, so the
            // last run is a two-tile belt instead of a lap around the block
            const cells = portCells(port.info, port.painter.x, port.painter.y, port.painter.rot);
            const approaches = portApproachCells(port.info, port.painter.x, port.painter.y, port.painter.rot);
            const portCell = cells[port.slot]!;
            const approach = approaches[port.slot]!;
            const out = { x: Math.sign(approach.x - portCell.x), y: Math.sign(approach.y - portCell.y) };
            const spotAnchor = { x: approach.x + out.x, y: approach.y + out.y };
            // out0 has to point back at the port: north/south/east/west = 0/2/3/1
            const rot: 0 | 1 | 2 | 3 = out.y === 1 ? 0 : out.y === -1 ? 2 : out.x === 1 ? 3 : 1;
            const spot = claims.placeNear(info, spotAnchor, rot);
            if (!spot) return;
            const splitter: Placement = {
                step: `splitter:${color}#${++colorSerial}`,
                stepId: `${idPrefix}splitter:${color}#${colorSerial}`,
                kind: "splitter",
                zh: BUILDING_NAMES.splitter,
                x: spot.x,
                y: spot.y,
                w: 1,
                h: 1,
                rot,
            };
            seam.buildings.push(splitter);
            if (!links.layLink(links.shapeLink(prev.building, prev.info, prev.outSlot, splitter, info, 0, { color: true }))) return;
            links.layLink(links.shapeLink(splitter, info, 0, port.painter, port.info, port.slot, { color: true }));
            prev = { building: splitter, info, outSlot: 1 };
        }
        links.layLink(links.shapeLink(prev.building, prev.info, prev.outSlot, lastPort.painter, lastPort.info, lastPort.slot, { color: true }));
    }

    /**
     * One port's colour, as many chains as the port pulls and one belt in.
     * A port outruns a chain above 0.4 items/s (a quad painter at 1/s pulls
     * three), so the chains are built side by side and merged; without the
     * merger part the port keeps one chain and stays the factory's limit.
     */
    function feedPort(
        color: ColorChar,
        port: { painter: Placement; info: BuildingInfo; slot: number },
        perPort: number,
        anchor: Tile
    ): Tile | null {
        const chains: BuiltColorChain[] = [];
        let production = anchor;
        for (let i = 0; i < perPort; i++) {
            const chain = buildColorChain(color, production);
            if (!chain || !chain.ok) {
                seam.missing.add(`颜色:${color}`);
                return null;
            }
            chains.push(chain);
            production = chain.anchor ?? production;
        }
        const root =
            chains.length === 1
                ? chains[0]!
                : (() => {
                      const merged = mergeSources(
                          claims,
                          links,
                          chains.map((c) => ({ building: c.building, info: c.info, outSlot: c.outSlot })),
                          () => ({ step: `merger:${color}#${++colorSerial}`, stepId: `${idPrefix}merger:${color}#${colorSerial}` }),
                          seam.buildings
                      );
                      if (merged.merged < chains.length) {
                          seam.missing.add(`颜色:${color}`);
                          return null;
                      }
                      return merged.root;
                  })();
        if (!root) return null;
        if (
            !links.layLink(
                links.shapeLink(root.building, root.info, root.outSlot, port.painter, port.info, port.slot, { color: true })
            )
        ) {
            return null;
        }
        return chains.at(-1)?.anchor ?? production;
    }

    /**
     * Every colour port of one factory, fed the way its unlock level allows.
     *
     * A port pulls the factory's own rate, so a quad painter at 1/s needs three
     * chains; `perPort` counts them. Ports of the same colour share a trunk only
     * when a splitter can fan it back out (L20); a chain group is sized by the
     * belt, not by a fixed port count.
     */
    function supplyFactoryColours(flat: PlanTree, allowColourNet: boolean, rate: number = 0, allowMerge: boolean = false): void {
        const perPort = allowMerge ? Math.max(1, Math.ceil(rate / SOURCE_RATE - 1e-9)) : 1;
        const groupSize = Math.max(1, Math.floor(tuning.colorGroupSize / perPort));
        const colourPorts = new Map<ColorChar, { painter: Placement; info: BuildingInfo; slot: number }[]>();
        for (const step of flat.steps) {
            const node = step.node;
            if (node.op !== "paint" && node.op !== "paint4") continue;
            const painter = seam.buildingOf(step.id);
            if (!painter) continue;
            const info = BUILDING_INFO[step.op];
            const colors: readonly (ColorChar | null)[] = node.op === "paint4" ? node.colors : [node.color];
            colors.forEach((color, i) => {
                if (!color || color === "u") return;
                const list = colourPorts.get(color) ?? [];
                list.push({ painter, info, slot: i + 1 });
                colourPorts.set(color, list);
            });
        }
        for (const [color, ports] of colourPorts) {
            // a belt carries 2 items/s and one chain 0.4, so a trunk takes five
            // chains — fewer ports when each port already needs several
            for (let start = 0; start < ports.length; start += groupSize) {
                const chunk = ports.slice(start, start + groupSize);
                const head = chunk[0]!;
                const anchor = { x: head.painter.x + head.info.w + 3, y: head.painter.y };
                if (chunk.length < 2 || !allowColourNet) {
                    // One chain group per port: a chain carries exactly one port's
                    // 0.4/s and one output port takes one belt, so two ports of the
                    // same colour need two groups — building one and linking only
                    // the head would leave the second port with no colour at all.
                    // Before the L20 splitter the merge cannot fan a trunk back
                    // out, so this is also the early-level path for k ≥ 2.
                    let production = anchor;
                    for (const port of chunk) {
                        const next = feedPort(color, port, perPort, production);
                        if (!next) break;
                        production = next;
                    }
                    continue;
                }
                buildSharedColorNet(color, chunk, anchor, perPort);
            }
        }
    }

    return { buildColorChain, buildSharedColorNet, supplyFactoryColours };
}
