/**
 * Regression + corpus tests.
 *   node test/run-tests.js            # everything
 *   node test/run-tests.js --quick    # unit tests only
 */

import * as S from "../src/shape.js";
import * as P from "../src/plan.js";
import { solve, ALL_BUILDINGS } from "../src/solver.js";
import { DEMO_LEVELS, FULL_LEVELS, buildingsForLevel } from "../src/levels.js";
import { generateChunk, scanMap, availableResources } from "../src/map.js";
import { compressX64, decompressX64 } from "../src/lz_factory.js";
import { compressObject, decompressObject } from "../src/savegame.js";
import { buildLayout, BUILDING_INFO } from "../src/layout.js";

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
    checks++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
}

function checkTrue(label, value, extra = "") {
    checks++;
    if (!value) {
        failures++;
        console.log(`  FAIL ${label} ${extra}`);
    }
}

console.log("== shape codec ==");
{
    const shape = S.parse("RuCw--Cw");
    check("hash round-trip", S.hash(shape), "RuCw--Cw");
    check("q0", shape.layers[0][0], { t: "R", c: "u" });
    check("q1", shape.layers[0][1], { t: "C", c: "w" });
    check("q2", shape.layers[0][2], null);
    check("q3", shape.layers[0][3], { t: "C", c: "w" });

    const two = S.parse("RuCw--Cw:----Ru--");
    check("two layers", two.layers.length, 2);
    check("layer1 q2", two.layers[1][2], { t: "R", c: "u" });
    check("two layer hash", S.hash(two), "RuCw--Cw:----Ru--");

    check("invalid: short", S.tryParse("Cu").ok, false);
    check("invalid: bad type", S.tryParse("XuCuCuCu").ok, false);
    check("invalid: empty layer", S.tryParse("--------").ok, false);
    check("invalid: color on empty", S.tryParse("-u------").ok, false);
    check("invalid: 5 layers", S.tryParse("CuCuCuCu:CuCuCuCu:CuCuCuCu:CuCuCuCu:CuCuCuCu").ok, false);
}

console.log("== rotations (game order: 0=TR 1=BR 2=BL 3=TL) ==");
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

console.log("== cutting ==");
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

console.log("== stacker (issues #313 recipe) ==");
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

console.log("== blueprint ports (official ItemEjector/ItemAcceptor slots) ==");
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
}

console.log("== blueprint: connections use the right output slot ==");
{
    // One synthetic circle patch; hub far away so placement stays deterministic.
    const patches = [{ x: 0, y: 0, size: 2, item: { kind: "shape", code: "CuCuCuCu" } }];
    const hub = { x: 40, y: 40 };
    const plans = [
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
        const source = layout.steps.find((s) => s.node.op.startsWith("cut"));
        const connection = layout.connections.find(
            (c) => c.from === source.id && c.to === layout.steps.at(-1).id
        );
        checkTrue(`${label}: connection exists`, !!connection);
        if (!connection) continue;
        check(`${label}: output slot`, connection.outSlot, slot);
        const building = layout.buildings.find((b) => b.stepId === source.id);
        check(`${label}: port x`, connection.x1, building.x + dx);
        check(`${label}: port y`, connection.y1, building.y);
    }

    const paint4 = buildLayout({
        plan: P.paint4Node(["r", null, "b", null], P.baseNode("C")),
        patches,
        hub,
    });
    const painter = paint4.buildings.find((b) => b.kind === "paint4");
    check("paint4 colors for port labels", painter.colors, ["r", null, "b", null]);
}

console.log("== planner: level 20 ==");
{
    const res = solve("RuCw--Cw:----Ru--");
    checkTrue("level 20 solvable", res.ok, res.error || "");
    if (res.ok) {
        console.log(`  level 20 plan: cost=${res.cost}, steps=${res.flat.steps.length}`);
        checkTrue("level 20 verified", res.verification.ok);
    }
}

console.log("== map generator (seed 47742, the demo save) ==");
{
    // predefined chunks must land exactly where the game puts them
    const patches = scanMap(47742, { chunkRadius: 1 });
    const near = (x, y) =>
        patches.find((p) => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3) || null;
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

console.log("== savegame codec (lz + key/value interning) ==");
{
    const sample = { hello: "world", list: [1, 2, 3], nested: { a: "world" } };
    const packed = compressObject(sample);
    const back = decompressObject(packed);
    check("compressObject roundtrip", back, sample);
    const text = JSON.stringify({ keys: ["a"], values: ["b"], data: { "#": 1 } });
    check("lz roundtrip", decompressX64(compressX64(text)), text);
}

const quick = process.argv.includes("--quick");
if (!quick) {
    console.log("== demo levels (buildings unlocked at that level) ==");
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

    console.log("== full game levels (all buildings) ==");
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

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
