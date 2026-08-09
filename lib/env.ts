import "server-only";

type PublicSupabaseEnv = {
  url: string;
  publishableKey: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getPublicSupabaseEnv(): PublicSupabaseEnv {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL"),
    publishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  };
}

export function getSupabaseSecretKey(): string {
  return required("SUPABASE_SECRET_KEY");
}

export function getAITokenPepper(): string {
  const pepper = required("AI_TOKEN_PEPPER");
  if (pepper.length < 32) {
    throw new Error("AI_TOKEN_PEPPER must contain at least 32 characters");
  }
  return pepper;
}
