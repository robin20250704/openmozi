# 30 · BOM 递归构建与三态版本对比设计

> 状态：**批 1~4 全部落地并部署验证（2026-10-03）· 四批闭环** · 依据用户 2026-10 原话需求①（"BOM 新建逻辑很乱，无从下手"）与需求②（"EBOM/PBOM/MBOM 三个状态要能对比，要支持导入/导出"）
> **批 1 实施记录**（新增 `BomExportService` + `BomEditorPage` 四处接线 + 14 号文 G-REF 补登记；套件 **W86 · 35/0 通过**；既有 `plm-b54-bom-state-accept` 基线 **30/7** 与无本批时**逐条相同** ⇒ 零回归）：**实施中多出一条设计未预见的判据**——`flat` 导出取的是**头当前版本**的行，而结构树取**有效版本**（已发布优先，D60-6），二者"都合法"却会分叉（实测父件 19 的 EBOM 头在 B 版、而行只在 A 版 ⇒ 导出静默给空文件）。已加守卫 `EXPORT_EMPTY_VERSION`（点名"另有 A 版 N 行" + 两条出路），见 §7 P7 与断言 B30-29。
> **批 2 实施记录**（`BomImportExportService` 两阶段落库 + 模板加两列 + 前端回执加视图列；套件 **W87 · 29/0 通过**）：实施中**抓到并修掉两个真实缺陷**，都属"静默做错"族——① `headerIndex` 按整串 label 全等匹配，而模板表头是 `结构行态(留空=草案)` 这种"列名 + 帮助文本"长串，用户把它简化成 `结构行态` 后**该列被静默丢弃**（层级退回第一层、视图退回默认），导入**照样报"成功"**；② 层级路径的 depth-1 内部键 `""` 与"导入目标"哨兵键 **相撞**，导致多视图一次导入时 EBOM 之外的行**悄悄挂到第一个子件身上**（库内证据：同一份三行文件产出两个父件）、回执仍逐行报"成功"。详见 §7 P8/P9。另固化一条**仪器教训**：夹具回收的残留判据必须查 TAG 所在的列（`name`），首版查了 `item_code` ⇒ 恒为 0 ⇒ **假绿**，4 轮静默泄漏 50 颗夹具物料（已用 `plm-b30-b2-purge.sh` 清除，并改为"按 TAG 单一判据 + 二次自证"）。
>
> **批 3 实施记录**（新增 `BomDiffKernel` 对比内核 + `GET /boms/compare-views` + `BomEditorPage` 多视图并排读面；套件 **W88 · 30/0 通过**）：`BomDiffKernel` 为**两个对比端点共用**（G-API-1.2 / 陷阱 #34），键按 D-30-1 升为 `(层级路径, 子件料号, 子件版本)`，并新增**第四类差异「位置替换」**——同一层级路径上左右子件不同即配成 1 条（实测 EBOM 的「组装件@1/电子件@2」对 MBOM 的「螺丝@1/线束@2/标签@3」得 replaced=2 + added=1 = 共 3 条；没有配对则是「移除 2 + 新增 3 = 5 条噪声」）。既有 `compare()` **原样未动**（D-30-12 ③），并已断言其响应**未混入** `replaced`。
>
> **批 4 实施记录**（BOM 编辑器接 G-UI-7：`usePanelMax` + `data-panel-state` + 复用 `.grid-wrap` / 挂 `.dp`；套件 **W89 · 45/0 通过**；**C 档最后一页结案**）：两处需记明的取舍——① **初始态取 `split`** 而非 G-UI-7-3 表里的"按 ID 到达⇒dp"：本页的"按 ID 到达"是路由参数 `:rootItemId`，它锚定**结构根**而右栏详情主语是**被选中的子件行**（两者非同一对象，那一刻那一列还没有内容可最大化）；且左栏是**编辑器**，默认 `grid` 会把右栏首屏隐藏。取与同档兄弟页 `/structure` 一致的口径（2026-09-28 以 `split` 结案）。② **不动并列比例**：本页是内联 `1fr 300px`，而共享类 `.dual.split.detail40` 是 `1.5fr/minmax(330px,1fr)`——换用会把右栏推到约 550px，是**可见版式改动**、且非 G-UI-7 接入所必需，故本批只接三态、比例留原样（若要统一到 `detail40` 应作为独立版式决策单独确认）。
>
> **四批合计**：**W86 35/0 · W87 29/0 · W88 30/0 · W89 45/0**（共 139 条）；既有 `plm-b54-bom-state-accept` 恒为 **30/7**（与改动前逐条相同 ⇒ 零回归）；`plm-suites-lint` 清单 125 → **129 行**、**FAIL=90 未变**（零新增）；夹具残留 **0**。
> 相关（**本号文受下列产品级规格约束，实现时逐条对齐，冲突以它们为准**）：**18-接口契约与状态一致性规格**（E 错误契约 / M 请求级记忆 / V 内容写留痕 / S 词表单源）· **12 号文 G-API-1**（HTTP 状态码 / 错误码族 / 分页 / 处理记录）· **14 号文 G-REF**（可复用构件清单）· **17 号文 T-C1**（套件清单登记）· 02-datagrid与电子表格方案 §3.2（Tree Data + 懒加载规格）· 08-前端实现规格 §4.2（G-UI-7 接入清单）· frontend/01-design-tokens-shell-layout §3.6 G-UI-3/5/7/9（布局三态与面板最大化）· 05-interactions-part2a §6.14（表格导出通道六条硬约束）· 22-CBB资产库业务逻辑与关系模型设计 §2.2（CBB 标记与 `BOM_FROZEN_STRUCTURE_LOCKED`）· 09-工作流引擎与元数据扩展设计（`bom-flow.yaml`）· 16-性能保障规格 S-9（10 层 BOM P95<3s）
>
> **修订轨迹（三次自检各留下一处自我订正，均保留在册）**：
> · **v2**：v1 经 18 号文 / 12 号文 G-API-1 / 14 号文 G-REF / 17 号文 T-C1 复核，修正 8 处（其中 **C1 是会 100% 失败的交互设计错误**）→ §5.4。
> · **v3**：用户裁定 A（深链收根物料 id）、B（对比**放开五视图任选两视图**），其余采纳建议 ⇒ 新增 D-30-7~D-30-12，**§8 待裁定清零**。
> · **v3 顺带订正 P4**：v2 曾称"放开五视图需扩展 `BomViewCatalog` 语义表"——**实测其语义表本就是 5 个视图**，该判断错误，D-30-8 放开**零改动**。

---

## 0. 一句话结论

**递归已经在后端、也已经被产品结构页用起来了，唯独 BOM 编辑器还在用平铺单层网格** —— 需求①的主体不是"造递归"，而是"把既有的递归暴露出来 + 把已发布锁的处置送到用户眼前"；需求②的**跨视图对比与导出在本域是零基础**，但有 `TabularExport` / `ExportPanel` / `compare()` 三块成熟现成件可抄，不需要新造基础设施。

---

## 1. 用户裁定

