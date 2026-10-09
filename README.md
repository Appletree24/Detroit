# Detroit

用于改进 Coding Agent Harness、比较 agent 配置的本地实验平台。面向 Harness 开发与 LLM 测评：自己实现执行循环，用独立验证器判分，再从证据和报告定位问题。

**当前：M1 使用 Bubblewrap，无需 Docker。** 已有参考 Harness、5 个开发任务、独立沙箱执行与评分、SQLite/JSONL、重评分和静态报告。本机已完成真实 Bubblewrap 隔离、取消回收与完整 10-Trial smoke；真实模型实验尚待执行。最新范围与待审阅方案见 [CONTEXT.md](CONTEXT.md) 和 [docs/MVP-DESIGN.md](docs/MVP-DESIGN.md)，实际实现边界见 [docs/M1.md](docs/M1.md)；[DESIGN.md](DESIGN.md) 保留历史设计。本轮只修复既有行为，未新增 Web、现场保存、通用题库、人工评分或统计模块。

## 先看结果

打开 [Bubblewrap 实跑报告](examples/reports/m1-bubblewrap.html)：包含任务通过情况、修改前后代码、工具轨迹、实际模型输入与环境指纹。

这是使用已知正确解的 **scripted model 沙箱测试**：5 个修复通过、5 个原始实现失败。它验证执行/评分管线，不代表任何真实模型的成功率、速度或费用。另有 [纯本地管线演示](examples/reports/m1-synthetic.html)，仅运行仓库固定 fixture；CLI 不提供任务的宿主机执行模式。

## 安装与检查

依赖 Linux、Bun 1.4.2、Bubblewrap（本机验证版本 0.8.0）和 `prlimit`（util-linux）。系统需允许非特权 user namespace；`doctor` 会实际启动沙箱检查。无需 Docker、镜像或常驻 daemon。本地数据放在 `.detroit/`，不要放在网络文件系统。

Debian/Ubuntu 上缺少系统依赖时可安装：`sudo apt-get install bubblewrap util-linux`。

```bash
cd Detroit
bun install --frozen-lockfile
bun scripts/build.ts
bun src/cli.ts doctor
```

本工作区已将 Bun 安装在 `.tools/`。没有全局 Bun 时可以使用 `./bunw`，它自动选择本地 Bun：

```bash
./bunw --version
./bunw scripts/build.ts
./bunw src/cli.ts doctor
```

在另一台机器上也可选择本地安装：

```bash
npm install --prefix .tools --no-audit --no-fund bun@1.4.2
./bunw install --frozen-lockfile
```

`doctor` 显示 Bubblewrap 启动探测、Bun/系统指纹、资源限制、driver 构建与凭据存在性。Bubblewrap 缺失或被系统策略禁用时，`run` 会拒绝执行，不回退到宿主运行。凭据值不会被打印。

## 跑第一批任务

直接构建并运行，不需要拉取镜像：

```bash
./bunw scripts/build.ts
./bunw test tests/bubblewrap.integration.test.ts
./bunw src/cli.ts run experiments/smoke.json --out .detroit/smoke.html
```

该批次包含 5 个 Case × 2 个脚本变体，共 10 个 Trial。每个 Trial 一个 Attempt，不自动重试挑选成绩。块内变体顺序由规格里的 seed 决定。默认配置为 `"sandbox": {"kind": "bubblewrap", "network": "none"}`；脚本运行禁用网络，不需要 API key。

运行时会输出 experiment ID，之后可查看状态、请求取消或重新生成报告：

```bash
./bunw src/cli.ts status <experiment-id>
./bunw src/cli.ts cancel <experiment-id>
./bunw src/cli.ts report <experiment-id> --out .detroit/report.html
```

Ctrl-C 也会触发取消，停止整个沙箱后收集产物。`cancel` 的回执只表示请求已登记，`status` 用于确认终态。意外退出后执行：

```bash
./bunw src/cli.ts recover
```

`recover` 按宿主侧保存的 PID、进程启动时间和 boot ID 对账，确认沙箱退出后将未提交终态的执行标记为 interrupted；不会自动重跑。记录不完整或回收未确认时阻止继续派发。

