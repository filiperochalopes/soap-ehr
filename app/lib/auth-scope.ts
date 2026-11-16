/**
 * Token scopes. Pure, no database: the rule that decides what a token may reach.
 *
 * - `full`: everything a signed-in clinician can do (the only scope that existed before),
 *   except the agent endpoint.
 * - `reminders`: only the reminder endpoints (read the minimised feed, record a patient's
 *   response). A leaked reminders token cannot read a patient record, a note or a CPF.
 * - `report`: the token of the pipeline that delivers reports: the reminder endpoints plus the
 *   rehydration endpoint (`@P<id>` -> name). It cannot read records, use the interface or reach
 *   the agent endpoint.
 * - `agent`: only `/mcp`, which answers with de-identified data. It reaches nothing else, and no
 *   other scope (`full` included) reaches `/mcp`, so a token pasted into an agent harness is not
 *   a key to the FHIR API.
 *
 * Anything that is not exactly one of these strings is denied, so a typo or a future scope
 * written by mistake never grants access by accident.
 */
export const TOKEN_SCOPES = ["full", "reminders", "report", "agent"] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** The endpoint scopes each token scope may reach. */
const REACH: Record<TokenScope, readonly TokenScope[]> = {
  full: ["full", "reminders", "report"],
  reminders: ["reminders"],
  report: ["reminders", "report"],
  agent: ["agent"],
};

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && (TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Whether a token carrying `tokenScope` may use an endpoint that requires `required`. */
export function scopeAllows(tokenScope: unknown, required: TokenScope): boolean {
  if (!isTokenScope(tokenScope)) {
    return false;
  }

  return REACH[tokenScope].includes(required);
}
