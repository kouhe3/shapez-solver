/**
 * Every shape the game will ever ask you for: level goals + hub upgrade tiers.
 *
 * Copied from shapez.io 1.5.x `src/js/game/modes/regular.js` (`generateUpgrades`)
 * and `src/js/game/modes/levels.js`. The game keeps a permanent record of every
 * shape delivered to the hub — the hub message "您生产过的所有图形都会被用于解锁升级"
 * means old factories should never be torn down — so a campaign plan wants the
 * union of all of them, not one level at a time.
 *
 * Notes:
 *  - amounts are the tier's own requirement; the game additionally charges the
 *    previous tiers' requirements (tierGrowth) for every tier after the first.
 *  - the China build swaps two tiers (see CHINA_VARIANT below); we model the
 *    standard build.
 *  - the demo is the restricted build: it has the fixed tiers but none of the
 *    endless endgame tiers, so `rocket` is full-version only.
 */

import { DEMO_LEVELS, FULL_LEVELS } from "./levels.js";
import type { GameVersion, Level } from "./levels.js";
import * as S from "./shape.js";

export const PREPAREMENT_SHAPE = "CpRpCp--:SwSwSwSw";
export const FINAL_GAME_SHAPE = "RuCw--Cw:----Ru--";
export const ROCKET_SHAPE = "CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw";

/** shapes the China build asks for instead of the standard ones */
export const CHINA_VARIANT: Record<string, string> = {
    miner_t4: "CyCyCyCy:CyCyCyCy:RyRyRyRy:RuRuRuRu",
    painting_t2: "CuCuCuCu:CwCwCwCw:Sb--Sr--",
};

export interface UpgradeRequirement {
    shape: string;
    amount: number;
}

export type TrackId = "belt" | "miner" | "processors" | "painting";

export const UPGRADE_TRACKS: Record<TrackId, UpgradeRequirement[][]> = {
    belt: [
        [{ shape: "CuCuCuCu", amount: 30 }],
        [{ shape: "--CuCu--", amount: 500 }],
        [{ shape: "CpCpCpCp", amount: 1000 }],
        [{ shape: "SrSrSrSr:CyCyCyCy", amount: 6000 }],
        [{ shape: "SrSrSrSr:CyCyCyCy:SwSwSwSw", amount: 25000 }],
        [{ shape: PREPAREMENT_SHAPE, amount: 25000 }],
        [
            { shape: PREPAREMENT_SHAPE, amount: 25000 },
            { shape: FINAL_GAME_SHAPE, amount: 50000 },
        ],
    ],
    miner: [
        [{ shape: "RuRuRuRu", amount: 300 }],
        [{ shape: "Cu------", amount: 800 }],
        [{ shape: "ScScScSc", amount: 3500 }],
        [{ shape: "CwCwCwCw:WbWbWbWb", amount: 23000 }],
        [{ shape: "CbRbRbCb:CwCwCwCw:WbWbWbWb", amount: 50000 }],
        [{ shape: PREPAREMENT_SHAPE, amount: 25000 }],
        [
            { shape: PREPAREMENT_SHAPE, amount: 25000 },
            { shape: FINAL_GAME_SHAPE, amount: 50000 },
        ],
    ],
    processors: [
        [{ shape: "SuSuSuSu", amount: 500 }],
        [{ shape: "RuRu----", amount: 600 }],
        [{ shape: "CgScScCg", amount: 3500 }],
        [{ shape: "CwCrCwCr:SgSgSgSg", amount: 25000 }],
        [{ shape: "WrRgWrRg:CwCrCwCr:SgSgSgSg", amount: 50000 }],
        [{ shape: PREPAREMENT_SHAPE, amount: 25000 }],
        [
            { shape: PREPAREMENT_SHAPE, amount: 25000 },
            { shape: FINAL_GAME_SHAPE, amount: 50000 },
        ],
    ],
    painting: [
        [{ shape: "RbRb----", amount: 600 }],
        [{ shape: "WrWrWrWr", amount: 3800 }],
        [{ shape: "RpRpRpRp:CwCwCwCw", amount: 6500 }],
        [{ shape: "WpWpWpWp:CwCwCwCw:WpWpWpWp", amount: 25000 }],
        [{ shape: "WpWpWpWp:CwCwCwCw:WpWpWpWp:CwCwCwCw", amount: 50000 }],
        [{ shape: PREPAREMENT_SHAPE, amount: 25000 }],
        [
            { shape: PREPAREMENT_SHAPE, amount: 25000 },
            { shape: FINAL_GAME_SHAPE, amount: 50000 },
        ],
    ],
};

