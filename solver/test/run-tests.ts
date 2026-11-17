/**
 * Regression + corpus tests.
 *   bun run test                     # everything
 *   bun run test --quick             # unit tests only
 *   bun run test --timings           # one check/fail/ms line per section
 *   bun run test --filter=<regex>    # only checks whose section or label matches
 */

import * as S from "../src/shape.js";
import * as P from "../src/plan.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel, availableLevels } from "../src/levels.js";
import { generateChunk, scanMap, scanForTypes, availableResources, patchMinerCapacity } from "../src/map.js";
import type { Patch } from "../src/map.js";
import { compressX64, decompressX64 } from "../src/lz_factory.js";
import { compressObject, decompressObject, savegameMapInfo } from "../src/savegame.js";
import {
    BUILDING_INFO,
    expandPlanTree,
    planBom,
    fuseCuts,
    fusedCost,
    createWorld,
    routeBelt,
    releaseRoute,
    cellKey,
    portCells,
    portApproachCells,
    rotatedSize,
} from "../src/layout.js";
import { buildLayout, createPlacementSession, DEFAULT_TUNING } from "../src/placement.js";
import { colourGap, sizeColorSupply } from "../src/color-supply.js";
import { createLinkScheduler } from "../src/placement-links.js";
import { createTileClaims } from "../src/spots.js";
import type { Connection, Placement, Tile, World } from "../src/layout.js";
import { BUILDING_NAMES } from "../src/catalogue.js";
import type { BuildingKind } from "../src/catalogue.js";
import { schematicSVG } from "../src/schematic.js";
import type { SchematicLayout } from "../src/schematic.js";
import { colorChain, colorChains } from "../src/color.js";
import { chainRate, formatDuration } from "../src/rates.js";
import { neededShapes, requiredTypes } from "../src/needs.js";
import { planCampaign } from "../src/campaign.js";
import { validateSheet } from "../src/validate.js";
import { recipeDiagram } from "../src/recipe.js";
import { initRouterWasm } from "../src/router-engine.js";
import { readFileSync } from "node:fs";

initRouterWasm(readFileSync(new URL("../router.wasm", import.meta.url)));

const argv = process.argv.slice(2);
const quick = argv.includes("--quick");
const timings = argv.includes("--timings");

let filter: RegExp | null = null;
const filterArg = argv.find((a) => a.startsWith("--filter="));
if (argv.includes("--filter")) {
    console.log("usage: bun run test [--quick] [--timings] [--filter=<regex>]");
    process.exit(2);
}
if (filterArg !== undefined) {
    const pattern = filterArg.slice("--filter=".length);
    if (!pattern) {
        console.log("usage: --filter needs a non-empty regular expression");
        process.exit(2);
    }
    try {
        filter = new RegExp(pattern);
    } catch {
        console.log(`bad --filter regular expression: ${pattern}`);
        process.exit(2);
    }
}

let failures = 0;
let checks = 0;
let skipped = 0;
let matched = 0;
let section = "";
let sectionChecks = 0;
let sectionFailures = 0;
let sectionStart = 0;

/** `--timings` prints one line per section; the next section flushes the previous one. */
function sectionSummary(): void {
    if (!timings || !section) return;
    const ms = performance.now() - sectionStart;
    console.log(`  (${sectionChecks} checks, ${sectionFailures} fail, ${ms.toFixed(1)} ms)`);
}

function beginSection(name: string): void {
    sectionSummary();
    section = name;
    sectionChecks = 0;
    sectionFailures = 0;
    sectionStart = performance.now();
    console.log(`== ${name} ==`);
}

/** `--filter` keeps a check only when the section name or the check label matches. */
function selected(label: string): boolean {
    if (!filter) return true;
    if (filter.test(section) || filter.test(label)) {
        matched++;
        return true;
    }
    skipped++;
    return false;
}

