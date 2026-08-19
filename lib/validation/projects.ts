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

/** Web 修改项目：working_directory 定位现有目录，new_working_directory 为目标路径。 */
export const updateProjectSchema = z
  .object({
    working_directory: nonEmptyText
      .max(4096)
      .regex(ABSOLUTE_PATH_PATTERN, "working_directory 必须是绝对路径"),
    name: nonEmptyText.max(200),
    new_working_directory: nonEmptyText
      .max(4096)
      .regex(
        ABSOLUTE_PATH_PATTERN,
        "new_working_directory 必须是绝对路径",
      ),
  })
  .strict();

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/** Web 删除项目：按工作目录路径删除看板中的项目记录。 */
export const deleteProjectSchema = z
  .object({
    working_directory: nonEmptyText
      .max(4096)
      .regex(ABSOLUTE_PATH_PATTERN, "working_directory 必须是绝对路径"),
  })
  .strict();

export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>;
