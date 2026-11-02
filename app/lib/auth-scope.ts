/**
 * Token scopes. Pure, no database: the rule that decides what a token may reach.
 *
 * - `full`: everything a signed-in clinician can do (the only scope that existed before).
 * - `reminders`: only the reminder endpoints (read the minimised feed, record a patient's
 *   response). A leaked reminders token cannot read a patient record, a note or a CPF.
 *
 * Anything that is not exactly one of these strings is denied, so a typo or a future scope
 * written by mistake never grants access by accident.
 */
export const TOKEN_SCOPES = ["full", "reminders"] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && (TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Whether a token carrying `tokenScope` may use an endpoint that requires `required`. */
export function scopeAllows(tokenScope: unknown, required: TokenScope): boolean {
  if (!isTokenScope(tokenScope)) {
    return false;
  }

  return tokenScope === "full" || tokenScope === required;
}
