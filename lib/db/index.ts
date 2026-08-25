import "server-only";

import { Pool, types as pgTypes, type QueryResult, type QueryResultRow } from "pg";

import { getDatabaseUrl } from "@/lib/env";

// PostgREST returned timestamps as ISO strings and the domain layer relies on
// that (localeCompare, Date.parse, deterministic serialization). node-postgres
// would otherwise parse them into Date objects, so keep the string form.
for (const oid of [1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */]) {
  pgTypes.setTypeParser(oid, (value: string) => value);
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 10,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** A dedicated client for long-lived LISTEN streams. Callers own its lifecycle. */
export { Client } from "pg";

export function connectionString(): string {
  return getDatabaseUrl();
}
