# 22 · CBB 资产库：业务逻辑、关系模型与作业流程

> 定位：把 `docs/plm-design/ipd-extension/` 扩展包里的 CBB 设计（BO-05 / 01B 五层分层 / 02-§2.5 CBB 资产 / J-IPD8+J-IPD13）与 `ipd/plm-app` 实现态**逐条对账**，补齐"设计有、实现断"的四处根因，并给出**唯一权威口径**与断言。
> 依据：用户裁定 D-01~D-17（见 `.creature/tasks/ipd-rd-management/cbb-review/decisions.md`）——本文是该裁定的设计载体，与裁定同步维护。
> **本批（2026-09-22，V141）新增 D-17**：「补录 + 验证门 + 交付载体关系」——入册曾是全生命周期唯一写路径，治理属性**永远补不上**（§2.2/§7.5）。
> 上游：`ipd-extension/01A`（业务对象·BO-05）、`01B`（五层分层与异步开发）、`02-§2.5`（CBB 资产表）、`06-§4`（决策权限矩阵）、`03-J-IPD8/J-IPD13`（旅程）。
> 下游：`ipd/plm-app/backend`（迁移 V140/V141、`IpdModelService`、`BomService`、`ChangeService`、`PrecheckService`、`PipelineService`）、`frontend/src/pages/CbbLibraryPage.tsx`（+ 产品结构页）、`docs/plm-user-guide/15`、`docs/plm-tech/23-变更域三单据与工作台设计.md`（变更域读面）。

---

## 0. 一句话结论

**CBB 是产品线的固定资产（L4 模块层），不是项目的交付物。** 它的业务闭环是
「**TDP 生 → 成熟度爬升 → 发布 → PDP 引用并落入 BOM → 变更反查使用方 → 年审 → 退役/接管**」。
本次审视的结论不是"CBB 模型设计错了"，而是**这条闭环在实现里断了四处**：

| 断点 | 现状 | 后果 |
| --- | --- | --- |
| **① 资产↔结构断**（CBB 只挂项目，不挂 BOM/物料） | `t_cbb.ref_item_rev_id` 建时写入、后端从不读出；`t_cbb_usage.item_rev_id` 无人写 | "改一个 CBB 会影响哪个产品的哪个结构位"查不到，只能查到"哪些项目" |
| **② 资产↔变更断**（反查只是 JSONB 备注） | 只写 `t_eco.attrs.cbb_usage_impact`，不写 `t_eco_affected`、不驱动修订、不阻断 | 变更影响评估里看不到 CBB；IBR-20 上溯链无处落 |
| **③ 规则双实现**（同一 IBR-06 写两遍，口径不同） | 清单项 `TR2/M2` 一处；`PrecheckService` 硬编码项目级 count 又一串，且**不看 gate_code** | "做过一次复用分析"即可永久满足两道门，假绿 |
| **④ 权责与收场缺**（无签署、无回退、无退役闸门） | `ipd.transition` 任一持有者可推进；`DEV` 退不回、也退役不了 | 设计里的"产品线技术负责人批准"是纸面要求；建错条目永久占号 |

---

## 1. CBB 的业务定义与权威源

### 1.1 定义（继承 01A-BO-05，不重写）

- **是什么**：跨产品复用的技术资产——**不是某个项目的交付物，是产品线的固定资产**。
- **Owner**：Owner 团队（维护责任）；**发布/退役批准 = 产品线技术负责人**（本文落为治理角色 `platform_owner`，见 §6.3）。
- **生死**：诞生于 TDP/PDP 沉淀 → 成熟度爬升（TRL）→ 发布 → 服役（被引用）→ 维护 → 退役。年度健康度评估。
- **回答什么业务问题**："这个能力我是不是已经做过了？能不能不再做一遍？"——**复用率是它的存在理由**。

### 1.2 唯一权威源（裁定 D-01）

> **PLM 库 `t_cbb` 是唯一权威。** `ipd/knowledge/cbb/registry.yaml` 降级为**只读投影/导入源**。

| 侧 | 角色 | 纪律 |
| --- | --- | --- |
| `t_cbb` / `t_cbb_usage` / `t_cbb_rev` | **唯一权威**：状态、TRL、版本、使用方、复用计数 | 一切写路径只写库；计数在库内实时派生，不落冗余字段 |
| `ipd/knowledge/cbb/registry.yaml` | 投影/导入源（8 条示例，`draft/validated/deprecated`） | **不再手改**；其状态是库内 `status` 的一次性导入映射（见 §7.1）；agent 侧改为经接口读库 |

**为什么必须收敛**：两份台账同时存在时，"同一条 CBB 两个状态、两个复用计数"是必然的——而 agent 的复用推荐（`cbb-reuse-assessment`）读 YAML、PLM 的门线判据读库，两边一旦漂移，**推荐给开发者的 CBB 可能正是门线会拦下的那一个**。

### 1.3 五层分层中的位置（继承 01B）

```
L1 解决方案 ──组合──▶ 多产品
L2 产品     ──引用──▶ L3 平台版本（发布列车）  ← 本期未落地（见 §9）
L3 平台     ──聚合──▶ L4 CBB（平台版本基线 = CBB 集合快照）
L4 CBB      ──引用──▶ L5 技术（技术转移后的资产化形态）
```

| 层 | 生命周期 | 节奏 | 判定标准 | 本期状态 |
| --- | --- | --- | --- | --- |
| L4 CBB | 5–10 年 | 随平台或按需 | 成熟度（TRL）+ 被引用量 | ✅ 本文 |
| L3 平台 / 平台版本 | 5–10 年 | 发布列车 | 复用广度 + 平台质量 | ⏸ **未落地**（无 `t_platform`/`t_platform_release`/`product.layer`） |
| L5 技术 | 不确定 | 2–5 年探索 | 技术可行性（TRL 爬升） | ⏸ 未落地（无 `t_tech_item`） |

> ⚠️ **不要把 §9 读成"已实现"**：IBR-16/17/18（成熟度门禁/路标对齐/发布列车）依赖 L3 与 `t_layer_ref`，本期**只交付 L4→L2 一段**（裁定 D-04）。

---

## 2. 关系模型（本文的核心交付）

### 2.1 目标态关系图

```
                       ┌──────────────── 物料域 ────────────────┐
TDP 项目 ──产出/回填──▶ │ t_cbb ──ref_item_rev_id──▶ t_item_rev   │
   (prj_type=TDP)      │   ▲                        ▲            │
                       │   │ cbb_id                 │ child_rev  │
PDP 项目 ──复用分析批准─┤   │                        │            │
   (T_CBB_USAGE)       │ t_bom_line ──parent_item_id──▶ t_item     │
                       │   │                                     │
                       │   └── 归属 ──▶ t_product（root_item_id） │
                       └───────┬─────────────────────────────────┘
                               │ CBB 变更/DECOM
                               ▼
                       变更域：ECR（自动起草）──▶ ECO ──▶ BOM/物料修订（t_eco_affected）
```

三条引用边，各有一个唯一承载（V141 起补第三条：交付载体）：

| 边 | 语义 | 物理承载 | 唯一性/纪律 |
| --- | --- | --- | --- |
| **CBB → 物料版本** | CBB 的**物理形态**（软件类 CBB 无物料时为空） | `t_cbb.ref_item_rev_id` | 可空；**HW/MECH 必有**（V141 齐备门，§2.2）；有值时必须在 CBB 生命周期内指向一个存在的 `t_item_rev` |
| **CBB → 受控文档版本** | CBB 的**交付载体**（"这份东西本身放在哪一版"，V141/D-17） | `t_cbb.doc_rev_id` | 可空；**SW/ALGO/TEST 允许"物料形态或文档载体任一"**；有值时须解析到存在的 `t_doc_rev` |
| **CBB → 项目** | 哪个项目在用它（治理/变更责任面） | `t_cbb_usage(born_project_id 非空)` | 幂等；由"复用分析批准"或"BOM 行标记"两条路径登记 |
| **CBB → BOM 行** | 它在产品结构里的具体落点（影响面） | `t_cbb_usage(item_rev_id 非空)` | 由 BOM 行的 `cbb_id` 标记**级联登记**——这是 `item_rev_id` 的唯一写入口 |

### 2.1.1 承载实体三层（本批补：为什么第三条边不能省）

一个 CBB 的"它是什么"由**三个不同层次的实体**分别承载，缺任一层都会让某类 CBB **无处安放**：

| 层 | 承载实体 | 回答的问题 | 谁必须填 | 纪律 |
| --- | --- | --- | --- | --- |
| ① **资产账** | `t_cbb`（治理主档，可补录）+ `t_cbb_rev`（只增不改的版本快照） | 这是**哪一项**资产、第几版、谁负责、什么状态 | 全部 CBB | 主档在 `DECOM` 后**冻结**（§2.2）；快照只增不改（§2.3） |
| ② **物理形态** | `ref_item_rev_id` → `t_item_rev`（BOM/物料侧锚点） | 它在**结构里**长什么样（能不能落 BOM） | **HW/MECH 必有** | 逻辑引用（无外键）⇒ 服务端必须解析存在性；与 BOM 行版本同批校验（§2.1 双记消解） |
| ③ **交付载体** | `doc_rev_id` → `t_doc_rev`（受控文档版本） | 这项资产**交付的东西本身**放在哪一版 | SW/ALGO/TEST 的**主要落点**（与 ② 取一即可） | 同上：逻辑引用，服务端解析存在性；版本快照同步记载（`t_cbb_rev.doc_rev_id`） |

**为什么必须有第三层**（D-17 的核心论证）：

- **没有它，软件/算法类 CBB 在库里只有"名字"**。`SW/ALGO/TEST` 常常没有物料形态（§5.2 已承认"软件类 CBB 可以没有物料形态"），于是它们唯一的落点就只剩 `reuse_policy` JSONB——**正是本文缺陷档案第 ④ 条「关系承载表缺席，降级为 JSONB 备注」的同族形态**：查不了（"哪些 CBB 的交付物指向这一版文档"）、对不了账（文档升版了而载体没变，没人能发现）、驱动不了下游（文档作废时找不到要通知谁）。
- **它与 ② 不是同一件事**：②回答"这个 CBB 是不是一个物料（能不能进 BOM 树）"，③回答"这项能力交付的**东西**是哪一版"。同一个 HW 类 CBB 可以既有物料形态、又有交付载体（图样/规范）；而一个 SW 类 CBB 只有 ③。把两者挤在一列上，就得在一列里塞两种类型不同的引用。
- **快照必须带载体**：`t_cbb_rev.doc_rev_id` 是"这一版快照时的交付载体"——少了它，版本历史只能比"改了什么内容"，比不了"**交付物换到哪一版**"，而后者恰恰是引用方最关心的事实。

**载体规则（与齐备门同源，判据只写在 `cbbGaps` 一处）**：

