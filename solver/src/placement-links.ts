/**
 * Link scheduling: what turns a pair of placed ports into belts.
 *
 * The scheduler owns everything the drawing records about the links of one
 * factory — the connections in placement order, the belt cells already spent,
 * which belt owns which tile, the hub entries a leg claimed and the gap left
 * where no legal run exists. It also owns the rip-up pass, which is the only
 * part of the layout that edits belts it already laid.
 *
 * The tile world and the router are `layout.ts`; where parts may stand is
 * `spots.ts`. This module asks the router and writes the answer down so a
 * re-route can take it back.
 */

import { BUILDING_NAMES } from "./catalogue.js";
import {
    cellKey,
    claimRoute,
    HUB_SIZE,
    portApproachCells,
    portCells,
    portCentre,
    releaseRoute,
    routeBeltDetailed,
    runFits,
    tileOfKey,
} from "./layout.js";
import type {
    BuildingInfo,
    Connection,
    ConnectionDraft,
    ConnectionExtra,
    Placement,
    RouteResult,
    RoutingGap,
    Tile,
    World,
} from "./layout.js";
import type { PlacementTuning } from "./placement.js";

/* ------------------------------------------------------------------ *
 * the hub's faces
 * ------------------------------------------------------------------ */

/**
 * The entry tiles a belt can stand on to feed the hub: four per side, 16
 * total. A corner hub tile has one on each of its two outward sides. Two
 * belts cannot share one entry tile, so a campaign with more inbound belts
 * than that needs a merger.
 */
function hubApproaches(hub: Tile): Tile[] {
    const out: Tile[] = [];
    for (let i = 0; i < HUB_SIZE; i++) {
        out.push({ x: hub.x + i, y: hub.y - 1 });
        out.push({ x: hub.x + i, y: hub.y + HUB_SIZE });
        out.push({ x: hub.x - 1, y: hub.y + i });
        out.push({ x: hub.x + HUB_SIZE, y: hub.y + i });
    }
    return out;
}

/** the border tile an outside approach feeds; its centre is where the belt ends */
function hubBorderOf(hub: Tile, tile: Tile): Tile {
    if (tile.y < hub.y) return { x: tile.x, y: hub.y };
    if (tile.y >= hub.y + HUB_SIZE) return { x: tile.x, y: hub.y + HUB_SIZE - 1 };
    if (tile.x < hub.x) return { x: hub.x, y: tile.y };
    return { x: hub.x + HUB_SIZE - 1, y: tile.y };
}

/* ------------------------------------------------------------------ *
 * the link record
 * ------------------------------------------------------------------ */

/** one link resolved against the map, before anything is claimed */
export interface LinkPlan {
    draft: ConnectionDraft;
    start: Tile;
    goal: Tile;
    /** the outside tile this link claims at the hub, when it goes there */
    hubTile: Tile | null;
    /** the searched run: `null` when no legal one exists */
    path: RouteResult | null;
}

/** a link waiting for the router; every part is placed before any belt is laid */
export type QueuedLink =
    | {
          toHub: true;
          srcBuilding: Placement;
          srcInfo: BuildingInfo;
          outSlot: number;
          dstBuilding: null;
          dstInfo: null;
          inSlot: null;
          extra: ConnectionExtra;
      }
    | {
          toHub?: false;
          srcBuilding: Placement;
          srcInfo: BuildingInfo;
          outSlot: number;
          dstBuilding: Placement;
          dstInfo: BuildingInfo;
          inSlot: number;
          extra: ConnectionExtra;
      };

export interface LinkSchedulerArgs {
    world: World;
    hub: Tile;
    /** what the router may not cross; the caller keeps it current */
    blocked: ReadonlySet<number>;
    tuning: PlacementTuning;
    allowTunnels: boolean;
}

export interface LinkScheduler {
    /** one entry per link laid or reported (the drawing and the sheet order) */
    readonly connections: Connection[];
    readonly routingGaps: RoutingGap[];
    /** belt cells this factory needs, tunnels counted twice */
    readonly beltEstimate: number;

