import "server-only";

import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getDatabaseUrl(): string {
  return required("DATABASE_URL");
}

export function getAITokenPepper(): string {
  const pepper = required("AI_TOKEN_PEPPER");
  if (pepper.length < 32) {
    throw new Error("AI_TOKEN_PEPPER must contain at least 32 characters");
  }
  return pepper;
}

export function getLocalStorageDir(): string {
  const value = process.env.LOCAL_STORAGE_DIR?.trim();
  return value || path.join(process.cwd(), "local-storage");
}

export function getAppUrl(): string {
  const value = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return value || "http://localhost:3000";
}

export function isSignupEnabled(): boolean {
  return process.env.ALLOW_SIGNUP?.trim() === "true";
}
