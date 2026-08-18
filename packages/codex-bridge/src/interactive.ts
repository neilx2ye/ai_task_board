import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

/** Board address used when neither the environment nor an existing install provides one. */
export const DEFAULT_BOARD_URL = "https://task.neilx.online";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ReadlineWithOutputOverride extends ReadlineInterface {
  _writeToOutput?: (value: string) => void;
}

export function normalizeBoardUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("请输入完整的 http:// 或 https:// 地址");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new Error("Board 地址只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Board 地址不能包含用户名或密码");
  }
  return normalized;
}

/** The one piece of connection configuration that cannot have a sensible default. */
export function hasConnectionEnvironment(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim());
}

/** Fill in the default Board address so every command path has a usable URL. */
export function applyDefaultBoardUrl(
  environment: Record<string, string | undefined> = process.env,
): void {
  if (!environment.AI_TASK_BOARD_URL?.trim()) {
    environment.AI_TASK_BOARD_URL = DEFAULT_BOARD_URL;
  }
}

export class TerminalPrompter {
  private readonly readline: ReadlineWithOutputOverride;
  private readonly originalWriteToOutput?: (value: string) => void;
  private muted = false;

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
  ) {
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
    }) as ReadlineWithOutputOverride;
    this.originalWriteToOutput = this.readline._writeToOutput?.bind(this.readline);
    if (this.originalWriteToOutput) {
      this.readline._writeToOutput = (value: string) => {
        if (!this.muted) this.originalWriteToOutput?.(value);
      };
    }
  }

  write(value: string): void {
    this.output.write(value);
  }

  async text(
    label: string,
    options: {
      defaultValue?: string;
      required?: boolean;
      validate?: (value: string) => string;
    } = {},
  ): Promise<string> {
    while (true) {
      const defaultHint =
        options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`;
      const answer = (await this.readline.question(`${label}${defaultHint}: `)).trim();
      const value = answer || options.defaultValue || "";
      if (options.required && !value) {
        this.write("  该项不能为空。\n");
        continue;
      }
      try {
        return options.validate ? options.validate(value) : value;
      } catch (error) {
        this.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  async secret(label: string, existingValue?: string): Promise<string> {
    while (true) {
      const suffix = existingValue ? "（回车保留现有值）" : "";
      this.write(`${label}${suffix}: `);
      this.muted = Boolean(this.input.isTTY && this.output.isTTY);
      let answer: string;
      try {
        answer = (await this.readline.question("")).trim();
      } finally {
        if (this.muted) this.write("\n");
        this.muted = false;
      }
      if (answer) return answer;
      if (existingValue) return existingValue;
      this.write("  该项不能为空。\n");
    }
  }

  async confirm(label: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = (await this.readline.question(`${label} [${hint}]: `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      if (["y", "yes", "是"].includes(answer)) return true;
      if (["n", "no", "否"].includes(answer)) return false;
      this.write("  请输入 y 或 n。\n");
    }
  }

  async choice<T extends string>(
    label: string,
    choices: readonly Choice<T>[],
    defaultValue: T,
  ): Promise<T> {
    this.write(`${label}\n`);
    choices.forEach((choice, index) => {
      this.write(`  ${index + 1}) ${choice.label}\n`);
    });
    const defaultIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === defaultValue),
    );
    while (true) {
      const answer = (
        await this.readline.question(`请选择 [${defaultIndex + 1}]: `)
      ).trim();
      if (!answer) return choices[defaultIndex].value;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) return choices[index].value;
      const named = choices.find((choice) => choice.value === answer);
      if (named) return named.value;
      this.write(`  请输入 1 到 ${choices.length}。\n`);
    }
  }

  close(): void {
    this.readline.close();
  }
}

/**
 * The unified, minimal interactive configuration shared by every Bridge:
 * Board address (optional, defaults when left empty) and Connection Token
 * (required). Everything else is configured from the Web console.
 */
export async function promptForConnectionBasics(
  prompt: TerminalPrompter,
  options: {
    existing?: Record<string, string>;
    environment?: Record<string, string | undefined>;
  } = {},
): Promise<{ boardUrl: string; connectionToken: string }> {
  const existing = options.existing ?? {};
  const environment = options.environment ?? process.env;
  const boardUrl = await prompt.text("Board 地址（留空使用默认）", {
    defaultValue:
      environment.AI_TASK_BOARD_URL?.trim() ||
      existing.AI_TASK_BOARD_URL?.trim() ||
      DEFAULT_BOARD_URL,
    required: false,
    validate: normalizeBoardUrl,
  });
  const connectionToken = await prompt.secret(
    "Connection Token（输入内容不会回显）",
    environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
      existing.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
      undefined,
  );
  return { boardUrl, connectionToken };
}
