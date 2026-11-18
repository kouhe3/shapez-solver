/**
 * The supply layer: ore mined once, on one vein cluster, and handed out on one
 * belt.
 *
 * A campaign that gives every factory its own miners pays for the same vein many
 * times — on the full set the miner links are 52% of the links but 91% of the
 * belt tiles. This module is the first half of the fix: it builds one outpost per
 * deposit code (miners on one cluster, merged into a single belt), so a later
 * pass can route a trunk and hand it out instead of running a belt per factory.
 *
 * The trunk half (route, ring terminals, taps) was measured three times and is
 * recorded in `docs/facts.md` (F76-F79): ring terminals route 5 of 5 spines, a
 * shared yard 1 of 5; a tap has to split the trunk with a splitter because a belt
 * cannot be read from; and neither a hub-ring bus nor a consumers-first bus beats
 * the current sheet (12.28 items/s against 18.67, 31 codes without ore). Only the
 * outpost is wired.
 */

import { BUILDING_NAMES } from "./catalogue.js";
import { BUILDING_INFO } from "./layout.js";
import type { Placement, Tile, World } from "./layout.js";
import { mergeSources } from "./placement-links.js";
import type { LinkScheduler, MergeSource } from "./placement-links.js";
import { MINER_RATE, BELT_RATE } from "./rates.js";
import { placeExtractor } from "./spots.js";
import type { TileClaims } from "./spots.js";

/** one deposit code, mined on a single cluster and merged into one belt */
export interface Outpost {
    /** the deposit code this outpost mines, as the mine reads it */
    code: string;
    /** every miner it placed */
    miners: Placement[];
    /** the belt that leaves the outpost */
    root: MergeSource;
    /** items/s the outpost makes: miners × 0.4, never more than a belt */
    rate: number;
}

/** miners one outpost may place: five 0.4/s miners fill a belt */
const MAX_MINERS = Math.max(1, Math.round(BELT_RATE / MINER_RATE));

/**
 * Build the outpost for `code`.
 *
 * `need` is items/s the campaign wants from this code; the outpost places the
 * miners for it and stops at one belt. `from` is where the search starts — the
 * caller's idea of "near" — and every extra miner stays on the cluster the first
 * one found, because a second deposit of the same code is far away (measured
 * median 148 tiles on the full set) and a merge across it only lengthens the run.
 *
 * Returns `null` when the map has no free cell of that code.
 */
export function buildOutpost(
    claims: TileClaims,
    world: World,
    links: LinkScheduler,
    code: string,
    need: number,
    from: Tile,
    make: (kind: "miner" | "merger", serial: number) => { step: string; stepId: string },
    out: Placement[]
): Outpost | null {
    const wanted = Math.max(1, Math.min(MAX_MINERS, Math.ceil(need / MINER_RATE - 1e-9)));
    const miners: Placement[] = [];
    let at = from;
    for (let i = 0; i < wanted; i++) {
        const found = placeExtractor(claims, world, (item) => item.kind === "shape" && item.code === code, at);
        if (!found) break;
        const id = make("miner", i + 1);
        const miner: Placement = {
            step: id.step,
            stepId: id.stepId,
            kind: "base",
            zh: BUILDING_NAMES.base,
            x: found.x,
            y: found.y,
            w: 1,
            h: 1,
            rot: found.rot,
            patch: found.patch,
            distance: found.distance,
        };
        miners.push(miner);
        out.push(miner);
        at = { x: found.x, y: found.y };
    }
    if (!miners.length) return null;
    if (miners.length === 1) {
        return {
            code,
            miners,
            root: { building: miners[0]!, info: BUILDING_INFO.base, outSlot: 0 },
            rate: MINER_RATE,
        };
    }
    const merged = mergeSources(
        claims,
        links,
        miners.map((building): MergeSource => ({ building, info: BUILDING_INFO.base, outSlot: 0 })),
        (serial) => make("merger", serial),
        out
    );
    return {
        code,
        miners,
        root: merged.root,
        rate: Math.min(BELT_RATE, merged.merged * MINER_RATE),
    };
}
