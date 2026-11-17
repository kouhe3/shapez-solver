/**
 * Sheet legality: would this drawing stand up in the game?
 *
 * The checker walks the drawing only — `buildings` and `connections` — and
 * re-derives every rule itself. It deliberately does not reuse `routeBelt`'s
 * search state or the `World` the sheet keeps: two implementations of the
 * tunnel law are the point, and the world's tile tables are module-private.
 *
 * Two adapters use it: the campaign census (`tools/check-tunnels.ts`) and
 * tests (a real layout, legal as drawn, plus corrupted copies of it).
 *
 * 判据来源见 `docs/facts.md`：F09/F16（隧道跨度、两端同向、劫持）、F44（隧道可从
 * 建筑下方穿过，中间格没有实体）、F21（端口朝向随旋转）。
 */
import { BUILDING_INFO, cellKey, portApproachCells, portCells } from "./layout.js";
import type { Connection, Placement, Tile, TunnelSpan } from "./layout.js";

/** tier-0 tunnel: at most 4 tiles strictly between the two ends */
const TUNNEL_RANGE = 5;

/** the game's four directions; `ROUTE_DIRS` order, index = bit in a tunnel mask */
const DIRS: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

export const VIOLATION_KINDS = [
    /** one connection visits the same tile twice */
    "selfOverlap",
    /** sender / receiver farther apart than one tunnel may span */
    "spanTooLong",
    /** the span's cells are not the straight run between its ends */
    "spanNotStraight",
    /** an end or span cell is not on the connection's path */
    "missingEnd",
    /** the belt enters or leaves a tunnel on a turn */
    "senderTurn",
    "receiverTurn",
    /** a tunnel end on a port tile faces away from the machine */
    "portDirection",
    /** two ends on one tile */
    "endOverlap",
    /** a tunnel end shares its tile with a surface belt */
    "endOnBelt",
    /** a same-direction end inside a span, or above a run of the same direction */
    "hijack",
    /** one tile claimed twice: a surface belt, or the same underground direction */
    "tileClaimed",
    /** a crossing the router recorded is not on this run's underground cells, or has no over-belt */
    "staleCrossing",
] as const;

export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export interface Violation {
    kind: ViolationKind;
    /** index into `connections` */
    connection: number;
    /** the tile the rule is about, when the rule has one */
    tile?: Tile;
    /** the other connection on a `tileClaimed` clash */
    other?: number;
}

/** what the checker reads: a campaign sheet, a factory layout, or a fixture */
export interface SheetLike {
    buildings: ReadonlyArray<Placement>;
    connections: ReadonlyArray<Connection>;
}

function sameCell(a: Tile, b: Tile): boolean {
    return a.x === b.x && a.y === b.y;
}

function axisDir(a: Tile, b: Tile): readonly [number, number] {
    return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
}

function dirIndex(dx: number, dy: number): number {
    return DIRS.findIndex((d) => d[0] === dx && d[1] === dy);
}

