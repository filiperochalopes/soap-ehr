/**
 * `listar_agenda`: the appointments of one day, each with the patient as an agent sees them.
 *
 * Appointment fields are an allow-list (the mapping in `listAgenda`): an appointment has no free
 * text today, and a future column would not reach the agent unless it is added there on purpose.
 */
import { getDayRangeForTimeZone } from "../../utils";
import { dateString, localDateTime } from "../shared";
import { toAgentPatientWithHistory, type AgentPatientWithHistory, type PatientLookupRepo } from "./localizar-paciente";

export type AgendaAppointment = {
  id: number;
  start: Date;
  end: Date;
  status: string;
  appointmentType: string;
  confirmationStatus: string;
  patientId: number;
};

export type AgendaRepo = {
  /** Appointments that start between `start` and `end` (both included), oldest first. */
  appointmentsBetween: (start: Date, end: Date) => Promise<AgendaAppointment[]>;
};

export const listAgendaShape = {
  data: dateString.describe("Dia da agenda, AAAA-MM-DD, no fuso do consultório."),
};

export const LIST_AGENDA_DESCRIPTION =
  "Lista as consultas de um dia (`data`, AAAA-MM-DD, no fuso do consultório, devolvido em `fuso`), da mais cedo para " +
  "a mais tarde: horário local de início e fim, tipo, status e a resposta do paciente ao lembrete (`confirmacao`). " +
  "Cada consulta traz o paciente como id, menção @P<id>, iniciais, idade e sexo, mais o total de registros e a " +
  "data/hora do último; nunca o nome. Use o `id` com `listar_registros` para ler o histórico. `paciente` é nulo " +
  "quando o cadastro está inativo. Cancelamentos aparecem com o status correspondente.";

export type AgendaResult = {
  fuso: string;
  data: string;
  consultas: Array<{
    consulta_id: number;
    inicio: string | null;
    fim: string | null;
    tipo: string;
    status: string;
    confirmacao: string;
    paciente: AgentPatientWithHistory | null;
  }>;
};

export async function listAgenda(
  input: { data: string },
  deps: { agenda: AgendaRepo; lookup: PatientLookupRepo },
  context: { now: Date; timeZone: string },
): Promise<AgendaResult> {
  const { start, end } = getDayRangeForTimeZone(input.data, context.timeZone);
  const appointments = await deps.agenda.appointmentsBetween(start, end);

  const patients = new Map<number, Promise<AgentPatientWithHistory | null>>();
  const patientOf = (patientId: number) => {
    if (!patients.has(patientId)) {
      patients.set(
        patientId,
        deps.lookup.findById(patientId).then((patient) =>
          patient ? toAgentPatientWithHistory(patient, context.now, context.timeZone) : null,
        ),
      );
    }
    return patients.get(patientId) as Promise<AgentPatientWithHistory | null>;
  };

  const consultas = await Promise.all(
    appointments.map(async (appointment) => ({
      consulta_id: appointment.id,
      inicio: localDateTime(appointment.start, context.timeZone),
      fim: localDateTime(appointment.end, context.timeZone),
      tipo: appointment.appointmentType,
      status: appointment.status,
      confirmacao: appointment.confirmationStatus,
      paciente: await patientOf(appointment.patientId),
    })),
  );

  return { fuso: context.timeZone, data: input.data, consultas };
}
