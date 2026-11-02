#!/usr/bin/env bash
# Real HTTP check of the reminder endpoints against a DISPOSABLE Postgres (localhost:55432)
# and a locally built server on port 3999. Never touches the dev EHR (3001) or production.
# Tokens are created in the throwaway database and never printed.
set -u
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://clinic:clinic@localhost:55432/soap_ehr_test"
export API_DRY_RUN=false PORT=3999 APP_URL=http://localhost:3999
BASE=http://localhost:3999
PSQL=(docker exec soap-ehr-reminders-test psql -q -U clinic -d soap_ehr_test -tA -c)

pnpm -s react-router build >/dev/null 2>&1 || { echo "build falhou"; exit 1; }
node_modules/.bin/react-router-serve ./build/server/index.js >"${TMPDIR:-/tmp}/ehr-http-check.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/openapi.json" && break; sleep 1; done

USER_ID=$("${PSQL[@]}" "insert into \"AuthUser\" (full_name, crm, crm_uf, updated_at) values ('Check HTTP','999','BA',now()) returning id")
mk() { node --env-file-if-exists=/dev/null --import tsx scripts/create-token.ts --userId "$USER_ID" --scope "$1" 2>/dev/null | awk '/^Token$/{getline; print}'; }
FULL=$(mk full); NARROW=$(mk reminders)

PID=$("${PSQL[@]}" "insert into \"Patient\" (name, gender, active, updated_at) values ('Beatriz Nogueira Prado','unknown',true,now()) returning id")
"${PSQL[@]}" "insert into \"ContactPoint\" (system, value, patient_id, updated_at) values ('phone','(71) 99999-1234',$PID,now())" >/dev/null 2>&1
AID=$("${PSQL[@]}" "insert into \"Appointment\" (patient_id, start, \"end\", status, appointment_type, updated_at) values ($PID,'2030-01-08T11:00:00Z','2030-01-08T12:00:00Z','booked','routine',now()) returning id")

code() { curl -s -o "${TMPDIR:-/tmp}/ehr-body.json" -w "%{http_code}" "$@"; }
body() { head -c 200 "${TMPDIR:-/tmp}/ehr-body.json" | tr -d '\n '; echo; }
show() { printf "%-62s %s\n" "$1" "$2"; }
[ -n "$AID" ] && [ -n "$USER_ID" ] && [ -n "$FULL" ] && [ -n "$NARROW" ] || { echo "preparo falhou (AID=$AID USER_ID=$USER_ID)"; exit 1; }

show "feed sem token" "$(code "$BASE/api/reminders/appointments?date=2030-01-08")"
show "feed com token reminders" "$(code -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments?date=2030-01-08")"
python3 - <<PY
import json
d = json.load(open("${TMPDIR:-/tmp}/ehr-body.json"))
a = d["appointments"][0]
print("   ->", {"id": a["id"], "confirmation": a["confirmation"], "firstName": a["patient"]["firstName"], "phone": a["patient"]["phone"][:4] + "…"}, "skipped", d["skipped"])
PY
show "token reminders lendo /fhir/Patient (deve ser 401)" "$(code -H "Authorization: Bearer $NARROW" "$BASE/fhir/Patient")"
show "token reminders lendo /fhir/Appointment (deve ser 401)" "$(code -H "Authorization: Bearer $NARROW" "$BASE/fhir/Appointment")"
show "token full lendo /fhir/Patient (deve ser 200)" "$(code -H "Authorization: Bearer $FULL" "$BASE/fhir/Patient")"
show "resposta sem token" "$(code -X POST "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"confirmed"}')"
show "resposta invalida" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"talvez"}')"
show "confirmo" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"confirmed"}')"
show "confirmo de novo (noop)" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"confirmed"}')"; body
show "nao vou" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"declined"}')"; body
show "reconfirmar depois de cancelar (409)" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response" -d '{"response":"confirmed"}')"
show "id inexistente (404)" "$(code -X POST -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/999999/response" -d '{"response":"confirmed"}')"
show "GET na rota de resposta (405)" "$(code -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments/$AID/response")"
show "feed depois do cancelamento" "$(code -H "Authorization: Bearer $NARROW" "$BASE/api/reminders/appointments?date=2030-01-08")"; python3 -c "import json;d=json.load(open('${TMPDIR:-/tmp}/ehr-body.json'));print('   -> consultas:',len(d['appointments']),'skipped',d['skipped'])"

echo "--- banco:"; "${PSQL[@]}" "select status, confirmation_status, confirmation_at is not null from \"Appointment\" where id=$AID"
echo "--- auditoria (so metadados):"; "${PSQL[@]}" "select action, metadata::text from \"AuditLog\" where user_id=$USER_ID and category in ('appointment','reminder') order by id"

"${PSQL[@]}" "delete from \"AuditLog\" where user_id=$USER_ID; delete from \"Appointment\" where id=$AID; delete from \"ContactPoint\" where patient_id=$PID; delete from \"Patient\" where id=$PID; delete from \"AuthToken\" where user_id=$USER_ID; delete from \"AuthUser\" where id=$USER_ID" >/dev/null
echo "--- limpeza ok"
