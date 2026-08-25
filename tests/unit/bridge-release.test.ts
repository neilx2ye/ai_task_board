import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fetchMock = vi.hoisted(() => vi.fn());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function importModule() {
  // 模块级缓存：每个用例都需要一份全新的模块实例。
  vi.resetModules();
  return import("@/lib/bridge-release");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLatestBridgeRelease", () => {
  it("返回 registry /latest 的版本号", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: "1.4.0" }));
    const { getLatestBridgeRelease } = await importModule();

    await expect(getLatestBridgeRelease()).resolves.toBe("1.4.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/ai-task-board-bridge/latest",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("五分钟内命中模块级缓存，不重复请求", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: "1.4.0" }));
    const { getLatestBridgeRelease } = await importModule();

    await getLatestBridgeRelease();
    await getLatestBridgeRelease();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["404", jsonResponse(404, {})],
    ["500", jsonResponse(500, {})],
    ["负载缺 version", jsonResponse(200, { name: "ai-task-board-bridge" })],
  ])("查询失败返回 null（%s）", async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    const { getLatestBridgeRelease } = await importModule();

    await expect(getLatestBridgeRelease()).resolves.toBeNull();
  });

  it("网络异常返回 null 且同样被缓存", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const { getLatestBridgeRelease } = await importModule();

    await expect(getLatestBridgeRelease()).resolves.toBeNull();
    await expect(getLatestBridgeRelease()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("bridgeReleaseExists", () => {
  it("精确版本存在时返回 true", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: "1.4.0" }));
    const { bridgeReleaseExists } = await importModule();

    await expect(bridgeReleaseExists("1.4.0")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/ai-task-board-bridge/1.4.0",
      expect.anything(),
    );
  });

  it("registry 返回的版本号不一致时视为不存在", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: "1.4.1" }));
    const { bridgeReleaseExists } = await importModule();

    await expect(bridgeReleaseExists("1.4.0")).resolves.toBe(false);
  });

  it("404 与网络异常都按不存在处理", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const { bridgeReleaseExists } = await importModule();

    await expect(bridgeReleaseExists("9.9.9")).resolves.toBe(false);
    await expect(bridgeReleaseExists("9.9.8")).resolves.toBe(false);
  });

  it("按版本号缓存查询结果", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { version: "1.4.0" }));
    const { bridgeReleaseExists } = await importModule();

    await bridgeReleaseExists("1.4.0");
    await bridgeReleaseExists("1.4.0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
