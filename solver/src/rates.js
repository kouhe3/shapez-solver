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

/** items/s a single belt carries */
export const BELT_RATE = 2;

/** items/s a single miner produces */
export const MINER_RATE = 0.4;

/** items/s a single colour source (miner on a deposit, or one mixer) produces */
export const SOURCE_RATE = 0.4;

/** a 4×4 hub has 12 perimeter tiles, so at most 12 belts can enter it directly */
export const HUB_SIDES = 12;

/** items/s each plan op processes; `base` is the miner */
export const STEP_RATE = {
    base: MINER_RATE,
    cutHalf: 0.5,
    cutQuad: 0.5,
    rotate: 2,
    stack: 0.25,
    paint: 2 / 6,
    paint4: 1,
    mixer: 0.4,
};

/** Chinese label per kind, for the bottleneck line */
const KIND_ZH = {
    base: "采矿机",
    cutHalf: "切割机",
    cutQuad: "四向切割机",
    rotate: "旋转器",
    stack: "堆叠器",
    paint: "上色器",
    paint4: "四色上色器",
    mixer: "混色器",
};

/**
 * A factory is one chain: every machine sees every item, so the slowest machine
 * sets the output rate. `steps` is a flattened plan (`plan.js` `flatten`).
 *
 * @param {Array<{op: string}>} steps
 * @returns {number} items/s
 */
export function chainRate(steps) {
    let rate = Infinity;
    for (const step of steps) {
        const r = STEP_RATE[step.op];
        if (r === undefined) continue;
        if (r < rate) rate = r;
    }
    return Number.isFinite(rate) ? rate : 0;
}

/**
 * The machine that caps the chain — the one to upgrade or duplicate first.
 *
 * @param {Array<{op: string}>} steps
 * @returns {{op: string, zh: string, rate: number}|null}
 */
export function bottleneck(steps) {
    let worst = null;
    for (const step of steps) {
        const r = STEP_RATE[step.op];
        if (r === undefined) continue;
        if (!worst || r < worst.rate) worst = { op: step.op, zh: KIND_ZH[step.op] || step.op, rate: r };
    }
    return worst;
}

/** items/s → "15.0/分" */
export function formatRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return "—";
    return `${(rate * 60).toFixed(1)}/分`;
}

/** seconds → "42s" / "18m" / "3.2h" / "2.1d" */
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "—";
    if (seconds < 90) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(0)}m`;
    if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
}
