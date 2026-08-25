// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

import { useAuth } from "@/hooks/use-auth";

function EmailProbe() {
  const auth = useAuth();
  if (auth.status !== "authenticated") return null;
  return createElement("span", null, auth.session.user.email ?? "no-email");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAuth", () => {
  it("wraps the session payload as session.user for existing consumers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          user: { id: "user-1", email: "owner@example.com" },
          signupEnabled: false,
        }),
      }),
    );

    render(createElement(EmailProbe));

    expect(await screen.findByText("owner@example.com")).toBeTruthy();
  });
});
