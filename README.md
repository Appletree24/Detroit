# Detroit

用于改进 Coding Agent Harness、比较 agent 配置的本地实验平台。面向 Harness 开发与 LLM 测评：自己实现执行循环，用独立验证器判分，再从证据和报告定位问题。

**当前：M1 使用 Bubblewrap，无需 Docker。** 已有参考 Harness、5 个开发任务、独立沙箱执行与评分、SQLite/JSONL、重评分和静态报告；新增了通用 case 导入、本地 Web 草稿整理与集合管理。真实模型实验尚待执行。最新范围与待审阅方案见 [CONTEXT.md](CONTEXT.md) 和 [docs/MVP-DESIGN.md](docs/MVP-DESIGN.md)，实际实现边界见 [docs/M1.md](docs/M1.md)；[DESIGN.md](DESIGN.md) 保留历史设计。

**收录不等于可执行。** 导入的真实题目尚未接入通用执行器与评分器，不会被塞进现有 5 个函数 fixture 的运行协议。OMP 原生现场保存、人工评分和统计模块仍未实现。

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

## 把日常真实 case 收录进集合

### 最方便：本地 Web

只做导入与整理时需要 Bun，不要求 Bubblewrap、driver 构建或模型凭据：

```bash
./bunw src/cli.ts serve --port 8787
```

打开 **http://127.0.0.1:8787/**。默认数据目录是 `.detroit/`，可用 `--data <目录>` 分开保存。仓库在远端时，先用 SSH 转发 `ssh -L 8787:127.0.0.1:8787 user@host`，浏览器仍访问上述地址；不要把服务暴露到公网。

服务在前台运行；保持这个终端打开，`Ctrl+C` 会停止服务。页面分为三个工作区：

- **新建导入**：按“描述任务 → 准备材料 → 核对与批准”整理 case，支持目录 / 附件及协议 JSON 两种入口。宽屏右侧展示预览，窄屏改为单列；切换工作区保留未保存的表单。
- **题目草稿**：按标题、题目 ID 或来源引用搜索，查看材料原始字节、批准摘要和历史版本，并以选定版本创建新修订。
- **集合管理**：创建集合、加入并固定题目版本。题目更新不会自动替换集合成员。

连接标识不表示题目可执行。“刷新列表”连接失败时会显示错误并停用导入保存；恢复服务后，可在“题目草稿”再次点击“刷新列表”重新建立会话。

以 PC / APP 处理同一实体不一致的 oncall 为例：

1. 在“新建导入”填写问题和“原始问题 / 当前状态”起点，展开“来源与用途”填写来源引用。已用来排障或优化的问题选择改善用途，不冒充独立验证题。
2. 分别选择 PC 与 APP 目录，填写各自版本和快照状态。版本是你的声明，导入不会检出 Git 提交或恢复历史文件。
3. 上传相同接口输入、日志与验收材料，逐项核对角色。旧模型失败记录默认放诊断侧；已知根因和私有验收答案不要写进任务说明或输入侧。
4. 点击“预览待批准的材料”，核对确切字节、路径、哈希、角色、排除项和缺失项，再勾选批准并保存。
5. 在“集合管理”创建集合，或保存时选择已有集合；可设用途、回归属性、题目版本和业务权重。集合成员固定具体版本，新修订不会自动替换它。

| 材料角色 | 用途 |
| --- | --- |
| `input` | 未来被测对象可见的任务材料，如两个仓库及相同接口输入 |
| `diagnostic` | 历史尝试、调试记录；不默认提供给被测对象 |
| `scoring` | 标准答案、私有验证数据或验收程序；不默认提供给被测对象 |

原始快照、依赖或验收依据暂缺时仍可保存。页面明确显示草稿、缺失项和 `executor_not_connected`；准备命令、联网和凭据能力只是惰性声明，保存不会执行脚本或调用模型，凭据字段只记录能力名称，不主动采集或填入密钥值。浏览器目录上传不保证原子快照，权限默认声明为 `0644`。

在草稿详情点击“以此版本材料创建新修订”可补充协议与材料；历史版本仍可查看、预览和下载。切换原始 / 当前起点须新建关联题目，不在同一题目上覆盖起点。已知同源问题选择同一来源组；相同非空来源引用不能偷偷新建另一个组绕过用途检查。验证来源转作改善须明确确认并说明理由，整个来源组记录暴露时间；历史验证集合会提示已暴露成员，不能继续作为当前独立验证证据。

### 通用协议与 CLI

