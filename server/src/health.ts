import { Router } from "express";

export interface RuntimeHealthDependencies {
  databaseProbe: () => void;
  modelMode: () => "mock" | "provider";
}

function releaseSha(): string {
  return process.env.AITEAM_RELEASE_SHA?.trim() || "unknown";
}

function authMode(): string {
  return process.env.AITEAM_AUTH_MODE?.trim() || "standalone";
}

export function createHealthRoutes(
  dependencies: RuntimeHealthDependencies,
): Router {
  const router = Router();
  const startedAt = Date.now();
  const common = () => ({
    service: "aiteam",
    release_sha: releaseSha(),
    uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  });

  router.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      ...common(),
    });
  });

  router.get("/readyz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      dependencies.databaseProbe();
      res.json({
        status: "ready",
        ...common(),
        checks: {
          database: "ok",
          auth_mode: authMode(),
          model_mode: dependencies.modelMode(),
        },
      });
    } catch {
      res.status(503).json({
        status: "not_ready",
        ...common(),
        checks: {
          database: "error",
          auth_mode: authMode(),
          model_mode: dependencies.modelMode(),
        },
      });
    }
  });

  return router;
}