| CBB 类型 | 物理形态（②） | 交付载体（③） | 判据 |
| --- | --- | --- | --- |
| `HW` / `MECH` | **必须** | 可选（有则一起校验存在性） | 缺 ② ⇒ 齐备门报 `CARRIER`。理由具体：它在 BOM 侧没有锚点，`BomService` 的"行版本 == CBB 形态"一致性校验会被**静默跳过**——一条本该拦住的比对变成"没比对" |
| `SW` / `ALGO` / `TEST` | 可选 | 可选 | ②**或**③**任一**即可；两者都空 ⇒ 算缺口（`gaps` 里的 `CARRIER`） |

> **本期只校验载体存在性，不校验文档版本状态**（明确的口径边界）：`resolveDocRevId` 只断言"`docNo + rev` 能解析到一个 `t_doc_rev`"，**不看**该文档版本是草稿、已发布还是已作废。理由："载体指向已作废文档"目前**没有真实案例**，而在没有案例时收紧状态校验，代价是把"文档先建档、CBB 后补录"这个正常顺序也一起拦下。
> **触发条件（何时再收紧）**：出现**第一个**"载体指向已作废文档"的真实案例（或文档域把"作废"变成常规动作）时，把状态判据加进齐备门——届时仍只加在 `cbbGaps` 一处，**界面不用改**（它只渲染 `gaps`，不重算）。

**双记消解（重要）**：`t_bom_line.cbb_id` 与 `t_cbb.ref_item_rev_id` 都指向同一个 CBB，但**它不是双权威**——
- `ref_item_rev_id` 是"这个 CBB 的形态是什么"（资产属性，一个 CBB 一个）；
- `bom_line.cbb_id` 是"这个产品在这一行用了它"（引用事实，可多处）。
- 一致性由**同批校验**保证：BOM 行标 CBB 时，若该 CBB 有 `ref_item_rev_id`，则行的 `child_rev` 必须与该物料版本一致，否则 400 并说明；若该 CBB 无物料形态（纯 SW/ALGO 资产），则只挂 CBB、不要求物料对应。
- **视图口径（用户 2026-10-02 裁定 A，本文 2026-10-02 补）**：CBB 标记**只允许出现在设计 BOM（EBOM）**上——
  非 EBOM 视图打标一律 `400 CBB_TAG_VIEW_NOT_ALLOWED`（`BomService.assertViewAllowsCbbTag`，白名单 `CBB_TAG_VIEWS={EBOM}`）；
  在 PBOM/MBOM/REGBOM/SBOM 里，CBB 的用法是**按其构成物料自然展开**，不重复承载"设计模块"身份。
  **权威表述在 `plm-design/02-信息架构设计.md` §5.2.1.1**（含三条理由与"将来放开时必须同批做的两件事"）；
  原文只讲"落 BOM"不讲"落哪个视图"，是本次复核发现的文档缺口（14 号报告 I-4），此处交叉引用以免两处自述。
  ⚠ 与本文 §5.6 的**结构内复用度**口径互为因果：该指标的分母是产品 **EBOM** 节点
  ——若允许在派生视图打标，就会出现"标了但不在度量里"的错位（这正是限定 EBOM 的理由之一）。

### 2.2 使用方（Usage）模型

`t_cbb_usage` 一行 = **一个"谁在用"的事实**，两种粒度共用一张表（裁定 D-02）：

| 粒度 | 触发 | 关键列 | 用途 |
| --- | --- | --- | --- |
| **项目级** | 复用分析（`t_reuse_analysis`）批准 | `project_id` 非空、`item_rev_id` 为空 | 治理面：影响哪些项目、变更责任通知谁 |
| **结构级** | BOM 行带 `cbb_id` 标记 | `item_rev_id` 非空（+ `cbb_id`） | 影响面：影响哪些产品/结构位、要改哪些 BOM |

- **退役闸门**（裁定 D-07）读这张表的**全部行**：`DECOM` 前置 = 每行都有处置结论（`dispose_type` 非空）。
- **退役通知**（裁定 D-05）读这张表的**去重使用方**：项目集合 + 结构位集合，作为变更单受影响的预填内容。

### 2.3 CBB 版本模型（裁定 D-05 的前置）

原设计里 CBB **没有版本概念**——"改 CBB"就是改本行，于是"变更反查"没有可比对的旧/新，也就无法自动起草变更单。本文补：

```sql
t_cbb(id, cbb_code UK, name, cbb_type, trl_level, owner_team_id, born_project_id,
      status, rev,                -- ← 新增：当前版本号（A/B/C，与物料版本同风格）
      owner_login,                -- ← V141：责任人（login TEXT，本库身份约定）
      doc_rev_id,                 -- ← V141：交付载体（逻辑引用 t_doc_rev，§2.1.1）
      ref_item_rev_id, annual_review_due, reuse_policy, ...)
t_cbb_rev(id, cbb_id FK, rev, status, trl_level, ref_item_rev_id,
          doc_rev_id,             -- ← V141：该版本的交付载体（快照要能回答"交付物换到哪一版"）
          change_note,
          drafted_ecr_code,         -- ← 本版本变更自动起草的变更申请编号（回链）
          created_by, created_at)   -- 版本快照，只增不改（与物料 BR-01 同纪律）
```

- **`rev` 升版**：`POST /ipd/cbbs/{id}/revs {changeNote}` → 写 `t_cbb_rev` 快照 + `t_cbb.rev` 前进 + **自动起草 ECR**（§5.3）。
- **升版入参也接受 `docRef`（业务键 `{code,rev}`）**：未给 = 保持当前载体，与 `refItemRevId` 同语义（不给不等于清空——"没提这件事"和"这件事没有了"是两回事）。
- **为什么只增不改**：CBB 变更的影响面是"已在服役的产品"，历史版本必须可追溯（与 `T_BASELINE` 冻结、物料发布后不可改同源）。

### 2.4 资产主档的写路径与补录边界（本批补，裁定 D-17）

主档有**三条**写路径，分工按"改的是治理属性还是资产内容"划开：

| 写路径 | 端点 / 权限点 | 写什么 | 产生版本吗 | 起草变更单吗 | 可改字段 |
| --- | --- | --- | --- | --- | --- |
| **① 入册** | `POST /ipd/cbbs`（`cbb.create`） | 名称、类型 + 首次可给的治理属性与载体 | 写 `t_cbb_rev` vA 起点快照 | 否 | 名称 / 类型 / TRL / 责任人 / 物料形态 / 交付载体 / 年审到期 / 复用策略 |
| **② 补录** | `PUT /ipd/cbbs/{id}`（`cbb.update`） | **只写治理属性**（把入册时漏掉的信息补齐） | **否**（不产生版本） | **否** | `ownerLogin` / `trlLevel` / `annualReviewDue` / `reusePolicy` / `refItem` / `docRef`（+ `note` 写审计） |
| **③ 升版** | `POST /ipd/cbbs/{id}/revs`（`cbb.create`） | **改资产内容**（本版改了什么） | **是**（只增不改的快照 + `rev` 前进） | **是**（自动起草 ECR，§5.3） | 内容由 `changeNote` 承载；载体可随版更新 |
| **⛔ 不可走** | — | **名称 / 类型**——它们不在 ② 的允许键内（未知键一律 400 `CBB_GOV_UNKNOWN_FIELD`） | — | — | 名称/类型要改 ⇒ 只能走 ③ 或新建（资产身份是审计对象） |

**为什么必须有 ②（补录）**：此前入册是**全生命周期唯一写路径**（无 `PUT`、详情面板全只读）⇒ 入册时没给的责任人/TRL/载体**永远补不上**。实测（2026-09-22）：库里 **44 条 CBB 全部是本批走查造的测试条目、真实业务条目为 0**，其中无物料形态 **44**、无诞生项目 **44**、无 Owner 团队 **44**、无 TRL **27**、无年审到期 **23**——**这些字段在旧实现下没有任何补录通道**。补录一到位，"想补却补不了"的死锁才解开（旧形态下它与本批新增的齐备门叠加，会变成"想验证却没资格验证"的**自锁**）。

**为什么补录不升版、不起草变更单**：补录写的是**治理属性**（谁负责、成熟度、载体在哪、何时年审），不是"这项资产的内容变了"。若每次补个责任人都升一版、造一张变更单，版本历史与变更台账会被治理维护动作淹没，评审成本也会失控。

**部分更新语义（三条纪律，逐条有判据）**：

| 纪律 | 语义 | 为什么 |
| --- | --- | --- |
| 出现的键才处理 | 请求体里**没出现的键不动** | 前端只提交改过的那一项，不会因为表单没渲染某个字段而把它清空 |
| 显式 `null` = 清空该关系 | `"docRef": null` ⇒ `doc_rev_id` 置 NULL | "这项资产不再有交付载体了"必须是一个**能表达**的意思（否则只能留着一个错值） |
| 未知键一律 400 | `CBB_GOV_UNKNOWN_FIELD` 并列出允许键 | 拼错键名（`owner` vs `ownerLogin`）**不许静默成功**——"点了没反应"是比报错更坏的形态 |

**引用一律用业务键**：`refItem` / `docRef` 传 `{code, rev}`（`code` 亦接受按域语义命名的 `itemCode` / `docNo`；`rev` 必给，缺一半报 `CBB_REF_INCOMPLETE` 家族错误）。理由：这两列是**逻辑引用**（无外键），服务端本来就必须解析并校验存在性；把内部 rev id 写进对外契约正是本库反复出现的"回显退化（`#123`）"根源。**同一逻辑在服务端只有一处实现**（`carrierOf` 收敛三种编号键名，不构成两处判据）。

**权限点 `cbb.update`**：角色集与 `cbb.create` 同档（`admin` / `flow_owner` / `platform_owner` / `pdt_manager`）——**能入册的人就该能把入册信息补齐**；且补录**不改资产内容**，故不需要发布级权限。该行必须与 `PermissionService.RULES` 的 `cbb.update` **逐字一致**（V141 迁移末尾有自检块；不一致则启动期报 `RULES_DB_DRIFT`）。

**退役资产主档冻结**：`DECOM` 状态下 `PUT` 一律 400 `CBB_DECOM_FROZEN`（"优先历史留痕，要重新启用请新建 CBB"，与 §3.1"终态不可复活"同口径）。**升版**同样拒绝已退役条目（400 `CBB_DECOMMISSIONED`）。

---

## 3. CBB 生命周期状态机（裁定 D-07）

### 3.1 目标态

```
        ┌──────────── 验证退回（原因 ≥10 字）────────────┐
        ▼                                               │
      DEV ──验证报告──▶ VERIFIED ──发布评审+签署──▶ RELEASED ──转维护──▶ MAINT ──迁移完毕──▶ DECOM
        │                   ▲                                            │
        └──作废/误建─────────┴──────────── 复用已发布版本 ────────────────┘
             │
             └──▶ DECOM（未定型作废）
```

