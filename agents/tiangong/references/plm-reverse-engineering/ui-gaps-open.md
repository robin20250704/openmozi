# UI ↔ 业务/后台 缺口：现行缺陷 · 索引与横切面（2026-10-05）

> 覆盖度声明与处置顺序见 [ui-logic-gap-analysis.md](ui-logic-gap-analysis.md)。
> 每条均双侧证据。复核请换解析路径（`gaps.md` §④ 有全假告警前例）。
>
> **2026-10-05 更新**：用户裁定 `请开始修改`（D-6 对本文件所列 SYS-01 已解除），**已修**，
> 处置见 §三。其中两条"权威侧"经全库 151 个 CHECK 闭集实测后**证否并订正**（见 §二 校订）。
> **追加（D-18）**：SYS-01 的 (a) 路线已由用户**裁定不做**；密级/创新类别改由 `V214` 升格为**库 CHECK**，
> 落地与验证见 §3.4–3.5。

## 一、现行缺陷速查（5 条 · **已于 2026-10-05 全部整改**）

| ID | 分类 | 严重度 | 域 | 一句话 | 状态 · 详细 |
| --- | --- | --- | --- | --- | --- |
| **MSG-01** | C | 中 | 计划任务 / 项目 | 「里程碑」一词指两样零外键的东西：任务是**形状**开关，项目是**时间点**实体 | ✅ 已修（纯标签）· [→](ui-gaps-open-domains.md) |
| **PRJ-01** | C+B | 中 | 项目管理 | 同一页面并存两套项目生命周期词表，一套写死 | ✅ 已修（11/11 逐字节一致）· [→](ui-gaps-open-project.md) |
| **PRJ-02** | C+B | 中 | 项目管理 | TDP 产出页违反本域已明立的「终态从服务端读」裁定 | ✅ 已修（失败即提示）· [→](ui-gaps-open-project.md) |
| **BOM-01** | D | 中 | BOM编辑 | 新建多层 BOM 必须逐级下钻；递归能力只用于查看 | ✅ 已修（挂载目标解耦）· [→](ui-gaps-open-bom.md) |
| **SYS-01** | C | 中 | **横切面·全部 8 模块** | 值域同源只覆盖变更/售后五域，8 处核心词表仍写死 | ✅ **已修**（(a) 裁定不做 · 另加 2 个库 CHECK）↓ 本文 §三 |

**已收敛、不要重复报的 8 条**见 [ui-gaps-settled.md](ui-gaps-settled.md) §一（第一轮横切面）。
**已证否 11 条**见 [ui-gaps-dispelled.md](ui-gaps-dispelled.md)（第二轮 10 + 整改期第三轮 1）。
**合计 24 条**（5 现行 + 8 已收敛 + 11 证否）——本轮深扫**证否 4 条疑似缺陷**，见 settled §二。

---

## 二、SYS-01 值域同源机制只覆盖变更/售后五域，8 个核心模块仍在前端硬编码
**分类**：C（概念重复） · **严重度**：中 · **性质**：当前值全部一致，是**结构性风险**而非功能故障

**机制与已覆盖范围**（服务端下发值域 + `code→label` 显示词）：
- 端点：`GET /ecos/enums`、`/pv/enums`、`/risk-ledger/enums`、`/_platform/risk-rules/enums`、`/pcos/enums`。
- 前端封装：`src/domain/ecoEnums.ts:11`、`src/domain/pvEnums.ts:5`、`src/domain/riskEnums.ts:14,71,104`。

**代码内已写明的漂移机理**（`PostMarketPage.tsx:25`）：
> 而后端 `GET /pv/enums` 早就把同一份词表下发着（含中文显示词）——**两份口径必然漂移**。

**本次 8 模块内的硬编码副本**（已逐条与库 CHECK/后端常量比对，**值均一致**）：

