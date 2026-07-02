# External Agent Adapter Contract

AiTeam may later delegate coding or local-runtime work to external agents such as Codex or Claude Code. This phase does not execute arbitrary code inside the AiTeam server process. External agents must run in an isolated runtime and report progress back through a narrow adapter.

## Goals

- Preserve AiTeam as the collaboration system of record: task owner, reviewer, activity log, approvals, deliverables, and final human close stay in AiTeam.
- Keep execution isolated: workspace, shell, network, and credentials belong to the external runtime, not the shared server process.
- Make external work observable: every meaningful step emits task activity events.
- Gate risky actions: installs, writes outside workspace, network publish, deploys, secrets access, and costs require an approval event before execution.

## Task In

```json
{
  "task_id": "task_123",
  "channel_id": "channel_123",
  "project_id": "project_123",
  "assignee_agent_id": "agent_123",
  "reviewer_agent_id": "agent_456",
  "title": "Implement feature",
  "description": "Detailed scope",
  "acceptance_criteria": "Runnable tests, documented behavior",
  "dependencies": ["task_001"],
  "source_doc_ids": ["doc_001"],
  "approval_policy": {
    "require_before": ["deploy", "external_write", "secret_access", "paid_resource"]
  }
}
```

## Runtime Out

```json
{
  "runtime_id": "codex-local-abc",
  "workspace_id": "repo-worktree-abc",
  "status": "starting|running|blocked|delivered|failed|cancelled",
  "started_at": 1780000000000,
  "updated_at": 1780000030000
}
```

## Event Stream

External agents send append-only events that map to `task_events`. The adapter translates
`metadata` (object) into the stored `metadata_json` (string) column; `created`/`claim`/`user_close`
exist in the runtime union but are emitted by AiTeam itself, not by external runtimes:

```json
{
  "task_id": "task_123",
  "runtime_id": "codex-local-abc",
  "type": "start|tool|blocked|handoff|delivery|verification|approval|failure",
  "summary": "Ran npm test",
  "metadata": {
    "tool": "shell",
    "artifact_id": "log_123",
    "approval_id": "approval_123"
  }
}
```

Rules:

- Do not include secrets, full command output, raw source dumps, or personal contact/payment data in event metadata.
- Store large logs, diffs, screenshots, and artifacts separately, then reference them by id/link.
- `blocked` must include a user-facing question or approval id.
- `delivery` must include artifact links, diff links, or document ids.

## Approval Gates

When an external agent reaches a risky action, it must pause and create an AiTeam approval:

与运行时 `Approval` 模型对齐：任务经 `ref_id` 关联（不是 `task_id` 字段），`payload` 入库为字符串
（对象由适配层序列化）：

```json
{
  "kind": "action",
  "ref_id": "task_123",
  "title": "Approve deployment to staging",
  "payload": "{\"action\":\"deploy\",\"target\":\"staging\",\"diff_summary\":\"3 files changed\",\"rollback\":\"previous deployment remains available\"}"
}
```

The runtime resumes only after AiTeam resolves the approval. Rejections must leave the task blocked or hand off a safer alternative; they must not retry the same action silently.

## Adapter Boundary

The AiTeam server may:

- create the adapter job,
- subscribe to event streams,
- persist task events,
- persist returned deliverable documents,
- resolve approvals and resume jobs,
- stop/cancel a runtime.

The AiTeam server must not:

- spawn arbitrary project commands in-process,
- mount user secrets into a shared runtime by default,
- write outside the declared workspace,
- treat external runtime success as human close.

## MVP Deferred

This contract is intentionally not implemented as a full runtime in the current phase. The desktop shell wraps existing AiTeam first. Coding sessions should be added only after the adapter has resource limits, workspace isolation, artifact storage, and approval-gated side effects.