function check(label: string, actual: unknown, expected: unknown): void {
    if (!selected(label)) return;
    checks++;
    sectionChecks++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failures++;
        sectionFailures++;
        console.log(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
}

function checkTrue(label: string, condition: boolean, detail = ""): void {
    if (!selected(label)) return;
    checks++;
    sectionChecks++;
    if (!condition) {
        failures++;
        sectionFailures++;
        console.log(`  FAIL ${label} ${detail}`);
    }
}

beginSection("shape codec");
{
    const shape = S.parse("RuCw--Cw");
    check("hash round-trip", S.hash(shape), "RuCw--Cw");
    check("q0", shape.layers[0]![0], { t: "R", c: "u" });
    check("q1", shape.layers[0]![1], { t: "C", c: "w" });
    check("q2", shape.layers[0]![2], null);
    check("q3", shape.layers[0]![3], { t: "C", c: "w" });

    const two = S.parse("RuCw--Cw:----Ru--");
    check("two layers", two.layers.length, 2);
    check("layer1 q2", two.layers[1]![2], { t: "R", c: "u" });
    check("two layer hash", S.hash(two), "RuCw--Cw:----Ru--");

    check("invalid: short", S.tryParse("Cu").ok, false);
    check("invalid: bad type", S.tryParse("XuCuCuCu").ok, false);
    check("invalid: empty layer", S.tryParse("--------").ok, false);
    check("invalid: color on empty", S.tryParse("-u------").ok, false);
    check("invalid: 5 layers", S.tryParse("CuCuCuCu:CuCuCuCu:CuCuCuCu:CuCuCuCu:CuCuCuCu").ok, false);
}

beginSection("rotations (game order: 0=TR 1=BR 2=BL 3=TL)");
{
    const top = S.parse("Cu----Cu"); // q0 + q3 = top row
    check("CW(top row) = right column", S.hash(S.rotateCW(top)), "CuCu----");
    check("CCW(top row) = left column", S.hash(S.rotateCCW(top)), "----CuCu");
    check("180(top row) = bottom row", S.hash(S.rotate180(top)), "--CuCu--");
    check("CW x4 = identity", S.hash(S.rotateCW(S.rotateCW(S.rotateCW(S.rotateCW(top))))), "Cu----Cu");

    const bevel = S.parse("RuCw--Cw");
    // new = [q2, q3, q0, q1] => [null, Cw, Ru, Cw]
    check("180 bevel", S.hash(S.rotate180(bevel)), "--CwRuCw");
}

beginSection("cutting");
{
    const circle = S.parse("CuCuCuCu");
    const [left, right] = S.cutHalf(circle);
    check("cut half A ({2,3})", S.hash(left), "----CuCu");
    check("cut half B ({0,1})", S.hash(right), "CuCu----");
    const quads = S.cutQuad(circle).map(S.hash);
    check("cut quad", quads, ["Cu------", "--Cu----", "----Cu--", "------Cu"]);

    // cutting a half along the other axis: rotate first
    const [a, b] = S.cutHalf(S.rotateCW(right));
    check("rotated half cut", [S.hash(a), S.hash(b)], ["----Cu--", "--Cu----"]);
}

beginSection("stacker (issues #313 recipe)");
{
    const p1 = S.parse("Ru----Cw");
    const p2 = S.parse("Ru--Ru--");
    const stacked = S.stack(p1, p2);
    check("stack support", S.hash(stacked), "Ru----Cw:Ru--Ru--");

    const [leftHalf, rightHalf] = S.cutHalf(stacked);
    check("cut scaffold away", S.hash(leftHalf), "------Cw:----Ru--");

    const logo = S.stack(S.parse("------Cw:----Ru--"), S.parse("RuCw----"));
    check("final logo shape", S.hash(logo), "RuCw--Cw:----Ru--");

    // the stacker is commutative here: the same target comes out either way
    check("reverse stack also works", S.hash(S.stack(S.parse("RuCw----"), S.parse("------Cw:----Ru--"))), "RuCw--Cw:----Ru--");
}

beginSection("blueprint ports (official ItemEjector/ItemAcceptor slots)");
{
    // Coordinates are tile boundary midpoints relative to the building origin,
    // y growing down. Mirrors src/js/game/buildings/*.js (default rotation).
    check("miner out", BUILDING_INFO.base.outs, [{ x: 0.5, y: 0 }]);
    check("rotater in/out", [BUILDING_INFO.rotate.ins, BUILDING_INFO.rotate.outs], [
        [{ x: 0.5, y: 1 }],
        [{ x: 0.5, y: 0 }],
    ]);
    check("cutter in/out", [BUILDING_INFO.cutHalf.ins, BUILDING_INFO.cutHalf.outs], [
        [{ x: 0.5, y: 1 }],
        [
            { x: 0.5, y: 0 },
            { x: 1.5, y: 0 },
        ],
    ]);
    check("quad cutter outs", BUILDING_INFO.cutQuad.outs, [
        { x: 0.5, y: 0 },
        { x: 1.5, y: 0 },
        { x: 2.5, y: 0 },
        { x: 3.5, y: 0 },
    ]);
    check("stacker ins", BUILDING_INFO.stack.ins, [
        { x: 0.5, y: 1 },
        { x: 1.5, y: 1 },
    ]);
    check("painter in/out", [BUILDING_INFO.paint.ins, BUILDING_INFO.paint.outs], [
        [
            { x: 0, y: 0.5 },
            { x: 1.5, y: 0, kind: "color" },
        ],
        [{ x: 2, y: 0.5 }],
    ]);
    check("quad painter ins (colors enter from the bottom)", BUILDING_INFO.paint4.ins, [
        { x: 0, y: 0.5 },
        { x: 0.5, y: 1, kind: "color" },
        { x: 1.5, y: 1, kind: "color" },
        { x: 2.5, y: 1, kind: "color" },
        { x: 3.5, y: 1, kind: "color" },
    ]);
    // `ref/buildings/balancer.js` 1×1 variants: splitter = one south input,
    // north + east outputs; merger = south + east inputs, one north output.
    check("splitter in/out", [BUILDING_INFO.splitter.ins, BUILDING_INFO.splitter.outs], [
        [{ x: 0.5, y: 1 }],
        [
            { x: 0.5, y: 0 },
            { x: 1, y: 0.5 },
        ],
    ]);
    check("merger in/out", [BUILDING_INFO.merger.ins, BUILDING_INFO.merger.outs], [
        [
            { x: 0.5, y: 1 },
            { x: 1, y: 0.5 },
        ],
        [{ x: 0.5, y: 0 }],
    ]);
    check("splitter port tiles", portCells(BUILDING_INFO.splitter, 10, 10, 0), [
        { x: 10, y: 11 },
        { x: 10, y: 9 },
        { x: 11, y: 10 },
    ]);
    check("merger port tiles", portCells(BUILDING_INFO.merger, 10, 10, 0), [
        { x: 10, y: 11 },
        { x: 11, y: 10 },
        { x: 10, y: 9 },
    ]);
}

beginSection("blueprint: connections use the right output slot");
{
    // One synthetic circle patch; hub far away so placement stays deterministic.
    const patches: Patch[] = [{ x: 0, y: 0, size: 2, item: { kind: "shape", code: "CuCuCuCu" } }];
    const hub = { x: 40, y: 40 };
    const plans: Array<[string, P.PlanNode, number, number]> = [
        [
            "cutHalf side 1",
            P.stackNode(P.cutHalfNode(1, P.baseNode("C")), P.paintNode("w", P.baseNode("C"))),
            1,
            1.5,
        ],
        [
            "cutQuad q1",
            P.stackNode(P.cutQuadNode(1, P.baseNode("C")), P.paintNode("w", P.baseNode("C"))),
            1,
            1.5,
        ],
        [
            "cutQuad q3",
            P.stackNode(P.cutQuadNode(3, P.baseNode("C")), P.paintNode("w", P.baseNode("C"))),
            3,
            3.5,
        ],
    ];
    for (const [label, plan, slot, dx] of plans) {
        const layout = buildLayout({ plan, patches, hub });
        const source = layout.steps.find((s) => s.node.op.startsWith("cut"))!;
        const connection = layout.connections.find(
            (c) => c.from === source.id && c.to === layout.steps.at(-1)!.id
        );
        checkTrue(`${label}: connection exists`, !!connection);
        if (!connection) continue;
        check(`${label}: output slot`, connection.outSlot, slot);
        const building = layout.buildings.find((b) => b.stepId === source.id)!;
        check(`${label}: port x`, connection.x1, building.x + dx);
        check(`${label}: port y`, connection.y1, building.y);
    }

    const paint4 = buildLayout({
        plan: P.paint4Node(["r", null, "b", null], P.baseNode("C")),
        patches,
        hub,
    });
    const painter = paint4.buildings.find((b) => b.kind === "paint4")!;
    check("paint4 colors for port labels", painter.colors, ["r", null, "b", null]);
}

beginSection("layout: a turned part keeps its ports on the game's own edges");
{
    // `Vector.rotateFastMultipleOf90(90)` maps (x, y) to (-y, x) and every slot
    // direction turns with it, so a clockwise cutter puts its south input on the
    // west edge and both north outputs on the east edge — slot 0 topmost.
    const cutter = { x: 10, y: 10 };
    check("turned cutter: footprint is 1×2", rotatedSize(BUILDING_INFO.cutHalf, 1), { w: 1, h: 2 });
    check("turned cutter: input faces west", portCells(BUILDING_INFO.cutHalf, cutter.x, cutter.y, 1)[0], { x: 9, y: 10 });
    check(
        "turned cutter: outputs face east, slot 0 upper",
        portCells(BUILDING_INFO.cutHalf, cutter.x, cutter.y, 1).slice(1),
        [
            { x: 11, y: 10 },
            { x: 11, y: 11 },
        ]
    );
    check(
        "turned cutter: each approach is one more tile out",
        portApproachCells(BUILDING_INFO.cutHalf, cutter.x, cutter.y, 1),
        [
            { x: 8, y: 10 },
            { x: 12, y: 10 },
            { x: 12, y: 11 },
        ]
    );
    check(
        "half-turn cutter: input moves to the far end and faces north",
        portCells(BUILDING_INFO.cutHalf, cutter.x, cutter.y, 2),
        [
            { x: 11, y: 9 },
            { x: 11, y: 11 },
            { x: 10, y: 11 },
        ]
    );

    // every port of every part, at every turn, has to sit outside the body and
    // touch it on exactly one edge — otherwise the belt it draws is unreachable
    const offenders: string[] = [];
    for (const kind of Object.keys(BUILDING_INFO) as BuildingKind[]) {
        const info = BUILDING_INFO[kind];
        for (const rot of [0, 1, 2, 3] as const) {
            const size = rotatedSize(info, rot);
            const body = new Set<string>();
            for (let dx = 0; dx < size.w; dx++) {
                for (let dy = 0; dy < size.h; dy++) body.add(`${dx}|${dy}`);
            }
            for (const c of portCells(info, 0, 0, rot)) {
                const touches =
                    body.has(`${c.x - 1}|${c.y}`) ||
                    body.has(`${c.x + 1}|${c.y}`) ||
                    body.has(`${c.x}|${c.y - 1}`) ||
                    body.has(`${c.x}|${c.y + 1}`);
                if (body.has(`${c.x}|${c.y}`) || !touches) offenders.push(`${kind}@${rot}:( ${c.x},${c.y})`);
            }
            for (const c of portApproachCells(info, 0, 0, rot)) {
                if (body.has(`${c.x}|${c.y}`)) offenders.push(`${kind}@${rot} approach (${c.x},${c.y})`);
            }
        }
    }
    check("every port of every turn sits on the body's edge", offenders, []);
}

beginSection("blueprint: the finished product is belted into the hub");
{
    // A bare miner still needs one belt run into the hub; it used to vanish from
    // the layout entirely, leaving 传送带约 0 格 and no flow line on the sheet.
    const patches: Patch[] = [{ x: 0, y: 0, size: 2, item: { kind: "shape", code: "CuCuCuCu" } }];
    const hub = { x: 40, y: 40 };

    const bare = buildLayout({ plan: P.baseNode("C"), patches, hub });
    const leg = bare.connections.find((c) => c.toHub);
    checkTrue("base-only plan: hub belt exists", !!leg);
    if (leg) {
        check("base-only plan: hub entry tile", [leg.x2, leg.y2], [40.5, 40.5]);
        check("base-only plan: hub belt tiles", leg.beltTiles, 81);
    }
    check("base-only plan: estimate counts the hub leg", bare.beltEstimate, 81);

    const built = buildLayout({ plan: P.cutHalfNode(0, P.baseNode("C")), patches, hub });
    check("processing plan: exactly one hub belt", built.connections.filter((c) => c.toHub).length, 1);
    check(
        "processing plan: estimate is the sum of every leg",
        built.beltEstimate,
        built.connections.reduce((n, c) => n + c.beltTiles, 0)
    );
}

beginSection("blueprint: mixed colours get a mixer");
{
    // RpRp---- needs purple paint, which the map only has as red + blue. The
    // sheet used to print "需混合 r+b" and leave the painter's colour port bare.
    const patches = scanMap(47742, { chunkRadius: 8 });
    const res = solve("RpRp----", { baseCodes: ["CuCuCuCu", "RuRuRuRu"] });
    checkTrue("purple: solved", res.ok, res.error || "");
    const layout = buildLayout({ plan: res.plan!, patches, hub: { x: -2, y: -2 } });

    const mixer = layout.buildings.find((b) => b.kind === "mixer");
    const painter = layout.buildings.find((b) => b.kind === "paint");
    checkTrue("purple: mixer placed", !!mixer);
    checkTrue("purple: painter placed", !!painter);
    check(
        "purple: mixer fed by two colour miners",
        mixer ? layout.connections.filter((c) => c.color && c.to === mixer.stepId).length : 0,
        2
    );
    checkTrue(
        "purple: painter colour input is belted",
        !!painter && layout.connections.some((c) => c.color && c.to === painter.stepId && c.slot === 1)
    );
    check(
        "purple: colour summary",
        layout.colors.map((c) => [c.color, c.mix]),
        [["p", ["r", "b"]]]
    );
    check("purple: nothing missing", layout.missing, []);
}

beginSection("colour plan: the single-shape recipe names the mixer");
{
    // the plan ops only carry a colour as data; the chain that produces that
    // colour (mixers + colour miners) has to be reported next to them
    const res = solve("RpRp----", { baseCodes: ["CuCuCuCu", "RuRuRuRu"] });
    const chains = colorChains(res.flat!.steps);
    check("colour plan: one chain per colour port", chains.length, 1);
    check("colour plan: chain colour", chains[0] && chains[0].color, "p");
    check(
        "colour plan: chain ops (dependencies first)",
        chains[0] && chains[0].ops.map((op) => [op.kind, op.color]),
        [["base", "r"], ["base", "b"], ["mixer", "p"]]
    );
    check(
        "colour chain: white needs two mixers",
        colorChain("w").filter((op) => op.kind === "mixer").map((op) => op.color),
        ["y", "w"]
    );

    const bom = planBom(expandPlanTree(res.flat!));
    const byZh = Object.fromEntries(bom.map((b): [string, number] => [b.zh, b.n]));
    check("colour plan: BOM has one mixer", byZh["混色器"], 1);
    check("colour plan: BOM has three miners", byZh["采矿机"], 3);
    check("colour plan: BOM has one trash can", byZh["垃圾桶"], 1);
    // the recipe and the drawing must count the same machines
    const patches = scanMap(47742, { chunkRadius: 8 });
    const layout = buildLayout({ plan: res.plan!, patches, hub: { x: -2, y: -2 } });
    check(
        "colour plan: BOM equals the drawing BOM",
        Object.entries(byZh).sort(),
        layout.bom.map((b): [string, number] => [b.zh, b.n]).sort()
    );
}

beginSection("levels: when each part unlocks");
{
    const demo = availableLevels(DEMO_LEVELS);
    check("demo: cutter usable from L2", demo.get("cutter"), 2);
    check("demo: painter usable from L7", demo.get("painter"), 7);
    check("demo: mixer usable from L9", demo.get("mixer"), 9);
    check("demo: stacker never unlocks", demo.has("stacker"), false);
    const full = availableLevels(FULL_LEVELS);
    check("full: mixer usable from L9", full.get("mixer"), 9);
    check("full: stacker usable from L11", full.get("stacker"), 11);
    check(
        "demo L9 building set",
        [...buildingsForLevel(DEMO_LEVELS, 9)].sort(),
        ["balancer", "cutter", "mixer", "painter", "rotaterCCW", "rotaterCW", "tunnel"].sort()
    );
    check("full L10 has no stacker yet", buildingsForLevel(FULL_LEVELS, 10).has("stacker"), false);
    check("full L11 has the stacker", buildingsForLevel(FULL_LEVELS, 11).has("stacker"), true);
}

beginSection("router: walls, tunnels, dead ends");
{
    const world = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    // a vertical wall with exactly one gap at y = 0
    for (let y = -5; y <= 5; y++) if (y !== 0) world.walls.add(cellKey(0, y));
    const through = routeBelt(world, world.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, { allowCross: true, dryRun: true });
    checkTrue("router: uses the gap in a wall", !!through && through.cells.some((c) => c.x === 0 && c.y === 0));
    check("router: gap route is the straight run", through && through.cells.length, 5);

    // a one-tile wall is exactly what a tunnel is for: only the ends of a run
    // are buildings, so it passes underneath the body
    const thin = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let y = -30; y <= 30; y++) thin.walls.add(cellKey(0, y));
    const under = routeBelt(thin, thin.walls, { x: -2, y: 2 }, { x: 2, y: 2 }, { allowCross: true, margin: 10, dryRun: true });
    checkTrue(
        "router: tunnels under a one-tile wall",
        !!under && under.spans.length === 1 && under.spans[0]!.cells.some((c) => c.x === 0 && c.y === 2)
    );
    const beforeTunnel = routeBelt(thin, thin.walls, { x: -2, y: 2 }, { x: 2, y: 2 }, { allowCross: false, margin: 10, dryRun: true });
    check("router: before L6 a one-tile wall seals", beforeTunnel, null);

    // deeper than one tier-0 tunnel: five tiles of wall cannot be crossed
    const sealed = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let x = 0; x < 5; x++) for (let y = -30; y <= 30; y++) sealed.walls.add(cellKey(x, y));
    const dead = routeBelt(sealed, sealed.walls, { x: -2, y: 2 }, { x: 7, y: 2 }, { allowCross: true, margin: 10, dryRun: true });
    check("router: a wall deeper than a tunnel has no route", dead, null);

    // a belt across the only straight run: crossing needs a tunnel, and the
    // tunnel only goes under a perpendicular belt
    const crossing = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let y = -1; y <= 1; y++) crossing.belts.set(cellKey(0, y), "v");
    const tunnel = routeBelt(crossing, crossing.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, { allowCross: true, dryRun: true });
    check("router: crosses a perpendicular belt", tunnel && tunnel.crossings, [{ x: 0, y: 0 }]);
    const noTunnel = routeBelt(crossing, crossing.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, { allowCross: false, dryRun: true });
    checkTrue(
        "router: before L6 it goes around",
        !!noTunnel && noTunnel.cells.every((c) => !(c.x === 0 && c.y === 0))
    );
    // a turn belt has no straight direction, so `relaxCross` (the repair pass)
    // may cross under it
    const turning = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    turning.belts.set(cellKey(0, 0), "turn");
    const relaxed = routeBelt(turning, turning.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, {
        allowCross: true,
        relaxCross: true,
        dryRun: true,
    });
    check("router: relaxed crossing takes a turn belt", relaxed && relaxed.crossings, [{ x: 0, y: 0 }]);

    // rip-up needs a reversible claim: lay a run, release it, world unchanged
    const reusable = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let y = -1; y <= 1; y++) reusable.belts.set(cellKey(0, y), "v");
    const before = {
        belts: [...reusable.belts].sort((l, r) => l[0] - r[0]),
        under: [...reusable.tunnelUnder].sort((l, r) => l[0] - r[0]),
        ends: [...reusable.tunnelEnds].sort((l, r) => l[0] - r[0]),
        crossings: [...reusable.tunnelCells].sort((l, r) => l - r),
    };
    const laid = routeBelt(reusable, reusable.walls, { x: -3, y: 0 }, { x: 3, y: 0 }, { allowCross: true });
    checkTrue("rip-up: the run is laid", !!laid);
    check("rip-up: the run claims belts", reusable.belts.size > before.belts.length, true);
    if (laid) releaseRoute(reusable, laid);
    check("rip-up: belts restored", [...reusable.belts].sort((l, r) => l[0] - r[0]), before.belts);
    check("rip-up: tunnel ends restored", [...reusable.tunnelEnds].sort((l, r) => l[0] - r[0]), before.ends);
    check("rip-up: tunnel-under bits restored", [...reusable.tunnelUnder].sort((l, r) => l[0] - r[0]), before.under);
    check("rip-up: crossings restored", [...reusable.tunnelCells].sort((l, r) => l - r), before.crossings);
}

