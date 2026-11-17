import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer, type McpServerDeps, type McpToolAudit } from "./server";

export type McpAuditEntry = McpToolAudit & { tokenId: number; userId: number };

/** What the HTTP handler needs from the outside; the route wires the real ones. */
export type McpRequestDeps = {
  /** Throws a Response (401) unless the caller holds a token that may reach `/mcp`. */
  authenticate: (request: Request) => Promise<{ tokenId: number; user: { id: number } }>;
  audit: (entry: McpAuditEntry) => Promise<void>;
  now?: () => Date;
} & Pick<McpServerDeps, "agenda" | "lookup" | "records" | "timeZone">;

/**
 * POST /mcp: the Streamable HTTP transport of the MCP, stateless (one server per request, JSON
 * answers). GET would open a server-push stream, which a stateless read-only server never needs.
 */
export async function handleMcpRequest(request: Request, deps: McpRequestDeps): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed", message: "Use POST." },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const auth = await deps.authenticate(request);

  const server = createMcpServer({
    agenda: deps.agenda,
    lookup: deps.lookup,
    records: deps.records,
    timeZone: deps.timeZone,
    audit: (entry) => deps.audit({ ...entry, tokenId: auth.tokenId, userId: auth.user.id }),
    now: deps.now ?? (() => new Date()),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
