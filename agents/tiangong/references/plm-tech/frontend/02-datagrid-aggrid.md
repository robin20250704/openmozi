# 前端实现规格 · 数据网格（AG Grid）

> 本文件是 `docs/plm-tech/08-前端实现规格.md`（索引）的子文件之一，承载**原 §4** 的正文。
> **章节编号保持原样**（保号）：原文档里的 `§5.4`、`§6.14` 等引用在本文件内一一对应，不必换算。
> **§4.8 ~ §4.10 为 B4 新增**（表格页默认排序的落点 / 通用只读甘特组件 `GanttChart` / 只读视图页侧责任清单），
> **§4.11 为批次54 新增**（列表批量动作与选择列范式）——
> 按索引 §五 规则 3「新增章节按该文件承载的原编号序列续号」，仍续 **§4** 号段，**不占用正文 §6.x 号段**。
> 索引（含章节号 → 子文件映射表）：[`../08-前端实现规格.md`](../08-前端实现规格.md)。

---
## 4. AG Grid 配置与主题

### 4.1 容器

```html
<div className="grid-wrap ag-theme-alpine">
  <AgGridReact ... />
</div>
```

> **关键**：`ag-theme-alpine` class **必须在容器 div 上**（`AgGridReact` v33 React 不自动添加）。缺失则所有主题 CSS 变量和 `.ag-theme-alpine` 前缀规则不生效。

```css
.grid-wrap { height:500px; background:#fff; border-radius:8px; overflow:visible; border:1px solid --border; }
```

`overflow:visible` 放行筛选菜单/下拉编辑器浮层；网格主体圆角裁切由 `.ag-root-wrapper { border-radius:8px; overflow:hidden }` 负责。

### 4.2 主题变量

| 变量                                   | 值         |
| ------------------------------------ | --------- |
| `--ag-foreground-color`              | `#1e293b` |
| `--ag-background-color`              | `#ffffff` |
| `--ag-odd-row-background-color`      | `#fbfcff` |
| `--ag-header-background-color`       | `#f8fafc` |
| `--ag-header-foreground-color`       | `#64748b` |
| `--ag-row-hover-color`               | `#f0f7ff` |
| `--ag-selected-row-background-color` | `#faf5ff` |
| `--ag-accent-color`                  | `#7c3aed` |
| `--ag-font-size`                     | `12.5px`  |
| `--ag-row-height`                    | `32px`    |
| `--ag-header-height`                 | `28px`    |

### 4.3 图标字体

```css
.ag-icon { font-family: agGridAlpine, sans-serif !important; }
```

> 全局规则（不带 `.ag-theme-alpine` 前缀），否则图标渲染为方框。

### 4.4 筛选面板

- 每列单独设 `filterParams: { buttons: ['reset', 'clear', 'apply'], maxNumConditions: 2 }`。
- `defaultColDef.filterParams` **不被 AG Grid v33 继承**——必须在每列上单独设。
- 关联列（id→name `valueFormatter`）设 `filter: false`（text filter 对原始 id 过滤，输入显示名不匹配）。
- 面板白底+阴影+边框：`.ag-menu { background:#fff; border:1px solid #e2e8f0; box-shadow:0 8px 24px rgba(15,23,42,.16); z-index:3000 }`。
- **勿设** `overflow:visible`——会覆盖面板高度自适应，导致按钮溢出隐藏。

### 4.5 浮层 z-index

所有 AG Grid 浮层（`.ag-popup` / `.ag-menu` / `.ag-select-list`）：`z-index: 3000`。

### 4.6 网格行为

| 配置                              | 值                                                | 说明              |
| ------------------------------- | ------------------------------------------------ | --------------- |
| `rowSelection`                  | `'single'`                                       | 单行选中            |
| `suppressRowClickSelection`     | `false`                                          | 点击行即选中          |
| `animateRows`                   | `true`                                           | 行动画             |
| `stopEditingWhenCellsLoseFocus` | `true`                                           | 失焦即停止编辑         |
| `defaultColDef`                 | `{ sortable:true, resizable:true, filter:true }` | 全列可排序/缩放/筛选     |
| `onCellFocused`                 | → `setSelected(data)`                            | **焦点行切换同步详情面板** |

### 4.7 网格交互与联动机制（参考：需求表格 `RequirementsPage.tsx`）

本节定义 AG Grid 表格的**完整交互链路**——从键盘/鼠标操作到详情面板联动到数据持久化。所有含"表格 + 详情面板"的页面（需求管理、用户管理、后续项目/风险/文档域）**必须遵循此机制**。

#### 4.7.1 Enter 进入单元格编辑

```
前置：列定义 editable: true + gridOptions.stopEditingWhenCellsLoseFocus: true
→ AG Grid 内建行为：
  1. 用户用鼠标点击或 ↑↓ 键将焦点移到某单元格
  2. 按 Enter → 进入该单元格编辑（text 输入框 / agSelectCellEditor 下拉）
  3. 编辑完按 Enter → 确认修改，焦点移到下一行同列（enterMovesDownAfterEdit 默认 true）
  4. 按 Esc → 取消编辑，恢复原值
  5. 点击其他单元格 → stopEditingWhenCellsLoseFocus 触发，自动提交编辑
```

