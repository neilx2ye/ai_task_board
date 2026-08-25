import "server-only";

import { query } from "@/lib/db";
import { buildRpcCall } from "@/lib/db/rpc";
import { mapDatabaseError } from "@/lib/domain/errors";
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
  try {
    const { text, values } = buildRpcCall(
      functionName as string,
      parameters as Record<string, unknown>,
    );
    const result = await query(text, values);
    return (result.rows[0]?.[functionName] ?? null) as unknown as DomainFunctionReturn<Name>;
  } catch (error) {
    throw mapDatabaseError(
      error as { message?: string; code?: string; details?: string },
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
