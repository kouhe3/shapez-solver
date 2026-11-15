# 修隧道布线（routeBelt 的隧道合法性）

gate: passed | mode=改造后做 | oracle=tools/check-tunnels.ts（独立几何校验器，不复用 routeBelt 的推导） | criteria=`bun run check:tunnels` → PASS=违规计数全 0 且 routed 不低于 F16 下限；`bun run test` 0 failure | round=1 | status=done | date=2026-11-15

依据：F15（已证现象：routeBelt 允许游戏建不出的隧道）、F16（本轮判据）、F09/F12/F14（隧道语义与画法）。
基线由 `work/probe-tunnel-rules.ts` 实测（见 F16 行）。

## 五问

| 问题 | 答 |
|---|---|
| 多项式时间有解？ | 是。固定网格上的 Dijkstra：状态 = (tile, heading, phase)，phase ∈ {surface, underground 1..4, receiver}，24 态/格。 |
| 状态空间有限？ | 是，搜索窗由 `margin` 限界（20 / 60 两轮）。 |
| 反馈几秒？ | 单元测试 2 s；full 集普查 ~31 s（一次 campaign 构建）。 |
| 判据直接？ | 是。违规计数（端点拐弯 / 跨度超长 / 同格双口 / 同向口劫持 / 口压带）二值化，独立校验器从 path + spans 反推。 |
| 能切片并行？ | 不需要；单文件改动 + 一个校验器。 |

## 游戏规则（L2，`ref/` 源码）

1. 跨度：sender 沿朝向前搜 `0..max-1` 个偏移找 receiver，`max = undergroundBeltMaxTilesByTier[0] = 5`；即 sender→receiver 间距 ≤ 5 格，严格中间的地下格 ≤ 4。tier 2（9 格）不建模，取保守值。
2. 两端朝向：sender 的输入槽在 local bottom（背后），receiver 的输出槽在 local top（前方）；所以路径在 sender / receiver 处必须直。
3. 同向口：跨度内的同向 sender 会让链接 break（没有 receiver），同向 receiver 会被先匹配（劫持）；异向口被跳过。→ 地下跨度内与两端所在格上，不得出现「与隧道同向」的另一个隧道口。
4. 隧道口是地表建筑：占格，不能再当地面带；另一条带可以在地下跨过它（异向时安全）。
5. 相邻的两段隧道接收端→发送端直接相连是合法的（receiver eject 进入 sender acceptor，方向一致即可）；共享同一格（gap-2 拐弯）不合法。

## 任务

1. `World` 增 `tunnelEnds: Map<string, dirIndex>`（地表隧道口）与 `tunnelUnder: Map<string, bitmask>`（每条隧道的地下格与方向）。依据：F16。
2. `routeBelt` 改成带 phase 的 Dijkstra：surface / underground(runLen≤4) / receiver；强制上述 1–4；端口方向（`startDir`/`goalDir`）只约束「sender 落在源端口格、receiver 落在目标端口格」的情况。依据：F16。
3. 占格：claim 时把隧道口写进 `tunnelEnds` + `occupied`，不再写 `belts`；`fit` / `placeExtractor` 把隧道口当成端口障碍。依据：F16。
4. `Connection.tunnelSpans` / `RouteResult.spans` 成为画法的唯一来源，`schematic.ts` 删除重复的跨度合并逻辑。依据：F15。
5. `tools/check-tunnels.ts` + `bun run check:tunnels`：独立校验器（span 几何、端点朝向、端口方向、口重叠、劫持、带占格）。依据：F16。
6. `run-tests.ts` 增 routeBelt 单元判据（正例 + 必失败负例）：跨度 ≤4、sender/receiver 直行、gap-2 拐弯拒绝、隧道口占格、receiver→sender 相邻链。依据：F16。

## 结果（2026-11-15）

- `bun run check:tunnels`：demo routed=46 / gaps=2 / spans=48；full routed=396 / gaps=413 / spans=928；两集全部违规计数 0。F16 预注册的 full routed ≥ 430 预测被实测 396 证伪（旧 452 条 link 依赖非法隧道），判据 floor 改为 full 390 / demo 44。
- `bun run test`：209 checks / 0 failure；`bun run test:quick` 174 checks / 0 failure。
- 中途发现并修掉：Dijkstra 缺 `dist/from` 松弛（全部路径为 null）、跨 phase 的 U 形自重叠（一格两带）、hub 目标落在隧道口上（现在拒绝并把最后一段留给地面带）。
- 画法：`schematic.ts` 直接消费 `Connection.tunnelSpans`；带条在隧道口前半格处断开，3×3 蓝/绿方块覆盖端头。
