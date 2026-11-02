#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is missing. Create a .env file or export DATABASE_URL before running the CLI.",
    );
  }

  const { addTokenToUser } = await import("../app/lib/auth.server");
  const { TOKEN_SCOPES, isTokenScope } = await import("../app/lib/auth-scope");
  const { prisma } = await import("../app/lib/prisma.server");

  // `--scope reminders` issues a restricted token (reminder endpoints only). Default: full.
  const scope = readArg("--scope") ?? "full";
  if (!isTokenScope(scope)) {
    throw new Error(`Invalid --scope "${scope}". Use one of: ${TOKEN_SCOPES.join(", ")}.`);
  }

  let userIdStr = readArg("--userId");

  if (!userIdStr) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("Missing required argument --userId. Pass --userId <id>.");
    }

    const terminal = createInterface({ input, output });
    try {
      const users = await prisma.authUser.findMany({
        where: { isActive: true },
        orderBy: { id: "asc" },
      });

      if (users.length === 0) {
        throw new Error("No active users found. Create a user first with pnpm create:user.");
      }

      console.log("");
      console.log("Active users:");
      for (const u of users) {
        console.log(`  [${u.id}] ${u.fullName} — CRM ${u.crm}/${u.crmUf}`);
      }
      console.log("");

      userIdStr = await terminal.question("User ID: ");
    } finally {
      terminal.close();
    }
  }

  const userId = parseInt(userIdStr, 10);
  if (isNaN(userId) || userId <= 0) {
    throw new Error(`Invalid user ID: ${userIdStr}`);
  }

  const user = await prisma.authUser.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(`User with ID ${userId} not found.`);
  }
  if (!user.isActive) {
    throw new Error(`User with ID ${userId} is inactive.`);
  }

  const { rawToken } = await addTokenToUser(userId, scope);

  console.log("");
  console.log("Token created");
  console.log(`User ID: ${user.id}`);
  console.log(`Name: ${user.fullName}`);
  console.log(`CRM: ${user.crm}/${user.crmUf}`);
  console.log(`Scope: ${scope}${scope === "full" ? "" : " (restricted: cannot read patient records)"}`);
  console.log("");
  console.log("Token");
  console.log(rawToken);
  console.log("");
  console.log("Store this token now. It is only shown in plaintext at creation time.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not create token");
  process.exit(1);
});
