# 02 · Datagrid 与电子表格方案

> 定位：将 ADR-7（AG Grid + Univer + AI 副驾）落实为**可实施的前端数据网格架构**。
> 输入：`docs/plm-design/05-技术架构设计.md` §6、`docs/plm-ui-prototypes/` 三栏布局与网格交互原型。
> 核心问题：医疗器械 PLM 的网格场景**行数跨度极大**（百行物料列表 → 十万行 BOM 树 → 百万行测试数据），且需**单元格级权限/状态锁/红线比对/Excel 粘贴/AI 动作**——单一组件无法覆盖，需分层选型+自研适配层。

> **实现栈对齐（2026-09-05，S0）**：本文档的 AG Grid Community + Univer（电子表格）+ PLM Grid Adapter（六能力）为**完整目标架构**。S1 已选用 **AG Grid Community ^32**（需求/项目网格），实现单元格/排序/过滤/分页的基础能力；**Univer（公式引擎，FMEA/检验单/测算表）、SSRM（百万行）、树形懒加载（大 BOM）、红线比对、Excel 粘贴管道**按此文档的 PoC-3/4/5/6 在 **P2（前端工作台 + Datagrid）**引入，落地 PLM Grid Adapter 的元数据列/权限锁/粘贴/红线/AI 动作六能力。见 `phase-plan.md`。
---

## 1. 组件选型矩阵（按场景）

| 场景 | 行数规模 | 选型 | 理由 |
|---|---|---|---|
| 物料库列表 | 1K~100K | **AG Grid Community + SSRM** | 服务端分页（上限口径见后端常量 `Paged.MAX_PAGE_SIZE`，本文不复述数值）；元数据驱动列；状态锁 |
| BOM 树形编辑 | 1K~50K 节点 | **AG Grid Community + Tree Data + 懒加载** | 树形展开/折叠；五视图切换；内联编辑 |
| 变更受影响对象 | 100~5K | **AG Grid Community** | Before/After Diff 染色；批量操作 |
| FMEA 评分表 | 100~2K 行 × 20+ 列 | **Univer** | 公式引擎（S×P=RPN）；多 Sheet；自由格式 |
| 检验单/测算表 | 50~500 行 | **Univer** | 公式计算；条件格式；打印区域 |
| 测试数据/批量导入预览 | 10K~1M | **glide-data-grid** | Canvas 渲染百万行；虚拟滚动 60fps |
| 需求追溯矩阵 RTM | 500~10K | **AG Grid Community** | 矩阵布局；覆盖率热力图染色 |
| 阶段门 checklist | 10~50 | **shadcn/ui Table** | 简单列表；无需网格性能 |

**选型原则**：
- 默认 AG Grid（覆盖 80% 场景）
- 公式/自由格式 → Univer
- 超大规模（>10 万行）→ glide-data-grid
- 简单列表 → shadcn/ui Table（不引网格开销）

---

## 2. PLM Grid Adapter 架构（自研封装层）

> 设计文档 §6.2 定义六个能力，此处给出可实施的组件架构。

### 2.1 架构分层

```
┌──────────────────────────────────────────────────────┐
│                  PLM Grid Adapter                     │
│  (自研 React 组件，封装 AG Grid / Univer / glide)      │
├──────────────────────────────────────────────────────┤
│  Layer 4: AI 动作层（✦ 查重/建议/判定 → AI 副驾）      │
│  Layer 3: 粘贴管道（Ctrl+V → 解析 → 校验 → 差异预览）   │
│  Layer 2: 权限/状态锁层（单元格可编辑性判定）           │
│  Layer 1: 元数据驱动层（T_ATTR_TEMPLATE → 列定义）     │
├──────────────────────────────────────────────────────┤
│  AG Grid Community  │  Univer  │  glide-data-grid    │
│  (SSRM/Tree Data)   │ (公式引擎) │  (Canvas 渲染)       │
└──────────────────────────────────────────────────────┘
```

### 2.2 Layer 1：元数据驱动列生成

