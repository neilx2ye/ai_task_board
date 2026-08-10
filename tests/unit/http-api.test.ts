import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  parseJsonOrEmpty,
} from "@/lib/http/api";

describe("bounded JSON request parsing", () => {
  const schema = z.object({ reason: z.string().optional() }).strict();

  it("keeps the empty and whitespace body shorthand", async () => {
    const parsed = await parseJsonOrEmpty(
      new Request("http://localhost/api/user/tasks/task/cancel", {
        method: "POST",
        body: " \n\t ",
      }),
      schema,
    );

    expect(parsed).toEqual({});
  });

  it("rejects Content-Length and streamed bytes above the default limit", async () => {
    const declared = parseJsonOrEmpty(
      new Request("http://localhost/api/user/tasks/task/cancel", {
        method: "POST",
        headers: {
          "Content-Length": String(DEFAULT_JSON_BODY_LIMIT_BYTES + 1),
        },
        body: "{}",
      }),
      schema,
    );
    await expect(declared).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });

    const streamed = parseJsonOrEmpty(
      new Request("http://localhost/api/user/tasks/task/cancel", {
        method: "POST",
        body: `{"reason":"${"x".repeat(DEFAULT_JSON_BODY_LIMIT_BYTES)}"}`,
      }),
      schema,
    );
    await expect(streamed).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });
});
