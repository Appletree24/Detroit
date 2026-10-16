# 10 评测集格式协议

> 版本 v2 草案，2026-10-12。状态：**待审阅**。
> 已确认的决定：协议由 Detroit 定义和维护；评分定义可以和题目分开分发（见 09 D10、D11）；§13 中 4 个问题的处理方式。其余内容是设计建议，实现前需要再审阅。
> 机器可读的定义见 [`schemas/detroit-v2.schema.json`](../schemas/detroit-v2.schema.json)（JSON Schema 2020-12）。它只覆盖结构；摘要、引文核对等跨字段检查见 §10。
> 示例见 [`examples/datasets/v2/`](../examples/datasets/v2/)：`casepick-inline` 是一道对话续写题，带内联默认评分和一份单独分发的宽松版评分；`swe-bench-bundle` 是任务级题目的 bundle（示意数据，不是上游原文）。示例都通过了 Schema 校验，摘要按 §4 计算。

## 1. 目的与范围

04 定义了运行时的两套协议（Worker、Subject）。本文定义第三套：**评测集怎么交给 Detroit**。它是数据生产方和 Detroit 之间唯一的约定。

需要覆盖的来源：

| 来源 | 形态 | 例子 |
| --- | --- | --- |
| 外部 Harness 插件 | 截取真实会话中的一次犯错，只判下一条回复 | CasePick（Pi 插件） |
| 用户自建评测集 | 给定指令和沙箱，Agent 多步执行，按终态判定 | 05 §7 评测集构建器的产出 |
| 公开 benchmark | 由 loader 从上游按固定版本转换 | Terminal-Bench、SWE-bench 系列 |

不在本文范围：怎么跑（RunSpec、Variant、seed、repeat，见 03 §4）、跑出的结果（EpisodeResult、Label）、Judge 用哪个模型和提示词（属于 Scorer 版本，见 07 §3.4）。

具身垂类暂不定义 `task` 的具体形态，但信封、评分、评测集三部分与垂类无关，具身以后只需新增 `task.kind`（§12）。

## 2. 设计原则

1. **题目和评分分开版本化。** 改评分不等于改题。两者各有摘要，评分通过摘要绑定到题目的具体内容。评分更新后，Detroit 可以对已有制品重新评分，不重跑被测对象。
2. **可见性由结构决定，不靠约定。** 被测对象只能看到 `task`；`scoring` 和 `diagnostic` 永远不进入 Subject 的输入。
3. **能确定就不用模型判**（05 §5）。确定性检查和 rubric 并存；rubric 是确定性检查覆盖不了时的主要依据，不是次品。
4. **如实声明缺失。** 拿不到的系统提示、近似的工具定义、无法恢复的环境，都写进 `limitations`，不假装完整。
5. **交换格式不含平台内部状态。** 导入批准、平台分配的 ID、本机路径不进协议；平台在导入时自行生成。
6. **严格校验，但留扩展点。** 未知字段一律拒绝，只有 `extensions` 下的 `x-*` 键例外：平台必须原样保留，可以忽略。

## 3. 三种文档

| 文档 | `schema` 值 | 对应 03 中的抽象 | 作用 |
| --- | --- | --- | --- |
| 题目 | `detroit.case/v2` | `Task` + `InitState`，可附一份默认评分 | 被测对象看到什么、从哪开始、产出什么 |
| 评分 | `detroit.scoring/v2` | `ScorerSpec` 中与题目相关的部分 | 怎样算通过：要求、确定性检查、rubric |
| 评测集 | `detroit.dataset/v2` | `TaskSet` | 固定一组题目版本和评分版本，加上分组、用途、权重 |

```
detroit.dataset/v2 ──固定──▶ detroit.case/v2（id + revision + task 摘要）
        │                         ▲
        └──────固定──▶ detroit.scoring/v2 ──target.task_digest──┘
                       （一道题可以有多份评分）
```

最简单的用法只需要题目文档：评分可以内联在 `case.scoring` 里，不写评测集文档也能导入（平台按导入批次生成一个评测集）。尚未提供评分时，评测集条目的 `scoring` 为空数组；它表示待补评分，不能据此判定成功。

## 4. 编码与摘要