格式为 `kind: "detroit.case"`、`schemaVersion: 1` 的 JSON 清单加材料。可以用 CLI 从本地目录收集，也可以在 Web 的“协议 JSON 导入”中上传 `{manifest, files, warnings}`，其中 `files` 明确携带 `workspaceId`、相对 `path`、`role`、`required`、`mode`、`encoding: "utf8" | "base64"` 与 `data`。Web 只接收你选择上传的字节，禁止主机 `path` / `sourcePath`。

CLI 清单示例：把以下内容保存为 `case.json`，将批准的两个仓库目录放在同目录的 `pc/`、`app/`，附件放在同目录。起点未核实时保留 `unknown`，不要为了消除提示填成 `original`：

```json
{
  "kind": "detroit.case",
  "schemaVersion": 1,
  "title": "PC 与 APP 同实体表现不一致",
  "instruction": "针对相同接口比较两条处理链路，定位差异并给出验证证据。",
  "source": {
    "kind": "oncall",
    "reference": "pc-app-entity-oncall",
    "description": "本事件的稳定标识；也可填写真实工单链接",
    "usedForImprovement": true
  },
  "start": { "kind": "original", "description": "从原始用户问题开始" },
  "workspaces": [
    { "id": "pc", "name": "PC", "path": "pc", "snapshot": "unknown" },
    { "id": "app", "name": "APP", "path": "app", "snapshot": "unknown" }
  ],
  "materials": [
    { "path": "request.json", "sourcePath": "request.json", "role": "input" },
    { "path": "attempts.txt", "sourcePath": "attempts.txt", "role": "diagnostic", "required": false },
    { "path": "expected.txt", "sourcePath": "expected.txt", "role": "scoring" }
  ],
  "environment": { "requirements": [], "preparation": [], "network": "none", "credentials": [] },
  "output": { "format": "text", "description": "链路对比、根因及验证证据" },
  "acceptance": { "kind": "manual", "description": "按私有依据核对根因与证据；尚未接入评分器" },
  "missing": []
}
```

`path` / `sourcePath` 相对清单目录，不允许越界、符号链接（包括祖先目录）或特殊文件。缺失的路径会记录为 missing，仍可批准保存草稿；空文件是有效材料，不等同于缺失。无需附件的纯文本任务可只提供完整任务说明。

```bash
# 先检查预览；把输出中的完整 approvalDigest 贴到下一条命令
./bunw src/cli.ts case preview case.json
./bunw src/cli.ts case import case.json --approve <approvalDigest>
./bunw src/cli.ts case list
./bunw src/cli.ts case show <case-id>
```

CLI 也接受 Web 的完整上传协议 JSON。元数据清单上限 1 MiB，含材料的协议 JSON / HTTP 载荷上限 100 MiB；实际材料最多 10000 个文件、单文件 16 MiB、总计 64 MiB。目录收集排除 `.git`、`node_modules`、`.detroit` 和明显秘密文件，预览披露排除项；这不保证剩余内容无敏感信息。

创建集合时，把 `{"name":"oncall 回归","purpose":"improvement","regression":true}` 保存为 `collection.json`：

```bash
./bunw src/cli.ts collection create collection.json
./bunw src/cli.ts collection list
./bunw src/cli.ts collection add <collection-id> <case-id> --revision 1 --weight 1
./bunw src/cli.ts collection show <collection-id>
```

补充同一题目：预览和导入均传 `--case <case-id>`，导入额外传 `--expected-revision <当前版本>`；CLI 会绑定该题原来源组。新建同源关联题：预览和导入均传 `--source-group <source-id>`。确认验证来源转作改善时，额外传 `--confirm-exposure --reason <理由>`；已暴露来源不能重新加入独立验证集合。

`serve` 在存活期间持有写锁；CLI 的 `case` / `collection` 命令请在停止 Web 服务后使用，或直接在 Web 操作。材料与草稿按版本存于同一 `index.sqlite`，导入会事务迁移 v1 → v2，旧实验、尝试和评分保留。数据是本地明文，应保护数据目录权限；没有分享脱敏能力。

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
| `src/import-contract.ts` / `src/case-imports.ts` | 版本化导入、材料批准、不可变草稿修订、来源用途与集合成员 |
| `src/import-server.ts` / `src/import-layout.ts` / `src/import-ui.ts` | loopback Web、会话/来源校验、响应式布局、文件上传预览与草稿整理 |

数据包含提示、源代码、诊断和评分侧材料，报告是本地完整证据视图；尚未实现分享脱敏。当前可执行任务仍只有公开 dev fixture；导入集合只用于收录与整理，没有通用执行、统计显著性结论或模型排名。

下一步跑一份真实模型开发基线。随后进入 M2：完整历史、滑动窗口、结构化压缩的受控比较，加入长链信息任务、来源回读和文件失效检查。