- **可编辑列**用 `editable: true` 标记；**只读列**（如编号、状态、版本）不设。
- **下拉编辑**：`cellEditor: 'agSelectCellEditor'` + `cellEditorParams: { values: [...] }`。
- **布尔列编辑**：用 `valueGetter`/`valueSetter` 做 boolean↔string 映射（如 `isActive`: `valueGetter: p => p.data.isActive ? '活跃' : '停用'`，`valueSetter: p => { p.data.isActive = p.newValue === '活跃'; return true; }`），配 `agSelectCellEditor` + `values: ['活跃','停用']`。

#### 4.7.2 焦点行 → 详情面板联动（核心）

```typescript
// AgGridReact 组件上注册 onCellFocused（非 gridOptions）
<AgGridReact
  onCellFocused={(e) => {
    const row = e.api.getDisplayedRowAtIndex(e.rowIndex);
    if (row?.data && (!selected || row.data.id !== selected.id)) setSelected(row.data);
  }}
/>
```

- **触发时机**：鼠标点击单元格、`↑↓` 键移动、Enter 编辑后跳行——均触发 `onCellFocused`。
- **联动逻辑**：读取焦点行的 `row.data`，若其 `id` 与当前 `selected` 不同 → `setSelected(row.data)` → React 重渲染 → 详情面板切换到新行对象。
- **效果**：键盘 `↑↓` 在网格行间移动时，详情面板**实时跟随**到当前焦点行，无需额外点击。
- **`onRowClicked`** 作为鼠标点击的补充路径（`gridOptions.onRowClicked: e => setSelected(e.data)`），与 `onCellFocused` 共存不冲突。

#### 4.7.3 内联编辑保存（onCellValueChanged）

```typescript
// gridOptions 或 AgGridReact 组件上注册
async function onCellValueChanged(e) {
  const row = e.data, field = e.colDef.field;
  if (!row || !field || !EDITABLE_FIELDS.includes(field)) return;
  const patch = {}; patch[field] = row[field];   // valueSetter 已写回 row.data
  await api.put(`/${DOMAIN}/${row.id}`, patch);
  load();   // 刷新列表，拉回服务端权威值
}
```

- 编辑确认后 AG Grid 触发 `onCellValueChanged`，取 `e.data[field]`（经 `valueSetter` 写回的值）构造 patch → `PUT` → `load()` 刷新。
- **新建行**（`_isNew` 标记）走 `POST`，返回服务端编号后替换前端临时行。
- **乐观更新**（需求页）：用 `batchWithOptimistic` 五拍提交，失败回滚；管理页（用户/角色）低频操作可直接 await + load。

#### 4.7.4 完整联动链路图

```
用户操作                    AG Grid 事件              前端状态               后端
─────────────────────────────────────────────────────────────────────────────
点击行 / ↑↓ 移动      → onCellFocused      → setSelected(row.data)  → 详情面板重渲染
按 Enter             → 进入编辑（内建）      → 单元格变输入框
编辑完 Enter / 失焦   → onCellValueChanged  → api.put(patch)        → PUT /{domain}/{id}
                     →                     → load()                → GET 刷新列表
                     →                     → setSelected(null)     → 详情面板复位
```

#### 4.7.5 参考实现

| 机制 | 源码位置 |
| --- | --- |
| `onCellFocused` 联动 | `RequirementsPage.tsx` L278-281 |
| `gridOptions`（含 `stopEditingWhenCellsLoseFocus`） | `RequirementsPage.tsx` L201-207 |
| `onCellValueChanged` 保存 | `RequirementsPage.tsx` L77-116 |
| 可编辑列定义（`editable` / `cellEditor`） | `RequirementsPage.tsx` L191-193 |
| 用户管理页同机制 | `SettingsPage.tsx`（用户管理 Tab，2026-09-05 对齐） |

#### 4.7.6 只读网格形态（2026-09-20 · 批次41 · 风险台账接入）

**规格**：网格**不标任何 `editable: true` 列**即为只读网格——行可点、可排序、可筛选、↑↓ 焦点联动详情面板，但单元格不可进入编辑。**所有编辑一律在右侧详情面板完成**（统一构件 `DetailPanel`，G-UI-2）。

- **与 §4.7.1"可编辑列内联编辑"是两种合法形态**，按域选择：字段少、单行值短、批量改同列（用户管理的显示名/状态）→ 内联编辑；字段多、有跨字段联动（S×P 等级预览）、有结构化子对象（控制措施行数组）→ 只读网格 + 详情面板。
- 当前实例：**风险台账 `/risks`**（`RiskLedgerPage.tsx`）——左侧 AG Grid 列（风险编号/标题/产品/S/P/等级/状态/验证/责任人/最近更新）全部只读；等级、控制措施、状态推进、PMS 校准都在右侧 `DetailPanel` 完成。
- 只读网格**也要** `onCellFocused` 联动（§4.7.2）与空态 overlay（复述当前筛选 + 「清空全部筛选」，§6.8）——"只读"只关编辑，不关联动与空态反馈。

