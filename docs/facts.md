# 游戏源码事实台账（shapez.io 1.5.7）

按 `face-spaghetti` 的约定：一行一个 claim，出处可重放，状态只增不减。
`ref/` 固定在上游 `8a79de5`，和 `demo/` 的 build `8a79de52` 同源；L2 = 读
`ref/` 源码或 `demo/` 实体文件，L4 = 实机/成品输出观察。

| id | claim | 等级 | 出处 | 状态 | 影响 |
|---|---|---|---|---|---|
| F01 | 奖励→零件映射在 `tutorial_goals_mappings.js`：`reward_mixer`→混色器、`reward_stacker`→堆叠器，平衡器/隧道/并带器/分流器也在同一张表里 | L2 | `ref/tutorial_goals_mappings.js`(`enumHubGoalRewardsToContentUnlocked`) | 已证（机制） | 解锁等级表 |
| F02 | 奖励是「通关后」才发，所以 L8 的混色器奖励从 **L9** 才能用；L10 的堆叠器奖励从 L11 才能用 | L2 | `ref/modes/levels.js` + `ref/tutorial_goals_mappings.js`；`availableLevels()` 的 `level + 1` | 已证（机制） | `可建` 列、`--until` |
| F03 | 网页试玩版只有 9 关（`WEB_DEMO_LEVELS`），没有 `reward_stacker`，所以试玩版里堆叠器和所有需要它的图形都建不出来 | L2/L4 | `ref/modes/levels.js:18`；实跑 `node cli.js all 47742 --until=9` 得 13 种不可建 | 已证（机制） | 不可建 / 跳过分类 |
| F04 | 升级档位不跟关卡绑定（`generateUpgrades` 只按档位给形状），所以 L9 玩家买了几档升级无法从关卡推出；只有关卡目标能按关过滤 | L2 | `ref/modes/regular.js:75`、`:395` | 已证（机制） | `--until` 只按「解锁等级 + 关卡来源」过滤 |
| F05 | 游戏地图视图把建筑画成整块 `getSilhouetteColor` 剪影；采矿机、旋转器、垃圾桶另有 3×3 `getSpecialOverlayRenderMatrix` 挖空；地图视图不画机器图标 | L2 | `ref/map_chunk_view.js:184-215`；`ref/buildings/{miner,rotater,trash}.js` | 已证（机制） | 图纸建筑画法 |
| F06 | `demo/` 镜像只有 `atlas0_*.png`，没有 `res/sprites.json`，单个建筑贴图的图集坐标不可得；可复现的视觉语言只有地图视图的剪影 | L4 | `ls demo/v/8a79de52/res`；bundle 内无 sprite 名表 | 已证（现象） | 不嵌入游戏贴图 |
| F07 | 升级需求会乘 `difficultyMultiplicator`：网页试玩版是 **0.5**，独立版/Steam 认证是 1.0 | L2 | `ref/modes/regular.js:380-390`、`:243-255` | 已证（机制） | 试玩版升级数量是表里的一半（ETA 口径） |
| F08 | 试玩版的 `limitedVersion = true` 只去掉无尽档，固定 7 档仍在；于是试玩版会要求需要堆叠器的升级形状，却没有堆叠器 | L2 | `ref/modes/regular.js:75-85`、`:394` | 已证（机制） | 需求表保留形状、图纸标不可建 |
| F09 | 传送带交叉需要隧道（L6 解锁）且两条带必须垂直；同向重叠不是交叉 | L2 | `ref/buildings/underground_belt.js`；`routeBelt()` 的 `belt !== across` 判据 | 已证（机制） | 逐格布线 |

## 重放

```bash
cd solver
node test/run-tests.js                 # 182 项，含解锁等级与布线判据
node cli.js all 47742 --until=9        # 13 种可建 / 26 种需求（试玩版）
node cli.js solve "RpRp----"           # 色料链必须出现混色器
```

## 勘误

- 早期 `REWARD_BUILDINGS` 把 `reward_mixer`、`reward_balancer`、`reward_tunnel`、
  `reward_merger`、`reward_splitter` 留空，导致「可建」把 L9 的混色器当成 L1
  可用，`--level=demo:9` 也拿不到混色器。依据 F01/F02 修正。
