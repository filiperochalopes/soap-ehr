import { useTranslation } from "react-i18next";

import { formatDateTime } from "~/lib/utils";

type HistorySection = {
  text: string;
  title: string;
};

export type ClinicalHistoryItem = {
  author: {
    fullName: string;
  };
  encounteredAt: Date | string;
  id: string;
  kind: "narrative" | "soap";
  sections: HistorySection[];
  title: string;
};

export function ClinicalHistory(props: { notes: ClinicalHistoryItem[]; timeZone: string }) {
  const { t } = useTranslation();

  return (
    <details className="panel p-5">
      <summary className="cursor-pointer list-none text-lg font-semibold">
        {t("clinicalHistory.title", { count: props.notes.length })}
      </summary>
      <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {props.notes.length ? (
          props.notes.map((note) => (
            <article
              className="rounded-2xl border border-black/5 bg-white/40 p-4 dark:border-white/10 dark:bg-slate-950/30"
              key={note.id}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{note.title}</h3>
                  <p className="text-sm text-[color:var(--muted)]">
                    {formatDateTime(note.encounteredAt, { timeZone: props.timeZone })}
                  </p>
                </div>
                <div className="text-right text-sm text-[color:var(--muted)]">
                  <div>{note.author.fullName}</div>
                  <div>{note.kind === "soap" ? t("clinicalHistory.kindSoap") : t("clinicalHistory.kindNarrative")}</div>
                </div>
              </div>
              <div
                className={
                  note.sections.length > 1
                    ? "md:columns-2 md:gap-3"
                    : undefined
                }
              >
                {note.sections.map((section, index) => (
                  <section
                    className={note.sections.length > 1 ? "mb-3 break-inside-avoid" : undefined}
                    key={`${note.id}-${index}`}
                  >
                    <h4 className="field-label">{section.title}</h4>
                    <p className="whitespace-pre-wrap text-sm">{section.text}</p>
                  </section>
                ))}
              </div>
            </article>
          ))
        ) : (
          <p className="text-sm text-[color:var(--muted)]">
            {t("clinicalHistory.empty")}
          </p>
        )}
      </div>
    </details>
  );
}
