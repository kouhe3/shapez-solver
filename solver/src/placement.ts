/**
 * Turns a solved plan into a buildable layout ("图纸"):
 *
 *  - picks a real resource patch for every extractor (shape + color),
 *  - places the processing buildings on a tile grid next to the hub,
 *  - computes the exact port positions from the game's building definitions,
 *  - emits connections (what feeds what) + belt-length estimates + BOM.
 *
 * The tile world itself — geometry, ports, world state and the router — lives
 * in `layout.ts`. This module is the session that composes the three seams a
 * factory layout needs and the choreography that drives them:
 *
 *  - `spots.ts` decides where parts may stand and what the router may cross,
 *  - `placement-links.ts` turns port pairs into belts, gaps and rip-up,
 *  - `color-supply.ts` sizes the colour demand and grows the chains.
 *
 * Port coordinates are in tile units relative to the building's top-left tile;
 * y grows downwards (screen/tile space, same as the game).
 */

import * as P from "./plan.js";
import { BUILDING_NAMES } from "./catalogue.js";
import { COLOR_NEEDS } from "./color.js";
import type { ColorChar } from "./shape.js";
import type { Patch } from "./map.js";
import {
    BUILDING_INFO,
    cellKey,
    createWorld,
    expandPlanTree,
    fuseCuts,
    outputSlot,
    portApproachCells,
    portCells,
    rotatedSize,
} from "./layout.js";
import type { BomEntry, BuildingInfo, Connection, LayoutColor, LayoutSource, Placement, PlanTree, Rot, RoutingGap, Tile, World } from "./layout.js";
import { allocateBlock, createTileClaims, factoryAnchor, placeExtractor } from "./spots.js";
import type { TileClaims } from "./spots.js";
import { createLinkScheduler } from "./placement-links.js";
import type { LinkPlan, LinkScheduler, MergeSource, QueuedLink } from "./placement-links.js";
import { createColourSupply } from "./color-supply.js";
import { buildOutpost } from "./supply.js";
import type { ColourSupply } from "./color-supply.js";
import { factoryRate, minerCount } from "./rates.js";
import { MINER_RATE } from "./rates.js";

/* ------------------------------------------------------------------ *
 * tuning
 * ------------------------------------------------------------------ */

/**
 * The knobs the placement pass reads. Every default is the value the solver
 * ships with; `buildLayout` merges a caller's overrides over them, so a test
 * can widen a search box without touching anything else.
 */
export interface PlacementTuning {
    /**
     * Spots tried per part before it is dropped at the first spot that fits.
     * Each try is a full route search per input, so this is a search budget:
     * the first spot almost always routes, and a part that needs a turn finds
     * one within a row or two.
     */
    maxTries: number;
    /** smallest search box around a short link, in tiles */
    nearMarginFloor: number;
    /** largest search box around a short link, in tiles */
    nearMargin: number;
    /** second box a long link is searched in, in tiles */
    wideMargin: number;
    /** free row and column kept inside a factory window for belts */
    corridor: number;
    /** tiles between two machines of one row */
    machineGap: number;
    /** tiles between two factory windows */
    blockGap: number;
    /** rip-up rounds after the first build */
    ripRounds: number;
    /** belts one failed link may rip per round */
    ripPerRound: number;
    /** colour ports one shared colour net fans a trunk out to */
    colorGroupSize: number;
}

export const DEFAULT_TUNING: PlacementTuning = {
    maxTries: 4,
    nearMarginFloor: 8,
    nearMargin: 20,
    wideMargin: 60,
    corridor: 2,
    machineGap: 2,
    blockGap: 4,
    ripRounds: 5,
    ripPerRound: 3,
    colorGroupSize: 5,
};

/* ------------------------------------------------------------------ *
 * the placement session
 * ------------------------------------------------------------------ */