---

### 4.8 表格页默认排序的落点（服务端算序）（B4 批次，2026-09-26）

**中心口径**：**默认序由服务端算**——网格、服务端分页、导出三处共用**同一份序**；客户端的表头排序只服务
"用户主动点了一下表头"这一件事（不得反过来变成"进页面时的序由前端决定"）。

| 场景 | 默认序 | 落点 |
| --- | --- | --- |
| 非结构型对象列表 | `createdAt DESC, id DESC`（G-LST-1，最新在前，`id` 作稳定决胜键） | 服务端 `ORDER BY` |
| **结构型（父子层级）列表** | **父子层级优先（真前序）+ 同级按最近更新倒序** | 递归 CTE（见下） |

**递归 CTE 口径**（结构型域共用；`TaskService.treeOrderCte` 为基准实现）：

1. `sib`：**同一父下的兄弟**用 `row_number() OVER (PARTITION BY parent_id ORDER BY updated_at DESC NULLS LAST, id)` 编排名 `rn`
   —— "同级内最近更新的排前面"被编码进**路径段**；根之间同样按 `rn` 排（`PARTITION BY parent_id` 把 NULL 视作同一组）。
2. `tree`：自根下递归，把各段 `rn` 拼成 `text[]` 路径（每段**左补零成等宽**，保证**字典序 == 数值序**），末了按路径排序。
3. **不可用 `ORDER BY parent_id NULLS FIRST` 代替**：它按**父的 id 值**分组，不是按父在结果里的**位置**——
   层级超过两层时**叔侄会交错**（`A、A.1、B、B.1` 排成 `A、B、A.1、B.1`），既不满足"父在前"，也不满足"父子优先"。
   真前序需要"从根到本行的路径"逐段比较，只有递归能算出来。
4. **不可达行必须兜住**：调用方用 **`LEFT JOIN tree` + `coalesce(path, ARRAY['~'])`** —— 父指针悬空/成环的行排到**末尾但仍然出现**；
   **内连接会让它们从列表里消失**（本批首版实测踩过）。
5. **成环保护**：递归项带已访问集合（`vis` + `NOT c.id = ANY(tr.vis)`）—— 否则历史脏数据里的环会让查询跑不完。
6. **作用域收窄**：给了 `projectId` 时 CTE **只在项目内递归**（项目内视图不该扫全库）。
7. **稳定决胜键**：路径之外还要有 `updated_at DESC NULLS LAST, id` 这类决胜键，保证翻页不漂移、深链可复算。

#### 4.8.1 判据（默认序的两条反向实例）

| 锚点 | 位置 | 断言方向（**双向**：成立与不成立都要有一条） |
| --- | --- | --- |
| 默认序 | 列表首行 | 列表首行 == **服务端算序**的头行；翻到第 2 页的首行 == 预期序的下一条（同一份序）；**导出首行 == 列表首行**（同源） |
| 结构型序 | 层级列表 | 用**递归期望序列逐位比对**；**不得**用"`parent_id` 非空的都排在后面"这类弱判据（它对叔侄交错免疫） |

> 来源：B4 批次（2026-09-26）。**原记于索引** `08-前端实现规格.md` 的「六、B4 追加规格」§6.4；2026-09-26 按索引 §五 规则 1（新增规格写进对应子文件、索引不放正文）迁入本文件。

### 4.9 通用只读甘特组件 `GanttChart`（B4 批次，2026-09-26）

**一句话**：把"左侧信息列 + 右侧时间条"的**表**做成**领域无关**的只读组件——调用方把行与范围喂进来即可。

**边界（复用硬口径）**：组件内**不含任何领域词汇**（不认识"任务/需求/项目/基线"）：行怎么组装、点击去哪、状态怎么配色
（`toneClass`）全部由**页面侧**给。故下一个域（需求基线甘特、项目路线图）可直接复用，只写页面侧的"翻译层"。

#### 4.9.1 props 契约

| prop | 类型 | 默认 | 规格 |
| --- | --- | --- | --- |
| `rows` | `GanttRow[]` | — | 行数据；**空数组走 empty 态**，不是"画一张空图" |
| `range` | `{ start: string; end: string }` | — | 时间轴范围，**服务端算**（数据的最早/最晚），不是视图偏好 |
| `today` | `string \| null` | — | 今天；`range` 不含今天时**不画今天线** |
| `state` | `'loading' \| 'ready' \| 'error'` | `'ready'` | 三态各有独立 DOM 与锚点；**三种文案必须不同** |
| `emptyText` / `errorText` | `string` | `'没有可显示的行'` / `'取数失败'` | 空态/错误态文案由调用方给（组件不懂领域） |
| `onRetry` | `() => void` | — | **错误态渲染「重试」按钮的唯一条件** |
| `scopeNote` | `string` | — | 口径说明（"这张图统计的是谁"），渲染在根部 `.gc-scope` |
| `onRowClick` | `(key: string \| number) => void` | — | 行点击回调；**页面侧**决定去哪 |
| `leftWidth` / `rowHeight` | `number` | `320` / `30` | 左列宽、行高（px） |
| `testId` | `string` | `'gantt'` | **锚点前缀**：组件内全部锚点由它派生（`{testId}-row-<key>` …），组件**不硬编码**领域前缀 |

