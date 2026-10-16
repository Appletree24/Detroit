# Detroit

Detroit 是以 **Go** 构建的统一智能体评测框架，目标是让 **LLM Agent** 与 **具身策略（VLA / 机器人操作策略）** 共用任务编排、结果存储、统计比较和证据追溯内核，通过 Worker 与 Subject 适配不同执行环境和被测对象。

当前已实现控制面、租约调度、SQLite 持久化、Go Worker 运行时、Synthetic + Mock 验证闭环，以及独立的 Docker 沙箱组件。真实 Agent / 具身评测链路仍在建设中。本文描述当前代码；优化目标与实现顺序见 [DESIGN.md](DESIGN.md) 和 [路线图](docs/08-roadmap.md)。

## 当前实现

| 模块 | 已实现能力 | 入口 |
|---|---|---|
| 核心契约 | RunSpec 解析、默认值与校验；Task、Episode、Outcome；配置摘要与 episode 幂等键 | `internal/core/` |
| 任务展开 | TaskSet Loader 注册表；内置 Synthetic；任务 × 变体 × 初始状态 × seed × repeats 展开和任务集摘要 | `internal/taskset/`、`internal/scheduler/plan.go` |
| 调度服务 | gRPC 注册、拉取、心跳、结果上报；按垂类分配、过期租约回收、有限次重派、取消与重提续跑 | `internal/scheduler/` |
| 持久化 | SQLite WAL、短事务；run / episode / result 状态；重复结果不覆盖；重启后读取原记录 | `internal/store/` |
| Worker 运行时 | 注册与重新注册、并行槽位、心跳、执行取消、结果上报重试；Mock Executor 可模拟未知和崩溃 | `internal/workerkit/` |
| API 与 CLI | 提交、列表、进度汇总、取消；CLI 可启动 Mock Worker | `internal/api/`、`cmd/` |
| 统计 | 总体和按 variant 汇总；已判定样本条件成功率、Wilson 区间；unknown / infra_error 单列 | `internal/stats/`、`internal/store/query.go` |
| Agent 沙箱组件 | Docker 镜像启动、多工作区、setup、命令执行、资源限制、终态导出与销毁；可配置 `runsc` | `workers/agent/sandbox/` |
| 协议与数据格式 | Worker / Subject protobuf 与 Go 生成代码；评测集 v2 JSON Schema 和示例 | `proto/`、`gen/`、`schemas/`、`examples/` |

## 当前边界

- CLI 的执行入口目前只有 `worker mock`，使用 `synthetic` 任务；它不调用模型、不启动 Docker、不执行仿真。Subject protobuf 已定义，真实 Subject 服务、Agent 工具循环、LIBERO / LeRobot Worker 尚未接入。
- Docker 沙箱是独立组件，尚未接通“任务包导入 → 真实 Worker → 评分”的链路。`Runtime: "runsc"` 是可选后端配置，不表示已验证 gVisor 环境。网络配置值 `host` 当前映射 Docker bridge 外网访问，不是宿主机网络模式。
- 评测集 v2 Schema 与样例不等于已实现导入器。`scorers.offline / select`、`stats.compare_to` 已有配置字段，但离线评分执行、评分版本选择和配对比较尚未实现。
- 当前租约协议以 episode 为单位，重复上报采用先到结果保留。尚无独立 attempt 身份、租约代次隔离、持久化待提交队列或每次重派的完整成本账本；一次逻辑结果不代表物理执行仅发生一次。
- 当前成功率分母只含 `done` 且可判定 success / failure 的样本，unknown 与 infra_error 另列；Wilson 区间不说明缺失偏差。完成度辅助指标、缺失敏感性界、故障比例阈值判无效、配对检验与回归门禁待实现。置信水平默认 0.95，现有 `ci95` 字段和 CLI 表头尚未随自定义置信水平改名。
- `taskset_hash` 已记录到 manifest，但尚未校验 Worker 加载内容与该摘要一致。制品 URI 已有字段，统一制品存储、证据索引、HTML 报告、自动失败归因及多控制器部署仍是目标能力。

Mock 结果由 episode key 确定，用于验证调度与存储契约，不代表模型或机器人能力。仓库提供测试代码；本文不声明本轮测试通过或已完成真实模型 / 仿真实验。

## 快速开始

使用 [go.mod](go.mod) 声明的 **Go 1.26.0** 工具链。下面的 Makefile 命令需要兼容 POSIX 的 Shell 与 `make`；Mock 闭环不需要 Docker、GPU 或模型密钥。

在第一个终端构建并启动控制面：

标 ✅ 的目录已有代码，其余按 [路线图](docs/08-roadmap.md) 逐步落地。

