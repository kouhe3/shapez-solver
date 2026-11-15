/**
 * Real level data from shapez.io 1.5.x (src/js/game/modes/levels.js).
 * Used as a regression corpus and as ready-made targets in the UI.
 */

/**
 * Which part a reward unlocks, straight from the game's
 * `tutorial_goals_mappings.js` (`enumHubGoalRewardsToContentUnlocked`). A
 * reward is granted for *completing* a level, so L8's mixer reward is usable
 * from L9 on — `availableLevels` adds the one level.
 *
 * Rewards that unlock nothing this solver models (wire layer, storage, the
 * endless upgrades) stay empty. Transport pieces count too: the balancer, the
 * splitter, the merger and the tunnel gate what a belt layout can do.
 */
export const REWARD_BUILDINGS = {
    reward_cutter_and_trash: ["cutter"],
    reward_rotater: ["rotaterCW"],
    reward_painter: ["painter"],
    reward_rotater_ccw: ["rotaterCCW"],
    reward_stacker: ["stacker"],
    reward_cutter_quad: ["quadCutter"],
    reward_rotater_180: ["rotater180"],
    reward_wires_painter_and_levers: ["quadPainter"],
    reward_mixer: ["mixer"],
    reward_balancer: ["balancer"],
    reward_tunnel: ["tunnel"],
    reward_merger: ["merger"],
    reward_splitter: ["splitter"],
    reward_painter_double: [],
    reward_blueprints: [],
    reward_miner_chainable: [],
    reward_underground_belt_tier_2: [],
    reward_belt_reader: [],
    reward_storage: [],
    reward_filter: [],
    reward_display: [],
    reward_logic_gates: [],
    reward_virtual_processing: [],
    no_reward: [],
    reward_demo_end: [],
    reward_freeplay: [],
};

export const DEMO_LEVELS = [
    { level: 1, shape: "CuCuCuCu", required: 10, reward: "reward_cutter_and_trash" },
    { level: 2, shape: "----CuCu", required: 20, reward: "no_reward" },
    { level: 3, shape: "RuRuRuRu", required: 30, reward: "reward_balancer" },
    { level: 4, shape: "RuRu----", required: 30, reward: "reward_rotater" },
    { level: 5, shape: "Cu----Cu", required: 75, reward: "reward_tunnel" },
    { level: 6, shape: "Cu------", required: 50, reward: "reward_painter" },
    { level: 7, shape: "CrCrCrCr", required: 85, reward: "reward_rotater_ccw" },
    { level: 8, shape: "RbRb----", required: 100, reward: "reward_mixer" },
    { level: 9, shape: "RpRp----", required: 0, reward: "reward_demo_end" },
];

export const FULL_LEVELS = [
    { level: 1, shape: "CuCuCuCu", required: 30, reward: "reward_cutter_and_trash" },
    { level: 2, shape: "----CuCu", required: 40, reward: "no_reward" },
    { level: 3, shape: "RuRuRuRu", required: 70, reward: "reward_balancer" },
    { level: 4, shape: "RuRu----", required: 70, reward: "reward_rotater" },
    { level: 5, shape: "Cu----Cu", required: 170, reward: "reward_tunnel" },
    { level: 6, shape: "Cu------", required: 270, reward: "reward_painter" },
    { level: 7, shape: "CrCrCrCr", required: 300, reward: "reward_rotater_ccw" },
    { level: 8, shape: "RbRb----", required: 480, reward: "reward_mixer" },
    { level: 9, shape: "CpCpCpCp", required: 600, reward: "reward_merger" },
    { level: 10, shape: "ScScScSc", required: 800, reward: "reward_stacker" },
    { level: 11, shape: "CgScScCg", required: 1000, reward: "reward_miner_chainable" },
    { level: 12, shape: "CbCbCbRb:CwCwCwCw", required: 1000, reward: "reward_blueprints" },
    { level: 13, shape: "RpRpRpRp:CwCwCwCw", required: 3800, reward: "reward_underground_belt_tier_2" },
    { level: 14, shape: "--Cg----:--Cr----", required: 8, reward: "reward_belt_reader", throughputOnly: true },
    { level: 15, shape: "SrSrSrSr:CyCyCyCy", required: 10000, reward: "reward_storage" },
    { level: 16, shape: "SrSrSrSr:CyCyCyCy:SwSwSwSw", required: 6000, reward: "reward_cutter_quad" },
    { level: 17, shape: "CbRbRbCb:CwCwCwCw:WbWbWbWb", required: 20000, reward: "reward_painter_double" },
    { level: 18, shape: "Sg----Sg:CgCgCgCg:--CyCy--", required: 20000, reward: "reward_rotater_180" },
    { level: 19, shape: "CpRpCp--:SwSwSwSw", required: 25000, reward: "reward_splitter" },
    { level: 20, shape: "RuCw--Cw:----Ru--", required: 25000, reward: "reward_wires_painter_and_levers" },
    { level: 21, shape: "CrCwCrCw:CwCrCwCr:CrCwCrCw:CwCrCwCr", required: 25000, reward: "reward_filter" },
    { level: 22, shape: "Cg----Cr:Cw----Cw:Sy------:Cy----Cy", required: 25000, reward: "reward_constant_signal" },
    { level: 23, shape: "CcSyCcSy:SyCcSyCc:CcSyCcSy", required: 25000, reward: "reward_display" },
    { level: 24, shape: "CcRcCcRc:RwCwRwCw:Sr--Sw--:CyCyCyCy", required: 25000, reward: "reward_logic_gates" },
    { level: 25, shape: "Rg--Rg--:CwRwCwRw:--Rg--Rg", required: 25000, reward: "reward_virtual_processing" },
    { level: 26, shape: "CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw", required: 50000, reward: "reward_freeplay" },
];

/**
 * Buildings available while working on a given level: rewards of all
 * previously completed levels (extractors are always available). A part that
 * appears in no level of this version — the demo ends before the stacker — is
 * absent, which callers must read as "never", not "from L1".
 */
export function buildingsForLevel(levels, levelNumber) {
    const set = new Set();
    for (const lvl of levels) {
        if (lvl.level >= levelNumber) break;
        for (const b of REWARD_BUILDINGS[lvl.reward] || []) set.add(b);
    }
    return set;
}

/**
 * The first level each building can actually be used on. A reward is granted
 * for *completing* a level, so a level-3 reward is usable from level 4 on —
 * which is why the balancer (reward of L3) is a level-4 building. Transport
 * pieces are in the table too, under the names the throughput report uses.
 *
 * @param {Array<{level:number, reward:string}>} levels
 * @returns {Map<string, number>} building → first usable level
 */
export function availableLevels(levels) {
    const map = new Map();
    for (const lvl of levels) {
        for (const b of REWARD_BUILDINGS[lvl.reward] || []) if (!map.has(b)) map.set(b, lvl.level + 1);
    }
    return map;
}

