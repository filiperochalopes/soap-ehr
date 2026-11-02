import { writeAuditLog } from "~/lib/audit.server";
import { requireApiScope } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { prisma } from "~/lib/prisma.server";
import { handleReminderFeedRequest, type ReminderRequestDeps } from "~/lib/reminders.server";
import { getUiTimeZone } from "~/lib/settings.server";
import { DEFAULT_UI_TIME_ZONE } from "~/lib/utils";

/**
 * GET /api/reminders/appointments?date=YYYY-MM-DD
 *
 * Read-only feed for appointment reminders: id and time of each booked appointment of that
 * clinic-local day, plus the patient's first name and one normalised mobile number. Nothing
 * else about the patient is exposed (no CPF, birth date, e-mail or surname). Every read is
 * audited with counts only, since it hands out contact data. The rules live in
 * `handleReminderFeedRequest`; this file only wires the real auth, settings and audit log.
 */
const deps: ReminderRequestDeps = {
  authenticate: (request) => requireApiScope(request, "reminders"),
  // The dry-run store has no database behind it, so there is no settings table or audit log.
  timeZone: async () => (env.API_DRY_RUN ? DEFAULT_UI_TIME_ZONE : getUiTimeZone()),
  audit: async ({ count, date, skipped, userId }) => {
    if (env.API_DRY_RUN) {
      return;
    }

    await writeAuditLog(prisma, {
      action: "reminders.feed.read",
      category: "reminder",
      entityId: date,
      entityType: "AppointmentReminderFeed",
      metadata: { count, skipped },
      userId,
    });
  },
};

export async function loader({ request }: { request: Request }) {
  return handleReminderFeedRequest(request, deps);
}

export async function action({ request }: { request: Request }) {
  return handleReminderFeedRequest(request, deps);
}
