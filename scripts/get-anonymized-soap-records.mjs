#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { stdout } from "node:process";

import { scrubClinicalText } from "../app/lib/privacy/scrub.ts";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printHelp() {
  console.log(`Exporta somente o texto dos registros SOAP, sem consultar Patient.

Uso:
  pnpm export:soap-anonymized -- [--output caminho.txt] [--batch-size 500]

Sem --output, o TXT e escrito em stdout. Mensagens de progresso vao para stderr.`);
}

function formatRecord(note, recordNumber) {
  const sections = [
    ["S", note.subjective],
    ["O", note.objective],
    ["A", note.assessment],
    ["P", note.plan],
  ].map(([label, value]) => `${label}:\n${scrubClinicalText(value)}`);

  return `${recordNumber > 1 ? "\n" : ""}===== SOAP ${recordNumber} =====\n${sections.join("\n\n")}\n`;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nao esta definida.");
  }

  const batchSizeValue = readArg("--batch-size") ?? "500";
  const batchSize = Number.parseInt(batchSizeValue, 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error("--batch-size deve ser um inteiro entre 1 e 10000.");
  }

  const outputPath = readArg("--output");
  if (process.argv.includes("--output") && !outputPath) {
    throw new Error("Informe um caminho depois de --output.");
  }

  const output = outputPath
    ? createWriteStream(outputPath, { encoding: "utf8", flags: "wx", mode: 0o600 })
    : stdout;

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  let cursorId;
  let exported = 0;

  try {
    while (true) {
      const versions = await prisma.compositionVersion.findMany({
        where: { templateId: "soap-ehr.template.encounter-soap.v1" },
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        orderBy: { id: "asc" },
        select: {
          id: true,
          content: true,
        },
      });

      if (versions.length === 0) break;

      for (const version of versions) {
        const byTitle = Object.fromEntries(
          (version.content?.content ?? []).map((section) => {
            const entry = section.items?.[0];
            const tree = entry?._type === "OBSERVATION"
              ? entry.data?.events?.[0]?.data
              : entry?.data;
            return [section.name?.value, tree?.items?.[0]?.value?.value ?? ""];
          }),
        );
        const note = {
          subjective: byTitle.Subjective ?? "",
          objective: byTitle.Objective ?? "",
          assessment: byTitle.Assessment ?? "",
          plan: byTitle.Plan ?? "",
        };
        exported += 1;
        await writeChunk(output, formatRecord(note, exported));
      }

      cursorId = versions.at(-1).id;
    }
  } finally {
    await prisma.$disconnect();
    if (outputPath) {
      output.end();
      await once(output, "close");
    }
  }

  console.error(`${exported} registro(s) SOAP exportado(s)${outputPath ? ` para ${outputPath}` : ""}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Falha ao exportar registros SOAP.");
    process.exitCode = 1;
  });
}
