/**
 * 测试专用：用最少的对象构造合法的 PDF 字节流。
 *
 * 只用于单元测试，不进入生产包。内容为虚构文本，不含任何真实发票信息。
 *
 * 提供两个构造器：
 * - {@link buildPdf}：使用标准 Helvetica 字体，仅支持 ASCII 文本。
 * - {@link buildCjkInvoicePdf}：使用 Type0 字体 + ToUnicode CMap，可承载中文文本，
 *   用于端到端验证「PDF 提取 → 发票解析 → 页面核对」的真实链路。
 */

interface PdfObject {
  n: number;
  body: string;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** 把对象列表组装成带 xref/trailer 的完整 PDF。 */
function assemblePdf(objects: PdfObject[], rootNumber = 1): Uint8Array<ArrayBuffer> {
  const sorted = [...objects].sort((a, b) => a.n - b.n);
  const maxObjectNumber = sorted.reduce((max, object) => Math.max(max, object.n), 0);

  let output = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const object of sorted) {
    offsets.set(object.n, output.length);
    output += `${object.n} 0 obj\n${object.body}\nendobj\n`;
  }

  const xrefOffset = output.length;
  output += `xref\n0 ${maxObjectNumber + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObjectNumber; n += 1) {
    output += `${String(offsets.get(n) ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  output +=
    `trailer\n<< /Size ${maxObjectNumber + 1} /Root ${rootNumber} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(output);
}

/**
 * 生成一个合法 PDF（标准字体，ASCII 文本）。
 *
 * @param pageTexts 每页要写入的文本；`\n` 会被渲染为独立行；空字符串表示该页无可提取文本（模拟扫描件）。
 */
export function buildPdf(pageTexts: string[]): Uint8Array<ArrayBuffer> {
  const pageCount = pageTexts.length;
  if (pageCount === 0) {
    throw new Error('至少需要一页。');
  }
  const fontObjectNumber = 3 + pageCount * 2;
  const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`);
  const objects: PdfObject[] = [];

  objects.push({ n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({
    n: 2,
    body: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  });

  pageTexts.forEach((text, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    objects.push({
      n: pageObjectNumber,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] ` +
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
        `/Contents ${contentObjectNumber} 0 R >>`,
    });
    const lines = text.split('\n').filter((line) => line !== '');
    const stream =
      lines.length === 0
        ? ''
        : `BT /F1 12 Tf 20 250 Td ${lines
            .map((line) => `(${escapePdfText(line)}) Tj 0 -14 Td`)
            .join(' ')} ET`;
    objects.push({
      n: contentObjectNumber,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    });
  });

  objects.push({
    n: fontObjectNumber,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  });

  return assemblePdf(objects);
}

/** 把字符串按 UTF-16 码点编码成 Identity-H 的 4 位十六进制串。 */
function toIdentityHex(value: string): string {
  let hex = '';
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > 0xffff) {
      throw new Error('测试夹具不支持 BMP 以外的字符。');
    }
    hex += codePoint.toString(16).toUpperCase().padStart(4, '0');
  }
  return hex;
}

/** 恒等映射的 ToUnicode CMap：CID == Unicode 码点。 */
const IDENTITY_TO_UNICODE_CMAP = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
  '/CMapName /Adobe-Identity-UCS def',
  '/CMapType 2 def',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  '1 beginbfrange',
  '<0000> <FFFF> <0000>',
  'endbfrange',
  'endcmap',
  'CMapName currentdict /CMap defineresource pop',
  'end',
  'end',
].join('\n');

/**
 * 生成一个可承载中文文本的 PDF（Type0 字体 + 恒等 ToUnicode CMap）。
 *
 * 注意：字体未内嵌，PDF.js 仍可借助 ToUnicode 提取文本，这正是电子发票文本提取的真实链路。
 */
export function buildCjkInvoicePdf(lines: string[]): Uint8Array<ArrayBuffer> {
  const content = `BT /F1 12 Tf 20 250 Td ${lines
    .map((line) => `<${toIdentityHex(line)}> Tj 0 -14 Td`)
    .join(' ')} ET`;

  const objects: PdfObject[] = [
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      n: 3,
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    {
      n: 4,
      body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    },
    {
      n: 5,
      body:
        '<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H ' +
        '/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>',
    },
    {
      n: 6,
      body:
        '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /TestCJK ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
        '/FontDescriptor 7 0 R /DW 1000 >>',
    },
    {
      n: 7,
      body:
        '<< /Type /FontDescriptor /FontName /TestCJK /Flags 4 ' +
        '/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 ' +
        '/CapHeight 700 /StemV 80 >>',
    },
    {
      n: 8,
      body: `<< /Length ${IDENTITY_TO_UNICODE_CMAP.length} >>\nstream\n${IDENTITY_TO_UNICODE_CMAP}\nendstream`,
    },
  ];

  return assemblePdf(objects);
}

/** 生成一个非 PDF 的普通文件字节。 */
export function buildNotPdf(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode('this is definitely not a pdf file');
}
