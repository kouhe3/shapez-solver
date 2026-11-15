#!/usr/bin/env node
/**
 * Links ./ref to the official shapez.io game sources.
 *
 * The solver's shape math and building ports are verified against the real
 * game code, so ref/ must stay a live view of the upstream repository:
 *
 *   ref -> vendor/shapez.io/src/js/game
 *
 * The checkout is a partial + sparse clone: only the JS source folders the
 * game code references are materialized. The demo in demo/ is built from
 * 8a79de52, so the checkout is pinned to that commit when it is reachable.
 *
 * Usage: node setup-ref.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_URL = "https://github.com/tobspr-games/shapez.io";
const PIN = "8a79de5255fb6756f3a1d26579b1e9bc36e0c811"; // demo build 8a79de52
const CHECKOUT = path.join(ROOT, "vendor", "shapez.io");
const LINK = path.join(ROOT, "ref");
const GAME_SRC = path.join("src", "js", "game");
const SPARSE_PATHS = ["src/js/game", "src/js/core", "src/js/savegame", "src/js/platform"];

function run(cmd, args, opts = {}) {
    execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function git(args) {
    return execFileSync("git", ["-C", CHECKOUT, ...args], { encoding: "utf8" }).trim();
}

if (!fs.existsSync(path.join(CHECKOUT, ".git"))) {
    fs.mkdirSync(path.dirname(CHECKOUT), { recursive: true });
    console.log(`cloning ${REPO_URL} (sparse, blobs on demand)`);
    run("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO_URL, CHECKOUT]);
    run("git", ["-C", CHECKOUT, "sparse-checkout", "set", ...SPARSE_PATHS]);
} else if (git(["config", "--get", "core.sparseCheckout"]) === "true") {
    // Pick up newly added source folders on an existing managed checkout.
    run("git", ["-C", CHECKOUT, "sparse-checkout", "set", ...SPARSE_PATHS]);
}

try {
    if (git(["rev-parse", "HEAD"]) !== PIN) {
        console.log(`pinning checkout to ${PIN.slice(0, 8)} (demo build)`);
        run("git", ["-C", CHECKOUT, "fetch", "--depth", "1", "origin", PIN]);
        run("git", ["-C", CHECKOUT, "checkout", "--detach", "FETCH_HEAD"]);
    }
} catch {
    console.warn(`could not pin ${PIN.slice(0, 8)}; using the current checkout`);
}

const gameSrc = path.join(CHECKOUT, GAME_SRC);
if (!fs.existsSync(gameSrc)) {
    console.error(`missing ${gameSrc}; run: git -C "${CHECKOUT}" sparse-checkout set ${SPARSE_PATHS.join(" ")}`);
    process.exit(1);
}

const linkTarget = path.relative(ROOT, gameSrc).split(path.sep).join("/");
let stat = null;
try {
    stat = fs.lstatSync(LINK);
} catch {
    // absent: create below
}

if (stat) {
    if (stat.isSymbolicLink()) {
        fs.unlinkSync(LINK);
    } else if (stat.isFile()) {
        // core.symlinks=false checkouts write the link target as a plain file
        const stored = fs.readFileSync(LINK, "utf8").trim().split(/\r?\n/)[0];
        const variants = new Set([linkTarget, linkTarget.split("/").join(path.sep)]);
        if (variants.has(stored)) {
            fs.unlinkSync(LINK);
        } else {
            console.error(`${LINK} exists and is not the ref symlink; move it away first`);
            process.exit(1);
        }
    } else {
        console.error(`${LINK} exists and is not the ref symlink; move it away first`);
        process.exit(1);
    }
}

try {
    fs.symlinkSync(linkTarget, LINK, "dir");
} catch (error) {
    if (process.platform !== "win32") throw error;
    // A junction needs no symlink privilege and behaves the same for a directory.
    fs.symlinkSync(gameSrc, LINK, "junction");
}

console.log(`ref -> ${linkTarget}`);
console.log(`shapez.io @ ${git(["rev-parse", "--short", "HEAD"])}`);