    /** a belt between two placed parts; `extra` marks colour / waste runs */
    shapeLink(
        src: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dst: Placement,
        dstInfo: BuildingInfo,
        inSlot: number,
        extra?: ConnectionExtra
    ): QueuedLink;
    planLink(q: QueuedLink): LinkPlan | null;
    commitLink(plan: LinkPlan, q: QueuedLink, replace?: number): boolean;
    /** plan a link and lay it; `false` when no legal run exists */
    layLink(q: QueuedLink): boolean;
    /** undo one laid run so the rip-up pass can route it again */
    rip(index: number): void;
    /** rip-up and reroute: run once every part is placed */
    schedule(): void;
}

export function createLinkScheduler({ world, hub, blocked, tuning, allowTunnels }: LinkSchedulerArgs): LinkScheduler {
    const allowCross = allowTunnels !== false;

    const connections: Connection[] = [];
    const routingGaps: RoutingGap[] = [];
    let beltEstimate = 0;

    /** the run behind every connection index, for rip-up */
    const laid: ({ q: QueuedLink; run: RouteResult; hubTile: Tile | null } | undefined)[] = [];
    /** belt tile key → connection index */
    const beltOwner = new Map<number, number>();
    /** links whose search failed: the rip-up pass retries them */
    const failed: { q: QueuedLink; index: number }[] = [];
    /** the gap behind each connection index; a successful retry clears it */
    const gapOf: (RoutingGap | undefined)[] = [];
    /** the link behind each connection index, so a leftover can be retried */
    const queuedOf = new Map<number, QueuedLink>();
    /** the last run laid for each connection index, so a failed rip can be undone */
    const lastPlan = new Map<number, LinkPlan>();
    /** hub entry tile key → the connection that claimed it */
    const hubClaimOwner = new Map<number, number>();

    /** when set, every search records the blocked tiles it ran into */
    let blameFrontier: Set<number> | null = null;

    /**
     * A dry search. The short box covers any link inside one factory; a wide box
     * is only worth its cost for the long hub runs, and two of them per failed
     * candidate is what makes a big campaign crawl.
     */
    const searchRoute = (
        start: Tile,
        goal: Tile,
        join: boolean,
        exempt: ReadonlySet<number> | null,
        startDir: readonly [number, number] | null,
        goalDir: readonly [number, number] | null,
        wide: boolean
    ): RouteResult | null => {
        // a short link inside one factory only needs a small box: searching ±20
        // tiles around it costs 7× more and finds the same run
        const span = Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y);
        const near = routeBeltDetailed(world, blocked, start, goal, {
            allowCross,
            goalMayJoin: join,
            exempt,
            startDir,
            goalDir,
            frontier: blameFrontier,
            margin: Math.max(tuning.nearMarginFloor, Math.min(tuning.nearMargin, span)),
            dryRun: true,
        });
        if (near.run || !wide) return near.run;
        // the near box was never the limit: no reachable tile touched its
        // edge, so a wider box finds exactly the same (empty) component
        if (!near.boxLimited) return null;
        return routeBeltDetailed(world, blocked, start, goal, {
            allowCross,
            goalMayJoin: join,
            exempt,
            startDir,
            goalDir,
            frontier: blameFrontier,
            margin: tuning.wideMargin,
            dryRun: true,
        }).run;
    };

    /**
     * Belts that already carry items into the hub, nearest to `(x, y)` first.
     *
     * Two belts may point into one tile, so a leg that finds every entry boxed
     * in by the belts of earlier factories can still merge into one that is on
     * its way there. An entry belt carries 2 items/s and the fattest factory
     * root pulls 0.4, so a trunk stops taking legs once its entry reached
     * `tuning.hubEntryLegs` — without that cap every factory could chain onto
     * the first belt and the sheet would claim a rate the game cannot carry.
     */
    function hubTrunkCells(x: number, y: number, limit: number): Tile[] {
        const out: { tile: Tile; d: number }[] = [];
        for (const [key, entry] of world.hubBound) {
            if ((world.hubEntryLoad.get(entry) ?? 0) >= tuning.hubEntryLegs) continue;
            // an entry tile is offered by the face loop together with its claim
            if (world.hubApproaches.has(key)) continue;
            const tile = tileOfKey(key);
            out.push({ tile, d: Math.abs(tile.x - x) + Math.abs(tile.y - y) });
        }
        out.sort((a, b) => a.d - b.d || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
        return out.slice(0, limit).map((e) => e.tile);
    }

    /**
     * Resolve a link — the ports turn with their parts, the hub face is picked —
     * and ask the router whether a legal run exists, without claiming a tile.
     * A hub run walks down the faces from nearest to farthest: the closest one
     * is often boxed in by belts of the factories placed before this one.
     */
    function planLink(q: QueuedLink): LinkPlan | null {
        const src = q.srcBuilding;
        const sInfo = q.srcInfo;
        const outPort = sInfo.outs[q.outSlot] || sInfo.outs[0];
        if (!outPort) return null;
        const [ox, oy] = portCentre(sInfo, outPort, src.rot);
        const x1 = src.x + ox;
        const y1 = src.y + oy;
        const sCells = portCells(sInfo, src.x, src.y, src.rot);
        const sApproach = portApproachCells(sInfo, src.x, src.y, src.rot);
        const start = sCells[sInfo.ins.length + q.outSlot];
        if (!start) return null;
        const startApproach = sApproach[sInfo.ins.length + q.outSlot] || null;

        // a part standing on the ejector's target tile takes the item directly,
        // so there is no run to search and nothing to lay
        if (q.extra.direct && !q.toHub) {
            const dst = q.dstBuilding;
            const dInfo = q.dstInfo;
            const inPort = dInfo.ins[q.inSlot];
            if (!inPort) return null;
            const [ix, iy] = portCentre(dInfo, inPort, dst.rot);
            const x2 = dst.x + ix;
            const y2 = dst.y + iy;
            const draft: ConnectionDraft = {
                from: src.stepId,
                to: dst.stepId,
                toHub: false,
                merged: false,
                slot: q.inSlot,
                fromLabel: BUILDING_NAMES[src.kind],
                toLabel: BUILDING_NAMES[dst.kind],
                outSlot: q.outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
                ...q.extra,
            };
            return {
                draft,
                start,
                goal: start,
                hubTile: null,
                path: { cells: [], crossings: [], spans: [], phases: [], headings: [], joinsGoal: false, entryKey: null },
            };
        }

        /** finish one candidate end: exempt its ports, search, build the draft */
        const finish = (
            goal: Tile,
            x2: number,
            y2: number,
            to: string,
            toLabel: string,
            slot: number | null,
            mergeInto: boolean,
            hubTile: Tile | null,
            goalApproach: Tile | null,
            /** the hub side an entry tile feeds: a run may tunnel up onto it */
            goalDirOverride: readonly [number, number] | null = null
        ): LinkPlan => {
            const exempt = new Set<number>();
            for (const cell of [start, goal, startApproach, goalApproach, hubTile]) {
                if (cell) exempt.add(cellKey(cell.x, cell.y));
            }
            // a sender / receiver on the port tile itself only works when it
            // faces straight out of / into the machine
            const startDir = startApproach
                ? ([Math.sign(startApproach.x - start.x), Math.sign(startApproach.y - start.y)] as const)
                : null;
            const goalDir =
                goalDirOverride ??
                (goalApproach ? ([Math.sign(goal.x - goalApproach.x), Math.sign(goal.y - goalApproach.y)] as const) : null);
            const path = searchRoute(
                start,
                goal,
                mergeInto,
                exempt,
                startDir,
                goalDir,
                Math.abs(goal.x - start.x) + Math.abs(goal.y - start.y) > 24
            );
            const draft: ConnectionDraft = {
                from: src.stepId,
                to,
                toHub: !!q.toHub,
                merged: mergeInto,
                slot,
                fromLabel: BUILDING_NAMES[src.kind],
                toLabel,
                outSlot: q.outSlot,
                outCount: sInfo.outs.length,
                x1,
                y1,
                x2,
                y2,
                length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
                ...q.extra,
            };
            return { draft, start, goal, hubTile, path };
        };

        if (q.toHub) {
            const faces = hubApproaches(hub)
                .map((t) => ({ ...t, d: Math.abs(t.x - x1) + Math.abs(t.y - y1) }))
                .sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
            // a face another factory claimed is taken, and one a belt already runs
            // over can no longer end a run; merging may join a belt instead.
            // Only the nearest few faces are worth a search each: on a crowded
            // hub every extra face costs a full Dijkstra and rarely helps.
            const candidates: { tile: Tile; join: boolean; entry: boolean }[] = [];
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (!world.hubApproaches.has(key) && !world.belts.has(key) && candidates.length < 6) {
                    candidates.push({ tile: t, join: false, entry: true });
                }
            }
            let merges = 0;
            for (const t of faces) {
                const key = cellKey(t.x, t.y);
                if (world.hubApproaches.has(key) && world.belts.has(key) && merges++ < 3) {
                    candidates.push({ tile: t, join: true, entry: true });
                }
            }
            // every entry can be boxed in by the belts of factories laid before
            // this one. Two belts may point into one tile, so the leg can still
            // merge into a belt that already runs to the hub; one entry belt
            // carries 2 items/s, which bounds how many legs it may feed.
            for (const tile of hubTrunkCells(x1, y1, 6)) candidates.push({ tile, join: true, entry: false });

            if (!candidates.length) for (const t of faces) candidates.push({ tile: t, join: false, entry: true });
            let first: LinkPlan | null = null;
            for (const { tile, join, entry } of candidates) {
                const border = hubBorderOf(hub, tile);
                // an entry tile is a hub claim; a trunk merge ends on a belt that
                // already runs into the hub and claims nothing
                const plan = finish(
                    { x: tile.x, y: tile.y },
                    entry ? border.x + 0.5 : tile.x + 0.5,
                    entry ? border.y + 0.5 : tile.y + 0.5,
                    "HUB",
                    "中心",
                    null,
                    join,
                    entry ? { x: tile.x, y: tile.y } : null,
                    null,
                    // the entry belt has to point into the hub, so a run may
                    // surface onto the entry tile from a tunnel underneath the
                    // belts that box the hub in
                    entry ? [Math.sign(border.x - tile.x), Math.sign(border.y - tile.y)] : null
                );
                if (plan.path) return plan;
                if (!first) first = plan;
            }
            return first;
        }

        const dst = q.dstBuilding;
        const dInfo = q.dstInfo;
        const inPort = dInfo.ins[q.inSlot];
        if (!inPort) return null;
        const [ix, iy] = portCentre(dInfo, inPort, dst.rot);
        const goal = portCells(dInfo, dst.x, dst.y, dst.rot)[q.inSlot]!;
        const goalApproach = portApproachCells(dInfo, dst.x, dst.y, dst.rot)[q.inSlot] || null;
        return finish(goal, dst.x + ix, dst.y + iy, dst.stepId, BUILDING_NAMES[dst.kind], q.inSlot, false, null, goalApproach);
    }

    /**
     * Lay a planned run. An unroutable link is reported as a gap instead of
     * being drawn as if a belt could carry items there — a stub end blocks the
     * machine that feeds it.
     */
    function commitLink(plan: LinkPlan, q: QueuedLink, replace = -1): boolean {
        if (plan.hubTile) {
            const key = cellKey(plan.hubTile.x, plan.hubTile.y);
            world.hubApproaches.add(key);
            if (!hubClaimOwner.has(key)) hubClaimOwner.set(key, replace >= 0 ? replace : connections.length);
        }
        const path = plan.path;
        const index = replace >= 0 ? replace : connections.length;
        queuedOf.set(index, q);
        if (!path) {
            gapOf[index] = {
                from: plan.draft.from,
                to: plan.draft.to,
                fromLabel: plan.draft.fromLabel,
                toLabel: plan.draft.toLabel,
                start: plan.start,
                goal: plan.goal,
                connection: index,
            };
            connections[index] = { ...plan.draft, routed: false, path: null, tunnels: 0, tunnelCells: [], tunnelSpans: [], beltTiles: 0 };
            laid[index] = undefined;
            failed.push({ q, index });
            return false;
        }
        gapOf[index] = undefined;
        // a delivery leg feeds the entry it claimed, or — merged into a trunk —
        // the entry that trunk already belongs to; the tag has to be on the run
        // before it is claimed
        const tail = path.cells[path.cells.length - 1];
        const joined = path.joinsGoal && tail ? world.hubBound.get(cellKey(tail.x, tail.y)) : undefined;
        path.entryKey = plan.hubTile ? cellKey(plan.hubTile.x, plan.hubTile.y) : joined ?? null;
        // the run was searched on this very world a moment ago: write it as tested
        claimRoute(world, path);
        // every path tile is a belt or a tunnel end; the underground tiles are
        // neither, and the two ends of each tunnel are counted once each
        const underground = path.spans.reduce((n, span) => n + span.cells.length, 0);
        const beltTiles = path.cells.length - underground;
        beltEstimate += beltTiles;
        connections[index] = {
            ...plan.draft,
            routed: true,
            path: path.cells,
            tunnels: path.spans.length,
            tunnelCells: path.crossings,
            tunnelSpans: path.spans,
            beltTiles,
        };
        laid[index] = { q, run: path, hubTile: plan.hubTile };
        lastPlan.set(index, plan);
        for (const c of path.cells) beltOwner.set(cellKey(c.x, c.y), index);
        for (const span of path.spans) {
            beltOwner.set(cellKey(span.sender.x, span.sender.y), index);
            beltOwner.set(cellKey(span.receiver.x, span.receiver.y), index);
        }
        return true;
    }

    /** a belt between two placed parts; `extra` marks colour / waste runs */
    function shapeLink(
        src: Placement,
        srcInfo: BuildingInfo,
        outSlot: number,
        dst: Placement,
        dstInfo: BuildingInfo,
        inSlot: number,
        extra: ConnectionExtra = {}
    ): QueuedLink {
        return { srcBuilding: src, srcInfo, outSlot, dstBuilding: dst, dstInfo, inSlot, extra };
    }

    /** plan a link and lay it; `false` when no legal run exists */
    function layLink(q: QueuedLink): boolean {
        const plan = planLink(q);
        return plan ? commitLink(plan, q) : false;
    }

    /** undo one laid run so the rip-up pass can route it again */
    const rip = (index: number): void => {
        const entry = laid[index];
        if (!entry) return;
        /** every tile this run held, so a merge aimed at one of them can follow */
        const held = new Set<number>(entry.run.cells.map((c) => cellKey(c.x, c.y)));
        releaseRoute(world, entry.run);
        for (const c of entry.run.cells) beltOwner.delete(cellKey(c.x, c.y));
        for (const span of entry.run.spans) {
            beltOwner.delete(cellKey(span.sender.x, span.sender.y));
            beltOwner.delete(cellKey(span.receiver.x, span.receiver.y));
        }
        // a ripped hub leg frees the entry it claimed — otherwise the entry stays
        // "taken" while nothing feeds it and no later leg may claim it
        if (entry.hubTile) {
            const key = cellKey(entry.hubTile.x, entry.hubTile.y);
            if (hubClaimOwner.get(key) === index) {
                hubClaimOwner.delete(key);
                world.hubApproaches.delete(key);
            }
        }
        const underground = entry.run.spans.reduce((n, span) => n + span.cells.length, 0);
        beltEstimate -= entry.run.cells.length - underground;
        laid[index] = undefined;
        connections[index] = { ...connections[index]!, routed: false, path: null, tunnels: 0, tunnelCells: [], tunnelSpans: [], beltTiles: 0 };
        failed.push({ q: entry.q, index });
        // a leg that merged into a belt of this run now points into nothing:
        // rip it too so the rip-up pass can find it another way in
        for (let i = 0; i < connections.length; i++) {
            const merged = connections[i]!;
            if (i === index || !merged.toHub || !merged.merged || !merged.routed || !merged.path) continue;
            const tail = merged.path[merged.path.length - 1];
            if (tail && held.has(cellKey(tail.x, tail.y))) rip(i);
        }
    };

    /**
     * Rip-up and reroute. A failed link blames the belts its search ran into;
     * rip the worst offenders, retry the link, and let the ripped ones try
     * again next round. Deterministic and bounded: fixed visiting order, fixed
     * cap — no randomness, so the sheet stays reproducible.
     */
    function schedule(): void {
        let queue = failed.splice(0);
        for (let round = 0; round < tuning.ripRounds && queue.length; round++) {
            const next: { q: QueuedLink; index: number }[] = [];
            for (const item of queue) {
                const blame = new Set<number>();
                // the retry doubles as the blame run: it records what stopped it
                blameFrontier = blame;
                const retry = planLink(item.q);
                blameFrontier = null;
                if (retry?.path) {
                    commitLink(retry, item.q, item.index);
                    continue;
                }
                const counts = new Map<number, number>();
                for (const key of blame) {
                    const owner = beltOwner.get(key);
                    if (owner === undefined || owner === item.index) continue;
                    counts.set(owner, (counts.get(owner) ?? 0) + 1);
                }
                const victims = [...counts.entries()].sort((l, r) => r[1] - l[1] || l[0] - r[0]).slice(0, tuning.ripPerRound);
                if (!victims.length) {
                    next.push(item);
                    continue;
                }
                for (const [index] of victims) rip(index);
                const after = planLink(item.q);
                if (after?.path) commitLink(after, item.q, item.index);
                else next.push(item);
            }
            queue = [...next, ...failed.splice(0)];
        }
        // a rip late in the cascade frees corridors the last retries never saw: try
        // the leftovers once more against the finished world. This only adds runs,
        // so it can never turn a laid belt into a gap.
        for (let sweep = 0; sweep < 4; sweep++) {
            let fixed = 0;
            for (let i = 0; i < connections.length; i++) {
                if (connections[i]!.routed) continue;
                const q = queuedOf.get(i);
                if (!q) continue;
                const plan = planLink(q);
                if (plan?.path && commitLink(plan, q, i)) fixed += 1;
            }
            if (!fixed) break;
        }
        // a rip that never found a way back would leave a link silently missing: the
        // sheet draws a cross for it while the CLI summary counts no gap. Put the
        // last run back wherever its tiles are still free, and report a gap only
        // when they are not — a rip may move a belt, never quietly drop one.
        for (let i = 0; i < connections.length; i++) {
            if (connections[i]!.routed) continue;
            const saved = lastPlan.get(i);
            const q = queuedOf.get(i);
            if (saved?.path && q && runFits(world, saved.path) && commitLink(saved, q, i)) continue;
            if (!gapOf[i] && saved) {
                gapOf[i] = {
                    from: saved.draft.from,
                    to: saved.draft.to,
                    fromLabel: saved.draft.fromLabel,
                    toLabel: saved.draft.toLabel,
                    start: saved.start,
                    goal: saved.goal,
                    connection: i,
                };
            }
        }
        routingGaps.length = 0;
        for (const gap of gapOf) if (gap) routingGaps.push(gap);
        // a ripped belt can take away an over-belt another run was crossing under,
        // so every recorded crossing is refreshed from the final world
        for (const conn of connections) {
            if (!conn.routed || !conn.tunnelSpans || !conn.tunnelSpans.length) continue;
            conn.tunnelCells = conn.tunnelSpans
                .flatMap((span) => span.cells)
                .filter((cell) => world.belts.has(cellKey(cell.x, cell.y)));
        }
    }

    return {
        connections,
        routingGaps,
        get beltEstimate(): number {
            return beltEstimate;
        },
        shapeLink,
        planLink,
        commitLink,
        layLink,
        rip,
        schedule,
    };
}