旧的 `image` 配置需要改成 `sandbox`。历史 Docker 批次仍可查看报告，但不能直接改用 Bubblewrap 重评分；存在未清理的旧 Docker Attempt 时，需要用旧版本清理，或为新实验指定独立的 `--data` 目录。

## 真实模型

复制 `.env.example` 为 `.env`，填入自己的 `OPENAI_API_KEY`，检查 `experiments/openai-dev.json` 的模型、endpoint 和预算，再主动运行：

```bash
./bunw src/cli.ts run experiments/openai-dev.json --out .detroit/openai.html
```

这会产生真实 API 调用。仅支持 OpenAI Chat Completions 的文本/function-call 接口，模型必须支持配置里的参数；不自动降级模型。API key 经 stdin 传入 driver，不写进冻结规格或环境变量，不传给脚本变体、shell 子进程或 verifier。示例显式设置 `sandbox.network: "host"`，真实模型及其工具会共享宿主网络；这不是限制目的地址的代理。脚本与 verifier 始终断网。

每个沙箱只挂载独立工作区、必要运行文件和只读系统工具；宿主 home、项目源码、隐藏答案不挂载。验证器只读候选产物，预期输出与断言在宿主独立比较。支持墙钟超时、输出上限、64 MiB `/tmp`、16 MiB 单文件写入限制和每进程 256 个文件描述符；**当前没有整组 CPU、内存、PID 或工作区磁盘配额**。Bun、Bubblewrap、prlimit、系统版本及包清单指纹会随实验保存；宿主 `/usr` 不等价于不可变镜像。

请求为非流式；SDK 内部重试关闭。累计 token 预算是调用前的软限制，usage 缺失时保留 unknown。M1 未接入价格表，报告费用为 unknown，不把未测量费用当作零。

## 外部 Harness：Oh-my-pi（OMP）

