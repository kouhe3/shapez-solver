/** Build the Rust belt router and copy the wasm into `solver/router.wasm`. */
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const manifest = path.join(root, "native", "router", "Cargo.toml");
const built = path.join(root, "native", "router", "target", "wasm32-unknown-unknown", "release", "shapez_router.wasm");
const out = path.join(root, "solver", "router.wasm");

const res = spawnSync(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest],
    { stdio: "inherit" }
);
if (res.error) {
    console.error(`cargo failed: ${res.error.message}`);
    process.exit(1);
}
if (res.status !== 0) process.exit(res.status ?? 1);
copyFileSync(built, out);
console.log(`router wasm → ${path.relative(root, out)}`);