beginSection("router: tunnel legality (span limit, straight ends, own tile)");
{
    /** a one-row corridor with walls on every other tile, so only y = 0 is usable */
    const sealedCorridor = (world: World, fromX: number, toX: number): void => {
        for (let x = fromX; x <= toX; x++) {
            for (let y = -6; y <= 6; y++) if (y !== 0) world.walls.add(cellKey(x, y));
        }
        world.walls.add(cellKey(fromX - 1, 0));
        world.walls.add(cellKey(toX + 1, 0));
    };
    // four consecutive belts: one tunnel may stay under at most 4 tiles
    const four = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let x = 0; x <= 3; x++) four.belts.set(cellKey(x, 0), "v");
    sealedCorridor(four, -2, 5);
    const deep = routeBelt(four, four.walls, { x: -2, y: 0 }, { x: 5, y: 0 }, { allowCross: true, dryRun: true });
    check("tunnel: four underground tiles are one span", deep && deep.spans.length, 1);
    check("tunnel: span tiles", deep && deep.spans[0]!.cells, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
    ]);
    check("tunnel: ends sit right before and after the run", deep && [deep.spans[0]!.sender, deep.spans[0]!.receiver], [
        { x: -1, y: 0 },
        { x: 4, y: 0 },
    ]);
    check("tunnel: flow direction", deep && [deep.spans[0]!.dx, deep.spans[0]!.dy], [1, 0]);

    // five consecutive belts cannot be spanned by one tunnel and cannot be
    // split (there is no free tile between them), so the link is unroutable
    const five = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let x = 0; x <= 4; x++) five.belts.set(cellKey(x, 0), "v");
    sealedCorridor(five, -2, 6);
    const tooDeep = routeBelt(five, five.walls, { x: -2, y: 0 }, { x: 6, y: 0 }, { allowCross: true, dryRun: true });
    check("tunnel: five underground tiles are impossible", tooDeep, null);

    // the sender has to sit on a straight run: an L-shaped corridor that turns
    // into the crossing cannot be built
    const bent = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    const corridor: Record<string, true> = { "-1|0": true, "0|0": true, "0|-1": true, "0|-2": true };
    for (let x = -5; x <= 5; x++) {
        for (let y = -6; y <= 4; y++) if (!corridor[x + "|" + y]) bent.walls.add(cellKey(x, y));
    }
    bent.belts.set(cellKey(0, -1), "h");
    const turnIn = routeBelt(bent, bent.walls, { x: -1, y: 0 }, { x: 0, y: -2 }, { allowCross: true, dryRun: true });
    check("tunnel: a sender on a turn is rejected", turnIn, null);

    // two crossings two tiles apart with a bend between them would need the
    // same tile for one receiver and the next sender
    const gapTwo = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    const gapCells: Record<string, true> = { "-1|0": true, "0|0": true, "1|0": true, "1|-1": true, "1|-2": true };
    for (let x = -5; x <= 5; x++) {
        for (let y = -6; y <= 4; y++) if (!gapCells[x + "|" + y]) gapTwo.walls.add(cellKey(x, y));
    }
    gapTwo.belts.set(cellKey(0, 0), "v");
    gapTwo.belts.set(cellKey(1, -1), "h");
    const bentGap = routeBelt(gapTwo, gapTwo.walls, { x: -1, y: 0 }, { x: 1, y: -2 }, { allowCross: true, dryRun: true });
    check("tunnel: two crossings two apart with a bend are rejected", bentGap, null);

    // a tunnel end is a building on its tile: no belt there, but a belt of a
    // different direction may pass underneath
    const endWorld = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    endWorld.tunnelEnds.set(cellKey(0, 0), 0);
    const acrossEnd = routeBelt(endWorld, endWorld.walls, { x: 0, y: -2 }, { x: 0, y: 2 }, { allowCross: true, dryRun: true });
    checkTrue("tunnel end: a perpendicular belt may pass underneath", !!acrossEnd);
    check("tunnel end: the pass is one underground tile", acrossEnd && acrossEnd.spans[0] && acrossEnd.spans[0].cells, [
        { x: 0, y: 0 },
    ]);
    const alongEnd = routeBelt(endWorld, endWorld.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, { allowCross: true, dryRun: true });
    checkTrue(
        "tunnel end: a same-direction belt goes around",
        !!alongEnd && alongEnd.spans.every((span) => !span.cells.some((c) => c.x === 0 && c.y === 0))
    );
    const noTunnel = routeBelt(endWorld, endWorld.walls, { x: 0, y: -2 }, { x: 0, y: 2 }, { allowCross: false, dryRun: true });
    checkTrue(
        "tunnel end: before L6 the tile is closed",
        !!noTunnel && noTunnel.cells.every((c) => !(c.x === 0 && c.y === 0))
    );

    // claiming: ends become buildings (no belt), the underground tile remembers
    // the tunnel's direction
    const claim = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let y = -1; y <= 1; y++) claim.belts.set(cellKey(0, y), "v");
    const claimed = routeBelt(claim, claim.walls, { x: -2, y: 0 }, { x: 2, y: 0 }, { allowCross: true });
    checkTrue("tunnel: claimed", !!claimed);
    check(
        "tunnel: ends are buildings, not belts",
        [
            claim.belts.has(cellKey(-1, 0)),
            claim.belts.has(cellKey(1, 0)),
            claim.tunnelEnds.has(cellKey(-1, 0)),
            claim.tunnelEnds.has(cellKey(1, 0)),
        ],
        [false, false, true, true]
    );
    check("tunnel: end direction", [claim.tunnelEnds.get(cellKey(-1, 0)), claim.tunnelEnds.get(cellKey(1, 0))], [0, 0]);
    check("tunnel: underground tile records the direction", claim.tunnelUnder.get(cellKey(0, 0)), 1);
    check(
        "tunnel: ends are reserved",
        [claim.occupied.has(cellKey(-1, 0)), claim.occupied.has(cellKey(1, 0))],
        [true, true]
    );

    // a run longer than the limit is split; the receiver of one tunnel may feed
    // the sender of the next directly (they only have to be different tiles)
    const chain = createWorld({ hub: { x: 20, y: 20 }, patches: [] });
    for (let x = 0; x <= 3; x++) chain.belts.set(cellKey(x, 0), "v");
    chain.belts.set(cellKey(6, 0), "v");
    sealedCorridor(chain, -2, 8);
    const chained = routeBelt(chain, chain.walls, { x: -2, y: 0 }, { x: 8, y: 0 }, { allowCross: true, dryRun: true });
    check("tunnel: seven underground tiles split into two runs", chained && chained.spans.length, 2);
    check("tunnel: a receiver may feed the next sender", chained && [chained.spans[0]!.receiver, chained.spans[1]!.sender], [
        { x: 4, y: 0 },
        { x: 5, y: 0 },
    ]);
}

