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

const decompCache = new Map();

export function decompressInt(str) {
    if (decompCache.has(str)) return decompCache.get(str);
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

/** port of savegame_compressor.decompressObject */
export function decompressObject(obj, keys = [], values = []) {
    if (obj && obj.keys && obj.values && obj.data !== undefined) {
        return decompressObject(obj.data, obj.keys, obj.values);
    }
    if (Array.isArray(obj)) return obj.map((v) => decompressObject(v, keys, values));
    if (obj !== null && typeof obj === "object") {
        const out = {};
        for (const key in obj) {
            out[keys[decompressInt(key)]] = decompressObject(obj[key], keys, values);
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

/**
 * @param {string} raw file contents as stored by the browser build
 * @returns {{ payload: object, crc: string|null, json: object }}
 */
export function decodeSavegame(raw) {
    if (typeof raw !== "string" || !raw.length) throw new Error("empty savegame");
    // The stored file is "\x01" + LZ( "crc32-...-<hash>" + JSON )
    const body = raw.charCodeAt(0) === 1 ? raw.slice(1) : raw;
    const text = decompressX64(body);
    const brace = text.indexOf("{");
    if (brace < 0) throw new Error("savegame payload has no JSON body");
    const header = text.slice(0, brace);
    const crcMatch = header.match(/([0-9a-fA-F]{6,})$/);
    const crc = crcMatch ? crcMatch[1] : null;
    const json = JSON.parse(text.slice(brace));
    const payload = decompressObject(json);
    return { payload, crc, json };
}

/** Reverse: pack a savegame payload back into the stored string form. */
export function encodeSavegame(payload) {
    const json = compressObject(payload);
    return "\x01crc32-00000000-" + compressX64(JSON.stringify(json));
}

/* ------------------------------------------------------------------ *
 * compressObject (mirror of the game) — needed to re-encode saves
 * ------------------------------------------------------------------ */

const CHARLIST = CHARMAP;
const compCache = new Map();

export function compressInt(i) {
    i += 1;
    const cacheKey = i;
    if (compCache.has(cacheKey)) return compCache.get(cacheKey);
    let result = "";
    do {
        result += CHARLIST[i % CHARLIST.length];
        i = Math.floor(i / CHARLIST.length);
    } while (i > 0);
    if (compCache.size < 200000) compCache.set(cacheKey, result);
    return result;
}

export function compressObject(obj) {
    const keys = new Map();
    const values = new Map();
    const walk = (value) => {
        if (Array.isArray(value)) return value.map(walk);
        if (value !== null && typeof value === "object") {
            const out = {};
            for (const key in value) {
                let index = keys.get(key);
                if (index === undefined) {
                    index = keys.size;
                    keys.set(key, index);
                }
                out[compressInt(index)] = walk(value[key]);
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
    const toArray = (map) => {
        const out = new Array(map.size);
        map.forEach((index, key) => (out[index] = key));
        return out;
    };
    return { keys: toArray(keys), values: toArray(values), data };
}

/* ------------------------------------------------------------------ *
 * convenience accessors
 * ------------------------------------------------------------------ */

export function findMapSeed(payload) {
    // game_root serializes `map` with a seed; different versions use different spots
    const candidates = [
        payload && payload.map && payload.map.seed,
        payload && payload.mapSeed,
        payload && payload.game && payload.game.map && payload.game.map.seed,
    ];
    for (const c of candidates) if (typeof c === "number") return c;
    return null;
}

export function summarizeSavegame(payload) {
    const top = payload && Object.keys(payload);
    return {
        topLevelKeys: top,
        version: payload && payload.version,
        mapSeed: findMapSeed(payload),
        level: payload && payload.hubGoals && payload.hubGoals.level,
        storedShapes: payload && payload.hubGoals && payload.hubGoals.storedShapes,
        upgradeLevels: payload && payload.hubGoals && payload.hubGoals.upgradeLevels,
    };
}
