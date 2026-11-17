/**
 * The building vocabulary: one name per machine, for the drawing, the reports
 * and the CLI.
 *
 * Three id spaces meet here and nowhere else:
 *   - `BuildingKind` — what the layout places (`layout.ts` `BUILDING_INFO`);
 *   - `PlanOp` — what a plan step does (`plan.ts`);
 *   - `BuildingId` — what the game unlocks (`solver.ts` `ALL_BUILDINGS`), which
 *     spells the rotater three times and the cutters twice.
 *
 * Every display name comes from `BUILDING_NAMES`; the other two tables only
 * project from it, so a machine cannot end up with two names.
 */
import type { PlanOp } from "./plan.js";
import type { BuildingId } from "./solver.js";

/** every machine the sheet can place: the plan's ops plus the layout's own parts */
export type BuildingKind = PlanOp | "mixer" | "splitter" | "merger" | "trash";

/** the order the drawing legend and the UI legend both use */
export const BUILDING_KINDS: readonly BuildingKind[] = [
    "base",
    "cutHalf",
    "cutQuad",
    "rotate",
    "stack",
    "paint",
    "paint4",
    "mixer",
    "splitter",
    "merger",
    "trash",
];

/** the one name table: drawings, BOM lines, bottleneck labels and the UI read it */
export const BUILDING_NAMES: Record<BuildingKind, string> = {
    base: "采矿机",
    cutHalf: "切割机",
    cutQuad: "四向切割机",
    rotate: "旋转器",
    stack: "堆叠器",
    paint: "上色器",
    paint4: "四色上色器",
    mixer: "混色器",
    splitter: "分流器",
    merger: "合流器",
    trash: "垃圾桶",
};

/**
 * The unlock vocabulary spells the rotater three times and the cutters twice;
 * the labels are derived from the kind names, so renaming a machine renames
 * every checkbox with it.
 */
export const GAME_BUILDING_NAMES: Record<BuildingId, string> = {
    cutter: BUILDING_NAMES.cutHalf,
    quadCutter: BUILDING_NAMES.cutQuad,
    rotaterCW: `${BUILDING_NAMES.rotate} (顺时针)`,
    rotaterCCW: `${BUILDING_NAMES.rotate} (逆时针)`,
    rotater180: `${BUILDING_NAMES.rotate} (180°)`,
    stacker: BUILDING_NAMES.stack,
    painter: BUILDING_NAMES.paint,
    quadPainter: BUILDING_NAMES.paint4,
};
