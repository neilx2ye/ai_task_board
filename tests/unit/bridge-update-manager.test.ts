import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared mutable state between the hoisted module mocks and each test. The
// spawn mock fakes npm pack / tar / node --version / systemctl against real
// temporary directories, so the real installRuntime() and unit-file rewrite
// run end to end.
const h = vi.hoisted(() => ({
  events: [] as string[],
  packedVersion: "1.4.0",
  packExitCode: 0,
  smokeExitCode: 0,
  smokeStdout: "1.4.0\n",
  holdPack: false,
  releasePack: null as null | (() => void),
  unitFilePath: null as string | null,
  unitContentsAtReload: null as string | null,
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const fsp = await import("node:fs/promises");

  function makeChild() {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
  }

  function finish(
    child: ReturnType<typeof makeChild>,
    code: number | null,
    stdout = "",
    stderr = "",
  ): void {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("exit", code, null);
    });
  }

  const spawn = vi.fn((command: string, args: string[]) => {
    const child = makeChild();
    if (command === "npm" && args[0] === "pack") {
      h.events.push("npm pack");
      h.packedVersion = args[1].split("@").pop() ?? "0.0.0";
      const destination = args[args.indexOf("--pack-destination") + 1];
      const doPack = () => {
        if (h.packExitCode !== 0) {
          finish(child, h.packExitCode, "", "npm error 404 Not Found");
          return;
        }
        const tarball = `ai-task-board-bridge-${h.packedVersion}.tgz`;
        void fsp
          .writeFile(path.join(destination, tarball), "fake-tarball")
          .then(() => finish(child, 0, `${tarball}\n`));
      };
      if (h.holdPack) h.releasePack = doPack;
      else doPack();
      return child;
    }
    if (command === "tar") {
      h.events.push("tar");
      const target = args[args.indexOf("-C") + 1];
      void (async () => {
        const packageRoot = path.join(target, "package");
        await fsp.mkdir(path.join(packageRoot, "dist", "kimi-runtime"), {
          recursive: true,
        });
        await fsp.mkdir(path.join(packageRoot, "dist", "antigravity-runtime"), {
          recursive: true,
        });
        await fsp.writeFile(path.join(packageRoot, "dist", "cli.js"), "// cli\n");
        await fsp.writeFile(
          path.join(packageRoot, "dist", "kimi-runtime", "cli.js"),
          "// kimi cli\n",
        );
        await fsp.writeFile(
          path.join(packageRoot, "dist", "antigravity-runtime", "cli.js"),
          "// antigravity cli\n",
        );
        await fsp.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "ai-task-board-bridge",
            version: h.packedVersion,
          }),
        );
        await fsp.writeFile(path.join(packageRoot, "README.md"), "# bridge\n");
        finish(child, 0);
      })();
      return child;
    }
    if (command === process.execPath && args.includes("--version")) {
      h.events.push("smoke --version");
      finish(child, h.smokeExitCode, h.smokeStdout, "smoke failed");
      return child;
    }
    if (command === "systemctl") {
      h.events.push(`systemctl ${args.join(" ")}`);
      try {
        h.unitContentsAtReload = h.unitFilePath
          ? readFileSync(h.unitFilePath, "utf8")
          : null;
      } catch {
        h.unitContentsAtReload = null;
      }
      finish(child, 0);
      return child;
    }
    h.events.push(`unexpected: ${command} ${args.join(" ")}`);
    finish(child, 127);
    return child;
  });
  return { spawn };
});

function wrapInstallRuntime<
  T extends { installRuntime: (...args: never[]) => Promise<void> },
>(actual: T): T {
  return {
    ...actual,
    installRuntime: vi.fn(
      (...args: Parameters<T["installRuntime"]>): Promise<void> => {
        h.events.push("installRuntime");
        return actual.installRuntime(...args);
      },
    ) as unknown as T["installRuntime"],
  };
}