/** every rule the game applies to one drawing; an empty list = buildable */
export function validateSheet({ buildings, connections }: SheetLike): Violation[] {
    const out: Violation[] = [];
    const flag = (kind: ViolationKind, connection: number, tile?: Tile, other?: number): void => {
        const violation: Violation = { kind, connection };
        if (tile) violation.tile = tile;
        if (other !== undefined) violation.other = other;
        out.push(violation);
    };

    const byStep = new Map(buildings.map((b) => [b.stepId, b]));
    /** a surface belt tile may belong to one connection only */
    const beltOwner = new Map<number, number>();
    /** every surface belt tile on the sheet, merged legs included */
    const beltTiles = new Set<number>();
    /** tile *4 + direction → the connection running a tunnel there */
    const underOwner = new Map<number, number>();
    /** tunnel end tile → the direction it faces */
    const endDirections = new Map<number, number>();
    /** per connection: its underground cells and its own tunnel ends */
    const underground: Set<number>[] = [];
    const ownEnds: Set<number>[] = [];
    const ends: { cell: Tile; dx: number; dy: number }[] = [];
    const spans: { connection: number; span: TunnelSpan; dx: number; dy: number }[] = [];

    connections.forEach((conn, ci) => {
        const under = new Set<number>();
        const mine = new Set<number>();
        underground[ci] = under;
        ownEnds[ci] = mine;
        if (!conn.routed || !conn.path) return;
        const path = conn.path;
        const pathKeys = new Set<number>();
        for (const cell of path) {
            const key = cellKey(cell.x, cell.y);
            if (pathKeys.has(key)) {
                flag("selfOverlap", ci, cell);
                break;
            }
            pathKeys.add(key);
        }

        for (const span of conn.tunnelSpans) {
            const dx = Math.sign(span.receiver.x - span.sender.x);
            const dy = Math.sign(span.receiver.y - span.sender.y);
            spans.push({ connection: ci, span, dx, dy });
            const si = path.findIndex((p) => sameCell(p, span.sender));
            const ri = path.findIndex((p) => sameCell(p, span.receiver));
            if (si < 0 || ri < 0) {
                flag("missingEnd", ci, si < 0 ? span.sender : span.receiver);
                continue;
            }
            if ((dx !== 0) === (dy !== 0)) flag("spanNotStraight", ci, span.sender);
            if (ri - si < 2 || ri - si > TUNNEL_RANGE) flag("spanTooLong", ci, span.sender);
            // the span's cells must be exactly the path tiles between its ends
            const expected = path.slice(si + 1, ri);
            if (expected.length !== span.cells.length || expected.some((p, i) => !sameCell(p, span.cells[i]!))) {
                flag("spanNotStraight", ci, span.sender);
            }
            for (const cell of [span.sender, span.receiver]) {
                const key = cellKey(cell.x, cell.y);
                if (!pathKeys.has(key)) flag("missingEnd", ci, cell);
                mine.add(key);
            }
            for (const cell of span.cells) under.add(cellKey(cell.x, cell.y));
            // straight at both ends: the game searches the receiver along the facing
            if (si > 0) {
                const before = axisDir(path[si - 1]!, span.sender);
                if (before[0] !== dx || before[1] !== dy) flag("senderTurn", ci, span.sender);
            }
            if (ri < path.length - 1) {
                const after = axisDir(span.receiver, path[ri + 1]!);
                if (after[0] !== dx || after[1] !== dy) flag("receiverTurn", ci, span.receiver);
            }
            // a tunnel end sitting on the port tile has to face the machine
            const src = byStep.get(conn.from);
            if (si === 0 && src) {
                const info = BUILDING_INFO[src.kind];
                const start = portCells(info, src.x, src.y, src.rot)[info.ins.length + conn.outSlot];
                const approach = portApproachCells(info, src.x, src.y, src.rot)[info.ins.length + conn.outSlot];
                if (start && approach) {
                    const dir = axisDir(start, approach);
                    if (dir[0] !== dx || dir[1] !== dy) flag("portDirection", ci, span.sender);
                }
            }
            const dst = conn.to === "HUB" ? undefined : byStep.get(conn.to);
            if (ri === path.length - 1 && dst && conn.slot !== null) {
                const info = BUILDING_INFO[dst.kind];
                const goal = portCells(info, dst.x, dst.y, dst.rot)[conn.slot];
                const approach = portApproachCells(info, dst.x, dst.y, dst.rot)[conn.slot];
                if (goal && approach) {
                    const dir = axisDir(approach, goal);
                    if (dir[0] !== dx || dir[1] !== dy) flag("portDirection", ci, span.receiver);
                }
            }
            for (const cell of [span.sender, span.receiver]) ends.push({ cell, dx, dy });
            // one tunnel per tile and direction: the game's underground belt is
            // one entity, and a second sender with the same facing breaks the run
            const d = dirIndex(dx, dy);
            for (const cell of span.cells) {
                const slot = cellKey(cell.x, cell.y) * 4 + d;
                const prev = underOwner.get(slot);
                if (prev !== undefined) flag("tileClaimed", ci, cell, prev);
                else underOwner.set(slot, ci);
            }
            for (const cell of [span.sender, span.receiver]) {
                const key = cellKey(cell.x, cell.y);
                if (endDirections.has(key)) flag("endOverlap", ci, cell);
                endDirections.set(key, d);
            }
        }

        // surface belts: every path tile that is neither an end nor underground
        const merged = conn.merged === true;
        for (let i = 0; i < path.length; i++) {
            const cell = path[i]!;
            const key = cellKey(cell.x, cell.y);
            if (mine.has(key) || under.has(key)) continue;
            beltTiles.add(key);
            // a merged leg feeds a belt that already runs to the hub: that tile
            // belongs to the owner, exactly as `claimRoute` leaves it
            if (merged && i === path.length - 1) continue;
            const prev = beltOwner.get(key);
            if (prev !== undefined && prev !== ci) flag("tileClaimed", ci, cell, prev);
            else if (prev === undefined) beltOwner.set(key, ci);
        }
    });

    // crossings are recorded per run; they must be this run's underground cells
    // and something has to pass over them
    for (const [ci, set] of underground.entries()) {
        const conn = connections[ci]!;
        if (!conn.routed) continue;
        for (const cell of conn.tunnelCells) {
            const key = cellKey(cell.x, cell.y);
            if (!set.has(key) || !beltTiles.has(key)) flag("staleCrossing", ci, cell);
        }
    }

    // a surface belt may not sit on someone else's tunnel end
    for (const [ci, set] of underground.entries()) {
        const conn = connections[ci]!;
        if (!conn.routed || !conn.path) continue;
        const mine = ownEnds[ci]!;
        for (const cell of conn.path) {
            const key = cellKey(cell.x, cell.y);
            if (set.has(key) || mine.has(key)) continue;
            if (endDirections.has(key)) flag("endOnBelt", ci, cell);
        }
    }

    // hijack: a same-direction end strictly inside a span, and an end sitting
    // above a tunnel that runs the same way
    for (const { connection, span, dx, dy } of spans) {
        if (dx === 0 && dy === 0) continue;
        const lo = Math.min(span.sender.x * dx + span.sender.y * dy, span.receiver.x * dx + span.receiver.y * dy);
        const hi = Math.max(span.sender.x * dx + span.sender.y * dy, span.receiver.x * dx + span.receiver.y * dy);
        for (const end of ends) {
            if (end.dx !== dx || end.dy !== dy) continue;
            const at = end.cell.x * dx + end.cell.y * dy;
            const onAxis = dx !== 0 ? end.cell.y === span.sender.y : end.cell.x === span.sender.x;
            if (onAxis && at > lo && at < hi) flag("hijack", connection, end.cell);
        }
    }
    for (const end of ends) {
        const d = dirIndex(end.dx, end.dy);
        const owner = underOwner.get(cellKey(end.cell.x, end.cell.y) * 4 + d);
        if (owner !== undefined) flag("hijack", owner, end.cell);
    }

    return out;
}
