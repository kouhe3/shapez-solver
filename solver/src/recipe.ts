/**
 * The recipe diagram of a solved plan: what a factory is made of, in what
 * order, and which machine feeds which.
 *
 * A card is one machine — a fused cutter is one card with several outlets, not
 * one card per product — and a feed is one dependency line, carrying the outlet
 * step whose product it moves. `wave` is dependency depth only (an input always
 * sits in an earlier wave than its consumer), so the board has no production
 * timing in it.
 *
 * Pure: no DOM, no SVG, no canvas. The renderer (`web/app.ts`) owns sprites,
 * card geometry and channels; everything that is a rule about the plan — one
 * card per machine, colour chains as buildings, machine-level waves, which feed
 * skips a wave and therefore needs its own lane — lives here and is testable.
 */

import * as P from "./plan.js";
import { BUILDING_NAMES } from "./catalogue.js";
import { colorChains } from "./color.js";
import { fuseCuts } from "./layout.js";
import type { PlanTree } from "./layout.js";
import type { ColorChar } from "./shape.js";

/** one dependency line, from a producing card into an input port of a consumer */
export interface RecipeFeed {
    /** index into `RecipeDiagram.cards` */
    from: number;
    /** index into `RecipeDiagram.cards` */
    to: number;
    /** the outlet step whose product the line carries (plan feeds only) */
    outlet?: P.PlanStep;
    /** the colour dot the line carries (colour feeds only) */
    color?: ColorChar;
    /** which input port of the consumer the line enters */
    slot: number;
    /** `下层` / `上层` when the consumer names its ports, else empty */
    label: string;
    /** every wave the line skips needs its own lane under the board */
    lane: number | null;
}

/** one machine of the plan: a processing step or one colour-chain building */
export interface RecipeCard {
    id: string;
    kind: "plan" | "color";
    /** plan cards: the step that names the machine (a fused cutter's rep) */
    step?: P.PlanStep;
    /** plan cards: every product this one machine yields (one per slot) */
    outlets: P.PlanStep[];
    /** colour cards: the colour the building puts out */
    color?: ColorChar;
    /** colour cards: which machine sprite this card shows */
    sprite?: "miner" | "mixer";
    /** colour cards: the painter port this chain feeds (`v16 端口2`) */
    owner?: string;
    title: string;
    detail: string;
    /** dependency depth from the left column: an input's wave is strictly lower */
    wave: number;
    isFinal: boolean;
}

export interface RecipeDiagram {
    cards: RecipeCard[];
    feeds: RecipeFeed[];
    /** number of wave columns */
    waves: number;
}

/** the input port label a consumer gives a slot, when it names them */
function inputLabel(card: RecipeCard, slot: number): string {
    if (card.kind !== "plan" || card.step?.node.op !== "stack") return "";
    return slot === 0 ? "下层" : "上层";
}