| 边 | 权限点 | 前置/闸门 |
| --- | --- | --- |
| `DEV → VERIFIED` | `cbb.create`（**不是 `cbb.update`**——实现里流转走资产维护面；补录权限点只管主档字段） | 存在验证证据（`evidence_ref`）+ **齐备门**（V141/D-17：载体 / 责任人 / TRL 三项齐备，缺项点名，§3.4）；通过后自动写 `annual_review_due = now() + 1 year` |
| `VERIFIED → DEV`（**回退边**） | `cbb.create` | **`reason` 必填 ≥10 字**；写审计；`annual_review_due` 清空 |
| `VERIFIED → RELEASED` | **`cbb.release`** | 电子签署（`t_sign_rec`，对象=CBB，动作=RELEASE） |
| `RELEASED → MAINT` | `cbb.create` | — |
| `DEV → DECOM` | **`cbb.decom`**→实现取 `cbb.create`（见下注） | `decom_note` 必填（作废/误建说明）；**不要求使用方处置**（未发布，无服役面） |
| `MAINT → DECOM` | **`cbb.decom`** | `deprecation_notice` 必填 + **退役闸门**：`t_cbb_usage` 全部行 `dispose_type` 非空；签署 |
| `DECOM → *` | — | **终态**，不可复活（要复活=新建 CBB，历史留痕） |

> **权限点实现细节（复核用）**：`transitionCbb` 只对"发布/退役"两个目标状态分派专用权限点——
> `→RELEASED` 与 `→DECOM` 都会被**重定向到专用端点**（400 `CBB_RELEASE_VIA_ENDPOINT` / `CBB_DECOM_VIA_ENDPOINT`），
> 故 `transition` 这一路实际只执行 `DEV↔VERIFIED` 与 `RELEASED→MAINT` 三条边，统一用 `cbb.create`（资产维护面）。
> 表里 `DEV→DECOM` 写 `cbb.decom` 指的是**该动作的治理归属**，实际入口是专用端点的 `transition {to:DECOM, decomNote}`。

### 3.1.1 两条边都属于 `/decom`，且两处定义必须逐边对齐（本批抓到第 6、7 条缺陷）

**修正一（第 7 条缺陷 · 边不可达）**：`transitionCbb` 把**所有** `→DECOM` 一律重定向到
`POST /ipd/cbbs/{id}/decom`（提示"须走专用端点"），而 `/decom` 原先**只接受 `MAINT`** ⇒
`DEV → DECOM`（未定型作废）在实现里**不可达**：调用方被指向一个必然报错的端点，
再被告知"请先转 MAINT"——而"未定型条目先转维护"在业务上荒谬。flow 读面与用户手册又都声称这个动作可用
⇒ **用户会卡在"请走 /decom"→"/decom 说请先转 MAINT"的死循环**。
现已改为 `/decom` **按源状态分流**：`DEV` 只须 `decomNote`（作废说明）；`MAINT` 才须
废弃通告 + 退役闸门 + 迁移期 + 签署。判据：走查 R11c/R11f（读面声称可用 ⇒ 必须真的能执行且落库）。

**修正二（第 6 条缺陷 · 两处定义漂移）**：CBB 状态机有**两处定义**——
`IpdModelService.transitionCbb` 的 `allowed` 映射（判据）与 `resources/flows/cbb-flow.yaml`
（`GET /_platform/flows/cbb` 的读面，界面据此画可用动作）。本批实测该 flow 文件**缺 `DEV → DECOM`**，
且 `editableStatuses: [DEV]` 描述了一个不存在的语义（CBB 是资产，没有"可编辑字段"）。
后果与 18 号文"词表单源"违例同型：**页面看不到服务端允许的动作**，而手册却声称有 ⇒ 文档/读面/实现三方不一致。
已补齐：flow 文件补该边、`editableStatuses: []`，文件头写明"逐边对齐 + 逐边前置"。
判据：走查 **R11a** 断言"读面 == 服务端允许边（恰好 6 条）"——多一条即"声称可用而实际 400"，
少一条即"隐藏了可用动作"，两侧都被卡住。
**纪律**：凡"定义文件 + 实现映射"两处承载同一事实，必须有判据使其不能漂移（对照 `t_permission_rule` 与
`PermissionService.RULES` 的既有对账口径）。

### 3.2 为什么补这两条边

- **验证退回**：设计 02-§4.3 与用户手册 15 章都写了 `VERIFIED → DEV`，实现里没有 ⇒ 验证不通过的 CBB 永久卡在 `VERIFIED`，而 `VERIFIED` 正是 PDP 引用的**最低门槛**（IBR-10）⇒ 系统会把"没验证过的东西"当成"已验证"的可复用资产推荐出去。
- **未定型作废**：`DEV` 无法退役 ⇒ 建错/试验性的条目永久占号、永久出现在资产库列表里（资产库的信噪比会随时间恶化）。

### 3.3 退役闸门（三问）

`MAINT → DECOM` 时必须逐问有答案，缺一即 400 并**点名缺哪一问**：

1. **谁还在用**？→ `t_cbb_usage` 使用方清单（项目 + 结构位；为空则免问）
2. **他们怎么处置**？→ 每行 `dispose_type` ∈ `REPLACED`（换到另一个 CBB/版本）/`MIGRATED`（自身改造，不再引用）/`ACCEPTED`（继续用旧版本，走偏离审批）/`NO_IMPACT`（形态未变）
3. **什么对外通告**？→ `deprecation_notice`（对应 01B-§3.3 的"废弃通告 + 迁移期"）

**闸门只对 `MAINT → DECOM` 生效**（`DEV → DECOM` 不设闸门）：未定型条目**未发布 ⇒ 无服役面**，
没有"下游要迁移"这回事；对它要求使用方处置会把"建错了想删掉"变成一件走不完的流程，
而它唯一的护栏是 `decomNote`（说明为什么作废，防止"无痕删号"）。

### 3.4 齐备门（V141 / D-17）：`DEV → VERIFIED` 的三项判据

验证的语义是"这条资产**可以被产品引用了**"，那么它的最小事实必须齐：
`DEV → VERIFIED` 前若下面任一缺项存在，一律 400 `CBB_GOVERNANCE_INCOMPLETE` 并**逐项点名**（文案与界面「待补清单」同源）。

| 缺口 `code` | 判据 | 为什么它是缺口 |
| --- | --- | --- |
| `CARRIER` | HW/MECH 无 `ref_item_rev_id`；SW/ALGO/TEST 的 `ref_item_rev_id` 与 `doc_rev_id` **双空** | 无载体 ⇒ 它在结构/文档侧没有锚点，`BomService` 的"行版本 == CBB 形态"一致性校验**被静默跳过**（该拦的不拦） |
| `OWNER` | `owner_login` 为空/空白 | 无责任人 ⇒ 发布/退役的批准链上找不到人（"这项资产谁负责"回答不了） |
| `TRL` | `trl_level` 为空 | 无 TRL ⇒ IBR-10 的报错文案只能打 `null`，复用决策没有成熟度依据 |

**"年审到期"为什么不是缺口**（写代码时实测纠正的一处推理错误）：`transitionCbb` 在 `→VERIFIED` 时**自动**写
`annual_review_due = (now() + interval '1 year')::date`，回退到 `DEV` 时清空 ⇒ 该列**由状态机维护**，不需要人补录。
此前"23/44 条无年审到期"不是缺陷，那正是"**尚未验证**"的条目（验证时自动落值）。

**`gaps` 单一实现纪律**：判据只有一个函数（`IpdModelService.cbbGaps`），
- **读面**：`CbbResp.gaps` = `[{code, label}]`，界面**只渲染、不重算**（重算就是"同一判据两处实现"，本库已付过代价——缺陷档案第 1 条）；
- **写面**：`DEV → VERIFIED` 用**同一函数**拦截，故"界面显示的待补清单"就是"这里会拦的东西"。

> 这条纪律的判据是**同源**而不是"文案相似"：走查 R22c2 的做法是——先让 `gaps` 显示某一项缺失（读面），
> 再直接调 `transition`（写面），断言两侧都指向同一个缺口 code；若读面已无缺口而写面仍拒，或反之，就是漂移。

---

## 4. 作业流程（八步闭环，逐条对账）

| # | 环节 | 设计依据 | 实现态（2026-09 基线） | 本次交付 |
| --- | --- | --- | --- | --- |
| ① | 识别机会 | 需求 → 匹配可复用 CBB | ⚠️ 只有名称 `ILIKE` | 改走 `_platform/search`（RRF 混合）+ 状态/TRL 过滤（裁定 D-01：读库） |
| ② | 注册入册 | TDP 产出回填 `born_project` | ⚠️ `createCbb` 忽略 `bornProjectId` | 修正：创建时即接受 `bornProjectId`/`refItemRevId`；V141 起入册即可给责任人/物料形态/交付载体（业务键）；TDP 登记仍可后补，漏掉的走**补录**（§2.4） |
| ③ | 成熟爬升 | `DEV → VERIFIED`（验证报告） | ✅ | 保留 + 补回退边 + **齐备门**（载体/责任人/TRL，缺项点名；年审到期由状态机自动续期，§3.4） |
| ④ | 发布 | `RELEASED`（产品线技术负责人批准） | ❌ 无签署、权限过宽 | `cbb.release` + 签署 + `platform_owner` 角色（§6.3） |
| ⑤ | 搭载引用 | PDP 复用分析 → 建 `T_CBB_USAGE` → **落入 BOM** | ⚠️ 只到项目级 | BOM 行 `cbb_id` 标记 + 命中级联（§2.2）；TR2/DCP1 判据单实现（§7.2） |
| ⑥ | 变更 | 反查使用方 → ECO 影响评估 → 接受/拒绝新版本 | ❌ 只写 JSONB 备注 | 升版即**自动起草 ECR** + 预填 `t_eco_affected`（§5.3）；CBB 变更沿引用链上溯 |
| ⑦ | 年审 | `annual_review_due` 到期扫描 | ⚠️ 有字段+查询端点，无扫描 | **维持人工查（裁定 D-13）**：保留 `review-due` 端点 + 资产库列表按效期分级排序 |
| ⑧ | 退役 | 废弃通告 + 迁移期 → `DECOM` | ❌ 无迁移校验、`DEV` 退不了 | 退役闸门（§3.3）+ `cbb.decom` + 签署 |

> **⑦ 的口径澄清（避免误读为"没做完"）**：年审**有意**维持人工查——到期事项的处置动作（重新评估 TRL、决定退役）本质是人的业务判断，自动扫描只解决"提醒"，而提醒的可靠性在试点阶段不如"评审时看一眼效期列"。此条经用户显式裁定，且**不阻断**其余交付。

---

## 5. 与各业务域的关系（逐域口径）

### 5.1 与项目域

- **TDP（`prj_type=TDP`）**：CBB 的产地。`POST /ipd/tdp-outputs {projectId, cbbId}` 回填 `born_project_id`（已实现，保留）。**纪律**：只回填一次（`WHERE born_project_id IS NULL`），保证"谁生的"唯一。
- **PDP**：CBB 的用方。引用必须经 `t_reuse_analysis`（走门线），不得绕过；`t_cbb_usage` 在**批准时**登记（幂等）。
- **IBR-03 提示项**：PDP 标记 `new_tech` → 预检提示"建议拆分 TDP 沉淀 CBB 后复用"（已实现，保留为 ADVISORY，不阻断）。

### 5.2 与物料域

