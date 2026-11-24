# 素材检索与 CSV 导出

- Fork：https://github.com/zihan12ai/AI-Engineer-Quiz
- 分支：`feature/asset-search-export`
- 主需求：Issue #3；最终提交 SHA 可用 `git rev-parse HEAD` 获取，以功能 PR 的 head 为准。
- 登录缺陷已通过 Issue #1 / PR #2 独立修复并合并，保留了原始提交历史。

## 运行（Windows PowerShell）

需要 Python 3.10+；以下推荐 Python 3.12。Node.js 22+ 仅用于前端测试。

```powershell
uv venv --python 3.12
uv pip install -e '.[dev]'
$env:KEEPSTACK_AI_ENABLED="false"
$env:KEEPSTACK_OCR_ENABLED="false"
uv run --no-sync python -m keepstack seed-search
uv run --no-sync python -m keepstack
```

打开 http://localhost:8000，新数据库默认账号为 `admin` / `admin`。
已有虚拟环境可直接运行 `.\.venv\Scripts\python.exe -m keepstack`。
Linux/macOS 使用 `export KEEPSTACK_AI_ENABLED=false` 和 `export KEEPSTACK_OCR_ENABLED=false` 设置环境变量。

`seed-search` 自动生成 36 个图片素材及 `Search acceptance demo` 集合，含中文、逗号、引号、换行和相同创建时间。
重复执行会刷新这批演示素材的元数据和标签，不重复添加素材或集合；其他素材不受影响。
原有 `python -m keepstack seed` 仍可生成上游演示数据。数据库、素材、凭据和虚拟环境均不提交。

## 页面验收

1. 搜索 `harbor`，选择 `Search acceptance demo` 集合。
2. 左侧标签默认 Any（灰色）；点击一次变为 Include（绿色），再点击变为 Exclude（红色），再点击回到 Any。
3. 将 `approved`、`campaign` 设为 Include，将 `internal` 设为 Exclude。应有 **25 条**结果：第一页 24 条，第二页 1 条。
4. 切换创建时间升序/降序；修改任何筛选或排序都会回到第一页。条件摘要可逐个删除，也可 Clear filters。
5. 在任一页点击 Export all matches · CSV，应导出 **25 条数据及表头**，顺序与列表一致。
6. 用原有详情编辑入口修改标题、描述、添加或删除标签，再搜索或导出，确认新内容生效。

关键词、集合、素材类型及标签均可自由选择，示例值没有写死在筛选逻辑中。
标签统计是整个 active 素材库的统计，已标为 catalog totals，不代表当前匹配数。

## API

- `GET /api/assets`：`q`、`collection_id`、`media_type`、重复的 `include_tag` / `exclude_tag`、`sort=newest|oldest`、`limit=1..200`、`offset>=0`。
- `GET /api/assets/export.csv`：复用相同条件和排序，忽略分页参数。
- 两者沿用 Bearer token 鉴权；只允许 `active` 状态和关键词模式；语义搜索入口已隐藏。
- 保留旧 `tag` 参数，以及 `name` / `largest` 排序的 API 兼容性；页面仅提供题目要求的时间排序。
- 标签按完整名称并沿用小写规范匹配。包含取交集、排除取并集；重复标签去重，包含/排除冲突自然返回空集。
- 空白关键词不限制；仅标点输入没有可检索词，返回空集；其余沿用原有 FTS5 字段、前缀查询及 porter/unicode61 分词。

CSV 使用 UTF-8 BOM、标准 CSV 引号转义，`tags` 字段为按名称排序的 **JSON 字符串数组**，可无损表达含逗号或引号的标签。
字段包含 `uuid,title,description,filename,media_type,tags,created_at`；空结果仍返回表头。

## 验证

```powershell
uv run --no-sync python -m pytest -q
node --test tests/login.test.cjs tests/search.test.cjs
git diff --check
```

API 测试在独立临时数据库中自动构造 37 个确定性素材，覆盖组合条件、精确标签、重复/冲突标签、已归档/删除素材排除、双向排序、多页及相同时间、导出一致性、CSV 字符处理、非法参数、鉴权、元数据和标签编辑。
另验证 `seed-search` 的重复执行及 25 条跨页结果。
前端测试执行实际 `web/app.js`，用模拟 DOM / Fetch 验证登录、翻页与条件重置、旧请求和防抖竞态、失败重试、导出参数与下载失败提示。
CI 在 Python 3.10 / 3.12 下运行后端和 Node.js 22 前端测试。

本地实测：Python **45 passed, 2 skipped**（未安装可选的 OCR / 本地视觉模型）；Node 前端 **10 passed**。
存在原有 FastAPI startup 与当前 Starlette/httpx 的弃用警告，不影响结果。

可选的真实浏览器验收（安装 Chrome 或 Edge，运行演示数据及服务后）：

```powershell
node tests/browser_smoke.cjs
```

脚本实际提交登录表单、点击三态标签、按时间排序、翻页，并验证浏览器下载的 CSV 有全部 25 条数据且顺序正确。
标签始终按名称排列；连续切换状态不会将已选标签移到顶部，并保留手机标签列表的滚动位置。顶部条件芯片仍点击即移除。
还通过原有详情页保存标题/描述、添加与删除标签，验证下一次查询及 CSV 的变化，再恢复演示元数据。
本地 Chrome 验收已通过，390px 手机宽度无水平溢出。可通过 `CHROME_PATH` 指定浏览器路径，`KEEPSTACK_URL` 指定服务地址。
脚本仅用于演示目录，短暂修改演示素材；CSV 和独立浏览器配置保留在系统临时目录，截图写入 `docs/screenshots/`。

截图：[筛选结果](docs/screenshots/search-filters.png)、[第二页](docs/screenshots/search-page-two.png)、[手机布局](docs/screenshots/search-mobile.png)。

## 取舍与范围

- 保留现有技术栈，无新增运行时依赖。列表、总数和导出共用 SQL 条件构建器，用 EXISTS 避免标签连接产生重复素材或参数错位。
- 时间排序追加唯一 ID，确保数据不变时分页稳定。前端结合 AbortController 和请求序号，在输入防抖开始时就使旧请求失效。
- 沿用 offset 分页；不提供跨请求数据快照，与题目验收范围一致。
- CSV 同步生成并在内存中组装，适合本题数据规模；超大目录需要后续评估流式或异步导出。
- 全部标签均可选，统计不随筛选联动；未增加模型接入或在线部署。
- 原有 FastAPI startup 弃用警告，以及范围外的分享链接、用户/集合创建等入口的请求方法问题，未在本次扩展。
