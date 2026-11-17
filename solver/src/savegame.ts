/**
 * shapez.io savegame reader.
 *
 * File layout (as written by the game into IndexedDB `app_storage.files`):
 *
 *   "\x01" + "crc32-<hex>-" + LZ-String-base64( JSON({keys,values,data}) )
 *
 * The JSON is the output of savegame_compressor.compressObject(): object keys
 * and string values are interned into tables. decompressObject() undoes that.
 */

import { decompressX64, compressX64 } from "./lz_factory.js";

const CHARMAP =
    "!#%&'()*+,-./:;<=>?@[]^_`{|}~¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿABCDEFGHIJKLMNOPQRSTUVWXYZ";

const decompCache = new Map<string, number>();

export function decompressInt(str: string): number {
    const cached = decompCache.get(str);
    if (cached !== undefined) return cached;
    let result = 0;
    for (let i = str.length - 1; i >= 0; --i) {
        const digit = CHARMAP.indexOf(str.charAt(i));
        if (digit < 0) throw new Error("bad compressed int char: " + str.charAt(i));
        result = result * CHARMAP.length + digit;
    }
    result -= 1;
    if (decompCache.size < 200000) decompCache.set(str, result);
    return result;
}

/** the interned key/value envelope compressObject writes and decompressObject reads */
export interface CompressedObject {
    keys: string[];
    values: string[];
    data: unknown;
}

/** port of savegame_compressor.decompressObject */
export function decompressObject(obj: unknown, keys: string[] = [], values: unknown[] = []): unknown {
    if (obj !== null && typeof obj === "object") {
        // the envelope is the only object shape that carries its own tables
        const envelope = obj as Partial<CompressedObject>;
        if (envelope.keys && envelope.values && envelope.data !== undefined) {
            return decompressObject(envelope.data, envelope.keys, envelope.values);
        }
        if (Array.isArray(obj)) return (obj as unknown[]).map((v) => decompressObject(v, keys, values));
        const record = obj as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key in record) {
            out[String(keys[decompressInt(key)])] = decompressObject(record[key], keys, values);
        }
        return out;
    }
    if (typeof obj === "string") {
        const index = decompressInt(obj);
        if (index < 0 || index >= values.length) throw new Error("bad value index " + index);
        return values[index];
    }
    return obj;
}

export interface DecodedSavegame {
    /** the decompressed savegame root object */
    payload: unknown;
    /** the crc32 footer from the stored header, if the file has one */
    crc: string | null;
    /** the JSON envelope (`keys`/`values`/`data`) before key interning is undone */
    json: unknown;
}

/**
 * @param {string} raw file contents as stored by the browser build
 */
export function decodeSavegame(raw: string): DecodedSavegame {
    if (typeof raw !== "string" || !raw.length) throw new Error("empty savegame");
    // The stored file is "\x01" + LZ( "crc32-...-<hash>" + JSON )
    const body = raw.charCodeAt(0) === 1 ? raw.slice(1) : raw;
    const text = decompressX64(body);
    const brace = text.indexOf("{");
    if (brace < 0) throw new Error("savegame payload has no JSON body");
    const header = text.slice(0, brace);
    const crcMatch = header.match(/([0-9a-fA-F]{6,})$/);
    const crc = crcMatch ? (crcMatch[1] ?? null) : null;
    const json: unknown = JSON.parse(text.slice(brace));
    const payload = decompressObject(json);
    return { payload, crc, json };
}

/** Reverse: pack a savegame payload back into the stored string form. */
export function encodeSavegame(payload: unknown): string {
    const json = compressObject(payload);
    return "\x01crc32-00000000-" + compressX64(JSON.stringify(json));
}

/* ------------------------------------------------------------------ *
 * compressObject (mirror of the game) — needed to re-encode saves
 * ------------------------------------------------------------------ */

const CHARLIST = CHARMAP;
const compCache = new Map<number, string>();

export function compressInt(i: number): string {
    i += 1;
    const cacheKey = i;
    const cached = compCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let result = "";
    do {
        result += CHARLIST.charAt(i % CHARLIST.length);
        i = Math.floor(i / CHARLIST.length);
    } while (i > 0);
    if (compCache.size < 200000) compCache.set(cacheKey, result);
    return result;
}

