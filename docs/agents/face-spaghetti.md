# Face Spaghetti 落点

本仓库的 face-spaghetti 配置。`SKILL.md` §9 读它；手改优先于重跑 setup。

## 落点

「覆盖开关」列填对应的环境变量名（用默认路径也照填）；用不上的填 `—`。文件或目录不存在就标「未建」，不替仓库创建。

| 项 | 路径 / 命令 | 覆盖开关 |
|---|---|---|
| 台账 | `docs/facts.md`（F01–F27，重放命令在文末「重放」节） | `FACTS_FILE` |
| 计划 / todo | `docs/plans/*.md`（`tunnel-routing.md`、`routing-gaps.md`、`test-filter.md`）；无 `tasks/` 目录 | `PLAN_GLOBS` |
| 判据定义域表 | `docs/coverage-domain.md`（未建） | — |
| 进度 / surface 表 | 未建 | — |
| 一次性探测目录 | `work/`（gitignored）；探针放 `work/probe/`，大件产物（SVG、profile）同根放 | — |
| 仪器目录 | `tools/`：`check-tunnels.ts`、`check-test-filter.ts`、`bench-key-cost.ts` | — |
| 只读 oracle | `ref/` → junction 到 `vendor/shapez.io/src/js/game`，上游固定在 `8a79de5255fb6756f3a1d26579b1e9bc36e0c811`（= demo build `8a79de52`），由 `bun setup-ref.ts` 稀疏 clone + 重建；`demo/v/8a79de52/` 是预构建镜像。两者都只读 | — |
| backlog 发布 | `docs/agents/issue-tracker.md` → `.scratch/<feature-slug>/`（`.scratch/` 未建，首条 issue 时创建） | — |
| 门禁 | `bun run verify`（`bun check` + `bun run test`，判据是 0 failure）；`bun run check:tunnels`（隧道合法性普查）；`bun run check:filter`（harness 自检）；`bash "$HOME/.omp/agent/skills/face-spaghetti/scripts/append-only-check.sh" --worktree` | — |

判据命令只许指向 tracked 的 `tools/`（`bun run check:tunnels` 等）；一次性脚本留 `work/probe/`，台账行写路径 + 生成命令 + 输入。

## 本机事实

- Bun：`%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe`，版本 1.4.4；TypeScript 直接执行，无构建步骤，类型门是 `bun check`。
- `bash` 在 PATH 上会命中 WSL 启动器（`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`）；跑 skill 脚本必须用 Git Bash 全路径：`"C:\Program Files\Git\bin\bash.exe"`。
- 本 skill 目录：`%USERPROFILE%\.omp\agent\skills\face-spaghetti`（`scripts/`、`references/` 都在其下）。
- `ref/` 是 Windows 目录 junction，由 `bun setup-ref.ts` 创建；别手工建，别删除 `vendor/` 后忘记重跑。
- Python 只用于 `cd demo && python -m http.server 8087` 这类静态服务，不参与求解或测试。

## 共享资源

本仓库没有存档格式、音频端点、注册表键或单实例应用；唯一被多轮探测共用的是本地 HTTP 服务端口。

| 资源 | 隔离方式 | 恢复命令 |
|---|---|---|
| 求解器 Web 服务（`bun run serve`，默认 `127.0.0.1:8099`，只绑回环） | 探测用 `bun run serve --port=<其它端口>`，不占 8099；同时只跑一个实例 | `pkill -f "bun solver/server.ts"`（或按 proc 记录 kill 掉本轮 pid） |
| `savegame.json` / `savegame.raw.json` / `tree.json`（gitignored scratch，由 CLI 覆写） | 需要保留就 `cp` 到 `work/probe/` 后再跑覆写命令 | `cp work/probe/<name> ./<name>` |

## 冻结树

（未建；换目标时按 face-spaghetti `references/handoff.md` 填路径 / 冻结日期 / 基线提交 / 复跑门禁。）
