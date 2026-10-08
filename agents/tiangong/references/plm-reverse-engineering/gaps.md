# 四棵标准树的缺口与债（gaps）

> 从 `README.md` 搬出（2026-10-05 第三轮）：入口 README 有 **≤6 KB** 上限，而缺口清单只增不减。
> **纪律：缺口必须可数。**「留白」证明不了缺口被看到，「TODO」能。

## ① 已清掉的（留作对照，不删）

| 曾经 | 现状 |
| --- | --- |
| `ontology/` 只落地 `terms.md` | ✅ `entities` / `state-machines` / `invariants` 三类全部落地（**+134 条**：E-001~E-051 / S-001~S-033 / V-001~V-050） |
| `business-rules/change-control.md` 13 199 B 超限 | ✅ 按业务域拆两片；`review-gates.md` 加两列后超限 ⇒ 也拆两片 |
| **276 条**声明缺「性质/保证」两列 | ✅ 全树补齐（现 547 条中 0 条缺列） |
| `inventory/` 93 行指针为空 | ✅ 补 `→ 指针` 列，88 条指到可机械核对的落点，5 条写 `TODO` |
| `interfaces/` 只讲 Harness、PLM 接口面无处可查 | ✅ 第三轮补 `plm-http-contract.md`（I-081~I-095），并说清本树**两个主体** |
| `interfaces/README.md` 7 487 B / 根 `README.md` 7 124 B 双双超 6 KB | ✅ 第三轮按域拆出本文件与 `interfaces/writers-guide.md`（**拆的是文件，不是把字写短**） |
| 4 处**已落地声明失效**（T-033/T-034/T-036、inventory D-016/D-024/D-045） | ✅ 已改正 |
| 3 处引用**不存在**的 `creature-标准树编写规范.md` | ✅ 第三轮全部改为指向真实出处（本目录 §"怎么读" + `selfcheck.cjs` 的 `SAT_*` 常量） |
| `t_product.status` 有第二套词表（英文 `ACTIVE`）；`t_project` 双列口径未定 | ✅ 第三轮收口：V212（CHECK + 触发器 + 存量归位）+ V213（删除夹具行），见 `../.creature/tasks/plm-reverse-engineering-complete/conflict-resolution.md` |

## ② 仍未清掉的（可数）

| # | 债 | 量 | 收敛路径 |
| --- | --- | --- | --- |
| 1 | `interfaces` 的 `contract` 行断言未写 | **76 条** `assert: TODO` | 一份 **golden NDJSON 夹具**（把一次完整会话的请求/回帧序列固化，跑真实桥接进程比对）可**一次覆盖 I-011~I-080**；详见 `interfaces/gaps.md` §① |
| 2 | 待做分片 | **11 个已登记** | `interfaces` 5（daemon-wire / swarm-comm / cli / ts-sdk / plm-mcp）｜`business-rules` 3（field-and-format / notification-and-audit / integration-boundary）｜`inventory` 3（code-tree / infra-tree / tooling-tree） |
| 3 | 权威文档树未进 `inventory` | **4 棵** | `ipd/deploy/wsl/plm-app`、`ipd/deploy/uat`、`ipd/knowledge`、`ipd/agents`。补齐 `inventory` 三片后，此后**新增**的文档会按 P2 报出（机制启用前的旧文档不追补，理由：消不掉的告警会训练出忽略告警） |
| 4 | `invariants` 有守卫但无回归兜底 | **11 条**「机械断言 = 无」 | 集中在 BOM 冻结锁、REGBOM 禁占位件、幂等键唯一性；`无` 是**可数**的债，假测试名不可数 |
| 5 | `inventory` 根级散文只能指到目录 | **5 条** `TODO` | 写一条 `scripts/check-inventory.cjs`（读每行 → 断言路径与入口在盘上存在）后即可指到文件级并清掉这 5 条 |

## ③ 已登记的实现内在冲突

**26 条**（C-001~C-026）+ **4 条覆盖缺口**（F-001~F-004），登记与处置逐条见
`.creature/tasks/plm-reverse-engineering-complete/conflicts.md` 与 `conflict-resolution.md`。

2026-10-05 第三轮把最后 3 条未收口的**全部收口**（用户逐条拍板）：

