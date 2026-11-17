/**
 * Dirty-cell log behind the router's resident world.
 *
 * The belt router keeps its own copy of every search-relevant cell inside wasm
 * (blocked, belt, tunnel end, tunnel-under mask, tunnel-cell flag). `World`
 * stays authoritative here: the tracked collections below mark every tile
 * whose state changed since the last search, and `routerSearch` flushes just
 * those cells (packed key → packed word) before asking for a run. A search no
 * longer re-encodes the whole map, which used to be the largest JS cost of a
 * campaign sheet.
 *
 * Packed word layout, identical to the router's box format:
 *
 *   bit 0      blocked (wall, approach or a session claim)
 *   bit 1      exempt (per search, set by the router, never stored here)
 *   bit 2      tunnel cell (a belt with another belt passing underneath)
 *   bits 8-15  belt heading: 1 "h", 2 "v", 3 "turn"
 *   bits 16-23 tunnel end direction + 1
 *   bits 24-31 bitmask of tunnel directions running underneath
 */
export interface RouterLog {
    /** wasm world slot; null until the first search (or after disposal) */
    id: number | null;
    /** instance generation the id belongs to; a re-init invalidates it */
    epoch: number;
    /** packed keys whose cell changed since the last flush to wasm */
    dirty: Set<number>;
}

export function createRouterLog(): RouterLog {
    return { id: null, epoch: 0, dirty: new Set<number>() };
}

/** a Map whose every mutation marks its tile for the next wasm flush */
export class SyncMap<V> extends Map<number, V> {
    #log: RouterLog;

    constructor(log: RouterLog) {
        super();
        this.#log = log;
    }

    override set(key: number, value: V): this {
        this.#log.dirty.add(key);
        return super.set(key, value);
    }

    override delete(key: number): boolean {
        this.#log.dirty.add(key);
        return super.delete(key);
    }

    /** `clear()` is a bulk edit: every cell it dropped still has to reach wasm */
    override clear(): void {
        for (const key of this.keys()) this.#log.dirty.add(key);
        super.clear();
    }
}

/** a Set whose every mutation marks its tile for the next wasm flush */
export class SyncSet extends Set<number> {
    #log: RouterLog;

    constructor(log: RouterLog) {
        super();
        this.#log = log;
    }

    override add(value: number): this {
        this.#log.dirty.add(value);
        return super.add(value);
    }

    override delete(value: number): boolean {
        this.#log.dirty.add(value);
        return super.delete(value);
    }

    override clear(): void {
        for (const value of this) this.#log.dirty.add(value);
        super.clear();
    }
}