#### 4.9.2 行数据契约（`GanttRow`）

| 字段 | 必填 | 语义 / 规格 |
| --- | --- | --- |
| `key` | ✔ | 稳定键（React key 与点击回调都用它），同一图内唯一 |
| `label` | ✔ | 左列主标签（名称） |
| `sub` |  | 左列副标签（编号等） |
| `depth` |  | 层级（0 = 根）；左内边距 `8 + depth * 14` |
| `start` / `end` |  | 计划起止（`YYYY-MM-DD`）；**两者皆空 = 未排期**：行照常在，只是**不画条** |
| `actualStart` / `actualDone` |  | 实际起止（画实际条）；**单边缺失按另一边兜成一天** |
| `milestone` |  | 画**菱形**而不是长条 |
| `progress` |  | 0–100，填充计划条内部（`Math.min(100, progress)`） |
| `status` / `statusLabel` |  | 状态码与中文标签（展示用） |
| `toneClass` |  | **状态配色的类名由调用方给**（如任务域传 `taskStatusPillClass(status)`）——组件不认识状态码 |
| `note` |  | 行尾附加说明（如「未排期」的原因） |

#### 4.9.3 DOM 契约（选择器与锚点）

| 选择器 | 锚点 | 说明 |
| --- | --- | --- |
| `.gc`（根） | `{testId}` | 根上另带 **`data-range-start` / `data-range-end` / `data-total-days` / `data-rows`** ⇒ 走查**不必读像素**即可核对范围与行数 |
| `.gc-scroll` > `.gc-body` | — | `min-width = leftWidth + max(totalDays * 6, 480)` ⇒ 长范围靠**横向滚动**承载，不压缩 |
| `.gc-head` / `.gc-head-left` / `.gc-head-right` | `{testId}-axis` | 表头；右侧承载刻度 `.gc-tick` 与 `.gc-range-label`（`起 ~ 止（N 天）`） |
| `.gc-rows` | — | `position: relative`，**今天线的定位上下文** |
| `.gc-row` | `{testId}-row-<key>` | 一行；`height = rowHeight` |
| `.gc-left` / `.gc-sub` / `.gc-label` / `.gc-note` | `{testId}-note-<key>` | 左列信息（编号 / 名称 / 行尾说明） |
| `.gc-bar.gc-bar-plan` | `{testId}-bar-<key>` | 计划条；内部 `.gc-bar-fill` 表达进度 |
| `.gc-bar.gc-bar-actual` | `{testId}-actual-<key>` | 实际条（**另起一条**，不与计划条合并——两者含义不同，画在一起就没法比对） |
| `.gc-milestone` | `{testId}-mile-<key>` | 里程碑菱形（`left: calc(<pct>% - 6px)` 使中心落在日期上） |
| 未排期标记 | `{testId}-undated-<key>` | 行内「未排期」字样（**行仍在**） |
| 今天线 | `{testId}-today` | 只覆盖**条区**的竖线；`range` 不含今天时**不渲染** |
| 三态 | `{testId}-loading` / `-error` / `-empty` | 三种文案互不相同，同一时刻只出现一个 |
| 口径 | `{testId}-scope` | `scopeNote` 的容器 |

#### 4.9.4 几何口径（走查可据此反算日期）

1. **条的位置一律用 `left`/`width` 百分比**（不用像素）：走查可由几何**反算日期**，与接口读数对照——
   "界面上画的位置"与"数据里的日期"是否一致，是这一页最该被验的一件事。
2. **含首尾算天数**：`spanDays = (end - start) / DAY + 1`（9/1 ~ 9/3 = 3 天，少算一天会让每根条都短一格）；百分比分母取 `(r1 - r0 + DAY)`。
3. **日期用 `Date.UTC` 解析 `YYYY-MM-DD`**：本地时区会把日期推成前一天，症状是走查里"条错位一天"。
4. **一天最小 6px、超长靠滚动**：`timelineWidth = max(totalDays * 6, 480)`。左列是**定宽 px**，与条区的百分比**不能在同一条 `calc` 里混算** ⇒ 今天线只覆盖条区、以 `.gc-rows` 为定位上下文。
5. **单边缺失兜成一天**（只有 `start` 或只有 `end`）：否则"这条在图上**消失**"，用户会当成数据丢失。
6. 刻度按范围自动取：`totalDays > 70` 用「月」（`YYYY-MM`），否则用「周」（`M/D`，步长 7 天）。
7. **不做缩放**（本批为只读视图，无拖拽改期、无依赖箭头）：这是产品裁定，不是遗漏。

