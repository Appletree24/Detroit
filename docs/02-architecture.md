# 02 系统架构

## 1. 总览

```
                     ┌──────────────────────── 控制面 (Go) ────────────────────────┐
  detroit CLI ──────▶│  API Server ── Run Planner ── Scheduler ── Result Ingestor  │
                     │                    │              │              │           │
                     │                    ▼              ▼              ▼           │
                     │               Metadata Store (SQLite / Postgres)             │
                     └───────────────────────────┬──────────────────────────────────┘
                                                 │ Lease / Heartbeat / Report (gRPC)
                     ┌───────────────────────────┴──────────────────────────────────┐
                     │                     数据面 (Workers)                          │
                     │  Agent Worker (沙箱容器)        Embodied Worker (MuJoCo/LIBERO) │
                     │        │                                │                     │
                     │        ▼ Subject 协议                   ▼ Subject 协议        │
                     │   Subject Server (LLM+harness)     Subject Server (VLA 策略)   │
                     └───────────────────────────┬──────────────────────────────────┘
                                                 ▼
                                  Artifact Store (本地 FS / MinIO)
                                  轨迹、视频、日志、工具调用记录
                                                 │
                     ┌───────────────────────────┴──────────────────────────────────┐
                     │  离线分析 (Go + Python)：Stats ── Analyzer(Judge) ── Report   │
                     └──────────────────────────────────────────────────────────────┘
```

## 2. 控制面 / 数据面分离

**控制面**只负责"该跑什么、谁在跑、跑完没有"，从不接触观测和动作数据。
**数据面**由 Worker 直接调用 Subject，观测 / 动作在 Worker 与 Subject 之间点对点传输。

理由：

- 具身观测是多路图像，单个 episode 可能产生数百 MB 的帧数据；如果经过控制面中转，控制面会成为带宽瓶颈。
- 控制面保持无状态（状态在数据库），可以随时重启而不影响正在执行的 episode。
- Worker 与 Subject 可以部署在同一台 GPU 机器上，消除网络往返。

## 3. 核心组件

### 3.1 API Server
- 接收 RunSpec（YAML），校验后写入数据库，返回 run_id。
- 提供查询接口：进度、失败 episode 列表、报告。

### 3.2 Run Planner
把一个 RunSpec 展开为 Episode 列表：

```
Episode = (run_id, task_id, variant_id, init_state_id, seed, repeat_idx)
episode_key = sha256(上面六元组 + subject_digest + env_digest)
```

`episode_key` 是幂等键：同一个 key 的 episode 无论被调度多少次，结果只入库一次。这使得"断点续跑"等价于"重新提交同一个 RunSpec，跳过已完成的 key"。

### 3.3 Scheduler（拉模式 + 租约）
- Worker 主动 `Lease(n)` 拉取最多 n 个 episode，获得 TTL 为 T 的租约。
- Worker 每 T/3 发送一次 `Heartbeat` 续租。
- 租约过期未续 → episode 回到待调度状态，attempt + 1。
- attempt 超过上限 → 标记为 `infra_error`，**不计入成功率分母**，在报告中单列。

为什么用拉模式而不是推模式：Worker 的处理能力差异大（GPU 型号、并行环境数不同），拉模式天然按能力分配，控制面不需要感知 Worker 负载。

为什么区分 `infra_error` 与 `failure`：沙箱启动失败、仿真器崩溃、Subject 超时属于基础设施问题，不应被算作模型失败；但它们的比例必须在报告中可见，比例过高时整次 run 判定为无效。

### 3.4 Result Ingestor
- 接收 Worker 上报的 `EpisodeResult`（结构化结果 + 制品 URI）。
- 基于 `episode_key` 做 upsert，保证幂等。

### 3.5 Workers
- 每个垂类一个 Worker 实现，遵守统一的 Worker 协议（见 04）。
- Worker 内部负责：环境构建、重置到指定初始状态、与 Subject 交互、执行 Scorer 中的"在线"部分（需要环境内部状态的检查）、录制制品。

### 3.6 离线分析
- **Stats**：纯 Go，按 task / suite / variant 聚合，计算区间与检验。
- **Analyzer**：调用 LLM / VLM Judge 对失败 episode 打标签，并做聚类。由于需要调用模型 API，Analyzer 作为独立任务异步执行，可以重跑而不影响原始结果。
- **Report**：生成 Markdown / HTML 报告。

## 4. 存储设计

### 4.1 元数据（SQLite 起步，可切 Postgres）

```sql
runs(run_id PK, spec_yaml, manifest_json, status, created_at)
episodes(episode_key PK, run_id, task_id, variant_id, init_state_id, seed, repeat_idx,
         status, attempt, lease_owner, lease_expire_at)
results(episode_key PK, outcome, score, steps, duration_ms, cost_json,
        subgoals_json, artifact_uri, error_kind, finished_at)
labels(episode_key, labeler, label, confidence, rationale, created_at)   -- 失败归因
```

`status ∈ {pending, leased, done, infra_error}`；`outcome ∈ {success, failure}`。

### 4.2 制品

```
artifacts/<run_id>/<episode_key>/
  trajectory.jsonl     # 每一步的观测摘要、动作、耗时
  video.mp4            # 具身：多视角拼接录像
  tool_calls.jsonl     # Agent：工具调用与返回
  env_final_state.json # 终态快照（供离线 Scorer 使用）
  stdout.log
```

## 5. 吞吐优化（具身垂类为主）

具身评测的时间消耗来自四部分：策略推理、仿真步进、渲染、环境重置。优化手段按投入产出排序：

1. **策略服务与仿真分离**：Subject 独立进程 / 独立 GPU，仿真在 CPU 侧并行。
2. **多环境并行 + 批量推理**：一个 Worker 内 K 个环境并行步进，把 K 个观测合并为一次批推理。
3. **动作块执行**：Subject 一次返回 H 步动作，Worker 执行前 h 步后再重新查询（h ≤ H 可配置），推理调用次数下降为 1/h。
4. **跨机器分片**：靠调度器天然支持。

每次 run 记录 `env_steps/sec`、`inference_latency_p50/p99`、`gpu_util`，报告中给出瓶颈分析。

## 6. 部署形态

| 形态 | 组成 | 适用 |
|---|---|---|
| 单机开发 | controller + SQLite + 本地 FS + 1 个 Worker + 1 个 Subject，`docker compose up` | 开发、小规模评测 |
| 单机 GPU | 同上，Worker 开多进程，Subject 在 GPU 上 | 具身全量评测 |
| 多机 | controller + Postgres + MinIO，Worker 横向扩展 | 大规模扫参、多 checkpoint |

## 7. 可观测性

- 控制面暴露 Prometheus 指标：待调度 / 执行中 / 完成 / infra_error 的 episode 数，租约过期率，Worker 存活数。
- 每个 episode 带 trace_id，贯穿 Worker、Subject 日志，便于定位单个失败。