| 前端位置 | 硬编码值 | 权威侧 |
| --- | --- | --- |
| `DocumentsPage.tsx:33` | `SEC_LEVELS = ['内部','秘密','机密']` | ⚠ 见下方**校订 1** |
| `ItemLibraryPage.tsx:1010` | `materialType: ['常规','一次性耗材']` | `V7__item-bom-change.sql:15` `CHECK (material_type IN ('常规','一次性耗材'))` |
| `ProjectsPage.tsx:915` | `projectClass: ['A','B','C']` | ⚠ 见下方**校订 2** |
| `ProjectsPage.tsx:924` | `clinicalPath: ['EXEMPT','PREDICATE','TRIAL']` | `V1__schema.sql:114` |
| `ChangeDetailPage.tsx:1054` | `effectivityType: ['DATE','SERIAL','BATCH','IMMEDIATE']` | `V7:44` `CHECK (effectivity_type IN (...))` |
| `ProductStructurePage.tsx:712` | `medClass: ['I','II','III',{NA}]` | `V72__product-kind.sql:11` |
| `ProjectsPage.tsx:1330` | 11 个生命周期阶段 | `flows/project-flow.yaml:3-47`（= PRJ-01） |
| `TdpOutputsPage.tsx:445` | `['已终止','退市']` | `V162:34-43`（= PRJ-02） |

> **⚠ 2026-10-05 校订（库实测后改写，原文如上）**——上表两条"权威侧"经本轮
> 对 `plm_test` 全库 151 个 `CHECK` 闭集的实测**证否**，故标 ⚠。原判定是"值都一致、只是没同源"，
> 实测后必须承认：**这两处连"会强制的一致"都不存在**。这类"看着有权威、其实没有"的错，
> 比单纯的硬编码更危险——它会让人以为已经有人管着了。
>
> **校订 1 · 密级**：原写「`DocumentDtos.java:24` `SECURITY_LEVELS`」。
> 该常量**确实存在**，但**从不被强制执行**：`DocumentService.java:226,423` 只把它当默认值透传、
> **从不比对**。库侧 `V18:16` 仅有 `security_level TEXT NOT NULL DEFAULT '内部'`，**无 CHECK**。
> ⇒ 越界密级**静默落库**（不是 400），而 `DetailPanel` 的 `select` 渲染不出对应选项 ⇒ 读回来是一格空白。
> 更正后的定性：「**声明了但不是权威**」。
>
> **校订 2 · 创新类别**：原写「`V1__schema.sql:111`；`V73:35` 事后加 CHECK」。
> `V73` 的 CHECK 落在 **`innovation_type`**（另一根轴）上，**不是** `project_class`；
> `t_project.project_class` **至今无 CHECK**。⇒ 同样属于「有常量、不强制」。
> 已把两处都降级为 `ProjectVocabulary` 具名常量，并把 `ui-only` 断言挂进 parity 脚本。

**这正是本仓已踩过的坑**（`V72__product-kind.sql:119-121`）：
> 实测 2 条项目为 'C'（与 project_class 的 A/B/C 串轴）——置 NULL 表示「未填」

即 `innovation_type`（另一根轴）被灌入 `project_class` 的值，**事后由 `V73:5,35` 加 CHECK 补救**。
`V73:35` 原话：
> 注意：与 project_class（IPD 分级 A/B/C）是**两根不同的轴**，不要写入分级值（V73 已加 CHECK 约束）。

**影响**：库 CHECK 一改，上述任一处**不会收到任何信号**。前车之鉴证明这不是理论风险——
同一份迁移里已发生过一次真实串轴，且是**先污染、后加约束**的顺序。

**建议**：两条路任选其一——
(a) 把 `/enums` 同源机制推广到上述 8 处（改造成本低，前端已有 `useFlow` 缓存范式）；或
(b) 写 `scripts/check-vocab-parity.cjs`：断言前端每处硬编码枚举 ⊆ 对应库 CHECK 值域，
变成「库 CHECK 一改就报出」的回归断言（不要求改前端，只要能**及时发现**即可收敛）。

> 判据（沿用 `gaps.md` §④ 教训）：**只加约束不加出口/不改源，会把人逼去 `DROP CONSTRAINT`**。
> 故优先 (a)，(b) 只作过渡防线。