#### 4.9.5 为什么不用 ECharts（`PlmChart` 的 `CustomChart` 仍未使用，**刻意保留**）

甘特的本体是「**左侧信息列 + 右侧时间条**」的**表**，不是统计图：左列每行要放编号、名称（带层级缩进）、日期、责任人，
右侧才是条。**用图表画条之后，左列仍需与图表的 y 轴逐行对齐**（行高、滚动、悬停都要同步），而那正是这类实现最脆的地方；
DOM 行的对齐是**结构性**的（同一行就是同一个 flex 容器）。附带的收益是这一页**不下载 chart chunk**（包体纪律）。
`CustomChart` 的注册保持不动（留给"真正的统计类自定义图形"），此处登记原因，免得后人以为漏用了。

#### 4.9.6 判据 / 走查锚点（走查脚本据此定位，改名等于作废历史套件）

| 锚点 | 位置 | 断言方向（**双向**：成立与不成立都要有一条） |
| --- | --- | --- |
| `<testId>-row-<key>` | 甘特行 | 有排期的行**必须有**条；**未排期的行必须没有条但行仍在**（两条都要，只测一侧对"消失"与"静默截断"免疫） |
| `<testId>-bar-<key>` 的 `left/width` | 计划条 | 由百分比**反算天数**并与接口读数逐行对照（差距 = 0）；含首尾口径（9/1~9/3 必须算出 3 天） |
| `<testId>-actual-<key>` | 实际条 | 有实际日期才有；**实际条与计划条是两条独立元素**（合并不算通过） |
| `<testId>-mile-<key>` | 里程碑 | 里程碑行**画菱形而不画长条**（两条互为反向实例） |
| `<testId>-today` | 今天线 | `today ∈ [range]` ⇔ 存在；**`range` 不含今天时必须不存在**（反向实例是这条的关键） |
| `<testId>-loading` / `-error` / `-empty` | 三态 | 同一时刻**只出现一个**，且三者文案互不相同；error 态同时有「重试」按钮 |
| `<testId>` 根上的 `data-range-start/end` / `data-total-days` / `data-rows` | 甘特根 | 与接口读数**逐值相等**（不必读像素就能验范围与行数） |
| `<testId>-undated-<key>` | 未排期标记 | 未排期行**有标记且行在**（与"行被过滤掉"互为反向实例） |
| `gantt-truncated-banner` / `gantt-render-cap-banner` | 截断横幅 | 出现 ⇔ 对应计数条件成立（**不得无条件渲染**，也不得条件成立而不渲染） |
| `gantt-counts` / `gantt-need-project` / `gantt-no-dates` / `gantt-empty` | 读数与空态 | "没选项目" / "选了但命中为空" / "命中但没有排期日期" 三种空态**文案不同、互不冒充** |

> 对象切换 tab 的锚点（`<域>wt-tab-<X>`）随**对象切换器**规格走，见 §6.15.1（`06-interactions-part2b.md`）。

#### 4.9.7 走查纪律（B4 实测代价）

1. **甘特行不是 AG Grid 行**：点它用 `gantt-row-*`（DOM 行，`onRowClick`）；网格页则必须点行内 `.ag-cell`（点 `.ag-row` 不触发 `onRowClicked`，§6.16.4）。两者**点击语义不同**，套用错会得到"点了没反应"。
2. **先自证数据前提再断言几何**：`data-rows` / `gantt-counts` 是几何断言的前置——行数为 0 时"没有条"是**必然**的，那种通过什么也没证明。
3. **百分比反算要用同一口径**：反算时必须复用"含首尾 + `(r1 - r0 + DAY)`"的分母，否则会把口径差异读成"条画错了"。
4. **锚点前缀由 `testId` 派生**：新增调用方**不要**另起一套命名（组件侧已参数化），否则同一组件在不同页面各有一套锚点，套件无法复用。

> 来源：B4 批次（2026-09-26）。**原记于索引** `08-前端实现规格.md` 的「六、B4 追加规格」§6.2 与 §6.5；2026-09-26 按索引 §五 规则 1 迁入本文件（tab 锚点行按"随其规格走"的原则并入 §6.15.1）。

### 4.10 只读视图页（甘特页）侧责任清单（B4 批次，2026-09-26）

组件只负责"把行画成图"，**下列六件事必须由页面侧做**（缺一条就会得到"看起来能用、结论错了"的页面）：

