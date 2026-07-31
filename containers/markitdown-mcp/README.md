# MarkItDown MCP production image

This image is the first concrete `safety=local` plugin for AITeam's
Mission-scoped production stdio runner. It packages Microsoft's
`markitdown-mcp` and MarkItDown converter without granting the converter host
filesystem or network access.

## Pinned inputs

- base: Python 3.12.11 slim Bookworm, selected by OCI manifest digest;
- `markitdown-mcp==0.0.1a4`;
- `markitdown==0.1.6`;
- every transitive Python dependency is exact and hash-verified in
  `requirements.lock`;
- `azure-ai-contentunderstanding==1.2.0b2` is the single additional
  prerelease explicitly selected because `markitdown[all]` requires
  `>=1.2.0b1`.

The official MCP exposes `convert_to_markdown(uri)` for `file:`, `data:`,
`http:`, and `https:` URIs. AITeam intentionally runs this image with
`--network=none` and stages only the requested upload under `/workspace`.
Remote URI conversion is therefore not a supported production path.

## Build and verify

Preload the exact base image, then build:

```bash
podman pull docker.io/library/python@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
npm run mcp:image:markitdown:build
```

The build command first validates the recipe, builds with `--pull=never`, and
then runs the resulting image with no network, a read-only filesystem, all
capabilities dropped, and a non-root UID. It emits:

- `output/markitdown-mcp-image-evidence.json`;
- `output/markitdown-mcp-image-sbom.cdx.json`.

Both files are local ignored artifacts. Archive them in the release evidence
store if the image is promoted. The evidence JSON prints the exact
`localhost/aiteam/markitdown-mcp@sha256:...` value to enter in the MCP form.

Run the real production workflow with that value:

```bash
AITEAM_MARKITDOWN_TEST_IMAGE='localhost/aiteam/markitdown-mcp@sha256:...' \
  npm run test:stdio-sandbox:markitdown-real
```

This verifies production startup, admin registration, MCP registration and
handshake, the task rehearsal, real DOCX upload/conversion/persistence, and
staged-file cleanup.

## Release boundary

The digest is architecture-specific. The local Apple Silicon proof is arm64;
an amd64 Preview host must build or import an amd64 image, generate a new SBOM
and digest, and rerun the real workflow plus the generic escape suite under
the exact service user and systemd unit. Runtime pulls remain forbidden.

Sources:

- <https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp>
- <https://github.com/microsoft/markitdown/security>
- <https://pypi.org/project/markitdown-mcp/0.0.1a4/>
