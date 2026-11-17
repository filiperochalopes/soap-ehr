import { writeAuditLog } from "~/lib/audit.server";
import { requireApiScope } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { handleMcpRequest, type McpRequestDeps } from "~/lib/mcp/handler.server";
import { prismaPatientLookup } from "~/lib/mcp/patient-lookup.server";
import { prismaAgenda, prismaRecords } from "~/lib/mcp/records.server";
import { prisma } from "~/lib/prisma.server";
import { getUiTimeZone } from "~/lib/settings.server";

/**
 * POST /mcp: the read-only, de-identified MCP server for external agents (see docs/mcp.md).
 * Only a token with the `agent` scope gets in; `full` does not. The rules live in
 * `handleMcpRequest`; this file only wires the real auth, repositories, time zone and audit log.
 */
const deps: McpRequestDeps = {
  authenticate: (request) => requireApiScope(request, "agent"),
  lookup: prismaPatientLookup,
  records: prismaRecords,
  agenda: prismaAgenda,
  timeZone: getUiTimeZone,
  audit: async ({ durationMs, patientId, results, tokenId, tool, userId }) => {
    if (env.API_DRY_RUN) {
      return;
    }

    await writeAuditLog(prisma, {
      action: `mcp.tool.${tool}`,
      category: "mcp",
      entityId: patientId === undefined ? null : String(patientId),
      entityType: patientId === undefined ? null : "Patient",
      metadata: { durationMs, results, tokenId },
      userId,
    });
  },
};

export async function loader({ request }: { request: Request }) {
  return handleMcpRequest(request, deps);
}

export async function action({ request }: { request: Request }) {
  return handleMcpRequest(request, deps);
}
