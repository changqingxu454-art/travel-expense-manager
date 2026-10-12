import { describe, expect, it } from 'vitest';
import { parseInvoiceText } from '../utils/invoiceParser';

/**
 * 全部测试文本均为**虚构的脱敏样例**，不包含任何真实发票或个人财务信息。
 */

/** 模板一：标准增值税电子普通发票（含表体合计与价税合计）。 */
const TEMPLATE_STANDARD = [
  '增值税电子普通发票',
  '发票代码 011002000311',
  '发票号码 12345678',
  '开票日期 2026年03月15日',
  '购买方信息 名称:某某科技有限公司 统一社会信用代码:91110000XXXXXXXX',
  '销售方信息 名称:北京某某酒店管理有限公司 统一社会信用代码:91110105YYYYYYYY',
  '项目名称 规格型号 单位 数量 单价 金额 税率 税额',
  '*住宿服务*住宿费 1 100.00 100.00 6% 6.00',
  '合计 ¥100.00 ¥6.00',
  '价税合计(大写)壹佰零陆元整 (小写)¥106.00',
].join('\n');

/** 模板二：全电发票（数电票）风格，无发票代码，字段标签为半角冒号。 */
const TEMPLATE_EDIGITAL = [
  '电子发票(普通发票)',
  '发票号码:24312000000123456789',
  '开票日期:2026-04-02',
  '销售方名称:上海某某餐饮管理有限公司',
  '项目名称 金额 税额',
  '餐饮服务 200.00 12.00',
  '合计金额 200.00',
  '合计税额 12.00',
  '价税合计(小写)¥212.00',
].join('\n');

/** 模板三：全角标点与千位分隔符。 */
const TEMPLATE_FULLWIDTH = [
  '增值税电子普通发票',
  '发票号码：87654321',
  '开票日期：2026年5月20日',
  '销售方名称：广州某某酒店有限公司',
  '价税合计（小写）￥1,234.50',
].join('\n');

describe('parseInvoiceText', () => {
  it('解析标准模板：发票号码、日期、销售方与价税合计', () => {
    const result = parseInvoiceText(TEMPLATE_STANDARD);
    expect(result.status).toBe('parsed');
    expect(result.fields.invoiceNumber).toBe('12345678');
    expect(result.fields.issuedAt).toBe('2026-03-15');
    expect(result.fields.sellerName).toBe('北京某某酒店管理有限公司');
    // 价税合计 106.00 元 = 10600 分
    expect(result.fields.totalCents).toBe(10600);
    expect(result.needsReview).toEqual([]);
  });

  it('区分税额、不含税金额与价税合计', () => {
    const result = parseInvoiceText(TEMPLATE_STANDARD);
    expect(result.fields.totalCents).toBe(10600);
    expect(result.fields.amountWithoutTaxCents).toBe(10000);
    expect(result.fields.taxCents).toBe(600);
    // 价税合计不得被表体中的第一个金额（100.00）取代
    expect(result.fields.totalCents).not.toBe(10000);
  });

  it('价税合计与税额同时存在时不互相混淆', () => {
    const result = parseInvoiceText(TEMPLATE_EDIGITAL);
    expect(result.fields.totalCents).toBe(21200);
    expect(result.fields.amountWithoutTaxCents).toBe(20000);
    expect(result.fields.taxCents).toBe(1200);
    expect(result.fields.invoiceNumber).toBe('24312000000123456789');
    expect(result.fields.issuedAt).toBe('2026-04-02');
    expect(result.fields.sellerName).toBe('上海某某餐饮管理有限公司');
  });

  it('兼容全角标点与带千位分隔符的金额', () => {
    const result = parseInvoiceText(TEMPLATE_FULLWIDTH);
    expect(result.fields.invoiceNumber).toBe('87654321');
    expect(result.fields.issuedAt).toBe('2026-05-20');
    expect(result.fields.sellerName).toBe('广州某某酒店有限公司');
    // 1,234.50 元 = 123450 分
    expect(result.fields.totalCents).toBe(123450);
  });

  it('优先取「价税合计」而不是文本中出现的第一个金额', () => {
    const text = [
      '发票号码 11112222',
      '开票日期 2026年01月01日',
      '销售方名称 某某供应商',
      '单价 9.90',
      '金额 9.90',
      '税额 0.10',
      '价税合计(小写)¥10.00',
    ].join('\n');
    const result = parseInvoiceText(text);
    expect(result.fields.totalCents).toBe(1000);
  });

  it('缺失发票号码时标记为待核对，且不虚构号码', () => {
    const text = [
      '开票日期 2026年03月15日',
      '销售方名称 某某酒店',
      '价税合计(小写)¥106.00',
    ].join('\n');
    const result = parseInvoiceText(text);
    expect(result.status).toBe('partial');
    expect(result.fields.invoiceNumber).toBeUndefined();
    expect(result.needsReview).toContain('invoiceNumber');
  });

  it('缺失金额时 totalCents 保持 undefined，绝不填 0', () => {
    const text = [
      '发票号码 12345678',
      '开票日期 2026年03月15日',
      '销售方名称 某某酒店',
    ].join('\n');
    const result = parseInvoiceText(text);
    expect(result.fields.totalCents).toBeUndefined();
    expect(result.needsReview).toContain('totalCents');
    expect(result.status).toBe('partial');
    expect(result.message).toContain('价税合计');
  });

  it('日期格式异常时不写入日期并标记待核对', () => {
    const text = [
      '发票号码 12345678',
      '开票日期 2026年13月45日',
      '销售方名称 某某酒店',
      '价税合计(小写)¥106.00',
    ].join('\n');
    const result = parseInvoiceText(text);
    expect(result.fields.issuedAt).toBeUndefined();
    expect(result.needsReview).toContain('issuedAt');
  });

  it('金额存在歧义时标记待核对且不选任一取值', () => {
    const text = [
      '发票号码 12345678',
      '开票日期 2026年03月15日',
      '销售方名称 某某酒店',
      '价税合计(大写)壹佰零陆元整 (小写)¥106.00',
      '价税合计(小写)¥199.00',
    ].join('\n');
    const result = parseInvoiceText(text);
    expect(result.fields.totalCents).toBeUndefined();
    expect(result.needsReview).toContain('totalCents');
    expect(result.status).toBe('partial');
  });

  it('无法识别的文本返回 unrecognized 与可理解提示', () => {
    const result = parseInvoiceText('这是一段与发票无关的普通文本。');
    expect(result.status).toBe('unrecognized');
    expect(result.recognized).toEqual([]);
    expect(result.needsReview).toContain('totalCents');
    expect(result.message).toContain('手动录入');
  });

  it('空文本返回 unrecognized 而不是抛异常', () => {
    const result = parseInvoiceText('   ');
    expect(result.status).toBe('unrecognized');
    expect(result.fields).toEqual({});
  });

  it('是纯函数：相同输入得到相同结果且不修改输入', () => {
    const input = TEMPLATE_STANDARD;
    const first = parseInvoiceText(input);
    const second = parseInvoiceText(input);
    expect(first).toEqual(second);
    expect(input).toBe(TEMPLATE_STANDARD);
  });
});
