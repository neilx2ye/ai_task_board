import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { query } from "@/lib/db";
import { AppError } from "@/lib/domain/errors";

export const SESSION_COOKIE = "atb_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const { rows } = await query<{ id: string; email: string | null }>(
    `select u.id, u.email
     from auth.sessions s
     join auth.users u on u.id = s.user_id
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ? { id: rows[0].id, email: rows[0].email } : null;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await query<{ id: string; password_hash: string | null }>(
    `select id, password_hash
     from auth.users
     where lower(email) = $1`,
    [normalized],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new AppError("AUTHENTICATION_REQUIRED", "邮箱或密码不正确");
  }
  await startSession(user.id);
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AppError("INVALID_REQUEST", "邮箱格式不正确");
  }
  if (password.length < 8) {
    throw new AppError("INVALID_REQUEST", "密码至少需要 8 个字符");
  }
  const id = randomUUID();
  try {
    await query(
      `insert into auth.users (id, email, raw_user_meta_data, password_hash)
       values ($1::uuid, $2, jsonb_build_object('name', split_part($2, '@', 1)), $3)`,
      [id, normalized, await hashPassword(password)],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("INVALID_REQUEST", "该邮箱已注册");
    }
    throw error;
  }
  await startSession(id);
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await query(
      `update auth.sessions set revoked_at = now() where token_hash = $1`,
      [hashToken(token)],
    ).catch(() => undefined);
  }
  cookieStore.delete(SESSION_COOKIE);
}

async function startSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `insert into auth.sessions (user_id, token_hash, expires_at)
     values ($1::uuid, $2, $3::timestamptz)`,
    [userId, hashToken(token), expiresAt.toISOString()],
  );
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
