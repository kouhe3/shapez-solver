/**
 * Plan AST: a small DAG of shapez buildings.
 *
 * Every node knows its own cost (number of buildings placed, extractors count 0).
 * Nodes are immutable-ish plain objects; the same node object may be shared by
 * several parents, so flatten() dedupes on identity.
 */

import {
    cloneShape,
    computeHash,
    cutHalf,
    cutQuad,
    equals,
    hash,
    isEntirelyEmpty,
    paint,
    paint4,
    parse,
    rotate,
    stack,
} from "./shape.js";
import type { ColorChar, Layer, Rotation, Shape, ShapeType } from "./shape.js";
import { BUILDING_NAMES } from "./catalogue.js";
import { colorChains } from "./color.js";
import type { ColorChain } from "./color.js";

/* ------------------------------------------------------------------ *
 * node types
 * ------------------------------------------------------------------ */

export interface BaseNode {
    op: "base";
    type: ShapeType;
    /** full code of the deposit this miner sits on, e.g. a mixed "RuRuRuWu" */
    code?: string;
    cost: number;
}

export interface RotateNode {
    op: "rotate";
    dir: Rotation;
    input: PlanNode;
    cost: number;
}

export interface CutHalfNode {
    op: "cutHalf";
    side: 0 | 1;
    input: PlanNode;
    cost: number;
}

export interface CutQuadNode {
    op: "cutQuad";
    quad: number;
    input: PlanNode;
    cost: number;
}

export interface StackNode {
    op: "stack";
    lower: PlanNode;
    upper: PlanNode;
    cost: number;
}

export interface PaintNode {
    op: "paint";
    color: ColorChar;
    input: PlanNode;
    cost: number;
}

export interface Paint4Node {
    op: "paint4";
    colors: readonly (ColorChar | null)[];
    input: PlanNode;
    cost: number;
}

export type PlanNode =
    | BaseNode
    | RotateNode
    | CutHalfNode
    | CutQuadNode
    | StackNode
    | PaintNode
    | Paint4Node;

export type PlanOp = PlanNode["op"];

/* ------------------------------------------------------------------ *
 * builders
 * ------------------------------------------------------------------ */

/**
 * @param type single-letter shape type (C/R/S/W)
 * @param code full code of the deposit this miner sits on; the game
 *   generates mixed deposits such as "RuRuRuWu", and cutting those is the only
 *   way to obtain some quadrants. Omitted = all four quadrants of `type`.
 */
export function baseNode(type: ShapeType, code: string | null = null): BaseNode {
    return code ? { op: "base", type, code, cost: 0 } : { op: "base", type, cost: 0 };
}

export function rotateNode(dir: Rotation, input: PlanNode): RotateNode {
    return { op: "rotate", dir, input, cost: input.cost + 1 };
}

/** side 0 -> quadrants {2,3}, side 1 -> quadrants {0,1} (the game's two cutter outputs) */
export function cutHalfNode(side: 0 | 1, input: PlanNode): CutHalfNode {
    return { op: "cutHalf", side, input, cost: input.cost + 1 };
}

export function cutQuadNode(quad: number, input: PlanNode): CutQuadNode {
    return { op: "cutQuad", quad, input, cost: input.cost + 1 };
}

export function stackNode(lower: PlanNode, upper: PlanNode): StackNode {
    return { op: "stack", lower, upper, cost: lower.cost + upper.cost + 1 };
}

export function paintNode(color: ColorChar, input: PlanNode): PaintNode {
    return { op: "paint", color, input, cost: input.cost + 1 };
}

export function paint4Node(colors: readonly (ColorChar | null)[], input: PlanNode): Paint4Node {
    return { op: "paint4", colors, input, cost: input.cost + 1 };
}

/* ------------------------------------------------------------------ *
 * evaluation
 * ------------------------------------------------------------------ */

const evalCache = new WeakMap<PlanNode, Shape>();

export function evalNode(node: PlanNode): Shape {
    const cached = evalCache.get(node);
    if (cached) return cached;
    let out: Shape;
    switch (node.op) {
        case "base": {
            if (node.code) {
                out = parse(node.code);
                break;
            }
            const layer: Layer = [0, 1, 2, 3].map(() => ({ t: node.type, c: "u" as const }));
            out = { layers: [layer] };
            break;
        }
        case "rotate":
            out = rotate(evalNode(node.input), node.dir);
            break;
        case "cutHalf":
            out = cutHalf(evalNode(node.input))[node.side];
            break;
        case "cutQuad": {
            const parts = cutQuad(evalNode(node.input));
            const part = parts[node.quad];
            if (!part) throw new Error(`cutQuad quad out of range: ${node.quad}`);
            out = part;
            break;
        }
        case "stack":
            out = stack(evalNode(node.lower), evalNode(node.upper));
            break;
        case "paint":
            out = paint(evalNode(node.input), node.color);
            break;
        case "paint4":
            out = paint4(evalNode(node.input), node.colors);
            break;
    }
    if (out.layers.length > 4) throw new Error("plan produced more than 4 layers");
    evalCache.set(node, out);
    return out;
}