/** what `createPlacementSession` needs to know */
export interface PlacementArgs {
    world: World;
    hub: Tile;
    /** the flat plan's steps by id, for `hubLinkOf` */
    stepById: ReadonlyMap<string, P.PlanStep>;
    allowTunnels?: boolean;
    /** partial overrides merged over `DEFAULT_TUNING` */
    tuning?: Partial<PlacementTuning>;
    /** namespaces the synthetic ids the colour chains hand out */
    idPrefix?: string;
    /** classic mode: a hub entry holds 5 legs, not 2 items/s */
    legacyHub?: boolean;
}

/** one branch of a splitter that stands in for a shared output port */
export interface FanoutSource {
    building: Placement;
    info: BuildingInfo;
    outSlot: number;
}

/**
 * Everything one plan needs while it is being laid out: the parts placed, the
 * links between them, the colour supply and the tile claims behind all three.
 * `buildLayout`'s choreography and a test drive the same state, and each seam
 * owns its own bookkeeping.
 */
export interface PlacementSession {
    /** the resolved knobs; the choreography reads `corridor`, `machineGap`, … */
    readonly tuning: PlacementTuning;
    /** the parts placed so far, in placement order (the drawing and BOM order) */
    readonly buildings: Placement[];
    /** where every resource comes from */
    readonly sources: LayoutSource[];
    /** resources the map does not have */
    readonly missing: Set<string>;
    /** where parts may stand and what the router may cross */
    readonly claims: TileClaims;
    /** the links laid so far, their gaps and the rip-up pass */
    readonly links: LinkScheduler;
    /** colour demand and the chains that meet it */
    readonly colour: ColourSupply;
    /** name the building a plan step id resolves to */
    bind(stepId: string, placement: Placement): void;
    buildingOf(stepId: string): Placement | undefined;
    /** every link a step's inputs need, against the placement being tried */
    inputLinks(step: P.PlanStep, placement: Placement, info: BuildingInfo): QueuedLink[];
    /** the product of the plan's root, belted into the hub */
    hubLinkOf(src: Placement, rate: number): QueuedLink;
    /** the branch a fused source's consumer reads instead of the shared port */
    readonly fanout: Map<string, FanoutSource>;
    /** after a fused source is placed, put the splitter chain its fan-out needs */
    wireFanout(stepId: string, placement: Placement, info: BuildingInfo): void;
}

