/** Small pieces shared by the MCP tools. */
import { z } from "zod";

import { toDateTimeLocalValue } from "../utils";

/** A refusal the agent can act on (wrong arguments); reported as a tool error, not a server failure. */
export class ToolInputError extends Error {}

function isRealDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A calendar date as YYYY-MM-DD that exists (no 2026-02-31). */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
  .refine(isRealDate, "Data inexistente.");

/**
 * A moment as local time in the clinic's zone, `YYYY-MM-DDTHH:mm`. Every tool answers in this
 * form, with the zone name beside it (`fuso`), so "09:00" means 09:00 on the clinic's clock.
 */
export function localDateTime(value: Date | null, timeZone: string): string | null {
  return value ? toDateTimeLocalValue(value, timeZone) : null;
}
