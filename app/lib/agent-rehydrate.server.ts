/**
 * POST /api/agent/rehydrate  body: {"texto": "...@P42..."}
 *
 * Turns the `@P<id>` mentions of a finished report into "Full Name (age)". It is called by the step
 * that delivers the report (a script, a cron, n8n), never by the agent: the answer carries names,
 * so it must not go back to a model. For that reason it is not an MCP tool and the `agent` token
 * cannot reach it (it needs `report`).
 *
 * The rules live here with injected dependencies, as in reminders.server.ts; the route only wires
 * the real authentication, patient lookup, time zone and audit log.
 */
import { RehydrateInputError, rehydrateMentions, type RehydrationLookup } from "~/lib/privacy/rehydrate";

export const MAX_TEXT_CHARS = 200_000;
export const MAX_BODY_BYTES = 1_000_000;

/** Counts only. The audit trail must never hold the text or a name. */
export type RehydrateAuditEntry = {
  tokenId: number;
  userId: number;
  mentions: number;
  notFound: number;
  characters: number;
};

export type RehydrateRequestDeps = {
  /** Throws a Response (401) unless the caller holds a token that may reach this endpoint. */
  authenticate: (request: Request) => Promise<{ tokenId: number; user: { id: number } }>;
  find: RehydrationLookup;
  audit: (entry: RehydrateAuditEntry) => Promise<void>;
  /** The clinic's time zone: a patient's age changes on the clinic's day. */
  timeZone: () => Promise<string>;
  now?: () => Date;
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function handleRehydrateRequest(request: Request, deps: RehydrateRequestDeps): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405, { Allow: "POST" });
  }

  const auth = await deps.authenticate(request);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", message: "Body too large." }, 413);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", message: "Body too large." }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", message: "The body must be JSON." }, 400);
  }
  const text = body && typeof body === "object" ? (body as Record<string, unknown>).texto : undefined;
  if (typeof text !== "string") {
    return json({ error: "invalid_body", message: 'Send {"texto": "..."} with a string.' }, 400);
  }
  if (text.length > MAX_TEXT_CHARS) {
    return json({ error: "payload_too_large", message: `"texto" has more than ${MAX_TEXT_CHARS} characters.` }, 413);
  }

  let result;
  try {
    result = await rehydrateMentions(text, deps.find, {
      now: (deps.now ?? (() => new Date()))(),
      timeZone: await deps.timeZone(),
    });
  } catch (error) {
    if (error instanceof RehydrateInputError) {
      return json({ error: "too_many_mentions", message: error.message }, 400);
    }
    throw error;
  }

  await deps.audit({
    tokenId: auth.tokenId,
    userId: auth.user.id,
    mentions: result.mencoes,
    notFound: result.nao_encontradas.length,
    characters: text.length,
  });

  return json(result);
}