- `ref_item_rev_id` 是"CBB 的物理形态"。**软件类 CBB 可以没有物料形态**（`SW/ALGO` 类型常见）⇒ 该列**可空**，为空不影响 CBB 的有效性，但会影响"结构级影响面"的可达性（无物料 ⇒ 无法落 BOM ⇒ 只能停在项目级）。**此类资产的分发方式不是"写在备注里"**：它的交付载体应落在 `doc_rev_id`（受控文档版本，见 §2.1.1）；`reuse_policy` 只承载**补充说明**（谁来改、能不能改、跨产品线的约束等），不承载"那份东西在哪一版"这个关系——这与 §10 缺陷档案第 ④ 条"备注不是关系"是同一条纪律（V141 之前这句话与新增的第三层口径相抵，故一并订正）。
- 物料侧**不加反向标记**：CBB 不是物料的一种（它是"跨项目复用意图的资产"，物料只是它的形态）。反向查询一律走 §2.1 的三条边。

### 5.3 与变更域（裁定 D-05）
**触发**：`POST /ipd/cbbs/{id}/revs`（升版）或 `MAINT → DECOM`（退役通告）。

```
CBB 升版/退役请求
   ├─ 写 t_cbb_rev 快照（只增不改）
   ├─ 收集使用方：项目集合（治理面）+ 结构位集合（影响面，item_rev 级）
   ├─ 起草 ECR：source='IMPROVE'，problem_desc 模板化（含 cbbCode/旧→新版本/使用方计数）
   ├─ 影响面备好并挂到 ECR（triage_concl 内的 [cbb_impact] {…json…}）
   └─ 回链：t_cbb_rev.drafted_ecr_code = ECR 编号（可追"这次变更谁在处理"）

ECR → ECO（业务判定：要不要改/改哪些/走哪条通道）
   └─ **建 ECO 时**把 [cbb_impact] 落成 t_eco_affected 行：
         obj_type='ITEM_REV'（obj_item_id=子件物料, obj_id="<CBB编号>@<旧版本>", old_rev/new_rev=CBB 版本）
         obj_type='BOM'     （obj_item_id=父件物料, obj_id="BOM:<父>-><子> <CBB编号>"）
         action='REVISE'；项目面使用方落 ECO attrs（t_eco_affected.obj_type 值域不含项目）
```

> **⚠ 为什么"预填 t_eco_affected"落在 ECO 建立时，而不是起草 ECR 时**（对 D-05 字面的落地解释，2026-09-21 实测后固化）：
> `t_eco_affected.eco_id` 是**物理外键指向 `t_eco`**，ECR 阶段没有 ECO 可指向；而"不自动创建 ECO"是本设计的边界（见下）。
> 于是口径是：**起草 ECR 时备好影响面（结构化，不是散文），ECO 建立时落成行**——
> 既守住"不替业务决定"，又让承诺的那张表真的被填。
> **这一条本身是本批的教训**：第一版实现只把影响面写进 JSONB 就收工，等于把"关系降级为备注"这个老缺陷（§10 缺陷档案 #4）换个位置重犯——
> 只有"行真的存在"才能被查询、对账与下游驱动。判据 = `t_eco_affected` 行数 ≥ 1 且 `obj_id` 可追溯回 CBB 编号（走查 R13b/R13c）。

**边界（刻意不做的事）**：
- **不自动创建 ECO**：ECR→ECO 之间是业务判定（要不要改、改哪些、走哪条通道），系统只把"受影响对象清单"准备好，不替业务决定。
- **不自动改 BOM**：BOM 修订必须经既有变更窗口与授权（`ChangeService` 的"已授权变更窗口"纪律），CBB 只负责**把影响面摆出来**。

**"起草了 ECR"必须能在界面上找到它**（本批的第二个半场，2026-09-22 实测）：

自动起草只完成了一半——**写进库 ≠ 有人能看到**。实测：`t_ecr` 中 `problem_desc LIKE '%CBB 升版%'` 的 **18 条**，
其中 **13 条停在 `OPEN` 且 `eco_cnt=0`**（无人处理）；根因不是"没人愿意做"，而是**主框架里 ECR 根本没有列表入口**：
前端全仓对 `/ecrs` 只有 `POST`（发起）、没有列表；`/changes` 只查 `/ecos`；ECO 新建路径从不带 `ecrId`
（面板字段里没有 `ecrId`）⇒ **界面无法把 ECO 关联到 ECR**，ECR→ECO 交接链整条断裂。

本批的收口（详细设计见 **`docs/plm-tech/23-变更域三单据与工作台设计.md`**）：

| 环节 | 落地 |
| --- | --- |
| 去哪儿找起草出来的 ECR | **工程变更工作台** `/changes` 一页三对象（左栏切 ECR/ECO/ECN）；URL 深链 `/changes?obj=ECR&code=<编号>` |
| CBB 版本历史里的入口 | 「起草的变更申请(ECR)」**编号可点**（此前是死文本，用户只能自己去变更页搜编号） |
| 交接 | ECR 列表 + 初评 → 按钮「**转变更单(ECO)**」；ECO 侧「关联 ECR」可编辑（`PUT /ecos/{id} {ecrId}`，挂上即把 ECR 置 `TO_ECO`；已 `TO_ECO`/`CLOSED`/`CANCELLED` 的 ECR 二次挂载被拒 `ECR_NOT_LINKABLE`） |
| 文案订正 | 按钮与版本历史表头曾把 **ECR 说成"变更单"**（本库"变更单"= ECO）⇒ 用户按字面理解成 ECO、去工程变更模块找它。现统一为"变更申请（ECR）"，且**为什么转变更单必须由人点**见 23 号文 |

### 5.4 与评审域（裁定 D-03）

**IBR-06 只有一个实现**：清单项（配置侧）+ 存在性判据（预检侧），两者同源。

| 门 | 清单项 | 判定人 | 判据 |
| --- | --- | --- | --- |
| TR2 | `M2 复用分析已批准（CBB/平台，IBR-06）`（既有，V24:93） | `system_engineer` | 见下"三条判据" |
| DCP1 | `M5 平台复用分析(模块化/家族化)`（既有，V17→V92 迁入） | `product_manager` | 同上（同判据、参数化门点） |

**三条判据（预检项 `REUSE_ANALYSIS`）**：

1. **清单项存在**：本门解析链上有一条"复用分析"清单项（识别口径 = `evidence_type='RA'`，V140 落）。
   配置缺失时**显式自述"未配置"**，不静默记 OK（15 号文"空集必须可辨"）。
2. **本项目已有已批准的复用分析**（`t_reuse_analysis.approved_by` 非空）——等价于 IBR-06 原文
   "TR2/DCP1 **前**必须完成复用检查并输出结论"。"无现成 CBB / 自研"的结论由
   `POST /reuse-analyses/general` 承载（见 §5.7）。
3. **本门清单项若已判定，结论不得为 COND/FAIL**；已判 PASS 时其 `evidence_ref` 必须解析到
   一份**真实且已批准**的复用分析。**未判定不阻断**——逐项判定正是本门评审要做的动作。

> ⚠ **这里有一个我犯过并已纠正的设计错误（留档，因为它极易重犯）**：我最初把判据写成
> "该清单项必须已判定为 PASS/COND"。实测后果是**系统级自锁**——`requestReview` 会跑预检，
> 而清单项只能在评审内判定 ⇒ "因为没判定所以开不了评审，因为开不了评审所以判定不了"，
> 一次性打红 14 个既有用例。这与 REQ-2026-0764 的门点自环、15 号文"转段瞬间自锁"是**同型**。
> 教训：**用"评审内的产物"当"开评审的前置"必然自锁**；预检只能校验"开门之前就应存在的事实"。

- **`PrecheckService` 的硬编码 count 撤销**：原判据 `SELECT count(*) FROM t_reuse_analysis WHERE project_id=? AND approved_by IS NOT NULL`
  完全不看 `gate_code` 也不核证据（一次分析跨门永久通过）。
- **证据必须可解析**：`t_review_item.evidence_ref` 此前是自由文本（实测填任意字符串也 200 落库），
  本次对**本判据**引入解析校验（指向真实且已批准的 `RA-*`）。

### 5.5 与产品域（裁定 D-16）

`t_product` 补齐设计 §5.4 的字段（现库无 `family_id`）：

| 列 | 用途 |
| --- | --- |
| `family_id` | 产品族（复用度按族聚合的前提） |
| `layer` | 业务层级（为 L1~L5 分层预留；本期只落字段，不启用 IBR-15/16 门禁） |
| `platform_release_id` | 搭乘的平台版本（为 IBR-18 预留，L3 未落地时恒 NULL） |

### 5.6 与指标/绩效（裁定 D-08）

**"复用率"统一为结构内复用度**，且**必须与"资产被用率"分名**：

| 指标 | 定义 | 分母 | 用途 |
| --- | --- | --- | --- |
| **结构内复用度** `structuralReuse` | 产品 EBOM 中**带 CBB 标记的节点占比** | 该产品的 BOM 节点（**显式排除**根件、`PHANTOM` 与 `SUBSTITUTE` 两种"结构组织手段"占位件——后者 = 互替组占位件，V210 起） | 度量"产品真的在复用"（业务价值）|
| 资产被用率 `assetUsedRate`（原 `cbbReuseRate`） | 被引用过的 CBB ÷ 入册 CBB | CBB 总数 | 度量"资产库有没有活着"（库健康） |

- **空集必须可辨**：分母为 0 时输出**"不适用（无结构节点）"**，不输出 `0%`——本项目 26/27/28 批次的复盘结论是"每一次假绿都出在判据的分母或作用域上"。
- 01C-D4 的"战略协同"维度原设计取 `T_LAYER_REF` 的复用度；该表未落地，本期**改取结构内复用度**（同语义、可用承载），并在 01C 同步标注。

### 5.7 复用分析的两种形态（收口"平台级复用无承载"）

| 形态 | 端点 | 适用 | `candidate_cbbs` |
| --- | --- | --- | --- |
| **绑定 CBB** 的复用分析 | `POST /ipd/reuse-analyses {projectId, gateCode, cbbId, conclusion}` | "我要复用某个 CBB"（IBR-10 校验该 CBB 状态 ≥ VERIFIED） | `[cbbId]` |
| **通用**复用分析 | `POST /ipd/reuse-analyses/general {projectId, gateCode, conclusion, scope}` | "评估过，结论是**不复用**"/"无现成 CBB，本次自研"/"平台级/家族级复用" | `[]`（**空数组的语义就是"没有候选 CBB"**） |

**为什么必须补第二种**：原接口把 `cbbId` 设为必填 ⇒ 系统只能表达"我要复用 X"，
而"我评估过、结论不复用"无处安放；当时的绕过方式是**随便挂一个 CBB**，那会把没关系的东西记成"被复用"，
直接污染复用度与影响分析（原偏差登记见 `docs/plm-user-guide/附录C-§17`，现已收口）。
通用形态下 `conclusion` **必填**——"没有结论的复用分析"不能用来满足 IBR-06。

### 5.8 CBB 的两种落地来源：引用 vs 识别（批次54，2026-09-27 · 用户裁定 D54-3）

**用户原话**：「区分CBB作为被引用对象，还是在产品开发过程中识别CBB；如果是引用的CBB，物料上CBB标签**不可改**；
如果是识别CBB，则在选取的物料上**打上目标CBB标签**；**将识别CBB与添加物料的过程分开**」。

