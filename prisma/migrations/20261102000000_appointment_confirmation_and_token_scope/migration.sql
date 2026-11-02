-- Reminder confirmation and token scope.
--
-- Both columns are additive and default to the previous behaviour: every existing appointment
-- is `pending` and every existing token is `full`, so nothing that works today changes.
-- The CHECK constraints keep invalid values out even if something writes around the app.

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "confirmation_at" TIMESTAMP(3),
ADD COLUMN     "confirmation_status" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_confirmation_status_check"
  CHECK ("confirmation_status" IN ('pending', 'confirmed', 'declined', 'no_response'));

-- AlterTable
ALTER TABLE "AuthToken" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_scope_check"
  CHECK ("scope" IN ('full', 'reminders'));
