# 02 系统架构

本文以 Go 内核为实现基线，保留 LLM Agent 与具身策略共用控制面的设计。标注“当前”的内容对应仓库代码；“目标”需要后续实现与验证。跨模块约束见 [DESIGN.md](../DESIGN.md)，线上消息以 [04 协议](04-protocol.md) 和实际 protobuf 为准。

## 1. 总览与实现边界

```text
CLI / HTTP 客户端
       │ RunSpec / 查询 / 取消
       ▼
Go 控制面：API → Planner → Scheduler → Result Ingestor → SQLite
                         │ Register / Lease / Heartbeat / Report
                         ▼
                Go Worker Runtime → Executor
                         │
            当前：Synthetic + Mock
            目标：Agent Worker / Embodied Worker
                         │ 观测与动作
                         ▼
               Subject 服务 / 适配器
                         │
             制品、评分、统计、分析与报告
```

当前链路止于 Mock Executor 与结果汇总。Docker 沙箱组件已有代码，Subject 协议已有定义；二者尚未接入真实 Worker。制品服务、离线评分、失败归因、HTML 报告、具身仿真和真实模型适配属于目标组件。

## 2. 控制面与数据面

控制面管理配置、任务计划、租约、结果提交和比较口径；数据面负责恢复环境、执行被测对象、记录轨迹与终态。目标中观测和动作直接在 Worker 与 Subject 间传输，大体积帧、视频和日志通过制品存储引用，不由调度 RPC 中转。

当前单个 controller 使用 SQLite 持久化 episode 状态，Worker 注册信息留在内存。重启后 Worker 可重新注册，但重启或网络中断仍可能导致租约过期和重复执行，不能据此承诺正在执行的物理任务不受影响。

Agent 与具身共享控制协议和结果契约，环境恢复、动作语义与评分证据由垂类适配器负责。Worker / Subject 的同机部署是延迟优化选项，不改变协议边界。

## 3. 核心组件

### 3.1 API Server

当前实现以下 HTTP + JSON 接口，提交体接受 YAML 或 JSON RunSpec：

| 接口 | 当前行为 |
|---|---|
| `POST /v1/runs` | 校验 RunSpec、加载任务集、展开并提交计划；相同 RunSpec 复用原 run |
| `GET /v1/runs` | 列表 |
| `GET /v1/runs/{id}` | 状态、manifest、总体与 variant 汇总 |
| `POST /v1/runs/{id}/cancel` | 标记取消，阻止后续领取；运行中的 Worker 通过心跳获知 |

失败明细、报告导出、独立恢复/新实验操作及认证部署不是当前 API 已实现能力。目标提交阶段还需检查任务包、评分器、执行能力、预算和资源；不支持的配置在派发前拒绝，不能仅写入 manifest 后忽略。

### 3.2 Run Planner 与冻结清单

当前展开与身份如下：

```text
episodes = tasks × variants × init_states × seeds × repeats
run_id = name + "-" + sha256(normalized RunSpec)[:12]
episode_key = sha256(JSON[
  run_id, task_id, variant_id, init_state_id, seed, repeat_idx,
  subject_digest, env_digest
])
```

规范化配置先补默认值。JSON 数组编码避免拼接歧义；展开顺序确定。当前 `variant` 是任务扰动，不是模型名称，模型 / 策略由 RunSpec 的 `subject` 指定。Planner 计算 `taskset_hash` 写入 manifest，但该摘要未绑定 RunID 或租约载荷，Worker 重新加载任务时也没有校验。

目标先解析、校验并冻结执行清单，再创建实验：

- 绑定 dataset 版本、每题 task revision、所选 scoring revision、Loader 版本、环境 / 镜像摘要、初始状态与材料摘要。
- 固定 Subject / Harness 配置、采样计划、变体、重试规则、资源要求、统计方案与协议版本；未知实际配置单独标记。
- 保存清单和所引用对象，Worker 校验摘要后执行；原路径或同名任务内容变化不得混入已有实验。
- 将实验身份与配置摘要分离：相同配置可以创建新的独立实验；恢复只能引用原冻结计划。幂等提交请求只确认同一次创建，不自动生成额外样本。

这是目标模型。当前 v1 仍按 RunSpec 派生 run_id，已有任务源目前只有 Synthetic。

### 3.3 Scheduler：当前租约语义

