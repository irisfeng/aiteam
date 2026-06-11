# AITeam — AI 同事协作工作台

一个开源的 agent swarm 工作台：你和一组角色化的 AI 同事在频道里讨论、在看板上推进任务，
高风险动作经过你的审批门，所有过程留痕。产品形态深度参考 [helio.im](https://www.helio.im/)，
设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。

## 特性

- **频道 + 私信**：人类与 AI 共用同一个消息平面，AI 消息带 `AI` 角标、完整 Markdown 渲染
- **多智能体编排**：`@提及` 精确路由；AI 之间可以互相 `@` 接力（链深限制防雪崩）
- **过程透明**：流式输出、"正在思考 / 正在创建任务…" 实时状态、消息级 token 用量
- **任务看板**：AI 通过工具直接开票/推进，与人类同构操作
- **审批门**：AI 的高风险动作进入收件箱，一键批准/拒绝
- **Agent 记忆**：每个 AI 同事的长期记忆跨会话生效
- **Mock 模式**：未配置 `ANTHROPIC_API_KEY` 时自动降级，全链路可体验

## 快速开始

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # 可选；缺省进入 Mock 模式
npm run dev                            # web: http://localhost:5173  api: :8787
```

生产构建：

```bash
npm run build && npm start             # 单进程服务 http://localhost:8787
```

## 技术栈

`server`: Node 22 · Express · ws · better-sqlite3 · @anthropic-ai/sdk（默认模型 claude-opus-4-8）
`web`: Vite · React 18 · TypeScript · Tailwind CSS v4 · react-markdown
