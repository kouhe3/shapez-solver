#!/usr/bin/env bash
# 重新抓取 shapez.io 官方网页 DEMO 到 ./demo
# 用法: bash fetch-demo.sh
set -euo pipefail
BASE="https://shapez.io"
BUILD="8a79de52"          # 1.5.7 @ 8a79de52
OUT="$(cd "$(dirname "$0")" && pwd)/demo"

mkdir -p "$OUT/v/$BUILD"
fetch() {
  local path="$1"
  local dest="$OUT/$path"
  mkdir -p "$(dirname "$dest")"
  echo "GET /$path"
  curl -fsSL --retry 3 --max-time 120 --ssl-no-revoke "$BASE/$path" -o "$dest"
}

fetch "index.html"
fetch "favicon.ico"
fetch "v/$BUILD/bundle.js"
fetch "v/$BUILD/main.css"
fetch "v/$BUILD/async-resources.css"
for f in \
  "res/fonts/GameFont.woff2" \
  "res/atlas0_hq.png" "res/atlas0_mq.png" "res/atlas0_lq.png" \
  "res/sounds/sfx.mp3" "res/sounds/music/theme-short.mp3" \
  "res/bg_render.webm" \
  "res/logo.png" "res/logo_demo.png" "res/logo-tobspr-games.svg" \
  "res/ui/shapez2.noinline.png" "res/ui/shapez2_banner_bg.noinline.png" ; do
  fetch "v/$BUILD/$f"
done

# 交互教程 gif（运行到对应教程步骤时才会请求）
for g in \
  1_1_extractor 1_2_conveyor 1_3_expand \
  2_1_place_cutter 2_2_place_trash 2_3_more_cutters \
  3_1_rectangles \
  21_1_place_quad_painter 21_2_switch_to_wires 21_3_place_button 21_4_press_button ; do
  fetch "v/$BUILD/res/ui/interactive_tutorial.noinline/$g.gif"
done

echo
echo "完成: $OUT  (约 20 MB)"
echo "运行: cd demo && python -m http.server 8087"
echo "打开: http://127.0.0.1:8087/"