export function createPlacementSession({
    world,
    hub,
    stepById,
    allowTunnels = true,
    tuning: overrides = {},
    idPrefix = "",
    legacyHub = false,
}: PlacementArgs): PlacementSession {
    const tuning: PlacementTuning = { ...DEFAULT_TUNING, ...overrides };
    const claims = createTileClaims(world);
    const links = createLinkScheduler({ world, hub, tuning, allowTunnels, legacyHub });

    const buildings: Placement[] = [];
    const sources: LayoutSource[] = [];
    const missing = new Set<string>();
    /** placed parts, by plan step id; links resolve their two ends through it */
    const buildingByStep = new Map<string, Placement>();

    function bind(stepId: string, placement: Placement): void {
        buildingByStep.set(stepId, placement);
    }

    function buildingOf(stepId: string): Placement | undefined {
        return buildingByStep.get(stepId);
    }

    const colour = createColourSupply({ world, buildings, sources, missing, claims, links, buildingOf }, tuning, idPrefix);

    // a fused group can leave two consumers on one output port (the copy bug);
    // a splitter is the legal drop back to one belt, at half the branch rate
    interface FanoutEdge {
        stepId: string;
        inputIndex: number;
    }
    interface FanoutGroup {
        repId: string;
        outSlot: number;
        edges: FanoutEdge[];
    }
    const fanout = new Map<string, FanoutSource>();
    const fanoutGroups = new Map<string, FanoutGroup[]>();
    {
        const byKey = new Map<string, FanoutGroup>();
        for (const step of stepById.values()) {
            // a fused member is not a second consumer: it is another output
            // slot of its rep, and only the rep's own inputs are belted
            if (step.fuseInto) continue;
            step.inputs.forEach((input, i) => {
                const src = stepById.get(input.id);
                if (!src) return;
                const repId = src.fuseInto ?? src.id;
                const outSlot = outputSlot(src);
                const key = `${repId}|${outSlot}`;
                const group = byKey.get(key) ?? { repId, outSlot, edges: [] };
                group.edges.push({ stepId: step.id, inputIndex: i });
                byKey.set(key, group);
            });
        }
        for (const group of byKey.values()) {
            if (group.edges.length < 2) continue;
            const list = fanoutGroups.get(group.repId) ?? [];
            list.push(group);
            fanoutGroups.set(group.repId, list);
        }
    }

    /** one splitter in front of a feed: its input faces the feed's output */
    function placeSplitter(stepId: string, outSlot: number, serial: number, feed: FanoutSource, info: BuildingInfo): Placement | null {
        const approaches = portApproachCells(feed.info, feed.building.x, feed.building.y, feed.building.rot);
        const cells = portCells(feed.info, feed.building.x, feed.building.y, feed.building.rot);
        const index = feed.info.ins.length + feed.outSlot;
        const portCell = cells[index];
        const approach = approaches[index];
        if (!portCell || !approach) return null;
        const dx = Math.sign(approach.x - portCell.x);
        const dy = Math.sign(approach.y - portCell.y);
        const rot: Rot = -dy === 1 ? 0 : -dy === -1 ? 2 : -dx === -1 ? 1 : 3;
        const anchor = { x: approach.x + dx, y: approach.y + dy };
        const splitterAt = (x: number, y: number): Placement => ({
            step: `fanout:${stepId}:${outSlot}#${serial + 1}`,
            stepId: `${idPrefix}fanout:${stepId}:${outSlot}#${serial + 1}`,
            kind: "splitter",
            zh: BUILDING_NAMES.splitter,
            x,
            y,
            w: 1,
            h: 1,
            rot,
        });
        // the aligned spot would share its input approach with the feed, which
        // the generic fit test rejects (the pair's one belt tile is both sides'
        // approach); the nearest free off-axis spot routes with a bend instead.
        // A splitter is no good if its one belt cannot reach, so try a short
        // list rather than every free tile on the map.
        let tries = 0;
        for (const spot of claims.nearFits(info, anchor, rot)) {
            if (tries++ >= 64) break;
            // a splitter whose output approach is a dead end can never feed its
            // consumer; the fit test cannot see past the approach itself
            const sides = portApproachCells(info, spot.x, spot.y, rot);
            const deadEnd = sides.slice(1).some((side) => {
                const open = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => {
                    if (spot.x === side.x + dx && spot.y === side.y + dy) return false;
                    const key = cellKey(side.x + dx, side.y + dy);
                    return !world.walls.has(key) && !world.occupied.has(key) && !world.belts.has(key);
                });
                return !open;
            });
            if (deadEnd) continue;
            const claim = claims.reserve(info, spot.x, spot.y, rot);
            const splitter = splitterAt(spot.x, spot.y);
            const q = links.shapeLink(feed.building, feed.info, feed.outSlot, splitter, info, 0);
            const plan = links.planLink(q);
            if (plan?.path && links.commitLink(plan, q)) return splitter;
            claims.release(claim);
        }
        return null;
    }

    function wireFanout(stepId: string, placement: Placement, info: BuildingInfo): void {
        const groups = fanoutGroups.get(stepId);
        if (!groups) return;
        const splitterInfo = BUILDING_INFO.splitter;
        for (const group of groups) {
            let feed: FanoutSource = { building: placement, info, outSlot: group.outSlot };
            const chain: Placement[] = [];
            let ok = true;
            for (let j = 0; j < group.edges.length - 1; j++) {
                const splitter = placeSplitter(stepId, group.outSlot, j, feed, splitterInfo);
                if (!splitter) {
                    ok = false;
                    break;
                }
                buildings.push(splitter);
                chain.push(splitter);
                feed = { building: splitter, info: splitterInfo, outSlot: 1 };
            }
            if (!ok) continue;
            for (let j = 0; j < chain.length; j++) {
                const edge = group.edges[j]!;
                fanout.set(`${edge.stepId}:${edge.inputIndex}`, { building: chain[j]!, info: splitterInfo, outSlot: 0 });
            }
            const last = group.edges[group.edges.length - 1]!;
            fanout.set(`${last.stepId}:${last.inputIndex}`, { building: chain[chain.length - 1]!, info: splitterInfo, outSlot: 1 });
        }
    }

    /** every link a step's inputs need, against the placement being tried */
    function inputLinks(step: P.PlanStep, placement: Placement, info: BuildingInfo): QueuedLink[] {
        const out: QueuedLink[] = [];
        step.inputs.forEach((input, i) => {
            const branch = fanout.get(`${step.id}:${i}`);
            if (branch) {
                out.push(links.shapeLink(branch.building, branch.info, branch.outSlot, placement, info, i));
                return;
            }
            const src = buildingByStep.get(input.id);
            if (!src || !info.ins[i]) return;
            out.push(links.shapeLink(src, BUILDING_INFO[src.kind], outputSlot(stepById.get(input.id)), placement, info, i));
        });
        return out;
    }

    /** the product of the plan's root, belted into the hub */
    function hubLinkOf(src: Placement, rate: number): QueuedLink {
        return {
            toHub: true,
            srcBuilding: src,
            srcInfo: BUILDING_INFO[src.kind],
            outSlot: outputSlot(stepById.get(src.step)),
            dstBuilding: null,
            dstInfo: null,
            inSlot: null,
            extra: { rate: legacyHub ? 1 : rate },
        };
    }

    return { tuning, buildings, sources, missing, claims, links, colour, bind, buildingOf, inputLinks, hubLinkOf, fanout, wireFanout };
}

