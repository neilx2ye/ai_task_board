import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getAITokenPepper,
  getAppUrl,
  getDatabaseUrl,
  getLocalStorageDir,
} from "@/lib/env";

const names = [
  "DATABASE_URL",
  "AI_TOKEN_PEPPER",
  "LOCAL_STORAGE_DIR",
  "NEXT_PUBLIC_APP_URL",
] as const;

afterEach(() => {
  names.forEach((name) => vi.stubEnv(name, ""));
  vi.unstubAllEnvs();
});

describe("server environment contract", () => {
  it("reads the local PostgreSQL connection URL", () => {
    vi.stubEnv("DATABASE_URL", "postgresql:///ai_task_board_local");
    expect(getDatabaseUrl()).toBe("postgresql:///ai_task_board_local");
  });

  it("requires a database URL", () => {
    expect(() => getDatabaseUrl()).toThrow(
      "Missing required environment variable: DATABASE_URL",
    );
  });

  it("rejects a short AI token pepper", () => {
    vi.stubEnv("AI_TOKEN_PEPPER", "too-short");
    expect(() => getAITokenPepper()).toThrow(
      "AI_TOKEN_PEPPER must contain at least 32 characters",
    );
  });

  it("defaults the app URL and storage directory", () => {
    expect(getAppUrl()).toBe("http://localhost:3000");
    expect(getLocalStorageDir()).toMatch(/local-storage$/);
  });

  it("honors explicit app URL and storage directory", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://task.example.com");
    vi.stubEnv("LOCAL_STORAGE_DIR", "/var/lib/ai-task-board");
    expect(getAppUrl()).toBe("https://task.example.com");
    expect(getLocalStorageDir()).toBe("/var/lib/ai-task-board");
  });
});
