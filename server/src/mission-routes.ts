import { Router } from "express";
import {
  createMission,
  getMission,
  listMissionEvents,
} from "./missions.js";
import {
  requireServiceJwt,
  type ServiceRequest,
} from "./service-auth.js";
import { listMissionArtifacts } from "./mission-execution.js";

export const missionRoutes = Router();

missionRoutes.use(requireServiceJwt);
missionRoutes.post("/", (request, res) => {
  const req = request as ServiceRequest;
  const claims = req.serviceClaims;
  if (!claims?.scopes.includes("mission:create")) {
    return res.status(403).json({
      error: {
        code: "MISSION_SCOPE_FORBIDDEN",
        message: "The token does not allow mission creation",
      },
    });
  }

  const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
  const organizationId = String(req.body?.organization_id ?? "").trim();
  const kind = String(req.body?.kind ?? "").trim();
  const title = String(req.body?.title ?? "").trim();
  const brief = String(req.body?.brief ?? "").trim();
  const requestedBy = String(req.body?.requested_by ?? "").trim();
  if (organizationId && organizationId !== claims.organizationId) {
    return res.status(403).json({
      error: {
        code: "MISSION_ORGANIZATION_FORBIDDEN",
        message: "The token cannot act for this organization",
      },
    });
  }
  if (
    !idempotencyKey ||
    idempotencyKey.length > 160 ||
    !organizationId ||
    kind !== "research_report" ||
    !title ||
    !brief ||
    !requestedBy
  ) {
    return res.status(400).json({
      error: {
        code: "MISSION_REQUEST_INVALID",
        message: "The mission request is invalid",
      },
    });
  }

  const result = createMission(
    {
      organization_id: organizationId,
      kind,
      title,
      brief,
      requested_by: requestedBy,
    },
    idempotencyKey,
  );
  if (result.outcome === "conflict") {
    return res.status(409).json({
      error: {
        code: "MISSION_IDEMPOTENCY_CONFLICT",
        message: "The idempotency key was already used for another request",
      },
    });
  }
  return res
    .status(result.outcome === "created" ? 201 : 200)
    .json({ data: result.mission });
});

missionRoutes.get("/:missionId", (request, res) => {
  const req = request as ServiceRequest;
  const claims = req.serviceClaims;
  if (!claims?.scopes.includes("mission:read")) {
    return res.status(403).json({
      error: {
        code: "MISSION_SCOPE_FORBIDDEN",
        message: "The token does not allow mission reads",
      },
    });
  }
  const mission = getMission(claims.organizationId, req.params.missionId);
  if (!mission) {
    return res.status(404).json({
      error: {
        code: "MISSION_NOT_FOUND",
        message: "Mission not found",
      },
    });
  }
  return res.json({ data: mission });
});

missionRoutes.get("/:missionId/events", (request, res) => {
  const req = request as ServiceRequest;
  const claims = req.serviceClaims;
  if (!claims?.scopes.includes("mission:read")) {
    return res.status(403).json({
      error: {
        code: "MISSION_SCOPE_FORBIDDEN",
        message: "The token does not allow mission event reads",
      },
    });
  }
  const mission = getMission(claims.organizationId, req.params.missionId);
  if (!mission) {
    return res.status(404).json({
      error: {
        code: "MISSION_NOT_FOUND",
        message: "Mission not found",
      },
    });
  }
  const after = Number(req.query.after ?? 0);
  const requestedLimit = Number(req.query.limit ?? 100);
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1
  ) {
    return res.status(400).json({
      error: {
        code: "MISSION_EVENT_CURSOR_INVALID",
        message: "Event cursor parameters are invalid",
      },
    });
  }
  const events = listMissionEvents(
    claims.organizationId,
    mission.id,
    after,
    Math.min(requestedLimit, 500),
  );
  return res.json({
    data: events,
    next_after: events.at(-1)?.sequence ?? after,
  });
});

missionRoutes.get("/:missionId/artifacts", (request, res) => {
  const req = request as ServiceRequest;
  const claims = req.serviceClaims;
  if (!claims?.scopes.includes("mission:read")) {
    return res.status(403).json({
      error: {
        code: "MISSION_SCOPE_FORBIDDEN",
        message: "The token does not allow mission artifact reads",
      },
    });
  }
  const mission = getMission(claims.organizationId, req.params.missionId);
  if (!mission) {
    return res.status(404).json({
      error: {
        code: "MISSION_NOT_FOUND",
        message: "Mission not found",
      },
    });
  }
  return res.json({ data: listMissionArtifacts(mission) });
});