除了自带 reference harness，Detroit 也能驱动外部 harness。首个适配是 [Oh-my-pi](https://omp.sh)：variant 设置 `"driver": "omp"`、`"provider": "external"`。OMP shim（[src/drivers/omp.ts](src/drivers/omp.ts)）按 v18.8.3 协商 RPC v2，关联请求的 `prompt_result`，必要时等待 `session_settled`，进程退出并确认清理后采集产物，再由独立验证器评分。不会把第一个 `agent_end` 当作整次请求成功。

安装 OMP，并在首次运行时让它把原生模块解压到主机（不要在 64 MiB 沙箱 `/tmp` 内解压）：

```bash
curl -fsSL https://omp.sh/install | sh -s -- --binary   # 安装到 ~/.local/bin/omp
omp -p "hi"                                              # 首次运行，解压 pi_natives 到 ~/.omp/natives
```

用真实模型运行（key 经 stdin 送入 driver，再按明确的 `"provider/model"` 将凭据注入 OMP 子进程环境；不放入 argv、冻结规格或证据。示例明确使用 `openai/gpt-4.1-mini`）：

```bash
DETROIT_OMP_API_KEY=<key> \
  ./bunw src/cli.ts run experiments/omp.json --out .detroit/omp.html
```

- OMP 自己管理模型与工具，需要 `sandbox.network: "host"`（见 [experiments/omp.json](experiments/omp.json)）。
- 运行时只读绑定主机的 `~/.omp/natives`；路径可用 `DETROIT_OMP_NATIVES` 覆盖。
- 缺凭据/OMP 启动失败时 attempt 记为 **error**，不会伪装成正常结束或成功。
- **配置与控制**：模型选择和墙钟期限实际应用；`baseURL`、温度及其余模型/tool/token/context/output 预算不由 Detroit 应用于 OMP，启动时提醒并记录为 unsupported/unknown。请求值、应用值、原生观察值分别保存，参考 Harness 的系统提示与上下文策略不冒充 OMP 配置。
- **可观测性受限**：去重后的主会话 assistant/tool 身份是观测下界，不等于 HTTP 调用、重试或子代理总数。主会话上报 token 仅作已知小计，`usageComplete=false`，总费用保持 unknown；原生上报费用小计留在证据，不冒充完整账单。
- **证据与凭据边界**：逐事件保存有界白名单摘要，过滤原始 headers、工具参数和诊断输出；超过上限记录不完整与丢弃数。最终文本有独立上限。OMP 与工具处于同一沙箱用户下，环境注入不能保证对同用户进程绝对保密；评分沙箱不接收这些凭据。

## 验证、重评分与开发

```bash
./bunw test
node_modules/.bin/tsc --noEmit
node_modules/.bin/biome check src tests scripts
./bunw scripts/build.ts
```

常规环境也可用 `bun run check` 和 `bun run build`。本次 IDE 沙箱中 `bun run` 曾返回 127，直接执行上述命令可得到检查输出；Bun 部分命令完成后还出现 `/sys/kernel/debug/tracing/trace_marker` 访问受限，不能据此宣称整个沙箱命令干净退出。

普通测试包含 Harness、OpenAI SDK 本地假服务、工具副作用、证据、SQLite、协调器与验证器测试。Linux 上检测到 bwrap 后自动运行真实集成测试；仅缺少 Linux/bwrap 时跳过，已安装但无法启动则测试失败。覆盖完整批次、网络与文件隔离、取消、强制退出回收、超时、输出超限和证据软链接。测试不会调用付费模型。

重新生成演示：

```bash
DETROIT_WRITE_DEMO=1 ./bunw test tests/pipeline.test.ts
```

独立重评分：

```bash
./bunw src/cli.ts score <experiment-id>
./bunw src/cli.ts status <experiment-id>  # 查看各版本评分历史
./bunw src/cli.ts report <experiment-id> --out .detroit/frozen-comparison.html
```

评分读取原始产物对象和冻结 Case，不重新调用 agent。相同产物、验证器和环境下的有效评分保持幂等；评分器故障可再执行，保留原故障记录。验证 worker、宿主断言代码或运行环境指纹变化会产生新版本评分，旧结果不覆盖。

报告比较固定使用原实验冻结的评分版本，优先该版本最后一份有效评分；后续评分器故障不会覆盖既有有效结果。新版本重评分仍保留在 `status` 与证据历史中，不自动与旧版本混比。执行超时与验收分开：清理确认、产物完整且评分通过时计入成功，不隐含增加按时完成条件；未确认清理、未评分或评分故障保持 provisional。

采集只保留安全、限额内的 UTF-8 常规文件；缺失、截断和采集错误单独记录，不覆盖原执行停止原因。工作区采集不完整时评分为 `evaluation_error`，不将缺产物伪装成候选任务失败，也不对不完整快照强行重评分。

## 从哪里读代码

| 入口 | 主要机制 |
| --- | --- |
| `src/harness/runtime.ts` | 模型循环、预算、调用结果配对、错误恢复和停止 |
| `src/harness/context.ts` | 原始历史与输入副本分离、完整历史策略、估算预算 |
| `src/harness/tools.ts` | read/search/patch/shell/read-artifact、digest 前置条件、调用去重 |
| `src/sandbox/bubblewrap.ts` / `src/sandbox/lifecycle.ts` | agent/verifier 独立沙箱、环境探测、退出与回收 |
| `src/sandbox/files.ts` | 常规文件采集、路径/大小检查、driver 协议校验 |
| `src/eval/verifier.ts` | 固定断言在候选进程外执行，区分任务失败与评分故障 |
| `src/runner.ts` / `src/store.ts` | 冻结实验、Trial/Attempt、SQLite WAL、重评分和遗留对账 |
| `src/evidence.ts` / `src/report.ts` | SHA-256 对象、JSONL、输入回查、代码变化和 HTML 转义 |
| `src/cases.ts` | 5 个原创合成开发任务、已知正解与验证断言 |

数据包含提示、源代码和工具输出，报告是本地完整证据视图；M1 没有实现分享脱敏。所有任务均为公开 dev fixture，没有保留测试集、统计显著性结论或模型排名。

下一步跑一份真实模型开发基线。随后进入 M2：完整历史、滑动窗口、结构化压缩的受控比较，加入长链信息任务、来源回读和文件失效检查。
