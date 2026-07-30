# ADR: Coworker 与 AITeam 通过 Mission API 集成

- 状态：已接受，Phase 0
- 日期：2026-07-29

## 背景

Coworker 负责组织、人员、任务、审批和责任归属；AITeam 负责多智能体编排、执行、预算、质量复核和成果生成。两边现有数据模型、发布节奏和故障域不同，直接合库、共享会话或 iframe 拼接都会扩大耦合与权限边界。

## 决策

采用“Coworker 控制面 + AITeam 执行面 + Mission API 契约”。

- Coworker 是 Organization、发起人和业务任务的权威来源。
- AITeam 为每个 Mission 保存执行状态和追加式事件流。
- 服务调用使用独立 HS256 JWT；密钥为 `AITEAM_SERVICE_JWT_SECRET`，不得复用 `AUTH_SECRET` 或浏览器 Cookie。
- JWT 固定校验 `iss=coworker`、`aud=aiteam`、`sub=service:coworker`、过期时间、组织和 scope。
- 所有 Mission 查询都以 JWT 中的 `organization_id` 约束；跨组织读取返回 404，避免泄露资源是否存在。
- 创建请求必须带 `Idempotency-Key`。同组织、同 key、同请求返回原 Mission（200）；同 key 不同请求返回 409。
- Mission 与首条 `mission.created` 事件在一个 SQLite 事务内写入。
- Coworker 通过 `after` 游标增量拉取事件；序列号从 1 开始、在单个 Mission 内单调递增。

## 初始范围

Phase 0 只支持 `research_report`，并提供：

- `POST /aiteam/api/v1/missions`
- `GET /aiteam/api/v1/missions/{missionId}`
- `GET /aiteam/api/v1/missions/{missionId}/events?after={sequence}`

不在本阶段实现任务投影、执行调度、成果下载、回调推送或生产部署。

## 结果

优点：

- 两个系统可以独立部署、回滚和升级。
- 组织隔离、幂等和故障恢复成为可自动验证的协议行为。
- Coworker 可以用事件游标重建投影，不依赖 AITeam 数据库结构。

代价：

- 需要管理服务密钥和轮换窗口。
- Coworker 必须保存 Mission 映射与最后消费序列。
- 事件 schema 变更必须保持向后兼容。

## 后续门槛

进入 Phase 1 前，需通过 Mission API 集成回归、完整 typecheck/build，并由 OpenAPI 文档与实现保持一致。进入生产灰度前，还需完成密钥轮换、持久化投影、执行恢复和真实研究报告闭环。

Phase 1 的执行映射、报告产物和恢复决策见
[`ADR-coworker-mission-execution.md`](./ADR-coworker-mission-execution.md)。