| # | 责任 | 规格 | 反例（会得到什么错误结论） |
| --- | --- | --- | --- |
| 1 | **作用域不许自动选首项** | 未选项目时给**引导态**（如 `gantt-need-project`）；"没选项目"与"选了但项目里没有任务"是**两个空态**，文案必须不同 | 自动选中一个空项目 ⇒ 页面呈现成"这件事没有计划" |
| 2 | **口径与计数由服务端算** | 时间轴 `range`/`today`、`dated` / `undated` / `milestones` / `truncated` 一律服务端算好下发（如 `gantt-counts` 直接展示读数），前端**不自算** | 前端自算会与接口/导出分叉（同一问题两个答案） |
| 3 | **未排期行照常显示并标注** | "未排期"**不是**过滤掉，而是行照常在、加「未排期」标记 + 一个可见的「显示未排期任务」开关（默认开） | 直接不显示 ⇒ 用户以为"这些任务不存在"（实际是没排期） |
| 4 | **两种截断都要显式横幅** | ①**服务端截断**（命中超单次上限）：`gantt-truncated-banner` 写明"命中 N 条，图上只有前 M 条，请收窄筛选"；②**界面渲染上限**（为可读性只画前 N 行）：`gantt-render-cap-banner` 同类说明。**画半张图比画不出更坏，但不许悄悄画一半** | 静默截断 ⇒ 用户把"图上的条数"当成"计划的全貌" |
| 5 | **排序键必须可见** | 默认序用到的**第二键**必须在表里有对应列（否则用户无法解释"为什么这条排在那条前面"） | 排序列不可见 ⇒ 每次看到的顺序都像随机的 |
| 6 | **口径说明必须写** | `scopeNote` 写清"这张图统计的是谁"（范围、口径、本批边界），随图常驻 | 不写 ⇒ 同一张图被当成"全部工作"或"某人工作" |

- 视图页的通用骨架与列表页同形：`.page-head`（标题 + 对象切换 tab）/ `.ctx-bar`（**作用域**）/ `.toolbar`（筛选 + 计数读数）。
- 只读视图**不给**必被拒的控件：本批为只读 ⇒ 不渲染"拖拽改期""加依赖"等入口（服务端也不支持）。

> 来源：B4 批次（2026-09-26）。**原记于索引** `08-前端实现规格.md` 的「六、B4 追加规格」§6.3；2026-09-26 按索引 §五 规则 1 迁入本文件。

### 4.11 列表批量动作与选择列范式（批次54，2026-09-27）

**一句话**：列表要做**批量动作**时，选择必须是**看得见的复选框首列**——不复用"点行即选中"，也不新造选择状态。

**首列规格（逐项固定，不要各页微调）**：

| 列属性 | 值 | 为什么 |
| --- | --- | --- |
| `checkboxSelection` | `true` | 选择必须**看得见"我把它当成了操作对象"**——只靠行高亮表达的是"我正在看这条"；两者被读成同一件事时，批量动作会作用在没打算动的行上 |
| `headerCheckboxSelection` | `true` | 全选走表头复选框（没有它，批量动作只能一行行点） |
| `width` | `40` | 只装一个复选框；再宽会挤掉业务列 |
| `pinned: 'left'` | 固定 | 横向滚动时选择列不跟着跑（否则滚到右边就看不到自己勾了哪些） |
| `lockPosition: true` | 固定 | 不许被拖到中间 |
| `filter: false` / `sortable: false` / `resizable: false` | 关掉 | 复选框列上的筛选/排序/缩放都没有语义，开着只会让用户误操作 |

**配套的 `gridOptions`**：`rowSelection: 'multiple'` + `onSelectionChanged` 收集选中 id
（`e.api.getSelectedRows().map(r => r?.id).filter(x => typeof x === 'number')`），
选中 id 存进页面 state，供批量动作与按钮文案（`移除选中(2)`）读取。

**样板（三个现成实现，新域照抄其一，不要另起一套）**：

| 样板 | 批量动作 | 说明 |
| --- | --- | --- |
| `DocumentsPage.tsx`（文档中心） | 批量下载（服务端打 ZIP） | 最早的选择列范式；未勾选时动作回落到"当前筛选结果" |
| `TasksPage.tsx`（任务页） | 「新建任务」建在选中行的下一层 | 选择列带**语义 tooltip**（`headerTooltip` 写清"选中后动作会作用在哪"）——选择列不只是勾选，它同时声明了动作的作用点 |
| `BomEditorPage.tsx`（BOM 结构网格） | 批量移除 / 批量定稿 | **多选但不允许点行勾选**（见下"边界"第 1 条） |

**边界（三条，每条都对应一次具体代价）**：

1. **多选模式 ≠ 点行即勾选**：本页"点行"若已有别的语义（如 BOM 结构网格点行 = 在右栏看该行详情），
   必须 `suppressRowClickSelection: true`——否则用户每看一行就往批量目标里多塞一行，**批量移除会误删**。
   解耦后：勾选只由复选框改变，点行只负责"看"。
2. **单选用 `'single'`，不要为了省事全站改多选**：对象的"当前选中项"只有一条时（详情面板跟随焦点行、单选树）
   用 `'single'`；多选会让"当前对象"变成"一组对象"，而详情面板只能显示一个——那组里剩下的几个去了哪里，用户无从知道。
