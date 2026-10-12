import * as pdfjsLib from 'pdfjs-dist';
// Vite 会把该 worker 作为静态资源输出并带上正确的 base 前缀，
// 因此在 GitHub Pages 的子路径部署下也能正确加载。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfExtractResult } from '../types';
import { AppError } from '../utils/errors';

/**
 * 使用 PDF.js 在浏览器本地提取 PDF 文本。
 *
 * 文件永远不会离开用户设备：解析在内存中完成，结果与原件都只写入 IndexedDB。
 * 页面组件不得直接调用 PDF.js 底层接口，一律通过本模块。
 */

/** 单个 PDF 允许的最大体积（20 MB）。 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** PDF 文件头魔数：%PDF */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

function ensureWorkerConfigured(): void {
  // 允许调用方（含测试）自行指定 worker；未指定时使用 Vite 打包出的资源地址。
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
}

/**
 * 读取 Blob 字节。
 *
 * 优先使用标准的 `Blob.arrayBuffer()`；部分环境（如 jsdom）未实现该方法，
 * 此时退回 FileReader，保证同一套代码在浏览器与测试环境中行为一致。
 */
function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new AppError('FILE_READ_FAILED', '读取文件内容失败。'));
      }
    };
    reader.onerror = () =>
      reject(new AppError('FILE_READ_FAILED', '读取文件内容失败。'));
    reader.readAsArrayBuffer(blob);
  });
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) {
    return false;
  }
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** 将 PDF.js 抛出的异常映射为带稳定错误码的 AppError。 */
function mapPdfError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'PasswordException') {
    return new AppError(
      'PDF_PASSWORD_PROTECTED',
      '该 PDF 已加密，当前版本不支持需要密码的发票，请提供未加密的文件。',
    );
  }
  if (name === 'InvalidPDFException') {
    return new AppError('PDF_INVALID', '文件已损坏或不是有效的 PDF。');
  }
  if (name === 'MissingPDFException') {
    return new AppError('PDF_MISSING', 'PDF 内容缺失，无法读取。');
  }
  if (name === 'AbortException') {
    return new AppError('PDF_ABORTED', 'PDF 读取被中止。');
  }
  return new AppError('PDF_PARSE_FAILED', `PDF 解析失败：${message}`);
}

/** 读取文本条目变换矩阵中的纵向位置（第 6 个分量）。 */
function readTransformY(transform: unknown): number | undefined {
  if (!Array.isArray(transform)) {
    return undefined;
  }
  const value: unknown = transform[5];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 把一页的文本条目按原始顺序拼接。
 *
 * 依据 `hasEOL` 以及相邻条目的纵向位置变化补换行，
 * 以便在提取结果中尽量保留原始的行结构（发票字段通常按行排列）。
 */
function joinPageText(items: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  let lastY: number | undefined;

  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as {
      str?: unknown;
      hasEOL?: unknown;
      transform?: unknown;
    };
    if (typeof record.str !== 'string') {
      continue;
    }
    const y = readTransformY(record.transform);
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 1) {
      parts.push('\n');
    }
    parts.push(record.str);
    if (record.hasEOL === true) {
      parts.push('\n');
    }
    lastY = y ?? lastY;
  }

  return parts.join('');
}

/**
 * 提取 PDF 的全部文本。
 *
 * - 校验文件类型（%PDF 魔数）与体积。
 * - 支持多页，按页码顺序拼接并保留每页文本。
 * - 无文本（如扫描版）时返回 `hasText: false` 与空文本，由 UI 引导手动录入。
 * - 无论成功或失败都会释放 PDF.js 资源。
 */
export async function extractPdfText(file: Blob): Promise<PdfExtractResult> {
  if (file.size === 0) {
    throw new AppError('FILE_EMPTY', '文件内容为空，请重新选择。');
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `文件超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB，暂不支持解析。`,
    );
  }
  const buffer = await readBlobAsArrayBuffer(file);
  const data = new Uint8Array(buffer);
  if (!hasPdfSignature(data)) {
    throw new AppError('INVALID_FILE_TYPE', '仅支持 PDF 文件（文件头校验失败）。');
  }

  ensureWorkerConfigured();

  const loadingTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  try {
    const document = await loadingTask.promise;
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          pages.push(joinPageText(content.items));
        } finally {
          page.cleanup();
        }
      }
      const text = pages.join('\n');
      return {
        text,
        pages,
        pageCount: document.numPages,
        hasText: text.trim() !== '',
      };
    } finally {
      await document.destroy();
    }
  } catch (error) {
    throw mapPdfError(error);
  } finally {
    // 加载失败时 loadingTask 可能尚未产出 document，这里确保资源被释放。
    await loadingTask.destroy().catch(() => undefined);
  }
}