**数据流**：
```
后端 GET /api/v1/meta/attr-template?class_id={classId}&role={role}
  → 返回 AttrTemplate[]
  → 前端 buildColDefs(templates, role, status) → AG Grid ColDef[]
```

**核心接口**：
```typescript
interface AttrTemplate {
  attr_code: string;        // 'msl_level'
  attr_name: string;        // 'MSL 等级'
  data_type: 'STRING'|'INT'|'DECIMAL'|'BOOL'|'DATE'|'LOV'|'REF';
  lov_values?: string[];
  is_required: boolean;
  is_key: boolean;          // 查重关键属性
  regex_check?: string;
  sec_level: 'PUBLIC'|'INTERNAL'|'SECRET'|'CONFIDENTIAL';
  width?: number;
  frozen?: boolean;
}

function buildColDefs(
  templates: AttrTemplate[],
  role: UserRole,
  objStatus: ObjStatus
): ColDef[] {
  return templates.map(t => ({
    field: `attrs.${t.attr_code}`,
    headerName: t.attr_name,
    editable: canEdit(t, role, objStatus),  // Layer 2
    cellEditor: mapEditor(t.data_type),
    cellRenderer: t.is_key ? KeyCellRenderer : undefined,
    cellStyle: statusLockStyle(objStatus),   // 已发布=灰锁
    width: t.width ?? 150,
    pinned: t.frozen ? 'left' : undefined,
    // ✦ AI 动作
    cellRendererParams: { aiAction: t.is_key ? 'dedup' : undefined },
  }));
}
```

**与 UI 原型的对应**：物料库界面 11 列由 `T_ATTR_TEMPLATE(class_id=电子件-IC)` 动态生成，企业加属性 → 前端零发布自动多出列。

### 2.3 Layer 2：单元格级权限与状态锁

**可编辑性判定函数**：
```typescript
function canEdit(
  attr: AttrTemplate,
  role: UserRole,
  objStatus: ObjStatus,
  ctx: WorkflowContext
): boolean {
  // 1. 对象状态锁：已发布对象不可直接编辑（BR-01）
  if (objStatus === 'RELEASED') return false;
  // 2. 密级过滤：机密属性按名单授权（BR-18）
  if (attr.sec_level === 'CONFIDENTIAL' && !role.clearances.includes('CONFIDENTIAL')) return false;
  // 3. 角色权限：有效权限 = (职能∪项目) ∩ 密级 ∩ 组织范围 ∩ 对象状态
  if (!hasPermission(role, attr.attr_code, 'WRITE')) return false;
  // 4. 流程上下文：ECO 实施中只允许改受影响对象
  if (ctx.eco_id && !ctx.affected_attrs.includes(attr.attr_code)) return false;
  return true;
}
```

**UI 表现**（对应 UI 原型）：
- 已发布行：灰锁 + 行首「发起变更」按钮（BR-01）
- 机密属性（如试纸配方）：服务端脱敏显示 `***`，有权限才可见（BR-18）
- ECO 实施中：仅受影响对象可编辑，其余灰锁

### 2.4 Layer 3：Excel 粘贴管道

**流程**（设计文档 §6.2 能力 4）：
```
Ctrl+V
  → 解析剪贴板（行列映射）
  → 预览对话框（映射预览：源列 → 目标属性）
  → 服务端校验（POST /api/v1/bulk-validate）
  → 差异预览（新增=绿 / 修改=黄 / 拒绝=红+原因）
  → 用户确认
  → 走同一写入管道（POST /api/v1/bulk-commit，单事务）
```

**关键纪律**：粘贴不是后门——校验/状态守卫/审计全走正规写入管道，与单格编辑同一入口（规则/校验服务）。

**性能目标**：500 行粘贴端到端 < 10s（SLO §9.1）。

### 2.5 Layer 4：AI 动作层（✦）

**三种 AI 介入形态**（对应 UI 原型三模态 C）：

