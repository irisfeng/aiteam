# AITeam 天翼云隔离灰度运行手册

本手册只覆盖共享 VPS 上的**空库、Mock、无公网入口**灰度。它不会修改
Coworker、Nginx/Caddy、systemd、Docker daemon、防火墙或安全组，也不会迁移生产数据。

## 当前边界

| 层级 | 状态 | 证明 |
| --- | --- | --- |
| 本地代码 | 可验证 | Dockerfile、live/ready、Compose、回归脚本 |
| 已提交代码 | 未执行 | 需要独立 commit |
| 远端 PR | 未执行 | 需要单独授权第三个 Draft PR |
| VPS 镜像 | 未执行 | 需要只读盘点和构建授权 |
| VPS 灰度容器 | 未执行 | 只允许回环端口和独立网络 |
| Coworker 联调 | 未执行 | 需要单独重建 Coworker gray |
| 生产流量 | 禁止 | 本阶段不设置公网入口、不切流 |

## 运行约束

- 源码必须来自远端已确认的不可变 release SHA。
- `AITEAM_NODE_IMAGE` 在 VPS 构建前必须替换为已验证的上游 digest，不得只依赖可变 tag。
- 构建前必须完成获授权的在线依赖/镜像漏洞扫描；critical/high 未处置时不得进入 VPS。
- 数据目录与 secrets 文件必须是本灰度实例专用；数据目录归属 UID/GID `10001`。
- secrets 文件权限为 `0600`，不得进入 Git、命令行参数、日志或交付报告。
- 首轮保持 `ANTHROPIC_API_KEY` 为空，以 Mock 验证运行时和跨服务契约。
- 宿主机只发布 `127.0.0.1:18787`；Docker 网络内使用
  `http://aiteam-gray:8787`。
- `AUTH_SECRET` 必须与 Coworker gray 一致；
  `AITEAM_SERVICE_JWT_SECRET` 也必须两边一致，但不得复用 `AUTH_SECRET`。
- `AITEAM_CREDENTIAL_KEY` 是持久数据的一部分；备份/恢复时必须保持不变。

## 1. 部署前只读门禁

先按 `production-vps-staged-migration` 完成并保存时间戳基线，至少确认：

- `coworker-web`、`funasr-realtime` 的容器 ID、镜像、启动时间、重启次数和健康状态；
- 当前监听端口、Docker 网络、磁盘/内存/负载；
- `/srv/aiteam-gray` 不与现有服务目录、volume 或 Compose project 重名；
- `127.0.0.1:18787` 未占用；
- 恢复路径和主机/应用备份证据存在。

任一现有容器出现不明重启、监听变化或资源回退时停止。

## 2. 主机目录与配置

以下为计划命令，尚未在 VPS 执行：

```bash
sudo install -d -o root -g root -m 0750 /srv/aiteam-gray
sudo install -d -o 10001 -g 10001 -m 0700 /srv/aiteam-gray/data
sudo install -d -o root -g root -m 0700 /srv/aiteam-gray/secrets
sudo install -o root -g root -m 0600 /dev/null /srv/aiteam-gray/secrets/aiteam.env
```

将 `aiteam-gray.operator.env.example` 复制为主机 root-only operator env，并填写：

- 已固定的 AITeam release SHA；
- 同 SHA 的不可变本地镜像 tag；
- 已验证 digest 的 Node 基础镜像；
- 专用数据、secrets 和网络路径。

将 `aiteam-gray.secrets.env.example` 的变量写入
`/srv/aiteam-gray/secrets/aiteam.env`。只报告变量是否存在，不输出值。

## 3. 构建与配置验证

从 pinned worktree 执行：

```bash
docker compose \
  --env-file /srv/aiteam-gray/operator.env \
  -f deploy/compose.aiteam-gray.yaml \
  config --quiet

docker compose \
  --env-file /srv/aiteam-gray/operator.env \
  -f deploy/compose.aiteam-gray.yaml \
  build --pull aiteam-gray
```

构建后记录：

```bash
docker image inspect local/aiteam:<release-sha> \
  --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

release label 和镜像内 `/app/RELEASE_SHA` 必须与 pinned SHA 完全一致；容器入口会再与
Compose 的 `AITEAM_EXPECTED_RELEASE_SHA` 比对，不一致时拒绝启动。不得把 secrets
写进 image history。

## 4. 只启动命名灰度服务

```bash
docker compose \
  --env-file /srv/aiteam-gray/operator.env \
  -f deploy/compose.aiteam-gray.yaml \
  up -d --no-deps aiteam-gray
```

验证：

```bash
curl --fail --silent http://127.0.0.1:18787/aiteam/api/healthz
curl --fail --silent http://127.0.0.1:18787/aiteam/api/readyz
docker inspect aiteam-gray \
  --format '{{.State.Health.Status}} restarts={{.RestartCount}} readonly={{.HostConfig.ReadonlyRootfs}}'
docker inspect aiteam-gray \
  --format 'memory={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}'
docker exec aiteam-gray node scripts/gray-data-audit.mjs
ss -ltnp
```

必须证明：

- live/ready 都返回预期 release SHA；
- `model_mode=mock`、SQLite `database=ok`；
- 数据审计返回 `integrity=ok`、`journal_mode=wal`，除系统 `skills` 种子外，
  users/tasks/missions/documents/providers 等预期空表全部为 0；
- 健康状态持续为 healthy、重启次数为 0；
- 只有 `127.0.0.1:18787` 新增监听；
- 根文件系统只读、capabilities 全部移除、资源/PID/日志限制生效；
- 现有服务的容器 ID、启动时间、监听和重启次数与基线一致。

## 5. 空库观察与 Coworker 灰度联调

至少完成一个观察窗口后再联调。确认除系统种子外的用户/任务/Mission/文档/配置表
为空、迁移/完整性正常，并留存 SQLite 备份与实际恢复证据。

Coworker gray 联调是独立变更：

1. 让 Coworker gray 加入 `coworker-aiteam-gray` 网络；
2. 仅在 Coworker gray 设置
   `AITEAM_INTERNAL_URL=http://aiteam-gray:8787`；
3. 使用独立 gray `AITEAM_SERVICE_JWT_SECRET`；
4. 保持真实模型关闭，跑 Mission 创建、事件、artifact、重启幂等验收；
5. 证明 Vercel/生产 Coworker 和其他 VPS 服务均未变化。

Vercel Coworker 无法访问这个 Docker 内网地址。若要让 Vercel Preview 直连 AITeam，
必须另行审批 HTTPS 公网入口、访问控制、证书和安全组；本手册不包含该路径。

## 回滚与停止条件

停止灰度但保留数据和镜像：

```bash
docker compose \
  --env-file /srv/aiteam-gray/operator.env \
  -f deploy/compose.aiteam-gray.yaml \
  stop aiteam-gray
```

不得执行 `down -v`，不得删除 `/srv/aiteam-gray/data` 或旧镜像。出现以下任一情况立即停止：

- 现有服务重启、端口或资源出现无法解释的变化；
- ready 非 200、release SHA 不匹配、数据库完整性失败；
- 获授权的依赖/镜像扫描仍有未处置 critical/high；
- 容器产生重启、OOM、写只读根文件系统或权限错误；
- 需要修改共享 Docker daemon、Nginx、防火墙、安全组或生产 secret 才能继续；
- 需要导入生产数据或允许公网访问。
