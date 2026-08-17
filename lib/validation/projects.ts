import { z } from "zod";

import { nonEmptyText, uuidSchema } from "@/lib/validation/common";

/** POSIX 或 Windows 盘符绝对路径。 */
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/])/;

export const createProjectSchema = z
  .object({
    name: nonEmptyText.max(200),
    working_directory: nonEmptyText
      .max(4096)
      .regex(ABSOLUTE_PATH_PATTERN, "working_directory 必须是绝对路径"),
    connection_ids: z.array(uuidSchema).min(1).max(100),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