| 形态 | 触发 | UI 表现 | 示例 |
|---|---|---|---|
| 单元格 ✦ | 点击 ✦ 图标 | 浮层建议 | 查重：相似度 78%/95%/99% |
| 副驾面板 | 右栏对话 | 对话+引用 chip | "这个物料适合哪个供应商？" |
| 任务级 Agent | 待办触发 | 待审网格视图 | 变更分析 Agent 产出影响评估初稿 |

**上下文协议**（设计文档 §7.2）：
```typescript
interface GridContext {
  view_type: 'BOM_TREE'|'ITEM_LIST'|'ECO_AFFECTED'|...;
  object_type: string;
  filter_state: FilterModel;
  selected_cells: CellCoord[];      // {obj_id, rev, attr_code}
  focused_object?: LogicalID;       // PLM:ITEM:E-000123#B
}
```

AI 副驾通过 GridContext "看得见用户正在看什么"，实现上下文感知的问答与建议。

### 2.6 红线比对（能力 6）

**场景**：变更评审时对比任意两版本/基线的结构 diff。

**实现**：
```typescript
function redlineCompare(
  baselineA: BaselineSnapshot,
  baselineB: BaselineSnapshot
): RedlineResult {
  return {
    added: rows in B not in A,    // 绿色新增行
    removed: rows in A not in B,  // 红色删除行
    modified: rows with attr diff, // 黄色差异格
  };
}
```

**UI 表现**（对应 UI 原型 03-change-detail）：Before/After Diff 表，差异格染色，增删行标记。

---

## 3. AG Grid 性能方案

### 3.1 SSRM（Server-Side Row Model）

**适用**：物料库（1K~100K 行）、变更受影响对象列表。

**配置**：
```typescript
<AgGridReact
  rowModelType="serverSide"
  serverSideDatasource={plmDatasource}  // 自研，对接后端分页 API
  serverSideInfiniteScroll={true}
  cacheBlockSize={50}                    // 每次加载 50 行
  maxBlocksInCache={20}                  // 缓存 20 块 = 1000 行
/>
```

**数据流**：
```
用户滚动 → AG Grid 请求 {startRow, endRow, sortModel, filterModel}
  → plmDatasource.getRows()
  → GET /api/v1/items?page={n}&size=50&sort=...&filter=...
  → 后端 PG 分页查询（精确过滤+GIN 索引）
  → 返回 {rowData, rowCount}
  → AG Grid 渲染
```

**性能基准**（PoC-3 目标）：
- 百万行：滚动 60fps，首次加载 < 2s
- 翻页：P95 < 500ms（SLO）
- 排序/过滤：服务端处理，P95 < 500ms

### 3.2 Tree Data + 懒加载

**适用**：BOM 编辑器（1K~50K 节点，5~10 层）。

**配置**：
```typescript
<AgGridReact
  treeData={true}
  getDataPath={data => data.bomPath}  // ['A-90001', 'E-000123']
  rowModelType="serverSide"
  serverSideDatasource={bomTreeDatasource}
  isServerSideGroupOpenByDefault={node => node.level < 2}  // 默认展开 2 层
/>
```

**懒加载策略**：
- 首次加载：根节点 + 前 2 层（通常 50~200 节点）
- 展开节点：按需请求子节点 `GET /api/v1/bom/{parentId}/children`
- 缓存：已加载子树缓存在前端，切换视图不重新请求

**性能基准**（PoC-4 目标）：
- 5 万行 BOM 树：展开/折叠 < 200ms/层
- 10 层 where-used：P95 < 3s（SLO，后端递归 CTE）

### 3.3 批量提交（乐观更新）

**场景**：BOM 编辑器批量修改数量/位号。

**策略**：
```
本地编辑 → 暂存变更栈 → 用户点"保存"
  → POST /api/v1/bom/batch-update（整批单事务）
  → 成功：清空变更栈
  → 失败：回滚本地态，显示错误行
```

**协作用悲观检出锁**：同一 BOM 同时只允许一人检出编辑（符合"同一时刻一条受控修改路径"的质量直觉）。

---