3. **批量动作必须逐个调用并汇总成功/失败，失败不得静默吞掉**：后端**没有批量端点**（不为批量改接口契约），
   逐行调既有单行端点；每行的失败原因（含后端原文）汇总成一句可照着改的话
   （`成功 N 行，失败 M 行 —— <料号>：<原因>；…`），按钮文案带选中计数。
   - 为什么**逐个串行**而不是并发：这些写操作各自要走变更窗口 / 结构锁等校验，逐个调用才能说清"第几行、为什么失败"；
     并发写同一条 BOM 的结构会让错误顺序不可复现，而用户要的是一份**能照着改的失败清单**。
   - 失败**不静默吞掉**与 §4.10 第 4 条"不许悄悄画一半"同源：部分成功若只报"完成"，
     用户会把没改成的行当成已改。
   - 批量完成后**清空选择并刷新列表**：留着勾选会让人以为"这些还没处理"；要重试的是失败那几行（重新勾选），
     不是把上一次的选择留着。

> 来源：批次54（2026-09-27，用户裁定 D54-8：结构网格复用文档中心写法，动作 = 批量移除 + 批量定稿）。
> 本轮实例：BOM 结构网格（`BomEditorPage.tsx`，锚点 `bom-grid`）。

### 4.12 流程状态列的显示词：服务端域词表 + `data-raw-status`（批次55，2026-09-27）

**一句话**：网格里显示**流程状态**的列，中文只能来自**服务端下发的域词表**，且同一格上必须保留**原码**——
`<span data-raw-status={code}>{label(code)}</span>`。

| 要素 | 规定 | 为什么 |
| --- | --- | --- |
| 词表来源 | `flows/*.yaml` 的 `states.<CODE>.label`（启动时加载，经 `GET /api/v1/_platform/flows/{flowId}` 下发）；前端只**接线**：一个域一行 `useFlowStateLabel('<flowId>')`（`frontend/src/hooks/useFlowStateLabel.ts`） | 前端写第二份「码值 → 中文」必然与 `flows/*.yaml` 漂移（批次28 的枚举漂移即此形态）；用户口径（D55-1）：「服务端下发域词表 + 前端统一映射」 |
| 域必须**显式**声明 | 一页多域就**各调一次** hook，**不许**合并/推断 | 同名不同义（`doc` 有 `DRAFT/APPROVED`，`item` 有 `WIP/CHANGING`，仅 `RELEASED`/`OBSOLETE` 同名）；自动推断必然错译 |
| 原码必须保留 | 单元格内用 **`cellRenderer`** 输出带 `data-raw-status` 的元素；**不要**用 `valueFormatter` | `valueFormatter` 只能换文本、**挂不上属性** ⇒ 断言只能退回"从接口反查"，丢掉"这一格到底渲染了什么" |
| 回落语义 | 词表未到货 / 该码不在词表内 ⇒ **原样回落码值** | 回落码值是"如实"，不是缺陷；因此"没接线"与"词表缺 label"表现相同，必须分别核验 |
| ⚠ 依赖数组 | `cols` 的 `useMemo` 依赖**必须**含那个取词函数 | 词表**异步**到货 ⇒ 漏写依赖会让显示词**锁死在首帧**（那刻词表为 `null`）⇒ 屏幕永远英文码（L-715 家族）。`useFlowStateLabel` 的返回身份已 `useCallback` 稳定，所以把它放进依赖只在词表到货时重建列定义**一次**（与"把随用户操作反复变化的 `structureLocked` 放进依赖"不是一回事） |

**实例登记**（本批接入的物料域渲染点，全部锚点可查）：

| 页面 | 渲染点 | 锚点 |
| --- | --- | --- |
| `BomEditorPage.tsx`（BOM 编辑器） | 结构网格「父件状态」/「子件状态」列、上下文条母件状态、右栏详情「状态」、子件校验提示文案 | `bom-grid`（列 `parentStatus`/`childStatus`） |
| `ProductStructurePage.tsx`（产品结构） | 结构树节点状态 | `tree-itemstatus-<itemId>` |

**边界**：`BOM状态` 列（`t_bom.status`）**不是**物料域状态，走它自己的 `bomStatusLabel`；
`结构行态`（`structureState`）是第三种轴（结构与行），也不该拿物料词表去映射。

### 4.13 动作按「操作主体」三分区 + 对象主体化（批次57，2026-09-27）

**一句话**：一个"编辑某个对象"的页面，动作按**主语**分三区，**同一动作只保留一个执行方式**；
页头把"当前正在编辑的对象"做成**几何上最显著的元素**。

