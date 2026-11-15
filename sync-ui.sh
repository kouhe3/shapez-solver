#!/usr/bin/env bash
# 把 solver 的 UI + src 同步到 demo/solver（同源，才能读游戏存档的 IndexedDB）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$ROOT/demo/solver/src" "$ROOT/demo/solver/web"
mkdir -p "$ROOT/demo/solver"
cp -r "$ROOT/solver/src" "$ROOT/demo/solver/src"
cp -r "$ROOT/solver/web" "$ROOT/demo/solver/web"
echo "synced -> demo/solver"
