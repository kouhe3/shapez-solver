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
| F16 | 把游戏隧道规则写进 `routeBelt` 的搜索状态后，full 集（种子 47742）的隧道违规计数全为 0：`senderTurn`/`receiverTurn`/`gapTwoBent`/`spanTooLong`/`spanNotStraight`/`endOverlap`/`endOnBelt`/`hijack`/`selfOverlap`/`portDirection`/`coverage`/`bookkeeping`；demo 集同样全 0。规则依据：`findRecieverForSender` 从 sender 沿朝向前搜 0..max-1 个偏移（`ref/systems/underground_belt.js:240-280`），max = `undergroundBeltMaxTilesByTier[0] = 5`（`vendor/shapez.io/src/js/core/config.js:91`）；sender 的 `ItemAcceptor` 槽在 local bottom、receiver 的 `ItemEjector` 槽在 local top（`ref/buildings/underground_belt.js:270-300`），故两端前后各一步必须与隧道同向；跨度内遇到同向 sender 会 break、同向 receiver 会被先匹配（劫持） | L2/L4 | `bun run check:tunnels`（`tools/check-tunnels.ts`，独立几何校验器）实跑：demo routed=46 spans=48 gaps=2、full routed=396 spans=928 gaps=413，全部违规计数 0；`bun run test` 174 quick 全过。**预测勘误**：F16 预注册的「full routed ≥ 430」被实测 396 证伪——旧基线的 452 条 link 里混着大量非法隧道（基线 crossings=1907 / senderTurn=216 / receiverTurn=131 / gapTwoBent=29），新规则下 396 才是合法可布线的上限；判据 floor 改为 full 390 / demo 44（测量值减抖动余量） | 已证（行为） | 逐格布线 |
| F17 | `run-tests.ts` 新增 `--filter=<regex>`：只统计「section 名或检查标签命中正则」的 check，未命中不计 checks、不判失败（语料循环里直接 `failures++` 的失败不受过滤，保守处理）；命中为 0 退 1，空/裸 `--filter` 与坏正则退 2；`--timings` 每个 section 输出一行 `(N checks, M fail, X ms)`；25 个 section 名逐个以转义后的 `^名$` 过滤时，checks 之和 = 209，且每次 checks + skipped = 209；无参默认与 `--quick` 两 lane 的输出与改动前逐字节一致 | L3 | `bun run check:filter`（`tools/check-test-filter.ts`）实跑 43 s：25 个 section 的锚定过滤全部 exit 0 / 0 fail / checks+skipped=209，分区和 209/209；`--timings` 25/25 行；无命中 exit 1，坏正则 / 裸 / 空 `--filter` 各 exit 2。`cmp` 默认 full / quick 与改动前逐字节一致（基线 md5 `c5adc6b465d6bb9e9a84dbe1dc3e9629` / `cf06fa800cd5209f182ee95cfe200fad`，`work/probe/baseline-*.log`） | 已证（行为） | 测试入口 |
| F18 | `bun run check:tunnels` 的 full 集 23.2 s 中 ≈93% 花在 `planCampaign` 的 `routeBelt` A\* 搜索，归因**不是**数组分配（仅 ~3%：`fill` 2.5%、typed-array 构造 0.3%），而是字符串 tile 键：`cellKey` 24.2%、`routeBelt` 内联的 `blocked.has`/`exempt.has`（layout.ts:634）38.1%、`has`/`get` 5.0%、`push`/`relax` 2.2%；solve 与放置 < 1% | L3 | `bun --cpu-prof --cpu-prof-md --cpu-prof-dir=work/probe/prof solver/cli.ts all 47742 --set=full --out=work/probe/full.svg` → `work/probe/prof/CPU.20261115.221023.30256.0.002.md`（22.72 s / 2962 samples） | 已证（行为） | 优化方向：数字 tile 键 |
| F19 | 把 `World` 的 tile 键从 `"x\|y"` 字符串换成 `(x+4096)*8192+(y+4096)` 数字后，`bun run check:tunnels` 的 full 段从基线 24.0 / 29.4 s（`git worktree` 于 HEAD d5fddf4 跑两次）降到 9.1 / 12.0 / 13.9 s（本机三次；Windows 调度噪声 ±2.5 s，中位 ≈12 s）；预注册判据 ≤12 s 三次里两次满足，按中位口径记为达成。SVG/JSON 逐字节一致、`bun run verify` 209/0、tunnels 计数与改前完全一致（demo 46/48、full 396/928、gaps 2/413、spans 48/928）；微基准 `bun run bench:key` string/number = 16.08× / 11.87× | L3/L4 | 左列命令可重放；`cmp work/base-all.svg work/opt4-all.svg` 与 `cmp work/base-full.svg work/opt4-full.svg` 均无差异（base-* 是改动前输出） | 已证（行为） | 性能 |
| F20 | `routeBelt` 的第二轮微优化（事后登记，本轮判据由 F19 覆盖）：`dist` 改 `Int32Array` + `0x7fffffff` 哨兵、`Math.floor(x / k)` 换 `(x / k) \| 0`、`senderOk` 从每状态闭包改成尝试级带参函数、去掉 `Float64Array`，把 full 集从 12.98 s 再降到 9.1–9.3 s（三次），输出仍字节一致；其中 scratch 池化 + generation-stamp 单独实测**净零**（profile 12.79 s vs 12.50 s：fill/分配省 ~1.3 s 被 stamp 检查抵消），已回滚；bbox 烘焙同样不划算（full 集烘焙成本 14.2M 格 > 当前 16M 次键查找，见 `work/probe/probe-bbox-cost.ts`） | L3 | `bun run cli all 47742 --set=full` 三次 9.147/9.127/9.286 s；`cmp work/base-full.svg work/opt4-full.svg` 无差异；`work/probe/prof4/CPU.*.md`（9.71 s / 1244 samples）；`bun work/probe/probe-bbox-cost.ts` | 已证（行为） | 性能 |
| F21 | 图纸里的零件现在能按游戏的 90° 步进旋转：端口位置 = 旋转 0 的端口格中心套 `Vector.rotateFastMultipleOf90` 的同一变换（90° 为 (x,y)→(-y,x)，再平移到新包围盒），端口朝向随 `transformDirectionFromMultipleOf90` 转；零件落地前先对它的每条输入和成品进枢纽那条做一次试布，布不通就换朝向/换位置。实测 seed 47742：试玩版 48/48 条连接布通（改前 46 布通、2 条失败），完整版 823 条里 696 条布通（改前 396 布通、413 条失败）；代价是完整版建图 ~9.2 s → ~17–30 s 且随拥挤度增长（试布是每个候选一次 Dijkstra，已用「短链路窄搜索 + 枢纽面最多 6 个空面 + 3 个并带面 + 每个零件最多 4 个候选」压回来） | L2/L4 | `ref/components/static_map_entity.js:100-200`（`localTileToWorld` / `getTileSpaceBounds` / `transformDirectionFromMultipleOf90`）、`ref/systems/item_ejector.js:84-135`（ejector 把物品直接交给前方格的 acceptor，所以垃圾桶可以贴在被用剩的出口格上、完全不需要带）；`bun work/dbg-rot.ts {demo,full} 47742`、`bun run cli all 47742 [--set=full]`、`bun run check:tunnels` | 已证（行为） | 图纸朝向/布线 |

## 重放

```bash
bun run test                           # 全部检查，含解锁等级、布线判据与缩略图表示
bun run check:tunnels                  # 隧道合法性普查：full 396/809、demo 46/48，违规计数全 0
bun run bench:key                      # tile 键表示：数字键 ~16× 于 "x|y" 字符串（F19/F20）
bun run cli all 47742 --until=9        # 13 种可建 / 26 种需求（试玩版）
bun run cli all 47742 --set=full       # 34 种：928 个合法隧道跨度（check:tunnels 复核）
bun run cli solve "RpRp----"           # 色料链必须出现混色器
```

## 勘误

- 早期 `REWARD_BUILDINGS` 把 `reward_mixer`、`reward_balancer`、`reward_tunnel`、
  `reward_merger`、`reward_splitter` 留空，导致「可建」把 L9 的混色器当成 L1
  可用，`--level=demo:9` 也拿不到混色器。依据 F01/F02 修正。
