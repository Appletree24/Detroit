# 05 Agent 垂类

> Go 分支目标方案；当前只有独立 Docker sandbox 组件，尚未接通真实 Agent Worker、Subject、评分与报告。外部数据生产遵循 [10](10-dataset-format.md)，生命周期和评分版本以 [优化设计](../DESIGN.md) 为补充。

## 1. 范围

评测"LLM + harness"组成的工具调用 Agent：给定任务和一组工具（文件系统、shell、业务 API、模拟用户），Agent 自主多步执行，最终由终态检查判定成败。

两条主线：

1. **通用任务形态复现**：参考公开 benchmark 的任务形态（模拟用户 + 业务规则 + 数据库终态检查；终端沙箱 + 测试脚本判定），实现适配器，验证内核的正确性。
2. **垂直领域自定义评测集**：通过统一 v2 格式接入外部插件、用户和公开来源；平台负责校验、冻结、执行和测量。后文构建器描述外部生产流程，不要求平台原生生成数据。

## 2. 沙箱

### 2.1 隔离级别

| 级别 | 实现 | 适用 |
|---|---|---|
| L1 | Docker 容器，无网络，只读根文件系统 + 可写工作目录 | 默认 |
| L2 | Docker + gVisor 运行时 | 需要执行不可信代码 |
| L3 | Firecracker 微虚拟机 | 规划中，不在首期 |

### 2.2 生命周期
1. 从**沙箱快照**（= InitState）启动：镜像 digest + 初始化脚本 + 种子数据。
2. 注入工具：以 MCP server 或内置函数形式暴露给 Agent。
3. 执行 episode。
4. 导出终态（数据库 dump、工作目录 diff），交给 OnlineScorer。
5. 销毁。

### 2.3 资源限制
CPU / 内存 / 磁盘 / 墙钟时间需分别声明硬限制、监测限制和不可观测项。候选确实超出已声明预算时记录 resource_exhausted，并按任务验收规则判定；后端启动或监测失败属于基础设施故障。当前磁盘为事后检查，不能写成已提供硬配额。

### 2.4 实现（`workers/agent/sandbox`）

沙箱是可替换的后端（`Provider` / `Sandbox` 接口），目前实现了 Docker，通过 docker CLI 调用，也可换成 Podman。配置字段对应 10 §6.3 的 `task.environment`。

| 要求 | 做法 |
|---|---|
| 快照 | 镜像必须按 digest 固定；工作区是匿名卷，镜像中该路径已有的内容会带入，再复制种子目录，然后执行 `setup`。setup 完成时记录每个文件的 sha256 作为初始状态，墙钟时间从这时开始计 |
| 隔离（L1） | `--network none`、只读根文件系统、工作区与 `/tmp`（tmpfs）可写、`--cap-drop ALL` 后只补回 CHOWN / DAC_OVERRIDE / FOWNER / FSETID / KILL / SETGID / SETUID、`no-new-privileges`、`--init` 回收孤儿进程。`network: host` 对应 Docker 默认 bridge 网络（能访问外网，但不是宿主网络）；`allowlist` 需要出口代理，尚未实现 |
| L2 | 支持传入 `Runtime: runsc`；需宿主机安装并验证 gVisor，当前未提供验证结果 |
| 内存 / 进程数 | `--memory`（禁用 swap）、`--pids-limit` 硬限制；是否超限读容器内 cgroup v2 的 `memory.events` 的 `oom_kill` 与 `pids.events` 的 `max`。读不到（cgroup v1）时标记为未知，不按未超限处理 |
| 磁盘 | 工作区总大小在 `Usage` / `Export` 时用 `du` 检查，属于事后判定；`/tmp` 是同样大小上限的 tmpfs |
| 墙钟时间 | 沙箱自己计时；耗尽后正在执行的命令被终止，之后的命令不再执行。单条命令另有可选超时 |
| 终止命令 | 结束 `docker exec` 客户端不会结束容器内的进程，所以每条命令都记录 pid，超时或取消时在容器内结束整棵进程树。已脱离父进程的守护进程不在树内，随 `Destroy` 一起结束 |
| 导出终态 | 每个工作区一个 tar 包加相对初始状态的文件差异（新增 / 修改 / 删除）；`ExportCommands` 的输出（如数据库 dump）；资源使用情况。超限后仍可导出；Agent 占满进程数时，平台临时放宽上限读取，结束后恢复 |
| 故障分类 | 镜像拉取、创建、启动、种子数据失败为 `sandbox_boot`，setup 失败为 `sandbox_setup`，运行中 Docker 出错为 `sandbox_error`，都按 infra_error 上报；启动失败不留下容器 |
| 清理 | 容器带 `detroit.sandbox`、`detroit.owner` 标签，Provider 提供按 owner 清理能力；真实 Worker 启动对账尚未接入 |

## 3. 工具层与回放

**问题**：Agent 评测中外部工具（搜索、第三方 API）返回不确定，导致结果不可复现，且调用成本高。

