import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  arrayCastForUdt,
  castForUdt,
  paramForUdt,
  publicColumnTypes,
} from "@/lib/db/columns";
import { query } from "@/lib/db";
import { buildRpcCall } from "@/lib/db/rpc";
import {
  createSignedUrl,
  removeObjects,
  uploadObject,
  type StorageError,
  type UploadOptions,
} from "@/lib/storage/local";
import type { Database } from "@/lib/types/database";

/**
 * Server-side data access for the local PostgreSQL deployment.
 *
 * This module keeps the Supabase admin-client surface that the domain layer
 * already uses (from/eq/or/upsert/rpc/storage) so call sites and their tests
 * keep working, but executes everything through the `pg` driver directly
 * against DATABASE_URL. No PostgREST, GoTrue or hosted Storage is involved.
 */

type DatabaseError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

type PostgrestErrorLike = DatabaseError & {
  status?: number;
  statusCode?: string;
};

function normalizeError(error: unknown): PostgrestErrorLike {
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: string;
      code?: string;
      detail?: string;
      hint?: string;
      status?: number;
      statusCode?: string;
    };
    return {
      message: candidate.message ?? "Database request failed",
      code: candidate.code,
      details: candidate.detail,
      hint: candidate.hint,
      status: candidate.status,
      statusCode: candidate.statusCode,
    };
  }
  return { message: "Database request failed" };
}

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

type Condition = {
  column: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "is" | "in";
  value: unknown;
};

type Order = {
  column: string;
  ascending: boolean;
};

