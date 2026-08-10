/**
 * /api/user 下用户态 REST 接口的浏览器端封装。
 * 只负责请求与错误映射，所有状态规则都由服务端领域服务校验。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ErrorBody = {
  error?: string | { code?: string; message?: string };
  message?: string;
  code?: string;
};

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // 非 JSON 响应，忽略。
  }

  let message = `请求失败（HTTP ${res.status}）`;
  let code: string | null = null;

  if (body) {
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = body.error.message;
    else if (body.message) message = body.message;
    code =
      (typeof body.error === "object" ? body.error?.code : null) ??
      body.code ??
      null;
  }

  if (res.status === 401) message = "登录状态已失效，请重新登录";
  return new ApiError(res.status, message, code);
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown; idempotencyKey?: string },
): Promise<T> {
  const { json, headers, idempotencyKey, ...rest } = init ?? {};
  const method = (rest.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : null),
      // Most writes are one-shot and get a fresh key. Retryable callers can
      // pin a key until the response is confirmed (for example session turns).
      ...(["POST", "PATCH", "PUT", "DELETE"].includes(method)
        ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() }
        : null),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;

  const body: unknown = await res.json();
  // 用户态 API 统一以 { data: ... } 包装成功响应。
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}
