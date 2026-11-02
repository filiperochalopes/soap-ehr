import { randomBytes, createHash } from "node:crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";

import { env } from "~/lib/env.server";
import { prisma } from "~/lib/prisma.server";
import { writeAuditLog } from "~/lib/audit.server";
import { isTokenScope, scopeAllows, type TokenScope } from "~/lib/auth-scope";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type AuthContext = {
  tokenId: number;
  scope: TokenScope;
  user: {
    id: number;
    fullName: string;
    crm: string;
    crmUf: string;
  };
};

export function createRawToken() {
  return `fsr_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(rawToken: string) {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function buildAuthCookie(rawToken: string) {
  return serializeCookie(env.COOKIE_NAME, rawToken, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
  });
}

export function clearAuthCookie() {
  return serializeCookie(env.COOKIE_NAME, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
  });
}

function getTokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  const cookies = parseCookie(request.headers.get("cookie") ?? "");
  return cookies[env.COOKIE_NAME];
}

/**
 * Resolves a raw token to its context, or null.
 *
 * `requiredScope` defaults to `full`, so every caller that existed before scopes (login, the
 * UI session, the FHIR API) keeps working for full tokens and automatically REFUSES a
 * restricted token. Only a caller that explicitly asks for a narrower scope (the reminder
 * endpoints) accepts one. The check runs before `lastUsedAt` is touched.
 */
export async function authenticateToken(
  rawToken: string | null | undefined,
  requiredScope: TokenScope = "full",
) {
  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const authToken = await prisma.authToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!authToken || !authToken.isActive || authToken.revokedAt || !authToken.user.isActive) {
    return null;
  }

  if (!isTokenScope(authToken.scope) || !scopeAllows(authToken.scope, requiredScope)) {
    return null;
  }

  if (!env.API_DRY_RUN) {
    await prisma.authToken.update({
      where: { id: authToken.id },
      data: { lastUsedAt: new Date() },
    });
  }

  return {
    tokenId: authToken.id,
    scope: authToken.scope,
    user: {
      id: authToken.user.id,
      fullName: authToken.user.fullName,
      crm: authToken.user.crm,
      crmUf: authToken.user.crmUf,
    },
  } satisfies AuthContext;
}

export async function getAuthContext(request: Request, requiredScope: TokenScope = "full") {
  const rawToken = getTokenFromRequest(request);
  return authenticateToken(rawToken, requiredScope);
}

export async function requireUserSession(request: Request) {
  const auth = await getAuthContext(request);
  if (!auth) {
    throw new Response(null, {
      status: 302,
      headers: {
        Location: "/login",
      },
    });
  }

  return auth;
}

export async function requireApiUser(request: Request) {
  const auth = await getAuthContext(request);
  if (!auth) {
    throw new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: "A valid Bearer token is required.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      },
    );
  }

  return auth;
}

/**
 * API guard for endpoints that a restricted token may reach (today: the reminder endpoints).
 * A `full` token passes too; a token of any other scope passes only for its own scope.
 */
export async function requireApiScope(request: Request, requiredScope: TokenScope) {
  const auth = await getAuthContext(request, requiredScope);
  if (!auth) {
    throw new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: "A valid Bearer token with access to this endpoint is required.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      },
    );
  }

  return auth;
}

export async function createUserToken(input: {
  crm: string;
  crmUf: string;
  fullName: string;
}) {
  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);

  const user = await prisma.authUser.create({
    data: {
      crm: input.crm,
      crmUf: input.crmUf,
      fullName: input.fullName,
      tokens: {
        create: {
          tokenHash,
        },
      },
    },
  });

  await writeAuditLog(prisma, {
    action: "auth.user.created",
    category: "auth",
    entityId: String(user.id),
    entityType: "AuthUser",
    userId: user.id,
  });

  return { rawToken, user };
}

export async function addTokenToUser(userId: number, scope: TokenScope = "full") {
  if (!isTokenScope(scope)) {
    throw new Error(`Invalid token scope: ${String(scope)}.`);
  }

  const rawToken = createRawToken();
  const tokenHash = hashToken(rawToken);

  const token = await prisma.authToken.create({
    data: { tokenHash, userId, scope },
    include: { user: true },
  });

  await writeAuditLog(prisma, {
    action: "auth.token.created",
    category: "auth",
    entityId: String(token.id),
    entityType: "AuthToken",
    metadata: { scope },
    userId,
  });

  return { rawToken, user: token.user };
}

export async function revokeToken(tokenId: number) {
  const token = await prisma.authToken.update({
    where: { id: tokenId },
    data: { isActive: false, revokedAt: new Date() },
    include: { user: true },
  });

  await writeAuditLog(prisma, {
    action: "auth.token.revoked",
    category: "auth",
    entityId: String(token.id),
    entityType: "AuthToken",
    userId: token.userId,
  });

  return token;
}

export async function recordLoginAudit(auth: AuthContext) {
  await writeAuditLog(prisma, {
    action: "auth.token.used",
    category: "auth",
    entityId: String(auth.tokenId),
    entityType: "AuthToken",
    userId: auth.user.id,
  });
}
