# 05 Agent 垂类

## 1. 范围

评测"LLM + harness"组成的工具调用 Agent：给定任务和一组工具（文件系统、shell、业务 API、模拟用户），Agent 自主多步执行，最终由终态检查判定成败。

两条主线：

1. **通用任务形态复现**：参考公开 benchmark 的任务形态（模拟用户 + 业务规则 + 数据库终态检查；终端沙箱 + 测试脚本判定），实现适配器，验证内核的正确性。
2. **垂直领域自定义评测集**：让用户用少量样例为自己的业务构建评测集——这是本项目最初的出发点，也是对使用者最有价值的部分。

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
CPU / 内存 / 磁盘 / 墙钟时间上限；超出视为 Agent 失败（`resource_exhausted`），而不是 infra_error——资源失控是 Agent 行为的一部分。

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

1. **确定性检查**（OnlineScorer）：数据库终态是否等于期望状态；测试脚本是否通过；输出是否包含必要字段。
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

目标：用户提供 **领域文档 + 5~10 个种子样例**，产出一个可用的评测集。

流程：

1. **Schema 定义**：用户定义领域工具（OpenAPI / MCP 描述）和数据库 schema。
2. **种子样例**：每个样例 = 用户目标 + 初始数据 + 期望终态。
3. **扩写**：LLM 根据种子样例和领域文档生成候选任务，覆盖不同规则分支和边界条件。
4. **可解性校验**：用一个强模型 + 多次尝试执行候选任务；所有尝试都失败的任务进入人工审核（可能是题目本身有误）。
5. **去重与难度分层**：按任务的规则分支覆盖度与强模型通过率分为 smoke / core / hard 三层。
6. **版本化**：评测集以内容哈希为版本号，写入 manifest。

产出物：`verticals/agent/datasets/<domain>/<version>/`，每个任务一个 YAML。

## 8. 回归门禁（CI 集成）

```yaml
gate:
  suite: core
  min_success_rate_lower_ci: 0.70   # 用置信区间下界做门禁，而不是点估计
  max_regression_vs_baseline: significant_only  # 只有配对检验显著下降才阻断
  max_cost_per_task_usd: 0.20
  max_p95_steps: 30
  max_unsafe_action_rate: 0.0
```
