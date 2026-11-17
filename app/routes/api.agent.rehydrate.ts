import { handleRehydrateRequest, type RehydrateRequestDeps } from "~/lib/agent-rehydrate.server";
import { writeAuditLog } from "~/lib/audit.server";
import { requireApiScope } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { findCurrentPatient } from "~/lib/mcp/patient-lookup.server";
import { prisma } from "~/lib/prisma.server";
import { getUiTimeZone } from "~/lib/settings.server";

/**
 * POST /api/agent/rehydrate: `@P<id>` -> "Full Name (age)" in a finished agent report (see
 * docs/mcp.md). Needs a `report` token; the `agent` token of the MCP cannot reach it, because the
 * answer has names and must never go back to a model. The rules live in `handleRehydrateRequest`;
 * this file only wires the real auth, patient lookup, time zone and audit log.
 */
const deps: RehydrateRequestDeps = {
  authenticate: (request) => requireApiScope(request, "report"),
  find: (patientId) => findCurrentPatient(patientId),
  timeZone: getUiTimeZone,
  audit: async ({ characters, mentions, notFound, tokenId, userId }) => {
    if (env.API_DRY_RUN) {
      return;
    }

    await writeAuditLog(prisma, {
      action: "agent.rehydrate",
      category: "agent",
      metadata: { characters, mentions, notFound, tokenId },
      userId,
    });
  },
};

export async function action({ request }: { request: Request }) {
  return handleRehydrateRequest(request, deps);
}

export async function loader({ request }: { request: Request }) {
  return handleRehydrateRequest(request, deps);
}
