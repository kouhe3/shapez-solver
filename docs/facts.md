# 游戏源码事实台账（shapez.io 1.5.7）

按 `face-spaghetti` 的约定：一行一个 claim，出处可重放，状态只增不减。
`ref/` 固定在上游 `8a79de5`，和 `demo/` 的 build `8a79de52` 同源；L2 = 读
`ref/` 源码或 `demo/` 实体文件，L4 = 实机/成品输出观察。

| id | claim | 等级 | 出处 | 状态 | 影响 |
|---|---|---|---|---|---|
| F01 | 奖励→零件映射在 `tutorial_goals_mappings.js`：`reward_mixer`→混色器、`reward_stacker`→堆叠器，平衡器/隧道/并带器/分流器也在同一张表里 | L2 | `ref/tutorial_goals_mappings.js`(`enumHubGoalRewardsToContentUnlocked`) | 已证（机制） | 解锁等级表 |
| F02 | 奖励是「通关后」才发，所以 L8 的混色器奖励从 **L9** 才能用；L10 的堆叠器奖励从 L11 才能用 | L2 | `ref/modes/levels.js` + `ref/tutorial_goals_mappings.js`；`availableLevels()` 的 `level + 1` | 已证（机制） | `可建` 列、`--until` |
| F03 | 网页试玩版只有 9 关（`WEB_DEMO_LEVELS`），没有 `reward_stacker`，所以试玩版里堆叠器和所有需要它的图形都建不出来 | L2/L4 | `ref/modes/levels.js:18`；实跑 `bun run cli all 47742 --until=9` 得 13 种不可建 | 已证（机制） | 不可建 / 跳过分类 |
| F04 | 升级档位不跟关卡绑定（`generateUpgrades` 只按档位给形状），所以 L9 玩家买了几档升级无法从关卡推出；只有关卡目标能按关过滤 | L2 | `ref/modes/regular.js:75`、`:395` | 已证（机制） | `--until` 只按「解锁等级 + 关卡来源」过滤 |
| F05 | 游戏地图视图把建筑画成整块 `getSilhouetteColor` 剪影；采矿机、旋转器、垃圾桶另有 3×3 `getSpecialOverlayRenderMatrix` 挖空；地图视图不画机器图标 | L2 | `ref/map_chunk_view.js:184-215`；`ref/buildings/{miner,rotater,trash}.js` | 已证（机制） | 图纸建筑画法 |
| F06 | `demo/` 镜像只有 `atlas0_*.png`，没有 `res/sprites.json`，单个建筑贴图的图集坐标不可得；可复现的视觉语言只有地图视图的剪影 | L4 | `ls demo/v/8a79de52/res`；bundle 内无 sprite 名表 | 已证（现象） | 不嵌入游戏贴图 |
| F07 | 升级需求会乘 `difficultyMultiplicator`：网页试玩版是 **0.5**，独立版/Steam 认证是 1.0 | L2 | `ref/modes/regular.js:380-390`、`:243-255` | 已证（机制） | 试玩版升级数量是表里的一半（ETA 口径） |
| F08 | 试玩版的 `limitedVersion = true` 只去掉无尽档，固定 7 档仍在；于是试玩版会要求需要堆叠器的升级形状，却没有堆叠器 | L2 | `ref/modes/regular.js:75-85`、`:394` | 已证（机制） | 需求表保留形状、图纸标不可建 |
| F09 | 传送带交叉需要隧道（L6 解锁）且两条带必须垂直；同向重叠不是交叉 | L2 | `ref/buildings/underground_belt.js`；`routeBelt()` 的 `belt !== across` 判据 | 已证（机制） | 逐格布线 |
| F10 | 正式版需求表（`#all-set=full`）下图纸的关卡下拉只有 9 个关卡选项；根因是 `levelsFor()` 只把 `game` 映射到 `FULL_LEVELS`，而 `#all-set` 的取值是 `full`。判据：浏览器把 `#all-set` 设为 `full` 并触发 change，`#all-until option` 数量修复前 = 10（占位+9）、修复后 = 27（占位+26），`demo` 对照恒为 10 | L4/L2 | 实机测量（headless Chromium）；`solver/web/app.ts`、`solver/web/index.html:37`；`levelsForVersion()` 见 `solver/src/levels.ts:102` | 已证（行为） | 关卡列表 |
| F11 | 游戏缩略图把传送带画成 `THEME.map.chunkOverview.beltColor`（#777）、每格 3×3 覆盖矩阵（带厚 = 1/3 格）的色块线；当前图纸画成 0.14 格宽 #797a80 折线。判据：修复后图纸传送带填充 = #777、带宽 = t/3（±0.5px） | L2/L4 | `ref/themes/light.json:45`、`ref/buildings/belt.js:11-17,46,126`；用户截图实测 tile≈34.7px、带厚 12px（0.346 格）；`bun run cli all 47742` 出图 `stroke="#777" stroke-width="7"`（t=21，3 的倍数） | 已证（行为） | 传送带画法 |
| F12 | 游戏缩略图把隧道画成 sender `#6d9dff` / receiver `#71ff9c` 的 1×1 剪影 + `getSpecialOverlayRenderMatrix` 3×3 覆盖矩阵；当前图纸画成白色小方块。判据：修复后含交叉的 SVG 出现两种颜色且白色隧道方块归零 | L2/L4 | `ref/buildings/underground_belt.js:28-30,68-88`、`enumDirectionToAngle` 见 `vendor/shapez.io/src/js/core/vector.js:30`；`bun run cli all 47742 --set=full` 得 1353 对 sender/receiver、0 个 `#f8f9ff`；`bun run test` 报 0 failure | 已证（行为） | 隧道画法 |
| F13 | 游戏缩略图按每格 3×3 像素绘制：每个设施是 3×3 色块（采矿机 `[1,1,1,1,0,1,1,1,1]`、垃圾桶 `[1,1,0,1,1,1,0,1,1]`），传送带 1 格宽、隧道 sender/receiver 各带 3×3 矩阵；自动图纸尺寸取 3 的倍数，使 1/3 格落在整像素上 | L2/L4 | `ref/buildings/miner.js:12`、`ref/buildings/trash.js:11`、`ref/buildings/belt.js:11-17`；`bun run cli all 47742` 出图 `stroke-width="7"`、`t=21` | 已证（行为） | 图纸网格 |
| F14 | 同一段地下的连续交叉是一条隧道：交叉间隔 1 格（连续）或 2 格且中间直行时合并为一个跨度（一个 sender + 一个 receiver）；拐弯间隔保持两段。演示图纸重复方块 8 → 1，full 集 1907 crossings → 1353 spans / 2706 blocks | L4 | `schematicSVG()` 的跨度分组；`bun run test` 的 one-span 用例；`bun run cli all 47742 --set=full` 出图计数 | 已证（行为） | 隧道跨度 |
| F15 | `routeBelt` 只检查交叉格两条带垂直，允许游戏建不出的隧道：sender/receiver 落在拐角（full 集 senderTurn=182、receiverTurn=131）、两条隧道只隔 1 格且拐弯（gapTwoBent=29）、receiver 落在另一条带的地下格（2 处 receiver+receiver 重叠）。回流条件见 `docs/design-notes.md` | L4 | 一次性探针 `work/probe-full-tunnels.ts`（输入：种子 47742 + `needs.ts` full 集）；`bun run cli all 47742 --set=full --out=work/plan-full.svg` 后统计 `#6d9dff`/`#71ff9c` 的重复 translate | 已证（现象） | 待修：路由约束 |

## 重放

```bash
bun run test                           # 189 项，含解锁等级、布线判据与缩略图表示
bun run cli all 47742 --until=9        # 13 种可建 / 26 种需求（试玩版）
bun run cli all 47742 --set=full       # 34 种：1353 对隧道口、0 个白色隧道方块
bun run cli solve "RpRp----"           # 色料链必须出现混色器
```

## 勘误

- 早期 `REWARD_BUILDINGS` 把 `reward_mixer`、`reward_balancer`、`reward_tunnel`、
  `reward_merger`、`reward_splitter` 留空，导致「可建」把 L9 的混色器当成 L1
  可用，`--level=demo:9` 也拿不到混色器。依据 F01/F02 修正。
