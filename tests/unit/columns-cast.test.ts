import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { arrayCastForUdt, castForUdt } from "@/lib/db/columns";
import "@/lib/db";
import { types as pgTypes } from "pg";

describe("local database column casts", () => {
  it("casts scalar uuid columns as uuid arrays", () => {
    expect(arrayCastForUdt("uuid")).toBe("uuid[]");
    expect(castForUdt("uuid", "$1")).toBe("$1::uuid");
  });

  it("normalizes array udt names", () => {
    expect(arrayCastForUdt("_uuid")).toBe("uuid[]");
    expect(arrayCastForUdt("uuid[]")).toBe("uuid[]");
  });

  it("falls back to text arrays for unknown column types", () => {
    expect(arrayCastForUdt(undefined)).toBe("text[]");
  });

  it("keeps timestamps as ISO strings to match the domain layer", () => {
    const value = "2026-08-24T14:00:00.123456+00:00";
    for (const oid of [1082, 1114, 1184]) {
      expect(pgTypes.getTypeParser(oid)?.(value)).toBe(value);
    }
  });
});