| 编号 | 议题 | 裁定 |
|---|---|---|
| **D-30-1** | 三态对比（EBOM/PBOM/MBOM）在多层结构下按什么对齐 | **按层级路径对齐**（不按子件料号、不做双模式） |
| **D-30-2** | "三态导入"的形态 | **一个文件含「视图」列，一次导入三态** |
| **D-30-3** | BOM 编辑器树表的数据规模与加载策略 | **小规模直出 + 大规模懒加载**（阈值 2000 节点） |
| **D-30-4** | "已发布 BOM 改结构"的处置 | **只做引导，判据一字不动**（D54-2 发布即冻结、D61-1 升版复制行落 DRAFT，两条裁定均保持） |
| **D-30-5** | 导入行数上限 | 2000 → **5000**（多层后整机 BOM 更容易超；与 `ItemImportExportService` 同量级） |
| **D-30-6** | 本轮是否动数据模型 | **不动**。occurrence（用量随父而异）与 depth/path 物化路径**仅登记为技术债**（§7） |
| **D-30-7**（v3 · 原待裁定 A） | BOM 编辑器深链 id 锚定哪个对象 | **维持现状：收根物料 id（`t_item.id`）**。`?open=` / `/bom/:rootItemId` 语义**不变**、既有深链与 e2e 探针**零失效**。配套：新增**查询串** `?view=&rev=`（见 §5.1 1-A）——加法，不改 id 锚点 |
| **D-30-8**（v3 · 原待裁定 B，**覆盖 v1/v2 的"限三态"**） | 跨视图对比的视图范围 | **放开到五视图任选两视图**（`EBOM/PBOM/MBOM/REGBOM/SBOM` 任意组合）。**不限于** EBOM/PBOM/MBOM |
| **D-30-9**（v3） | 逐视图软提醒 | 某一视图有 `softRuleCode`（`R-BOM-01~04`）时，对比面板在**该视图列头**显示对应软提醒（读 `GET /boms/views` 的 `BomViewDef`，界面不写第二份） |
| **D-30-10**（v3 · 原待裁定 A2） | BOM 编辑器是否本批顺带完成 G-UI-7 接入 | **否，单独一批做**。理由：它改的是**布局契约**（`grid`/`dp`/`split` 互斥），与树表/导入/对比**正交**；混批会让 G-UI-7 走查门（W42/W43）与 BOM 功能断言互相干扰 |
| **D-30-11**（v3 · 原待裁定 C/D/E） | 累计用量双列 / 层级路径写法 / 懒加载阈值 | **全部采纳建议**：① 导出**单层用量 + 累计用量两列都给**；② 层级路径用**点分数字**（`1.1.1`）；③ 懒加载阈值 **2000 节点硬编码为单一常量**（不做配置项） |
| **D-30-12**（v3 · 原待裁定 F/G/H） | 差异上限 / G-REF 补登记归属 / 既有 `compare()` 是否收口 | **全部采纳建议**：① 差异超限走**截断 + `truncated=true` + 回显生效上限**；② `TabularExport`/`ExportPanel`/`lib/download.ts` **由本号文补登记进 14 号文 G-REF 4.1/4.2**（见 §9 附记，已获授权）；③ 既有 `compare()` **本轮不收口**，只在新端点设限 |

> **v2/v3 的自我订正留痕**：C1（v1「一键升版」必失败）、D-2（v1 把"三态锚点"解释错）、P4（v2 误称放开五视图"需扩展 `BomViewCatalog` 语义表"——**实测其语义表本就是 5 个，D-30-8 放开后无需任何扩展**）三条错误均保留在册，见 §7 D-4/D-2/P4。

---

## 2. 事实基座（全部带 `文件:行号`，可复核）

> 本节是本号文的地基。**下面每一条都是读代码读出来的，不是从文档转述的**；凡与设计文档冲突处，在 §7 登记冲突而不擅自改设计。

### 2.1 递归：**后端有、产品结构页有、BOM 编辑器没有**

| 事实 | 证据 |
|---|---|
| `GET /boms/tree?rootItemId=&view=&maxDepth=` 已实现，`maxDepth` 缺省 **6** | `BomController.java:156-162`；`BomService.java:1375-1384` |
| 递归展开带 **visited 环守卫**与深度预算，注释明说"下层有 visited 环守卫，深度只影响遍历上界、不会死循环" | `BomService.java:1429-1431`（`SCOPE_MAX_DEPTH=200`）、`1464-1472` |
| **产品结构页已在渲染这棵树**：`TreeNode` 递归组件 + 折叠展开 + 结构行数/行态/CBB/法规标记 | `ProductStructurePage.tsx:244-318`；取数 `:569`（`maxDepth: 6`） |
| **BOM 编辑器取的是平铺单层**：`api.get('/boms', {parentItemId, view})` | `BomEditorPage.tsx:398-408` |
| 编辑器网格是**全量 `rowData`、无 `treeData`/`getDataPath`** | `BomEditorPage.tsx:1858` |
| 编辑器默认结构根取自 `localStorage`（`plm_bom_root_item`），无记忆时显式提示手选、**不猜** | `frontend/07-keyboard-conventions-gotchas-files.md` 陷阱 #35（V-179/V-180） |

**判读**：需求①里"BOM 支持递归构建"这句话，**后端 100% 已具备**，缺的是编辑器这一个消费端。把它当"新造递归能力"会重复建设。

### 2.2 "已发布 BOM 不能加子件"：**不是缺陷，是已裁定设计**

| 事实 | 证据 |
|---|---|
| 头态 `RELEASED` ⇒ 结构任何写操作被拒，错误码 `BOM_FROZEN_STRUCTURE_LOCKED` | `BomService.java:166-187`（判据在 `:173-187` 抛出） |
| 该判据出自用户裁定 **D54-1 的 R6 / D54-2**（"只有可编辑状态才能改"、发布即冻结基线） | 同上 Javadoc `:132-156` |
| 报错文案**已经写明处置①**"先升版"并给出端点与理由要求 | `BomService.java:180-186` |
| 升版**保留结构行**（`INSERT … SELECT` 复制），但行态落 `DRAFT`、头态回 `DRAFT` | `BomHeaderService.java:345-367`（D60-1 复制 + **D61-1 落 DRAFT**） |
| 升版后的行需重新定稿才能推进"设计"、才能发布 | `BomHeaderService.java:548-558`（`designBlockReason`） |

**判读**：用户"要重新开始新建"的感受，**真实来源是"升版后要重新定稿"这一步，而不是行丢了**。文案里"要重新开始新建"与实际行为（复制行 + 落草案）之间存在**用户预期与实现的落差**——这是引导问题，不是判据问题。故 D-30-4 裁定"只做引导"。

### 2.3 导入：**已有，但单父件 + 单层**

| 事实 | 证据 |
|---|---|
| `GET /boms/import-template`（xlsx/csv，带父件/视图上下文说明行）+ `POST /boms/import`（multipart，逐行独立）已实现 | `BomController.java:38-54`、`:63-72` |
| 模板列仅 6 列：`子件料号 / 数量 / 单位 / 位号 / 替代优先级 / 结构行态` —— **无父件列、无层级列** | `BomImportExportService.java:63-69` |
| "文件里**不写父件列** —— 父件是上下文而不是数据"（明确设计决定） | `BomImportExportService.java:32-33` |
| 每行走 `BomService.add()` ⇒ BR-01/BR-07/CBB/审计全部继承，**无导入旁路** | `BomImportExportService.java:239-240` |
| 逐行独立、整批不回滚；子件料号必须已存在（导入**不建料号**） | `BomImportExportService.java:34-39`、`:216-223` |
| 上限 `IMPORT_MAX_ROWS = 2000`、文件 5 MB | `BomImportExportService.java:56-58` |
| 解析器**复用物料域** `ItemImportExportService.readCsv/readExcel` | `BomImportExportService.java:174-176` |
| 导入**已经是多视图的**：`bomView` 是入参，"一次导一个视图" | `BomController.java:69` |

**判读**：D-30-2 要求的"一次导三态"缺的只是**模板加一列 + 按列分组**，不是新机制。

### 2.4 对比：**只有"同一父件 + 同一视图下两个 rev"的平铺 diff**

