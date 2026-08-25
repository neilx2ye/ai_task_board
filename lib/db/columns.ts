import "server-only";

import { query } from "@/lib/db";

type ColumnRow = {
  table_name: string;
  column_name: string;
  udt_name: string;
};

let columns: Map<string, Map<string, string>> | undefined;

export async function publicColumnTypes(): Promise<Map<string, Map<string, string>>> {
  if (columns) return columns;
  const { rows } = await query<ColumnRow>(
    `select table_name, column_name, udt_name
     from information_schema.columns
     where table_schema = 'public'`,
  );
  const next = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const table = next.get(row.table_name) ?? new Map<string, string>();
    table.set(row.column_name, row.udt_name);
    next.set(row.table_name, table);
  }
  columns = next;
  return columns;
}

/** Add an explicit SQL cast when Postgres cannot infer the parameter type. */
export function castForUdt(udt: string | undefined, placeholder: string): string {
  switch (udt) {
    case "uuid":
      return `${placeholder}::uuid`;
    case "timestamptz":
    case "timestamp":
    case "date":
      return `${placeholder}::timestamptz`;
    case "int2":
      return `${placeholder}::int2`;
    case "int4":
      return `${placeholder}::int4`;
    case "int8":
      return `${placeholder}::int8`;
    case "numeric":
    case "float4":
    case "float8":
      return `${placeholder}::numeric`;
    case "bool":
      return `${placeholder}::boolean`;
    case "json":
    case "jsonb":
      return `${placeholder}::jsonb`;
    default:
      if (udt?.startsWith("_")) return `${placeholder}::${udt}`;
      return placeholder;
  }
}

export function arrayCastForUdt(udt: string | undefined): string {
  const element = udt?.startsWith("_")
    ? udt.slice(1)
    : udt?.endsWith("[]")
      ? udt.slice(0, -2)
      : udt;
  return element ? `${element}[]` : "text[]";
}

export function paramForUdt(udt: string | undefined, value: unknown): unknown {
  if (udt === "json" || udt === "jsonb") {
    return value == null ? null : JSON.stringify(value);
  }
  return value;
}