beginSection("needs: every shape the game asks for");
{
    for (const set of ["demo", "full"] as const) {
        const shapes = neededShapes({ set });
        check(
            `needs ${set}: every code parses`,
            shapes.filter((s) => !S.tryParse(s.code).ok).map((s) => s.code),
            []
        );
        check(`needs ${set}: codes are unique`, shapes.length, new Set(shapes.map((s) => s.code)).size);
        checkTrue(
            `needs ${set}: covers level goals`,
            shapes.some((s) => s.sources.some((x) => x.kind === "level"))
        );
        checkTrue(
            `needs ${set}: covers upgrade tiers`,
            shapes.some((s) => s.sources.some((x) => x.kind === "upgrade"))
        );
    }
    check("needs demo size", neededShapes({ set: "demo" }).length, 26);
    check("needs full size", neededShapes({ set: "full" }).length, 34);
    checkTrue(
        "rocket shape is full-version only",
        !neededShapes({ set: "demo" }).some((s) => s.code === "CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw")
    );
}

beginSection("needs: the map scan finds every letter the campaign needs");
{
    const types = requiredTypes(neededShapes({ set: "demo" }));
    check("needs demo: letters used by the targets", [...types].sort(), ["C", "R", "S", "W"]);

    // seeds 7 and 1234 have no windmill deposit near the hub; a fixed radius
    // used to leave their windmill shapes unsolvable
    for (const seed of [7, 1234]) {
        const scan = scanForTypes(seed, { types, startRadius: 8, maxRadius: 32 });
        check(`scan seed ${seed}: nothing missing`, scan.missingTypes, []);
        checkTrue(`scan seed ${seed}: radius expanded`, scan.radius > 8);
    }
    const tight = scanForTypes(1234, { types, startRadius: 8, maxRadius: 8 });
    check("scan: a fixed radius reports the missing letter", tight.missingTypes, ["W"]);
}

