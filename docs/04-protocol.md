# 04 协议

Detroit 有两套运行时协议：**Worker 协议**（控制面 ↔ Worker）和 **Subject 协议**（Worker ↔ 被测对象）。任务数据的输入协议见 [10 评测集格式协议](10-dataset-format.md)，跨模块约束见 [DESIGN.md](../DESIGN.md)。

本文分别记录当前 v1 与目标演进。下文新增的 attempt、租约代次、能力协商和提交回执等字段**尚未进入 protobuf 或 Go 实现**；评测集格式 v2 与运行时协议版本是不同维度。

## 1. 当前 Worker v1（已实现）

实际定义位于 [worker.proto](../proto/detroit/worker/v1/worker.proto)，控制面和 Go Worker 运行时已接入；当前可执行闭环是 Synthetic + Mock。

```protobuf
syntax = "proto3";
package detroit.worker.v1;

service Scheduler {
  rpc Register(RegisterReq) returns (RegisterResp);
  rpc Lease(LeaseReq) returns (LeaseResp);
  rpc Heartbeat(HeartbeatReq) returns (HeartbeatResp);
  rpc Report(EpisodeReport) returns (ReportAck);
}

message RegisterReq  { string worker_id = 1; string vertical = 2; int32 slots = 3; map<string,string> labels = 4; }
message RegisterResp { int64 lease_ttl_ms = 1; }
message LeaseReq     { string worker_id = 1; int32 max = 2; }
message LeaseResp    { repeated EpisodeLease leases = 1; }
message EpisodeLease { string episode_key = 1; bytes episode_json = 2; bytes run_spec_json = 3; int64 expire_unix_ms = 4; }
message HeartbeatReq { string worker_id = 1; repeated string episode_keys = 2; }
message HeartbeatResp{ repeated string cancelled = 1; int64 extend_to_unix_ms = 2; }
message EpisodeReport{ string episode_key = 1; bytes result_json = 2; string artifact_uri = 3; }
message ReportAck    { bool accepted = 1; bool duplicate = 2; }
```

### 1.1 注册与领取

- Register 要求非空 worker_id、agent / embodied 垂类和正 slots；labels 当前仅记录日志，未用于 GPU 或运行时能力匹配。注册信息在控制面内存中。
- Lease、Heartbeat 要求已注册，否则返回 `FailedPrecondition`；Worker 据此重新注册。Report 不要求注册。
- Lease 按 vertical 选择 pending episode，单次上限为 `min(max, slots)`；控制面尚未扣除该 Worker 已持有的全部租约。Go Worker 通过本地 active 数计算剩余槽位。
- `episode_json` 是 core.Episode，`run_spec_json` 是补默认值后的 RunSpec。当前租约没有任务快照摘要、attempt_id、Worker 会话代次或 lease_epoch。

### 1.2 续租、取消与重派

- 默认 TTL 为 30 秒，Go Worker 约每 TTL/3 心跳。Heartbeat 仅按 owner、leased 状态和 episode key 更新到期时间；超过旧有效期但尚未被回收的租约仍可能被续期。
- 已被回收或转给其他 Worker 的租约不再续期；响应目前只给统一 `extend_to_unix_ms` 和 run 取消列表，不逐项返回 lost / stale。Worker 目前不会因本地租约时间到期自行终止执行。
- 租约回收增加过期次数，达到配置上限后写入 `infra_error: lease_exhausted`。默认上限为 3；显式上报 infra_error 后已经终结，不自动重派。
- 用户取消 run 后停止新派发，Worker 在后续心跳收到 cancelled 并取消 context。当前 runtime 不提交该次执行结果，停止续租后由回收器转回 pending 或写入耗尽结果；重新提交同一 RunSpec 可重新开放原 run。

### 1.3 结果上报与现有限制

`result_json.key` 必须等于外层 episode_key。done 必须带 success / failure / unknown；infra_error 必须带 error_kind 且不能带 outcome。未知 episode 返回 `NotFound`，非法载荷返回 `InvalidArgument`。

当前 Report 以 episode_key 去重，第一条结果被保留；内容不同的后续报告也返回 duplicate，不比较摘要。过期旧 Worker 先完成时仍可成为有效结果；已写入 lease_exhausted 后到达的有效结果也只算 duplicate。

