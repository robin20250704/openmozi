# 分片：plm-design 与 plm-user-guide 文档树（docs-guide-tree）

> 登记 `docs/plm-design` 24 篇（逐篇）与 `docs/plm-user-guide` 23 篇（按章节块成组）。
> `docs/` 一级子目录与 `docs/plm-tech` 分篇登记在同目录 `docs-tree.md`。
> 末列写法 `<树名>:<该事实当前权威落点>`；三树尚未落盘时只写现有权威文件，不杜撰 ID。
> **`→ 指针` 列**：散文条目指向其**所在目录**（目录存在可机械核对，文件名在「入口」列）——见 `inventory/README.md` §③.6。

## C. docs/plm-design 分篇登记（24 篇，逐篇）

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-062 | docs/plm-design/01-业务架构设计.md | 业务域划分与端到端链路：系统管哪几件事 | 人 | 01-业务架构设计.md | ontology:PLM 业务域 | as-built | def:同指针 | → docs/plm-design/ |
| D-063 | docs/plm-design/02-信息架构设计.md | 角色×场景的信息地图与页面清单 | 人 | 02-信息架构设计.md | ontology:信息架构 | as-built | def:同指针 | → docs/plm-design/ |
| D-064 | docs/plm-design/03-用户旅程设计.md | 端到端用户旅程与关键分叉点 | 人 | 03-用户旅程设计.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-065 | docs/plm-design/04-应用架构设计.md | 应用分层、模块职责与依赖方向 | 人 | 04-应用架构设计.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-066 | docs/plm-design/05-技术架构设计.md | 技术栈、部署拓扑与选型落点 | 人 | 05-技术架构设计.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-067 | docs/plm-design/06-权限模型设计.md | BAC 角色 + ABAC 对象实例 ACL 的混合模型 | 人 | 06-权限模型设计.md | business-rules:权限判定 | as-built | def:同指针 | → docs/plm-design/ |
| D-068 | docs/plm-design/12-产品包与服务设计.md | Offering/Service 定义、生命周期与服务契约 | 人 | 12-产品包与服务设计.md | ontology:Offering | as-built | def:同指针 | → docs/plm-design/ |
| D-069 | docs/plm-design/13-UI设计走查-需求物料项目文档四模块.md | 需求/物料/项目/文档四模块的 UI 走查问题清单 | 人 | 13-UI设计走查-需求物料项目文档四模块.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-070 | docs/plm-design/14-UI设计走查-变更CBB上市后注册产品包风险治理台.md | 变更/CBB/上市后/注册/产品包/风险台 UI 走查清单 | 人 | 14-UI设计走查-变更CBB上市后注册产品包风险治理台.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-071 | docs/plm-design/15-需求买点与产品定义买点视图设计.md | 需求 APPEALS 买点与产品定义买点视图定义 | 人 | 15-需求买点与产品定义买点视图设计.md | ontology:买点 | as-built | def:同指针 | → docs/plm-design/ |
| D-072 | docs/plm-design/README.md | 目录索引，说明各篇先后阅读顺序 | 人 | README.md | — | as-built | def:同指针 | → docs/plm-design/ |
| D-073 | docs/plm-design/ipd-extension/01-IPD业务架构扩展设计.md | 把 IPD 业务域并入 PLM 业务架构 | 人 | 01-IPD业务架构扩展设计.md | ontology:IPD 业务域 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-074 | docs/plm-design/ipd-extension/01A-IPD业务对象模型.md | 一个 IPD 项目由哪些对象构成及其关系 | 人 | 01A-IPD业务对象模型.md | ontology:IPD 业务对象 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-075 | docs/plm-design/ipd-extension/01B-业务分层与异步开发专项设计.md | 业务分层与跨部门异步开发协同约定 | 人 | 01B-业务分层与异步开发专项设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-076 | docs/plm-design/ipd-extension/01C-需求与买点量化评估体系.md | 需求与买点的量化评估公式 | 人 | 01C-需求与买点量化评估体系.md | business-rules:买点量化 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-077 | docs/plm-design/ipd-extension/01D-证据供应链与产品定义指引体系.md | 结论须挂证据的追溯规则 | 人 | 01D-证据供应链与产品定义指引体系.md | business-rules:证据可追溯 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-078 | docs/plm-design/ipd-extension/01E-文档对象关联模型设计.md | 文档对象与业务对象的关联模型 | 人 | 01E-文档对象关联模型设计.md | ontology:文档对象 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-079 | docs/plm-design/ipd-extension/01F-软件族评审清单模板设计.md | 软件族评审清单模板 | 人 | 01F-软件族评审清单模板设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-080 | docs/plm-design/ipd-extension/02-IPD信息架构扩展设计.md | IPD 场景下的信息架构与页面扩展 | 人 | 02-IPD信息架构扩展设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-081 | docs/plm-design/ipd-extension/03-IPD用户旅程扩展设计.md | 市场/研发/服务角色的旅程扩展 | 人 | 03-IPD用户旅程扩展设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-082 | docs/plm-design/ipd-extension/04-IPD应用架构扩展设计.md | IPD 能力的应用层落点与服务划分 | 人 | 04-IPD应用架构扩展设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-083 | docs/plm-design/ipd-extension/05-IPD技术架构扩展设计.md | IPD 技术架构扩展与集成方式 | 人 | 05-IPD技术架构扩展设计.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-084 | docs/plm-design/ipd-extension/06-IPD权限模型设计.md | IPD 角色与权限的扩展规则 | 人 | 06-IPD权限模型设计.md | business-rules:IPD 权限 | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |
| D-085 | docs/plm-design/ipd-extension/README.md | ipd-extension 子集索引（定稿 v1.0） | 人 | README.md | — | as-built | def:同指针 | → docs/plm-design/ipd-extension/ |