**方案：录制 / 回放模式**

| 模式 | 行为 |
|---|---|
| `live` | 真实调用，记录请求与响应到 `tool_calls.jsonl` |
| `record` | 同 live，并写入工具响应缓存（key = 工具名 + 规范化参数哈希） |
| `replay` | 只读缓存；未命中时返回明确的 `cache_miss` 错误并标记 episode |

**故障注入**（作为 Variant）：工具超时、返回 5xx、返回格式异常、延迟增大。用来评测 Agent 的鲁棒性：是否重试、是否死循环、是否在失败时如实告知用户。

## 4. 模拟用户

对话类任务需要一个"用户"。模拟用户由一个 LLM 扮演，持有隐藏的用户目标与个人信息。

- 模拟用户的模型与温度写入 manifest。
- 模拟用户本身会引入噪声，因此对话类任务**必须多次重复**（repeat ≥ 3），并报告 pass^k（见 07 §2.3）。

## 5. 评分栈

按"能确定就不用模型判"的原则分三层：

1. **确定性检查**：OnlineScorer 检查数据库终态和环境内测试；OfflineScorer 从冻结制品检查文本、JSON 等输出。
2. **LLM Judge**（OfflineScorer）：对确定性检查无法覆盖的部分（回复是否礼貌、是否如实告知限制）按 rubric 打分。
3. **人工复核队列**：Judge 置信度低或与确定性检查冲突的样本进入人工队列；人工结果用于校准 Judge（见 07 §3）。

## 6. 失败分类体系（taxonomy.yaml 初版）

```yaml
agent_failures:
  - wrong_tool            # 选错工具
  - wrong_arguments       # 工具对，参数错
  - policy_violation      # 违反业务规则（如超额退款）
  - unsafe_action         # 越权 / 破坏性操作
  - loop_or_stall         # 重复调用、无进展
  - premature_stop        # 未完成即宣布完成
  - hallucinated_result   # 声称做了实际未做的事
  - malformed_action      # 输出无法解析
  - tool_error_unhandled  # 工具报错后处理不当
  - resource_exhausted
```

## 7. 垂直领域评测集构建器

外部生产方可采用以下工作流：由用户提供领域文档与种子样例，生成待验证的候选评测集；Detroit 负责接收 v2 包，不内置数据生成器。

流程：

1. **Schema 定义**：用户定义领域工具（OpenAPI / MCP 描述）和数据库 schema。
2. **种子样例**：每个样例 = 用户目标 + 初始数据 + 期望终态。
3. **扩写**：LLM 根据种子样例和领域文档生成候选任务，覆盖不同规则分支和边界条件。
4. **可解性校验**：用一个强模型 + 多次尝试执行候选任务；所有尝试都失败的任务进入人工审核（可能是题目本身有误）。
5. **去重与难度分层**：按任务的规则分支覆盖度与强模型通过率分为 smoke / core / hard 三层。
6. **版本化**：评测集以内容哈希为版本号，写入 manifest。

交付物采用 [10](10-dataset-format.md) 的 case / scoring / dataset 文档与 blob bundle。生成结果、强模型通过率和人工确认分别记录；“模型能完成”不单独证明任务和评分可靠。

## 8. 回归门禁（CI 集成）

```yaml
gate:
  suite: core
  min_success_rate_lower_ci: 0.70   # 用置信区间下界做门禁，而不是点估计
  max_regression_vs_baseline: 0.03  # 业务允许下降幅度示例，按适用的配对区间判断
  inconclusive: block             # 证据不足时不能默认通过
  max_cost_per_task_usd: 0.20
  max_p95_steps: 30
  max_unsafe_action_rate: 0.0
```

以上是待实现的门禁配置示意，阈值需按业务和统计计划确定。回归判定先检查运行有效性；“未发现显著下降”不等于已经证明满足可接受的下降幅度。

## 9. 真实执行闭环的补强要求

- next_message 只执行一次 Subject.Act，工具调用作为输出评分；episode 才运行工具循环。两者分别预检能力，不能为了评分调用而改变任务 horizon。
- Worker、Subject 和评分器共享冻结任务引用，但 Subject 只取得公开 task 视图；诊断、隐藏测试和标准答案不进入被测输入。
- 当前 network: host 实际映射 Docker bridge 出网；运行计划须记录实际网络语义。未来修正映射需要版本化后端政策，不能在同一策略版本下悄悄改变网络隔离。
- Docker Destroy 失败后保留可重试清理状态；整个 episode 设置独立 watchdog。导出记录截断、文件类型、权限和字节摘要，只有清单原子提交后才允许依赖完整证据的评分。
- online 检查在受信任评分边界运行并保存终态及版本；offline 检查读取不可变制品。重评分所需终态未保存时明确不可重评，不声称重新运行原命令一定可复现。
- 首个 openai-compatible 适配器须区分请求、施加、实际观测和未知配置；模型会话、工具与环境均按 Attempt 隔离，未实现参数不能静默忽略。