beginSection("solver: atoms cut out of mixed deposits");
{
    // The map generator never puts four windmill quadrants in one deposit (it
    // caps a patch at a single W), so a windmill can only be cut out of a mixed
    // patch. The base family must not invent a "WuWuWuWu" deposit instead.
    const fromPatch = solve("WuWuWuWu", { baseCodes: ["RuRuWuWu"] });
    checkTrue("windmill from a mixed patch is plannable", fromPatch.ok, fromPatch.error || "");
    checkTrue("windmill plan needs buildings", fromPatch.ok && fromPatch.cost > 0);
    checkTrue("windmill plan verifies", fromPatch.ok && fromPatch.verification.ok);

    const painted = solve("CwCwCwCw:WbWbWbWb", { baseCodes: ["CuCuCuCu", "RuRuWuWu"] });
    checkTrue("painted windmill is plannable", painted.ok, painted.error || "");
    checkTrue(
        "painted windmill mines the real deposit",
        painted.ok &&
            P.flatten(painted.plan).steps.some((s) => s.node.op === "base" && s.node.code === "RuRuWuWu")
    );

    checkTrue("a map without windmills refuses", !solve("WuWuWuWu", { baseCodes: ["CuCuCuCu"] }).ok);
}

beginSection("campaign: one map, one hub, no overlaps");
{
    const patches: Patch[] = [
        { x: 0, y: 0, size: 2, item: { kind: "shape", code: "CuCuCuCu" } },
        { x: 14, y: 14, size: 2, item: { kind: "shape", code: "RuRuRuRu" } },
    ];
    const hub = { x: 40, y: 40 };
    const res = planCampaign({
        shapes: [
            { code: "CuCuCuCu", sources: [] },
            { code: "RuRuRuRu", sources: [] },
            { code: "----CuCu", sources: [] },
        ],
        patches,
        hub,
    });
    check("campaign: every shape solved", res.entries.map((e) => e.ok), [true, true, true]);
    check(
        "campaign: building total adds up",
        res.totals.buildings,
        res.entries.reduce((n, e) => n + e.buildings, 0)
    );

    const cells = new Set<string>();
    let clashes = 0;
    for (const b of res.sheet.buildings) {
        for (let dx = 0; dx < b.w; dx++) {
            for (let dy = 0; dy < b.h; dy++) {
                const k = b.x + dx + "|" + (b.y + dy);
                if (cells.has(k)) clashes += 1;
                cells.add(k);
            }
        }
    }
    check("campaign: buildings never overlap", clashes, 0);
    check("campaign: one miner per factory", res.sheet.buildings.filter((b) => b.kind === "base").length, 3);
    check("campaign: a belt run into the hub per shape", res.sheet.connections.filter((c) => c.toHub).length, 3);
    check(
        "campaign: belt total is the sum of the legs",
        res.totals.belts,
        res.sheet.connections.reduce((n, c) => n + c.beltTiles, 0)
    );
    check(
        "campaign: every factory reports a rate",
        res.entries.map((e) => e.status === "ok" && e.rate > 0),
        [true, true, true]
    );
    check(
        "campaign: a shared colour chain only ever limits, never boosts",
        res.entries.every((e) => e.status === "ok" && e.supplyFactor > 0 && e.supplyFactor <= 1),
        true
    );
    // an unconnected output port backs up and stalls the machine
    const cans = res.sheet.buildings.filter((b) => b.kind === "trash").length;
    check("campaign: cutter offcuts get a trash can", cans, 1);
    check("campaign: every waste belt lands in one", res.sheet.connections.filter((c) => c.waste).length, cans);
    const fanout = new Map<string, number>();
    for (const c of res.sheet.connections) {
        if (c.toHub) continue;
        const key = `${c.from}|${c.outSlot}`;
        fanout.set(key, (fanout.get(key) || 0) + 1);
    }
    check("campaign: no output port feeds two belts", Math.max(0, ...fanout.values()), 1);
    check(
        "campaign: belt total adds up per factory",
        res.totals.belts,
        res.entries.reduce((n, e) => n + e.belts, 0)
    );
    // the run's own count is what the sheet adds up, so it has to describe the
    // path that is actually drawn — after the build and after any repair
    const staleBeltCounts = res.sheet.connections.filter(
        (c) => c.routed && c.path && c.beltTiles !== c.path.length - c.tunnelSpans.reduce((n, span) => n + span.cells.length, 0)
    ).length;
    check("campaign: every run's belt count matches its path", staleBeltCounts, 0);
    check(
        "campaign: one frame per drawn factory",
        res.sheet.plans.length,
        res.entries.filter((e) => e.status === "ok").length
    );

    // a painted factory is the only one that builds colour sources, and every
    // machine on a chain carries the colour it puts out
    const colourPatches: Patch[] = [
        { x: 0, y: 0, size: 2, item: { kind: "color", color: "r" } },
        { x: 10, y: 0, size: 2, item: { kind: "color", color: "g" } },
    ];
    const paint = planCampaign({
        shapes: [{ code: "CyCyCyCy", sources: [] }],
        patches: colourPatches,
        hub: { x: 40, y: 40 },
    });
    const chain = paint.sheet.buildings.filter((b) => b.color !== undefined);
    check("campaign: yellow pulls one mixer and two miners", paint.totals.throughput.builtSourceCount, 3);
    check("campaign: colour count is the coloured machines", paint.totals.throughput.builtSourceCount, chain.length);
    check("campaign: only miners and mixers carry a colour", [...new Set(chain.map((b) => b.kind))].sort(), ["base", "mixer"]);
    check("campaign: a covered colour needs no extra source", paint.totals.throughput.colorGap, []);
    check("campaign: the sheet is legal as drawn", validateSheet(res.sheet), []);
}

beginSection("sheet: the drawing validates, and the checker sees damage");
{
    const scan = scanForTypes(47742, { types: requiredTypes(neededShapes({ set: "demo" })), startRadius: 8, maxRadius: 32 });
    const solved = solve("CrCrCrCr", { maxAttempts: 30000, buildings: new Set(ALL_BUILDINGS) });
    // hub at the map origin is what the CLI and the campaign use; the colour
    // miner's belt crosses the painter's leg here, so the fixture has a tunnel
    const layout = buildLayout({ plan: solved.plan!, patches: scan.patches, hub: { x: -2, y: -2 } });
    const tunnel = layout.connections.findIndex((c) => c.tunnelSpans.length > 0);
    checkTrue("fixture: the layout has one tunnel to corrupt", tunnel >= 0);
    check("fixture: legal as drawn", validateSheet(layout), []);

    const crossing = structuredClone(layout);
    crossing.connections[tunnel]!.tunnelCells.push({ x: 0, y: 0 });
    check(
        "checker: a crossing off the underground run",
        validateSheet(crossing).map((v) => [v.kind, v.connection, v.tile?.x, v.tile?.y]),
        [["staleCrossing", tunnel, 0, 0]]
    );

    const overlap = structuredClone(layout);
    const beltPath = overlap.connections[0]!.path!;
    beltPath.push({ ...beltPath[3]! });
    check(
        "checker: a run that visits a tile twice",
        validateSheet(overlap).map((v) => [v.kind, v.connection]),
        [["selfOverlap", 0]]
    );

    const clash = structuredClone(layout);
    const shared = clash.connections[0]!.path![3]!;
    clash.connections[1]!.path!.push({ x: shared.x, y: shared.y });
    check(
        "checker: two runs on one belt tile",
        validateSheet(clash).map((v) => [v.kind, v.connection, v.other]),
        [["tileClaimed", 1, 0]]
    );

    const turn = structuredClone(layout);
    const conn = turn.connections[tunnel]!;
    const span = conn.tunnelSpans[0]!;
    const si = conn.path!.findIndex((p) => p.x === span.sender.x && p.y === span.sender.y);
    conn.path![si - 1] = { x: span.sender.x, y: span.sender.y - 1 };
    check(
        "checker: a belt leaving a sender on a turn",
        validateSheet(turn).map((v) => [v.kind, v.connection]),
        [["senderTurn", tunnel]]
    );
}

