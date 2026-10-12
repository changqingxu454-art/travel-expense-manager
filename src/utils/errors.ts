import type { AppErrorInfo, Result } from '../types';

/** 业务层可预期的错误，携带稳定的错误码。 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }

  toInfo(): AppErrorInfo {
    return { code: this.code, message: this.message };
  }
}

/** 功能尚未实现的占位错误；本阶段仅搭建骨架，禁止返回假数据。 */
export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super('NOT_IMPLEMENTED', `功能「${feature}」尚未实现。`);
    this.name = 'NotImplementedError';
  }
}

/** 将未知异常规范化为 {@link AppErrorInfo}。 */
export function toErrorInfo(error: unknown): AppErrorInfo {
  if (error instanceof AppError) {
    return error.toInfo();
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message };
  }
  return { code: 'UNKNOWN', message: String(error) };
}

/** 成功结果包装。 */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 失败结果包装。 */
export function fail<T>(error: unknown): Result<T> {
  return { ok: false, error: toErrorInfo(error) };
}
