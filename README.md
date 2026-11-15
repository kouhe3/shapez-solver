# shapez.io DEMO + 通用机器求解器

两件事：

1. `demo/` —— 官方网页版 shapez.io DEMO 的离线镜像（本地可玩）
2. `solver/` —— **通用求解器**：输入任意 shape code，输出能把它造出来的建筑方案（采矿机 / 切割机 / 旋转器 / 堆叠器 / 上色器），并自动复算校验

> 是为「任意 shape」写的，不是单关解谜脚本；游戏里的 26 个正式关卡 + 9 个 demo 关卡只是回归测试集。

---

## 0. 参考源码（官方仓库符号链接）

`ref/` 是指向 `vendor/shapez.io/src/js/game` 的符号链接；`vendor/shapez.io` 是
<https://github.com/tobspr-games/shapez.io> 的 sparse partial clone（只落盘
`src/js/{game,core,savegame,platform}`，约 2 MB），固定在 `8a79de5` —— 和 `demo/` 的 build
`8a79de52` 是同一个 commit。

```bash
node setup-ref.mjs
```

首次运行会 clone，之后只重建链接。求解器的 shape 运算和建筑端口都以 `ref/` 里的官方实现为准：
`buildings/*.js`（ItemAcceptor/ItemEjector slot）、`shape_definition.js`（切割/堆叠/旋转/上色）、
`systems/item_processor.js`（四色上色器的象限顺序）。

> `vendor/` 和 `ref` 是本机生成物，不提交；换机器后重跑一次 `node setup-ref.mjs`。

---

## 1. DEMO

- 来源：<https://shapez.io/>，官方网页 DEMO，`1.5.7 @ 8a79de52`
- 位置：`demo/`（约 20 MB），包含 `index.html`、`bundle.js`、图集、字体、音效、音乐、UI 图、交互教程 gif
- 本地运行：

  ```bash
  cd demo
  python -m http.server 8087
  # 打开 http://127.0.0.1:8087/
  ```

- 重新抓取：`bash fetch-demo.sh`（官方把资源放在 `/v/<build>/` 下，脚本按清单抓取；`async-resources.css`、`atlas0_lq.png`、`theme-short.mp3`、教程 gif 这些运行时会请求但首页没列出的文件也在清单里）

已验证：截图里能进主菜单 → PLAY → 教程关卡 1（挖圆形矿），控制台无 404。

---

## 2. 求解器

```bash
cd solver

# 命令行
node cli.js solve "RuCw--Cw:----Ru--"
node cli.js solve "CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw" --json
node cli.js solve "Cu------" --level=demo:6      # 只用第 6 关时已解锁的建筑
node cli.js render "RuCw--Cw"
node cli.js levels --game
node cli.js check                                 # 单元测试 + 全部关卡

# 网页 UI + JSON API
node server.js --port=8099
# 打开 http://127.0.0.1:8099/
# GET /api/solve?shape=RuCw--Cw:----Ru--&buildings=cutter,stacker
```

### shape code 语义（与游戏 1.5.7 完全一致）

- 象限顺序 `q0=右上, q1=右下, q2=左下, q3=左上`；每层 8 个字符 = 4 × (形状, 颜色)
- 形状 `C` 圆 / `R` 方 / `S` 星 / `W` 风车；颜色 `r g b y p c w u`，`--` 表示空位
- 例：`RuCw--Cw:----Ru--` = 底层 q0 方(无色)、q1 圆(白)、q3 圆(白)，上层 q2 方(无色)

### 建筑语义（照抄官方实现）

- **堆叠器**：下层保持不动，上层下落，直到每个象限的最小间隙恰好为 1 层；合并后超过 4 层会被截断
- **切割机**：产出 `{2,3}` 和 `{0,1}` 两半；切完为空的层会被压缩掉（层号前移）
- **四向切割机**：一次产出 4 个单象限
- **旋转器**：CW / CCW / 180°
- **上色器**：整块染一色；**四色上色器**：按象限分别上色（空的象限传 null 保留原色）

### 算法

成本最优的递归分解（每个候选都用真实堆叠模拟校验，最后再整体复算一遍）：

1. **base**：未上色的整块形状（采矿机）
2. **atom**：单层形状按象限拆块 → 各块切割/上色 → 堆叠（含"整层上色 vs 逐块上色"取优）
3. **整体上色 / 四色上色**：先去色求几何，再加一步染色
4. **旋转**：注意方向要取反——要造 `rot(shape, dir)`，最后一步是 `opposite(dir)`
5. **前缀堆叠**：`B = 前 k 层`，`T = 其余层`，且 `stack(B,T) === target`
6. **脚手架 + 切割**：目标只占半个形状时，先在会被切掉的那半边加一列"脚手架"把层高撑开，堆完再切掉（Level 20 的悬浮方块技巧）
7. **象限窗口拆分**：下层保留"某象限子集"的前 k 层，其余给上层；k=0 时就是同层合并（Level 20/26 的关键手法）
8. **兜底**：全组合拆分（受预算限制）

失败会缓存（被环检测影响的不缓存）；预算默认 30k 个状态，`--budget=N` 可调。超预算但已找到方案时会标注「可能次优」。

### 验证结果

`node test/run-tests.js`（约 5 秒，92 项检查，全部通过）：

- 编码/旋转/切割/堆叠单元测试（含 GitHub issue #313 里 Level 20 的官方构造步骤）
- 图纸端口表：逐项对照官方 `ItemEjector/ItemAcceptor` 的 slot 位置（四色上色器的颜色入口在底部）
- 多出口槽位：`cutHalf` side 1、`cutQuad` q1/q3 的连线从正确出口出发
- 9 个 DEMO 关卡目标：按各关解锁的建筑求解，全部通过
- 26 个正式关卡目标：全部求解并模拟校验通过