beginSection("layout: one cutter serves every output slot at once");
{
    // a quad cutter ejects all four quadrants in the same cycle, so two steps
    // that cut the same shape into different slots are one machine
    const res = solve("RuCw--Cw:----Ru--", { maxAttempts: 30000, buildings: new Set(ALL_BUILDINGS) });
    checkTrue("multi-output plan solved", res.ok && res.flat !== undefined);
    const fused = fuseCuts(res.flat!);
    check(
        "sibling quad cuts fuse into one machine",
        fused.steps.filter((s) => s.fuseInto).map((s) => `${s.id}->${s.fuseInto}`),
        ["v6->v2", "v11->v5"]
    );
    check("a fused cutter counts once", fusedCost(fused, res.cost!), res.cost! - 2);
    const bom = Object.fromEntries(planBom(expandPlanTree(fused)).map((b) => [b.zh, b.n]));
    check("two quad cutters, not four", bom["四向切割机"], 2);
    // q0+q3 on one cutter, q1+q2 on the other: two slots stay unused on each
    check("only the unused slots get a trash can", bom["垃圾桶"], 6);

    // the plan needs the C and R deposits; the chains need r, g and b
    const types = requiredTypes([{ code: "RuCw--Cw:----Ru--" }]);
    for (const color of ["r", "g", "b"]) types.add(color);
    const scan = scanForTypes(47742, { types, startRadius: 6, maxRadius: 32 });
    const L = buildLayout({ plan: res.plan!, patches: scan.patches, hub: { x: 0, y: 0 } });
    const ports = L.connections
        .flatMap((c) => (c.color && c.to === "v16" && c.slot !== null ? [c.slot] : []))
        .sort((a, b) => a - b);
    check("both w ports of the quad painter are fed", ports, [2, 4]);
    check("one colour chain per port", L.buildings.filter((b) => b.kind === "mixer").length, 4);
    const fanout = new Map<string, number>();
    for (const c of L.connections) {
        const key = `${c.from}|${c.outSlot}`;
        fanout.set(key, (fanout.get(key) || 0) + 1);
    }
    check("a fused cutter still feeds each slot once", Math.max(0, ...fanout.values()), 1);
    check("the fused layout routes", L.routingGaps.length, 0);
}

beginSection("placement: the session lays and rips its own links");
{
    const hub = { x: 20, y: 20 };
    const world = createWorld({ hub, patches: [] });
    const session = createPlacementSession({ world, hub, stepById: new Map() });
    const info = BUILDING_INFO.rotate;
    const src: Placement = { step: "a", stepId: "a", kind: "rotate", zh: BUILDING_NAMES.rotate, x: 0, y: 0, w: 1, h: 1, rot: 0 };
    const dst: Placement = { ...src, step: "b", stepId: "b", x: 9 };
    check("session: a link between two parts lays", session.links.layLink(session.links.shapeLink(src, info, 0, dst, info, 0)), true);
    check("session: one connection, routed", session.links.connections.map((c) => c.routed), [true]);
    check("session: the belt ledger is the run", session.links.beltEstimate, session.links.connections[0]!.beltTiles);
    checkTrue("session: the belts are on the map", world.belts.size > 0);
    session.links.rip(0);
    check("session: a ripped link is a gap again", session.links.connections[0]!.routed, false);
    check("session: the ledger goes back to zero", session.links.beltEstimate, 0);
    check("session: the map lost the belts", world.belts.size, 0);
}

beginSection("links: a failed link is retried by the rip-up pass");
{
    const hub = { x: 30, y: 30 };
    const world = createWorld({ hub, patches: [] });
    const claims = createTileClaims(world);
    // no tunnels: a wall is a wall, so the first search has to fail
    const links = createLinkScheduler({ world, hub, blocked: claims.blocked, tuning: DEFAULT_TUNING, allowTunnels: false });
    const info = BUILDING_INFO.rotate;
    const src: Placement = { step: "a", stepId: "a", kind: "rotate", zh: BUILDING_NAMES.rotate, x: 0, y: 0, w: 1, h: 1, rot: 0 };
    const dst: Placement = { ...src, step: "b", stepId: "b", x: 9 };
    const wall: number[] = [];
    for (let y = -40; y <= 40; y++) wall.push(cellKey(6, y));
    claims.block(wall);
    check("links: a walled run is reported as a gap", links.layLink(links.shapeLink(src, info, 0, dst, info, 0)), false);
    // the gap list is the scheduler's report, refreshed when it gives up
    links.schedule();
    check("links: the gap carries the link's ends", links.routingGaps.map((g) => [g.from, g.to]), [["a", "b"]]);
    for (const key of wall) claims.blocked.delete(key);
    links.schedule();
    check("links: the retry closes the gap", links.connections.map((c) => c.routed), [true]);
    check("links: the gap list is empty again", links.routingGaps, []);
    checkTrue("links: the retried belts are on the map", world.belts.size > 0);
}

beginSection("colour supply: two ports of one colour grow two chains");
{
    const hub = { x: 0, y: 0 };
    const patches: Patch[] = [
        { x: 10, y: 10, size: 2, item: { kind: "color", color: "r" } },
        { x: 14, y: 10, size: 2, item: { kind: "color", color: "g" } },
    ];
    const world = createWorld({ hub, patches });
    const session = createPlacementSession({ world, hub, stepById: new Map() });
    const first = session.colour.buildColorChain("y", { x: 12, y: 10 });
    const second = session.colour.buildColorChain("y", { x: 12, y: 10 });
    check("supply: two yellow chains each build", [first?.ok, second?.ok], [true, true]);
    // y = r + g: each chain is its own two miners and one mixer
    check("supply: two chains mine four deposits", session.buildings.filter((b) => b.kind === "base").length, 4);
    check("supply: and place two mixers", session.buildings.filter((b) => b.kind === "mixer").length, 2);
    check("supply: nothing is missing", [...session.missing], []);
}

beginSection("recipe: one card per machine, waves and lanes from the plan");
{
    const res = solve("RuCw--Cw:----Ru--");
    checkTrue("recipe: the plan solves", res.ok && !!res.flat);
    const diagram = recipeDiagram(res.flat!);
    // a fused cutter is one machine with two outlets, not one card per product
    check(
        "recipe: a fused cutter is one card",
        diagram.cards.filter((c) => c.outlets.length > 1).map((c) => [c.id, c.outlets.length]),
        [
            ["v2", 2],
            ["v5", 2],
        ]
    );
    // every line points right: an input sits in a strictly earlier wave
    check(
        "recipe: every feed points right",
        diagram.feeds.filter((f) => diagram.cards[f.from]!.wave >= diagram.cards[f.to]!.wave).length,
        0
    );
    // a line that skips a wave dives below the board on its own lane
    check(
        "recipe: only wave-skipping feeds get a lane",
        diagram.feeds.map((f) => f.lane !== null),
        diagram.feeds.map((f) => diagram.cards[f.to]!.wave - diagram.cards[f.from]!.wave >= 2)
    );
    check("recipe: lanes are numbered in feed order", diagram.feeds.flatMap((f) => (f.lane === null ? [] : [f.lane])), [0, 1, 2]);
    // the stack names its two input ports on the line
    check(
        "recipe: a stack labels its two inputs",
        diagram.feeds.filter((f) => f.label).map((f) => f.label),
        ["下层", "上层", "下层", "上层", "下层", "上层", "下层", "上层"]
    );
}

beginSection("recipe: a mixed colour is a chain of buildings");
{
    const res = solve("RpRp----");
    const diagram = recipeDiagram(res.flat!);
    const mixer = diagram.cards.find((card) => card.kind === "color" && card.sprite === "mixer");
    check("recipe: magenta needs a mixer card", [mixer?.color, mixer?.owner], ["p", "v3 端口1"]);
    // the two operand lines carry their own colours, r and b
    check(
        "recipe: the mixer is fed r and b",
        diagram.feeds.filter((f) => f.to === diagram.cards.indexOf(mixer!)).map((f) => f.color),
        ["r", "b"]
    );
    // the painter takes the shape on slot 0 and the chain's mixed colour on slot 1
    const paint = diagram.cards.findIndex((card) => card.kind === "plan" && card.id === "v3");
    check(
        "recipe: the painter is fed magenta",
        diagram.feeds.filter((f) => f.to === paint).map((f) => [f.slot, f.color ?? null]),
        [
            [0, null],
            [1, "p"],
        ]
    );
}

