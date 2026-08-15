import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { isRecord, stringValue } from "./utils.js";

export type RegistryBinding = {
  /** agy conversation ID; null until the first turn creates one. */
  conversationId: string | null;
  directoryKey: string;
  workingDirectory: string;
  name: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

type DiskRegistry = {
  version: 1;
  bindings: Record<string, RegistryBinding>;
};

function normalizeBinding(value: unknown): RegistryBinding | null {
  if (!isRecord(value)) return null;
  const conversationId = stringValue(value.conversationId) ?? null;
  const directoryKey = stringValue(value.directoryKey);
  const workingDirectory = stringValue(value.workingDirectory);
  const name = stringValue(value.name);
  const createdAt = stringValue(value.createdAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!directoryKey || !workingDirectory || !name || !createdAt || !updatedAt) {
    return null;
  }
  return {
    conversationId,
    directoryKey,
    workingDirectory: path.resolve(workingDirectory),
    name,
    model: stringValue(value.model),
    createdAt,
    updatedAt,
  };
}

function emptyDiskRegistry(): DiskRegistry {
  return { version: 1, bindings: {} };
}

/**
 * Local mapping between stable Board-facing thread IDs and real agy
 * conversations. The stable ID is what the Bridge reports as
 * `external_conversation_ref`; it never changes when the first turn learns
 * the agy `conversation_id`, so the Board session stays put.
 */
export class BridgeRegistry {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) {
      throw new Error("ANTIGRAVITY_REGISTRY_FILE 必须是绝对路径");
    }
  }

  async list(): Promise<Map<string, RegistryBinding>> {
    const disk = await this.load();
    return new Map(Object.entries(disk.bindings));
  }

  async upsert(
    bindingId: string,
    binding: RegistryBinding,
  ): Promise<void> {
    this.writeChain = this.writeChain
      .then(async () => {
        const disk = await this.load();
        disk.bindings[bindingId] = binding;
        await this.save(disk);
      })
      .catch((error) => {
        process.stderr.write(
          `Antigravity Bridge 注册表写入失败：${String(
            error instanceof Error ? error.message : error,
          )}\n`,
        );
      });
    await this.writeChain;
  }

  async delete(bindingId: string): Promise<boolean> {
    let deleted = false;
    this.writeChain = this.writeChain
      .then(async () => {
        const disk = await this.load();
        deleted = bindingId in disk.bindings;
        delete disk.bindings[bindingId];
        await this.save(disk);
      })
      .catch((error) => {
        process.stderr.write(
          `Antigravity Bridge 注册表删除失败：${String(
            error instanceof Error ? error.message : error,
          )}\n`,
        );
      });
    await this.writeChain;
    return deleted;
  }

  private async load(): Promise<DiskRegistry> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.bindings)) {
        return emptyDiskRegistry();
      }
      const bindings: Record<string, RegistryBinding> = {};
      for (const [bindingId, rawBinding] of Object.entries(parsed.bindings)) {
        const normalized = normalizeBinding(rawBinding);
        if (normalized) bindings[bindingId] = normalized;
      }
      return { version: 1, bindings };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyDiskRegistry();
      }
      throw error;
    }
  }

  private async save(disk: DiskRegistry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temporary, `${JSON.stringify(disk, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
