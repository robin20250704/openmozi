# 已收敛项（防误报）与未核实清单

> 索引与覆盖度声明见 [ui-logic-gap-analysis.md](ui-logic-gap-analysis.md)。现行缺陷见 [ui-gaps-open.md](ui-gaps-open.md)。
> **本轮（补扫需求管理/文档管理/计划任务）新证否 9 条**，见 [ui-gaps-dispelled.md](ui-gaps-dispelled.md)。

## 一、已复核为「非缺陷」——**不要重复报**（第一次横切面审计产出）

本仓 2026-09~10 做过一轮密集整改。以下问题**看起来严重但已修好**，逐条附证据。
任何后续审计若重新提出这些，说明没有先读这一节。

| # | 曾被怀疑 | 现状与证据 |
| --- | --- | --- |
| 1 | **DCP0 GO 三联动可能只成功一半**（任务书冻结 + BizPlan v1.0 + 自动建项目三写不同事务） | **原子，确认无问题**。`ReviewService.java:805` `@Transactional public ReviewResp decide(...)`；`:892-895` 在同一方法内调 `activation.activate(charterId, reviewId, req.conclusion())`；`CharterActivation.java:168,175` 标 `Propagation.REQUIRED` ⇒ 加入调用方事务 ⇒ 三动作同生共死。附带：`ReviewService.java:891-892` 对订正通道（`supersedes_id != null`）显式跳过副作用重放，V112 已堵「订正一次产生一份重复 BIZPLAN」（`:883-890` 留档该事故机理）。 |
| 2 | **任务书 JSONB 四区「留空=清空该区」用户不知道，会误清财务估算** | **已在 UI 披露**。`CharterPage.tsx:99-100` 常量注释定义该语义；`:642,648,651,652` 四个字段标签**逐个带「（留空=清空该区）」**；`:454` `if (t === '') return { ok: true, value: {} };`。 |
| 3 | **脱敏态下编辑会写坏数据**（`***` 占位被当对象、清空框写入 `{}`） | **已处理**。`CharterPage.tsx:626-628` 记 REQ-2026-0790 原缺陷：脱敏值是 truthy 字符串 ⇒「无权限」提示永不可达；修法是优先读契约字段 `finEstimateMasked`。`:510` 脱敏态任何情况下不回写；`:646` 换成只读占位；`:804,911` 不把 `***` 当对象 `JSON.stringify`。 |
| 4 | **「虚拟件」/「互替组」两套命名指同一件事** | **V210 已收敛**。`ItemLibraryPage.tsx:51,57,60,62` 四个常量与后端 `SubstituteService.SUBSTITUTE_GROUP_CLASS` **同名同值**；`:45-48` 注释明写「⚠ **不是**采购类型 PHANTOM：那是『自制/外购/虚拟件』里的第三档『不占料』，与互替组无关」；导入说明 `ItemImportExportService.java:250-264,463,468-476` 与 UI 词表一致，并拒绝在采购列填「互替组」给正解。**残余**：「虚拟件」在采购档位与历史别名之间的语义歧义仍在（读码仍需靠注释区分），但**界面已无歧义**。 |
| 5 | **`t_product.status` 有第二套词表（英文 `ACTIVE`）** | **V212 已收敛**。V212 ① 加 `CHECK ck_product_status_vocab` + 存量归位；前端 `ProductStructurePage.tsx:864,883` 已用中文 `'概念'`；`statusPill.ts:26` 有 `'概念'` 配色；`HistorySection.tsx:23` 注明「产品域的状态码本身就是中文，不能假设一定是英文码」。**注意**：残留的 `'ACTIVE'` 字面量属**委派**（`GovernancePage.tsx:401`）、**签署**（`ReviewWorkbench.tsx:1069,1094,1096`）、**时间线节点**（`ProjectFlowTimeline.tsx:42,135`）三个不同域，**不要误报为产品状态残留**。 |
| 6 | **BOM 并发冲突无回执通道，409 后改动丢失** | **已存在**。`BomEditorPage.tsx:372`：「409 并发冲突自动分流到冲突块（带『刷新重取』出口）。BOM 此前没有并发回执通道。」另 `:1053` 注释说明批量路径**有意**不走逐行客户端循环（`400 行 = 400 次请求 + 400 条审计`）。 |
| 7 | **V212 新加的产品线双列约束在 UI 上没有出口** | **这是正确的，不是缺口**。全仓 `productLine` 仅 `TasksPage.tsx:973` 以 `kind:'lookup'` 编辑 **`productLineId`（id）**；`:976` `productLineName` 是服务端解析的**只读**展示；`:977` `productLineNote` 给出「未归属」可读原因（`TasksPage.tsx:17` 注明「不把 NULL 渲染成默认值」）；`ProjectsPage.tsx` 中 `productLine` **0 处命中**。⇒ UI 从不写 name，与 `ck_project_product_line_needs_authority` 的「id 权威」口径完全一致。 |
| 8 | **项目生命周期三处词表不一致**（库 CHECK 11 / YAML 10 / 前端 11） | **2026-09-25 已收口**。`flows/project-flow.yaml:34-47` 补声明 `已终止` 为无出边终态（语义零改动、不新增转移边）。`ProjectCockpitPage.STATUS_OPTIONS` 已**整份删除**（全仓 `STATUS_OPTIONS` 仅剩 `ProjectsPage.tsx:1330` 一处，即 PRJ-01）。**残余**：见 PRJ-01。 |