| 事实 | 证据 |
|---|---|
| `GET /boms/compare?parentItemId=&view=&left=&right=` 已实现 | `BomController.java:280-287` |
| `compare()` 首行 `normalizeView(view)` ⇒ **硬编码单视图**，跨视图不存在 | `BomHeaderService.java:603-604` |
| 比较粒度 = `findByParentItemIdAndBomViewAndParentRev` ⇒ **平铺单层**（不含子层结构） | `BomHeaderService.java:618-621` |
| 行的业务键 = `(child_item_id, child_rev)` | `BomHeaderService.java:637-644`（`indexByChild`） |
| 不足两个版本返回 `available=false + reason`，**不报错**（空集与故障可区分） | `BomHeaderService.java:600-617` |
| 该端点曾是"404 伪装成 405"（`/boms/compare` 被 `/{id}` 的 PUT/DELETE 吞并），已用 `{id:\d+}` 修掉 | `BomController.java:112-123` |
| **EBOM→PBOM→MBOM 派生/转换能力：全仓不存在**（`convertBom` / `deriveBom` / 视图转换 = 0 命中） | grep 全仓 |

**判读**：跨视图对比是本域零基础，但 `indexByChild` + `diffFields` 可以提成可复用，不必复制一份。

### 2.5 导出：**BOM 域零端点**

| 事实 | 证据 |
|---|---|
| `TabularExport` 只在 `BomController:51-52` 被引用，且**只借了 MIME 常量**（import-template 用） | `BomController.java:45-53` |
| 导出公共件已成熟并在**四处**在用：任务 / 需求 / 物料 / 组织 | `TaskExportService.java:70-137`、`RequirementExportService.java:86-261`、`ItemImportExportService.java:116-224`、`OrgAssignmentImportService.java:84-284` |
| 前端面板 `ExportPanel.tsx` + 下载封装 `lib/download.ts` | `components/ExportPanel.tsx`、`lib/download.ts:98,151` |
| 六条硬约束（筛选同源 / UTF-8 BOM / 超限报错不截断 / 表头单处声明 / RFC 5987 / 列口径与面板一致） | `05-interactions-part2a.md:293-303` |

### 2.6 数据模型：**层级是"物料邻接"，不是"BOM 内部层级"**

| 事实 | 证据 |
|---|---|
| `t_bom_line(parent_item_id, parent_rev, child_item_id, child_rev, bom_view)` UNIQUE | `V7__item-bom-change.sql:70-88` |
| **无 `depth` / `path` / `parent_line_id`** ⇒ 层级靠"子件本身也能当父件"隐式表达 | 同上（V89/V113/V140/V177 逐版加列均未加层级列） |
| `bom_view` CHECK = `('EBOM','PBOM','MBOM','SBOM','REGBOM')` | `V7__item-bom-change.sql:76` |
| 视图词表**单一事实源** = `BomService.BOM_VIEWS`，由 `BomViewVocabularyTest` 从迁移 CHECK 解析比对（约定 V-185） | `BomService.java:1363-1364`；`BomViewCatalog.java:17-19, 51-55` |

---

## 3. 缺口矩阵

| 需求点 | 后端 | 编辑器前端 | 缺口 |
|---|---|---|---|
| ① 递归构建 | ✅ `/boms/tree` 已实现 | ❌ 平铺单层网格 | **编辑器暴露递归**（下钻 + 树表） |
| ① 按上下层级建 | ✅ 数据模型已支持多层 | ❌ 只能给当前根加子件，无"下钻"动作 | **下钻 + 面包屑** |
| ① 从外部导入 Excel | ⚠️ 有，但单层 | ✅ 有表单与逐行回执 | **模板加层级路径列** |
| ① 已发布不能改 | ✅ 判据 + 文案 | ❌ 升版按钮不在用户眼前 | **引导**（D-30-4） |
| ② 三态版本对比 | ❌ 仅同视图两 rev | ✅ 有 compare 面板 | **跨视图端点 + 路径对齐 + 三列并排 UI** |
| ② 导入 | ⚠️ 已支持 `bomView` 参数 | ✅ | **模板加视图列 + 分组**（D-30-2） |
| ② 导出 | ❌ 零端点 | ❌ 无入口 | **`BomExportService` + `ExportPanel`** |

---

## 4. 可复用构件清单（**新功能一律从这里取，不重造**）

| 能力 | 位置 | 本号文用途 |
|---|---|---|
| 递归树展开（含环守卫、深度预算） | `BomService.tree/expand`；`structureItemIds:1429-1472` | 编辑器树表 / 层级路径计算 / 树形导出的**唯一递归源** |
| 前端递归树组件 | `ProductStructurePage.tsx:244-318` `TreeNode` | 抽 `components/BomTreeNode.tsx` 共用，**禁止复制** |
| 结构可编辑性唯一判据 | `BomService.assertStructureEditable()`（5 个调用点） | 新写入口必须调它，**不旁路** |
| 写路径纪律（BR-01/BR-07/CBB/审计） | `BomService.add()` | 导入/批量建行一律走它 |
| 版本对比内核 | `BomHeaderService.indexByChild:644` + `diffFields` | **提成可复用**，跨视图对比不复制 |
| 多级对比 UI 样式参照 | 基线对比面板 `BomEditorPage.tsx:1380-1410` + `GET /baselines/{id}/compare` | 三列并排对比的版式与交互参照 |
| Excel/CSV 解析 | `ItemImportExportService.readCsv/readExcel` | 已被 `BomImportExportService` 复用，继续复用 |
| xlsx 模板生成（POI） | `BomImportExportService.template():87-121` | 多层/三态模板加列即可 |
| 导入逐行回执 UI | `BomEditorPage.tsx:1697-1755` | 加"层级路径 + 视图"两列 |
| **导出公共件** | 后端 `com.plm.common.TabularExport`；前端 `ExportPanel.tsx` + `lib/download.ts`；规格 `05-interactions-part2a §6.14` | 照 `TaskExportService` 结构写 `BomExportService`，前端直接挂面板 |
| 状态词表 | `BomViewCatalog.defs()`（`GET /boms/views`，已在编辑器消费） | 三列并排的列头 tooltip 直接读它，**界面不写第二份** |
| 风险引擎 | `risk.evaluate("BOMLINE", lineId)`（B41 已接 BOM 编辑器） | 批量导入回执可带风险提示 |
| 审计 | `AuditService.findByObject`（`GET /boms/{id}/history` 已接） | 对比面板可显示两侧版本的变更记录——**按 BOM 头 id 取，不新写端点**（G-API-1.3） |
| **错误契约出口（v2 补）** | `GlobalExceptionHandler`（G-REF 4.2） | 新端点的 4xx/5xx 一律走它，形状 `{code, message, ts}`（E-1） |
| **分页上限常量（v2 补）** | `Paged.MAX_PAGE_SIZE`（G-REF 4.2，**禁止字面量**） | 新端点若涉及分页，引用它而非写数字 |
| **字段校验出口（v2 补）** | `MetadataService.validateAttrWithValues`（G-REF 4.2，错误附合法值清单且与库同源） | "视图"列的合法值清单**优先走它**或 `BomViewCatalog`（E-3 / S-1） |

---

## 5. 方案

### 5.1 批 1 · 低风险纯复用（建议先落地）

#### 1-A 编辑器下钻（**零新后端端点**）

网格选中一行 → 「在此件下继续建结构」→ 复用现有 `openBom()` / `loadLines()`（`BomEditorPage.tsx:464-488, 398-408`）切换 `rootId`，并渲染面包屑 `整机M-0190 › 电子件M-0192 › …`。

**不变的东西**：`localStorage` 键 `plm_bom_root_item` 语义不变；深链 `/bom/:rootItemId` **仍收根物料 id**（D-30-7）。"根就是视图入口"这条约定见 `frontend/07` 陷阱 #33 —— 不得在 `POST /boms` 加"父件必须是整机"这类**写路径**判据。

**配套的加法（D-30-7）**：深链**只加查询串，不改 id 锚点**——
`/bom/:rootItemId?view=EBOM&rev=A`。

