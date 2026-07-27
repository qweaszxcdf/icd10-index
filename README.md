# icd10-index

参考 [`qweaszxcdf/icd9cm3-index`](https://github.com/qweaszxcdf/icd9cm3-index) 的树形检索与 Cloudflare Worker 部署方式，为中国版 ICD-10 第三卷字母顺序索引 CSV 构建的只读检索站点。

本版本为**完全 Node.js 实现**：CSV 解析、字段清洗、树结构重建、数据集生成、测试及 Cloudflare Worker 均不依赖 Python。

## 功能

- 中文、英文、ICD-10 编码检索。
- 所有 level 都会计算 `parent_index` 和 `subtree_end`，因此 `level 0`、`level 1` 也可以展开；检索结果补齐父级时从 `level 2` 开始，不显示 level 0/1 作为检索层级。
- 完全忽略 CSV 原有的 `parent`、`subtreeEnd` 值。
- 搜索结果自动携带祖先路径。
- 子节点通过 `/api/children` 按需加载。
- 支持浏览整个索引、展开全部、折叠全部。
- 主编码及肿瘤表五类编码均可点击。
- 编码跳转地址：`https://icd10.pages.dev/?code=<编码>`。
- 保留 OCR `confidence`。
- 支持原发恶性、继发恶性、原位、良性、性质未定或未特指五列。
- 兼容 `**in_situ`、`**benign` 等带 Markdown 星号的表头。
- `*`、`**`、破折号等占位值自动作为空值处理。
- 生成构建审计报告，记录层级跳跃及孤立节点。
- 每个词条提供反馈按钮，并支持全局“缺少词条”反馈。
- 反馈通过 Worker `/api/feedback` 写入统一 Cloudflare D1 `feedback` 表，以 `project_key=icd10-index` 区分项目。

## 环境要求

- Node.js 20 或更高版本
- npm
- Cloudflare 部署时需要 Wrangler；执行 `npm install` 会安装项目声明的 Wrangler。

数据构建和测试只使用 Node.js 内置模块，不需要安装额外 CSV 解析库。

## CSV 格式

推荐表头：

```csv
image_page,level,chinese,english,code,confidence,malignant_primary,malignant_secondary,in_situ,benign,uncertain_or_unspecified,parent,subtreeEnd
```

示例：

```csv
35,0,A,,,,,,**,**,,,4644
35,1,ā 阿,,,0.9999596476554871,,,**,**,,0,83
35,2,阿-德综合征[垂体功能减退症][阿乌马达-德尔卡斯蒂洛],Ahumada-del Castillo syndrome,E23.0,0.9468976855278015,,,**,**,,1,3
```

最后两列可以保留，但不会读取。树结构仅由 CSV 行顺序和 `level` 决定，并采用以下规则：

1. `level 0`、`level 1` 保留在数据集中，并按行顺序作为可展开的展示父级。
2. `level 2` 及以上按最近的、更浅的前驱节点建立展示树。
3. 搜索结果补齐父级时，`level 0`、`level 1` 不会被加入结果树；搜索命中它们时仍可单独显示。

兼容的表头别名包括：

| 标准字段 | 可兼容名称 |
|---|---|
| `image_page` | `page`、`imagepage` |
| `level` | `indent`、`depth` |
| `chinese` | `zh`、`cn`、`中文` |
| `english` | `en`、`英文` |
| `code` | `icd`、`icd_code`、`icd10` |
| `in_situ` | `**in_situ`、`insitu`、`carcinoma_in_situ` |
| `benign` | `**benign` |

同时支持 UTF-8 BOM、CSV 引号字段、字段内逗号、字段内换行及双引号转义。

## 放入正式数据

将正式 CSV 放入：

```text
data/source/
```

建议命名：

```text
data/source/icd10_index.csv
```

如果目录中存在非 `.sample.` CSV，默认构建会自动忽略样例文件。

## 构建

```bash
cd workers
npm run build
```

也可以直接运行：

```bash
node workers/scripts/build.mjs
```

显式指定文件：

```bash
node workers/scripts/build.mjs --input data/source/icd10_index.csv
```

多个分片按顺序传入：

```bash
node workers/scripts/build.mjs \
  --input data/source/part-001.csv \
  --input data/source/part-002.csv
```

输出易读 JSON：

```bash
node workers/scripts/build.mjs --pretty
```

## 生成文件

```text
workers/public/index.html
workers/public/static/app.js
workers/public/static/style.css
workers/public/data/dataset.json
workers/public/data/build-report.json
```

紧凑数据行结构：

```text
image_page, level, chinese, english, code, confidence,
malignant_primary, malignant_secondary, in_situ, benign,
uncertain_or_unspecified, source_file_index, search_blob,
normalized_codes, parent_index, subtree_end
```

`subtree_end` 使用半开区间，即某节点完整子树范围为：

```text
[row_index, subtree_end)
```

## 本地运行

```bash
cd workers
npm install
npm run dev
```

## Cloudflare D1 反馈数据库

本项目复用统一的 `feedback` 表，表结构位于：

```text
schema.sql
migrations/0001_feedback.sql
```

`workers/wrangler.jsonc` 默认使用参考项目中的共享 D1 数据库：

```json
{
  "binding": "DB",
  "database_name": "feedback",
  "database_id": "f755b043-bb86-4ea8-ae8c-e56991814433"
}
```

该数据库已初始化时无需重复执行。首次初始化可运行：

```bash
cd workers
npm install
npm run db:init:remote
```

如果部署到其他 Cloudflare 账户，请创建自己的数据库并替换 `database_id`：

```bash
npx wrangler d1 create feedback
npm run db:init:remote
```

## 部署到 Cloudflare Workers

```bash
cd workers
npm install
npx wrangler login
npm run deploy
```

项目使用 Workers Static Assets：

- `/api/*` 由 Worker 处理。
- HTML、CSS、JavaScript 和数据集作为静态资源部署。
- Worker 首次请求时从 `ASSETS` 加载 `dataset.json` 并缓存解析结果。
- 大型数据集不会直接打包进 Worker JavaScript。

可以在 `workers/wrangler.jsonc` 中修改 Worker 名称和路由配置。

## API

### 搜索

```http
GET /api/search?q=E23.0&mode=auto
```

`mode` 可选值：

- `auto`：自动判断编码或文本。
- `code`：强制按编码前缀匹配。
- `phrase`：按完整输入短语匹配。

空查询返回根节点：

```http
GET /api/search?q=&mode=auto
```

### 加载直接子节点

```http
GET /api/children?id=r1&q=阿&mode=auto
```

### 定位引用项

```http
GET /api/locate?target=Ahumada-del%20Castillo%20syndrome
```

### 数据集元信息

```http
GET /api/meta
```

### 提交反馈

```http
POST /api/feedback
Content-Type: application/json
```

请求示例：

```json
{
  "feedbackType": "层级错误",
  "proposedValue": "调整到目标词条下",
  "message": "该词条应当作为另一词条的子项。",
  "contact": "",
  "url": "https://example.com/?q=测试",
  "record": {
    "index": 123,
    "image_page": 35,
    "level": 3,
    "chinese": "测试词条",
    "code": "E23.0"
  }
}
```

## 测试

无需安装 Wrangler，即可执行 Node 构建和测试：

```bash
node workers/scripts/build.mjs
node --test tests/build.test.mjs tests/worker.test.mjs
node --check workers/scripts/build.mjs
node --check workers/src/index.js
node --check workers/public/static/app.js
```

安装 npm 依赖后也可以：

```bash
cd workers
npm run check
```

## 项目结构

```text
icd10-index/
├── data/
│   └── source/
│       └── icd10_index.sample.csv
├── migrations/
│   └── 0001_feedback.sql
├── schema.sql
├── static/
│   ├── app.js
│   └── style.css
├── templates/
│   └── index.html
├── tests/
│   ├── build.test.mjs
│   └── worker.test.mjs
└── workers/
    ├── scripts/
    │   └── build.mjs
    ├── src/
    │   └── index.js
    ├── public/
    ├── package.json
    └── wrangler.jsonc
```

## 树结构重建规则

构建器使用栈进行单次顺序扫描，但层级计算从 `level 2` 开始：

1. 遇到 `level 0` 或 `level 1` 时，关闭此前尚未结束的 `level 2+` 子树；该行自身保持独立，不入栈。
2. `level 2` 行始终作为树根，不能挂到 `level 0` 或 `level 1` 下。
3. `level 3+` 的父节点取最近一个更浅的 `level 2+` 前驱节点。
4. 遇到同层或更浅层的 `level 2+` 节点时，关闭栈顶节点的子树。
5. 层级跳跃或缺少有效父节点时写入构建警告，但仍生成可用数据。
6. CSV 中已有的 `parent`、`subtreeEnd` 始终忽略。

因此，字母标题和首字头行不会污染疾病索引的真实父子关系。