function parseOrClause(
  input: string,
  types: Map<string, Map<string, string>>,
  table: string,
  values: unknown[],
): string {
  const castForColumn = (column: string, placeholder: string) =>
    castForUdt(types.get(table)?.get(column), placeholder);

  const parseCondition = (raw: string): string => {
    const firstDot = raw.indexOf(".");
    const secondDot = raw.indexOf(".", firstDot + 1);
    if (firstDot === -1 || secondDot === -1) {
      throw new Error(`Unsupported or() condition: ${raw}`);
    }
    const column = raw.slice(0, firstDot);
    const operator = raw.slice(firstDot + 1, secondDot);
    const value = raw.slice(secondDot + 1);
    const quoted = identifier(column);
    if (operator === "is") {
      if (value === "null") return `${quoted} is null`;
      if (value === "true") return `${quoted} is true`;
      if (value === "false") return `${quoted} is false`;
      throw new Error(`Unsupported is() operator in or(): ${raw}`);
    }
    const symbols: Record<string, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    const symbol = symbols[operator];
    if (!symbol) throw new Error(`Unsupported or() operator: ${operator}`);
    values.push(value);
    return `${quoted} ${symbol} ${castForColumn(column, `$${values.length}`)}`;
  };

  const splitTopLevel = (text: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (char === "," && depth === 0) {
        parts.push(text.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
  };

  return splitTopLevel(input)
    .map((part) => {
      if (part.startsWith("and(") && part.endsWith(")")) {
        const inner = splitTopLevel(part.slice(4, -1))
          .map(parseCondition)
          .join(" and ");
        return `(${inner})`;
      }
      return parseCondition(part);
    })
    .join(" or ");
}

class LocalQueryBuilder {
  private readonly table: string;
  private selectColumns: string | null = null;
  private conditions: Condition[] = [];
  private orSql: string | null = null;
  private orders: Order[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private kind: "select" | "insert" | "update" | "delete" | "upsert" =
    "select";
  private insertRows: Record<string, unknown>[] = [];
  private updatePatch: Record<string, unknown> = {};
  private onConflict: string | null = null;
  private executed: Promise<{ data: unknown; error: PostgrestErrorLike | null }> | null =
    null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns = "*"): this {
    this.selectColumns = columns;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "eq", value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "neq", value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "gt", value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "gte", value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "lt", value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "lte", value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.conditions.push({ column, operator: "is", value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.conditions.push({ column, operator: "in", value });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.conditions.push({
      column,
      operator:
        operator === "is" ? "is" : (operator as Condition["operator"]),
      value: { negated: true, operator, value },
    });
    return this;
  }

  filter(column: string, operator: string, value: unknown): this {
    this.conditions.push({
      column,
      operator: (operator as Condition["operator"]) ?? "eq",
      value,
    });
    return this;
  }

  or(raw: string): this {
    this.orSql = raw;
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push({
      column,
      ascending: options.ascending ?? true,
    });
    return this;
  }

  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  insert(rows: Record<string, unknown> | Record<string, unknown>[]): this {
    this.kind = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.kind = "update";
    this.updatePatch = patch;
    return this;
  }

  delete(): this {
    this.kind = "delete";
    return this;
  }

  upsert(
    rows: Record<string, unknown> | Record<string, unknown>[],
    options: { onConflict?: string } = {},
  ): this {
    this.kind = "upsert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    this.onConflict = options.onConflict ?? null;
    return this;
  }

  single(): Promise<{ data: unknown; error: PostgrestErrorLike | null }> {
    return this.runWithRows((rows) => {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message: `The result contains ${rows.length} rows`,
            code: "PGRST116",
          },
        };
      }
      return { data: rows[0], error: null };
    });
  }

  maybeSingle(): Promise<{
    data: unknown;
    error: PostgrestErrorLike | null;
  }> {
    return this.runWithRows((rows) => {
      if (rows.length > 1) {
        return {
          data: null,
          error: {
            message: `The result contains ${rows.length} rows`,
            code: "PGRST116",
          },
        };
      }
      return { data: rows[0] ?? null, error: null };
    });
  }

  then<TResult1 = { data: unknown; error: PostgrestErrorLike | null }, TResult2 = never>(
    onfulfilled?:
      | ((
          value: { data: unknown; error: PostgrestErrorLike | null },
        ) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async runWithRows(
    map: (
      rows: Record<string, unknown>[],
    ) => { data: unknown; error: PostgrestErrorLike | null },
  ): Promise<{ data: unknown; error: PostgrestErrorLike | null }> {
    try {
      const rows = (await this.executeRaw()) as Record<string, unknown>[];
      return map(rows);
    } catch (error) {
      return { data: null, error: normalizeError(error) };
    }
  }

  private async execute(): Promise<{
    data: unknown;
    error: PostgrestErrorLike | null;
  }> {
    if (!this.executed) {
      this.executed = (async () => {
        try {
          const rows = (await this.executeRaw()) as Record<string, unknown>[];
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error: normalizeError(error) };
        }
      })();
    }
    return this.executed;
  }

  private async executeRaw(): Promise<unknown[]> {
    const types = await publicColumnTypes();
    const tableTypes = types.get(this.table) ?? new Map<string, string>();
    const values: unknown[] = [];
    const returning = this.selectColumns;
    const quotedTable = identifier(this.table);

    const conditionsSql: string[] = [];
    for (const condition of this.conditions) {
      const quoted = identifier(condition.column);
      const udt = tableTypes.get(condition.column);
      if (condition.operator === "is") {
        const target =
          typeof condition.value === "object" &&
          condition.value !== null &&
          "negated" in condition.value
            ? (condition.value as unknown as {
                operator: string;
                value: unknown;
              })
            : null;
        if (target) {
          if (target.value === null) {
            conditionsSql.push(`not (${quoted} is null)`);
            continue;
          }
          values.push(target.value);
          conditionsSql.push(
            `not (${quoted} is distinct from ${castForUdt(udt, `$${values.length}`)})`,
          );
          continue;
        }
        if (condition.value === null) {
          conditionsSql.push(`${quoted} is null`);
        } else if (typeof condition.value === "boolean") {
          conditionsSql.push(`${quoted} is ${condition.value ? "true" : "false"}`);
        } else {
          values.push(condition.value);
          conditionsSql.push(
            `${quoted} is not distinct from ${castForUdt(udt, `$${values.length}`)}`,
          );
        }
        continue;
      }
      if (condition.operator === "in") {
        const list = Array.isArray(condition.value) ? condition.value : [];
        values.push(list);
        conditionsSql.push(
          `${quoted} = any($${values.length}::${arrayCastForUdt(udt)})`,
        );
        continue;
      }
      const symbols: Record<string, string> = {
        eq: "=",
        neq: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      const symbol = symbols[condition.operator];
      if (!symbol) throw new Error(`Unsupported filter operator: ${condition.operator}`);
      values.push(paramForUdt(udt, condition.value));
      conditionsSql.push(
        `${quoted} ${symbol} ${castForUdt(udt, `$${values.length}`)}`,
      );
    }
    if (this.orSql) {
      conditionsSql.push(
        `(${parseOrClause(this.orSql, types, this.table, values)})`,
      );
    }

    const where =
      conditionsSql.length > 0 ? ` where ${conditionsSql.join(" and ")}` : "";

    if (this.kind === "select") {
      const order = this.orders.length
        ? ` order by ${this.orders
            .map((entry) => `${identifier(entry.column)} ${entry.ascending ? "asc" : "desc"}`)
            .join(", ")}`
        : "";
      const limit = this.limitValue !== null ? ` limit ${Math.trunc(this.limitValue)}` : "";
      const offset =
        this.offsetValue !== null ? ` offset ${Math.trunc(this.offsetValue)}` : "";
      const result = await query(
        `select ${this.selectColumns ?? "*"} from public.${quotedTable}${where}${order}${limit}${offset}`,
        values,
      );
      return result.rows;
    }

    let statement = "";
    if (this.kind === "insert" || this.kind === "upsert") {
      const rows = this.insertRows;
      if (!rows.length) return [];
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      if (!columns.length) throw new Error("Insert requires at least one column");
      const placeholders = rows
        .map((row) => {
          const rowPlaceholders = columns.map((column) => {
            values.push(paramForUdt(tableTypes.get(column), row[column]));
            return castForUdt(tableTypes.get(column), `$${values.length}`);
          });
          return `(${rowPlaceholders.join(", ")})`;
        })
        .join(", ");
      const conflict = this.onConflict
        ? ` on conflict (${this.onConflict
            .split(",")
            .map((column) => identifier(column.trim()))
            .join(", ")}) do update set ${columns
            .map((column) => {
              const quoted = identifier(column);
              return `${quoted} = excluded.${quoted}`;
            })
            .join(", ")}`
        : this.kind === "upsert"
          ? " on conflict do nothing"
          : "";
      statement = `insert into public.${quotedTable} (${columns
        .map(identifier)
        .join(", ")}) values ${placeholders}${conflict}`;
    } else if (this.kind === "update") {
      const columns = Object.keys(this.updatePatch);
      if (!columns.length) return [];
      const assignments = columns.map((column) => {
        values.push(
          paramForUdt(tableTypes.get(column), this.updatePatch[column]),
        );
        return `${identifier(column)} = ${castForUdt(
          tableTypes.get(column),
          `$${values.length}`,
        )}`;
      });
      statement = `update public.${quotedTable} set ${assignments.join(", ")}${where}`;
    } else {
      statement = `delete from public.${quotedTable}${where}`;
    }

    const returningSql =
      returning !== null ? ` returning ${returning}` : "";
    const result = await query(`${statement}${returningSql}`, values);
    return result.rows;
  }
}

function from(table: string): LocalQueryBuilder {
  return new LocalQueryBuilder(table);
}

async function rpc(
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<{ data: unknown; error: PostgrestErrorLike | null }> {
  try {
    const { text, values } = buildRpcCall(functionName, parameters);
    const result = await query(text, values);
    return { data: result.rows[0]?.[functionName] ?? null, error: null };
  } catch (error) {
    return { data: null, error: normalizeError(error) };
  }
}

const storage = {
  from(bucket: string) {
    return {
      upload: (
        objectPath: string,
        bytes: Uint8Array,
        options: UploadOptions = {},
      ) => uploadObject(bucket, objectPath, bytes, options),
      remove: (paths: string[]) => removeObjects(bucket, paths),
      createSignedUrl: (
        objectPath: string,
        expiresInSeconds: number,
      ): Promise<
        | { data: { signedUrl: string } | null; error: StorageError | null }
      > => createSignedUrl(bucket, objectPath, expiresInSeconds),
    };
  },
};

let adminClient: SupabaseClient<Database> | undefined;

export function createAdminClient(): SupabaseClient<Database> {
  if (adminClient) return adminClient;
  adminClient = {
    from,
    rpc,
    storage,
  } as unknown as SupabaseClient<Database>;
  return adminClient;
}

export type { DatabaseError };