```
Detroit/
├── cmd/
│   ├── detroit/            # ✅ CLI：提交 run、查看进度、取消；mock Worker
│   └── controller/         # ✅ 控制面服务（gRPC Worker 协议 + HTTP API）
├── internal/
│   ├── core/               # ✅ 核心类型、RunSpec 解析、episode 幂等键
│   ├── scheduler/          # ✅ 切分、租约、重试、续跑
│   ├── store/              # ✅ 元数据（SQLite）、结果与制品路径查询
│   ├── stats/              # ✅ Wilson 区间；配对检验、样本量待做
│   ├── taskset/            # ✅ TaskSet Loader 注册表（synthetic、detroit-v2）
│   ├── dataset/            # ✅ v2 导入校验、冻结快照与评分绑定
│   ├── scoring/            # ✅ 单步输出的确定性评分
│   ├── workerkit/          # ✅ Go Worker 运行时（注册、拉取、心跳、上报）+ mock Executor
│   ├── api/                # ✅ API Server
│   ├── analyze/            # 失败归因、聚类
│   └── report/             # 报告生成（Markdown / HTML）
├── proto/                  # ✅ Subject 协议、Worker 协议（protobuf）；生成代码在 gen/
├── workers/
│   ├── agent/              # ✅ next_message 真实 Worker；sandbox/：独立 Docker 沙箱
│   └── embodied/           # Python：MuJoCo / LIBERO 环境 worker
├── subjects/               # ✅ openaicompat：OpenAI 兼容 API 的 Subject gRPC 服务
├── verticals/
│   ├── agent/              # Agent 任务集、评分器、自定义评测集构建器
│   └── embodied/           # 具身任务集、扰动套件、子目标谓词
├── schemas/                # ✅ 评测集格式协议 v2 的 JSON Schema
├── examples/               # ✅ RunSpec 与评测集示例
├── test/e2e/               # ✅ 真实进程的端到端测试（kill -9 续跑）
├── deploy/                 # docker-compose / 单机脚本
└── docs/
```

该命令执行 `go build -o bin/ ./cmd/...`，数据库使用 `.detroit/detroit.db`；默认 gRPC 地址为 `127.0.0.1:7070`，HTTP API 为 `http://127.0.0.1:7071`。也可自行执行 `go build`，再用 `controller -db <path> -grpc <address> -http <address>` 启动；直接运行 controller 的默认数据库路径是 `detroit.db`。

| 文档 | 内容 |
|---|---|
| [01 定位与目标](docs/01-overview.md) | 问题定义、目标 / 非目标、与现有工具的关系 |
| [02 系统架构](docs/02-architecture.md) | 组件、控制面 / 数据面、调度、存储、部署 |
| [03 核心抽象](docs/03-core-abstractions.md) | 所有核心类型与接口定义 |
| [04 协议](docs/04-protocol.md) | Subject 协议与 Worker 协议 |
| [05 Agent 垂类](docs/05-vertical-agent.md) | 沙箱、工具回放、评分栈、自定义评测集 |
| [06 具身垂类](docs/06-vertical-embodied.md) | LIBERO 复现、扰动套件、子目标谓词、仿真-真机相关性 |
| [07 评测方法论](docs/07-methodology.md) | 统计、Judge 校准、失败归因、可复现性 |
| [08 路线图](docs/08-roadmap.md) | 里程碑、验收标准、砍需求顺序 |
| [09 设计决策记录](docs/09-decisions.md) | 关键取舍及理由 |
| [10 评测集格式协议](docs/10-dataset-format.md) | 题目、评分、评测集三种文档，打包与导入检查（草案） |
| [11 模型接入](docs/11-model-evaluation.md) | 模型配置、真实 Worker、单步评分、制品与当前边界 |

## 快速开始

需要 Go 1.26+。支持导入 v2 评测集并调用 OpenAI 兼容模型，运行 `next_message` 单步评测、确定性评分与结果查看，见[模型接入指南](docs/11-model-evaluation.md)。多步沙箱任务尚未接入。以下 mock 流程用于验证调度，不产生真实模型成绩。

```bash
./bin/detroit worker mock --slots 8
```

在第三个终端提交示例并查看结果：

```bash
./bin/detroit run submit -f examples/runspecs/mock-smoke.yaml
./bin/detroit run list
./bin/detroit run status <run-id>
./bin/detroit run status <run-id> --json
./bin/detroit run cancel <run-id>
```

### 导入 v2 评测集

```bash
./bin/detroit dataset import -f examples/datasets/v2/casepick-inline
# 也支持 bundle 目录、单个 case.json / cases.jsonl / scoring.json。
# 单独导入评分时，用 --base <已有快照路径> 提供题目。
```