几个代表性结果：

| 目标 | 建筑数 | 说明 |
| --- | --- | --- |
| `CuCuCuCu` | 0 | 采矿机直接出 |
| `----CuCu` | 1 | 切一半 |
| `Cu------` | 3 | DEMO 第 6 关：切半 → 旋转 → 再切（此时还没有四向切割机） |
| `CuCuCuCu:RuRuRuRu` | 1 | 满层堆叠 |
| `RuCw--Cw:----Ru--` | 14 | Level 20「logo」：需要脚手架+切割 |
| `CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw` | 19 | Level 26「rocket」：脚手架 + 象限窗口拆分 |


---

## 3. 读地图 → 出图纸

```bash
# 读存档：从 IndexedDB 里拿到的 savegame-*.bin 原始内容（或直接给种子）
node cli.js map --save=../savegame.bin --radius=2
node cli.js map --seed=47742 --radius=3

# 按目标生成图纸：放置清单 + 物料流 + 材料表 + SVG
node cli.js blueprint "RuCw--Cw:----Ru--" --save=../savegame.bin --out=plan.svg
```

- **存档解码**：`"\x01" + LZ-String-base64( "crc32-…" + JSON )`，JSON 里是游戏自己的 key/value 内联格式；`src/savegame.js` 解出 `dump.map.seed` 和 HUB 位置。
- **地图重建**：`src/map.js` 是 `map_chunk.js` 的逐行移植（ALEA RNG、`${chunkX}|${chunkY}|${seed}`、预置的 Cu/Ru/红/绿/星矿脉、圆的叠加算法）。实测与游戏画面完全对齐（Cu 在左下、Ru 在右上、红在右下、绿在左上）。
- **图纸**：`src/layout.js` + `src/schematic.js`
  - 每个采矿机自动落到最近的对应矿脉上（给出坐标和距离）
  - 加工建筑按依赖深度排布，避开采矿脉，给出每个建筑的 tile 坐标
  - 连接按游戏真实的输入/输出口位置计算（切割机 2×1、堆叠器 2×1、上色器 2×1、四色上色器 4×1、旋转器/采矿机 1×1）
  - 输出 SVG：矿脉、HUB、建筑、输入/输出口、物料流向、传送带格数估算

### 建筑端口（默认朝向，tile 边界中点）

| 建筑 | 尺寸 | 输入 | 输出 |
| --- | --- | --- | --- |
| 采矿机 | 1×1 | — | 上 (0.5,0) |
| 旋转器 | 1×1 | 下 (0.5,1) | 上 (0.5,0) |
| 切割机 | 2×1 | 下 (0.5,1) | 上 (0.5,0)=`{2,3}`、上 (1.5,0)=`{0,1}` |
| 四向切割机 | 4×1 | 下 (0.5,1) | 上 (0.5/1.5/2.5/3.5,0)=q0/q1/q2/q3 |
| 堆叠器 | 2×1 | 下 (0.5,1)=下层、下 (1.5,1)=上层 | 上 (0.5,0) |
| 上色器 | 2×1 | 左 (0,0.5)=形状、上 (1.5,0)=颜色 | 右 (2,0.5) |
| 四色上色器 | 4×1 | 左 (0,0.5)=形状、下 (0.5/1.5/2.5/3.5,1)=q0..q3 颜色 | 上 (0.5,0) |

坐标相对建筑左上角，y 向下；多出口建筑的出口编号与游戏 `ItemEjector` 的 slot 下标一致
（图纸上的绿色 `#0..#3`）。`node test/run-tests.js` 会把这张表逐项和官方源码对齐。

网页版：<http://127.0.0.1:8087/solver/web/>（`bash sync-ui.sh` 把 solver 的 UI 同步到 `demo/solver/`，这样它和游戏同源，能直接读到游戏的 IndexedDB 存档）。点"读取游戏存档"→"生成图纸"。

> 说明：原版 1.5.7 **没有**可导入的蓝图字符串（游戏里的蓝图只是内存里的复制/粘贴，不写进存档），所以这里给的是"坐标级放置清单 + 接口精确的连线图 + 传送带格数"，传送带按图上的连线铺即可。

### 局限

- **不是所有 shape 都能造**。例如 `Cu------:--Cu----:----Cu--`（每层只占一个象限、彼此完全不重叠）：堆叠器要靠"两个形状在同一象限重叠"才能把上层撑开一层，这种目标在游戏里也造不出来。求解器会明确报告找不到方案（同时说明可能只是预算不足）。
- 只保证「建筑序列能产出该 shape」，不建模传送带、朝向、吞吐量。
- 复杂目标可能吃满预算返回次优解（UI 和 JSON 都会标注 `aborted`）。
- 图纸只保证建筑坐标和接口正确，传送带需要照着连线自己铺（原版没有蓝图字符串可以导入）。

### 关于那篇 arXiv 论文

`arXiv:2611.17309v1`《Classical Energies Learn to Reason 1,000x Faster than Looped Models》讲的是用能量模型（energy descent）解 Sudoku/Maze 这类**判定型谜题**。本项目的任务是**构造性综合**：要在 shapez 的建筑语义下找一条可执行、可逐步验证的生产链，而不是给一个解打分/去噪。因此没有采用学习式求解器；不过它提到的「能量/约束即模型」在更模糊的变体（比如带吞吐/布局约束的优化）里可能有借鉴价值。
