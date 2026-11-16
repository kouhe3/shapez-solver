#!/usr/bin/env bun
/**
 * Tiny static server + JSON API for the shapez solver.
 *   bun server.ts [--port 8099]
 *
 *   GET /api/solve?shape=RuCw--Cw:----Ru--&buildings=cutter,stacker
 *
 * The web UI is TypeScript too, so /web/app.js and /src/<name>.js are
 * transpiled in-process: no build step, no node_modules in the browser.
 */

import path from "node:path";
import { solve, ALL_BUILDINGS } from "./src/solver.js";
import type { SolveResult } from "./src/solver.js";
import * as P from "./src/plan.js";
import * as S from "./src/shape.js";

const ROOT = path.resolve(import.meta.dir);

const args = process.argv.slice(2);
let port = 8099;
const portFlagIndex = args.findIndex((a) => a.startsWith("--port"));
const portFlag = args[portFlagIndex];
if (portFlag !== undefined) {
    const eq = portFlag.indexOf("=");
    port = Number(eq >= 0 ? portFlag.slice(eq + 1) : args[portFlagIndex + 1]);
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

function send(status: number, body: string, type = "application/json; charset=utf-8"): Response {
    return new Response(body, {
        status,
        headers: { "content-type": type, "cache-control": "no-store" },
    });
}

function solveRequest(url: URL): Response {
    const shape = url.searchParams.get("shape");
    if (!shape) return send(400, JSON.stringify({ ok: false, error: "missing ?shape=" }));
    const buildingsParam = url.searchParams.get("buildings");
    const buildings = buildingsParam ? new Set(buildingsParam.split(",")) : new Set(ALL_BUILDINGS);
    const budget = Number(url.searchParams.get("budget") || 30000);
    try {
        const t0 = Date.now();
        const result: SolveResult = solve(shape, { buildings, maxAttempts: budget });
        const ms = Date.now() - t0;
        return send(
            200,
            JSON.stringify({
                ok: result.ok,
                error: result.error,
                target: S.hash(result.target),
                cost: result.cost,
                ms,
                aborted: !!(result.stats && result.stats.aborted),
                verification: result.verification,
                plan: result.plan ? P.planToJSON(result.plan) : null,
            })
        );
    } catch (e) {
        return send(400, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
}

async function serveFile(filePath: string): Promise<Response> {
    const resolved = path.resolve(filePath);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
        return send(403, "forbidden", "text/plain");
    }
    const file = Bun.file(resolved);
    if (!(await file.exists())) return send(404, "not found", "text/plain");
    return new Response(file, {
        headers: {
            "content-type": MIME[path.extname(resolved)] || "application/octet-stream",
            "cache-control": "no-store",
        },
    });
}

async function serveModule(sourcePath: string): Promise<Response> {
    let source: string;
    try {
        source = await Bun.file(sourcePath).text();
    } catch {
        return send(404, "not found", "text/plain");
    }
    return send(200, transpiler.transformSync(source), "text/javascript; charset=utf-8");
}

const MODULE_PATH = /^\/src\/([A-Za-z0-9_-]+)\.js$/;

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/solve") return solveRequest(url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(null, { status: 302, headers: { location: "/web/index.html" } });
    }
    if (url.pathname === "/web/app.js") return serveModule(path.join(ROOT, "web", "app.ts"));
    const moduleName = MODULE_PATH.exec(url.pathname)?.[1];
    if (moduleName !== undefined) {
        const sourcePath = path.join(ROOT, "src", `${moduleName}.ts`);
        // lz_factory is plain JS, so a missing .ts falls through to the static file.
        if (await Bun.file(sourcePath).exists()) return serveModule(sourcePath);
    }
    const clean = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    return serveFile(path.join(ROOT, clean));
}

Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });

console.log(`shapez solver UI: http://127.0.0.1:${port}/`);
console.log(`API: http://127.0.0.1:${port}/api/solve?shape=RuCw--Cw:----Ru--`);