导入结果的 `path` 和 `snapshot` 填入 RunSpec（模板见
[dataset-smoke.yaml](examples/runspecs/dataset-smoke.yaml)）：

```yaml
taskset:
  vertical: agent
  source: detroit-v2
  options:
    path: /absolute/path/from/import/result
    snapshot: sha256:<snapshot 摘要>
scorers:
  select: all # 或评分 label，如 lenient
```

导入校验 Schema、摘要、blob、对话工具配对、引文及评分引用，并将完整文档和材料复制到
`.detroit/datasets/` 下的固定快照。导入不执行模型、setup 或评分命令。
修改原始文件不影响已有快照；快照被修改或材料损坏时，提交和 Worker 加载会失败。
题目、评分与诊断原文保存在快照中，Loader 只把 `task` 放入被测输入。

验证集出现改进来源或与已导入改进集共享同源题组时，导入返回冲突并以非零退出码结束；
可先修正用途，也可在确认后重新导入并指定 `--confirm-validation-conflicts`。

当前为本地共享文件系统模式：CLI、控制面和 Worker 必须能访问同一绝对快照路径。
`scorers.select` 决定评分定义。真实 Worker 当前要求每题最多选择一份评分，多份时需指定 label；分别出报告仍待实现。

### 运行真实模型

在模型适配服务的终端配置 `OPENAI_API_KEY`，然后启动服务与 Worker（分别运行）：

```bash
./bin/detroit subject openai-compatible --model YOUR_MODEL_ID --digest YOUR_MODEL_REVISION
./bin/detroit worker agent --slots 1
```

使用 [model-next-message.yaml](examples/runspecs/model-next-message.yaml)，填入模型版本和已导入的快照。
`subject.endpoint` 指向 Subject gRPC 地址；更换供应商 API 时，在适配服务上设置 `--base-url`。

```bash
./bin/detroit run submit -f my-run.yaml
./bin/detroit run status RUN_ID
./bin/detroit run results RUN_ID
```

完整操作、参数和评分支持范围见[模型接入指南](docs/11-model-evaluation.md)。

开发：`make test`（含 kill -9 端到端测试）、`make test-short`、`make lint`、`make proto`（重新生成 gRPC 代码，需要 protoc）。

## 仓库结构

```text
Detroit/
├── cmd/
│   ├── controller/          # gRPC 调度服务 + HTTP API
│   └── detroit/             # CLI 与 Mock Worker 入口
├── internal/
│   ├── core/                # 核心类型、配置与幂等键
│   ├── scheduler/           # 计划展开与租约服务
│   ├── store/               # SQLite 状态与汇总查询
│   ├── stats/               # Wilson 区间
│   ├── taskset/             # Loader 注册表与 Synthetic
│   ├── workerkit/           # Worker 运行时与 Mock
│   ├── api/                 # HTTP API
│   └── version/             # 构建版本信息
├── proto/                   # Worker 与 Subject 协议
├── gen/                     # protobuf / gRPC 生成代码
├── workers/agent/sandbox/   # 独立 Docker 沙箱组件
├── schemas/                 # 评测集 v2 JSON Schema
├── examples/                # Mock RunSpec 与数据集样例
├── test/e2e/                # 真实进程的重启测试
├── docs/                    # 架构、协议、方法论与路线图
├── DESIGN.md                # 跨模块优化目标
├── CONTEXT.md               # 范围与决策
├── GLOSSARY.md              # 术语
├── Makefile
└── go.mod
```

## 文档导航

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 基于当前 Go 内核的优化目标与跨模块约束 |
| [CONTEXT.md](CONTEXT.md)、[术语表](GLOSSARY.md) | 范围决策与核心概念 |
| [01 定位与目标](docs/01-overview.md) | Agent + 具身双垂类定位 |
| [02 系统架构](docs/02-architecture.md) | 当前组件、持久化边界与调度演进 |
| [03 核心抽象](docs/03-core-abstractions.md) | 统一类型与领域接口 |
| [04 协议](docs/04-protocol.md) | 当前 v1 与目标租约、提交协议 |
| [05 Agent 垂类](docs/05-vertical-agent.md)、[06 具身垂类](docs/06-vertical-embodied.md) | 环境、适配器与垂类执行设计 |
| [07 评测方法论](docs/07-methodology.md) | 条件成功率、比较有效性与不确定性 |
| [08 路线图](docs/08-roadmap.md)、[09 设计决策](docs/09-decisions.md) | 交付阶段、验收与取舍 |
| [10 评测集格式协议](docs/10-dataset-format.md) | 题目、评分、评测集与导入契约 |
| [项目介绍](docs/PROJECT-PROFILE.md) | 面向最终目标形态的专业项目介绍与简历文案 |