| 条 | 裁定 | 落地 |
| --- | --- | --- |
| `C-009` `t_pipeline_snapshot` 补列 vs 作废 V32 意图 | **作废 V32 的意图**（真身 = V23 形态的 `metrics` jsonb） | V212 ③：登记列注释，明写"不要再提补列的迁移" |
| `C-010` `t_project` 双列口径 | **id 权威 + 加对账断言** | V212 ②：CHECK + 触发器 + 改名守卫（R-185/R-186） |
| `C-026` `t_product.status` 两套词表 | **迁移成中文态 + 加 CHECK**，并**删掉测试夹具行** | V212 ①（CHECK `ck_product_status_vocab` + 存量归位）+ V213（删除），根因是夹具已修 |

2026-10-05 第四轮（任务 `plm-ui-logic-gap-analysis`）**只登记、不改代码**（D-6），新增 3 条冲突 + 1 条缺口：

| 条 | 摘要 | 性质 |
| --- | --- | --- |
| `C-028` | 项目页**同一文件内**并存两套生命周期词表（`:1330` 硬编码 vs `:192` 的 `useFlow('project')`） | 前端 1 行可解，零新增请求 |
| `C-029` | TDP 产出页漏落实「终态从服务端读」裁定（`PipelineLifecyclePage` 已改、`TdpOutputsPage` 未改） | 端点已存在，属整改补漏 |
| `C-030` | `/enums` 值域同源只覆盖变更/售后五域，8 个核心模块仍前端硬编码 | 结构性风险；`V72→V73` 是已发生的前车之鉴 |
| `G-001` | BOM 递归展开能力只用于**查看**、未接**创建**路径（30 号文 1-A 面包屑只缓解未除根因） | 缺口，非冲突 |

**本轮最大的产出不是这 4 条缺陷，而是 8 条"已收敛·不要重复报"**（DCP0 GO 原子性、
任务书 JSONB 整写披露、财务脱敏只读、虚拟件/互替组改名、`ACTIVE→概念`、BOM 409 通道、
V212 产品线约束无 UI 出口、项目生命周期三处词表）——见
[`ui-gaps-settled.md`](ui-gaps-settled.md)。本仓 2026-09~10 整改密集，
**任何后续审计若不提先读该节，大概率重复报已完成项。**

**覆盖度（2026-10-05 第二轮已结清）**：8 个模块**已全部取证**——需求管理/文档管理/计划任务
的深扫由主代理内联完成（subagent 通道本会话 12/12 崩溃，整读 60–192 KB TSX 会耗尽子代理上下文）。
产出 **1 条新冲突 MSG-01**（「里程碑」一词二义）+ **10 条证否**。
防误报清单已分两册： [`ui-gaps-settled.md`](ui-gaps-settled.md)（8 条）、
[`ui-gaps-dispelled.md`](ui-gaps-dispelled.md)（10 条）。
未结清残余 7 项见 `ui-gaps-settled.md` §二。深扫方法见 §三。

## ④ 两条方法学债（写给下一个作者）

1. **扫描脚本必须认 Markdown 的 `\|` 转义。** 2026-10-05 第三轮，我的一份扫描脚本因为没认它，
   报出"2 个分片列数混杂 + 3 条死指针"——独立复核后**全是假告警**（脚本错位读了相邻单元格）。
   **假告警和最危险的缺陷长得很像**：都带着看起来对得上的定位与数字。
   判据：报出问题后，**先用另一条独立路径复核那一条**，再决定改不改文档
   （本次用的是 `.creature/tasks/plm-reverse-engineering-complete/verify-pointers.cjs`）。
2. **"约束在守"与"死约束"是两回事 —— 只加约束不加出口，会把人逼去 `DROP CONSTRAINT`。**
   第三轮给 `t_project` 双列加约束时踩过：`CHECK` 禁子查询 ⇒ 跨表那条只能用触发器；
   而"项目 TEXT 必须等于产品线名"这条不变量在**跨表改名**时**没有任何一个语句边界能满足**
   ——两条触发器合起来等于**把"产品线改名"这个业务动作彻底禁掉**。
   正解是给维护窗口（同事务内 `DISABLE TRIGGER` → 跨表同改 → `ENABLE`，并在事务内自证已一致），
   由探针 P9/P10/P10b 三条一起证明"拦得住分叉"且"路径没被写死"。
   **判据**：每条新约束都要配一条"**合法动作仍能做**"的探针；只有"非法被拒"的探针证明不了这件事。
