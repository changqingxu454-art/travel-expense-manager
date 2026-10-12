# 差旅小账本（travel-expense-manager）

个人差旅发票管理网页应用。部署在 GitHub Pages，主要在手机浏览器中使用。

**所有数据（出差记录、发票元数据、发票 PDF）都保存在浏览器本地的 IndexedDB 中，不会上传到任何服务器。**

## 技术栈

| 领域     | 选型                                   |
| -------- | -------------------------------------- |
| 构建     | Vite 5                                 |
| 框架     | React 18 + TypeScript（strict）        |
| 本地存储 | IndexedDB（原生 API，无后端）          |
| PDF 解析 | PDF.js（`pdfjs-dist`，浏览器本地提取） |
| 测试     | Vitest 2 + jsdom + Testing Library     |
| 路由     | 基于 `location.hash` 的轻量路由        |

金额一律以 **整数分** 保存（见 `Cents` 类型），避免浮点误差。

## 当前阶段范围

本阶段只完成**项目初始化与骨架**：

**阶段一（已完成）**：Vite + React + TS 工程、目录规划、统一类型与错误约定、页面骨架、IndexedDB 初始化、GitHub Pages 部署配置。

**阶段二（已完成）**：

- ✅ 餐标计算 `calculateMealBudget`（纯函数，返回 `Result`）
- ✅ 出差记录 CRUD `tripService`（真实写入 IndexedDB，含校验与错误处理）
- ✅ 首页概览、出差列表、出差详情与新建/编辑表单
- ✅ 删除二次确认；删除时阻止遗留失效的发票关联

**阶段三（已完成）**：

- ✅ PDF 文本提取 `pdfService`（PDF.js，本地解析，支持多页、扫描件、加密与损坏文件）
- ✅ 发票文本解析 `parseInvoiceText`（纯函数，区分价税合计/税额/不含税金额，歧义字段交人工核对）
- ✅ 发票 CRUD、关联/解除关联、疑似重复检查、文件引用清理（`invoiceService`）
- ✅ 发票管理页：上传解析、核对编辑、手动录入、筛选、关联与删除
- ✅ 出差详情页展示关联发票
- ✅ PDF.js 按需加载（首屏不加载 366 KB 的解析器）

**尚未实现（后续阶段）**：

- ❌ 餐补与实际发票统计的最终整合：详情页「已使用金额」仍固定为 ¥0.00，并明确标注「暂未接入发票统计」
- ❌ 扫描版/图片型发票的 OCR 识别（当前明确提示不支持，只提供手动录入）
- ❌ 导出/导入备份

## 目录结构

```
travel-expense-manager/
├── .github/workflows/deploy.yml  # GitHub Pages 自动部署
├── public/                       # 原样拷贝到 dist 的静态资源
│   ├── favicon.svg
│   ├── .nojekyll                 # 关闭 Jekyll，保证 _ 开头文件正常发布
│   └── icons/
├── src/
│   ├── components/               # 可复用的展示型公共组件
│   │   ├── AppLayout.tsx         # 全局页面骨架
│   │   ├── BottomNavigation.tsx  # 移动端底部导航（hash 链接）
│   │   ├── ConfirmDialog.tsx     # 二次确认弹窗
│   │   └── EmptyState.tsx        # 统一空状态
│   ├── pages/                    # 路由页面，只负责组合 UI，不写业务计算
│   │   ├── Dashboard.tsx         # 首页概览
│   │   ├── Trips.tsx             # 出差列表
│   │   ├── TripDetail.tsx        # 出差详情
│   │   └── Invoices.tsx          # 发票管理
│   ├── features/                 # 按业务域划分的功能模块
│   │   ├── trips/                # 出差管理（校验、表单、汇总、数据 hook）
│   │   ├── budget/               # 餐标计算（规则已落入 utils/budget.ts）
│   │   └── invoices/             # 发票校验、表单与列表数据 hook
│   ├── services/                 # 数据访问层：唯一允许接触 IndexedDB / PDF.js 的地方
│   │   ├── db.ts                 # IndexedDB 连接、schema 迁移与事务辅助
│   │   ├── tripService.ts        # 出差记录 CRUD
│   │   ├── invoiceService.ts     # 发票 CRUD、关联、去重与文件清理
│   │   └── pdfService.ts         # PDF.js 文本提取（按需加载）
│   ├── utils/                    # 纯函数：可独立单测，不依赖 DOM
│   │   ├── budget.ts             # 金额格式化、元/分转换与餐标计算
│   │   ├── date.ts               # 日期解析与格式化
│   │   ├── invoiceParser.ts      # 发票文本解析（纯函数）
│   │   └── errors.ts             # AppError / NotImplementedError / Result 工具
│   ├── types/                    # 全局类型定义（Trip、Invoice、MealBudget、Cents 等）
│   ├── test/                     # 单元测试、UI 测试与测试环境配置（fake-indexeddb、PDF 夹具）
│   ├── App.tsx                   # hash 路由与页面装配
│   ├── main.tsx                  # 应用入口
│   └── styles/global.css         # 全局样式（移动优先）
├── index.html
├── package.json
├── vite.config.ts                # Vite + Vitest + GitHub Pages base 配置
├── tsconfig.json
└── .gitignore
```

### 分层约定

- **页面 / 组件**：只做渲染与交互，不直接访问 IndexedDB，也不做金额与日期计算。
- **features**：某一业务域的表单、校验与展示组件；可依赖 services 与 utils。
- **services**：数据读写与文件解析。
- **utils**：无副作用的纯函数，必须可被 Vitest 直接测试。
- **types**：只放类型与常量。

### 错误处理约定