beginSection("campaign: only the lines buildable by L9");
{
    const shapes = neededShapes({ set: "demo" });
    const scan = scanForTypes(47742, { types: requiredTypes(shapes), startRadius: 8, maxRadius: 32 });
    const res = planCampaign({
        shapes,
        patches: scan.patches,
        hub: { x: -2, y: -2 },
        levels: DEMO_LEVELS,
        untilLevel: 9,
    });
    checkTrue(
        "campaign L9: every drawn factory is buildable by L9",
        res.entries.every((e) => e.status !== "ok" || e.availableAt <= 9)
    );
    checkTrue(
        "campaign L9: the demo's stacker shapes are impossible",
        res.entries.some((e) => e.status === "impossible")
    );
    check(
        "campaign L9: statuses add up",
        res.totals.shapes + res.totals.deferred + res.totals.impossible + res.totals.failed,
        res.totals.requested
    );
    // cyan paint needs the mixer, so this factory is L9 and not the painter's L7
    const cyan = res.entries.find((e) => e.code === "ScScScSc");
    check("campaign L9: cyan is L9 (mixer), not L7", cyan && ("availableAt" in cyan ? cyan.availableAt : undefined), 9);
    check(
        "campaign L9: every link is routed or reported",
        res.sheet.connections.filter((c) => !c.routed).length,
        res.sheet.routingGaps.length
    );

    // a lower cap has to skip the level goals that are still ahead
    const early = planCampaign({
        shapes: shapes.filter((s) => s.code === "CrCrCrCr" || s.code === "RuRu----"),
        patches: scan.patches,
        hub: { x: -2, y: -2 },
        levels: DEMO_LEVELS,
        untilLevel: 6,
    });
    check(
        "campaign L6: the L7 factory is deferred, the L4 one is drawn",
        early.entries.map((e) => [e.code, e.status]),
        [
            ["RuRu----", "ok"],
            ["CrCrCrCr", "deferred"],
        ]
    );
}

beginSection("hub: a leg with every entry boxed in merges into a delivery belt");
{
    const hub = { x: 40, y: 40 };
    const patches: Patch[] = [{ x: 10, y: 41, size: 2, item: { kind: "shape", code: "CuCuCuCu" } }];
    const world = createWorld({ hub, patches });
    // a delivery leg already runs along the west face and ends on its entry tile
    const entry = { x: hub.x - 1, y: hub.y + 1 };
    for (let x = 28; x <= entry.x; x++) {
        const key = cellKey(x, entry.y);
        world.belts.set(key, "h");
        world.occupied.add(key);
        world.hubBound.set(key, cellKey(entry.x, entry.y));
    }
    world.hubApproaches.add(cellKey(entry.x, entry.y));
    world.hubEntryLoad.set(cellKey(entry.x, entry.y), 1);
    // every other entry tile is claimed too, so no free face is left
    for (let i = 0; i < 4; i++) {
        for (const t of [
            { x: hub.x + i, y: hub.y - 1 },
            { x: hub.x + i, y: hub.y + 4 },
            { x: hub.x - 1, y: hub.y + i },
            { x: hub.x + 4, y: hub.y + i },
        ]) {
            if (t.x === entry.x && t.y === entry.y) continue;
            world.hubApproaches.add(cellKey(t.x, t.y));
        }
    }

    const laid = buildLayout({ plan: P.baseNode("C"), patches, hub, world });
    const leg = laid.connections.find((c) => c.toHub);
    check("hub merge: the boxed-in leg still routes", leg?.routed, true);
    check("hub merge: it joins a belt that is on its way to the hub", leg?.merged, true);
    check("hub merge: it claims no entry tile of its own", world.hubApproaches.size, 16);
    const tail = leg?.path?.at(-1);
    check(
        "hub merge: the joined belt remembers the entry it feeds",
        tail ? world.hubBound.get(cellKey(tail.x, tail.y)) : -1,
        cellKey(entry.x, entry.y)
    );
    check("hub merge: two legs now share one entry belt", world.hubEntryLoad.get(cellKey(entry.x, entry.y)), 2);
}

beginSection("throughput: the game's own rates");
{
    check("rate: a bare miner makes 0.4/s", chainRate([{ op: "base" }]), 0.4);
    check("rate: a stacker caps the chain at 0.25/s", chainRate([{ op: "base" }, { op: "stack" }]), 0.25);
    check(
        "rate: a painter chain runs at 2/6 per second",
        Math.round(chainRate([{ op: "base" }, { op: "paint" }]) * 1e6) / 1e6,
        Math.round((2 / 6) * 1e6) / 1e6
    );
    check("rate: 3600 s reads as 1.0h", formatDuration(3600), "1.0h");

    // w = mix(mix(r, g), b): 0.8/s of white needs 2 mixers, plus 2 of each base
    const supply = sizeColorSupply(new Map<S.ColorChar, number>([["w", 0.8]]));
    check("sizing: white needs two mixers", supply.sources.get("w"), 2);
    check("sizing: its first stage (y) also needs two", supply.sources.get("y"), 2);
    check(
        "sizing: every base colour behind it needs two",
        (["r", "g", "b"] as const).map((c) => supply.sources.get(c)),
        [2, 2, 2]
    );
    // the drawing builds one chain per port; a colour with fewer is a shortfall
    const gaps = colourGap(supply, new Map<S.ColorChar, number>([["w", 2], ["y", 2], ["r", 1], ["g", 2], ["b", 2]]));
    check("gap: the short base colour is the one reported", gaps.map((g) => [g.color, g.need, g.have, g.kind]), [["r", 2, 1, "采矿机"]]);

    // a deposit is lossy: every miner needs its own tile to eject into
    const solid = (w: number, h: number): Array<[number, number]> =>
        Array.from({ length: w * h }, (_, i) => [i % w, Math.floor(i / w)]);
    check("capacity: a lone tile takes one miner", patchMinerCapacity({ cells: [[0, 0]] }), 1);
    check("capacity: a solid 5×5 tops out at its 20 border tiles", patchMinerCapacity({ cells: solid(5, 5) }), 20);
    check("capacity: a 1×5 strip is fully usable", patchMinerCapacity({ cells: solid(1, 5) }), 5);

    // one output port = one belt: a shared sub-plan has to be duplicated
    const shared = expandPlanTree({
        steps: [
            { id: "a", op: "base", inputs: [] },
            { id: "b", op: "cutHalf", inputs: [{ id: "a" }] },
            { id: "c", op: "cutHalf", inputs: [{ id: "a" }] },
            { id: "d", op: "stack", inputs: [{ id: "b" }, { id: "c" }] },
        ],
        final: { id: "d" },
    });
    check("tree: the shared miner is copied", shared.steps.filter((s) => s.op === "base").length, 2);
    check("tree: every step id stays unique", new Set(shared.steps.map((s) => s.id)).size, shared.steps.length);
    const parents = new Map<string, number>();
    for (const step of shared.steps) for (const input of step.inputs) parents.set(input.id, (parents.get(input.id) || 0) + 1);
    parents.set(shared.final.id, (parents.get(shared.final.id) || 0) + 1);
    check("tree: no step is referenced twice", Math.max(...parents.values()), 1);
}

beginSection("planner: level 20");
{
    const res = solve("RuCw--Cw:----Ru--");
    checkTrue("level 20 solvable", res.ok, res.error || "");
    if (res.ok) {
        console.log(`  level 20 plan: cost=${res.cost}, steps=${res.flat.steps.length}`);
        checkTrue("level 20 verified", res.verification.ok);
    }
}

beginSection("map generator (seed 47742, the demo save)");
{
    // predefined chunks must land exactly where the game puts them
    const patches = scanMap(47742, { chunkRadius: 1 });
    const near = (x: number, y: number): Patch | null =>
        patches.find((p) => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3) ?? null;
    const red = near(6, 6);
    checkTrue("red color patch near (6,6)", !!red && red.item.kind === "color" && red.item.color === "r");
    const cu = near(-9, 8);
    checkTrue("circle patch near (-9,8)", !!cu && cu.item.kind === "shape" && cu.item.code === "CuCuCuCu");
    const ru = near(6, -8);
    checkTrue("rect patch near (6,-8)", !!ru && ru.item.kind === "shape" && ru.item.code === "RuRuRuRu");
    const green = near(-11, -9);
    checkTrue("green patch near (-11,-9)", !!green && green.item.kind === "color" && green.item.color === "g");

    const res = availableResources(patches);
    check("shapes near hub", [...res.shapes.keys()].sort(), ["CuCuCuCu", "RuRuRuRu"]);
    check("colors near hub", [...res.colors.keys()].sort(), ["g", "r"]);

    // chunk generation is deterministic
    const a = generateChunk(47742, 0, 0);
    const b = generateChunk(47742, 0, 0);
    check("chunk deterministic", a.patches.length, b.patches.length);
}

beginSection("savegame codec (lz + key/value interning)");
{
    const sample = { hello: "world", list: [1, 2, 3], nested: { a: "world" } };
    const packed = compressObject(sample);
    const back = decompressObject(packed);
    check("compressObject roundtrip", back, sample);
    const text = JSON.stringify({ keys: ["a"], values: ["b"], data: { "#": 1 } });
    check("lz roundtrip", decompressX64(compressX64(text)), text);
}

