# Detroit

> 一个统一的智能体评测框架：同一套评测内核，同时评测 **LLM Agent** 与 **具身策略（VLA / 机器人操作策略）**。
>
> 名字取自 *Detroit: Become Human* —— 在把仿生人放进真实世界之前，先确认它到底能做什么、在哪里会失败。

## 为什么需要它

不论被测对象是"调用工具的 LLM Agent"还是"输出关节动作的机器人策略"，评测本质上是同一个循环：

```
Env 给观测 ──▶ Subject(被测对象) 给动作 ──▶ Env 推进一步 ──▶ … ──▶ Scorer 打分
                                                               │
                                       Aggregator 统计聚合 ◀────┘
                                               │
                                       Analyzer 失败归因 ──▶ Report
```

两类评测在业界各自有成熟工具，但普遍存在三个工程问题：

1. **结论不可信**：很多结果只有一个点估计，没有置信区间；10 个 episode 的结论被当作事实。
2. **结果不可复现**：模型版本、环境版本、seed、配置没有被完整锁定，换台机器分数就变。
3. **只知道分数，不知道为什么**：成功率掉了 5 个点，却说不清是哪类失败变多了。

Detroit 的目标不是提出新的 benchmark，而是把业界零散的最佳实践**工程化、统一化**：可扩展的调度、统计严谨的结论、完整的可复现性、自动化的失败归因。

## 核心特性

| 能力 | 说明 |
|---|---|
| 统一抽象 | `Task / Env / Subject / Episode / Scorer / Aggregator / Analyzer`，两个垂类共用 |
| 被测对象服务化 | Subject 以独立服务运行（gRPC / WebSocket），依赖与评测环境隔离；N 个被测对象 + M 个环境只需 N+M 个适配器 |
| 分布式调度 | Go 实现的控制面；episode 级切分、租约 + 心跳、幂等、断点续跑、失败重试 |
| 统计严谨 | Wilson 置信区间、配对检验（McNemar）、样本量规划、回归门禁 |
| 失败归因 | 规则/谓词 → LLM/VLM Judge → 人工复核的三层打分栈；失败聚类与影响排序 |
| 可复现 | 运行清单（manifest）锁定镜像 digest、模型版本、seed、配置哈希；自带 sanity check |
| 两个垂类 | `verticals/agent`：沙箱化工具调用 Agent 评测、垂直领域自定义评测集；`verticals/embodied`：基于 LIBERO / LeRobot 的仿真策略评测与鲁棒性扰动 |

## 仓库结构

```
Detroit/
├── cmd/
│   ├── detroit/            # CLI：提交 run、查看进度、导出报告
│   └── controller/         # 控制面服务
├── internal/
│   ├── core/               # 核心抽象（Go interface 定义）
│   ├── scheduler/          # 切分、租约、重试、续跑
│   ├── store/              # 元数据（SQLite/Postgres）+ 制品（本地 FS / MinIO）
│   ├── stats/              # 置信区间、检验、样本量
│   ├── analyze/            # 失败归因、聚类
│   └── report/             # 报告生成（Markdown / HTML）
├── proto/                  # Subject 协议、Worker 协议（protobuf）
├── workers/
│   ├── agent/              # Python/Go：沙箱环境 worker
│   └── embodied/           # Python：MuJoCo / LIBERO 环境 worker
├── subjects/               # 被测对象适配器（LLM API、openpi、LeRobot 策略…）
├── verticals/
│   ├── agent/              # Agent 任务集、评分器、自定义评测集构建器
│   └── embodied/           # 具身任务集、扰动套件、子目标谓词
├── deploy/                 # docker-compose / 单机脚本
└── docs/
```

## 文档

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

## 快速开始（目标形态，M1 后可用）

```bash
# 1. 启动控制面（单机模式，SQLite + 本地文件存储）
make up

# 2. 启动被测对象（示例：一个 OpenAI 兼容接口的 LLM Agent）
detroit subject serve --adapter openai-compatible --model <your-model>

# 3. 提交评测
detroit run submit -f examples/agent-smoke.yaml

# 4. 查看结果与报告
detroit run status <run-id>
detroit report <run-id> --format md
```

## 项目状态

见 [路线图](docs/08-roadmap.md)。所有对外宣称的数字都以 `results/` 下带运行清单的实测结果为准，未实测的数字一律不写。

## License

Apache-2.0
