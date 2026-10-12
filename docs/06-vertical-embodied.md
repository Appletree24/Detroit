# 06 具身垂类

## 1. 范围

在物理仿真中评测机器人操作策略（以 VLA 为主）：给定语言指令和视觉观测，策略输出动作，仿真器判定任务成败。

首期只做 **桌面操作 + MuJoCo 系仿真**（LIBERO 及其扰动版本），原因：

- 不依赖 RTX 显卡（Isaac Sim 系工具需要 RTX，数据中心卡如 A100/H100 不支持）。
- 有公开 checkpoint 和公开分数可供复现对齐。
- 社区已有通过 gym 接口统一的环境封装（LeRobot），可直接集成。

## 2. 任务集

### 2.1 LIBERO（标定用）
四个标准 suite：`libero_spatial`、`libero_object`、`libero_goal`、`libero_10`，每个 suite 10 个任务，每个任务有固定的初始状态集合。

**用途是标定，不是排名**：顶级 VLA 在 LIBERO 上的平均成功率已在 96%~98%，区分度很低。Detroit 用它来证明"我们的评测管线跑出来的数和公开数一致"。

### 2.2 扰动集（真正的评测）
LIBERO-Plus / LIBERO-PRO 一类工作表明，在原版上接近满分的模型，在物体位置变化、相机偏移、指令改写等扰动下可能大幅下降。Detroit 将扰动建模为 `Variant`：

| 轴 | 示例 | 实现方式 |
|---|---|---|
| camera | 视角偏移 5°/15°/30° | 修改仿真相机外参 |
| lighting | 亮度 ×0.5 / ×1.5、光源方向 | 修改仿真光照 |
| layout | 目标物体位置扰动、新增干扰物 | 修改初始状态生成 |
| language | 指令同义改写、语序变化 | 预生成并人工抽检的改写集 |
| sensor_noise | 本体状态加高斯噪声 | Worker 侧注入 |

优先直接使用 LIBERO-Plus / LIBERO-PRO 已发布的扰动配置，自定义扰动作为补充。

## 3. 被测对象

| Subject | 接入方式 | 说明 |
|---|---|---|
| SmolVLA | LeRobot 策略，Detroit 内置适配器 | 体量小，单张消费级显卡可跑，用于开发联调 |
| pi0.5 (LIBERO 微调版) | openpi 推理服务 + 协议转换适配器 | 主要标定对象 |
| OpenVLA-OFT 等 | 视资源情况追加 | 可选 |

## 4. 执行细节（影响结果正确性的坑）

这些细节决定"复现出来的分数是否和公开值一致"，必须写进 RunSpec 并记录到 manifest：

1. **初始状态**：使用 benchmark 提供的固定初始状态，按编号遍历，不随机采样。
2. **步数上限**：按 suite 设置，与公开评测脚本一致。
3. **前若干步空动作**：等待物体在仿真中落稳，与公开脚本一致。
4. **图像预处理**：分辨率、是否翻转、是否旋转必须与训练数据一致。
5. **动作块执行步数**（replan_steps）：与公开配置一致。
6. **夹爪动作的二值化与符号约定**。

标定流程：先用公开 checkpoint 跑全量 → 与公开值比较 → 若差值超出 95% 置信区间，逐项排查以上 6 点。**排查记录本身就是项目文档的一部分**（`results/calibration-log.md`）。

## 5. 子目标谓词（部分得分与归因基础）

把每个任务拆为有序子目标，由仿真器状态判定：

```yaml
task: "put the black bowl on the plate"
subgoals:
  - name: approach   # 末端执行器距目标物 < 5cm
  - name: grasp      # 夹爪闭合且目标物在两指之间
  - name: lift       # 目标物离开桌面 > 3cm
  - name: transport  # 目标物在放置区域上方
  - name: place      # 目标物与放置区域接触且夹爪张开
```

子目标进度 = 已达成的最远子目标 / 总数。它让"失败"变得可分析：卡在 grasp 和卡在 place 是完全不同的问题。

对 LIBERO 中定义为 BDDL 谓词的任务，优先复用其谓词；通用子目标（approach / grasp / lift）以几何规则实现。

## 6. 失败分类体系（taxonomy.yaml 初版）

```yaml
embodied_failures:
  - wrong_object        # 抓了非目标物体
  - grasp_miss          # 接近目标但未抓住 / 空抓
  - drop_during_transport
  - place_inaccurate    # 放置位置偏差
  - stall               # 长时间无进展、原地抖动
  - no_recovery         # 失误后未尝试恢复
  - collision           # 与环境发生明显碰撞
  - instruction_misread # 执行了与指令不符的任务
  - timeout             # 到达步数上限
```

打标流程：

1. **规则层**：子目标谓词 + 状态序列直接判定 `grasp_miss`、`drop_during_transport`、`timeout`、`wrong_object`。
2. **VLM 层**：对规则无法确定的失败，把 rollout 视频关键帧 + 指令 + 子目标轨迹交给 VLM，按 taxonomy 输出标签与理由。
3. **人工层**：抽样复核，用于校准 VLM Judge（见 07 §3）。

VLM Judge 与 Agent 垂类的 LLM Judge 共用 `internal/analyze` 中的调用、重试、解析、校准代码，只有提示词与 taxonomy 不同。

## 7. 仿真-真机相关性（方法论，不在首期实现）

仿真评测的价值在于**排序是否与真机一致**，而不是绝对成功率是否一致。公开工作通常用 Pearson 相关系数和 MMRV（平均最大排序违例）衡量这一点。

Detroit 首期没有真机，但在报告中：

- 明确标注"仿真结果，未经真机验证"。
- 提供相关性计算模块（`internal/stats/correlation.go`），输入两组按策略配对的成功率，输出 Pearson、Spearman、MMRV，为后续接入真机数据留好接口。

## 8. 首期交付物

1. pi0.5 在 LIBERO 四个 suite 上的复现结果（附置信区间、标定记录）。
2. 同一模型在扰动集上的成功率与下降幅度（按扰动轴分组）。
3. 失败分布：base 与各扰动下，各失败类型占比的变化。
4. 吞吐报告：单机下不同并行度的 env_steps/sec 与瓶颈分析。
