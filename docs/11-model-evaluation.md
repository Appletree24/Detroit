# 11 模型接入与单步评测

当前可以通过 OpenAI 兼容的 Chat Completions API，运行 v2 评测集中的 `horizon: next_message` 题目，保存模型输出并执行确定性评分。
HTTP 字段按 [OpenAI Docs：Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 实现；供应商必须支持所选模型的 Chat Completions 接口。

## 1. 启动

需要 Go 1.26+。先构建并启动控制面：

```bash
make up
```

另开终端，在当前 shell 中配置 `OPENAI_API_KEY`，然后启动模型适配服务：

```bash
./bin/detroit subject openai-compatible \
  --listen 127.0.0.1:7080 \
  --base-url https://api.openai.com/v1 \
  --model YOUR_MODEL_ID \
  --digest YOUR_MODEL_REVISION
```

- `--base-url` 是供应商 API 基础地址，适配器在后面追加 `/chat/completions`。模型名称必须是该供应商实际支持的名称。
- `--digest` 用于固定本次比较的模型版本，与 RunSpec 的 `subject.digest` 一致。优先使用供应商提供的固定版本标识；别名本身不能保证底层模型不变。原始响应中的实际 `model`、`system_fingerprint` 等字段会保存在制品里。
- `--api-key-env` 默认 `OPENAI_API_KEY`，也可指定别的环境变量名。本地无认证服务可用 `--api-key-env ''`。Key 只在适配服务内用于 HTTP Authorization，不写入 RunSpec、数据库或制品。
- 参数不支持时返回接口错误，不会自动换模型、删除参数或改用其他 API。

再开终端启动真实 Worker：

```bash
./bin/detroit worker agent --slots 1 --artifacts .detroit/artifacts
```

控制面默认 `127.0.0.1:7070`；可用 `--controller` 更改。HTTP API 默认 `127.0.0.1:7071`。
Worker、控制面和 CLI 使用共享本地文件系统。Subject 仅接收被测输入；它不需要读取评测集快照。

## 2. 导入与提交

```bash
./bin/detroit dataset import -f examples/datasets/v2/casepick-inline
```

复制 [model-next-message.yaml](../examples/runspecs/model-next-message.yaml)，将导入返回的 `path`、`snapshot` 填进去，并让 `subject.digest` 与适配服务一致。

```yaml
name: first-model-eval
subject:
  adapter: openai-compatible
  endpoint: 127.0.0.1:7080
  digest: YOUR_MODEL_REVISION
  params: {}
taskset:
  vertical: agent
  source: detroit-v2
  options:
    path: /absolute/path/from/import
    snapshot: sha256:<snapshot 摘要>
scorers:
  select: default
```

**`subject.endpoint` 是 Subject 的 gRPC 地址，不是供应商 HTTP URL。** HTTP URL 和 API Key 由适配服务配置。

```bash
./bin/detroit run submit -f my-run.yaml
./bin/detroit run status RUN_ID
./bin/detroit run results RUN_ID
./bin/detroit run results RUN_ID --json
./bin/detroit run cancel RUN_ID
```

重复提交同一 RunSpec 会续跑，已完成的样本不会再调用模型。需要完整新跑时修改 `name`。
真实 Worker 只领取 `openai-compatible` 任务，mock Worker 只领取 `mock` 任务。

## 3. 输入与采样

- Worker 只使用 `task` 中的系统提示、对话、工具定义和材料。评分、诊断、历史错误示例不会进入模型请求。
- 缺失的系统提示保持缺失；`approximate` / `captured` 且有内容的提示按内容发送，不自动重建。
- 文本材料作为一条前置 user 上下文消息提供，包含路径和 UTF-8 内容。非文本材料不支持；请求与响应上限各为 16 MiB。
- 模型返回的工具调用只记录，不执行。这是一次下一条回复评测，不是多步 Agent 执行。
- 一次 episode 请求一份非流式 completion。`params` 传给 API，支持由供应商决定，例如 `temperature`、`top_p`、`max_completion_tokens` 或 `max_tokens`。需要 token 上限时显式设置供应商支持的字段。
- `model`、`messages`、`tools`、`stream`、`n`、`seed` 等字段由框架固定，不能在 `params` 中覆盖。Key 不能写入参数。
- `params.send_seed: true` 才会把 episode 的 seed 发给供应商；默认不发送，以兼容不支持 seed 的接口。发送 seed 也不等于供应商保证确定性。实际请求保存在 `request.json`。
- `--subject-timeout` 默认 `120s`。一次 Act 超时后重试一次；再次超时记为 `infra_error: subject_timeout`。其他接口错误不自动重试，格式错误的模型动作也不重试。
- 超时请求可能已在供应商消耗 token。`attempts.json` 保留尝试记录，原始 `usage` 记录已知用量；缺失用量与费用不作估算。

## 4. 当前评分支持

| 检查 | 行为 |
|---|---|
| `json_only` | 最终文本完整解析为一个 JSON 值 |
| `json_schema` | 用所提供 Schema 校验 JSON 输出；不拉取远程 Schema |
| `contains` / `not_contains` | 文本包含检查，支持 `ignore_case` |
| `tool_called` / `tool_not_called` | 按工具名称与 `args_match` 递归对象子集匹配 |
| 只有 rubric、未知检查、regex 和环境检查 | `unknown`，不补零、不计入成功率分母 |

同一条要求的 checks 全部通过才通过；任一失败则失败；否则保留 unknown。有 checks 时按 checks 判定，rubric 不触发额外模型调用。
必过条件和加分阈值按 10 §7.4 组合；评分明细同时保存加分项覆盖率。
评分器故障记为 `infra_error: scorer_error`，保留已有输出；格式错误的 assistant/tool action 记为任务失败。

当前每题最多选择一份评分。示例评测集同时有 `default` 和 `lenient`，因此应指定 `scorers.select: default`；
选择 `all` 导致某题匹配多份时，提交会明确拒绝，要求选择 label。没有评分的题目可以执行，结果保持 unknown。
`episode` 多步任务、非 base Variant 和命名离线 Scorer 也会在提交前拒绝。

## 5. 查看制品

`run results` 返回控制面实际接受的那次执行的目录：

```text
.detroit/artifacts/<run_id>/<episode_key>/attempt-*/
  episode.json            # episode、声明的 Subject、数据与评分版本、超时
  subject.json            # Describe 返回的模型名称、版本和协议
  request.json            # 实际 HTTP 请求体，不含认证头
  response.json           # 原始供应商响应，包括其提供的模型版本和 usage
  response_metadata.json  # 配置的模型、API 地址、供应商 request ID
  output.json             # assistant 消息
  trajectory.jsonl        # 观测摘要、动作、耗时
  attempts.json           # 超时与请求尝试
  scoring.json            # 各要求结果和 unknown 原因
  result.json             # 上报的结构化结果
  error.json              # 发生基础设施故障时的原因
```

不同执行尝试使用不同目录，不覆盖先前证据。`run status` 中成功率的分母仅包含可判定样本，unknown 和 infra_error 单列，附 Wilson 区间。

本地 HTTP 测试服务已用于验证完整 CLI → 控制面 → Worker → Subject → HTTP → 评分 → 续跑流程；
这类脚本化响应只验证工程行为，不作为真实模型的评测成绩。接入供应商后应另外保存带实际配置与响应的实测结果。