/* ------------------------------------------------------------------ *
 * what a layout reports
 * ------------------------------------------------------------------ */

/** what `buildLayout` reports */
export interface Layout {
    hub: Tile;
    buildings: Placement[];
    connections: Connection[];
    sources: LayoutSource[];
    colors: LayoutColor[];
    /** resources the map does not have */
    missing: string[];
    routingGaps: RoutingGap[];
    /** belt cells the drawing needs, tunnels counted twice */
    beltEstimate: number;
    bom: BomEntry[];
    steps: P.PlanStep[];
    /** items/s this factory delivers once its miners are sized */
    rate: number;
}

/** what `buildLayout` takes */
export interface BuildLayoutArgs {
    /** plan AST root */
    plan: P.PlanNode;
    /** map deposits (`map.js`) */
    patches: Patch[];
    /** hub tile origin */
    hub?: Tile;
    blockWidth?: number;
    blockHeight?: number;
    /** shared placement state; omit for a one-off layout */
    world?: World | null;
    /** namespaces step ids when several plans share a world */
    idPrefix?: string;
    /** may a belt cross another one (tunnel unlocked)? Before L6 every crossing is illegal */
    allowTunnels?: boolean;
    /** may colour ports of one factory share a net (splitter unlocked, L20)? */
    allowColourNet?: boolean;
    /** may several miners be joined into one belt (merger unlocked, L10)? */
    allowMerge?: boolean;
    /** classic mode: a hub entry holds 5 legs, not 2 items/s */
    legacyHub?: boolean;
    /** placement knobs; anything left out keeps its `DEFAULT_TUNING` value */
    tuning?: Partial<PlacementTuning>;
}

