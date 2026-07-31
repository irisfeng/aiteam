# Preview host qualification

This runbook turns target Linux host checks into one redacted, structured gate.
It does not deploy, restart, pull an image, change systemd, open a port, or
modify a firewall.

## Profiles

| Profile | Intended stage | Required result |
|---|---|---|
| `http-only` | First AITeam Preview | Exact clean release, hardened active unit, loopback listener and healthy route, production Coworker auth, required secret keys present, stdio runner absent |
| `local-stdio` | Separately approved later gray | Everything above plus rootless Podman, cgroup v2, bounded runner resources, workspace below the data directory, and a preloaded digest image matching the host architecture and non-root image contract |

The first Preview must use `http-only`. A passing `local-stdio` report is only
host metadata and admission evidence; it does not replace the real container
escape, document conversion, restart, cleanup, pressure, or concurrency tests.

## Read-only inputs

The CLI reads:

- the exact Git commit and dirty-path count under the release directory;
- current user identity and Linux kernel/architecture;
- selected non-secret `systemctl show` properties;
- the named environment file, returning safe values and secret presence only;
- `ss -H -ltn` for the requested port;
- the loopback health route;
- for `local-stdio`, `podman info`, `podman image exists`, and
  `podman image inspect`.

It never prints environment secret values, file contents, command stderr, or
database contents. The optional evidence file is created with mode `0600`.
Its parent directory must already exist and the output path must not be a
symbolic link.
Environment files must use ordinary systemd `KEY=VALUE` lines; inline shell
expansion is not evaluated.

If a required boundary command cannot be executed or parsed, the CLI exits
non-zero and emits `QUALIFICATION_COLLECTION_FAILED` in the same redacted
`0600` evidence format instead of exposing a stack trace or command output.

## First HTTP-only Preview

Run this as the exact service user after the isolated Preview service is
active. Replace the commit with the full reviewed release SHA:

```bash
sudo -u aiteam node scripts/preview-host-qualification.mjs \
  --profile http-only \
  --service aiteam-preview.service \
  --release-dir /opt/aiteam-preview/current \
  --expected-commit 0123456789abcdef0123456789abcdef01234567 \
  --env-file /etc/aiteam/preview.env \
  --port 8787 \
  --health-url http://127.0.0.1:8787/aiteam/api/auth/me \
  --output /var/lib/aiteam-preview/evidence/host-qualification-http.json
```

Expected health status is `401` before browser authentication or `200` with a
valid local session. Any public/non-loopback listener fails the gate.

## Later local-stdio gray

This profile is allowed only after an explicit, reversible gray-stage
approval. The environment file referenced by the unit must contain the
reviewed Podman runner settings and the exact image must already be present:

```bash
sudo -u aiteam node scripts/preview-host-qualification.mjs \
  --profile local-stdio \
  --service aiteam-preview.service \
  --release-dir /opt/aiteam-preview/current \
  --expected-commit 0123456789abcdef0123456789abcdef01234567 \
  --env-file /etc/aiteam/preview.env \
  --port 8787 \
  --health-url http://127.0.0.1:8787/aiteam/api/auth/me \
  --image registry.example.internal/aiteam/markitdown-mcp@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --output /var/lib/aiteam-preview/evidence/host-qualification-local-stdio.json
```

This command does not pull the image. The image platform must equal the target
host platform and its configured user must be `65532:65532`.

## Findings-first stop table

| Finding | Risk | Required action |
|---|---|---|
| Release SHA mismatch or dirty release | Unreviewed code is running | Stop; create a clean remote-pinned release |
| Unit inactive, wrong user, missing hardening or resource limits | Cross-service impact or uncontrolled resource use | Stop; correct the isolated unit and re-qualify |
| Environment file is not `0600`, required secret is absent, or rotation keyring is malformed | Credential exposure or authentication outage | Stop; repair through the controlled secret channel |
| Listener is not loopback-only | Premature public exposure | Stop; restore loopback binding before proxy work |
| Health is not `200` or `401` | Process, route, or SQLite readiness is unproven | Stop; inspect service logs without printing secrets |
| HTTP-only profile finds a runner | First Preview exceeds the approved boundary | Stop; remove runner configuration and restart |
| Podman is rootful, not cgroup v2, or image is missing/mismatched | Sandbox and resource boundary are unproven | Keep stdio disabled |
| Workspace is outside the data directory | Host write scope is too broad | Keep stdio disabled and correct the path |

## Evidence and next gate

Record:

```bash
sha256sum /var/lib/aiteam-preview/evidence/host-qualification-http.json
systemctl show aiteam-preview.service \
  --property=ActiveState,SubState,NRestarts,ExecMainStartTimestamp
```

Do not include environment values or journal payloads in a ticket. A passing
HTTP-only report allows only the next Preview vertical-loop test. A passing
local-stdio report still requires, under the exact service user and unit:

```bash
npm run test:stdio-sandbox:real
npm run test:stdio-sandbox:markitdown-real
```

Then perform an approved service restart, verify zero unexplained restarts,
confirm workspace/container cleanup, compare unrelated-service start times and
listeners, and retain rollback to HTTP-only.