| 区 | 主语 | 放什么 | 锚点实例（BOM 编辑器） |
| --- | --- | --- | --- |
| **页头右侧** | 这个**对象（及其版本）** | 版本轴动作：发布/冻结、升版、版本对比 | `bom-version-actions`（`bom-freeze` / `bom-revise` / `bom-compare`） |
| **内容区上方**（`.toolbar`） | 这个对象的**结构/子行** | 加行、删行、定稿、导入、新建 | `bom-structure-toolbar`（`bom-add-line` / `bom-batch-remove` / `bom-batch-promote` / `bom-import`） |
| **详情面板（右栏）** | **被选中那个元素自身** | 只属于"那颗物料/那条记录"的动作 | `bom-node-actions`（`bom-raise-ecr` / 通知建料人发布） |

**对象主体区（页头左侧，锚点 `bom-object`）**：显示 `料号 + 名称 + #当前版本 + 状态`，
其中「换对象」的选择器（SearchPick）与对象标题**合一**，不再在内容区上方重复一个同类选择器。
状态走**该对象所在域**的服务端词表（BOM 编辑器用 `useFlowStateLabel('bom')` + `data-raw-status`，见 §4.12）。

**两条硬判据（走查可判，均为几何/接口读数）**：

1. **显著性**：对象标题的字号 ≥ 页头内任一按钮字号 `+4px`，且其盒子面积 ≥ 该区域内最大按钮面积的 **2 倍**
   （不用"元素存在"当证据）。
2. **不重复**：同一动作的选择器/按钮在全页**只出现一次**。选择器类控件用 `data-testid` 定锚点核对
   （不要靠宽度/文案猜哪个是"父件选择器"）；批量按钮与单行入口二选一——**单行能力由"勾一行 + 批量按钮"承担**。

**反例（三条，都对应一次真实代价）**：

- **不为"去重复"而删能力**：删掉详情面板里的单行入口时，必须证明等价路径存在（勾一行 + 批量按钮，且两者本就是同一写链路）。
- **不把两个状态机的动作拼到一处**：把"发布这条 BOM 的版本"和"变更那颗物料"并排放在没有主语的按钮组里，
  读的人只能把它们揉成一对（实测用户就问出了"这两个是不是对偶"——**不是**：一个作用在 BOM 版本轴、一个在物料生命周期 + 变更域）。
- **同一个动作不留两个入口**：既留单行按钮又留批量按钮，正是被用户点名的冗余形态（V-218）。

> 「换对象」类选择器若带"记住上次选择"的行为，必须同时提供**可清除**的入口（SearchPick 的 `allowClear`，
> 选中后在选择器上出现 `✕`）：清除 ⇒ 回到**未选态**并**忘掉记忆**；判据要求**驱动自证**（点 ✕ ⇒ 空态几何可见 + 存储里的记忆被移除），
> "点了没反应"必须判红。

> 来源：批次57（2026-09-27，用户原话 1/3/4/5 + 裁定 D57-1；约定 V-218）。
> 本轮实例：`BomEditorPage.tsx`（三分区 + 对象主体区 + 父件详情深链 `?open=`）、
> `ItemLibraryPage.tsx`（新建物料的类别从"静默默认 + 双击单元格"改为页头**显式选择**，选项取既有唯一取数口 `useItemClassOptions()`）。

### 4.14 统计/看板表格图表化：`PlmChart` 薄封装 + 懒加载（2026-09-28 UI 走查整改）

**一句话**：看板页里的"统计表"（两列 `阶段|数量` 一类）**默认画成图**，不再用 `<table>` 展示——表格是给人
"逐行核对"的，看板是给人"一眼看分布与异常"的，两态混用让驾驶舱读不出瓶颈。

**规格**：

1. **一律走 `components/PlmChart.tsx`**（ECharts 按需注册的薄封装，§8 组件约定）：漏斗/分布用 `hbar`，
   趋势用 `line`，占比用 `pie`/`bar`。**不得**在页面里新写第二份 ECharts option 封装。
2. **懒加载纪律**（包体预算，门禁判据 D）：`const PlmChart = React.lazy(() => import('../components/PlmChart'))`
   + `<Suspense>`——echarts 不进首屏 chunk；`vite.config.ts` 的 `manualChunks` 已把 echarts 打成独立 `chart-*` chunk。
3. **三态文案必须分开**（"没有"≠"没加载"）：`state: 'loading' | 'ready' | 'error'` + `emptyText` / `errorText` / `onRetry`，
   口径写进 `scopeNote`（"这个数字统计的是谁"，同 §6.14 面板纪律）。
4. **判据**：单系列数值表（每行=类目+一个数）⇒ 必须 `hbar`；预警类数据（负载% vs 阈值）另加一行
   **超载摘要**（`⚠ 超载阶段：概念（320%）`）——图上读不出"哪根超了阈值"时必须有一行文字兜底。
5. **数值列另留时的例外**：需要逐行精确核对（如对账表）或行内带交互（行级按钮）的表格**不图表化**——
   图表化的是"读分布"的看板，不是"读数据"的台账。

> 基准实例：`PipelineDashboardPage.tsx`（阶段漏斗 + 负载热力 → 两张 `hbar`，超载摘要一行，
> `口径：` 注脚走 `scopeNote`）。工作台 `MyDashboard` 四张图是同一构件的首个实例。

---