- **编码**：JSON（UTF-8）。多条文档用 JSONL，一行一条。手写时可以用 YAML，但必须能无损转成 JSON；摘要始终按 JSON 计算。
- **规范化**：摘要按 [RFC 8785（JCS）](https://www.rfc-editor.org/rfc/rfc8785) 规范化后取 SHA-256，写成 `sha256:<64 位小写十六进制>`。
- **二进制与大文件**：用 `blob` 引用（`{"sha256": "…", "bytes": 123}`），内容按摘要存放（§9）。摘要只覆盖引用本身，blob 内容由引用中的哈希保证。

| 摘要 | 覆盖范围 | 不覆盖 |
| --- | --- | --- |
| `digests.task` | `task` 整个对象 | 标题、`meta`、`diagnostic`、`provenance`、`scoring`、`extensions` |
| `digests.scoring` | 评分文档去掉 `id`、`revision`、`label`、`target`、`producer`、`extensions` 后的内容；内联评分取 `case.scoring` 同样的子集 | — |

所以：改标题、补诊断信息、更新来源说明，都不会让题目"变成新题"；改了 `task` 里的任何内容，所有绑定它的评分都会失效（§7.2）。

## 5. 公共字段

三种文档都有：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `schema` | 是 | 文档类型和主版本，如 `detroit.case/v2` |
| `id` | 是 | 稳定标识。建议带生产方前缀，如 `casepick:c_01JB7Q9X2M`、`swe-bench-verified:django__django-11099` |
| `revision` | 是 | 正整数，从 1 开始，内容变化时加 1 |
| `extensions` | 否 | 只允许 `x-` 开头的键，值任意 |

## 6. 题目：`detroit.case/v2`

### 6.1 顶层

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `title` | 是 | 一句话标题 |
| `suite` | 否 | 聚合分组（03 `Task.Suite`） |
| `meta` | 否 | 字符串到字符串的标签（03 `Task.Meta`），如 `domain=refund`、`skill=format` |
| `task` | 是 | 被测对象可见的全部内容，§6.2 |
| `scoring` | 否 | 默认评分，结构同评分文档去掉 `target`，§7 |
| `diagnostic` | 否 | 只给人和评审看的信息，§6.4 |
| `provenance` | 是 | 来源、用途、生产方、局限，§6.5 |
| `digests` | 是 | `task`，以及有内联评分时的 `scoring` |

### 6.2 `task`

被测对象从这里开始。字段按"上下文 → 环境 → 产出"组织：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `kind` | 是 | 目前只有 `agent`；具身以后新增 |
| `horizon` | 是 | `next_message`：只判被测对象的下一条回复（含工具调用），不执行工具；`episode`：被测对象多步执行，直到结束或达到 `max_steps` |
| `start` | 是 | `original`：从最初的任务开始；`current`：从中途的某个状态接手 |
| `instruction` | 条件 | 自然语言指令。没有 `messages` 时必填 |
| `messages` | 条件 | 起始对话，OpenAI Chat Completions 的 messages 格式（不含 system）。`horizon: next_message` 时必填，且最后一条不能是 assistant |
| `system` | 否 | `{ "status": "captured" \| "approximate" \| "missing", "content": string \| null }` |
| `tools` | 否 | §6.3 |
| `environment` | 否 | 沙箱 / InitState，§6.3 |
| `materials` | 否 | 被测对象可见的文件：`[{ "path", "content" \| "blob", "mode"?, "media_type"? }]` |
| `output` | 否 | `{ "format": "text" \| "json" \| "tool_calls" \| "files" \| "mixed", "description"? }` |
| `max_steps` | 否 | 仅 `episode`，03 `Task.MaxSteps` |
| `limitations` | 否 | 影响这道题本身的已知缺失或近似，§6.5 的同名结构 |

**`instruction` 和 `messages` 的关系**：同时存在时，`instruction` 只是给人看的摘要；只有 `instruction` 时，平台把它当作 `messages: [{"role": "user", "content": instruction}]`。所以"任务级题目"就是只有一条消息的对话，CasePick 这类"对话续写"题和 SWE-bench 这类任务题共用同一个结构。

**`horizon` 决定 Worker 的行为**：

| | `next_message` | `episode` |
| --- | --- | --- |
| Worker 做什么 | 发一次 `Act`，记录返回 | 循环 `Act` → 执行工具 → 观测，直到结束 |
| 工具调用 | 记录，不执行 | 在沙箱内执行 |
| 能用的检查 | 输出类、调用类（§7.3） | 全部，包括环境类 |
| 需要环境 | 不需要 | 通常需要 |

### 6.3 `tools` 与 `environment`

`tools`：

| 字段 | 含义 |
| --- | --- |
| `source` | `captured`：取自当时的真实定义；`approximate`：取自事后的配置，可能和当时不同；`environment`：由沙箱或 harness 提供（如 Terminal-Bench 的终端）；`none` |
| `definitions` | OpenAI tools 格式的函数定义，`source` 为 `environment` 或 `none` 时可省略 |

`environment`（对应 03 `InitState`）：

| 字段 | 含义 |
| --- | --- |
| `kind` | `none`：不需要环境；`image`：容器镜像；`unavailable`：需要环境但无法恢复（如事后才截取的会话） |
| `image` | `{ "ref": "python:3.11", "digest": "sha256:…" }`，或 `{ "build": { "dockerfile": blob, "context": blob } }` |
| `workspaces` | `[{ "id", "path", "repo"?, "commit"?, "snapshot"?: blob }]`：代码仓库按提交固定，或给出目录快照 |
| `setup` | 进入初始状态前在沙箱内执行的命令列表；导入时**不执行** |
| `network` | `none` \| `allowlist` \| `host`，默认 `none` |
| `credentials` | 需要的能力名称，如 `["github_read"]`；**只写名称，不写值** |
| `resources` | `{ "cpu"?, "memory_mb"?, "disk_mb"?, "timeout_s"? }` |

`kind: unavailable` 的题目只能用 `horizon: next_message`。平台导入时允许保存，但如果它要求执行工具，运行前会阻止。

### 6.4 `diagnostic`

给人、Judge 校准和失败归因用，**永远不进入被测对象的输入**：

| 字段 | 含义 |
| --- | --- |
| `observed` | 原来那次的输出：一条 assistant 消息，或一段轨迹的 blob |
| `violates` | 原输出违反了哪些要求 ID |
| `followup` | 原输出之后的消息，如用户的纠正 |
| `labels` | 原失败的归因标签：`[{ "taxonomy": "agent_failures@1", "label": "policy_violation", "primary"?: true }]`，对应 05 §6 |
| `notes` | 自由文本 |

`observed` 加上 `violates`，本身就是一条人工确认过的"违反"样本，可以直接进入 07 §3 的 Judge 人工标注集（§7.5）。

### 6.5 `provenance`

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `source.kind` | 是 | `session` \| `issue` \| `oncall` \| `benchmark` \| `generated` \| `manual` |
| `source.reference` | 否 | 稳定的来源标识，不含本机路径。如会话 ID 的哈希加 entry ID |
| `source.group_key` | 否 | 同源题组键。同一个真实问题拆出的多道题填同一个值；平台据此生成来源组 |
| `source.benchmark` | 条件 | `kind: benchmark` 时必填：`{ "name", "version", "instance_id", "license"? }` |
| `purpose` | 是 | `improvement`：已经或将会用于调试、改提示词、训练；`validation`：独立验证用。拿不准时填 `improvement` |
| `producer` | 是 | `{ "name", "version", "method"? }`，`method` 如 `model:deepseek-chat`、`rule:json-conflict@1`、`manual` |
| `created_at` | 是 | RFC 3339 时间 |
| `limitations` | 否 | `[{ "field": "task.system", "status": "missing" \| "approximate" \| "unrecoverable", "note"? }]` |
| `transforms` | 否 | 对原始材料做过的改动：`[{ "type": "redact" \| "truncate" \| "omit_image" \| "drop_thinking", "target": "task.messages[1]", "detail"? }]` |

`purpose` 默认偏向 `improvement`，因为错把改进数据当验证数据会高估泛化能力，反过来只是少用了一些数据。

## 7. 评分：`detroit.scoring/v2`

### 7.1 结构

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `label` | 否 | 给人看的名称，如 `strict`、`lenient`、`v2-rubric` |
| `target` | 是（独立文档） | `{ "case_id", "task_digest" }`；内联在题目里时省略 |
| `producer` | 否 | 同 §6.5 |
| `combine` | 是 | §7.4 |
| `requirements` | 是 | 至少一条，§7.2 |
| `materials` | 否 | 评分侧材料（隐藏测试、标准答案）：同 `task.materials` 结构 |
| `digests` | 是（独立文档） | `{ "scoring" }` |

### 7.2 要求

每条要求是一个独立的判定单位。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 文档内唯一，如 `r1` |
| `text` | 是 | 要求本身，一句话 |
| `required` | 是 | `true`：必过条件；`false`：加分项 |
| `weight` | 否 | 加分项权重，默认 1 |
| `source` | 否 | 要求的出处：`{ "message": 3, "quote": "只输出 JSON" }`（引自 `task.messages` 的下标和原文片段），或 `{ "material": "README.md", "quote": "…" }`，或 `{ "external": "SWE-bench FAIL_TO_PASS" }` |
| `checks` | 否 | 确定性检查，§7.3。多条之间是"都要通过" |
| `rubric` | 条件 | 给 Judge 或人看的判定标准，§7.5。`checks` 为空时必填 |

**绑定与失效**：独立评分文档的 `target.task_digest` 必须等于题目当前的 `digests.task`。题目出了新修订且 `task` 变了，旧评分自动标为"失效"，不会被用到新题上；如果 `source.quote` 仍然能在新题里找到，平台可以提示"可迁移"，但必须由人确认后生成新评分修订。

### 7.3 确定性检查

只支持登记过的类型，不支持任意脚本。需要任意逻辑时，用 `command` 在沙箱里跑。

| 类型 | 阶段 | 参数 | 适用 `horizon` |
| --- | --- | --- | --- |
| `json_only` | 离线 | — | 都可以 |
| `json_schema` | 离线 | `schema` | 都可以 |
| `contains` / `not_contains` | 离线 | `text`、`ignore_case`? | 都可以 |
| `regex` / `not_regex` | 离线 | `pattern`（ECMAScript 语法）、`flags`? | 都可以 |
| `tool_called` / `tool_not_called` | 离线 | `name`、`args_match`?（参数子集匹配） | 都可以 |
| `file_exists` / `file_contains` | 在线 | `path`、`text`? | `episode` |
| `command` | 在线 | `run`、`cwd`?、`timeout_s`?、`pass_exit_codes`（默认 `[0]`）、`error_exit_codes`? | `episode` |
| `tests` | 在线 | `run`、`must_pass`、`must_still_pass`?、`report`（`junit` \| `pytest-json` \| `exit_code`） | `episode` |

- **阶段**由类型决定：离线检查只读制品，对应 03 `OfflineScorer`，可以随时重跑；在线检查要访问终态环境，对应 `OnlineScorer`，在 Worker 内执行。
- **作用对象**：离线检查默认看最终的文字输出；`tool_*` 看全部工具调用；可以用 `scope: "final_text" | "all_text" | "tool_calls"` 覆盖。
- **`command` 的退出码**：在 `pass_exit_codes` 里算通过，在 `error_exit_codes` 里算**评分器故障**，其他算失败。不能把所有非零退出码都当成任务失败。
- **`tests`** 覆盖 SWE-bench 的 FAIL_TO_PASS（`must_pass`）和 PASS_TO_PASS（`must_still_pass`）。
- **未知类型**：平台遇到不认识的检查类型时，导入给出警告；运行时这条要求判 `unknown`，不判失败。
- 新增类型属于小版本升级（§11）。

### 7.4 判定与组合

每条要求的判定结果：

| 结果 | 含义 |
| --- | --- |
| `pass` | 满足 |
| `fail` | 违反 |
| `unknown` | 依据不足：rubric 没覆盖、Judge 拿不准、检查类型不认识 |

评分器自己出错（Judge 接口超时、`command` 返回 `error_exit_codes`）不是任何一种判定结果，而是记为评分故障，可以重跑（对应 D5 的精神：基础设施问题不算模型失败）。

`combine` 目前只有一种：

```json
{ "rule": "required_then_threshold", "threshold": 0.6 }
```

- 任一必过条件 `fail` → 整题 `fail`，不管其他结果。
- 所有必过条件都 `pass`，并且加分项加权得分达到 `threshold`（没有加分项或没写 `threshold` 时跳过）→ 整题 `pass`。
- 其余情况 → 整题 `unknown`。`unknown` 不能当作失败计入成功率，也不能悄悄从分母里去掉；在统计和报告中的处理见 §13 第 1 条。
- 加分项里的 `unknown` 不补零，加权得分只按已知项计算，同时报告覆盖比例。

### 7.5 rubric

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `question` | 是 | 一个能回答"是 / 否"的问题，"是"表示通过 |
| `pass` | 是 | 怎样算通过，描述能直接观察到的特征 |
| `fail` | 是 | 怎样算违反 |
| `edge_cases` | 否 | 容易误判的情况怎么判，一条一句 |
| `examples` | 否 | `[{ "verdict": "pass" \| "fail", "origin": "observed" \| "written", "text", "note"? }]` |
| `scope` | 否 | 同 §7.3 |

写法要求（生产方负责，平台导入时只做结构检查）：

1. 只判这一条要求，范围不超过 `text` 和 `source`。
2. 只依赖 Judge 能看到的东西：`task`、被测输出和 rubric 本身，不依赖 `diagnostic`。
3. 描述可观察的行为，不描述意图。
4. 二元判定，拿不准的情况写进 `edge_cases`。
5. 不惩罚和这条要求无关的差异。

**`origin: observed` 的例子**是从原失败输出中截取的真实片段，并且由人确认过判定。平台用它做两件事：

- **导入检查**：如果题目带了 `diagnostic.observed`，这些片段必须能在其中找到原文。
- **Judge 校准**：可以导出为 07 §3 的人工标注样本。这是 rubric 的独立校验：Judge 对这些已知 `fail` 的片段判 `pass`，说明 Judge 或 rubric 有问题。

Judge 用哪个模型、什么提示词，不属于本协议，由 RunSpec 中的 Scorer 决定，并进入 `scorer.Version()`。

### 7.6 Judge 请求与响应：`detroit.judge/v1`

为了让不同 Judge 实现的结果可以对齐，约定一次只判一条要求：

```jsonc
// 请求
{
  "schema": "detroit.judge/v1",
  "requirement": { "id": "r1", "text": "…", "rubric": { /* §7.5 */ } },
  "context": [ /* task.messages 的全部或末尾若干条，由 Scorer 决定 */ ],
  "output": { "text": "…", "tool_calls": [ ] }
}
// 响应
{
  "requirement": "r1",
  "verdict": "fail",                 // pass | fail | unknown
  "evidence": "被测输出中支撑判定的原文片段",
  "reason": "一两句话"
}
```

`evidence` 必须是 `output` 的原文片段，Scorer 应该核对；核对不过的响应按 `unknown` 处理，并记录原因。

## 8. 评测集：`detroit.dataset/v2`

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 名称 |
| `purpose` | 是 | `improvement` \| `validation`。验证集里不能出现 `provenance.purpose` 为 `improvement` 的题，也不能和改进集共享 `group_key` |
| `entries` | 是 | `[{ "case": { "id", "revision", "task_digest" }, "scoring": [{ "id"?, "revision"?, "digest" }], "weight"?, "suite"? }]` |
| `digests` | 是 | `{ "dataset" }`：`entries` 和 `purpose` 的摘要，作为评测集版本号（05 §7 第 6 步） |

- `scoring` 列出这道题在本评测集里使用的评分。只有一份时直接使用；有多份时，RunSpec 必须指定用哪一份，或者全部评一遍、分别报告。不同评分的结果不混在一起统计（07 §3.4）。
- 内联评分用 `{ "digest": case.digests.scoring }` 引用，不需要 `id`。
- 尚无评分的题目可以导入，条目的 `scoring: []` 表示待补评分。
- 导入时若拒绝某份评分，平台移除该评分的引用并生成新的有效评测集摘要，在导入结果中明确报告；原始交换文件保持不变。
- 同一个 `group_key` 的题目，在统计上作为相关样本处理，不当作互相独立的题。

## 9. 打包

同一个数据模型，两种打包方式：

**内联（JSONL）**：适合纯文本题目，比如 CasePick 的产出。

```
cases.jsonl          每行一个 detroit.case/v2，材料用 content 内联
scorings.jsonl       可选：每行一个 detroit.scoring/v2
dataset.json         可选：没有时平台按导入批次生成
```

**目录（bundle）**：适合带工作区、镜像构建文件或二进制材料的题目。

```
<name>/
  dataset.json
  cases/<id>.json            文件名里的 ":" 替换为 "__"
  scorings/<id>.r<revision>.json
  blobs/sha256/<hex>         所有 blob 引用的内容
```

上限：单个 JSON 文档 16 MiB，单个 blob 256 MiB，单个 bundle 总计 4 GiB。超出时用 `environment.image` 或 `workspaces[].repo` + `commit` 引用，不内联。

**公开 benchmark 不重新分发。** loader 按 `source.benchmark.version` 从上游拉取并转换成本格式，只在本地存储。这样做避免许可证问题，也保证和上游内容一致（D7）。

## 10. 导入检查

平台导入时必须做以下检查。前四类不通过就拒绝导入，后两类只给警告：

| 检查 | 不通过时 |
| --- | --- |
| 符合 JSON Schema；除 `extensions` 外没有未知字段 | 拒绝 |
| 所有 `digests` 都和重新计算的结果一致；blob 内容和哈希一致 | 拒绝 |
| `horizon: next_message` 时 `messages` 存在，最后一条不是 assistant；工具调用和工具结果一一配对 | 拒绝 |
| 要求的 `source.quote` 能在所引用的消息或材料原文中找到 | 拒绝 |
| `origin: observed` 的例子能在 `diagnostic.observed` 中找到（有 `diagnostic` 时） | 拒绝 |
| 独立评分的 `target.task_digest` 和题目当前版本不一致 | 拒绝该评分，题目照常导入 |
| `horizon` 和检查类型冲突（比如 `next_message` 用了 `command`） | 拒绝该要求所在的评分 |
| 出现未知检查类型 | 警告；运行时该要求判 `unknown` |
| `environment.kind: unavailable` | 警告；运行前阻止需要执行工具的题目 |
| 验证集中出现 `improvement` 来源或共享 `group_key` | 警告，并要求在评测集上显式确认 |

## 11. 版本规则

- `schema` 里的主版本（`v2`）变化表示不兼容。v2 内部的新增都必须兼容：新增可选字段、新增检查类型、新增 `task.kind`。
- 文档里可以写 `schema_minor`（整数，默认 0），表示用到了哪个小版本的特性。平台遇到比自己新的小版本时仍然尝试导入，不认识的部分按 §7.3 和 §10 处理。
- 检查类型登记表随小版本更新，记录在本文 §7.3。

## 12. 从各来源映射

### 12.1 CasePick

CasePick 的内部记录和导出都直接使用本格式，私有信息放在 `extensions["x-casepick"]`。

| 本协议 | 取值 |
| --- | --- |
| `task.kind` / `horizon` / `start` | `agent` / `next_message` / `current` |
| `task.messages` | 截止点之前的消息 |
| `task.system.status` | 通常是 `missing` |
| `task.tools.source` | `approximate`（取自扫描时的配置） |
| `task.environment.kind` | 不涉及文件时为 `none`，否则为 `unavailable` |
| `scoring`（内联） | 原要求、引文、rubric、确定性检查 |
| `diagnostic` | 原出错回复、违反的要求、用户的纠正 |
| `provenance.source` | `session`，`reference` 为会话哈希加截止点 entry ID |

### 12.2 SWE-bench 系列

| 本协议 | 取值 |
| --- | --- |
| `id` | `swe-bench-verified:<instance_id>` |
| `task.horizon` / `start` | `episode` / `original` |
| `task.instruction` | `problem_statement` |
| `task.environment` | 官方评测镜像；`workspaces: [{ "repo", "commit": base_commit }]` |
| `task.tools.source` | `environment` |
| `scoring.requirements` | 一条必过要求，`checks: [{ "type": "tests", "must_pass": FAIL_TO_PASS, "must_still_pass": PASS_TO_PASS }]` |
| `scoring.materials` | `test_patch`（评分侧，被测对象不可见） |
| `diagnostic` | 不填；参考补丁 `patch` 不进入任何被测对象可见的位置 |
| `provenance.source.benchmark` | `{ "name": "swe-bench-verified", "version", "instance_id" }` |

### 12.3 Terminal-Bench

| 本协议 | 取值 |
| --- | --- |
| `task.horizon` / `start` | `episode` / `original` |
| `task.instruction` | 任务描述中的 `instruction` |
| `task.environment` | 任务目录中的 Dockerfile 构建为 `image.build` |
| `task.tools.source` | `environment`（终端） |
| `task.max_steps`、`environment.resources.timeout_s` | 取自任务配置 |
| `scoring.requirements` | 一条必过要求，`checks: [{ "type": "tests", "run": "bash run-tests.sh", "report": "pytest-json" }]` |
| `scoring.materials` | 任务的 `tests/` 目录（评分侧） |

### 12.4 旧格式迁移

| 旧格式 | 迁移方式 |
| --- | --- |
| `detroit.case/v1`（M1 导入清单） | `instruction` → `task.instruction`；`materials[role=input]` → `task.materials`，`role=scoring` → `scoring.materials`，`role=diagnostic` → `diagnostic`（作为 blob）；`acceptance.description` → 一条只有 rubric 的必过要求，`question` 需要人补；`source.usedForImprovement` → `provenance.purpose`；`missing` → `provenance.limitations`；`approvalDigest`、`sourcePath`、平台 `groupId` 丢弃 |
| `casepick.case/v1` | 见 12.1；`quality` / `judge_mode` 丢弃（可以从有没有 `checks` 推出来）；单一 `hash` 拆成 `digests.task` 和 `digests.scoring` |

## 13. 已处理的问题

起草时列出的 4 个问题，2026-10-12 用户同意按建议处理，已同步到相关文档：

1. **`unknown` 在统计中怎么处理。** 新增 `Outcome = Unknown`：不计入成功率分母，也不算失败；和 `infra_error` 一样单列展示比例，超过阈值（默认 10%）时整次 run 标为无效。见 02 §4.1、03 `EpisodeResult` / `Aggregate`、07 §1、§6。
2. **`next_message` 题在 Worker 里怎么跑。** 由轻量的对话 Worker 执行，不启动沙箱，工具调用只记录不执行。见 02 §3.5。
3. **工具定义近似的题目能不能和其他题混在一起比较。** 不阻止混用；报告按 `task.tools.source` 和 `task.system.status` 分组展示。见 07 §6 第 7 项。
4. **一道题挂多份评分时 RunSpec 怎么写。** `scorers.select: all` 或某个评分的 `label`；默认 `all`，不同评分的结果分别报告。见 03 §4。

## 14. 当前导入实现

`detroit dataset import -f <path> [--store DIR] [--base SNAPSHOT]` 支持 JSON、JSONL 和目录 bundle。
`--base` 为单独分发的评分提供已导入的题目与评分；未提供评测集文档时按合并后的内容生成评测集。
JSON 重复键、非法 Unicode、结构未知字段和摘要不符均拒绝；未知检查类型按 §10 警告保留。
本实现尚不接受 YAML；可先无损转换为 JSON。

导入返回 `dataset_digest`（协议版本）与 `snapshot`（本地完整快照摘要），后者同时固定来源、诊断、
扩展字段和用途冲突确认状态。RunSpec 使用 `source: detroit-v2`，在 `options.path` 和
`options.snapshot` 中固定快照；CLI、控制面和 Worker 共享该路径。
题目以 `digests.task` 作为唯一固定初始状态 ID。评分、权重和同源题组保留在评估侧，不进入 `Task.Input`。

验证集冲突会保存一个可检查的快照，但运行需要显式确认；确认后重新导入并加
`--confirm-validation-conflicts`。后续导入同源改进数据时，尚未显式确认的验证快照也会在加载时阻止运行。
当前已有 `next_message` 真实模型 Worker 与部分确定性评分，见 [11 模型接入](11-model-evaluation.md)。导入成功仍不代表环境可运行；多步任务和多份评分分别统计尚未接入。
