#!/usr/bin/env node
/**
 * Tiny static server + JSON API for the shapez solver.
 *   node server.js [--port 8099]
 *
 *   GET /api/solve?shape=RuCw--Cw:----Ru--&buildings=cutter,stacker
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { solve, ALL_BUILDINGS } from "./src/solver.js";
import * as P from "./src/plan.js";
import * as S from "./src/shape.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let port = 8099;
const portFlag = args.find((a) => a.startsWith("--port"));
if (portFlag) {
    const eq = portFlag.indexOf("=");
    port = Number(eq >= 0 ? portFlag.slice(eq + 1) : args[args.indexOf(portFlag) + 1]);
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

function send(res, code, body, type = "application/json; charset=utf-8") {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
}

function serveFile(res, filePath) {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(__dirname)) return send(res, 403, "forbidden", "text/plain");
    fs.readFile(resolved, (err, data) => {
        if (err) return send(res, 404, "not found", "text/plain");
        res.writeHead(200, {
            "content-type": MIME[path.extname(resolved)] || "application/octet-stream",
            "cache-control": "no-store",
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/solve") {
        const shape = url.searchParams.get("shape");
        if (!shape) return send(res, 400, JSON.stringify({ ok: false, error: "missing ?shape=" }));
        const buildingsParam = url.searchParams.get("buildings");
        const buildings = buildingsParam ? new Set(buildingsParam.split(",")) : new Set(ALL_BUILDINGS);
        const budget = Number(url.searchParams.get("budget") || 30000);
        try {
            const t0 = Date.now();
            const result = solve(shape, { buildings, maxAttempts: budget });
            const ms = Date.now() - t0;
            return send(
                res,
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
            return send(res, 400, JSON.stringify({ ok: false, error: e.message }));
        }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(302, { location: "/web/index.html" });
        return res.end();
    }
    const clean = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    return serveFile(res, path.join(__dirname, clean));
});

server.listen(port, "127.0.0.1", () => {
    console.log(`shapez solver UI: http://127.0.0.1:${port}/`);
    console.log(`API: http://127.0.0.1:${port}/api/solve?shape=RuCw--Cw:----Ru--`);
});