## 4. Univer 电子表格方案

### 4.1 适用场景

| 场景 | 公式需求 | 选 Univer 理由 |
|---|---|---|
| FMEA 评分表 | S×P=RPN, S2×P2=RPN2 | 公式引擎自动重算 |
| 检验单 | AQL 抽样量计算 | 条件格式+公式 |
| 测算表 | 成本/工时汇总 | 多 Sheet 聚合 |
| 风险矩阵 | S×P → 可接受/ALARP/不可接受 | 矩阵染色+公式 |

### 4.2 集成架构

```typescript
// Univer 实例化
const univer = new Univer({
  locale: 'zh-CN',
  locales: zhCN,
});

// 创建 FormulaSheet
const sheet = univer.createUniverSheet({
  sheets: {
    sheet1: {
      cellData: fmeaData,       // 从后端 T_FMEA_LINE 加载
      styles: riskMatrixStyles, // 风险矩阵染色
    },
  },
});

// 公式注册（自定义医疗行业公式）
univer.registerFunction('RISK_LEVEL', (s, p) => {
  const rpn = s * p;
  if (rpn <= 4) return '可接受';
  if (rpn <= 12) return 'ALARP';
  return '不可接受';
});
```

### 4.3 与后端数据同步

```
Univer 编辑 → onCellUpdate 事件 → 暂存变更
  → 用户点"保存" → POST /api/v1/fMEA/batch-update
  → 后端校验（公式重算结果一致性）→ 持久化
```

**纪律**：Univer 公式仅做前端即时计算，后端独立重算校验——前端公式不作为权威值。

### 4.4 性能基准（PoC-5 目标）

- 500 行 × 20 列公式表：公式重算 < 500ms
- 2000 行 FMEA：加载 < 2s，编辑响应 < 100ms

---

## 5. glide-data-grid 备选方案

**适用**：测试数据/批量导入预览（10K~1M 行）。

**特点**：
- Canvas 渲染，DOM 节点恒定（不随行数增长）
- 百万行虚拟滚动 60fps
- MIT 开源

**限制**：
- 无内置树形数据（BOM 树不适用）
- 无内置编辑器（需自研）
- 列定义不如 AG Grid 灵活

**集成**：仅在"测试数据查看""批量导入预览"两个高行数场景启用，其余场景用 AG Grid。

---

## 6. UI 原型三栏布局映射

> UI 原型 `00-ai-workspace.svg` 定义的三栏布局是所有模块的基础框架。

### 6.1 布局规格

```
┌──────────────────────────────────────────────────────────────────┐
│ Top Bar (56px)  ⚙PLM | 🔍搜索 | ✦AI副驾 | 🔔 | 用户              │
├────────┬─────────────┬────────────────────┬─────────────────────┤
│Sidebar │  Column A    │    Column B        │    Column C          │
│(220px) │  待办中心    │    网格工作台      │    AI 副驾面板       │
│        │  (320px)     │    (flex-1)        │    (280px)           │
│ 数据层 │  我的待办    │    AG Grid/Univer  │    对话+引用chip     │
│ 流程层 │  我发起      │    元数据驱动列    │    ✦ 建议            │
│ 支撑层 │  抄送我      │    状态锁          │    一键动作          │
│        │  AI 建议卡   │    ✦ 单元格动作    │                      │
├────────┴─────────────┴────────────────────┴─────────────────────┤
│ 底部状态栏：📎 当前对象 | 版本 | 状态 | 审计提示                   │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 响应式策略

| 断点 | 布局 | 说明 |
|---|---|---|
| ≥1440px | 三栏全展开 | 桌面主力模式 |
| 1024~1440px | Column C 折叠为浮层 | AI 副驾变为右侧抽屉 |
| 768~1024px | Column A 折叠为 Tab | 待办变为顶部 Tab |
| <768px | 仅 Column B | 移动端现场测试（J5/V&V） |

### 6.3 设计系统色板映射

| 用途 | 色值 | Tailwind 类 | 组件应用 |
|---|---|---|---|
| 主色 | `#2563eb` | `blue-600` | 按钮/选中/链接 |
| 成功 | `#16a34a` | `green-600` | 已发布/通过 |
| 警告 | `#d97706` | `amber-600` | 待审批/待补充 |
| 错误 | `#dc2626` | `red-600` | 驳回/QA否决 |
| AI 副驾 | `#8b5cf6` | `violet-500` | ✦ 标记/AI 卡片/副驾面板 |
| 医疗 | `#0d9488` | `teal-600` | 患者接触/注册载明 |
| 侧边栏 | `#0f172a` | `slate-900` | 深色侧栏 |
| 背景 | `#f1f5f9` | `slate-100` | 内容区 |

