import { describe, expect, it } from "vitest";

import {
  MAX_ARTIFACT_BYTES,
  safeFilename,
  safeMimeType,
  uploadFileSchema,
} from "@/lib/validation/artifacts";

describe("artifact upload validation", () => {
  it("accepts an ordinary browser File", () => {
    const file = new File(["report"], "competitor report.md", {
      type: "text/markdown",
    });

    expect(uploadFileSchema.parse(file)).toBe(file);
    expect(MAX_ARTIFACT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("rejects a blank display name and non-file values", () => {
    expect(
      uploadFileSchema.safeParse(new File(["x"], "   ", { type: "text/plain" })).success,
    ).toBe(false);
    expect(uploadFileSchema.safeParse({ name: "forged.txt", size: 1 }).success).toBe(false);
  });

  it("accepts exactly 50 MiB and rejects one byte more without allocating the payload", () => {
    class DeclaredSizeFile extends File {
      constructor(private readonly declaredSize: number) {
        super(["x"], "boundary.bin", { type: "application/octet-stream" });
      }

      override get size(): number {
        return this.declaredSize;
      }
    }

    expect(uploadFileSchema.safeParse(new DeclaredSizeFile(MAX_ARTIFACT_BYTES)).success).toBe(
      true,
    );
    expect(
      uploadFileSchema.safeParse(new DeclaredSizeFile(MAX_ARTIFACT_BYTES + 1)).success,
    ).toBe(false);
  });
});

describe("artifact object path sanitization", () => {
  it.each([
    ["../../secret.txt", "secret.txt"],
    ["folder\\nested/report final (v2).pdf", "report_final_v2_.pdf"],
    ["...", "artifact"],
    ["控制\u0000字符.txt", "txt"],
    [".hidden", "hidden"],
    ["report...final.pdf", "report.final.pdf"],
    ["normal-file_1.csv", "normal-file_1.csv"],
  ])("sanitizes %j as %j", (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it("caps the safe object-name segment independently from display metadata", () => {
    expect(safeFilename(`${"a".repeat(300)}.txt`)).toHaveLength(180);
  });

  it.each([
    [" Text/Markdown ", "text/markdown"],
    ["application/vnd.api+json", "application/vnd.api+json"],
    ["text/plain; charset=utf-8", "application/octet-stream"],
    ["not-a-mime", "application/octet-stream"],
    ["", "application/octet-stream"],
  ])("normalizes MIME %j as %j", (input, expected) => {
    expect(safeMimeType(input)).toBe(expected);
  });
});