- **为什么要加**：id 锚定物料后，URL **区分不出视图**，于是"打开产品的 EBOM"和"打开该产品的 PBOM"共用一条链接，
  分享出去别人打开的是另一个视图。而 D-30-8 放开五视图后，用户会**频繁在视图间来回**，
  这条可分享、可收藏的链接是需求②（对比三态）能落地的前提。
- **为什么是加法**：`view`/`rev` 缺省行为与今天完全一致（缺省 = `EBOM` + 头当前版本），
  **既有深链与 e2e 探针一条都不会失效**。
- 切视图 / 升版 / 切换根件时**同步回写 URL**（用 `replaceState`，不污染后退栈）。

> 这一条直接解掉"无从下手"：用户不再需要猜"该先建电子件的 BOM 还是先建整机的"。

#### 1-B 编辑器树表（D-30-3）

`GET /boms/tree` 的 `BomNode` 喂 AG Grid Tree Data，`TreeNode` 抽成公共组件。

**阈值策略（D-30-11 ③）**：节点数 ≤ **2000** → `treeData` 直出；> 2000 → 切 SSRM 懒加载。**2000 写成单一常量**（不做配置项）。符合 02 号文 §3.2 的规格（`02-datagrid与电子表格方案.md:219-241`）。

⚠️ **现编辑器是全量 `rowData`**（`BomEditorPage.tsx:1858`），**不能简单直出全树**。

⚠️ 02 号文 §3.2:236 规划的懒加载端点 `GET /api/v1/bom/{parentId}/children` **从未实现**（且路径单数 `bom` 与实际 `/api/v1/boms` 不一致，见 §7 冲突登记）。本号文**不新建**该端点：懒加载直接复用已存在的 `GET /boms?parentItemId=&view=`（单层行，正是"一个节点的子节点"所需）。

#### 1-C 导出（复用 `TabularExport`，本批风险最低）

- 新增 `BomExportService`，照 `TaskExportService.java:70-137` 的结构声明**一份** `ExportSpec`（陷阱 #34：表头标签与顺序只声明一次）。
- 端点：`GET /boms/export?parentItemId=&view=&mode=flat|tree&format=csv|xlsx`，文件名走 **RFC 5987**（`ContentDisposition.attachment().filename(name, UTF_8)`，手拼会让整个头在 Tomcat 10 上**静默消失**）。
- 前端直接挂 `<ExportPanel endpoint=… query=… />`，**不新写下载逻辑**。
- **两种模式都给**（这正是"整体 BOM 要包含电子件-组装件-包装件"的落点）：
  - `mode=flat` = 当前行集（与网格所见一致，导出物可与屏幕对账）
  - `mode=tree` = 含**层级路径** + **累计用量**（Extended Qty）
- 超限走 `TabularExport.tooLarge()` **报错并点名行数，不静默截断**。

#### 1-D 已发布锁的引导（D-30-4：判据一字不动）

结构锁命中（`BOM_FROZEN_STRUCTURE_LOCKED`）时，**在错误条处就地展开「升版并继续建」表单**——把升版按钮送到用户眼前，而不是让用户自己去页头找。

> **⚠ v2 修正（C1，18 号文 E-4「文案指向的动作必须真的可行」）**：v1 写的是「**一键**升版」，**这是错的**。
> `BomHeaderService.revise:303-306` 硬性要求 `reason` 非空且 **≥8 字**，否则 400 `REASON_REQUIRED`
> （"原因会写进版本记录，供评审回答『这一版为什么升』"）。**「一键」点下去必然失败**，
> 且失败原因（必填原因）与用户预期（一步改完）完全脱节 —— 正是 E-4 禁止的那种"指了条走不通的路"。
>
> **正确形态 = 一站式，不是零步骤**：① 错误条内展开升版表单，**原因必填**（前端即标出"≥8 字"计数，
> 不让用户提交后才被拒）；② 升版成功后**自动回到原界面**，并把新版本（头态 `DRAFT`、行落未定稿草案）
> 置为当前编辑对象；③ 因为 D61-1 已保证"新版本 = 复制行 + 落草案"，用户接着就能自由加行/改行/
> 定稿，**不再需要变更单**。这条链必须端到端走通，否则就是"给了路、路上有门"（12 号文 W-1 的同型）。

**明确不做**：不放开 `RELEASED` 锁、不提供"解冻改结构"、不提供"已发布直接退回草稿"的边、不改 D61-1 的"升版复制行落 DRAFT"、**不做无原因的"一键"**。

### 5.2 批 2 · 导入升级

#### 2-A 多层 Excel 导入

模板 `COLUMNS`（`BomImportExportService.java:63-69`）新增一列 **`层级路径`**（`1` / `1.1` / `1.1.2`）。

- **处理顺序**：按路径深度**升序** ⇒ 父层行先建立，子件行随后挂上去。
- **仍逐行走 `BomService.add()`** ⇒ "无导入旁路"纪律不破（BR-01 / BR-07 / CBB / 审计全部继承）。
- **顺序错乱**（子件行早于其父件行）明确报错：`第 N 行：层级 1.1 的父件尚未建立，请把父件行放在子件行之前`，错误码 `IMPORT_PARENT_NOT_ESTABLISHED`（归 `IMPORT_*` 族，见 §5.4.2）。
- **回执加"层级路径"列**，让用户能定位到**哪一层**失败。
- 上限 2000 → **5000**（D-30-5）。
- **一个父件的路径由导入目标决定**（`parentItemId` 仍是上下文），`1` 即导入目标本身；`1.1` 是它的直接子件，依此类推。

> **⚠ v2 新增（C3，18 号文 M-1~M-4 请求级记忆）**：导入是**同请求内先读后写**的典型（先解析文件、再逐行 `add()`）。
> 层级路径的解析**必须走"本次导入的行序列在内存中累积"**（`path → itemId` 边解析边填），
> **不得**建 `RequestCache`、**不得**每行回查库。
> 理由（M-4 的原话："本请求内会不会写它？会写就别记"）：若把 `path→itemId` 做成请求级记忆，
> 第 N 行写入后该记忆即过期，后续行按旧值解析 ⇒ 层级错挂，而且**症状是"静默挂错父件"**——
> 比报错严重得多。
> 参照既有正确做法：`BomService` 的两个缓存（`effectiveRevCache()` `BomService.java:1277-1283`、
> `cbbCodeCache()` `:1392-1397`）都是**每次调用新建的局部 Map**，刻意**不经** `RequestCache`，
> 本批沿用同一纪律。**这条写进代码注释**，防后人"优化"成 `RequestCache` 而引入 M-1 缺陷。

#### 2-B 三态一次性导入（D-30-2）

模板再加一列 **`视图`**（留空 = 该次导入指定的默认视图）。导入时**按视图列分组**，每组各自走 2-A 的同一条深度升序逻辑。

- 分组是**纯编排**，不新增判据：三组的每一行最终都落到同一个 `BomService.add()`。
- 回执增加"视图"列 ⇒ 一次导入多态后，用户能一眼看出哪一态的哪一层失败。
- 逐行独立、整批不回滚的口径**不变**。

> **⚠ v2 修正（C2，18 号文 E-3 / S-1 词表单源 + 12 号文 G-UI-8）**：v1 把"视图"列的取值**写死成
> EBOM/PBOM/MBOM 三个**，那等于给视图词表造了**第二份清单**——正是 S-1 点名的缺陷形态
> （"登记新值后调用方按报错补值仍被拒，**报错文案本身也是过期的**"）。
>
> **正确口径**：
> 1. 模板的"视图"列**说明行与可选值清单从 `BomViewCatalog.defs()` 生成**（`GET /boms/views` 已是既成读面），
>    **不硬编码**；模板示例行给 EBOM/PBOM/MBOM 只是**示例**，不是值域声明。
> 2. 导入侧校验视图值时，非法值报错 `IMPORT_VIEW_INVALID`，**message 必附合法值清单**（E-3 明文要求），
>    清单同样取自 `BomViewCatalog`，不得抄第二份。
> 3. `t_bom_line.bom_view` 的 DB CHECK 与 `BomService.BOM_VIEWS` 是既成事实源，本批**不加新值**、
>    **不改** `BomViewCatalog` 语义表；扩视图仍走 V-185 约定（`BomViewVocabularyTest` 从迁移 CHECK 解析比对）。
>
> ⇒ 结论：**"一次导三态"是界面与模板的默认形态，不是数据模型的限制**。用户文件里若写 REGBOM/SBOM，
> 同样合法（只要子件在库中存在）；这让模板不会因将来扩视图而过期。

