import { describe, expect, it } from 'vitest';
// jsdom 没有 Web Worker，PDF.js 会退回主线程 worker。
// 直接 import 该模块会让它在 globalThis.pdfjsWorker 上注册 WorkerMessageHandler，
// 从而避免 PDF.js 去动态加载 worker 脚本 —— 测试因此执行的是真实的解析流程。
import 'pdfjs-dist/build/pdf.worker.mjs';
import { MAX_PDF_BYTES, extractPdfText } from '../services/pdfService';
import { buildCjkInvoicePdf, buildNotPdf, buildPdf } from './pdfFixture';

function toBlob(bytes: Uint8Array<ArrayBuffer>, type = 'application/pdf'): Blob {
  return new Blob([bytes], { type });
}

describe('extractPdfText', () => {
  it('解析单页文本型 PDF 并保留文本顺序', async () => {
    const result = await extractPdfText(
      toBlob(buildPdf(['Invoice No 12345 Total 100.00'])),
    );
    expect(result.pageCount).toBe(1);
    expect(result.hasText).toBe(true);
    expect(result.text).toContain('Invoice No 12345 Total 100.00');
  });

  it('支持多页 PDF，并按页码顺序拼接', async () => {
    const result = await extractPdfText(
      toBlob(buildPdf(['PAGE-ONE 111', 'PAGE-TWO 222', 'PAGE-THREE 333'])),
    );
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]).toContain('PAGE-ONE');
    expect(result.pages[2]).toContain('PAGE-THREE');
    expect(result.text.indexOf('PAGE-ONE')).toBeLessThan(
      result.text.indexOf('PAGE-THREE'),
    );
  });

  it('提取中文发票文本并保留分行结构', async () => {
    const result = await extractPdfText(
      toBlob(
        buildCjkInvoicePdf([
          '增值税电子普通发票',
          '发票号码 12345678',
          '价税合计(小写)¥106.00',
        ]),
      ),
    );
    expect(result.hasText).toBe(true);
    expect(result.text).toContain('发票号码 12345678');
    expect(result.text).toContain('价税合计(小写)¥106.00');
    // 分行结构被保留，解析器才能按行区分字段
    expect(result.text).toContain('发票号码 12345678\n');
  });

  it('无文本内容（模拟扫描件）时 hasText 为 false 且不报错', async () => {
    const result = await extractPdfText(toBlob(buildPdf([''])));
    expect(result.hasText).toBe(false);
    expect(result.text.trim()).toBe('');
    expect(result.pageCount).toBe(1);
  });

  it('空文件返回明确的错误', async () => {
    await expect(extractPdfText(toBlob(new Uint8Array()))).rejects.toMatchObject({
      code: 'FILE_EMPTY',
    });
  });

  it('非 PDF 文件（文件头校验失败）返回明确的错误', async () => {
    await expect(
      extractPdfText(toBlob(buildNotPdf(), 'text/plain')),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
  });

  it('损坏的 PDF 返回明确的错误', async () => {
    const corrupted = buildPdf(['HELLO']).slice(0, 60);
    await expect(extractPdfText(toBlob(corrupted))).rejects.toMatchObject({
      code: 'PDF_INVALID',
    });
  });

  it('超过体积上限的文件被拒绝', async () => {
    const huge = new Blob([new Uint8Array(MAX_PDF_BYTES + 1)]);
    await expect(extractPdfText(huge)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
});