- **纯函数**（餐标计算、金额解析）返回 `Result<T>`，用 `ok` / `fail` 表达可预期的业务失败，不抛异常。
- **异步数据访问**（tripService 等）抛出带稳定 `code` 的 `AppError`，页面捕获后用 `toErrorInfo` 展示可读提示。
- **未实现的模块**抛出 `NotImplementedError`，绝不返回假数据或虚假成功。

### 删除出差记录的引用完整性策略

采用「**阻止删除**」策略：`removeTrip` 会先通过 IndexedDB 的 `by_tripId` 索引统计关联发票
（`countRelatedInvoices`）。若存在关联发票，则抛出 `TRIP_HAS_INVOICES` 并中止删除，
既不会静默留下失效的 `tripId`，也不会擅自解除用户未确认的关联。

### IndexedDB schema 与迁移

| 版本 | 变更 |
| ---- | ---- |
| 1 | `trips`（`by_startDate`）、`invoices`（`by_tripId`、`by_issuedAt`）、`invoiceFiles` |
| 2 | 在既有 `invoices` 上**新增索引** `by_category`、`by_status`、`by_fileId` |

版本 2 **没有**新增/删除对象仓库，也没有改动主键，因此升级不会丢失数据：
`createSchema` 在升级事务中对已存在的仓库幂等地补建索引，IndexedDB 会为既有记录自动建立索引，
不涉及删除或重建数据库。迁移兼容性由 `src/test/invoiceService.test.ts` 中构造真实 v1 数据库的测试覆盖。

### 发票元数据与文件的一致性

`createInvoice` 在**同一个事务**（`withTransaction(['invoices','invoiceFiles'])`）中写入元数据与
PDF 文件：任一步失败都会整体回滚，不会出现「元数据保存成功但文件不存在」的情况；测试通过让事务
抛错验证了两边都未落库。删除时 `removeInvoice` 先用 `by_fileId` 统计引用数，只有该文件不再被其它
发票引用时才在同一事务中清理，避免留下孤儿文件或误删共享文件。

`fileId` 由 `invoiceService` 生成和维护，不接受外部传入，因此不会产生指向不存在文件的悬空引用。

## 本地开发

需要 Node.js 18+（推荐 20+）。

```bash
npm install       # 安装依赖
npm run dev       # 启动开发服务器，默认 http://localhost:5173/
```

手机预览：手机与电脑连同一局域网，访问 Vite 输出的 Network 地址即可。

## 测试与构建

```bash
npm run typecheck   # TypeScript 类型检查（tsc --noEmit）
npm test            # 运行全部单元测试（vitest run）
npm run test:watch  # 监听模式
npm run build       # 类型检查 + 生产构建，产物在 dist/
npm run preview     # 本地预览 dist/ 产物
```

提交前请确保 `npm run typecheck`、`npm test`、`npm run build` 三者均通过。

## 部署到 GitHub Pages

已内置 `.github/workflows/deploy.yml`：推送到 `main` 后自动执行「安装 → 类型检查 → 测试 → 构建 → 发布」。

### 部署注意事项

1. **base 路径必须与仓库名一致。** 项目站点地址形如
   `https://<用户名>.github.io/<仓库名>/`。`vite.config.ts` 中的 `repoName` 当前为
   `travel-expense-manager`；**若仓库名不同，务必修改该常量**，否则 JS/CSS 会 404（页面空白）。
   - 若部署到用户站点仓库（`<用户名>.github.io`）或使用自定义域名，应把 `base` 改为 `'/'`。
2. **开启 Pages。** 在仓库 `Settings → Pages → Build and deployment` 中把 `Source` 设为
   **GitHub Actions**。
3. **SPA 刷新不会 404。** 路由使用 `location.hash`（如 `#/trips`），服务器只需托管静态文件即可，
   无需 404 重写规则。
4. **`.nojekyll` 已内置**在 `public/` 中，用于关闭 Jekyll 处理。
5. **不要提交个人数据。** 发票与账目只存在于浏览器 IndexedDB，`.gitignore` 已排除 `.env*` 等文件；
   请勿把真实的发票或个人财务文件放进仓库。
6. **数据不会随部署迁移。** 用户换设备、换浏览器或清除站点数据后，IndexedDB 中的内容都会丢失，
   后续如需备份应提供「导出/导入」功能。
7. **PDF.js worker 会自动带上 base。** worker 通过 Vite 的 `?url` 资源引用，
   构建后会输出为 `dist/assets/pdf.worker.min-*.mjs` 并携带正确的 base 前缀，
   因此子路径部署无需额外配置；`pdfService` 被拆分为独立 chunk 按需加载。

## 后续计划

1. 用真实发票统计替换详情页中固定的「已使用金额 = ¥0.00」，完成餐补与发票的整合。
2. 按目的地细化餐标规则（如分城市档位）。
3. 提供导出/导入备份（IndexedDB 数据不随部署迁移）。
4. 如需支持扫描版发票，可评估接入本地 OCR（仍不得上传用户文件）。

## 测试与已知限制

- `fake-indexeddb` **不会**像真实浏览器那样按结构化克隆保存 `Blob`，读回的 blob 是普通对象。
  因此服务层测试只校验「文件记录存在 + 元数据正确 + fileId 对应关系」，
  文件内容的往返由浏览器原生 IndexedDB 保证。
- jsdom 没有 Web Worker，PDF 测试通过直接 import worker 模块让 PDF.js 使用主线程 worker，
  执行的是真实的解析流程；测试夹具包含一个 Type0 字体 + 恒等 ToUnicode CMap 的 PDF，
  可承载中文文本用于端到端验证。
- 解析器目前覆盖的是常见的增值税电子发票/全电发票文本模板；模板差异过大时字段会进入
  「待核对」，不会写入猜测值。