### 5.3 批 3 · 三态对比

#### 3-A 层级路径 = 路径键（唯一实现点）

`树展开 → 扁平化 → 每节点带 path`。批 1 树表、批 2 导入回执、批 3 对比、树形导出**共用这一份**，不各算一次。

#### 3-B 跨视图对比端点（**五视图任选两视图**，D-30-8）

`GET /boms/compare-views?parentItemId=&leftView=&leftRev=&rightView=&rightRev=`

- **端点契约本就是参数化的**（`leftView`/`rightView` 是入参，不是硬编码三态）⇒ **D-30-8 放开五视图不需要改端点签名**。
- **视图值域校验**：必须过 `BomService.BOM_VIEWS`（= DB CHECK = `BomViewVocabularyTest` 解析源，V-185 约定），
  非法值 400 且 **message 附合法值清单**（E-3）。
- **不复制对比逻辑**：`indexByChild` / `diffFields` 从 `BomHeaderService` **提成可复用**（同族漂移源，陷阱 #34）。
- 现 `GET /boms/compare` **原样保留**（零回归），两个端点并存：前者比"同视图两 rev"，后者比"跨视图"。
- 键升级为 `(层级路径, 子件料号, 子件版本)`（D-30-1）。
- 权限点沿用 `bom.read`。

**空视图的处置（放开五视图后必遇到）**：dev 库实测各视图行数量级为
`EBOM 405 / MBOM 11 / PBOM 6 / REGBOM 5 / SBOM 2`（`BomDtos.java:336` 记的采样）。
⇒ **任一侧为 0 行时返回 `available=false + reason`（写明"左侧 SBOM 该版本无结构行"），不是返回"全部新增"**——
后者读起来像"右侧凭空多出 N 件"，是**把空集伪装成差异**，与仓库反复禁止的"少给当没有"同族。

#### 3-C 对比 UI：**两视图对比为原语 + 多视图并排为读面**

D-30-8 放开五视图后，"固定三列 EBOM|PBOM|MBOM"与"任选两视图"是两个不同形状。取法：

| 层 | 形态 | 说明 |
|---|---|---|
| **原语** | **任选两视图**（5 × 5，两侧可同视图） | 就是 3-B 的端点，可重复调用 N 次 |
| **读面** | **并排 N 列**，用户勾选要看的视图（**默认 3 列 EBOM/PBOM/MBOM**） | 差异高亮由相邻列对的原语结果合成 |

- **为什么两层都要**：只做原语 → 用户要回答"EBOM/PBOM/MBOM 三者什么关系"得点 3 次（EBOM↔PBOM、EBOM↔MBOM、PBOM↔MBOM），
  正是原需求想避免的往返；只做固定三列 → D-30-8 刚放开的 REGBOM/SBOM 没有入口，裁定落空。
- **界面不得硬编码视图名**：视图下拉与列头一律读 `GET /boms/views` 的 `BomViewDef`
  （`BomViewCatalog.defs()` 已在编辑器消费，`:267-275`），**S-1 单一事实源**。
- **D-30-9 逐视图软提醒**：`BomViewDef.softRuleCode`（`R-BOM-01~04`）非空时，在**该视图列头**显示对应软提醒
  （MBOM→R-BOM-01、REGBOM→R-BOM-02、SBOM→R-BOM-03、EBOM→R-BOM-04；PBOM 无）。
  软提醒**只提示不阻断**（`BomViewCatalog.java:21-24`：硬化会把存量 EBOM 405 行判违规）。
- 版式参照基线对比面板（`BomEditorPage.tsx:1380-1410`）。

**D-30-1 带来的可读性收益**：EBOM 的一行"组装件"在 MBOM 里拆成"螺丝/线束/标签"时，会呈现为**一条拆分差异**，而不是三条"仅 EBOM 有 / 仅 MBOM 有"的噪声。

---

### 5.4 接口契约对齐（v2 新增 · 逐条落 18 号文 / 12 号文 G-API-1）

> 本节是 v1 缺的一节。v1 把方案写成了"要做什么"，没有把**新端点/新错误码落进既有横切契约**；
> 18 号文与 12 号文 G-API-1 都是**产品级规格，新端点必须按它接入**，否则新域会立刻分叉出一套口径。

#### 5.4.1 端点契约总表

| 端点 | 方法 | 权限点 | 成功 | 失败（族） | 契约要点 |
|---|---|---|---|---|---|
| `GET /boms/export` | GET | `bom.read` | 200 附件 | 400 业务族（`EXPORT_TOO_LARGE`，**点名行数**）/ 403 授权族 | 文件名走 **RFC 5987**（`ContentDisposition.attachment().filename(n, UTF_8)`）；CSV 带 UTF-8 BOM；超 `TabularExport.EXPORT_MAX_ROWS` **报错不截断** |
| `POST /boms/import`（扩列） | POST | `bom.create` | 200 `ImportResult` | 400 校验族（`IMPORT_VIEW_INVALID` / `IMPORT_HEADER_INVALID`，**必附合法值清单**）/ 400 业务族（`IMPORT_PARENT_NOT_ESTABLISHED`） | **逐行独立、整批不回滚**的口径不变；新增两码均归既有 `IMPORT_*` 族 |
| `GET /boms/compare-views` | GET | `bom.read` | 200 `BomCompareResp` | 400 校验族（非法视图，**附五视图合法值清单**）/ 403 授权族 | **不可比时返回 200 + `available=false` + `reason`**（含"任一侧为空"），**不得**改成 400；差异集超限回 `truncated=true` + 生效上限（**不静默截断**）。**五视图任选两视图**（D-30-8），端点不特判视图 |
| 树形/懒加载取数 | GET | `bom.read` | 200 | 同上 | **复用既有** `GET /boms?parentItemId=&view=&rev=`；**不新建**端点（见 §7 D-1） |
| 深链 `/bom/:rootItemId` | GET | — | 200 页面 | — | **仍收根物料 id**（D-30-7）；**加法**支持 `?view=&rev=`，缺省行为与今天一致，既有深链零失效 |

**共通（E-1/E-2/E-5）**：以上全部走 `GlobalExceptionHandler`，4xx/5xx 一律返回同一形状 `{code, message, ts}`；
**堆栈/类名只进日志**，不进 `message`。

#### 5.4.2 新增错误码必须归入既有族（G-REF 4.2 硬要求）

| 新码 | 族 | 触发 | message 必须包含 |
|---|---|---|---|
| `IMPORT_PARENT_NOT_ESTABLISHED` | `IMPORT_*`（既有族） | 层级路径的父件尚未建立 | **行号 + 层级路径 + 可执行处置**（"把父件行放在子件行之前"） |
| `IMPORT_VIEW_INVALID` | `IMPORT_*`（既有族） | 视图列取值不在合法值域 | **合法值清单**（E-3；清单取自 `BomViewCatalog`，不硬编码） |

**不新造族**。既有的 `IMPORT_*` 族命名形状见 `BomImportExportService.java:158-233`。

#### 5.4.3 三条必须遵守的横切纪律

