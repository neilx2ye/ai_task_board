import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function embedRuntime(workspaceName, destinationName) {
  const source = path.resolve(
    packageDirectory,
    "..",
    workspaceName,
    "dist",
  );
  const destination = path.join(packageDirectory, "dist", destinationName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

await embedRuntime("kimi-bridge", "kimi-runtime");
await embedRuntime("antigravity-bridge", "antigravity-runtime");
await embedRuntime("claude-code-bridge", "claude-runtime");
