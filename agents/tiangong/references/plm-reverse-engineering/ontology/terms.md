# 术语表（ontology 树 · 声明层）

> 表头固定为 `| ID | 类型 | 定义 | 取值/状态 | 性质 | 保证 | → 指针 |`；`性质` ∈ {`contract` 树是承诺 / `as-built` 树是描述 / `planned` 尚无实现}，`保证` ∈ {`def:同指针` / `def:<路径>#<符号>` / `assert:<路径>::<用例>` / `gen:<路径>` / `TODO`}（口径见 `../README.md` §"怎么读" 第 5 条与 `.creature/tools/selfcheck.cjs` 的 `SAT_*` 常量）。
> **指针不许为空**：`保证=def:` 时指针必须是**完整路径 + 锚点**（裸文件名无法核实 ⇒ 等于假知识）。本片 37 条全部 `as-built`。

| ID | 类型 | 定义 | 取值/状态 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- |
| T-001 | 术语 | **ECR**（工程变更请求）：提出"要不要改"的单据，不含实施方案 | — | as-built | def:同指针 | → docs/plm-design#变更域 |
| T-002 | 术语 | **ECO**（工程变更指令）：ECR 获批后承载"改什么、怎么改、影响谁"的执行单据 | 见 R- 变更域分片 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java |
| T-003 | 术语 | **ECN**（工程变更通知）：ECO 落地后对外/对下游的知会件 | — | as-built | def:同指针 | → docs/plm-design#变更域 |
| T-004 | 术语 | **CCB**（变更控制委员会）：ECO 的审批组织；其结论取值与界面预置词**不是同一套**（别名关系见 T-005/T-006） | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#CCB_RESULTS |
| T-005 | 术语 | **CCB 结论（机读值）**：`APPROVED`（批准）/ `CONDITIONAL`（有条件批准）/ `REJECTED`（驳回） | APPROVED / CONDITIONAL / REJECTED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#CCB_RESULTS |
| T-006 | 术语 | **评估结论预置词（界面）**：`通过` / `有条件通过` / `不通过`。**别名**：与 T-005 是同一判定的两种写法（界面用中文、机读用英文枚举），**不要当成两个概念** | 通过 / 有条件通过 / 不通过 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#EVAL_CONCLUSION_PRESETS |
| T-007 | 术语 | **变更维度**：ECO 影响面的五个评估维度 | tech 技术 / reg 法规 / risk 风险 / vv 验证 / mfg 制造 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#DIMENSIONS |
| T-008 | 术语 | **变更分级**：ECO 的紧急与影响程度分类 | MINOR / MAJOR / REG / EMERGENCY | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#CHANGE_CLASSES |
| T-009 | 术语 | **受影响对象类型**：ECO 可以指向的版本化对象 | ITEM_REV 物料版本 / DOC_REV 文档版本 / BOM / REG 注册 / SOFTWARE 软件 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#AFFECTED_OBJ_TYPES |
| T-010 | 术语 | **受影响对象动作**：对受影响对象做什么 | REVISE 改版 / ADD 新增 / OBSOLETE 作废 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#AFFECTED_ACTIONS |
| T-011 | 术语 | **旧料处置方式**：变更生效后库存/在制品的处置 | USE_UP 用完 / SCRAP 报废 / REWORK 返工 / IMMEDIATE 立即停用 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#DISPOSE_TYPES |
| T-012 | 术语 | **PCO**（项目变更指令）：与 ECO 并列的另一条变更线，改的是项目四要素而非物料 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java |
| T-013 | 术语 | **PCO 类别**：PCO 改哪个项目要素 | GOAL 目标 / SCOPE 范围 / SCHEDULE 进度 / RESOURCE 资源 / BUDGET 预算 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#CLASSES |
| T-014 | 术语 | **PCO 未实现类别**：`RESOURCE` 明确不实现。**这是"明确说不做"，不是"还没填"** | RESOURCE | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#NOT_IMPLEMENTED_CLASSES |
| T-015 | 术语 | **PCO 状态**：PCO 单据的生命周期状态 | DRAFT / SUBMITTED / APPROVED / REJECTED / IMPLEMENTING / CLOSED / CANCELLED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#STATUSES |
| T-016 | 术语 | **PCO 在办状态集**：算"未了结"时用这一组，不是用"非 CLOSED"。⚠**它不含 `DRAFT`**（未提交本就不该影响门线），而 `STATUSES − {CLOSED,CANCELLED,REJECTED}` **含 `DRAFT`**——按补集算会多算一条。2026-10-05 常量由 `OPEN_STATUSES` 改名 `PENDING_CLOSURE`（旧名名不副实，取值未变） | SUBMITTED / APPROVED / IMPLEMENTING | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#PENDING_CLOSURE |
| T-017 | 术语 | **PCO 批准人**：类别 → 批准人角色码（目标/范围/预算 → IPMT 主任；进度/资源 → PDT 经理） | 见取值列 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#APPROVER_BY_CLASS |
| T-018 | 术语 | **IPMT 主任**：产品线投资决策层角色，批复目标/范围/预算类变更 | ipmt_chair | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#APPROVER_BY_CLASS |
| T-019 | 术语 | **PDT 经理**：产品开发团队负责人，批复进度/资源类变更 | pdt_manager | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#APPROVER_BY_CLASS |
| T-020 | 术语 | **项目阶段**：交付物名称前缀即阶段名（`[立项] xxx`） | 立项 / 概念 / 计划 / 开发 / 验证 / 注册申报 / 设计转换 / 上市 / 维护 / 退市 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/project/ProjectStages.java#ALL |
| T-021 | 术语 | **DCP**（决策评审点）：阶段门评审类型之一 | 见 T-022 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#TYPE_DCP |
| T-022 | 术语 | **TR**（技术评审）：与 DCP 并列的评审类型；**两者的合法结论集不同**，不可混用 | 见 T-023 / T-024 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#TYPE_TR |
| T-023 | 术语 | **DCP 合法结论**：DCP 评审允许给出的全部结论（含"不推进"两种） | GO / GO_WITH_RISK / TERMINATE / REDIRECT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#DCP_LEGAL |
| T-024 | 术语 | **TR 合法结论**：TR 评审允许给出的全部结论 | PASS / COND / FAIL | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#TR_LEGAL |
| T-025 | 术语 | **"评审通过"（DCP 口径）**：**只有 GO 与 GO_WITH_RISK 算通过**。别名/易错点：`TERMINATE`、`REDIRECT` 是**合法结论但不是"已通过"**——把"有结论"当成"通过了"是实测发生过的漂移 | GO / GO_WITH_RISK | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#DCP_OK |
| T-026 | 术语 | **"评审通过"（TR 口径）**：TR 的通过集与 DCP 不同 | PASS / COND | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#TR_OK |
| T-027 | 术语 | **"有条件通过"**：DCP 的 `GO_WITH_RISK` 与 TR 的 `COND` 的合称；跨类型判定统一用这一组 | GO_WITH_RISK / COND | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#COND |
| T-028 | 术语 | **BOM**（物料清单）：产品结构的版本化表达 | — | as-built | def:同指针 | → docs/plm-tech |
| T-029 | 术语 | **EBOM**（设计 BOM）：由设计侧定义的产品结构 | — | as-built | def:同指针 | → docs/plm-tech |
| T-030 | 术语 | **MBOM**（制造 BOM）：由工艺/制造侧定义、含工艺合件与工装的结构；**与 EBOM 不是同一棵树，转换有损** | — | as-built | def:同指针 | → docs/plm-tech |
| T-031 | 术语 | **PDR**（初步设计评审）：见 T-022 的 TR 族 | — | as-built | def:同指针 | → docs/plm-design |
| T-032 | 术语 | **基线（baseline）**：被冻结、不可原地修改的版本集合；改动必须走 ECO | — | as-built | def:同指针 | → docs/plm-design#基线 |
| T-033 | 术语 | **逻辑 ID / 版本号**：同一性由逻辑 ID 表达，版本号只表达"第几版"。⚠**"引用一律用逻辑 ID + 版本"不是全平台强制**：DB 层**只有 `ITEM_REV` 被 CHECK 钉住**，`DOC_REV`/`RISK_CTRL`/`ECO` 等无 DB 约束（本库口径是"业务引用不靠 DB 外键守"，靠应用层 + 对账脚本） | `PLM:<TYPE>:<CODE>[#<REV>]` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V107__req-trace-item-rev-guard.sql#t_req_trace |
| T-034 | 术语 | **乐观并发版本**：并发写保护用的版本计数，与业务版本号 T-033 是**两个不同的东西**。⚠**载体有两种**：`@Version` **只有 3 个实体**（ECO / 产品包 / 注册证），其余 13 域走 `OptimisticLock.require` + `AND version = ?` 手拼栅栏——语义一致、载体不同 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#VERSION_GUARD |
| T-035 | 术语 | **/enums 端点**：把值域与显示词一并下发，**界面下拉与后端判定同源**（这是值域漂移的既有解法） | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoVocabulary.java#enums |
| T-036 | 术语 | **虚拟件**（**弃用名/别名**，正名 = T-037「互替组」）：2026-10-05 用户裁定「虚拟件、互替组是同一个概念，统一为互替组 ⇒ 换到底」，`t_item.item_class` 该值已改名（V210）。⚠**最易搞错**：采购类型档位 `PHANTOM` 的显示名**仍叫「虚拟件」**，是**另一样东西**（见 V-023）。旧定义：`item_class='虚拟件'` 的一行是"这里可以换"的**占位身份**，不是实物类别 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/item/SubstituteService.java#SUBSTITUTE_GROUP_CLASS |
| T-037 | 术语 | **互替组**：可互相顶替的**真实物料** + 优先级（主选 = 1）。**组就是那颗 `item_class='互替组'` 的行**（组编号 = 其 `item_code`，成员落 `t_item_substitute`），属主数据、独立于 BOM；与 T-036 是**同一概念**。建组 = 建这颗行 + 加成员；该行 `make_buy` 由服务端**强制**为 `SUBSTITUTE`（与采购类型 `PHANTOM` 无关）；0 成员 = 未解析（按 0 计） | 优先级 `1..N`（组内唯一）；`make_buy` 恒 `SUBSTITUTE` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/item/SubstituteService.java#createGroup |