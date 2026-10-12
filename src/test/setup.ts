import '@testing-library/jest-dom/vitest';
// jsdom 未内置 IndexedDB，这里注入内存实现，使数据访问层测试使用真实事务语义。
import 'fake-indexeddb/auto';
