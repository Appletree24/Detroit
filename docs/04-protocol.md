# 04 协议

Detroit 有两套运行时协议：**Worker 协议**（控制面 ↔ Worker）和 **Subject 协议**（Worker ↔ 被测对象）。评测集怎么交给 Detroit（数据生产方 ↔ Detroit）见 [10 评测集格式协议](10-dataset-format.md)。

## 1. Worker 协议（gRPC）

```protobuf
syntax = "proto3";
package detroit.worker.v1;

service Scheduler {
  rpc Register(RegisterReq) returns (RegisterResp);   // 上报能力：垂类、并行度、GPU
  rpc Lease(LeaseReq) returns (LeaseResp);            // 拉取 episode
  rpc Heartbeat(HeartbeatReq) returns (HeartbeatResp);// 续租；响应中可携带取消指令
  rpc Report(EpisodeReport) returns (ReportAck);      // 上报结果（幂等）
}

message RegisterReq  { string worker_id = 1; string vertical = 2; int32 slots = 3; map<string,string> labels = 4; }
message LeaseReq     { string worker_id = 1; int32 max = 2; }
message LeaseResp    { repeated EpisodeLease leases = 1; }
message EpisodeLease { string episode_key = 1; bytes episode_json = 2; bytes run_spec_json = 3; int64 expire_unix_ms = 4; }
message HeartbeatReq { string worker_id = 1; repeated string episode_keys = 2; }
message HeartbeatResp{ repeated string cancelled = 1; int64 extend_to_unix_ms = 2; }
message EpisodeReport{ string episode_key = 1; bytes result_json = 2; string artifact_uri = 3; }
message ReportAck    { bool accepted = 1; bool duplicate = 2; }
```

语义约定：

- `Report` 必须幂等：同一 `episode_key` 重复上报，返回 `duplicate=true`，不覆盖已有结果。
- Worker 在租约过期后仍可能完成并上报（"僵尸完成"）。控制面接受第一个到达的结果；后到者标记 duplicate。
- `Heartbeat` 响应中的 `cancelled` 用于用户取消 run 时让 Worker 尽快停止。

## 2. Subject 协议

### 2.1 设计原则
- **无状态优先**：每次请求携带完整的当前观测；需要历史的被测对象（如 Agent 的对话历史）由 Worker 维护并随请求发送，或通过 `session_id` 由 Subject 自行维护（二选一，在 `Describe` 中声明）。
- **一个 Subject 适配器服务所有环境**：环境差异由观测 schema 描述，而不是由适配器硬编码。这样 N 个 Subject + M 个环境只需要 N + M 次集成。

### 2.2 接口

```protobuf
syntax = "proto3";
package detroit.subject.v1;

service Subject {
  rpc Describe(Empty) returns (SubjectInfo);
  rpc Reset(ResetReq) returns (Empty);          // 新 episode 开始
  rpc Act(ActReq) returns (ActResp);            // 单个观测 → 动作
  rpc ActBatch(ActBatchReq) returns (ActBatchResp); // 多环境批量推理
}

message SubjectInfo {
  string name = 1;
  string digest = 2;           // 写入 manifest
  string obs_schema = 3;       // 期望的观测字段，如 "agentview_rgb,wrist_rgb,state,instruction"
  string action_schema = 4;    // 如 "eef_delta_7d" | "tool_call"
  int32 action_horizon = 5;    // 动作块长度 H（Agent 为 1）
  bool stateful = 6;
}

message ActReq  { string session_id = 1; bytes observation = 2; }   // observation 为 msgpack 编码
message ActResp { bytes actions = 1; map<string,string> debug = 2; }  // actions: H×D 数组或工具调用 JSON
message ActBatchReq  { repeated ActReq items = 1; }
message ActBatchResp { repeated ActResp items = 1; }
```

### 2.3 传输
- 具身：观测含多路图像，使用 gRPC + msgpack 载荷；对已经提供 WebSocket 推理服务的策略框架（如 openpi），适配器做一层协议转换，不修改上游代码。
- Agent：被测对象常常就是一个 OpenAI 兼容的 Chat Completions 接口 + 一段 harness 逻辑。`openai-compatible` 适配器把 Act 映射为一次 chat 调用，工具调用以 JSON 形式返回。

### 2.4 超时与重试
- `Act` 默认超时：Agent 120s、具身 5s（可配）。
- 超时由 Worker 判定：可重试一次；再次超时则 episode 记为 `infra_error: subject_timeout`。
- **不重试模型层面的错误输出**（例如格式错误的工具调用）——那是模型能力的一部分，应计为失败并归因为 `malformed_action`。

## 3. 观测与动作约定（具身）

| 字段 | 形状 | 说明 |
|---|---|---|
| `agentview_rgb` | H×W×3 uint8 | 第三人称相机 |
| `wrist_rgb` | H×W×3 uint8 | 腕部相机 |
| `state` | D | 末端位姿 + 夹爪状态 |
| `instruction` | string | 语言指令 |

图像的朝向（是否翻转）、分辨率、归一化方式必须与被测策略训练时一致，否则会出现"分数莫名偏低"的问题。Worker 在 `Reset` 后执行一次朝向自检（见 07 §5）。
