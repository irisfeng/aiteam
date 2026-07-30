# ADR: Coworker 研究 Mission 使用 AITeam 原生执行引擎

- 状态：已接受，Phase 1
- 日期：2026-07-30

## 背景

Phase 0 只证明了组织隔离、服务认证、幂等创建和事件回放，Mission 会停留在
`queued`。这不能证明“研究报告”已经落地，也没有给 Coworker 可验收的成果。

AITeam 已有按用户隔离的多智能体任务、依赖调度、独立复核、返工、文档版本和
重启恢复能力。新建另一套 Mission worker 会重复这些机制并产生两套质量语义。

## 决策

`research_report` Mission 映射到发起人的 AITeam 私有执行工作区：

1. 使用 Coworker `requested_by` 建立 `user:<id>` owner 上下文。
2. 幂等播种该 owner 的默认团队和频道。
3. 创建一个 AITeam Project，并建立“口径→资料→对比→报告”的四任务 DAG。
4. 每个任务使用现有负责人、独立 reviewer、质量门、返工和文档版本机制。
5. `mission_executions` 只保存 Mission 与 Project/Task 的内部映射。
6. Mission 查询或事件同步时，从执行真相收敛状态并追加
   `mission.started|blocked|completed|failed|cancelled` 事件。
7. `mission.completed` 必须已有最终报告；真实执行还必须有通过的最终机器
   裁决，或由 AITeam 人工执行 `done` 覆盖。事件 payload 给出
   `final_artifact_id`、`quality_gate` 和最终裁决标识。机器裁决未通过或缺失
   时 Mission 进入 `blocked`，不会伪装成已完成。
8. Coworker 通过组织范围内的 `/artifacts` 端点读取成果；不能直接访问
   AITeam 数据库或用户工作区。

## 故障与恢复

- Mission 与 `mission.created` 仍在同一事务中写入。
- 如果进程在创建 Mission 后、建立执行映射前退出，下一次 GET/事件同步会
  幂等补建执行。
- Project、四个 Task 与 `mission_executions` 映射在同一事务中提交，失败时
  不留下没有映射的孤儿 Project。
- 如果事务已提交但进程在把首个 Task 放入内存执行队列前退出，下一次
  GET/事件同步会重新调度尚未失败且依赖已满足的 `todo` Task。
- AITeam 原有重启恢复会重新启动 `doing` 任务；Mission 状态由持久化 Task、
  Event 和 Document 重新计算。
- 同组织同幂等键重放不会新建第二个 Project 或第二组任务。
- 执行初始化或检查失败会进入 `failed` 并留下可重放事件，不静默卡在 queued。
- Mission 与首事件写入前，以 SQLite 立即事务检查组织和单实例活跃容量；
  `queued/running/blocked` 占用名额，终态和已收口超时释放名额。相同幂等键
  重放先于容量检查，超限的新请求返回
  `429 / MISSION_CAPACITY_EXCEEDED` 且不留下半成品。

## 边界

- AITeam 的 `completed` 只表示执行引擎已交付并通过其复核；Coworker 将其映射
  为 `awaiting_acceptance`，最终业务完成仍需要人在 Coworker 确认。
- Mock 模式没有真实机器裁决，仍允许用于契约和 UAT，但完成事件明确标注
  `quality_gate=mock_skipped`，不得提升为真实质量证明。
- Mock 模式只证明流程、持久化和状态契约，产物明确标记为演示内容；真实研究
  质量仍需配置模型与联网能力后单独验收。
