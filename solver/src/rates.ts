/**
 * How fast the game's machines really run, and what that means for a layout.
 *
 * Every number here is read off the game, not guessed:
 *   - `hub_goals.js` `getProcessorBaseSpeed()` = beltSpeed × upgrade × buildingSpeeds[type]
 *   - `globalConfig.beltSpeedItemsPerSecond = 2`
 *   - `globalConfig.buildingSpeeds = { cutter: .25, painter: 1/6, mixer: .2, stacker: 1/8, … }`
 *   - `globalConfig.minerSpeedItemsPerSecond`, patched to .4 in the bundle
 *
 * All values are for upgrade level 1 — the state a campaign starts in. Upgrades
 * multiply the whole column, so a rate at level N is `rate × upgradeMultiplier`.
 */

import type { PlanOp } from "./plan.js";
import { BUILDING_NAMES } from "./catalogue.js";

/** the only field a rate reads off a plan step */
export interface RatedStep {
    op: PlanOp;
}

/** the machine that caps a chain — the one to upgrade or duplicate first */
export interface Bottleneck {
    op: PlanOp;
    zh: string;
    rate: number;
}

/** items/s a single belt carries */
export const BELT_RATE: number = 2;

/** items/s a single miner produces */
export const MINER_RATE: number = 0.4;

/** items/s a single colour source (miner on a deposit, or one mixer) produces */
export const SOURCE_RATE: number = 0.4;

/**
 * a 4×4 hub has 12 perimeter tiles but 16 entry slots: the four corner tiles
 * each take a belt from both outward sides (`ref/buildings/hub.js:79-82`).
 */
export const HUB_ENTRIES: number = 16;

/** items/s each plan op processes; `base` is the miner */
export const STEP_RATE: Record<PlanOp | "mixer", number> = {
    base: MINER_RATE,
    cutHalf: 0.5,
    cutQuad: 0.5,
    rotate: 2,
    stack: 0.25,
    paint: 2 / 6,
    paint4: 1,
    mixer: 0.4,
};

/**
 * A factory is one chain: every machine sees every item, so the slowest machine
 * sets the output rate. `steps` is a flattened plan (`plan.js` `flatten`).
 */
export function chainRate(steps: readonly RatedStep[]): number {
    let rate = Infinity;
    for (const step of steps) {
        const r = STEP_RATE[step.op];
        if (r === undefined) continue;
        if (r < rate) rate = r;
    }
    return Number.isFinite(rate) ? rate : 0;
}

/**
 * Items/s a factory can deliver once its miners are sized to feed it.
 *
 * A plan step processes at its machine rate, so the slowest machine still caps
 * the chain — but `base` is not a cap: miners are the one machine the game lets
 * you duplicate freely (five of them fill a belt), and a layout that places one
 * miner per base step leaves a cutter (0.5/s) or a quad painter (1/s) starved.
 * Before the merger unlocks there is no way to join several miners into one
 * belt, so the miner rate stays the cap.
 */
export function factoryRate(steps: readonly RatedStep[], canMerge: boolean = true): number {
    let rate = BELT_RATE;
    for (const step of steps) {
        if (step.op === "base") continue;
        const r = STEP_RATE[step.op];
        if (r !== undefined && r < rate) rate = r;
    }
    // a pure mining outpost fills a belt; a mixed chain is capped by its machine.
    // Measured 2026-11-18: stopping one miner short (1.6/s) takes the sheet from
    // 7 critical merge points to 1, but costs 16% of the delivery and leaves a
    // gap the drawing is refused for, so the full belt stays.
    return canMerge ? rate : Math.min(rate, MINER_RATE);
}

/** miners one base step needs to supply `rate` items/s, clamped to one belt */
export function minerCount(rate: number): number {
    const perBelt = Math.max(1, Math.round(BELT_RATE / MINER_RATE));
    return Math.max(1, Math.min(perBelt, Math.ceil(rate / MINER_RATE - 1e-9)));
}

/** the slowest machine of a chain, or `null` for an empty one */
export function bottleneck(steps: readonly RatedStep[]): Bottleneck | null {
    let worst: Bottleneck | null = null;
    for (const step of steps) {
        const r = STEP_RATE[step.op];
        if (r === undefined) continue;
        if (!worst || r < worst.rate) worst = { op: step.op, zh: BUILDING_NAMES[step.op], rate: r };
    }
    return worst;
}

/** items/s → "15.0/分" */
export function formatRate(rate: number): string {
    if (!Number.isFinite(rate) || rate <= 0) return "—";
    return `${(rate * 60).toFixed(1)}/分`;
}

/** seconds → "42s" / "18m" / "3.2h" / "2.1d" */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "—";
    if (seconds < 90) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(0)}m`;
    if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
}