vi.mock("@/packages/codex-bridge/src/setup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/packages/codex-bridge/src/setup")>();
  return wrapInstallRuntime(actual);
});
vi.mock("@/packages/kimi-bridge/src/setup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/packages/kimi-bridge/src/setup")>();
  return wrapInstallRuntime(actual);
});
vi.mock("@/packages/antigravity-bridge/src/setup", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/packages/antigravity-bridge/src/setup")
    >();
  return wrapInstallRuntime(actual);
});

type UpdateManagerModule = typeof import("@/packages/codex-bridge/src/update-manager");

let root: string;
let environment: Record<string, string>;
let exitSpy: ReturnType<typeof vi.fn>;

async function importCodexManager(): Promise<UpdateManagerModule> {
  return import("@/packages/codex-bridge/src/update-manager");
}

function stubExit(): void {
  const spy = vi.fn((code?: string | number | null) => {
    h.events.push(`exit ${code ?? 0}`);
  });
  exitSpy = spy;
  vi.spyOn(process, "exit").mockImplementation(spy as never);
}

beforeEach(async () => {
  vi.resetModules();
  h.events.length = 0;
  h.packedVersion = "1.4.0";
  h.packExitCode = 0;
  h.smokeExitCode = 0;
  h.smokeStdout = "1.4.0\n";
  h.holdPack = false;
  h.releasePack = null;
  h.unitFilePath = null;
  h.unitContentsAtReload = null;
  root = await mkdtemp(path.join(tmpdir(), "atb-update-manager-test-"));
  environment = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    INVOCATION_ID: "test-invocation-id",
  };
  stubExit();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function baseOptions(
  overrides: Record<string, unknown> = {},
): Parameters<UpdateManagerModule["maybeApplyDesiredBridgeUpdate"]>[0] {
  return {
    desiredVersion: "1.4.0",
    currentVersion: "1.3.0",
    allowRemoteUpdate: true,
    environment,
    homeDirectory: environment.HOME,
    log: vi.fn(),
    ...overrides,
  } as Parameters<UpdateManagerModule["maybeApplyDesiredBridgeUpdate"]>[0];
}

async function writeCodexUnit(installedVersion: string): Promise<string> {
  const setup = await import("@/packages/codex-bridge/src/setup");
  const paths = setup.resolveSetupPaths(
    environment.HOME,
    installedVersion,
    environment,
  );
  await mkdir(path.dirname(paths.unitFile), { recursive: true });
  await writeFile(
    paths.unitFile,
    setup.renderSystemdUserUnit({
      nodeBinary: "/opt/node versions/current/bin/node",
      runtimeCli: paths.runtimeCli,
      workingDirectory: "/srv/my project",
      homeDirectory: environment.HOME,
      codexHome: "/home/test/.codex-custom",
      environmentFile: paths.environmentFile,
    }),
    { mode: 0o644 },
  );
  h.unitFilePath = paths.unitFile;
  return paths.unitFile;
}

describe("Bridge update manager version comparison", () => {
  it("compares base semver and ignores runtime prerelease suffixes", async () => {
    const codex = await importCodexManager();
    const kimi = await import("@/packages/kimi-bridge/src/update-manager");
    const antigravity = await import(
      "@/packages/antigravity-bridge/src/update-manager"
    );
    for (const manager of [codex, kimi, antigravity]) {
      expect(manager.isUpdateVersionNewer("1.4.0", "1.3.0")).toBe(true);
      expect(manager.isUpdateVersionNewer("2.0.0", "1.9.9")).toBe(true);
      expect(manager.isUpdateVersionNewer("1.10.0", "1.9.0")).toBe(true);
      expect(manager.isUpdateVersionNewer("1.4.0", "1.4.0")).toBe(false);
      expect(manager.isUpdateVersionNewer("1.3.9", "1.4.0")).toBe(false);
      expect(manager.isUpdateVersionNewer("garbage", "1.3.0")).toBe(false);
      expect(manager.isUpdateVersionNewer("1.4.0", "garbage")).toBe(false);
    }
    // Suffixed runtime constants satisfy the same base target (no loop)…
    expect(kimi.isUpdateVersionNewer("1.4.0", "1.4.0-kimi.1")).toBe(false);
    expect(kimi.isUpdateVersionNewer("1.4.0", "1.3.0-kimi.1")).toBe(true);
    expect(
      antigravity.isUpdateVersionNewer("1.4.0", "1.4.0-antigravity.1"),
    ).toBe(false);
    expect(
      antigravity.isUpdateVersionNewer("1.5.0", "1.4.0-antigravity.1"),
    ).toBe(true);
  });
});

describe("Codex Bridge update manager skip conditions", () => {
  it("skips when the Board sends no desired version", async () => {
    const manager = await importCodexManager();
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(baseOptions({ desiredVersion: null })),
    ).resolves.toBeNull();
    expect(h.events).toEqual([]);
  });

  it("skips invalid, equal, or older desired versions", async () => {
    const manager = await importCodexManager();
    for (const desiredVersion of ["not-semver", "1.3.0", "1.2.9"]) {
      await expect(
        manager.maybeApplyDesiredBridgeUpdate(baseOptions({ desiredVersion })),
      ).resolves.toBeNull();
    }
    expect(h.events).toEqual([]);
  });

  it("skips with a single stderr notice when remote update is not opted in", async () => {
    const manager = await importCodexManager();
    const log = vi.fn();
    const options = baseOptions({ allowRemoteUpdate: false, log });
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(options),
    ).resolves.toBeNull();
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(options),
    ).resolves.toBeNull();
    expect(h.events).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(
      "AI_TASK_BOARD_ALLOW_REMOTE_UPDATE",
    );
  });

  it("skips when the Bridge is not running under systemd", async () => {
    const manager = await importCodexManager();
    const log = vi.fn();
    const foregroundEnvironment = { ...environment };
    delete foregroundEnvironment.INVOCATION_ID;
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(
        baseOptions({ environment: foregroundEnvironment, log }),
      ),
    ).resolves.toBeNull();
    expect(h.events).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("Codex Bridge update manager flow", () => {
  it("packs, installs, smoke-tests, rewrites the unit, reloads, and exits 75", async () => {
    const manager = await importCodexManager();
    const setup = await import("@/packages/codex-bridge/src/setup");
    await writeCodexUnit("1.3.0");

    await expect(
      manager.maybeApplyDesiredBridgeUpdate(baseOptions()),
    ).resolves.toBeNull();

    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
      "systemctl --user daemon-reload",
      "exit 75",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(75);

    const { spawn } = await import("node:child_process");
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const packCall = spawnMock.mock.calls.find(
      (call: unknown[]) => call[0] === "npm",
    );
    expect(packCall?.[1]?.slice(0, 2)).toEqual([
      "pack",
      "ai-task-board-bridge@1.4.0",
    ]);
    expect(packCall?.[1]?.[2]).toBe("--pack-destination");
    const smokeCall = spawnMock.mock.calls.find(
      (call: unknown[]) =>
        call[0] === process.execPath &&
        Array.isArray(call[1]) &&
        call[1].includes("--version"),
    );
    expect(smokeCall?.[1]?.[0]).toContain(
      path.join("codex-bridge", "versions", "1.4.0", "dist", "cli.js"),
    );

    const installRuntimeMock =
      setup.installRuntime as unknown as ReturnType<typeof vi.fn>;
    expect(installRuntimeMock).toHaveBeenCalledTimes(1);
    const [sourceArgument, pathsArgument] = installRuntimeMock.mock.calls[0] as [
      string,
      { runtimeDirectory: string; runtimeCli: string },
    ];
    expect(sourceArgument).toMatch(/package$/);
    expect(pathsArgument.runtimeDirectory).toBe(
      path.join(
        environment.XDG_DATA_HOME,
        "ai-task-board",
        "codex-bridge",
        "versions",
        "1.4.0",
      ),
    );

    // The real installRuntime placed the new runtime on disk, while the old
    // version directory stays untouched for manual rollback.
    expect(
      existsSync(
        path.join(pathsArgument.runtimeDirectory, "dist", "cli.js"),
      ),
    ).toBe(true);

    // The unit was already rewritten when daemon-reload ran, and it kept the
    // existing local decisions (HOME, CODEX_HOME, WorkingDirectory, node).
    expect(h.unitContentsAtReload).toContain("versions/1.4.0/dist/cli.js");
    expect(h.unitContentsAtReload).toContain(
      'Environment="CODEX_HOME=/home/test/.codex-custom"',
    );
    expect(h.unitContentsAtReload).toContain("WorkingDirectory=/srv/my project");
    expect(h.unitContentsAtReload).toContain(
      '"/opt/node versions/current/bin/node"',
    );
    expect(h.unitContentsAtReload).toContain(
      `Environment="HOME=${environment.HOME}"`,
    );
  });

  it("reports an npm download failure and never exits", async () => {
    const manager = await importCodexManager();
    await writeCodexUnit("1.3.0");
    h.packExitCode = 1;

    const result = await manager.maybeApplyDesiredBridgeUpdate(baseOptions());
    expect(result).toContain("升级到 Bridge 1.4.0 失败");
    expect(result).toContain("下载 Bridge 发布包失败");
    expect(h.events).toEqual(["npm pack"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit on smoke failure, keeps the old unit, and never retries the same target", async () => {
    const manager = await importCodexManager();
    const unitFile = await writeCodexUnit("1.3.0");
    const originalUnit = readFileSync(unitFile, "utf8");
    h.smokeExitCode = 1;
    h.smokeStdout = "1.3.0\n";

    const first = await manager.maybeApplyDesiredBridgeUpdate(baseOptions());
    expect(first).toContain("冒烟检查失败");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
    ]);
    // The failed version never reaches the unit file: the old one still runs.
    expect(readFileSync(unitFile, "utf8")).toBe(originalUnit);

    // A fixed release with the same target version is not retried.
    h.smokeExitCode = 0;
    h.smokeStdout = "1.4.0\n";
    h.events.length = 0;
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(baseOptions()),
    ).resolves.toBeNull();
    expect(h.events).toEqual([]);

    // A different target starts a fresh attempt.
    h.smokeStdout = "1.4.1\n";
    await expect(
      manager.maybeApplyDesiredBridgeUpdate(
        baseOptions({ desiredVersion: "1.4.1" }),
      ),
    ).resolves.toBeNull();
    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
      "systemctl --user daemon-reload",
      "exit 75",
    ]);
  });

  it("holds a concurrent second attempt behind the in-flight lock", async () => {
    const manager = await importCodexManager();
    await writeCodexUnit("1.3.0");
    h.holdPack = true;

    const first = manager.maybeApplyDesiredBridgeUpdate(baseOptions());
    await vi.waitFor(() => {
      expect(h.releasePack).not.toBeNull();
    });
    expect(h.events).toEqual(["npm pack"]);

    await expect(
      manager.maybeApplyDesiredBridgeUpdate(baseOptions()),
    ).resolves.toBeNull();
    expect(h.events).toEqual(["npm pack"]);

    h.releasePack?.();
    await expect(first).resolves.toBeNull();
    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
      "systemctl --user daemon-reload",
      "exit 75",
    ]);
  });

  it("fails safely when the existing unit misses required fields", async () => {
    const manager = await importCodexManager();
    const setup = await import("@/packages/codex-bridge/src/setup");
    const paths = setup.resolveSetupPaths(environment.HOME, "1.4.0", environment);
    await mkdir(path.dirname(paths.unitFile), { recursive: true });
    await writeFile(
      paths.unitFile,
      [
        "[Service]",
        "WorkingDirectory=/srv/app",
        `Environment="HOME=${environment.HOME}"`,
        `EnvironmentFile=${paths.environmentFile}`,
        `ExecStart="/usr/bin/node" "/old/dist/cli.js" "run"`,
        "",
      ].join("\n"),
    );
    h.unitFilePath = paths.unitFile;

    const result = await manager.maybeApplyDesiredBridgeUpdate(baseOptions());
    expect(result).toContain("无法安全重写");
    expect(result).toContain("CODEX_HOME");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
    ]);
  });
});

