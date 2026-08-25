import "server-only";

import {
  RPC_REGISTRY,
  type RpcSignature,
} from "@/lib/db/rpc-registry.generated";
import { castForUdt, paramForUdt } from "@/lib/db/columns";

export type RpcCall = {
  text: string;
  values: unknown[];
};

function signatureAccepts(signature: RpcSignature, provided: string[]): boolean {
  return provided.every((key) =>
    signature.args.some((arg) => arg.name === key),
  );
}

function sameKeys(signature: RpcSignature, provided: string[]): boolean {
  const names = signature.args.map((arg) => arg.name);
  return (
    names.length === provided.length &&
    names.every((name) => provided.includes(name))
  );
}

export function buildRpcCall(
  functionName: string,
  parameters: Record<string, unknown>,
): RpcCall {
  const signatures = RPC_REGISTRY[functionName];
  if (!signatures?.length) {
    throw new Error(`Unknown database RPC: ${functionName}`);
  }
  const provided = Object.keys(parameters);
  const signature =
    signatures.find((candidate) => sameKeys(candidate, provided)) ??
    signatures
      .filter((candidate) => signatureAccepts(candidate, provided))
      .sort((left, right) => left.args.length - right.args.length)[0];
  if (!signature) {
    throw new Error(
      `No signature of ${functionName} accepts the provided parameters`,
    );
  }

  const values: unknown[] = [];
  const clauses: string[] = [];
  for (const arg of signature.args) {
    if (!(arg.name in parameters)) continue;
    const value = parameters[arg.name];
    values.push(paramForUdt(arg.type, value));
    clauses.push(
      `${arg.name} => ${castForUdt(arg.type, `$${values.length}`)}`,
    );
  }
  return {
    text: `select * from public.${functionName}(${clauses.join(", ")})`,
    values,
  };
}
