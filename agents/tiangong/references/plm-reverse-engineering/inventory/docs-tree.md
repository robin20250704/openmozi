# 分片：docs/ 目录树（docs-tree）

> 登记 `docs/` 下 13 个一级子目录，以及 `docs/plm-tech` 51 篇分篇登记。
> **`docs/plm-design` 24 篇与 `docs/plm-user-guide` 23 篇已拆到同目录 `docs-guide-tree.md`**（本片原为单片，加「性质/保证」两列后超 12 288 B 上限）。
> `docs/` 根 63 篇散文档与 `plm-reflection` / `plans` / `audits` 等的逐篇登记见后续分片。
> 末列写法 `<树名>:<该事实当前权威落点>`；三树尚未落盘时只写现有权威文件，不杜撰 ID。
> **`→ 指针` 列**：散文条目指向其**所在目录**（目录存在可机械核对，文件名在「入口」列）——见 `inventory/README.md` §③.6。

## A. docs/ 一级子目录（实际 13 个）

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-038 | docs/audits | 对已实现代码的审计结论：能力、质量、provider 目录符合性 | agent | claude-opus-5-capability-audit.md | — | as-built | def:同指针 | → docs/audits/ |
| D-039 | docs/dev | 开发期契约规格：账户测试向量、账户流隐私、拆 crate 计划 | agent | ACCOUNT_CONTRACT_CONFORMANCE_TESTS.md | business-rules:账户契约 | as-built | def:同指针 | → docs/dev/ |
| D-040 | docs/discovery-baselines | Discovery 基准的 JSON 前后快照，供 benchmark 比对回归 | 生成器 | claude-fable-5-before.json | — | as-built | def:同指针 | → docs/discovery-baselines/ |
| D-041 | docs/images | README 引用的架构配图与 star-history 图 | 人 | memory-arch.png | — | as-built | def:同指针 | → docs/images/ |
| D-042 | docs/plans | 改造计划书：编译性能、代码质量、桌面端建设、服务拆分 | agent | CODE_QUALITY_TODO.md | — | as-built | def:同指针 | → docs/plans/ |
| D-043 | docs/plm-design | PLM 六层设计（业务/信息/旅程/应用/技术/权限）+ IPD 扩展 | 人 | plm-design/README.md | ontology:PLM 业务域 | as-built | def:同指针 | → docs/plm-design/ |
| D-044 | docs/plm-reflection | 把历史诉求反推成审查规则的证据层：语料、分类、候选规则 | agent | plm-review-rules.md | business-rules:PLM 审查规则 | as-built | def:同指针 | → docs/plm-reflection/ |
| D-045 | docs/plm-reverse-engineering | 逆向工程工作区：四棵标准树的**声明层**（接口/本体/业务规则/目录清单）——本树自身 | agent | inventory/README.md | — | as-built | def:同指针 | → docs/plm-reverse-engineering/ |
| D-046 | docs/plm-tech | 技术选型与产品级通用规格：元数据、工作流、门禁、安全 | 人 | plm-tech/README.md | business-rules:产品级通用规格 | as-built | def:同指针 | → docs/plm-tech/ |
| D-047 | docs/plm-uat | UAT 原始输入：需求整理稿、问题清单 csv/xlsx、操作手册原件 | 外部系统 | PLM第一轮UAT需求整理.9.24.md | — | as-built | def:同指针 | → docs/plm-uat/ |
| D-048 | docs/plm-ui-prototypes | UI 原型全集：10 模块 SVG、7 旅程 SVG、评审 PDF 与 rar | 人 | plm-ui-prototypes/README.md | — | as-built | def:同指针 | → docs/plm-ui-prototypes/ |
| D-049 | docs/plm-user-guide | 面向用户的手册：19 章操作说明 + 3 附录 + 同名 PDF | 人 | plm-user-guide/README.md | — | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-050 | docs/proposals | 未落地提案：macOS computer 工具、跨设备 worktree 同步 | 人 | computer-use-tool.md | — | as-built | def:同指针 | → docs/proposals/ |

## B. docs/plm-tech 分篇登记（51 篇 = 根 33 + frontend 7 + backup 5 + ipd-extension 5，2026-10 实测）

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-051 | docs/plm-tech/01~02b（3 篇） | 技术选型决策与表格方案业界调研，给出落地选型 | 人 | 01-技术选型决策.md | — | as-built | def:同指针 | → docs/plm-tech/ |
| D-052 | docs/plm-tech/03~04（2 篇） | 元数据驱动架构与 AI Agent 融入方案，定义可配置骨架 | 人 | 03-元数据驱动架构方案.md | ontology:元数据模型 | as-built | def:同指针 | → docs/plm-tech/ |
| D-053 | docs/plm-tech/05~07（3 篇） | 工作包拆解、开发实施方案、WSL 测试环境差距分析 | 人 | 05-工作包拆解.md | — | as-built | def:同指针 | → docs/plm-tech/ |
| D-054 | docs/plm-tech/08~11（5 篇） | 前端规格与工作流引擎、语义查重、检索索引方案 | 人 | 09-工作流引擎与元数据扩展设计.md | interfaces:工作流引擎 | as-built | def:同指针 | → docs/plm-tech/ |
| D-055 | docs/plm-tech/12~14（3 篇） | 通用规格：评审与列表范式、工程门禁与对账、交付完整性 | 人 | 13-产品级通用规格-工程门禁与数据对账机制.md | business-rules:工程门禁 | as-built | def:同指针 | → docs/plm-tech/ |
| D-056 | docs/plm-tech/15~19（5 篇） | 交付物三态、性能、测试方法、接口契约与状态一致性、安全 | 人 | 18-接口契约与状态一致性规格.md | business-rules:交付完整性 | as-built | def:同指针 | → docs/plm-tech/ |
| D-057 | docs/plm-tech/20~23（4 篇） | 账户与密码、治理台权限、CBB 资产库、变更三单据 ECR/ECO/ECN | 人 | 22-CBB资产库业务逻辑与关系模型设计.md | ontology:CBB 资产 | as-built | def:同指针 | → docs/plm-tech/ |
| D-058 | docs/plm-tech/24~31+README（9 篇） | 工作台、项目达成率、PCO、资金币种、任务交付物、BOM 模型 | 人 | 30-BOM递归构建与三态版本对比设计.md | ontology:BOM 模型 | as-built | def:同指针 | → docs/plm-tech/ |
| D-059 | docs/plm-tech/frontend/（7 篇） | 前端规格现行正文：设计令牌、AG Grid、详情面板、交互、键盘约定 | 人 | 01-design-tokens-shell-layout.md | interfaces:前端数据网格 | as-built | def:同指针 | → docs/plm-tech/frontend/ |
| D-060 | docs/plm-tech/backup/（5 篇） | 前端规格迁移前的旧版快照，2026-09-26 冻结，仅供追溯 | 人 | backup/README.md | — | as-built | def:同指针 | → docs/plm-tech/backup/ |
| D-061 | docs/plm-tech/ipd-extension/（5 篇） | IPD 现状盘点、差距分析、迭代重构方案、验收断言矩阵 | agent | 03-迭代重构演进方案.md | — | as-built | def:同指针 | → docs/plm-tech/ipd-extension/ |