- `Register` 保存 worker_id、vertical、slots；labels 目前只记录日志，不参与资源匹配。
- `Lease(max)` 按垂类选择 pending episode，单次数量不超过 worker 声明的 slots。控制面尚未从 slots 扣除它已有的全部活跃租约，正常 Go Worker 自行计算空闲槽位。
- 默认 TTL 为 30 秒，Worker 约每 TTL/3 心跳。当前续租检查 owner 与 leased 状态，未单独拒绝已经超时但尚未被回收的租约。
- 过期回收增加 `episodes.attempt`，其含义是过期次数；默认第 3 次过期后写入 `infra_error: lease_exhausted`。Worker 直接上报 infra_error 后即为终态，不自动再派。
- 已取消 run 不再派发；当前 Worker 得到取消后结束本地 context、不上报该次结果，租约随后由回收器处理。
- 控制面重启丢失注册表，Worker 收到 `FailedPrecondition` 后重新注册。episode 与已接收结果保存在数据库中。

这些机制提供逻辑结果去重和故障后收敛，不提供物理执行 exactly-once。

### 3.4 Scheduler：目标租约与容量控制

每次实际执行使用独立 `attempt_id`；`episode_key` 保留为计划样本身份。控制面为派发生成单调递增的 `lease_epoch`，Worker 会话也有独立身份。领取、续租、执行状态提交和结果选择均校验该代次，旧 owner / epoch 不得修改新 attempt 的状态。

失租不等于旧执行已经停止。目标 Worker 必须消费逐 attempt 的续租结果；续租失败且无法在有效期内恢复时，在保守的本地截止时间前停止启动新动作，取消执行、回收资源并记录停止证据。控制面先进入对账状态；确认旧执行已停止或后端可阻断旧执行后，才允许自动重派。远端调用仍可能完成或计费，无法确认时记录 unknown 并暂停相关自动重试。

容量由控制面按活跃 attempt 的实际占用扣减，并匹配 CPU、内存、GPU、运行时、环境版本和隔离能力。running、stopping 和尚未释放资源的 collecting attempt 都占用相应额度；进入 reporting 且资源已确认释放后可释放执行额度，但待提交数量必须另有上限。Worker 的 `max`、slots 和 labels 只是请求与能力声明，不替代控制面准入。

### 3.5 Result Ingestor 与提交生命周期

当前 `results` 以 episode_key 为主键，`INSERT OR IGNORE` 保留第一个结果，后续内容不同也返回 duplicate；僵尸完成同样可能抢先入库。现有 Go Worker 在执行返回后先移除 active，再进入内存中的 Report 重试，尚无持久化 outbox。这些是 v1 限制，不是目标保证。

目标 attempt 生命周期为：

```text
queued → preparing → running → stopping / collecting → reporting → terminal
```

执行结果、资源清理状态和提交状态分别持久化。Executor 完成后，先写入本地持久化 outbox，保存结果摘要、制品清单、attempt_id 和 lease_epoch，再报告；ACK 丢失或 Worker 重启只重传相同提交，不重跑模型或仿真。制品写入并校验完成后，控制面在事务中提交 attempt 结果与 receipt，随后返回 ACK。Worker 收到可验证的持久化回执后清除待提交项。

同一提交键与相同内容返回 duplicate；同键不同摘要是 conflict。失效 epoch 的迟到报告可以按审计规则留存旧 attempt 证据，但不得覆盖新 attempt 或直接成为有效样本。报告根据冻结规则选择结果，不按先到、最新或最好结果隐式选择。物理执行与远端费用仍可能重复，所有观测应保留。

### 3.6 Workers 与 Subject

当前 `internal/workerkit` 只接入 Mock Executor；Docker Provider 提供 Start / Exec / Usage / Export / Destroy，可配置默认 runc 或 runsc，但没有真实 Agent Worker 调用它。Subject 的 Describe / Reset / Act / ActBatch 已有 protobuf 与生成代码，尚无真实服务链路。

目标 Agent Worker 恢复任务快照、执行工具与验收、收集产物；具身 Worker 恢复固定仿真状态、驱动策略动作、记录状态与视频。`horizon: next_message` 任务采用轻量执行器，只记录下一次回复或工具调用，不执行工具。不同模式必须在 preflight 验证支持情况，不能由通用接口存在推断已支持所有任务。

### 3.7 统计、评分与分析

当前 Summary 按整体和 variant 汇总：条件成功率为 `success / (success + failure)`，仅使用 done 且可判定的样本；unknown 与 infra_error 分别列出。Wilson 区间已实现，但尚未按相关样本、同源任务或配对实验区分推断方法。