describe("Kimi Bridge update manager", () => {
  it("installs the kimi-runtime subtree and exits 75", async () => {
    const manager = await import("@/packages/kimi-bridge/src/update-manager");
    const setup = await import("@/packages/kimi-bridge/src/setup");
    const paths = setup.resolveSetupPaths(environment.HOME, "1.3.0", environment);
    await mkdir(path.dirname(paths.unitFile), { recursive: true });
    await writeFile(
      paths.unitFile,
      setup.renderSystemdUserUnit({
        nodeBinary: "/usr/bin/node",
        runtimeCli: paths.runtimeCli,
        workingDirectory: "/srv/kimi project",
        homeDirectory: environment.HOME,
        environmentFile: paths.environmentFile,
      }),
    );
    h.unitFilePath = paths.unitFile;

    await expect(
      manager.maybeApplyDesiredBridgeUpdate(
        baseOptions({ currentVersion: "1.3.0-kimi.1" }),
      ),
    ).resolves.toBeNull();

    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
      "systemctl --user daemon-reload",
      "exit 75",
    ]);
    const installRuntimeMock =
      setup.installRuntime as unknown as ReturnType<typeof vi.fn>;
    const [sourceArgument, destinationArgument, versionArgument] =
      installRuntimeMock.mock.calls[0] as [string, string, string];
    expect(sourceArgument).toMatch(/package[/\\]dist[/\\]kimi-runtime$/);
    expect(destinationArgument).toBe(
      path.join(
        environment.XDG_DATA_HOME,
        "ai-task-board",
        "kimi-bridge",
        "versions",
        "1.4.0",
      ),
    );
    expect(versionArgument).toBe("1.4.0");
    // The synthesized runtime package.json carries the updated version, which
    // is what the installed cli.js --version reports at smoke time.
    const installedManifest = JSON.parse(
      readFileSync(path.join(destinationArgument, "package.json"), "utf8"),
    ) as { version: string };
    expect(installedManifest.version).toBe("1.4.0");
    expect(h.unitContentsAtReload).toContain(
      "kimi-bridge/versions/1.4.0/dist/cli.js",
    );
    expect(h.unitContentsAtReload).toContain(
      "WorkingDirectory=/srv/kimi project",
    );
  });
});

