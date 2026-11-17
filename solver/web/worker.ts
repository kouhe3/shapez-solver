/**
 * The campaign runs here, not on the page thread.
 *
 * A full sheet takes tens of seconds (and rip-up made it slower), so solving on
 * the main thread freezes the tab and Chrome reports "page unresponsive". The
 * worker owns the whole solve; the page only renders the result.
 */
import { ALL_BUILDINGS } from "../src/solver.js";
import { scanForTypes } from "../src/map.js";
import { neededShapes, requiredTypes } from "../src/needs.js";
import { planCampaign } from "../src/campaign.js";
import type { CampaignResult } from "../src/campaign.js";
import { levelsForVersion } from "../src/levels.js";
import type { NeedSetName } from "../src/needs.js";
import { initRouterWasm } from "../src/router-engine.js";

export interface CampaignJob {
    seed: number;
    hub: { x: number; y: number };
    set: NeedSetName;
    untilLevel: number | null;
}

export interface CampaignReply {
    result: CampaignResult;
    radius: number;
    missingTypes: string[];
}

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<{ id: number; job: CampaignJob }>) => void) | null;
    postMessage: (message: unknown) => void;
};

/** the belt router is Rust; load it before the first campaign touches it */
const routerReady = (async (): Promise<void> => {
    const res = await fetch("/router.wasm");
    if (!res.ok) throw new Error(`router.wasm: HTTP ${res.status}`);
    initRouterWasm(await res.arrayBuffer());
})();

scope.onmessage = async (event) => {
    const { id, job } = event.data;
    try {
        await routerReady;
        const shapes = neededShapes({ set: job.set });
        const scan = scanForTypes(job.seed, {
            types: requiredTypes(shapes),
            startRadius: job.set === "full" ? 10 : 8,
            maxRadius: 32,
        });
        const result = planCampaign({
            shapes,
            patches: scan.patches,
            hub: job.hub,
            buildings: new Set(ALL_BUILDINGS),
            untilLevel: job.untilLevel,
            levels: levelsForVersion(job.set),
        });
        const value: CampaignReply = { result, radius: scan.radius, missingTypes: scan.missingTypes };
        scope.postMessage({ id, ok: true, value });
    } catch (error) {
        scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