目标保留该条件成功率作为主指标，同时展示计划样本数、终态完成度、可判定覆盖率和缺失原因。可另展示把未判定计划位置视为潜在失败 / 成功时的敏感性范围，明确这是完整计划口径的辅助边界，不是主指标的置信区间。故障比例阈值、最低覆盖率和比较有效性规则必须预先固定；阈值判无效、配对检验和样本量工具尚待实现。

离线评分目标独立消费已冻结产物，Evaluation 绑定评分器版本、参数和证据摘要；重评分产生新版本而不覆盖旧记录。Analyzer 的模型裁判、规则标签与人工复核也保留版本和来源。Report 固定结果选择与统计版本，只呈现可追溯的汇总，不自行重算另一套口径。

## 4. 持久化与恢复

### 4.1 当前 SQLite 模型

```text
runs(run_id PK, name, vertical, spec_yaml, spec_json, manifest_json, status, created_at)
episodes(episode_key PK, run_id, task_id, variant_id, init_state_id, seed, repeat_idx,
         status, attempt, lease_owner, lease_expire_at)
results(episode_key PK, outcome, score, steps, duration_ms, cost_json,
        subgoals_json, artifact_uri, error_kind, finished_at)
labels(episode_key, labeler, label, confidence, rationale, created_at)
```

SQLite 使用 WAL、FULL synchronous 和短事务，进程内单数据库连接串行写入。run 状态为 pending / running / done / cancelled；episode 为 pending / leased / done / infra_error。labels 表已建，标签生成与分析服务尚未实现。

目标在保留历史数据可读的前提下引入独立 attempts、lease 代次、提交回执、Evaluation 与报告选择记录，采用显式 schema migration。episode 记录计划样本，attempt 记录实际工作、清理和成本；评价版本不复用执行结果行。

### 4.2 取消、恢复与新实验

| 操作 | 当前 v1 | 目标 |
|---|---|---|
| 取消 | 标记 run，后续心跳通知 Worker；不再派发 | 保存取消代次，停止派发，等待清理 / 对账；已完成证据按预定规则保留 |
| 恢复 | 再次提交同一 RunSpec，重新开放 cancelled run | 显式恢复原冻结计划，先处理未确认执行与 outbox，再调度未完成样本 |
| 新实验 | 修改 RunSpec 的 name 生成新 run_id | 显式创建新实验身份，可复用配置摘要，形成独立样本 |
| 基础设施重试 | 租约过期有限重派；显式 infra_error 不重派 | 按冻结的故障类别、次数、时间和成本上限决定；确认前次执行停止后新建 attempt |

重试不增加计划样本数，也不用于把有效失败重跑成成功。每个 attempt 的调用、耗时、制品和已知 / 未知成本均保留，汇总实际支出包含失败与重试。可自动重试的基础设施故障必须与模型能力失败区分；重复提交和模型/工具请求重放不是同一层幂等性。

改变当前“重提即恢复”的行为需要版本化 API / CLI 迁移，不能只修改文档后默默改变现有操作。

### 4.3 制品存储

当前数据库仅保存制品 URI，Docker Export 可生成终态文件；统一存储与上传提交尚未接入。目标以 run / episode / attempt 为索引，内容摘要校验原始字节、工作区清单、轨迹、视频和工具日志；标准答案与任务可见材料分开授权。制品持久化成功是 ACK 条件的一部分，缺失或截断要显式披露。

## 5. 吞吐优化

以下均为真实执行接入后的优化方向：策略服务与仿真分离、多个环境并行、支持能力下的 ActBatch、动作块执行及跨机器分片。批量大小、动作块长度和实际执行步数写入冻结条件，不能以优化为由改变评分任务。记录环境步速、推理延迟、资源利用率和队列等待，再选择瓶颈改进；不预先宣称加速倍率。

## 6. 部署与可观测性

当前支持独立 controller + SQLite + 一个或多个 Mock Worker；可用 `make up` 启动单机开发环境，没有已实现的 Compose、Postgres、MinIO 或多控制器高可用部署。真实 Agent 需要 Docker 执行后端；具身环境与 GPU 依赖由对应 Worker 定义。

目标单机先保持单写者，扩展到多机时增加可靠资源匹配、认证通信、共享制品和数据库并发控制。Prometheus、分布式 trace、租约过期率、待提交队列、清理失败、重复执行及逐 attempt 成本指标属于后续实现；当前主要依靠日志与状态查询。
