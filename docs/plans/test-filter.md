# Harness filter + timing（F17）

gate: passed | mode=直接做 | oracle=`bun tools/check-test-filter.ts`（section 分区 + 负例退出码 + timings 行数） | criteria=`bun run check:filter` 全 lane ok，且 `cmp` 默认 full/quick 输出与改动前逐字节一致 | round=1 | status=done | date=2026-11-15

## 背景

`bun run test` 只有 `--quick` 一个粗档：失败时无法只重跑某一段，也没有分段耗时。整体迁移到 `bun test` 要重写 866 行 / 164 个断言点，收益（`-t` 过滤 + 覆盖率）不匹配；本任务只补最短的两块。

## 任务

- [x] `run-tests.ts`：`beginSection` 跟踪当前 section；`--filter=<regex>` 按 section 名或检查标签选择 check（未命中不计 checks、不判失败；零命中退 1；空/裸/坏正则退 2）。依据：F17
- [x] `run-tests.ts`：`--timings` 每 section 输出一行 `(N checks, M fail, X ms)`。依据：F17
- [x] `tools/check-test-filter.ts` + `check:filter` 脚本：25 个 section 锚定过滤的分区和 = 209、每条 checks + skipped = 209、timings 行数、负例退出码。依据：F17
- [x] 文档：AGENTS.md 命令块与测试章节。依据：F17

## 证据

- `bun run check:filter`：25 sections，every lane passes（43 s）。
- `bun run test` / `bun run test:quick`：209 / 174 checks，0 failure；输出与改动前逐字节一致（md5 `c5adc6b465d6bb9e9a84dbe1dc3e9629` / `cf06fa800cd5209f182ee95cfe200fad`）。
- `bun check`：21 files，0 errors。

## 已知边界

- `--filter` 不省计算：未选中的 block 仍执行（语料循环的 `[ok]` 行照打），只影响统计与失败上报。
- 语料循环里直接 `failures++` 的求解失败不受过滤影响（保守：结构性回归永远 fail）。
- `--quick` 与 `--filter` 组合时两段语料 section 不存在，零命中过滤器会退 1。
- 未覆盖：`--filter` 与基线的逐字节比较（过滤 lane 只断言计数与退出码）。
