-- Token scopes `report` and `agent`.
--
-- Only the CHECK constraint changes: it accepts two more values. No row is touched, so every
-- existing token keeps its scope. Reverting means issuing no `report` or `agent` token and
-- restoring the previous constraint (`'full', 'reminders'`).

ALTER TABLE "AuthToken" DROP CONSTRAINT "AuthToken_scope_check";

ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_scope_check"
  CHECK ("scope" IN ('full', 'reminders', 'report', 'agent'));