---

## 7. 前端模块与 UI 原型映射

| UI 原型模块 | 前端路由 | 主组件 | 网格选型 | 关键能力 |
|---|---|---|---|---|
| 00 AI 工作台 | `/` | `<AIWorkspace>` | AG Grid SSRM | 三栏布局；待办+网格+副驾 |
| 01 物料库 | `/items` | `<ItemLibrary>` | AG Grid SSRM | 元数据列；✦查重；状态锁 |
| 02 BOM 编辑器 | `/bom/:id` | `<BOMEditor>` | AG Grid Tree | 五视图；懒加载；内联编辑 |
| 03 变更详情 | `/eco/:id` | `<ChangeDetail>` | AG Grid + Diff | 五维评估；Before/After；任务包 |
| 04 文档管理 | `/docs` | `<DocumentLibrary>` | shadcn Table | DHF 树；受控发布；版本历史 |
| 05 产品结构 | `/product/:id/structure` | `<ProductStructure>` | ECharts Tree | 树形+图谱；节点高亮 |
| 06 阶段门 | `/project/:id/gate/:gate` | `<StageGate>` | shadcn Table | 证据包；BR-09 阻断；签署 |
| 07 项目管理 | `/project/:id` | `<ProjectManagement>` | shadcn Table | 5 Tab；OP 集成；里程碑 |

---

## 8. 性能 SLO 与 PoC 验证

| SLO 项 | 指标 | PoC | 验证方式 |
|---|---|---|---|
| 网格列表查询 | P95 < 500ms（百万级） | PoC-3 | SSRM 压测 |
| BOM 树展开 | < 200ms/层（5 万节点） | PoC-4 | 树形懒加载压测 |
| 10 层 where-used | P95 < 3s | PoC-2 | 递归 CTE 压测 |
| FMEA 公式重算 | < 500ms（500 行×20 列） | PoC-5 | Univer 公式压测 |
| 批量粘贴 | < 10s（500 行） | PoC-6 | 粘贴管道 E2E |
| 元数据列生成 | < 100ms（50 列） | PoC-7 | 列定义构建+渲染 |
| 红线比对 | < 1s（1K 行 diff） | — | 结构 diff 算法 |

---

## 9. 关键风险与缓解

| 风险 | 缓解 |
|---|---|
| AG Grid Community 缺 Excel 导出 | 方案 A：购买 Enterprise（~$999/dev/yr）；方案 B：自研 CSV 导出 + SheetJS |
| Univer 0.4.x API 不稳定 | 封装适配层；锁定 minor 版本；升级走变更流程 |
| 大 BOM 前端内存溢出 | SSRM + 懒加载 + 缓存上限；PoC 先行 5 万行实测 |
| 粘贴管道绕过校验 | 服务端单通道校验；前端管道仅做预览 |
| 元数据列过多导致性能下降 | 虚拟列；默认显示 key 属性；用户可配置可见列 |

*配套：[02b-表格前端业界实践](02b-表格前端业界实践.md)——业界成熟做法对照与 Grid Adapter 六能力落地要点（编辑/撤销/粘贴/diff/MSRM 坑）。
*下一篇：[03-元数据驱动架构方案](03-元数据驱动架构方案.md)——类型/属性/状态机/流程=配置即数据的全链路闭环。*