**两种来源的语义**（同一件事的两种发生方式，不是两种资产）：

| 来源 | 语义 | 产生方式 | 标签可改性 |
| --- | --- | --- | --- |
| **引用** `REFERENCE` | 开发中**搭载**一个已成型的 CBB——"这条结构行用的是这个资产" | **添加子件**时搭载（`POST /boms` 带 `cbbId`） | **不可改**（`CBB_TAG_IMMUTABLE`）——它描述的是**这条引用关系本身**，改它等于换掉引用 |
| **识别** `IDENTIFIED` | 产品开发过程中**识别出**该物料应成为某目标 CBB 的载体——"这个件以后是这个资产" | **独立动作** `POST /api/v1/boms/{id}/cbb`（body `{cbbId, reason}`，作用于**已存在**的结构行） | 可打 / 可换 / 可清（`cbbId=null` = 清除标签，行回到"没有 CBB"） |

**数据载体（为什么必须落库成一列）**：`t_bom_line.cbb_source`（`TEXT`，取值只有 `REFERENCE` / `IDENTIFIED`，空 = 该行没有 CBB）。

- **为什么不能用"有没有别的东西"推**：两种来源在库里若同形，界面就无从判断"这个标签能不能改"——
  而"能不能改"正是本裁定的全部内容。缺了它，界面只有两条退路：先让人点、再被后端拒（白跑一次请求），
  或干脆都禁掉（把合法操作也堵死）。
- **成对性**：`cbb_source` 只在 `cbb_id` 非空时有值（迁移 V177 的两条约束 `t_bom_line_cbb_source_check`、
  `t_bom_line_cbb_source_needs_cbb` + 自检块"成对性违例 = 0"）。存量回填口径：改造前 `cbb_id` 非空的行
  **全部**是"添加子件时搭载引用"⇒ 一律回填 `REFERENCE`（不猜、不编造）。
- **只读映射**：`BomLineEntity.cbbSource` 是 `insertable=false, updatable=false`，写入一律走 `BomService` 的显式 UPDATE
  （与 `structure_state` 同处置——列带 DB 默认与成对约束，不让 ORM 参与 INSERT）。
- **读面**：`BomLineResp.cbbSource` 与 `BomNode.cbbSource`（树节点同样带，评审者在 `/boms/tree` 上就能看出
  "这个 🧩CBB 标记能不能改"）。纯增字段 ⇒ 旧后端未部署时前端按 `null` 降级。

**识别动作的端点与设计意图**：

| 项 | 内容 |
| --- | --- |
| 端点 | `POST /api/v1/boms/{id}/cbb`（`id` 是**结构行** id；body `{cbbId, reason}`；权限点 `bom.update`；审计动作 `bom.cbb.tag`，diff 记 `action`（`TAG`/`RETAG`/`CLEAR`）+ 前后 cbbId + child + reason） |
| 与「添加子件」的关系 | **两个分开的动作与控件**（用户原话"将识别CBB与添加物料的过程分开"）：识别**不新建行、不改子件、不改数量**，故它能在"结构已经搭好之后"单独使用——这是把两者分开的全部意义（合成一个动作时，"补一个识别标签"只能靠"删掉重挂"来做） |
| 界面落点 | BOM 编辑器**右栏选中行的详情**里的独立区块「🏷 CBB 归属」（不在工具栏的"添加子件"旁边），三态各说一句话，判据就是 `cbbSource` |
| 引用来源的执拗行为 | 对 `REFERENCE` 行改标签 ⇒ `CBB_TAG_IMMUTABLE`；**同值重发视为幂等无操作**（不制造无意义的失败）；界面**先禁用并给出原因**（"要换请先移除该行再重新添加"），不让人白点一次 |
| 同一把门 | 识别动作受结构可编辑门约束（`BomService.assertStructureEditable`）：**已发布（当前 rev 已冻结基线）⇒ 拒绝**，正式行须变更窗口，草案行自由——与其它结构写动作同门，不另开例外 |
| 级联 | 换/清标签时先撤旧使用方再登新（`unmarkCbbUsage` → `markCbbUsage`），避免同一物料版本上留幽灵使用方 |

**CBB 侧校验：全部复用既有唯一实现**（本批不新写第二份）：可引用性走 `IpdModelService.assertCbbReferenceable`（IBR-10）；
"行版本 == CBB 物料形态"走 `CBB_ITEM_REV_MISMATCH`（与添加子件同一判据，§2.1 同批校验）；
使用方登记/撤销走 `markCbbUsage` / `unmarkCbbUsage`（结构级使用方，粒度见 §2.2 与 §5.3）。

**为什么不用 `t_cbb_usage.source` 扩值**：

1. `t_cbb_usage.source` 是**共享词表**（当前值 `BOM_MARK`，另有其它登记来源共用），扩值等于动跨域共享词表
   ⇒ 按本仓治理口径需 **W-3 审批**（跨域词表变更），审批成本远大于收益；
2. 语义上也不对：`t_cbb_usage` 回答的是"**谁在用这个资产**"（治理面 + 影响面），
   而"这条引用是搭载来的还是识别出来的"是**结构行自己**的属性——把它塞进使用方表，
   会让"使用方"这张表同时承载两件事，下一批做影响分析时必然要再拆一次；
3. 落点更贴：来源只对"**落在结构位上的** CBB"成立（项目级使用方没有"引用/识别"之别），
   放在 `t_bom_line` 上天然只覆盖该管的那部分。

**判据（本批已断言）**：① 添加子件带 `cbbId` ⇒ 行 `cbbSource=REFERENCE`，对其调识别端点换标签 ⇒ `CBB_TAG_IMMUTABLE`；
② 无 CBB 的行调识别端点 ⇒ `IDENTIFIED` 且 `t_cbb_usage` 出现/更新结构级使用方，再传 `cbbId=null` ⇒ 标签清空且使用方撤销；
③ 引用来源行**同值重发** ⇒ 幂等 200；④ 已发布头（已冻结基线）下四个结构写动作（加行/删行/改行/识别 CBB）一律 `BOM_FROZEN_STRUCTURE_LOCKED`。

> 与 §7.1 迁移清单的关系：本列由 **V177**（批次54）加入，该迁移同时做 BOM 头三态与存量归置；
> 本文档 §7 的迁移清单以本批之前的批次为界，V177 的完整依据见批次54 裁定 D54-1/D54-2/D54-3/D54-10。

---

## 6. 权限与签署（裁定 D-06 / D-11）

### 6.1 权限点（共四枚，`t_permission_rule` 与 `PermissionService.RULES` 必须同步，否则 `RULES_DB_DRIFT`）

| 域 | 动作 | 角色集 | 语义 |
| --- | --- | --- | --- |
| `cbb` | `create` | `admin, flow_owner, platform_owner, pdt_manager` | 入册（+ `DEV↔VERIFIED` 流转与 `RELEASED→MAINT`——资产维护面） |
| `cbb` | `update`（**V141**） | `admin, flow_owner, platform_owner, pdt_manager` | **治理属性补录**（§2.4）。与 `create` 同档：能入册的人就该能把入册信息补齐；补录不改资产内容 ⇒ 不需发布级权限 |
| `cbb` | `release` | `admin, platform_owner` | 发布（须签署） |
| `cbb` | `decom` | `admin, platform_owner` | 退役（须通告 + 退役闸门 + 签署） |

> **为什么补录单独成一个权限点**（而不是复用 `create`）：审计要能分辨"**入册**"与"**事后补录**"两类动作
> （同一把钥匙能开两道门时，审计行只能告诉你"开了门"，不能告诉你"为什么开"）；而补录面向的是**治理属性**，
> 与发布/退役（状态治理）不同类。四行都必须在 `t_permission_rule` 与 `PermissionService.RULES` 两处逐字一致。

### 6.2 与既有 `ipd.*` 的切分

- `ipd.create` / `ipd.update` / `ipd.transition` **保持不动**（其他 IPD 对象在用，改集合会牵连全局）。
- CBB 的写路径**不再走 `ipd.create`**，改走 `cbb.create`——这是把"入册"从"任何能建 IPD 对象的人"收回到**资产治理**。
- CBB 的 `transition` 按目标状态分派：`→RELEASED` 要 `cbb.release`；`→DECOM` 要 `cbb.decom`；其余仍走 `ipd.transition`。

### 6.3 新治理角色 `platform_owner`（裁定 D-11）

- `t_role(code='platform_owner', name='平台/产品线技术负责人', role_type='FUNCTION')`。
- 对应设计 01A-BO-05 / 扩展06-§4 的"产品线技术负责人（发布/退役批准）"。
- 功能角色映射：`PRJ_READ / REQ_READ / BOM_READ / ITM_READ / REVIEW_READ / DOC_READ`（读面与 `tr_chair` 同档，**不含** `REVIEW_WRITE`——发布不等于评审判定）。
- **不接受** CBB 发布被 `admin` 兜底：`admin` 在角色集里是运维兜底，不作为业务常态（治理台设计 21 号文对"禁 admin 兜底行"同一口径）。

### 6.4 签署

- 复用 `SignatureService` + `t_sign_rec`（`obj_type='CBB'`，`action` ∈ `RELEASE`/`DECOM`），内容哈希与验签沿用既有实现。
- 签署失败/缺失 ⇒ 400 且文案指向"去 CBB 资产库点【发布并签署】"。

---

## 7. 信息模型变更清单

### 7.1 迁移

**V140（一次性）**

| 对象 | 变更 | 说明 |
| --- | --- | --- |
| `t_cbb` | `ADD rev TEXT NOT NULL DEFAULT 'A'` | 版本号 |
| `t_cbb_rev` | **新建** | 版本快照（`cbb_id/rev/status/trl_level/ref_item_rev_id/change_note/drafted_ecr_code`） |
| `t_cbb_usage` | **重建**（DROP+CREATE，按"残留无业务意义"裁定 D-15）+ `dispose_type`/`dispose_note`/`disposed_by`/`disposed_on` | 新唯一约束 `(cbb_id, COALESCE(project_id,0), COALESCE(item_rev_id,0))`；**清空存量 0 行等价物 + 显式注释** |
| `t_bom_line` | `ADD cbb_id BIGINT NULL` | CBB 引用标记（可空；有值时触发命中级联） |
| `t_product` | `ADD family_id BIGINT / layer TEXT / platform_release_id BIGINT` | 裁定 D-16（`target_cost` 已存在，不重复加） |
| `t_checklist_item` | 为 DCP1 模板插入"复用分析已批准（CBB/平台，IBR-06）" | 裁定 D-03② |
| `t_role` | 插入 `platform_owner` | 裁定 D-11 |
| `t_function_role`/`t_role_function` | `platform_owner` 读面映射 | 同 §6.3 |
| `t_permission_rule` | 插入 `cbb.create/release/decom` 三行 | 与 `RULES` 同步 |
| `ipd.knowledge` 对象类型注册 | `CBB` 已有（V23）；补 `t_attr_template` 的 `cbbType` 枚举说明 | 词表单源（18 号文 S 条） |

