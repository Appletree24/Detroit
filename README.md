# Detroit

用于改进 Coding Agent Harness、比较 agent 配置的本地实验平台。面向 Harness 开发与 LLM 测评：自己实现执行循环，用独立验证器判分，再从证据和报告定位问题。

**当前：M1 基础实现。** 已有参考 Harness、5 个开发任务、Docker runner、独立验证、SQLite/JSONL、重评分和静态报告。本机完成了确定性测试与合成演示；尚未完成真实 Docker 集成和真实模型实验。完整路线见 [DESIGN.md](DESIGN.md)，实际实现边界见 [docs/M1.md](docs/M1.md)。

## 先看结果

打开 [合成演示报告](examples/reports/m1-synthetic.html)：包含任务通过情况、修改前后代码、工具轨迹与实际模型输入。

这是使用已知正确解的 **scripted model 本地测试**：5 个修复通过、5 个原始实现失败。它验证执行/评分管线，不代表任何真实模型的成功率、速度或费用。测试仅运行仓库自带的固定小任务，不提供用户任务的宿主机执行模式。

## 安装与检查

依赖 Linux、Bun 1.4.2、Docker Engine。本地数据放在 `.detroit/`，不要放在网络文件系统。

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

`doctor` 显示 Docker、driver 构建、凭据存在性和能力。缺少 Docker 时 `run` 会拒绝执行。凭据值不会被打印。

## 跑第一批任务

先在有 Docker 的机器上拉取运行镜像；Detroit 在派发前将标签解析成不可变的本地镜像 ID，并冻结进实验规格：

```bash
docker pull oven/bun:1.4.2
./bunw scripts/build.ts
DETROIT_DOCKER_TESTS=1 ./bunw test tests/docker.integration.test.ts
./bunw src/cli.ts run experiments/smoke.json --out .detroit/smoke.html
```

该批次包含 5 个 Case × 2 个脚本变体，共 10 个 Trial。每个 Trial 一个 Attempt，不自动重试挑选成绩。块内变体顺序由规格里的 seed 决定。脚本运行禁用网络，不需要 API key。

运行时会输出 experiment ID，之后可查看状态、请求取消或重新生成报告：

```bash
./bunw src/cli.ts status <experiment-id>
./bunw src/cli.ts cancel <experiment-id>
./bunw src/cli.ts report <experiment-id> --out .detroit/report.html
```

Ctrl-C 也会触发取消，停止容器后收集产物并回收。`cancel` 的回执只表示请求已登记，`status` 用于确认终态。意外退出后执行：

```bash
./bunw src/cli.ts recover
```

`recover` 对账并清理本数据目录记录的遗留容器，将未提交终态的执行标记为 interrupted；不会自动重跑，也不是模型会话续接。

## 真实模型

复制 `.env.example` 为 `.env`，填入自己的 `OPENAI_API_KEY`，检查 `experiments/openai-dev.json` 的模型、endpoint 和预算，再主动运行：

```bash
./bunw src/cli.ts run experiments/openai-dev.json --out .detroit/openai.html
```

这会产生真实 API 调用。仅支持 OpenAI Chat Completions 的文本/function-call 接口，模型必须支持配置里的参数；不自动降级模型。API key 经 stdin 传入 driver，不写进冻结规格或 Docker 环境变量，不传给脚本变体、shell 子进程或 verifier。真实模型容器使用 bridge 网络。

请求为非流式；SDK 内部重试关闭。累计 token 预算是调用前的软限制，usage 缺失时保留 unknown。M1 未接入价格表，报告费用为 unknown，不把未测量费用当作零。

## 验证、重评分与开发

```bash
./bunw test
node_modules/.bin/tsc --noEmit
node_modules/.bin/biome check src tests scripts
./bunw scripts/build.ts
```

常规环境也可用 `bun run check` 和 `bun run build`。本次 IDE 沙箱中 `bun run` 曾返回 127，直接执行上述命令可得到检查输出；Bun 部分命令完成后还出现 `/sys/kernel/debug/tracing/trace_marker` 访问受限，不能据此宣称整个沙箱命令干净退出。

普通测试包含 Harness、OpenAI SDK 本地假服务、工具副作用、证据、SQLite、协调器与验证器测试。两条真实 Docker 测试默认跳过，需显式启用。测试不会调用付费模型。

重新生成演示：

```bash
DETROIT_WRITE_DEMO=1 ./bunw test tests/pipeline.test.ts
```

独立重评分：

```bash
./bunw src/cli.ts score <experiment-id>
./bunw src/cli.ts report <experiment-id> --out .detroit/rescored.html
```

评分读取原始产物对象和冻结 Case，不重新调用 agent。相同产物/验证器的成功评分保持幂等；评分器故障可再执行，保留原故障记录。修改验证器并重新 build 后会产生新版本评分，旧结果不覆盖。

## 从哪里读代码

| 入口 | 主要机制 |
| --- | --- |
| `src/harness/runtime.ts` | 模型循环、预算、调用结果配对、错误恢复和停止 |
| `src/harness/context.ts` | 原始历史与输入副本分离、完整历史策略、估算预算 |
| `src/harness/tools.ts` | read/search/patch/shell/read-artifact、digest 前置条件、调用去重 |
| `src/sandbox/docker.ts` | agent/verifier 独立容器、资源限制、停止与采集 |
| `src/eval/verifier.ts` | 固定断言在候选进程外执行，区分任务失败与评分故障 |
| `src/runner.ts` / `src/store.ts` | 冻结实验、Trial/Attempt、SQLite WAL、重评分和遗留对账 |
| `src/evidence.ts` / `src/report.ts` | SHA-256 对象、JSONL、输入回查、代码变化和 HTML 转义 |
| `src/cases.ts` | 5 个原创合成开发任务、已知正解与验证断言 |

数据包含提示、源代码和工具输出，报告是本地完整证据视图；M1 没有实现分享脱敏。所有任务均为公开 dev fixture，没有保留测试集、统计显著性结论或模型排名。

下一步先在 Docker 环境完成 smoke、隔离与取消验收，再跑一份真实模型开发基线。随后进入 M2：完整历史、滑动窗口、结构化压缩的受控比较，加入长链信息任务、来源回读和文件失效检查。