export function buildLayout({
    plan,
    patches,
    hub = { x: -2, y: -2 },
    blockWidth = 26,
    blockHeight = 12,
    world = null,
    idPrefix = "",
    allowTunnels = true,
    allowColourNet = false,
    allowMerge = false,
    legacyHub = false,
    tuning: tuningOverrides = {},
}: BuildLayoutArgs): Layout {
    const shared = world || createWorld({ hub, patches });
    // one output port = one belt, so shared sub-plans get their own copy
    const flat = expandPlanTree(fuseCuts(P.flatten(plan)));
    // a miner is not a cap: it can be duplicated up to one belt. Without the
    // merger part there is no way to join them, so the miner rate still binds.
    const targetRate = factoryRate(flat.steps, allowMerge);
    // dependency depth
    const depth = new Map<string, number>();
    const stepById = new Map<string, P.PlanStep>(flat.steps.map((s): [string, P.PlanStep] => [s.id, s]));
    for (const step of flat.steps) {
        let d = 0;
        for (const input of step.inputs) d = Math.max(d, (depth.get(input.id) || 0) + 1);
        depth.set(step.id, d);
    }
    // every part and belt of this factory goes through the session
    const session = createPlacementSession({
        world: shared,
        hub,
        stepById,
        allowTunnels,
        idPrefix,
        tuning: tuningOverrides,
        legacyHub,
    });
    const { tuning, claims, links, colour } = session;
    /** fused cutters: alias step id → the rep's id (and back) */
    const aliasOf = new Map<string, string[]>();
    for (const step of flat.steps) {
        if (!step.fuseInto) continue;
        const list = aliasOf.get(step.fuseInto) || [];
        list.push(step.id);
        aliasOf.set(step.fuseInto, list);
    }
    /** how many belts a step's product feeds; a fused group's shared input counts once per building */
    const consumersOf = new Map<string, number>();
    for (const step of flat.steps) {
        for (const input of step.inputs) consumersOf.set(input.id, (consumersOf.get(input.id) || 0) + 1);
    }

    const paintColorsUsed = new Set<ColorChar>();
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op === "paint") paintColorsUsed.add(node.color);
        else if (node.op === "paint4") for (const c of node.colors) if (c && c !== "u") paintColorsUsed.add(c);
    }

    // rows of processors, grouped by depth; the reserved window has to be tall
    // enough for every row plus the corridor row between them
    const packWidth = blockWidth - tuning.corridor;
    const byDepth = new Map<number, P.PlanStep[]>();
    for (const step of flat.steps) {
        if (step.op === "base") continue;
        const d = depth.get(step.id) || 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d)!.push(step);
    }
    let extraRows = 0;
    for (const steps of byDepth.values()) {
        let width = 0;
        // two tiles between machines: adjacent ports would share one tile
        for (const step of steps) width += (BUILDING_INFO[step.op]?.w || 1) + tuning.machineGap;
        extraRows += Math.max(0, Math.ceil(width / packWidth) - 1);
    }
    const lastDepth = byDepth.size ? Math.max(...byDepth.keys()) : 0;
    const neededHeight = Math.max(blockHeight, (lastDepth + extraRows) * 4 + 6);
    const hasProcessors = byDepth.size > 0;
    // Grow the window around this factory's own deposits, not the hub: the miner
    // belt is the one run that cannot be shortened afterwards, and it is most of
    // the sheet's belt length (52% of the links, 91% of the tiles on the full set).
    // Placing the miners first and moving the window onto their centroid was
    // measured on 2026-11-18 too: the product legs grow more than the miner legs
    // shrink (belt tiles 41910 → 46114), so the ore centroid stays the anchor.
    // Halfway to the hub is worse as well (43242), so a shared trunk cannot be
    // faked by moving the blocks: it needs the factories placed along it.
    const centroid = factoryAnchor(shared, flat);
    const anchor: Tile = {
        x: Math.round(centroid.x - blockWidth / 2),
        y: Math.round(centroid.y - neededHeight / 2),
    };
    const block = hasProcessors ? allocateBlock(shared, blockWidth, neededHeight, tuning.blockGap, anchor) : null;
    const blockX = block ? block.x : hub.x + 8;
    const blockY = block ? block.y : hub.y - 8;

    // 1) place extractors on real patches. A base step is not one miner: the
    // machine it feeds may run at 0.5 or 2 items/s, so the step gets as many
    // miners as its belt needs, merged into one output where the merger exists.
    let minerSupply = Infinity;
    for (const step of flat.steps) {
        const node = step.node;
        if (node.op !== "base") continue;
        const type = node.type;
        const code = node.code || `${type}u${type}u${type}u${type}u`;
        // the mineral should be the one nearest the factory that mines it
        const minerFrom = { x: blockX + blockWidth / 2, y: blockY + neededHeight / 2 };
        const need = allowMerge ? minerCount(targetRate) : 1;
        const outpost = buildOutpost(
            claims,
            shared,
            links,
            code,
            need * MINER_RATE,
            minerFrom,
            (kind, serial) =>
                kind === "miner"
                    ? // a step with several miners needs distinct ids: the repair
                      // pass keys placements by stepId
                      { step: step.id, stepId: idPrefix + step.id + (need > 1 ? `#${serial}` : "") }
                    : { step: `${step.id}:merge#${serial}`, stepId: `${idPrefix}${step.id}:merge#${serial}` },
            session.buildings
        );
        if (!outpost) {
            session.missing.add(`shape:${code}`);
            session.sources.push({ step, missing: `地图上找不到 ${code} 矿脉`, patch: null });
            minerSupply = 0;
            continue;
        }
        for (const miner of outpost.miners) {
            session.sources.push({ step, patch: miner.patch ?? null, distance: miner.distance, x: miner.x, y: miner.y });
        }
        session.bind(step.id, outpost.root.building);
        session.wireFanout(step.id, outpost.root.building, outpost.root.info);
        minerSupply = Math.min(minerSupply, outpost.rate);
    }
    // what the miners actually feed; a deposit that ran out caps the factory
    const rate = Math.min(targetRate, Number.isFinite(minerSupply) ? minerSupply : targetRate);

    // 2) pack processors into rows, grouped by depth. One free row between two
    // rows and a two-tile column on the right stay empty: they are the cells a
    // belt can travel through, because every other free cell around a machine
    // is one of its own ports and must stay reserved for its own link.
    const reserveCorridor = (cy: number): void => {
        for (let x = blockX; x < blockX + blockWidth; x++) shared.occupied.add(cellKey(x, cy + tuning.corridor));
        for (let x = blockX + packWidth; x < blockX + blockWidth; x++) {
            for (let y = cy - 1; y <= cy + tuning.corridor; y++) shared.occupied.add(cellKey(x, y));
        }
    };
    /** the game turns a part by 90° at a time; 0 is the orientation it ships in */
    const ROTATIONS: readonly Rot[] = [0, 1, 2, 3];
    let reservedY: number | null = null;
    /**
     * the root's belt into the hub was already attempted with its placement —
     * attempted, not necessarily routed: a failed attempt is committed as a
     * gap, and laying it a second time would report the same gap twice
     */
    let rootPlanned = false;

    for (const [d, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let cx = blockX;
        let cy = blockY + d * 4;
        for (const step of steps) {
            // a fused cut step is another output slot of a cutter placed for
            // its rep; it gets no building of its own
            if (step.fuseInto) continue;
            const info = BUILDING_INFO[step.op];
            if (!info) continue;
            const node = step.node;
            const detail = node.op === "paint4" ? node.colors.map((c) => c || "-").join("/") : step.detail;
            const colors =
                node.op === "paint4"
                    ? node.colors.map((c) => (c && c !== "u" ? c : null))
                    : node.op === "paint"
                    ? [node.color]
                    : undefined;
            /** the root also has to reach the hub, so its belt joins the choice */
            const root = step.id === flat.final.id;
            const make = (x: number, y: number, rot: Rot): Placement => {
                const size = rotatedSize(info, rot);
                return {
                    step: step.id,
                    stepId: idPrefix + step.id,
                    kind: step.op,
                    zh: BUILDING_NAMES[step.op],
                    x,
                    y,
                    w: size.w,
                    h: size.h,
                    rot,
                    detail,
                    colors,
                };
            };

            let chosen: Placement | null = null;
            let fallback: Placement | null = null;
            let tries = 0;
            let scanning = true;
            for (let guard = 0; scanning && guard < 4096; guard++) {
                if (cy !== reservedY) {
                    reserveCorridor(cy);
                    reservedY = cy;
                }
                if (cx + info.w > blockX + packWidth) {
                    cx = blockX;
                    cy += 4;
                    continue;
                }
                for (const rot of ROTATIONS) {
                    if (cx + rotatedSize(info, rot).w > blockX + packWidth) continue;
                    if (!claims.fits(info, cx, cy, rot)) continue;
                    if (!fallback) fallback = make(cx, cy, rot);
                    if (tries >= tuning.maxTries) {
                        scanning = false;
                        break;
                    }
                    tries += 1;
                    // stand the part there, then ask the router whether its own
                    // inputs and — for the root — the hub can all be reached
                    const placement = make(cx, cy, rot);
                    const inputLinks = session.inputLinks(step, placement, info);
                    const toHub = root ? session.hubLinkOf(placement, rate) : null;
                    const claim = claims.reserve(info, cx, cy, rot);
                    const plans = inputLinks.map((q) => links.planLink(q));
                    const hubPlan = toHub ? links.planLink(toHub) : null;
                    const batch: (LinkPlan | null)[] = toHub ? [...plans, hubPlan] : plans;
                    // one tile holds one belt: two runs of this part may not share one
                    const taken = new Set<number>();
                    let clash = false;
                    for (const plan of batch) {
                        if (!plan?.path) continue;
                        for (const cell of plan.path.cells) {
                            const key = cellKey(cell.x, cell.y);
                            if (taken.has(key)) clash = true;
                            taken.add(key);
                        }
                    }
                    if (clash || batch.some((plan) => plan === null || plan.path === null)) {
                        claims.release(claim);
                        continue;
                    }
                    chosen = placement;
                    scanning = false;
                    for (let k = 0; k < batch.length; k++) {
                        const plan = batch[k];
                        if (!plan) continue;
                        links.commitLink(plan, k < inputLinks.length ? inputLinks[k]! : toHub!);
                    }
                    if (toHub) rootPlanned = true;
                    break;
                }
                if (!scanning) break;
                cx += info.w + tuning.machineGap;
            }

            let placement = chosen;
            if (!placement && fallback) {
                // nothing routed from any spot: keep the first that fits, lay
                // what still lays, and let the rest surface as reported gaps
                placement = fallback;
                claims.reserve(info, placement.x, placement.y, placement.rot);
                for (const q of session.inputLinks(step, placement, info)) links.layLink(q);
                if (root) {
                    links.layLink(session.hubLinkOf(placement, rate));
                    rootPlanned = true;
                }
            }
            if (!placement) continue;
            session.buildings.push(placement);
            session.bind(step.id, placement);
            for (const alias of aliasOf.get(step.id) || []) session.bind(alias, placement);
            session.wireFanout(step.id, placement, info);
            cx = placement.x + placement.w + 1;
        }
    }

    // 3b) a bare miner is the whole plan: the placement loop never sees the
    // root step, so its hub belt is laid here
    if (!rootPlanned) {
        const rootBuilding = session.buildingOf(flat.final.id);
        if (rootBuilding) links.layLink(session.hubLinkOf(rootBuilding, rate));
    }

    // 3c) colour belts: one chain per consumer port, merged into a trunk at the
    // production end when the factory may share a net (see `color-supply.ts`)
    colour.supplyFactoryColours(flat, allowColourNet, rate, allowMerge);

    // 3d) an output port with nowhere to go backs up and stalls the machine, so
    // every cutter slot the plan does not use gets a trash can. The ejector hands
    // the item to whatever acceptor stands on the tile in front of it
    // (`systems/item_ejector.js`), so the can goes exactly there: no belt, and no
    // way for the last link of a crowded factory to be left unroutable.
    for (const step of flat.steps) {
        // a fused sibling has no building of its own: its slot is handled here
        if (step.fuseInto) continue;
        const info = BUILDING_INFO[step.op];
        if (!info || !info.outs || info.outs.length < 2) continue;
        const source = session.buildingOf(step.id);
        if (!source) continue;
        // every slot a consumer belts away: the rep's own, plus a fused
        // sibling's when that sibling's product is used
        const used = new Set<number>([outputSlot(step)]);
        for (const alias of aliasOf.get(step.id) || []) {
            const aliasStep = stepById.get(alias);
            if (aliasStep && consumersOf.get(alias)) used.add(outputSlot(aliasStep));
        }
        const cells = portCells(info, source.x, source.y, source.rot);
        const approaches = portApproachCells(info, source.x, source.y, source.rot);
        for (let slot = 0; slot < info.outs.length; slot++) {
            if (used.has(slot)) continue;
            const cell = cells[info.ins.length + slot];
            if (!cell) continue;
            const can: Placement = {
                step: `trash:${step.id}:${slot}`,
                stepId: `${idPrefix}trash:${step.id}:${slot}`,
                kind: "trash",
                zh: BUILDING_NAMES.trash,
                x: cell.x,
                y: cell.y,
                w: 1,
                h: 1,
                rot: 0,
            };
            session.buildings.push(can);
            shared.occupied.add(cellKey(cell.x, cell.y));
            shared.walls.add(cellKey(cell.x, cell.y));
            claims.block([cellKey(cell.x, cell.y)]);
            // the side of the can the machine ejects into: opposite the port's
            // outward direction, so it is the side facing the body
            const approach = approaches[info.ins.length + slot];
            const outX = approach ? Math.sign(approach.x - cell.x) : 0;
            const outY = approach ? Math.sign(approach.y - cell.y) : -1;
            const inSlot = outY === -1 ? 2 : outY === 1 ? 0 : outX === -1 ? 1 : 3;
            links.layLink(links.shapeLink(source, info, slot, can, BUILDING_INFO.trash, inSlot, { waste: true, direct: true }));
        }
    }

    // 3e) rip up what a failed link ran into and let both sides try again
    links.schedule();

    // 4) colors: which ones are on the map, which need mixing
    const colorPatches = new Map<ColorChar, Patch>();
    for (const p of patches) {
        if (p.item.kind !== "color") continue;
        const prev = colorPatches.get(p.item.color);
        if (!prev || Math.hypot(p.x - hub.x, p.y - hub.y) < Math.hypot(prev.x - hub.x, prev.y - hub.y)) {
            colorPatches.set(p.item.color, p);
        }
    }
    const colors: LayoutColor[] = [...paintColorsUsed].map((c) => {
        const direct = colorPatches.get(c);
        if (direct) return { color: c, direct: true, patch: direct, mix: null };
        const mix = COLOR_NEEDS[c];
        return { color: c, direct: false, patch: null, mix };
    });

    const bom = new Map<string, number>();
    for (const b of session.buildings) bom.set(b.zh, (bom.get(b.zh) || 0) + 1);

    return {
        hub,
        buildings: session.buildings,
        connections: links.connections,
        sources: session.sources,
        colors,
        missing: [...session.missing],
        routingGaps: links.routingGaps,
        beltEstimate: links.beltEstimate,
        bom: [...bom.entries()].map(([zh, n]) => ({ zh, n })),
        steps: flat.steps,
        rate,
    };
}
