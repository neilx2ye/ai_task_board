import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getAITokenPepper,
  getPublicSupabaseEnv,
  getSupabaseSecretKey,
} from "@/lib/env";

const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "AI_TOKEN_PEPPER",
] as const;

afterEach(() => {
  names.forEach((name) => vi.stubEnv(name, ""));
  vi.unstubAllEnvs();
});

describe("server environment contract", () => {
  it("prefers publishable and secret key names for new projects", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-new");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-new");

    expect(getPublicSupabaseEnv()).toEqual({
      url: "https://project.supabase.co",
      publishableKey: "publishable-new",
    });
    expect(getSupabaseSecretKey()).toBe("secret-new");
  });

  it("requires a non-empty project URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-new");

    expect(() => getPublicSupabaseEnv()).toThrow(
      "Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL",
    );
  });

  it("rejects a short AI token pepper", () => {
    vi.stubEnv("AI_TOKEN_PEPPER", "too-short");

    expect(() => getAITokenPepper()).toThrow(
      "AI_TOKEN_PEPPER must contain at least 32 characters",
    );
  });
});