/* ------------------------------------------------------------------ *
 * flattening (what the UI / CLI shows)
 * ------------------------------------------------------------------ */

export interface PlanStep {
    id: string;
    op: PlanOp;
    node: PlanNode;
    inputs: PlanStep[];
    detail: string;
    cost: number;
    out: Shape;
    outKey: string;
    /**
     * This product is another output slot of the cutter built for `fuseInto`
     * (`layout.ts` `fuseCuts`): the two steps are one machine.
     */
    fuseInto?: string;
}

export interface FlatPlan {
    steps: PlanStep[];
    final: PlanStep;
    finalShape: Shape;
    cost: number;
}

let nextStepSeq = 1;

export function resetStepIds(): void {
    nextStepSeq = 1;
}

export function flatten(root: PlanNode): FlatPlan {
    const cache = new WeakMap<PlanNode, PlanStep>();
    const steps: PlanStep[] = [];

    function visit(node: PlanNode): PlanStep {
        const cached = cache.get(node);
        if (cached) return cached;
        const out = evalNode(node);
        const record: PlanStep = {
            id: "",
            op: node.op,
            node,
            inputs: [],
            detail: "",
            cost: node.cost,
            out,
            outKey: hash(out),
        };
        switch (node.op) {
            case "base":
                record.detail = node.code ? `${node.code}` : `${node.type}`;
                break;
            case "rotate":
                record.inputs = [visit(node.input)];
                record.detail = node.dir;
                break;
            case "cutHalf":
                record.inputs = [visit(node.input)];
                record.detail = node.side === 0 ? "保留 {2,3} 半边" : "保留 {0,1} 半边";
                break;
            case "cutQuad":
                record.inputs = [visit(node.input)];
                record.detail = `保留 q${node.quad}`;
                break;
            case "stack":
                record.inputs = [visit(node.lower), visit(node.upper)];
                record.detail = "下层 + 上层";
                break;
            case "paint":
                record.inputs = [visit(node.input)];
                record.detail = node.color;
                break;
            case "paint4":
                record.inputs = [visit(node.input)];
                record.detail = "";
                break;
        }
        steps.push(record);
        cache.set(node, record);
        return record;
    }

    const final = visit(root);
    steps.forEach((s, i) => {
        s.id = "v" + (i + 1);
    });
    return { steps, final, finalShape: final.out, cost: root.cost };
}

export function planKey(root: PlanNode): string {
    return evalKey(root);
}

function evalKey(node: PlanNode): string {
    // structural key, handy for tests
    switch (node.op) {
        case "base":
            return "base:" + node.type;
        case "rotate":
            return `rot${node.dir}(${evalKey(node.input)})`;
        case "cutHalf":
            return `cut${node.side}(${evalKey(node.input)})`;
        case "cutQuad":
            return `cut4.${node.quad}(${evalKey(node.input)})`;
        case "stack":
            return `stack(${evalKey(node.lower)},${evalKey(node.upper)})`;
        case "paint":
            return `paint${node.color}(${evalKey(node.input)})`;
        case "paint4":
            return `paint4[${node.colors.join(",")}](${evalKey(node.input)})`;
    }
}

/* ------------------------------------------------------------------ *
 * verification
 * ------------------------------------------------------------------ */

export interface Verification {
    ok: boolean;
    produced: Shape;
    problems: string[];
    steps: number;
    cost: number;
}

export function verifyPlan(root: PlanNode, target: Shape): Verification {
    const flat = flatten(root);
    const produced = flat.finalShape;
    const ok = equals(produced, target);
    const problems: string[] = [];
    for (const step of flat.steps) {
        if (step.out.layers.length > 4) problems.push(`step ${step.id}: more than 4 layers`);
        for (const layer of step.out.layers) {
            for (const c of layer) {
                if (c && !"CRSW".includes(c.t)) problems.push(`step ${step.id}: bad type`);
            }
        }
    }
    return { ok, produced, problems, steps: flat.steps.length, cost: root.cost };
}

export function parseTarget(codeOrShape: string | Shape): Shape {
    return typeof codeOrShape === "string" ? parse(codeOrShape) : codeOrShape;
}

export interface PlanJSONStep {
    id: string;
    op: PlanOp;
    label: string;
    inputs: string[];
    detail: string;
    out: string;
}

export interface PlanJSON {
    cost: number;
    target: string;
    steps: PlanJSONStep[];
    colors: ColorChain[];
}

export function planToJSON(root: PlanNode): PlanJSON {
    const flat = flatten(root);
    return {
        cost: root.cost,
        target: hash(flat.finalShape),
        steps: flat.steps.map((s) => ({
            id: s.id,
            op: s.op,
            label: BUILDING_NAMES[s.op],
            inputs: s.inputs.map((i) => i.id),
            detail: s.detail,
            out: s.outKey,
        })),
        // every painter colour port needs its own chain; without this a purple
        // shape looks like it only needs one painter
        colors: colorChains(flat.steps),
    };
}