| 纪律 | 出处 | 本批怎么落 |
|---|---|---|
| **写路径不得新写历史端点** | G-API-1.3：各域共用 `AuditService.findByObject`，**新增域不得另写一套历史端点** | 对比面板要看"版本轴上的变更"时，**按 BOM 头 id** 取 `findByObject("bom", 头id)`，**不得**为对比新开 `/history`。注意既有 `GET /boms/{id}/history`（`BomController.java:150-154`）是**结构行 id** 维度，语义不同，不要混用 |
| **请求级记忆不得在写路径上新增** | M-1~M-4 | 见 §5.2 2-A 的 C3 说明：路径解析走内存累积，不建 `RequestCache` |
| **对比/导出结果集要有上限，且超限不静默截断** | G-API-1.2「超上限不静默截断」 | 见 §7 P5：`compare-views` 必须设差异行数上限并回显 `truncated` + 生效上限 |

#### 5.4.4 交付与门禁（14 号文 G-DEP / 13 号文 G-CI / 17 号文 T-C1）

- 新增运行态套件在 `ipd/deploy/wsl/plm-app/plm-suites.tsv` **登记一行**
  （`id / tier / kind / timeout_s / script / desc`），**禁止**在 CI 脚本里写第二份清单（T-C1）。
- 断言写成**特征串**以便 `self87-check-assert-needles.sh` 自校验（G-CI-3：抽取数为 0 判失败）。
- 发布一律走 `release-plm-app.sh`（G-DEP-1/2），**产物指纹门**要绿。
- 端点契约改动后跑 `plm-contract-paging-verify.cjs`（12 号文 G-API-1.2 验收锚点）。

---

## 6. 断言（可机检形态）

| # | 断言 |
|---|---|
| B30-01 | 编辑器树表与 `GET /boms/tree` 在同一 (rootItemId, view) 下节点数逐一致（直出与懒加载两条路径都要断言） |
| B30-02 | 下钻后面包屑显示的层级与 `BomNode` 的 `depth` 逐一致；`localStorage` 键与深链语义未变 |
| B30-03 | 多层导入：路径 `1 / 1.1 / 1.1.1` 的三行落库后，`GET /boms/tree` 能展开出三层结构 |
| B30-04 | 多层导入：子件行早于父件行 ⇒ 报 `IMPORT_PARENT_NOT_ESTABLISHED`（**400** 业务族）并点名**行号 + 层级路径 + 处置**，**该行不落库、其余行照常成功** |
| B30-05 | 多层导入：导入的每一行都经过 BR-07 校验与审计（断言 `t_audit_log` 有对应行、`bom.add`） |
| B30-06 | 多层导入：路径解析**不读 `RequestCache`**（M-1~M-4）—— 断言"同一请求内写入的行对后续行可见"，即第 2 行解析时能取到第 1 行刚建出的物料 |
| B30-07 | 三态导入：一个含三列视图的文件 ⇒ 产出 3 组结构行，回执按视图分组且失败行可定位到层 |
| B30-08 | 视图列填非法值 ⇒ 报 `IMPORT_VIEW_INVALID`（**400** 校验族）且 **message 附合法值清单**（E-3）；清单内容与 `GET /boms/views` 逐一致（S-1，无第二份词表） |
| B30-09 | 模板生成的"视图"列说明行，其可选值清单与 `BomViewCatalog.defs()` 逐一致（**防止模板成为过期的枚举副本**） |
| B30-10 | `mode=flat` 导出的行集与 `GET /boms?parentItemId=&view=` 逐行一致（导出物可与屏幕对账） |
| B30-11 | `mode=tree` 导出含层级路径列，且累计用量 = 该节点单层用量 × 父链各级用量之积 |
| B30-12 | 导出超 `TabularExport.EXPORT_MAX_ROWS` ⇒ 报错并点名行数，**文件不产出**（不静默截断） |
| B30-13 | 导出 CSV 带 UTF-8 BOM；中文文件名经 RFC 5987 后 `Content-Disposition` 头可见（手拼会让该头**静默消失**） |
| B30-14 | 跨视图对比：`leftView=EBOM&rightView=MBOM` 可用；`leftView=rightView` 返回 **200 + `available=false` + `reason`**，**不是 400** |
| B30-15 | 跨视图对比：一条"拆分"（EBOM 单件 → MBOM 三件）呈现为 1 条差异，**不是** 4 条噪声 |
| B30-16 | 跨视图对比：差异集超上限 ⇒ 回 `truncated=true` + 生效上限，**不静默截断**（G-API-1.2） |
| B30-17 | **所有新端点的 4xx/5xx 都返回 `{code, message, ts}` 三字段**（E-1），且 `message` 内无堆栈/类名（E-5） |
| B30-18 | 结构锁命中时界面展开升版表单，**原因为空或 <8 字时前端即拦截**（不给用户"提交后才被拒"的体验）；断言后端 `REASON_REQUIRED` 仍是最后一道 |
| B30-19 | 结构锁命中时界面给出升版入口，且**判据未被放宽**（断言 `BOM_FROZEN_STRUCTURE_LOCKED` 仍拒，`POST /boms` 直调亦被拒） |
| B30-20 | 对比面板的历史来自 `AuditService.findByObject`（**按 BOM 头 id**），且**未新增**任何 `/history` 端点（G-API-1.3） |
| B30-21 | `BomViewVocabularyTest` 仍通过（未引入第二份视图词表，V-185 约定） |
| B30-22 | 回归：BOM 域既有集成测试 + 物料库"结构内物料"作用域（`inBomOf`）用例全绿 |
| B30-23 | **五视图任选两视图**（D-30-8）：`(EBOM,MBOM)` `(EBOM,SBOM)` `(REGBOM,SBOM)` `(PBOM,PBOM)` 四组均可用，**端点未对视图做特判** |
| B30-24 | 视图入参非法（如 `view=DBOM` 幽灵视图）⇒ 400 且 **message 附五视图合法值清单**（E-3 + V-185） |
| B30-25 | **空视图不得伪装成差异**（D-30-8 衍生）：右侧 SBOM 该版本 0 行 ⇒ `available=false + reason` 点名"SBOM 该版本无结构行"，**不是**"返回全部新增" |
| B30-26 | **逐视图软提醒**（D-30-9）：MBOM / REGBOM / SBOM / EBOM 列头分别出现 `R-BOM-01`/`02`/`03`/`04`，PBOM 列头**无**软提醒；提醒文案与 `GET /boms/views` 下发逐一致 |
| B30-27 | **界面零硬编码视图名**：在对比面板源码里 grep `EBOM`/`PBOM`/`MBOM` 字面量 = 0（视图名只从 `GET /boms/views` 来，S-1） |
| B30-31 | **多视图一次导入各归其位**：同一文件内 EBOM/MBOM/REGBOM 三行，逐视图回读**各 1 行**，且回执 `rows[].bomView` 逐行点名（防 P9 的"静默挂错父件"回归） |
| B30-32 | **层级路径列用短名也能读懂**：表头写 `层级路径`（而非模板里的 `层级路径(留空=…)` 长串）**必须照样生效**（防 P8 的"列被静默丢弃"回归） |
| B30-33 | **导入上限 5000 行**（D-30-5），超限报错**点名行数与上限**、不静默截断 |
| B30-29 | **「0 行」不静默**：`flat` 导出取到 0 行而该 (父件,视图) 在**别的版本**上有行 ⇒ 报 `EXPORT_EMPTY_VERSION`（400 业务族），message 点名"另有 A 版 N 行"并给出两条出路；**不是**产出一份只有表头的 CSV |
| B30-30 | **守卫不误伤**：`flat` 导出行数 > 0 时**不得**触发该守卫（实测 dev 库 MBOM 6 行正常导出） |
| B30-28 | 深链**加法兼容**（D-30-7）：`/bom/:rootItemId`（无查询串）与 `?view=PBOM&rev=B` 两种 URL 都能正确打开对应视图；既有 e2e 探针的裸路径**全部仍绿** |

