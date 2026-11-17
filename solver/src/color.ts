/**
 * Colour algebra and the colour chain a factory needs.
 *
 * The game mixes colours by OR-ing their red/green/blue bits (`colors.js`:
 * `enumColorMixingResults` is built from the same bitfield table), so a mixed
 * colour needs real mixer buildings before it can enter a painter's colour
 * port. Every consumer port owns its own chain: one output takes one belt and
 * parts are free, so a second chain next to the second painter is cheaper than
 * splitting (and legal before the L4 balancer).
 */

import type { ColorChar } from "./shape.js";
import type { PlanStep } from "./plan.js";

export const COLOR_BITS: Record<ColorChar, number> = { u: 0, r: 1, g: 2, y: 3, b: 4, p: 5, c: 6, w: 7 };
export const BITS_COLOR: readonly ColorChar[] = ["u", "r", "g", "y", "b", "p", "c", "w"];

/** base colours each mixed colour is mixed from, in mixer input order */
export const COLOR_NEEDS: Partial<Record<ColorChar, readonly ColorChar[]>> = {
    y: ["r", "g"],
    p: ["r", "b"],
    c: ["g", "b"],
    w: ["r", "g", "b"],
};

/** mixed colours need a mixer chain, base colours only a miner */
const MIXED_COLOR_TABLE: Readonly<Partial<Record<ColorChar, true>>> = {
    y: true,
    p: true,
    c: true,
    w: true,
};

export function isMixedColor(color: ColorChar): boolean {
    return MIXED_COLOR_TABLE[color] === true;
}

export function mixColor(a: ColorChar, b: ColorChar): ColorChar {
    return BITS_COLOR[(COLOR_BITS[a] || 0) | (COLOR_BITS[b] || 0)] ?? "u";
}

export interface ColorOpBase {
    kind: "base";
    color: ColorChar;
}

export interface ColorOpMixer {
    kind: "mixer";
    color: ColorChar;
    parts: readonly ColorChar[];
    /** indexes into the same chain: the two colours a mixer consumes */
    operands: number[];
}

export type ColorOp = ColorOpBase | ColorOpMixer;

/**
 * The ops one colour chain needs, dependencies first.
 *
 * A base colour is a single miner. A mixed colour is the mix tree of its parts:
 * `p = r + b`, and `w = mix(mix(r, g), b)` — a mixer takes two colours, so
 * three parts need two mixers in a tree.
 */
export function colorChain(color: ColorChar): ColorOp[] {
    if (!color || color === "u") return [];
    const ops: ColorOp[] = [];
    const built = new Map<ColorChar, number>();

    function build(c: ColorChar): number {
        const known = built.get(c);
        if (known !== undefined) return known;
        if (!isMixedColor(c)) {
            ops.push({ kind: "base", color: c });
            built.set(c, ops.length - 1);
            return ops.length - 1;
        }
        // `w` is the one colour whose parts contain another mixed colour
        const parts: readonly ColorChar[] = c === "w" ? ["y", "b"] : (COLOR_NEEDS[c] ?? []);
        const operands = parts.map(build);
        ops.push({ kind: "mixer", color: c, parts, operands });
        built.set(c, ops.length - 1);
        return ops.length - 1;
    }

    build(color);
    return ops;
}

export interface ColorChain {
    stepId: string;
    slot: number;
    color: ColorChar;
    ops: ColorOp[];
}

/**
 * One chain per painter colour port — the same chains `buildLayout` places.
 */
export function colorChains(steps: readonly PlanStep[]): ColorChain[] {
    const chains: ColorChain[] = [];
    for (const step of steps) {
        const node = step.node;
        if (node.op !== "paint" && node.op !== "paint4") continue;
        const colors: readonly (ColorChar | null)[] = node.op === "paint4" ? node.colors : [node.color];
        colors.forEach((color, i) => {
            if (!color || color === "u") return;
            chains.push({ stepId: step.id, slot: i + 1, color, ops: colorChain(color) });
        });
    }
    return chains;
}