describe("Antigravity Bridge update manager", () => {
  it("installs the antigravity-runtime subtree and exits 75", async () => {
    const manager = await import(
      "@/packages/antigravity-bridge/src/update-manager"
    );
    const setup = await import("@/packages/antigravity-bridge/src/setup");
    const paths = setup.resolveSetupPaths(environment.HOME, "1.3.0", environment);
    await mkdir(path.dirname(paths.unitFile), { recursive: true });
    await writeFile(
      paths.unitFile,
      setup.renderSystemdUserUnit({
        nodeBinary: "/usr/bin/node",
        runtimeCli: paths.runtimeCli,
        workingDirectory: "/srv/agy",
        homeDirectory: environment.HOME,
        environmentFile: paths.environmentFile,
      }),
    );
    h.unitFilePath = paths.unitFile;

    await expect(
      manager.maybeApplyDesiredBridgeUpdate(
        baseOptions({ currentVersion: "1.3.0-antigravity.1" }),
      ),
    ).resolves.toBeNull();

    expect(h.events).toEqual([
      "npm pack",
      "tar",
      "installRuntime",
      "smoke --version",
      "systemctl --user daemon-reload",
      "exit 75",
    ]);
    const installRuntimeMock =
      setup.installRuntime as unknown as ReturnType<typeof vi.fn>;
    const [sourceArgument, destinationArgument] =
      installRuntimeMock.mock.calls[0] as [string, string, string];
    expect(sourceArgument).toMatch(/package[/\\]dist[/\\]antigravity-runtime$/);
    expect(destinationArgument).toContain(
      path.join("antigravity-bridge", "versions", "1.4.0"),
    );
    expect(h.unitContentsAtReload).toContain(
      "antigravity-bridge/versions/1.4.0/dist/cli.js",
    );
  });
});