**V141（2026-09-22，纯增量 + 幂等；末尾带自检块，任一不成立即抛异常整体回滚——防"迁移成功但能力没生效"）**

| 对象 | 变更 | 说明 |
| --- | --- | --- |
| `t_cbb` | `ADD doc_rev_id BIGINT` | **交付载体**（逻辑引用 `t_doc_rev`，可空，§2.1.1）；**不回填任何业务事实**——存量 CBB 的载体只能由责任人补录（机器猜不出来） |
| `t_cbb` | `ADD owner_login TEXT` | 责任人（login；本库身份约定 TEXT，对照 V23 `t_open_issue.owner_login`） |
| `t_cbb` | `CREATE INDEX idx_cbb_doc_rev ON t_cbb(doc_rev_id) WHERE doc_rev_id IS NOT NULL` | 部分索引（"按载体反查 CBB"是这个关系的主要查询方向） |
| `t_cbb_rev` | `ADD doc_rev_id BIGINT` | 版本快照带载体（§2.3） |
| `t_permission_rule` | 插入 `cbb.update`（`["admin","flow_owner","platform_owner","pdt_manager"]`） | 与 `PermissionService.RULES` **逐字同步**（§2.4 末尾） |
| `t_ecn` | `ADD updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` + 存量按 `created_at` 回填 | 变更域列表范式前提（23 号文 §5.2）；**不假装存量行"刚被改过"** |
| 自检块 | 断言四列都在 + `cbb` 权限点恰 4 行 + `cbb.update` 角色集含 `platform_owner`/`pdt_manager`/`admin` + `t_ecn.updated_at` 无空值 | 迁移的"完成"以**能力生效**为准，不以"SQL 跑完没报错"为准 |

### 7.2 单一实现纪律（本文的关键约束）

| 规则 | 唯一实现位置 | 不得再出现 |
| --- | --- | --- |
| IBR-06 复用分析已批准 | `t_checklist_item`（TR2/M2 + DCP1 同名项） | ❌ `PrecheckService` 里的项目级 count |
| CBB 引用成熟度门（TRL/状态） | `IpdModelService.createReuseAnalysis`（引用闸口）**+** BOM 写入侧（结构闸口，同判据同文案） | ❌ 两处各自实现一套词表 |
| CBB 使用方登记 | `t_cbb_usage`（项目级 + 结构级两种粒度） | ❌ `t_eco.attrs` 里另存一份使用方 JSON |
| 结构内复用度 | `PipelineService`（从 BOM 派生） | ❌ 前端或报表各自算一套 |
| CBB 状态机允许边 | `IpdModelService.transitionCbb.allowed` **+** `flows/cbb-flow.yaml`（读面）——**两处必须逐边一致** | ❌ 只改一处（本批实测：读面缺 `DEV→DECOM` ⇒ 页面看不到服务端允许的动作） |
| CBB 类型值域 | **库约束** `t_cbb_cbb_type_check`（`HW/SW/ALGO/MECH/TEST`） | ❌ 界面自造值域（本批实测：界面编了 `ELEC/SOFTWARE/PROCESS/DOC`，与约束**零交集** ⇒ 选前四个必 400） |
| **齐备判据**（载体/责任人/TRL） | `IpdModelService.cbbGaps`（**读面 `gaps` 与写面拦截同一个函数**） | ❌ 界面自行重算待补清单；❌ 在 `transitionCbb` 里另写一套判据 |
| **载体的业务键解析** | `resolveItemRevId` / `resolveDocRevId`（+ `carrierOf` 收敛 `code`/`itemCode`/`docNo` 三种编号键名） | ❌ 各写各的解析（"同义键名"只在这一处收敛，不构成两处实现） |
| **时间列推进** | 实体 `@PrePersist/@PreUpdate`（`EcrEntity`/`EcoEntity`/`EcnEntity`）+ 绕过 JPA 的裸 SQL 显式写 `updated_at` | ❌ 逐处 `setUpdatedAt(...)`（写点一多必漏，§10.1 #9） |
| 台账列表的检索/分页 | `IpdModelService.listCbbs`（服务端 SQL）+ 标准分页对象 | ❌ 前端"拉全量再本地过滤"（08 §6.2.1 反模式） |

### 7.3 前端形态（08 号规格的落地口径）

> 用户裁定（2026-09-21）：「CBB 的 UI 设计应该参照 `docs/plm-tech/08-前端实现规格.md`，使用标准化的检索框、DataGrid 对象列表、详情面板」。
> 本页第一版**三处都偏离**：左栏是自绘 `<table class="grid">`（无排序/筛选/↑↓ 焦点联动）、无检索框（拉全量再本地过滤）、无分页 UI 且右侧不是统一构件。

| 规格条款 | 本页落地 | 判据 |
| --- | --- | --- |
| §3.1 标准业务页面结构 | `breadcrumb → page-head(h1+按钮行) → ctx-bar(生命周期口径) → toolbar → 两栏` | W34 U1a~U1d |
| §3.3.1 两栏变体 | `.dual.split`（表格 40% / 详情 60%）+ 全屏互斥类 `.dp-fullscreen-detail` / `.grid-fullscreen-detail` | W34 U8a/U8b |
| §4 AG Grid | `.grid-wrap.ag-theme-alpine` + `.ag-root`；列：编码/名称/类型/版本/TRL/状态/使用方(项目/结构)/年审到期(超期红·临期黄)/最近更新 | W34 U2a~U2b2 |
| §4.7.2 焦点联动 | `onCellFocused` + `onRowClicked` → 右侧面板跟随 | W34 U3a/U3b |
| §4.7.6 只读网格 | 不设任何 `editable` 列（双击不进编辑）；**资产主档无字段可改**（改内容=升版 §2.3） | W34 U2d |
| §5 统一详情面板 | 统一 `DetailPanel`（`dp-head/dp-body/dp-foot`），字段 11 项只读；动作区走 `extra`（§6.1 禁弹窗） | W34 U3c/U3d |
| §6.2 检索框 | 独立 `searchInput`，**回车触发 / Esc 清空**，placeholder 明示"回车触发" | W34 U4a/U4e |
| §6.3.1 列表范式 | 「共 N 条 · 第 x/y 页（最新在前）」+ 上下页；筛选变化回第 1 页；**创建后回第 1 页并选中新对象** | W34 U5a/U5b、U6c |
| §6.8 空态 | AG Grid 空态 overlay **复述当前筛选** + 「清空全部筛选」出口（严禁空白面板） | W34 U4b~U4d |
| §6.3.1 时间维度（所有对象统一） | toolbar 提供「更新起止」日期区间（闭区间整天，服务端 `updatedFrom/updatedTo`） | T3-19 R14a~R14g |

**"年审到期"列是裁定 D-13（人工查）的落点**：系统不自动提醒 ⇒ 界面**必须**把到期状态摆在列上
（超期用 `--err` 粗体、临期 ≤30 天用 `--warn`、未设置显示「未设置」而不是留白），并提供 `overdue=yes/no` 筛子——
否则"人工查"只能靠人滚列表。空值语义同样显式化（未设置 ≠ 未到期 ≠ 已过期，三者不混）。

### 7.4 台账列表的服务端契约（本次形状升级）

```
GET /api/v1/ipd/cbbs?keyword=&status=&cbbType=&overdue=&updatedFrom=&updatedTo=&page=0&pageSize=30[&size=]
→ { items:[CbbResp], total, page, pageSize, pageSizeCapped }
```

- **为什么要升级**：原实现返回**裸数组**、无参数 ⇒ 界面只能"拉全量再本地过滤"；且 `listCbbs` 是 N+1
  （每条 CBB 再查详情 + 使用方计数）。现为**一次分页查询 + 一次 count**（使用方两个计数下沉为相关子查询），与条数无关。
- `pageSize` 超上限（`Paged.MAX_PAGE_SIZE`=100）→ 钳制并置 `pageSizeCapped=true`（**不静默截断**）；`size` 为 `pageSize` 别名。
- 排序 `id DESC`（§6.3.1 通用口径；CBB 无合规时限类外部强制性 ⇒ 不用例外排序）。
- 未带凭据一律 401（列表不得对未登录开放）。

### 7.5 补录接口契约（V141 / D-17）

```
PUT /api/v1/ipd/cbbs/{id}            权限点 cbb.update
Body（部分更新：出现的键才处理；显式 null = 清空该关系；未知键 400）
  { "ownerLogin":"cbbpo1", "trlLevel":6, "annualReviewDue":"2027-06-30",
    "refItem":{"code":"MAT-0001","rev":"B"},      // 物料形态（HW/MECH 必需）
    "docRef":{"code":"DOC-2026-0001","rev":"A"},  // 交付载体（SW/ALGO/TEST 可用）
    "reusePolicy":{...}, "note":"补齐治理属性" }
→ 200 CbbResp（改后全量读面，含重算后的 gaps）
```

| 允许的键 | 语义 | 备注 |
| --- | --- | --- |
| `ownerLogin` | 责任人（login） | `null` = 清空；齐备门 `OWNER` 读它是空还是非空 |
| `trlLevel` | TRL 1..9 | `null` = 清空；越界 400 `CBB_TRL_RANGE`（**上下界都判**）；非数字 400 `CBB_TRL_NOT_A_NUMBER` |
| `annualReviewDue` | 年审到期日（`YYYY-MM-DD`） | 手改**不是**常规路径（状态机在 `→VERIFIED` 时自动续期）；格式错 400 `CBB_DATE_INVALID`；`null` = 交回状态机下次验证重算 |
| `reusePolicy` | 复用策略（JSON） | 结构化策略，**不是**"没处放的关系"的搬家袋（§2.1.1） |
| `refItem` | 物料形态，**业务键** `{code, rev}` | `null` = 清空；`code` 亦接受 `itemCode`；缺一半 400 `CBB_ITEM_REF_INCOMPLETE` |
| `docRef` | 交付载体，**业务键** `{code, rev}` | `null` = 清空；`code` 亦接受 `docNo`；缺一半 400 `CBB_DOC_REF_INCOMPLETE` |
| `note` | 审计说明（不落主档） | **只有 `note` 不算一次补录** ⇒ 400 `CBB_GOV_NO_FIELD` |

**错误码表**（全部为 400，文案一律"指名缺什么 / 指向可达的下一步"）：