当前 Go Worker 在 Executor 返回后移除 active、释放槽位，再用内存中的结果重试 Report。没有持久化 outbox，提交期间不再为该结果续租；断网或进程退出可能造成重复执行或已完成结果丢失。因此 v1 只提供“一条最终结果行”的逻辑去重，不承诺一次物理执行、全部 attempt 留存或完整费用统计。

### 1.4 Worker 协议目标演进（待实现）

#### 1.4.1 身份与能力

以下为目标契约字段，不是已分配字段号的 protobuf 定义：

| 消息 / 对象 | 目标新增内容 | 用途 |
|---|---|---|
| Register | protocol_versions、worker_session_id、executor_versions、runtime / resource capabilities | 协商能力，区分同 ID 的不同 Worker 进程 |
| Lease 请求 | worker_session_id、可接受资源、请求幂等键 | 限制派发与重复领取；不能替代控制面资源账本 |
| EpisodeLease | attempt_id、lease_epoch、plan_digest、task / dataset / scoring / loader / environment 摘要、资源预算 | 固定实际执行身份、版本和授权 |
| Heartbeat 项 | attempt_id、lease_epoch、执行阶段、资源占用 / 清理状态 | 每个执行独立续租、对账 |
| Heartbeat 响应项 | renewed / cancelling / lost / stale、有效期、取消代次 | 明确每项是否仍有执行权 |
| AttemptReport | attempt_id、lease_epoch、report_id、payload_digest、artifact_manifest_digest、实际用量、清理状态 | 不可变结果提交和完整成本记录 |
| ReportAck | accepted / duplicate / stale / conflict / rejected、receipt_id、committed_digest | 确认持久化结果及处理方式 |

控制面验证摘要对应冻结计划，Worker 在运行前核验材料和实际环境；不能只相信任务 ID、可变镜像标签或 Loader 名称。资源匹配按活跃 attempt 的占用、Worker 能力与后端可用量执行，不以 slots 或自报空闲量单独决定。

#### 1.4.2 Lease fencing 与分区行为

控制面每次授权新的实际执行时创建 attempt_id 和单调 lease_epoch，持久化 owner 与有效期。续租和影响有效结果的状态转换必须匹配当前授权；同名 Worker 重新注册不能继承旧会话的执行权。

Worker 使用已确认的租约有效期与保守的本地截止时间控制执行。有效续租失败时可在期限内重连；超过安全余量后停止发起新的模型/工具动作，取消执行并尝试回收后端资源。lost / stale 必须触发同样的停止流程，不能继续运行等待“先到结果获胜”。

控制面失联时不能推断执行已停止。过期 attempt 进入对账；自动重派前必须获得停止确认或由执行后端实现足够的隔离与阻断。网络请求已到达远端时，取消本地请求不保证远端未执行或未计费；无法确认的调用与成本记录为 unknown，按冻结规则暂停自动重试或要求显式处置。

Fencing 约束的是授权与提交；它本身不能撤销已发出的远端副作用，不作为物理 exactly-once 的证明。

- `Report` 必须幂等：同一 `episode_key` 重复上报，返回 `duplicate=true`，不覆盖已有结果。
- Worker 在租约过期后仍可能完成并上报（"僵尸完成"）。控制面接受第一个到达的结果；后到者标记 duplicate。
- `Heartbeat` 响应中的 `cancelled` 用于用户取消 run 时让 Worker 尽快停止。被取消的 episode 不上报结果；它们的租约过期后回到待调度状态，run 重新开放后继续执行。
- 心跳只为该 Worker 仍持有的租约续期；已过期并转给别的 Worker 的租约不会被续期。
- 注册 labels 的 `subject_adapter` 指定可执行的 Subject 适配器；未指定时按 `mock` 处理。控制面同时按垂类和适配器派发，避免 mock 执行真实模型任务。
- `Lease`、`Heartbeat` 要求 Worker 已注册，否则返回 `FailedPrecondition`；`Report` 不要求，以便接受僵尸完成和控制面重启前执行完的结果。
- `episode_json` 是 `Episode`（03 §2），`run_spec_json` 是补全默认值后的 RunSpec。`result_json` 是 `EpisodeResult`，其中 `key` 必须与 `episode_key` 一致。

## 2. Subject 协议

### 2.1 当前定义与实现状态