export const UPGRADE_LABELS: Record<TrackId, string> = {
    belt: "传送带",
    miner: "采矿机",
    processors: "加工建筑",
    painting: "上色",
};

/** endless endgame tiers: only the unrestricted build has them */
export const ENDGAME_TIERS: UpgradeRequirement[][] = [
    [
        { shape: PREPAREMENT_SHAPE, amount: 30000 },
        { shape: FINAL_GAME_SHAPE, amount: 20000 },
        { shape: ROCKET_SHAPE, amount: 20000 },
    ],
];

/** the requirement sets are keyed by game version — one vocabulary only */
export type NeedSetName = GameVersion;

export interface NeedSet {
    label: string;
    levels: Level[];
    endgame: boolean;
}

export const NEED_SETS: Record<NeedSetName, NeedSet> = {
    demo: { label: "试玩版", levels: DEMO_LEVELS, endgame: false },
    full: { label: "完整版", levels: FULL_LEVELS, endgame: true },
};

export interface ShapeSourceLevel {
    kind: "level";
    level: number;
    required: number;
    reward: string;
}

export interface ShapeSourceUpgrade {
    kind: "upgrade";
    track: TrackId;
    tier: number;
    amount: number;
}

export interface ShapeSourceEndgame {
    kind: "endgame";
    tier: number;
    amount: number;
}

export type ShapeSource = ShapeSourceLevel | ShapeSourceUpgrade | ShapeSourceEndgame;

export interface NeededShape {
    code: string;
    sources: ShapeSource[];
}

/**
 * All shapes a run of the given set needs, in priority order: level goals first
 * (in level order), then upgrade-only shapes by track and tier.
 */
export function neededShapes({ set = "demo" }: { set?: NeedSetName } = {}): NeededShape[] {
    const conf = NEED_SETS[set];
    if (!conf) throw new Error(`unknown need set: ${set}`);

    const byCode = new Map<string, NeededShape>();
    const add = (code: string, source: ShapeSource) => {
        let entry = byCode.get(code);
        if (!entry) {
            entry = { code, sources: [] };
            byCode.set(code, entry);
        }
        entry.sources.push(source);
    };

    for (const lvl of conf.levels) {
        add(lvl.shape, { kind: "level", level: lvl.level, required: lvl.required, reward: lvl.reward });
    }
    for (const track of Object.keys(UPGRADE_TRACKS) as TrackId[]) {
        UPGRADE_TRACKS[track].forEach((required, tier) => {
            for (const req of required) {
                add(req.shape, { kind: "upgrade", track, tier, amount: req.amount });
            }
        });
    }
    if (conf.endgame) {
        ENDGAME_TIERS.forEach((required, tier) => {
            for (const req of required) {
                add(req.shape, { kind: "endgame", tier, amount: req.amount });
            }
        });
    }
    return [...byCode.values()];
}

/**
 * Shape letters (C R S W) a list of targets needs from the map. A letter that
 * never appears as a deposit cannot be built, so the map scan has to know about
 * it before planning: `S`/`W` deposits only start a few chunks out.
 */
export function requiredTypes(shapes: readonly { code: string }[]): Set<string> {
    const types = new Set<string>();
    for (const need of shapes) {
        const parsed = S.tryParse(need.code);
        if (!parsed.ok) continue;
        for (const layer of parsed.shape.layers) {
            for (const cell of layer) if (cell) types.add(cell.t);
        }
    }
    return types;
}

/** one-line Chinese description of why a shape is needed */
export function describeSource(source: ShapeSource): string {
    if (source.kind === "level") {
        return `关卡 ${source.level}（要 ${source.required} 个）`;
    }
    if (source.kind === "upgrade") {
        const label = UPGRADE_LABELS[source.track] || source.track;
        return `${label} T${source.tier + 1}（要 ${source.amount} 个）`;
    }
    return `无尽升级 T${source.tier + 1}（要 ${source.amount} 个）`;
}