beginSection("savegame map info");
{
    const payload = {
        version: 1010,
        dump: {
            map: { seed: 12345 },
            hubGoals: { level: 7 },
            entities: [
                { components: { StaticMapEntity: { code: 1, origin: { x: 9, y: 9 } } } },
                { components: { StaticMapEntity: { code: 26, origin: { x: -4, y: 6 } } } },
            ],
        },
    };
    const info = savegameMapInfo(payload);
    check("seed/hub/level from wrapped payload", { seed: info.seed, hub: info.hub, level: info.level }, {
        seed: 12345,
        hub: { x: -4, y: 6 },
        level: 7,
    });
    check("bare dump also accepted", savegameMapInfo(payload.dump).seed, 12345);
}

beginSection("schematic (game chunk-overview representation)");
{
    const path: Tile[] = [
        { x: 5, y: 2 },
        { x: 6, y: 2 },
        { x: 7, y: 2 },
        { x: 8, y: 2 },
        { x: 9, y: 2 },
    ];
    const connection: Connection = {
        from: "src",
        to: "dst",
        toHub: false,
        merged: false,
        slot: 0,
        fromLabel: "切割机",
        toLabel: "堆叠器",
        outSlot: 0,
        outCount: 1,
        x1: 4.5,
        y1: 2.5,
        x2: 9.5,
        y2: 2.5,
        length: 5,
        routed: true,
        path,
        tunnels: 1,
        tunnelCells: [{ x: 7, y: 2 }],
        tunnelSpans: [{ sender: { x: 6, y: 2 }, receiver: { x: 8, y: 2 }, cells: [{ x: 7, y: 2 }], dx: 1, dy: 0 }],
        beltTiles: 7,
    };
    const layout: SchematicLayout = {
        hub: { x: 0, y: 0 },
        buildings: [],
        connections: [connection],
        beltEstimate: 7,
    };
    const svg = schematicSVG(layout, [], { tile: 30 });
    checkTrue("belt band uses the game's #777", svg.includes('stroke="#777"'));
    checkTrue("belt band is one third of a tile", svg.includes('stroke-width="10"'));
    checkTrue("tunnel sender is the game's blue", svg.includes('fill="#6d9dff"'));
    checkTrue("tunnel receiver is the game's green", svg.includes('fill="#71ff9c"'));
    checkTrue("tunnel blocks face the flow (rightward ⇒ rotate 90°)", svg.includes("rotate(90)"));
    check("old white tunnel notch is gone", svg.includes("#f8f9ff"), false);
    checkTrue("sender precedes receiver in path order", svg.indexOf('fill="#6d9dff"') < svg.indexOf('fill="#71ff9c"'));

    // one tunnel may run under several belts: the router already merged these
    // crossings into one straight span, so the drawing gets one sender and one
    // receiver instead of an overlapping pair on the tile between them
    const under: Tile[] = [
        { x: 2, y: 5 },
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 5, y: 5 },
        { x: 6, y: 5 },
    ];
    const longSpan: SchematicLayout = {
        hub: { x: 0, y: 0 },
        buildings: [],
        connections: [
            {
                ...connection,
                x1: 2.0,
                y1: 5.5,
                x2: 6.5,
                y2: 5.5,
                path: under,
                tunnels: 2,
                tunnelCells: [
                    { x: 3, y: 5 },
                    { x: 5, y: 5 },
                ],
                tunnelSpans: [
                    {
                        sender: { x: 2, y: 5 },
                        receiver: { x: 6, y: 5 },
                        cells: [
                            { x: 3, y: 5 },
                            { x: 4, y: 5 },
                            { x: 5, y: 5 },
                        ],
                        dx: 1,
                        dy: 0,
                    },
                ],
                beltTiles: 7,
            },
        ],
        beltEstimate: 7,
    };
    const spanSvg = schematicSVG(longSpan, [], { tile: 30 });
    // the legend swatch carries the same fill but no transform
    check("one span → one sender", spanSvg.split('fill="#6d9dff" transform=').length - 1, 1);
    check("one span → one receiver", spanSvg.split('fill="#71ff9c" transform=').length - 1, 1);

    // no output tab is drawn: the belt band already leaves from the port, and
    // a triangle tab there read as a direction arrow lying on the belt
    const cutLayout: SchematicLayout = {
        hub: { x: 0, y: 0 },
        buildings: [
            { step: "c1", stepId: "c1", kind: "cutHalf", zh: "切割机", x: 0, y: 0, w: 2, h: 1, rot: 0 },
        ],
        connections: [],
        beltEstimate: 0,
    };
    const cutSvg = schematicSVG(cutLayout, [], { tile: 30 });
    // a triangle is a three-point path; the sheet must not carry any
    check(
        "no output arrow tabs drawn",
        cutSvg.match(/<path d="M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ Z"/g),
        null
    );
    check("legend no longer lists an output port", cutSvg.includes("输出口"), false);

    // a colour input is shown by the colour it carries; a mixer's two inputs
    // are both colour, so the dot index has to count colour ports, not `ins`
    const mixLayout: SchematicLayout = {
        hub: { x: 0, y: 0 },
        buildings: [
            {
                step: "m1",
                stepId: "m1",
                kind: "mixer",
                zh: "混色器",
                x: 0,
                y: 0,
                w: 2,
                h: 1,
                rot: 0,
                colors: ["r", "g"],
            },
        ],
        connections: [],
        beltEstimate: 0,
    };
    const mixSvg = schematicSVG(mixLayout, [], { tile: 30 });
    // the legend plate draws its own r/g swatches; only the drawing above it counts
    const mixDots = [
        ...mixSvg
            .slice(0, mixSvg.indexOf('fill="#f4f6fb"'))
            .matchAll(/<circle cx="([\d.-]+)" cy="[\d.-]+" r="[\d.]+" fill="(#[0-9a-f]+)"\/>/g),
    ];
    check("mixer shows both colour inputs", mixDots.map((m) => m[2]).sort(), ["#78ff66", "#ff666a"]);
    check(
        "the two colour dots sit one port apart",
        mixDots.map((m) => Number(m[1])).sort((a, b) => a - b),
        [85, 115]
    );

    const paintLayout: SchematicLayout = {
        hub: { x: 0, y: 0 },
        buildings: [
            {
                step: "p1",
                stepId: "p1",
                kind: "paint",
                zh: "上色器",
                x: 0,
                y: 0,
                w: 2,
                h: 1,
                rot: 0,
                colors: ["b"],
            },
        ],
        connections: [],
        beltEstimate: 0,
    };
    const paintSvg = schematicSVG(paintLayout, [], { tile: 30 });
    check(
        "painter keeps its single colour dot",
        [
            ...paintSvg
                .slice(0, paintSvg.indexOf('fill="#f4f6fb"'))
                .matchAll(/<circle cx="[\d.-]+" cy="[\d.-]+" r="[\d.]+" fill="(#[0-9a-f]+)"\/>/g),
        ].map((m) => m[1]),
        ["#66a7ff"]
    );
}

if (!quick) {
    beginSection("demo levels (buildings unlocked at that level)");
    for (const lvl of DEMO_LEVELS) {
        const buildings = buildingsForLevel(DEMO_LEVELS, lvl.level);
        const res = solve(lvl.shape, { buildings });
        const flag = res.ok ? "ok  " : "FAIL";
        console.log(
            `  [${flag}] demo L${lvl.level} ${lvl.shape.padEnd(28)} cost=${res.ok ? String(res.cost).padStart(2) : "-"} buildings=[${[...buildings].join(",")}]`
        );
        if (!res.ok) {
            failures++;
            console.log("        " + res.error);
        } else {
            checkTrue(`demo L${lvl.level} verify`, res.verification.ok);
        }
    }

    beginSection("full game levels (all buildings)");
    for (const lvl of FULL_LEVELS) {
        const res = solve(lvl.shape, { buildings: ALL_BUILDINGS });
        const flag = res.ok ? "ok  " : "FAIL";
        console.log(
            `  [${flag}] game L${String(lvl.level).padStart(2)} ${lvl.shape.padEnd(46)} cost=${res.ok ? String(res.cost).padStart(2) : "-"}`
        );
        if (!res.ok) {
            failures++;
            console.log("        " + res.error);
        } else {
            checkTrue(`game L${lvl.level} verify`, res.verification.ok);
        }
    }
}

sectionSummary();
if (filter && matched === 0) console.log(`\nno check matched --filter=${filter.source}`);
console.log(`\n${checks} checks, ${failures} failure(s)${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failures || (filter && matched === 0) ? 1 : 0);
