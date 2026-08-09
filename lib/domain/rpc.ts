import "server-only";

import { mapDatabaseError } from "@/lib/domain/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/types/database";

type PublicFunctions = Database["public"]["Functions"];

export type DomainFunctionName = keyof PublicFunctions;
export type DomainFunctionArgs<Name extends DomainFunctionName> =
  PublicFunctions[Name]["Args"];
export type DomainFunctionReturn<Name extends DomainFunctionName> =
  PublicFunctions[Name]["Returns"];

export async function callDomainRpc<Name extends DomainFunctionName>(
  functionName: Name,
  parameters: DomainFunctionArgs<Name>,
): Promise<DomainFunctionReturn<Name>> {
  const { data, error } = await createAdminClient().rpc(functionName, parameters);
  if (error) throw mapDatabaseError(error);
  // supabase-js cannot preserve the name/return correlation through its own
  // generic filter-builder conditional. Keep the single boundary cast here;
  // callers remain fully constrained by Database.public.Functions.
  return data as unknown as DomainFunctionReturn<Name>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