| 错误码 | 触发条件 | 用户下一步 |
| --- | --- | --- |
| `CBB_GOV_NO_FIELD` | 请求体里**没有任何可补录字段**（如只给 `note`） | 至少给一个允许的键 |
| `CBB_GOV_UNKNOWN_FIELD` | 出现白名单外的键（如 `name`/`cbbType`/拼错的 `owner`） | 改内容走升版 `POST /ipd/cbbs/{id}/revs`；补录只认 7 个键 |
| `CBB_TRL_RANGE` | `trlLevel` 不在 1..9 | 改到 1..9（IBR-10） |
| `CBB_TRL_NOT_A_NUMBER` | `trlLevel` 非整数 | 传数字 |
| `CBB_DATE_INVALID` | `annualReviewDue` 不是 `YYYY-MM-DD` | 用 ISO 日期 |
| `CBB_ITEM_REF_NOT_FOUND` | `refItem` 的 `code + rev` 解析不到 `t_item_rev` | 用 `GET /api/v1/items?keyword=` 核编号与版本；没有该版本先在物料域建版本 |
| `CBB_ITEM_REF_INCOMPLETE` | 只给了 `code` 或只给了 `rev` | 两个都给（只给一半无法定位版本行） |
| `CBB_DOC_REF_NOT_FOUND` | `docRef` 解析不到 `t_doc_rev` | 用 `GET /api/v1/documents?keyword=` 核编号与版本 |
| `CBB_DOC_REF_INCOMPLETE` | 只给了 `docNo` 或只给了 `rev` | 两个都给 |
| `CBB_CARRIER_FORMAT` | 载体不是 `{code, rev}` 对象也不是 `null` | 传对象或 `null` |
| `CBB_TYPE_INVALID` | （入册 `POST`）`cbbType` 不在库约束值域 `HW/SW/ALGO/MECH/TEST` | 选值域内类型——**界面选项必须 ⊆ 库约束** |
| `CBB_DECOM_FROZEN` | 该 CBB 已 `DECOM` | 主档冻结、不再补录；要重新启用请新建 CBB（历史留痕优先） |
| `CBB_NOT_FOUND` | id 不存在 | 先 `GET /ipd/cbbs` 取真实 id |
| `CBB_GOV_NOT_APPLIED` | UPDATE 落库行数 < 1（并发被删） | 刷新后重试（**不信"响应说成功"**，见 §10 #8 同族纪律） |
| `CBB_GOVERNANCE_INCOMPLETE` | `DEV → VERIFIED` 时 `gaps` 非空（**写面**同判据） | 先按点名项走补录（本接口），再验证 |

**`CbbResp` 新增字段表**（V141 追加载体/责任人与齐备缺口；列表与详情共用同一映射函数，杜绝两处口径漂移）：

| 字段 | 类型 | 来源 | 用途 |
| --- | --- | --- | --- |
| `ownerLogin` | string \| null | `t_cbb.owner_login` | 责任人（`owner_team_id` 保留但本期不作门、界面不开，§9） |
| `docRevId` | number \| null | `t_cbb.doc_rev_id` | 交付载体的内部 id（**写路径用**） |
| `refItemCode` / `refItemRev` | string \| null | `LEFT JOIN t_item_rev / t_item` | 物料形态的**业务码回显**（界面不显示 `#id`） |
| `docNo` / `docRev` | string \| null | `LEFT JOIN t_doc_rev / t_document` | 交付载体的**业务码回显** |
| `gaps` | `[{code,label}]` | 服务端 `cbbGaps` 计算 | `DEV→VERIFIED` 的待补清单——**界面只渲染、不重算**（§3.4） |

> **两条边界**（避免误读）：① 载体/责任人的**权威落点**是 `t_cbb.doc_rev_id` / `t_cbb.owner_login`（V141），
> `ipd/knowledge/cbb/registry.yaml` 仍只是只读投影；② 载体列是**逻辑引用**（无外键），存在性由服务端解析保证，
> 不靠 DB 约束——这与 13 号文"逻辑引用登记表 + 全库对账"的既有口径一致。

---

## 8. 验收断言

### 8.1 构建态

| # | 断言 |
| --- | --- |
| B1 | `mvn -DskipTests package` 通过 |
| B2 | 既有单测全绿（零回归） |
| B3 | 迁移编号巡检通过（`plm-migration-lint.sh`：无重号、无跳号、V140 与 **V141** 均已登记） |
| B4 | 权限一致性校验通过：无 `RULES_DB_DRIFT`、无 `DOMAIN_UNION_MISSING`（V141 新增的 `cbb.update` 也在对账范围内） |

### 8.2 一致性

| # | 断言 |
| --- | --- |
| C1 | `PermissionService.RULES` 的 `cbb.*` **四行**（`create/update/release/decom`）与 `t_permission_rule` **逐字一致** |
| C2 | `t_cbb_usage` 唯一约束与 `IpdModelService` 的 `ON CONFLICT` 目标列一致（否则幂等失效） |
| C3 | 对象类型词表单源：`CBB` 在 `MetadataService`/`LookupService`/`ResolverRegisterConfig`/前端 `objRef`/`lookup` 五处值域一致 |
| C4 | 文档一致性：本文与 `ipd-extension/02-§2.5`、`01A-BO-05`、用户手册 15 章、**23 号文（变更域读面）** 的 CBB 状态机、字段、权限**逐条一致**（无第二种说法） |
| C5 | **齐备门判据单源**：`gaps` 读面与 `DEV→VERIFIED` 写面调用的是**同一个函数**（`IpdModelService.cbbGaps`）——不是"文案相似"，是同一实现 |

### 8.3 运行态（真实路径走查）

| # | 断言 | 走查脚本断言点 |
| --- | --- | --- |
| R1 | 建 CBB（`cbb.create`）：`platform_owner` 200；`developer` 403 | `POST /ipd/cbbs` 双身份 |
| R2 | `DEV → VERIFIED` 需证据；无证据 400 | `POST /ipd/cbbs/{id}/transition` |
| R3 | **回退边**：`VERIFIED → DEV` 无 reason → 400；有 ≥10 字 reason → 200 且审计含 reason | 同上 |
| R4 | 发布需签署：无签署 → 400；签署后 → `RELEASED` 且 `t_sign_rec` 有行 | `POST /ipd/cbbs/{id}/release` |
| R5 | BOM 行标 CBB → `t_cbb_usage` 出现 **结构级**行（`item_rev_id` 非空） | `POST /boms/lines` + `GET /ipd/cbbs/{id}/usage-impact` |
| R6 | IBR-06 三判据：① 本项目**无**已批准复用分析 → `REUSE_ANALYSIS=FAIL`（点名去建/批准）；② 已有且本门清单项未判定 → **PASS（不等判定，避免评审自锁）**；③ 清单项已判 FAIL → FAIL；④ 已判 PASS 但证据解析不到已批准 RA → FAIL | `GET /reviews/precheck?gateCode=DCP1` / `?gateCode=TR2` |
| R7 | DCP1 复用分析清单项存在（`M5`）且证据类型为 `RA`、判定人 `product_manager` | `GET /reviews/precheck?gateCode=DCP1` + 模板读面 |
| R8 | 退役闸门：使用方未处置 → 400 点名未处置行；逐行处置后 → 200 `DECOM` | `POST /ipd/cbbs/{id}/decom` |
| R9 | 升版自动起草 ECR：`t_cbb_rev.drafted_ecr_code` 非空 + ECR 存在且正文含 CBB **编号** + 影响面已挂到该 ECR | `POST /ipd/cbbs/{id}/revs` + `GET /ecrs/{code}` |
| R10 | 结构内复用度：有结构的返数（与库态对照）、无结构的返**"不适用"**（不返 0%） | `GET /pipeline/metrics` |
| R11 | 前端 `/cbb` 页：列表含版本/效期/使用方处置列；行内动作含回退/发布并签署/退役；操作后状态与库一致 | UI 走查脚本（CDP） |
| R12 | 旧 12 页 + IPD 页冒烟零回归 | 既有走查脚本集 |
| R14 | 台账列表服务端检索/分页：标准分页对象、pageSize 钳制标记、keyword/status/overdue 过滤、未登录 401 | `GET /ipd/cbbs` 参数化调用 + 库态对照 |
| R13 | **CBB 影响面落成 `t_eco_affected` 行**：升版起草的 ECR 带结构化影响面 → 建 ECO 时落行（`ITEM_REV` 行 `obj_id` 可追溯回 CBB 编号、`BOM` 行列父件、`action=REVISE`）→ ECO 详情 `affected` 可见；同 ECO 不重复膨胀 | `POST /ipd/cbbs/{id}/revs` → `POST /ecos` → `GET /ecos/{id}`；库计数 `t_eco_affected where eco_id=…` |
| R15 | **界面形态（08 号规格）**：标准页面结构齐备、左栏真是 AG Grid（只读）、检索框回车触发/Esc 清空、空态复述筛选、分页 UI、右侧统一详情面板且焦点联动、面板全屏、**界面类型选项 ⊆ 库约束值域**、**经界面新建→验证通过→动作区随之切换** | 真浏览器走查 `cbb-ui-walkthrough.mjs`（W34，32 断言；走**真实 IdP 表单**登录） |

**V141 / D-17~D-20 追加（R20~R27）**——本批的断言编号按"一件事一行"，每行写**意图 + 走查锚点**（脚本细节见 `ipd/deploy/wsl/plm-app/b42-cbb-governance-and-change.sh`）：