export function compressObject(obj: unknown): CompressedObject {
    const keys = new Map<string, number>();
    const values = new Map<string, number>();
    const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk);
        if (value !== null && typeof value === "object") {
            const record = value as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const key in record) {
                let index = keys.get(key);
                if (index === undefined) {
                    index = keys.size;
                    keys.set(key, index);
                }
                out[compressInt(index)] = walk(record[key]);
            }
            return out;
        }
        if (typeof value === "string") {
            let index = values.get(value);
            if (index === undefined) {
                index = values.size;
                values.set(value, index);
            }
            return compressInt(index);
        }
        return value;
    };
    const data = walk(obj);
    const toArray = (map: Map<string, number>): string[] => {
        const out = new Array<string>(map.size);
        map.forEach((index, key) => (out[index] = key));
        return out;
    };
    return { keys: toArray(keys), values: toArray(values), data };
}

/* ------------------------------------------------------------------ *
 * convenience accessors
 * ------------------------------------------------------------------ */

export interface SavegamePoint {
    x: number;
    y: number;
}

export interface SavegameInfo {
    seed: number;
    hub: SavegamePoint;
    level?: number;
    dump?: unknown;
}

/*
 * The save format is not modelled in full: the codec above hands out `unknown`
 * and the accessors below cast a payload once at the boundary, then narrow every
 * field they read.
 */
interface SavegameEntity {
    components?: { StaticMapEntity?: { code?: unknown; origin?: SavegamePoint | null } | null } | null;
}

interface SavegamePayload {
    dump?: SavegamePayload | null;
    map?: { seed?: unknown } | null;
    mapSeed?: unknown;
    game?: { map?: { seed?: unknown } | null } | null;
    entities?: ReadonlyArray<SavegameEntity | null | undefined> | null;
    hubGoals?: { level?: number; storedShapes?: unknown; upgradeLevels?: unknown } | null;
    version?: unknown;
}

/**
 * Seed, hub origin and level out of a decoded payload (or a bare dump).
 */
export function savegameMapInfo(payload: unknown): SavegameInfo {
    const root = payload as SavegamePayload | null | undefined;
    const dump = (root && root.dump) || root;
    const seed = dump && dump.map && dump.map.seed;
    if (typeof seed !== "number") throw new Error("savegame has no map seed");
    let hub: SavegamePoint = { x: -2, y: -2 };
    for (const e of (dump && dump.entities) || []) {
        const sm = e && e.components && e.components.StaticMapEntity;
        if (!sm || sm.code !== 26 || !sm.origin) continue;
        // Tiles pack into 13 bits per axis (`cellKey` in layout.ts), so a hub
        // outside that range cannot be placed at all, and a non-number would
        // feed NaN into the router box and trap inside wasm.
        const { x, y } = sm.origin;
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < -4096 || x > 4095 || y < -4096 || y > 4095) {
            throw new Error(`savegame hub origin out of range: (${String(x)}, ${String(y)})`);
        }
        hub = { x, y };
    }
    // a malformed dump can leave `hubGoals` null; the game always writes a level
    const level = (dump && dump.hubGoals && dump.hubGoals.level) as number | undefined;
    return { seed, hub, level, dump };
}

export function findMapSeed(payload: unknown): number | null {
    const root = payload as SavegamePayload | null | undefined;
    // game_root serializes `map` with a seed; different versions use different spots
    const candidates = [
        root && root.map && root.map.seed,
        root && root.mapSeed,
        root && root.game && root.game.map && root.game.map.seed,
    ];
    for (const c of candidates) if (typeof c === "number") return c;
    return null;
}

export interface SavegameSummary {
    topLevelKeys: string[] | null | undefined;
    version: unknown;
    mapSeed: number | null;
    level: unknown;
    storedShapes: unknown;
    upgradeLevels: unknown;
}

export function summarizeSavegame(payload: unknown): SavegameSummary {
    const root = payload as SavegamePayload | null | undefined;
    const top = payload ? Object.keys(payload as Record<string, unknown>) : (payload as string[] | null | undefined);
    return {
        topLevelKeys: top,
        version: root && root.version,
        mapSeed: findMapSeed(payload),
        level: root && root.hubGoals && root.hubGoals.level,
        storedShapes: root && root.hubGoals && root.hubGoals.storedShapes,
        upgradeLevels: root && root.hubGoals && root.hubGoals.upgradeLevels,
    };
}