[subject.proto](../proto/detroit/subject/v1/subject.proto) 已定义以下接口并生成 Go 代码；实际 Subject 服务、适配器及真实 Worker 调用尚未实现。

```protobuf
syntax = "proto3";
package detroit.subject.v1;

service Subject {
  rpc Describe(Empty) returns (SubjectInfo);
  rpc Reset(ResetReq) returns (Empty);
  rpc Act(ActReq) returns (ActResp);
  rpc ActBatch(ActBatchReq) returns (ActBatchResp);
}
message Empty {}
message SubjectInfo {
  string name = 1;
  string digest = 2;
  string obs_schema = 3;
  string action_schema = 4;
  int32 action_horizon = 5;
  bool stateful = 6;
}
message ResetReq { string session_id = 1; string task_id = 2; int64 seed = 3; }
message ActReq { string session_id = 1; bytes observation = 2; }
message ActResp { bytes actions = 1; map<string,string> debug = 2; }
message ActBatchReq { repeated ActReq items = 1; }
message ActBatchResp { repeated ActResp items = 1; }
```

### 2.2 适配与数据面目标

无状态 Subject 接收完整当前观测；有状态 Subject 通过 session_id 管理历史，并声明 Reset 和隔离能力。Agent 与具身适配器遵循相同控制接口，领域差异由经过版本化的 observation / action schema 表达。

目标 Agent 适配器可把 Act 映射到模型请求，返回文本或工具调用；工具由 Worker / Harness 按任务模式执行。具身观测按协议定义编码多路图像与状态，适配器可转换已有策略服务协议。当前 protobuf 注释约定 msgpack 观测载荷，但编码器、schema 校验和 WebSocket 转换尚待实现。

### 2.3 会话与能力声明

每个 attempt 使用独立 session_id，重派不能隐式复用上次历史。Describe 的实际模型版本、状态模式、动作块长度、批处理能力与 requested 配置分别记录；不支持的 schema、预算或模式须在 preflight 拒绝或按预先声明的兼容策略处理。

### 2.4 超时、模型请求重试与结果判定

超时、取消和重试是任务及适配器的显式配置，写入冻结计划；旧设计中的“Agent 120 秒、具身 5 秒、超时自动再试一次”不是现有代码默认，也不作为通用隐式策略。

模型请求可能在客户端超时后继续执行。只有服务端幂等请求标识、状态查询或其他明确重放条件成立时才允许自动请求重试；否则保留远端状态 / 费用不明并停止受影响执行。ActBatch 需逐项关联输入、输出与错误，不能把整批重传视为每项未执行。

### 2.4 当前 Agent 载荷

`subjects/openaicompat` 实现无状态 Subject 服务。`Describe.name` 为配置的 API 模型名称，
`digest` 为声明的模型版本，`obs_schema=detroit.agent.observation/v1`，
`action_schema=openai.chat.completion/v1`，`action_horizon=1`。
观测是 msgpack 对象：`{messages, tools?, params?, seed}`；Worker 维护完整对话。
`Act.actions` 返回原始非流式 Chat Completions 响应 JSON（含一份 choice、usage 等）；
Worker 取其中的 assistant 消息评分。`debug` 返回配置的 model、base_url 和供应商 request_id。
API Key 只存在于 Subject 服务中，不进入观测或响应。

### 2.5 超时与重试
- `Act` 默认超时：Agent 120s、具身 5s（可配）。
- 超时由 Worker 判定：可重试一次；再次超时则 episode 记为 `infra_error: subject_timeout`。
- **不重试模型层面的错误输出**（例如格式错误的工具调用）——那是模型能力的一部分，应计为失败并归因为 `malformed_action`。

## 3. 具身观测与动作约定（目标）

| 字段 | 形状 | 说明 |
|---|---|---|
| `agentview_rgb` | H×W×3 uint8 | 第三人称相机 |
| `wrist_rgb` | H×W×3 uint8 | 腕部相机 |
| `state` | D | 末端位姿、夹爪及所需本体状态 |
| `instruction` | string | 任务语言指令 |

相机朝向、分辨率、颜色顺序、归一化、动作坐标系、单位和 action horizon 都要版本化并与策略要求核对。Reset 后的朝向 / 状态自检、动作块执行与视频记录属于具身 Worker 的验收目标；不能因协议字段已存在宣称仿真链路已完成。