> **门禁登记（T-C1 / G-CI-3）**：B30-01~B30-22 中凡属运行态的，须在
> `ipd/deploy/wsl/plm-app/plm-suites.tsv` **各登记一行**，断言写成特征串以进
> `self87-check-assert-needles.sh`；端点契约相关用例与 `plm-contract-paging-verify.cjs` 同批跑。

---

## 7. 技术债与文档矛盾登记（**登记，不擅改**）

| # | 事项 | 处置 |
|---|---|---|
| **P1** | **occurrence（用量随父而异）**：`t_bom_line` 存的是"物料A 的子件是物料B"，"物料B 的子件是物料C"存在**另一行**。同一组装件在整机A 与整机B 下**共享同一份子件行**，无法表达"A 产品的组装件用 2 颗螺丝、B 产品用 3 颗" | D-30-6：本期不动，登记为技术债。若未来要支持，需引入 BOM 实例级用量（occurrence 模型），属重大模型变更 |
| **P2** | **无 `depth`/`path` ⇒ 性能目标无保障**：`01-技术选型决策.md:90` 与 `16-性能保障规格.md:35` 定的是"10 层 BOM 10 万节点 where-used **P95 < 3s**"，但 `tree()` 默认 `maxDepth=6` 且是 Java 侧逐层展开（非 PG 递归 CTE） | D-30-6：本期靠 1-B 的懒加载规避规模问题，**不引 `ltree`**。谁在 10 层/10 万节点上跑过 where-used，请补实测数据再议 |
| **P3** | **`compare()` 是平铺单层 diff**：同一子件在第 2 层和第 5 层各有一条时会被当成两行分别比较，读者看不出"哪一层变了" | 由 3-A 的路径键顺带解掉 |
| **P4**（v3 **订正**） | v2 曾写"放开五视图需同步扩展 `BomViewCatalog` 语义表与 `BomViewVocabularyTest`"——**该判断是错的**。实测 `BomViewCatalog.DEFS` **本就是 5 个视图**（`BomViewCatalog.java:31-46`：EBOM/PBOM/MBOM/REGBOM/SBOM），与 `BomService.BOM_VIEWS`（`BomService.java:1363-1364`）逐字相等，`defs()` 的自证断言（`:51-55`）**开箱即过** | D-30-8 放开五视图**零改动**、零迁移。保留本条作为**v2 判断错误的记录**（防后人再按 v2 稿去"补语义表"而造出第二份定义） |
| **P7**（批 1 **实施中新增**，设计未预见） | **`flat` 导出与结构树按不同版本口径取数**：`BomService.list` 取**头当前版本**（编辑面口径），`BomService.tree` 取**有效版本**（已发布优先，批次60 · D60-6）。二者**都合法**，但会分叉：实测父件 19 的 EBOM 头已到 B 版（DRAFT）、结构行只在 A 版（已发布）⇒ `/boms` 0 行、`/boms/tree` 2 行 | **已加守卫 `EXPORT_EMPTY_VERSION`**：flat 取到 0 行时去问"该 (父件,视图) 在**别的版本**上有没有行"，有则报**点名版本 + 两条出路**的可行动错（改树形模式 / 改到那一版），**不沉默给只有表头的空文件**（"把'看不到'伪装成'没有'"是本仓明令禁止的形态）。刻意**不替用户选版本**——"该看哪一版"是业务判断（下游按已发布那版制造、编辑者按当前版改），系统无权代劳 || **P8**（批 2 **实施中发现**，**既有潜伏缺陷**被新模板触发） | `BomImportExportService.headerIndex` 按**整串 label 全等**匹配表头。而模板 label 是 `结构行态(留空=草案)` / `层级路径(留空=第一层；1.1=该件的子件)` 这种"列名 + 帮助文本"长串 ⇒ 用户（或二次编辑过文件的同事）把它简化成 `结构行态` 后，**该列匹配不上、被静默丢弃**，导入**照样逐行报"成功"**。对批 0 的 6 列模板**同样成立**（只是恰好没人简化过列名） | **已修**：列身份取**括号（半角/全角）之前**那段，括号内是给人看的说明、不参与匹配；匹配优先级 = 整串 label &gt; 内部 code &gt; 括号前缀。未知列仍忽略（允许用户加备注列），但**必填列缺失仍报错** |
| **P9**（批 2 **实施中自己引入并当场修掉**） | 层级路径的 depth-1 内部键曾是 `""`（意为"父是导入目标"），而"导入目标本身"也用 `""` 作键 ⇒ **键相撞**：第一个 depth-1 行落库后 `parentByPath[""]` 被覆盖成那个子件的 id，**后续所有 depth-1 行都挂到第一个子件身上**。症状=**静默挂错父件**，回执全绿 | **已修**：路径**原样保留**（`"1"` / `"1.1"`），"导入目标"改用不可能与数字路径同形的哨兵 `#ROOT`，两者**永不相撞**。已加断言：多视图导入逐视图回读各 1 行（B30-07） |
| **P5**（v2 新增） | **`compare()` 差异集无任何上限**：`BomHeaderService.compare()` 返回的 `added/removed/changed` 不设行数上限（`BomHeaderService.java:603-634`）。多层结构 + 两版本大改时，差异集可达整棵树规模 | 本批**新端点**必须设上限并按 G-API-1.2 回 `truncated` + 生效上限（**不静默截断**）。既有 `compare()` 的同一缺口**本轮不擅改**（改它会影响既有消费者），登记为技术债 |
| **P10**（批 3 **实施后遗留**） | `BomDiffKernel.compare()` 的**位置替换**判定是「同路径首次出现」的**逐行线性扫描**（对右侧每一行查首个同 path 者）。当前规模（单条 BOM 数百行）无感，但**大结构 + 大差异**时是 O(n·m) | **已登记不擅改**：改为按 path 预建 Map 只需一次改动，但本批已过验证；且 16 号文 S-9 的性能门（10 层 P95<3s）覆盖的是树展开而非对比。若后续 `compare-views` 进入性能门，按"按 path 预索引"优化，**判据不变** |
| **P11**（批 4 **实施后遗留**） | 本页并列比例仍是**内联 `1fr 300px`**，与全站共享的 `.dual.split.detail40`（`1.5fr/minmax(330px,1fr)`）**不一致**；本页因此是全站唯一不靠 CSS 类定比例的接入页 | **已登记不擅改**：改成 `detail40` 是**可见版式改动**且非 G-UI-7 接入所必需。三态全屏本身不受影响（两个全屏类都带 `!important`，能压过内联）。若要统一，作为独立版式决策单独确认 |
| **P6**（v2 新增） | **`t_bom_line` 无 `updated_at` / `version` 列**：只有 V113 加的 `created_by`/`created_at`。18 号文 V-1 要求"每一次内容写都必须推进可观察的版本面"，本表**当前不满足** | 本批导入走既有 `BomService.add()`，**行为不变、不加列**（加了会牵动 `t_bom_line` 全部写路径与既有唯一键判据）。登记为技术债，与 P1 同属"动数据模型"的范畴，一并裁定 |
| **D-1** | **设计文档与实现冲突**：02 号文 §3.2:236 规划的懒加载端点 `GET /api/v1/bom/{parentId}/children` **从未实现**，且路径单数 `bom` 与实际前缀 `/api/v1/boms` 不一致 | **本号文不新建该端点**（复用 `GET /boms?parentItemId=&view=`）。02 号文的路径表述待该文自行订正——**未经确认不改设计文档** |
| **D-2**（v2 订正） | **08 号文 G-UI-7 接入阻塞 —— v1 把"三态锚点"解释成"头/物料/结构三选一"，那是 v1 的措辞错误，08 号文并无此枚举**。订正后的事实：① G-UI-7 的"三态"是**布局三态**（`grid` 表格全屏 / `dp` 详情最大化 / `split` 并列），由 `data-panel-state` 承载（`frontend/01-design-tokens-shell-layout.md:217-237, 248-253`）；② 实测 `BomEditorPage.tsx` **未调用 `usePanelMax`**（12 个已接入页里没有它）⇒ G-UI-7 接入确实未做，与 08 号文 §4.2 一致；③ "哪个对象的三态锚点"的真实含义是 **`?open=` / 路径参数里的 id 锚定哪个对象** —— 现状 `/bom/:rootItemId` 收的是**根物料 id（`t_item.id`）**，而 `t_bom.id` 是另一套数字空间（`lib/routes.ts:95-97` 已警告"拿 `t_bom.id` 当根物料 id 会打开另一棵树（跳错）"）；④ `lib/routes.ts:108` 与 `objRef.ts:40-44`（`SUPPORTED` 无 `BOM`）已一致登记 **BOM 无"按条目直达"深链、引用不可点** | **已裁定 D-30-7：维持现状，收根物料 id**，配套加 `?view=&rev=` 查询串（§5.1 1-A）。**本批 1-A 的下钻链天然沿用"根物料 id"**（面包屑逐级是物料链），与该裁定同构 |
| **D-5**（v2 新增） | **08 号文 §4.2 的"C 档唯一剩余待办"措辞已过期一半**：`frontend/01` G-UI-7-9（2026-09-28）已把契约标记类扩展为 `.grid-wrap`/`.tree-max`/`.list-max` 三个并声明"C 档『需新增 CSS 契约类』的待办就此关闭"（`:345-376`），而 08 号文同日只更新了 §4.1 接入现状、**§4.2 待接入表未同步** | **本号文不擅改 08 号文**。BOM 编辑器真实剩余的是**接入动作**（调 `usePanelMax` + 挂 `data-panel-state` + 定初始态），**不是**"需要新 CSS 契约类"（它可复用 `.grid-wrap`）。**已裁定 D-30-10：单独一批做（批 4）**，不混进 BOM 功能批 |
| **D-3**（v2 新增） | **14 号文 G-REF 4.2 后端通用件清单未收录 `TabularExport`（及前端 `ExportPanel` / `lib/download.ts`）**：14 号文缺陷档案第 3 条已自认"G-REF 构件清单未覆盖后端全部通用件：目前收录 6 项"。本批要复用的正是这三个件 | **建议**在 14 号文 G-REF 4.1/4.2 补登记（事实源已在 `05-interactions-part2a §6.14`）。**已裁定 D-30-12 ②：获授权由本号文补登记**，执行清单见 §9 附记（与批 1 同批提交） |
| **D-4**（v2 新增） | **本号文 v1 与 18 号文 E-4 冲突**（C1：「一键升版」在 `revise` 的 `reason ≥8 字` 门禁下必然失败） | 已在 §5.1 1-D 修正为"就地展开升版表单（原因必填）+ 成功后自动续建"。本条保留在册，**作为 v1 设计错误的记录**，防后人按 v1 稿实现 |
---