| # | 断言意图 | 走查锚点 |
| --- | --- | --- |
| **R20** | **迁移与权限就位**：`t_cbb.doc_rev_id` / `t_cbb.owner_login` / `t_cbb_rev.doc_rev_id` / `t_ecn.updated_at` 四列都在；`cbb` 权限点恰好 4 行（`create/update/release/decom`）且 `cbb.update` 角色集含 `platform_owner`；迁移自检块不抛异常（"迁移成功但能力没生效"不许发生） | 库结构读面 + `t_permission_rule` 行数/内容 + 启动期权限一致性校验（`RULES_DB_DRIFT`） |
| **R21** | **补录**：① 部分更新（只出现的键被改，其它键原值不动）；② 载体用**业务键** `{code,rev}` 且解析成功；③ 引用不存在**点名**（`CBB_ITEM_REF_NOT_FOUND` / `CBB_DOC_REF_NOT_FOUND`）；④ 未知键拒绝（`CBB_GOV_UNKNOWN_FIELD`，含"传 `name` 试图改内容"）；⑤ 显式 `null` = 清空（回读该列为 NULL）；⑥ 只给 `note` → `CBB_GOV_NO_FIELD`；⑦ `DECOM` 条目 → `CBB_DECOM_FROZEN` | `PUT /api/v1/ipd/cbbs/{id}` 参数化调用 + `GET /ipd/cbbs/{id}` 回读 + 库态对照 |
| **R22** | **齐备门**：① 缺三项 → `DEV→VERIFIED` 400 `CBB_GOVERNANCE_INCOMPLETE` 且**逐项点名**；② 只补一半仍被拒；③ **按类型分流的载体规则**（HW 只给 `docRef` **不**算齐备；ALGO 给 `docRef` 即算）；④ **`gaps` 与门同源**（读面显示的缺口 == 写面拦下的缺口，两侧缺项集合一致）；⑤ 补齐后 `gaps` 为空且状态进 `VERIFIED`（库内确认） | `GET /ipd/cbbs/{id}`（读 `gaps`）+ `POST /ipd/cbbs/{id}/transition {to:VERIFIED}` + 库态对照 |
| **R23** | **版本快照带载体**：升版时给 `docRef` → `t_cbb_rev` 新快照行的 `doc_rev_id` 非空且等于解析结果；**不给** `docRef` → 快照保持当前值（不给 ≠ 清空）；`t_cbb.doc_rev_id` 同步前进 | `POST /ipd/cbbs/{id}/revs` + `GET /ipd/cbbs/{id}/revs` + 库态对照 |
| **R24** | **ECR 读面与列表**：① `ecoCode` 按 **`ecr_id`** 正确取值（ECR 详情返回的是"以本 ECR 为来源"的那张 ECO，**不是** id 相同的那张——本批修掉的潜伏误取）；② 列表批量 `ecoCode` 与单条口径一致（取最新一张）；③ 时间维度可用（`updatedFrom/updatedTo` 按更新起止筛，初评后 `updatedAt` 前进）；④ `PUT /ecrs/{id}` 在 `TO_ECO`/`CLOSED` 态被拒（`ECR_LOCKED`），`OPEN`/`TRIAGED` 可改 | `GET /ecrs/{id}` + `GET /ecrs?updatedFrom=&updatedTo=` + `PUT /ecrs/{id}` 三态 |
| **R25** | **三对象非同一对象**：① 一条 ECR 可拆**多条** ECO（`t_eco.ecr_id` 可空且未限条数）；② **无 ECR** 也能建 ECO（`ecrId` 为空时 `createEco` 不回写任何 ECR 状态）；③ ECO 挂 ECR（`PUT /ecos/{id} {ecrId}`）→ 该 ECR 变 `TO_ECO`；④ **二次挂载被拒**（已 `TO_ECO` 的 ECR 再挂 → `ECR_NOT_LINKABLE`）；⑤ ECN 必挂 ECO（`t_ecn.eco_id` NOT NULL） | `POST /ecrs` → `POST /ecos`（两次，同一 `ecrId`）→ `PUT /ecos/{id}` → 库态对照 |
| **R26** | **ECN 列表与回执闭环**：① `GET /ecns` 返**标准分页对象**且支持 `status/keyword/updatedFrom/updatedTo/ecoId`；② 列表带 `ecoCode`（按 `ecoId` 批量取值）、`ecoTitle/createdBy/createdAt/updatedAt`；③ 回执收齐 → `ACKNOWLEDGED`；④ 关闭 ECN **反向把来源 ECO 置 `CLOSED`**；⑤ `updated_at` **真的推进**（下发/回执后列表"最近更新"变化，且 `updatedFrom` 能筛到） | `GET /ecns` 参数化 + `POST /ecns/{id}/ack` + `POST /ecns/{id}/transition` + `GET /ecos/{id}` 回读 |
| **R27** | **回归**：① 列表新字段不破坏既有调用方（`CbbResp`/`EcrResp`/`EcnResp` 均保留旧字段与兼容构造）；② 旧 `refItemRevId`（内部 id）入册路径仍可用；③ `GET /ecos?updatedFrom=` 仍可用（ECO 的时间维度不因本批改口）；④ 旧 12 页 + IPD 页冒烟零回归 | 既有走查脚本集 + 参数化回归调用 |

---

## 9. 明确未落地的部分（不许读成已实现）

| 未落地项 | 依赖 / 现状 | 触发条件（何时做） |
| --- | --- | --- |
| **L3 平台层**：`t_platform` / `t_platform_release`（发布列车）/ `t_product.platform_release_id` 搭乘声明 | 需业务先提供"平台路标数列 + 产品搭乘数据" | 出现**第一个**"多产品共享同一平台、需按固定节奏发版"的业务诉求时 |
| **L5 技术层**：`t_tech_item` / `t_tech_transfer`（技术转移五件套） | 需业务先定义转移包齐套清单 | 出现**第一次**"预研成果要正式移交接管方"时（J-IPD13） |
| **`t_layer_ref` 跨层引用泛化**（M-12） | 依赖 L3/L5 对象存在 | 同上两者之一落地时；届时 `t_cbb_usage` 收敛为它的特化视图 |
| **IBR-16/17/18**：成熟度门禁（平台版本）/路标对齐/发布列车 | 依赖 L3 | 同上 |
| **年审自动扫描** | — | 用户显式裁定**维持人工查**（裁定 D-13）；若后续要自动，复用 `ProjectService` 的效期扫描作业模式 |
| **`owner_team_id`（归属团队）不进补录表单**（V141 决策，**不是漏做**） | 需要组织/团队主数据（团队字典与成员关系）；责任人已落到 `owner_login`（"责任到人"才谈得上发布/退役找谁，团队不是可签署主体） | 组织/团队主数据就位时再开该字段；届时它**只作为额外维度**，不替换 `owner_login`（齐备门仍读责任人） |
| **载体只校验存在性、不校验文档版本状态** | 需要文档域把"作废/草稿"作为常规动作且产生真实案例 | 出现**第一个**"载体指向已作废文档"的真实案例时收紧（判据仍只加在 `cbbGaps` 一处，界面不用改，§2.1.1） |
| **ECR / ECN 的 ABAC 与项目作用域未做** | 需权限模型扩展（对象级授权 + 项目作用域过滤，见 10/21 号文）；本批只做**域级权限点**（`ecr.*` 既有 + `_platform/flows` 读面） | 变更域出现"申请人只能看自己项目的变更"这类真实诉求时；届时按 10 号文 checklist 复制，不重新设计 |

---

## 10. 缺陷档案（本次审视发现的、值得跨域复用的形态）

| # | 形态 | 本次实例 | 通用教训 |
| --- | --- | --- | --- |
| 1 | **同一规则两处实现、口径不同** | IBR-06：清单项（有判定人/证据槽）vs 预检 count（项目级、不看门点） | 产品级规格"一件事只能有一个实现"；**配置即数据的规则不应再硬编码一遍** |
| 2 | **判据作用域错**（分母/范围） | `REUSE_ANALYSIS` 不看 `gate_code` ⇒ 一次分析跨门永久通过 | 与 15 号文同型：**假绿出在分母或作用域，不在判据本身** |
| 3 | **字段建了但从未被写/读** | `t_cbb_usage.item_rev_id`（建了、无人写）；`t_cbb.ref_item_rev_id`（写得进、读不回） | "写得进读不回"是 REQ-2026-0482/1250 同族缺陷；**列的存在不等于关系存在** |
| 4 | **关系承载表缺席，降级为 JSONB 备注** | CBB 使用方只写进 `t_eco.attrs`，不写 `t_eco_affected` | 备注不是关系：查不了、对不了账、驱动不了下游 |
| 5 | **单向状态机缺收场路径** | `DEV` 退不回也退役不了 | 状态机设计必须回答"建错了怎么办" |

### 10.1 第二批评审（2026-09-22，用户复审 CBB 页面后提出 6 问）追加 4 条

| # | 形态 | 本次实例 | 通用教训 | 本批如何收口 |
| --- | --- | --- | --- | --- |
| 6 | **同一个面板槽位被两处渲染** | 「新建 CBB」面板渲染进了「已选中 CBB 的详情面板」的 `extra` 里（`action` 单槽 + 两处渲染）⇒ 用户看到"**新建面板叠在详情面板上**"，关掉一个另一个也跟着乱 | 一个插槽只能有一个占用者——**互斥态要用显式状态表达**（`creating` / 已选中 / 空态三态互斥），不要用"两个布尔各自渲染"隐式实现 | 改为独立 `creating` 状态 + 右栏**三态互斥**；判据 W34（界面走查） |
| 7 | **孤儿对象 + 死 DTO + 死代码**（写进去了，但**没有读面/没有入口**） | CBB 升版起草的 ECR 实测 **18 条**（其中 **13 条停在 `OPEN`、`eco_cnt=0`**）；前端全仓对 `/ecrs` **只有 `POST`、无列表**；`/changes` 只查 `/ecos`；`ChangeDetailPage.createEco()` 是**死代码**；ECO 新建路径**从不带 `ecrId`**（面板字段里没有它）⇒ ECR→ECO 交接链**整条断裂**；`UpdateEcrReq` 是**死 DTO**（只有定义、无端点） | **"写进去了"只是半个功能**：任何自动产生的对象都必须回答"**人在哪儿看到它、在哪儿处理它**"。判据不是"库里行数增长"，而是"**用户能在界面上走完这条链**"（02 章 J2 旅程的每一步都要有落点） | 工程变更工作台一页三对象 + 深链 `?obj=ECR&code=` + ECR 初评→转变更单 + ECO「关联 ECR」可编辑 + `PUT /ecrs/{id}`（死 DTO 复活）；详见 `23-变更域三单据与工作台设计.md` |
| 8 | **潜伏的错误取数**（读面用错键，因当前数据恰好不撞而**一直没显形**） | `ChangeService.getEcr` 原实现 `ecoRepo.findById(e.getId())`——**拿 ECR 的 id 当 ECO 的主键**查；正确语义是"找 `ecr_id = 本 ECR` 的 ECO"。实测当前 id 区间 `eco 160..182` / `ecr 103..120` **未碰撞（0 命中）** ⇒ 潜伏；一旦碰撞，ECR 详情会回显**无关的** ECO 编号（**张冠李戴比空白更坏**：用户会照着错的单子去追变更） | 读面错误是最难抓的一类：**断言必须走读面**，不能只从 DB 侧证明"数据对"。触发点是本批记录的一条"走查漏网"——原 R9 只断言"ECR 存在 / 正文含编号 / 影响面挂在 ECR 上"（**全在 DB 侧**），**没走 ECR 读面** ⇒ 这类错误天然抓不到 | 改为按 `ecr_id` 查（单条与批量同口径，取最新一张）；新增读面断言 **R24**（`ecoCode` 取值正确 + 列表批量与单条一致） |
| 9 | **`updated_at` 从不推进**（"最近更新"列与"按更新起止筛选"从一建成就冻住） | `EcrEntity`/`EcoEntity` 的 `updated_at` 原是 `insertable=false, updatable=false`（只有 INSERT 时由 DB 默认值写一次），且本库**没有 `updated_at` 触发器**（既定口径是"更新列由应用层维护"）⇒ 一条今天刚初评的 ECR 在列表里仍显示建单日；`t_ecn` 连这一列都没有 | "时间列必须有人推进"是个**跨域不变量**（18 号文 §V 内容写留痕：**别假设 DB 自动维护时间戳**）。修法要落在**唯一出口**（实体生命周期钩子），而不是逐处 `setUpdatedAt(...)`——写点一多必漏 | 实体 `@PrePersist/@PreUpdate` 统一推进（与需求域 REQ-2026-2111 同口径）；`t_ecn` 由 V141 补列并按 `created_at` 回填（**不假装它们"刚被改过"**）；`riseCbbRev` 里绕过 JPA 写 `t_ecr` 的那条裸 SQL 也显式推进 |

---

*上游：《ipd-extension/01A-IPD业务对象模型》《01B-业务分层与异步开发专项设计》《02-§2.5 CBB 资产》。*
*裁定来源：`.creature/tasks/ipd-rd-management/cbb-review/decisions.md`（用户裁定 D-01~D-17）。*
*下一篇：[23 · 变更域三单据与工作台设计](23-变更域三单据与工作台设计.md)——ECR/ECO/ECN 为什么不是同一对象的三态、工作台如何承载、本批修掉的变更域缺陷。（原预留的"23 · 平台层与发布列车设计"顺延至 L3 落地时撰写。）*