## A. docs/plm-user-guide 分篇登记（23 篇，按章节块成组）

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-086 | docs/plm-user-guide/README.md | 手册总入口与阅读顺序 | 人 | README.md | — | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-087 | docs/plm-user-guide/00~01（2 篇） | 手册导航与术语速查；登录到首个会话的最短路径 | 人 | 01-快速入门.md | — | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-088 | docs/plm-user-guide/02~03（2 篇） | 需求录入/查重/状态流转；项目立项与评审门通过条件 | 人 | 03-项目管理与评审门.md | business-rules:评审门 | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-089 | docs/plm-user-guide/04~06（3 篇） | 产品与结构建模、物料建档检索、BOM 编辑与版本对比 | 人 | 05-物料库.md | ontology:物料 | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-090 | docs/plm-user-guide/07~10（4 篇） | ECR/ECO/ECN 流转、文档中心、注册法规、权限分配操作 | 人 | 07-工程变更.md | ontology:变更单据 | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-091 | docs/plm-user-guide/11~14（4 篇） | 任务书工作台、Offering 产品包、投诉/CAPA/召回、风险台与规则 | 人 | 14-风险台账与风险规则.md | business-rules:风险规则 | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-092 | docs/plm-user-guide/15~18（4 篇） | IPD 工作台治理、目标达成率看板、角色闭环排障、甘特编排 | 人 | 15-IPD工作台与治理.md | — | as-built | def:同指针 | → docs/plm-user-guide/ |
| D-093 | docs/plm-user-guide/附录A~C（3 篇） | 快捷键与 FAQ、字段与枚举速查、已知偏差与限制 | 人 | 附录B-字段与枚举速查.md | ontology:字段枚举 | as-built | def:同指针 | → docs/plm-user-guide/ |

## B. 标准树自身的非分片文件（2026-10-05 第三轮新增）

> 这两份**不是声明分片**（表头不同、不含声明行），是"地图与债务清单"；登记它们是为了让
> 「清单没列 = 不存在」这个假设不成立 —— 否则下一个作者会以为 `gaps.md` 是野文件。

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-094 | docs/plm-reverse-engineering/gaps.md | 四棵标准树**缺口与债的唯一清单**（从根 README 拆出：入口 README 有 ≤6 KB 上限而缺口只增不减）；含"缺口必须可数"与两条方法学债 | 工作技能 | gaps.md | — | as-built | def:同指针 | → docs/plm-reverse-engineering/ |
| D-095 | docs/plm-reverse-engineering/interfaces/writers-guide.md | 接口树写入纪律 11 条 + 冲突裁决 + 缺口表 + **76 条 `assert: TODO` 的收敛路径** + 两条踩过的坑（引用不存在的规范、`\|` 转义导致的假告警） | 工作技能 | writers-guide.md | interfaces:I-001~I-095 | as-built | def:同指针 | → docs/plm-reverse-engineering/interfaces/ |

