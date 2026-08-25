import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

/** Board address used when neither the environment nor an existing install provides one. */
export const DEFAULT_BOARD_URL = "https://task.neilx.online";

export interface Choice<T extends string> {
  value: T;
  label: string;
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
  private readline: ReadlineInterface;

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
  ) {
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
    });
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
      const answer = (await this.readSecretLine(`${label}${suffix}: `)).trim();
      if (answer) return answer;
      if (existingValue) return existingValue;
      this.write("  该项不能为空。\n");
    }
  }

  /**
   * Reads one line without echoing the typed characters. readline redraws
   * its current line with an erase-then-rewrite sequence that wipes prompt
   * text written directly to the output, and Node 22 moved its echo hook
   * from `_writeToOutput` to a Symbol, so hooking it neither renders the
   * prompt nor mutes input there. On a TTY we therefore close readline
   * (which restores terminal echo), consume raw bytes ourselves with echo
   * disabled, and recreate readline for the questions that follow; on a
   * pipe there is no echo to suppress and the value is read as a line.
   */
  private async readSecretLine(label: string): Promise<string> {
    if (!this.input.isTTY) {
      return this.readline.question(label);
    }

    this.readline.close();
    const input = this.input;
    const output = this.output;
    const rawBefore = Boolean(input.isRaw);

    try {
      return await new Promise<string>((resolve, reject) => {
        let line = "";
        let settled = false;

        const cleanup = (): void => {
          input.off("data", onData);
          input.off("end", onEnd);
          input.off("error", onError);
        };

        const finish = (error: Error | null, value?: string): void => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            input.setRawMode?.(rawBefore);
          } catch {
            // Restoring raw mode is best effort on non-TTY backing streams.
          }
          if (error) {
            reject(error);
            return;
          }
          resolve(value ?? line);
        };

        const onData = (chunk: Buffer | string): void => {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          for (const character of text) {
            if (character === "\r" || character === "\n") {
              output.write("\n");
              finish(null, line);
              return;
            }
            if (character === "\u0003") {
              output.write("^C\n");
              finish(new Error("Aborted with Ctrl+C"));
              return;
            }
            if (character === "\u007f" || character === "\b") {
              if (line.length > 0) {
                line = line.slice(0, -1);
              }
              continue;
            }
            if (character < "\u0020") continue;
            line += character;
          }
        };

        const onEnd = (): void => finish(new Error("输入流已关闭"));
        const onError = (error: Error): void => finish(error);

        input.setRawMode?.(true);
        this.write(label);
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("error", onError);
        input.resume();
      });
    } finally {
      this.readline = createInterface({
        input: this.input,
        output: this.output,
        terminal: Boolean(this.input.isTTY && this.output.isTTY),
      });
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
 * The unified, minimal interactive configuration shared by every Bridge.
 * Every interactive run re-asks the Board address and Connection Token:
 * leaving the token blank keeps the saved value, while entering a new value
 * replaces it for the next service restart. Everything else comes from one
 * shared environment file or the Web console.
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
    existing.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
      environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
      undefined,
  );
  return { boardUrl, connectionToken };
}