### 补扫后的边界（本轮新增，已核实）
全 `src/pages/` 的**硬编码中文值域**普查（正则 `\['汉` 命中 18 处）逐条判定后：
- **需求管理 / 需求基线 / 计划任务 / 甘特 / 业务计划：零命中** ⇒ 本缺陷形状**不出现在**这三模块。
- 命中项中 `ChangeDetailPage.tsx:95/1596/1598` 、`ProjectsPage.tsx:41`（页签）、
  `DocumentsPage.tsx:1215`、`RegistrationPage.tsx:590`、`SettingsPage.tsx:443/1001`、
  `CharterPage.tsx:138`（页签）、`PipelineLifecyclePage.tsx:74`（注释）**均为非值域或已在表内**。
- **待核**：`OfferingsPage.tsx:43 REPURCHASE = ['日','周','月','季','年']`、`SettingsPage.tsx:387 ['活跃','停用']`
  （均属 IPD/治理域，不在本 8 模块的横切范围内，未纳入上表）。

---

## 三、SYS-01 处置（2026-10-05 · D-16）已修 · 采纳 (b) 并额外清重复副本

### 3.1 为什么没选 (a)
(a) 是把 `/enums` 机制推广到 8 处。**这条被用户明确否掉之前我先量了成本**：
8 处里有 5 处的权威是**库 CHECK**——CHECK 不是接口，DB 不跑 HTTP。
要在运行期下发它，就得**新建**一个读 `pg_constraint` 的端点。这不是"推广既有机制"，
是**发明一个从未存在过的运行时依赖**（而 CHECK 只有在迁移执行时才是活的）。
故按建议里的 (b) 做，并把 (a) 留作业务裁定（已裁定：**(a) 不做**，见 §3.4）。

### 3.2 做了什么
1. **一次性普查**：全库 151 个 `CHECK` 闭集抽成快照 `scripts/vocab-authority.snapshot.json`
   （150 个唯一 `table.column`；1 处重复是**重叠约束**，非冲突，见 `ui-gaps-dispelled.md`）。
2. **消重复副本**（这一半的病根其实是 C「同一事实两处实现」）：
   - `ProjectService` 2 处内联词表 → 新建 `ProjectVocabulary`（`CLINICAL_PATHS`/`PROJECT_CLASSES`/`CLINICAL_PATH_LABELS`），
     临床路径现在会**拒绝**非法值并列出全部合法值与其中文（此前静默入库）；
   - 管理类别走既有的 `MedClasses.ALL`（REQ-2026-0781 早已建好，此前 `ProjectService` 仍在抄第 2 份）；
   - 6 处前端词表统一提到 `projectFilters.ts` 并**标注值域归属**（`duplicate-of-server` / `ui-only` / `server-derived`）。
3. **加机械防线**：`scripts/check-vocab-parity.cjs`（已挂 `npm run check:vocab`），
   8 条注册项按 3 种权威类型分别断言；`--refresh` 重取库闭集；`--self-test` **自带 17 例解析器自测**。
   17 例中 5 例是 `CHECK` 解析（含 V214 新增的**可空闭集** `IS NULL OR …` 与**首条中文值**闭集两种形态）——
   这两种都是本轮新造的判据形态，按 D-17 必须能被证否，否则等于没测。

### 3.3 防线自己差点给出假结论（值得单独记）
`--self-test` 是按 D-13 补的，结果**当场抓到一个真 bug**：
解析 `CHECK (((make_buy)::text = ANY (...))` 时，末尾标识符取到了 `text` 而不是 `make_buy`
⇒ 首版快照的 key 是错的。**没有自测的话，这个错误会安静地一直错下去。**
由此定一条纪律：**新写的判据必须带自测，且自测要能证否（不能只跑"应该通过"的路径）**。

### 3.4 密级与创新类别：用户裁定（2026-10-05 · D-18）· 已拆片
这 2 处与上述 7 处**病根不同**（那 7 处是「前端抄后端」，这 2 处是**前后端都声明了闭集但谁都不强制**），
连同「先清存量再加 CHECK」的落地顺序、服务端补校验的理由、两库 D-13 探针结果、
以及第二次自测抓到的判据崩溃，**已拆为独立分片**：[ui-gaps-open-vocab-authority.md](ui-gaps-open-vocab-authority.md)。