export function recipeDiagram(flat: PlanTree): RecipeDiagram {
    const fused = fuseCuts(flat);
    const cards: RecipeCard[] = [];
    /** machine id → index in `cards` */
    const machineIndex = new Map<string, number>();
    /** one feed list per card, so the flatten order matches the drawing order */
    const feedsOf: RecipeFeed[][] = [];

    const addCard = (card: RecipeCard): number => {
        cards.push(card);
        feedsOf.push([]);
        return cards.length - 1;
    };

    for (const step of fused.steps) {
        const key = step.fuseInto ?? step.id;
        let index = machineIndex.get(key);
        if (index === undefined) {
            const rep = step.fuseInto ? fused.steps.find((s) => s.id === key) ?? step : step;
            index = addCard({
                id: key,
                kind: "plan",
                step: rep,
                outlets: [],
                title: `${key} · ${BUILDING_NAMES[rep.op]}`,
                detail: rep.detail,
                wave: 0,
                isFinal: false,
            });
            machineIndex.set(key, index);
        }
        cards[index]!.outlets.push(step);
        if (step === fused.final) cards[index]!.isFinal = true;
    }

    // the machine a step id belongs to: `step.inputs` still holds the pre-fuse
    // step objects, so an alias step (`v6` fused into `v2`) must resolve through
    // a step-id → card map rather than a missing per-slot card
    const machineOf = new Map<string, number>();
    for (const step of fused.steps) {
        const index = machineIndex.get(step.fuseInto ?? step.id);
        if (index !== undefined) machineOf.set(step.id, index);
    }
    cards.forEach((card, to) => {
        const rep = card.step;
        if (!rep) return;
        rep.inputs.forEach((input, slot) => {
            const from = machineOf.get(input.id);
            if (from === undefined) return;
            feedsOf[to]!.push({ from, to, outlet: input, slot, label: "", lane: null });
        });
    });

    // machines plus the colour chains every painter port needs: a mixed colour
    // is real buildings (a mixer tree), so it belongs in the same graph, and
    // each port owns its own chain, matching what `buildLayout` places
    for (const chain of colorChains(fused.steps)) {
        const to = machineIndex.get(chain.stepId);
        if (to === undefined) continue;
        const chainCards: number[] = chain.ops.map((op, index) => {
            const id = `${chain.stepId}:${chain.slot}:${index}`;
            return addCard({
                id,
                kind: "color",
                outlets: [],
                color: op.color,
                sprite: op.kind === "base" ? "miner" : "mixer",
                owner: `${chain.stepId} 端口${chain.slot}`,
                title: op.kind === "base" ? "采矿机" : "混色器",
                detail: op.kind === "base" ? `颜色 ${op.color}` : `${op.parts.join(" + ")} → ${op.color}`,
                wave: 0,
                isFinal: false,
            });
        });
        chain.ops.forEach((op, index) => {
            if (op.kind !== "mixer") return;
            const mixer = chainCards[index];
            if (mixer === undefined) return;
            for (const operand of op.operands) {
                const from = chainCards[operand];
                if (from === undefined) return;
                // the dot is the product on the line, so it is the source's colour
                feedsOf[mixer]!.push({ from, to: mixer, color: cards[from]!.color, slot: operand, label: "", lane: null });
            }
        });
        const last = chainCards[chainCards.length - 1];
        if (last !== undefined) feedsOf[to]!.push({ from: last, to, color: cards[last]!.color, slot: chain.slot, label: "", lane: null });
    }

    // lazy waves: every card sits as late as possible, just left of its first
    // consumer, and the final product is the rightmost column. One rule for
    // shape ops and colour chains alike. A machine with several outlets waits
    // for its *earliest* consumer, so every line still points right.
    const feeds: RecipeFeed[] = feedsOf.flat();
    const consumers: number[][] = cards.map(() => []);
    for (const feed of feeds) consumers[feed.from]!.push(feed.to);
    const distance = new Map<number, number>();
    const depthOf = (index: number): number => {
        const known = distance.get(index);
        if (known !== undefined) return known;
        const downstream = consumers[index]!;
        const depth = downstream.length ? Math.max(...downstream.map((c) => depthOf(c) + 1)) : 0;
        distance.set(index, depth);
        return depth;
    };
    for (let index = 0; index < cards.length; index++) depthOf(index);
    const maxDepth = Math.max(...cards.map((_, index) => distance.get(index) ?? 0), 0);
    cards.forEach((card, index) => {
        card.wave = maxDepth - (distance.get(index) ?? 0);
    });

    // a line that skips a wave would cross the cards of the column between, so
    // it gets its own lane under the whole board; one lane per such feed
    let lanes = 0;
    for (const feed of feeds) {
        feed.label = inputLabel(cards[feed.to]!, feed.slot);
        if (cards[feed.to]!.wave - cards[feed.from]!.wave >= 2) feed.lane = lanes++;
    }

    return { cards, feeds, waves: maxDepth + 1 };
}