---

## 二、未核实清单（**没查，不等于没问题**）

### 2.1 已在本轮结清（原「整模块未覆盖」三项）
需求管理 / 文档管理 / 计划任务三个模块的深扫已完成，结果：
**1 条现行缺陷（MSG-01）+ 9 条证否**。逐条见 [ui-gaps-dispelled.md](ui-gaps-dispelled.md)，
未结清的残余项：
- 需求管理：前后端**字段级**校验规则是否同源（只核实了词表与基数两层）；
- 计划任务：工作日历日期口径前后端一致性（`SettingsPage.tsx:1001` 周一起始表头，**未与后端比对**）。

### 2.2 已知但未取证（断点）
- **BOM 成环/递归上限**：`/boms/tree` 多层展开有没有深度限制；BOM 允许自引用吗；前后端哪一层拦。
- **BOM 破坏性批量操作**：`BomEditorPage.tsx` 批量导入 / 批量改数量 / 批量删除有无 `confirm` 二次确认。
- **BOM 成本口径**：界面是否说明成本是估算值；密级 SECRET 区域在 BOM 成本汇总里怎么处理。
- **物料「未解析互替组」筛选器**：`substitute-controller` 的未解析过滤是否有 UI 入口（全仓未定位到）。
- **任务书「不能删除」的替代路径**：TERMINATE 决策 → 主席签署 → `REJECTED` + 处置清单草稿，实际需要几次点击、入口是否可发现。
- **项目双入口**：`ProjectsPage.tsx:980-987` 记「a) 快速立项=直建（初始·立项） b) 任务书正门=DCP0 GO 自动建项目（初始·概念）」——两个入口进同一「概念」阶段但初始态不同，是否让用户在项目列表里分不清项目来源（**C 类重点**）。
- **文档文件夹**：`doc-folder` 是树还是扁平、成环防护（本轮只证否了 ticket 与交付物两问）。

---

## 三、补扫方法（供下一轮直接接续）

1. **不要整读大 TSX。** `grep` 定位 → `read` 带 `offset/limit`（单次 ≤60 行，单文件累计 ≤350 行）。
   本次 12 次 subagent 崩溃**全部**源于整读 60–192 KB 的 TSX。
2. **主代理自查 > 委派。** 本会话 subagent 通道 12/12 失败。
3. **横切面优先于逐页面，但补扫必须做。** SYS-01 靠一次横切面普查拿到 8 处硬编码；
   而 **MSG-01（里程碑一词二义）只能靠补扫得到**——横切面看不见"同一个词在两个域各指什么"。
   两者不可互相替代。
4. **每条结论标注三态**：`现行缺陷` / `已收敛（附证据）` / `未核实`。
   **缺双侧证据的一律进 §二，不得进正文。**
5. **前两轮共证否 13 条**（本文件 8 条 + [dispelled](ui-gaps-dispelled.md) 9 条中有重叠去重前 13 项存疑），
   再次说明 `gaps.md` §④ 的判据成立：**假告警与最危险的缺陷长得极像**，先证否再落笔。
