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
import { colorChains } from "./color.js";

/* ------------------------------------------------------------------ *
 * builders
 * ------------------------------------------------------------------ */

/**
 * @param {string} type single-letter shape type (C/R/S/W)
 * @param {string} [code] full code of the deposit this miner sits on; the game
 *   generates mixed deposits such as "RuRuRuWu", and cutting those is the only
 *   way to obtain some quadrants. Omitted = all four quadrants of `type`.
 */
export function baseNode(type, code = null) {
    return code ? { op: "base", type, code, cost: 0 } : { op: "base", type, cost: 0 };
}

export function rotateNode(dir, input) {
    return { op: "rotate", dir, input, cost: input.cost + 1 };
}

/** side 0 -> quadrants {2,3}, side 1 -> quadrants {0,1} (the game's two cutter outputs) */
export function cutHalfNode(side, input) {
    return { op: "cutHalf", side, input, cost: input.cost + 1 };
}

export function cutQuadNode(quad, input) {
    return { op: "cutQuad", quad, input, cost: input.cost + 1 };
}

export function stackNode(lower, upper) {
    return { op: "stack", lower, upper, cost: lower.cost + upper.cost + 1 };
}

export function paintNode(color, input) {
    return { op: "paint", color, input, cost: input.cost + 1 };
}

export function paint4Node(colors, input) {
    return { op: "paint4", colors, input, cost: input.cost + 1 };
}

/* ------------------------------------------------------------------ *
 * evaluation
 * ------------------------------------------------------------------ */

const evalCache = new WeakMap();

export function evalNode(node) {
    const cached = evalCache.get(node);
    if (cached) return cached;
    let out;
    switch (node.op) {
        case "base": {
            if (node.code) {
                out = parse(node.code);
                break;
            }
            const layer = [0, 1, 2, 3].map(() => ({ t: node.type, c: "u" }));
            out = { layers: [layer] };
            break;
        }
        case "rotate":
            out = rotate(evalNode(node.input), node.dir);
            break;
        case "cutHalf":
            out = cutHalf(evalNode(node.input))[node.side];
            break;
        case "cutQuad":
            out = cutQuad(evalNode(node.input))[node.quad];
            break;
        case "stack":
            out = stack(evalNode(node.lower), evalNode(node.upper));
            break;
        case "paint":
            out = paint(evalNode(node.input), node.color);
            break;
        case "paint4":
            out = paint4(evalNode(node.input), node.colors);
            break;
        default:
            throw new Error("unknown plan node: " + node.op);
    }
    if (out.layers.length > 4) throw new Error("plan produced more than 4 layers");
    evalCache.set(node, out);
    return out;
}

/* ------------------------------------------------------------------ *
 * flattening (what the UI / CLI shows)
 * ------------------------------------------------------------------ */

export const OP_LABELS = {
    base: "采矿机",
    rotate: "旋转器",
    cutHalf: "切割机",
    cutQuad: "四向切割机",
    stack: "堆叠器",
    paint: "上色器",
    paint4: "四色上色器",
};

export const OP_LABELS_EN = {
    base: "Extractor",
    rotate: "Rotater",
    cutHalf: "Cutter",
    cutQuad: "Quad Cutter",
    stack: "Stacker",
    paint: "Painter",
    paint4: "Quad Painter",
};

let nextStepSeq = 1;

export function resetStepIds() {
    nextStepSeq = 1;
}

/**
 * @returns {{steps: Array, final: object, finalShape: object}}
 */
export function flatten(root) {
    const cache = new WeakMap();
    const steps = [];

    function visit(node) {
        if (cache.has(node)) return cache.get(node);
        const record = { id: 0, op: node.op, node, inputs: [], detail: "", cost: node.cost };
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
            default:
                throw new Error("unknown node");
        }
        record.out = evalNode(node);
        record.outKey = hash(record.out);
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

export function planKey(root) {
    return evalKey(root);
}

function evalKey(node) {
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
        default:
            return "?";
    }
}

/* ------------------------------------------------------------------ *
 * verification
 * ------------------------------------------------------------------ */

export function verifyPlan(root, target) {
    const flat = flatten(root);
    const produced = flat.finalShape;
    const ok = equals(produced, target);
    const problems = [];
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

export function parseTarget(codeOrShape) {
    return typeof codeOrShape === "string" ? parse(codeOrShape) : codeOrShape;
}

export function planToJSON(root) {
    const flat = flatten(root);
    return {
        cost: root.cost,
        target: hash(flat.finalShape),
        steps: flat.steps.map((s) => ({
            id: s.id,
            op: s.op,
            label: OP_LABELS[s.op],
            inputs: s.inputs.map((i) => i.id),
            detail: s.detail,
            out: s.outKey,
        })),
        // every painter colour port needs its own chain; without this a purple
        // shape looks like it only needs one painter
        colors: colorChains(flat.steps),
    };
}
