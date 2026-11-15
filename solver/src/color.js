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

export const COLOR_BITS = { u: 0, r: 1, g: 2, y: 3, b: 4, p: 5, c: 6, w: 7 };
export const BITS_COLOR = ["u", "r", "g", "y", "b", "p", "c", "w"];

/** base colours each mixed colour is mixed from, in mixer input order */
export const COLOR_NEEDS = { y: ["r", "g"], p: ["r", "b"], c: ["g", "b"], w: ["r", "g", "b"] };

/** mixed colours need a mixer chain, base colours only a miner */
export const MIXED_COLORS = new Set(["y", "p", "c", "w"]);

/** the parts a colour chain is built from */
export const COLOR_OP_LABELS = { base: "采矿机", mixer: "混色器" };

export function mixColor(a, b) {
    return BITS_COLOR[(COLOR_BITS[a] || 0) | (COLOR_BITS[b] || 0)] || "u";
}

/**
 * The ops one colour chain needs, dependencies first.
 *
 * A base colour is a single miner. A mixed colour is the mix tree of its parts:
 * `p = r + b`, and `w = mix(mix(r, g), b)` — a mixer takes two colours, so
 * three parts need two mixers in a tree.
 *
 * @param {string} color
 * @returns {Array<{kind: "base"|"mixer", color: string, parts?: string[], operands?: number[]}>}
 *   `operands` index into this same array: the two colours a mixer consumes.
 */
export function colorChain(color) {
    if (!color || color === "u") return [];
    const ops = [];
    const built = new Map();

    function build(c) {
        if (built.has(c)) return built.get(c);
        if (!MIXED_COLORS.has(c)) {
            ops.push({ kind: "base", color: c });
            built.set(c, ops.length - 1);
            return ops.length - 1;
        }
        // `w` is the one colour whose parts contain another mixed colour
        const parts = c === "w" ? ["y", "b"] : COLOR_NEEDS[c];
        const operands = parts.map(build);
        ops.push({ kind: "mixer", color: c, parts, operands });
        built.set(c, ops.length - 1);
        return ops.length - 1;
    }

    build(color);
    return ops;
}

/**
 * One chain per painter colour port — the same chains `buildLayout` places.
 *
 * @param {Array} steps flat plan steps (`P.flatten(...).steps`)
 * @returns {Array<{stepId: string, slot: number, color: string, ops: Array}>}
 */
export function colorChains(steps) {
    const chains = [];
    for (const step of steps) {
        if (step.op !== "paint" && step.op !== "paint4") continue;
        const colors = step.op === "paint4" ? step.node.colors : [step.node.color];
        colors.forEach((color, i) => {
            if (!color || color === "u") return;
            chains.push({ stepId: step.id, slot: i + 1, color, ops: colorChain(color) });
        });
    }
    return chains;
}