## 8. 待裁定 —— **已全部裁定完毕（2026-10）**

> 保留本节作为**裁定台账**，不删。表中历史"建议"已全部转为 §1 的 D-30-7~D-30-12。

| # | 问题 | 裁定结果 |
|---|---|---|
| A（= **D-30-7**） | BOM 编辑器深链 id 锚定哪个对象 | **维持现状：收根物料 id**（`t_item.id`），既有深链零失效；**加法**配 `?view=&rev=` 查询串 |
| A2（= **D-30-10**） | 是否本批顺带完成 G-UI-7 接入 | **否，单独一批做**（布局契约与 BOM 功能正交） |
| B（= **D-30-8**） | 对比的视图范围 | **放开五视图任选两视图**；UI = "两视图对比为原语 + 多视图并排为读面（默认 EBOM/PBOM/MBOM 三列）" |
| C（= **D-30-11 ①**） | 累计用量是否双列 | **单层用量 + 累计用量两列都给** |
| D（= **D-30-11 ②**） | 层级路径写法 | **点分数字**（`1.1.1`） |
| E（= **D-30-11 ③**） | 懒加载阈值是否配置项 | **硬编码为单一常量**（2000 节点），不做配置体系 |
| F（= **D-30-12 ①**） | 差异行数上限 | **截断 + `truncated=true` + 回显生效上限** |
| G（= **D-30-12 ②**） | G-REF 补登记归属 | **由本号文补登记**进 14 号文 G-REF 4.1/4.2（已获授权，见 §9 附记） |
| H（= **D-30-12 ③**） | 既有 `compare()` 是否收口 | **不收口**，只在新端点设限（P5 留档） |

**裁定带来的两处连锁修正**（不是新问题，是 A、B 的直接后果）：

| # | 连锁项 | 处置 |
|---|---|---|
| **C-C1** | A 定了"URL 不区分视图" ⇒ 分享链接打不开指定视图；D-30-8 放开五视图后用户要频繁切视图 | 加 `?view=&rev=` 查询串（§5.1 1-A）。**加法**：缺省行为与今天完全一致 |
| **C-C2** | B 放开了 REGBOM/SBOM，而 dev 库这两视图只有 5 / 2 行（`BomDtos.java:336` 采样）⇒ 极可能出现"一侧空"的对比 | 空侧返回 `available=false + reason` 点名，**不得**返回"全部新增"（§5.3 3-B / 断言 B30-25） |

---

## 9. 实施顺序与回归

| 批 | 内容 | 风险 | 前置 |
|---|---|---|---|
| 批 1 | 1-A 下钻 + `?view=&rev=` 深链 · 1-B 树表 · 1-C 导出 · 1-D 引导 | **低**（复用为主，改动集中于 `BomEditorPage.tsx` + 新增 `BomExportService`） | 无（裁定已清零） |
| 批 2 | 2-A 多层导入 · 2-B 多视图导入 | 中（模板与解析是既有件加列，但分组编排是新的） | 批 1 的 3-A 路径键 |
| 批 3 | 3-B 五视图跨视图端点 · 3-C 多视图并排对比 UI | 中（对比内核提取影响既有 `compare()`） | 批 1 + 批 2 |
| **批 4（独立）** | **G-UI-7 接入**（调 `usePanelMax` + 挂 `data-panel-state` + 定初始态 + 复用 `.grid-wrap`） | 低 | 与批 1~3 **正交**，可并行；走 W42/W43 门 |

每批落地后跑：BOM 域集成测试 + 物料库"结构内物料"作用域（`inBomOf`）回归 + `BomViewVocabularyTest`，再进下一批。

### 附记 · D-30-12 ② 授权的跨文档动作

已获授权补登记 **14 号文 G-REF**（本批的落地动作，非本号文内部修改）：

| 位置 | 补登内容 |
|---|---|
| 14 号文 §4.1 前端构件 | `ExportPanel`（导出面板 UI + 下载动作 + 结果/错误文案）、`lib/download.ts`（`downloadAttachment` / `fileNameFromContentDisposition` / `blobErrorText`） |
| 14 号文 §4.2 后端通用件 | `TabularExport`（`ExportSpec`/`ExportRow`/CSV+xlsx/`EXPORT_MAX_ROWS`/`tooLarge()`） |
| 14 号文 §4.2 纪律列 | 追加"**取数与筛选留在各域**、**表格→字节与面板 UI 走公共件**；各域不得内联第二份下载逻辑" |

**事实源**：`05-interactions-part2a §6.14`（六条硬约束，已成文）。
**执行时机**：与批 1 的 `BomExportService` **同批提交**——登记的是"本批正在复用的既有件"；
不先登记就等于让 `BomExportService` 落在 G-REF 覆盖之外（正是该缺陷档案第 3 条的形态）。
