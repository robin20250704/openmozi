# 参考资料出处（PROVENANCE）

本目录下的 `plm-reverse-engineering/`（业务逻辑）与 `plm-tech/`（技术实现）由脚本
`scripts/sync-plm-references.mjs` 从外部文档仓**拷贝**而来，目的是让本 agent 的参考资料
自足（可独立部署打包），不依赖那台机器上的另一个仓库。

- 源目录：`D:\project\jcode\docs`
- 拷贝目标：`agents/tiangong/references/`
- 重新同步：`node scripts/sync-plm-references.mjs`；核对：`node scripts/sync-plm-references.mjs --check`

## 脱敏记录（拷贝与原件的唯一差异）

| 文件 | 处理 | 原因 |
| --- | --- | --- |
| `plm-tech/20-账户与密码管理设计.md` | /同一口令\s*`[^`\s]+`/g → 遮蔽 | 源文档含真实口令明文 |

> 原件（外部仓）仍含该口令明文，建议在源仓一并整改。

## 清单（sha256 前 16 位）

### plm-reverse-engineering/ — 39 个文件 / 275.5 KB

```
plm-reverse-engineering/business-rules/change-control-execution.md      4769B  sha256:52b86dcd57dc0092
plm-reverse-engineering/business-rules/change-control.md     10820B  sha256:d52913946991fb06
plm-reverse-engineering/business-rules/identity-and-concurrency.md      8349B  sha256:a4d3219e9be5e10e
plm-reverse-engineering/business-rules/item-and-bom-lifecycle.md     12122B  sha256:62cb3d425dc14d10
plm-reverse-engineering/business-rules/permissions-and-access.md      9073B  sha256:4318ac8a264fe94a
plm-reverse-engineering/business-rules/README.md      5570B  sha256:fb0bf3d0058aac96
plm-reverse-engineering/business-rules/review-gates.md     10156B  sha256:ef6508453281feda
plm-reverse-engineering/business-rules/review-sign-and-correction.md      3331B  sha256:1568ec3a0ccc0e35
plm-reverse-engineering/business-rules/workflow-and-approval.md      8805B  sha256:de00b43e8066e43c
plm-reverse-engineering/gaps.md      7353B  sha256:83f0fec373620dc9
plm-reverse-engineering/interfaces/harness-api-events.md      9860B  sha256:02411451b6470b9a
plm-reverse-engineering/interfaces/harness-api-requests.md      8193B  sha256:09c05b6b2693a544
plm-reverse-engineering/interfaces/harness-api-transport.md      2644B  sha256:5b8e58e7b6597173
plm-reverse-engineering/interfaces/plm-http-contract.md      7618B  sha256:62e3bffa6c967a2f
plm-reverse-engineering/interfaces/README.md      4025B  sha256:e1487ddb3d77e675
plm-reverse-engineering/interfaces/writers-guide.md      6585B  sha256:9b8c6a843e5a7340
plm-reverse-engineering/inventory/docs-guide-tree.md      9495B  sha256:8c05050167219427
plm-reverse-engineering/inventory/docs-tree.md      6490B  sha256:f50cb49aea534d81
plm-reverse-engineering/inventory/README.md      5673B  sha256:df691255a9be90a4
plm-reverse-engineering/inventory/top-level.md      6430B  sha256:681cd7037251c713
plm-reverse-engineering/ontology/entities-change-review.md      8074B  sha256:6c16b539842db44c
plm-reverse-engineering/ontology/entities-risk-pv.md      8098B  sha256:5e9f58314e8d44a4
plm-reverse-engineering/ontology/entities.md      6829B  sha256:0f7725cb26df0b35
plm-reverse-engineering/ontology/invariants-concurrency-access.md      6018B  sha256:11f55dac1c193d52
plm-reverse-engineering/ontology/invariants-values-guards.md      7189B  sha256:7fcd2ffb4a94d9f1
plm-reverse-engineering/ontology/invariants.md      6183B  sha256:7752cfb6566c9375
plm-reverse-engineering/ontology/README.md      6100B  sha256:dd3d9b4dd0c074a9
plm-reverse-engineering/ontology/state-machines-engine.md      4828B  sha256:ebdeacb5a4f27b1a
plm-reverse-engineering/ontology/state-machines.md      8180B  sha256:abf696ece20c0bee
plm-reverse-engineering/ontology/terms.md     11472B  sha256:fe2f3dd14fe449a2
plm-reverse-engineering/README.md      6133B  sha256:1781f89a7ad27299
plm-reverse-engineering/ui-gaps-dispelled.md      9266B  sha256:94e2dde67f4a4450
plm-reverse-engineering/ui-gaps-open-bom.md      4559B  sha256:73648f5e603ba024
plm-reverse-engineering/ui-gaps-open-domains.md      5601B  sha256:e274c2b6f9625f05
plm-reverse-engineering/ui-gaps-open-project.md      5418B  sha256:2bade2a964ae6f13
plm-reverse-engineering/ui-gaps-open-vocab-authority.md      6744B  sha256:2e84e282c6a582e1
plm-reverse-engineering/ui-gaps-open.md     10331B  sha256:7f609ea89862bc24
plm-reverse-engineering/ui-gaps-settled.md      7464B  sha256:d3a89a33a774e07d
plm-reverse-engineering/ui-logic-gap-analysis.md      6236B  sha256:0d0f41fd1200aaaa
```

### plm-tech/ — 51 个文件 / 1597.2 KB

```
plm-tech/01-技术选型决策.md     19042B  sha256:fda581c29c340f64
plm-tech/02-datagrid与电子表格方案.md     17715B  sha256:8aeab037608704eb
plm-tech/02b-表格前端业界实践.md     21802B  sha256:6bdd793f27742557
plm-tech/03-元数据驱动架构方案.md     18816B  sha256:d030886ef680e6db
plm-tech/04-AI-Agent融入方案.md     25411B  sha256:cca1922030e377c8
plm-tech/05-工作包拆解.md     12135B  sha256:ebae0854bde9293a
plm-tech/06-开发实施方案.md     16092B  sha256:ab6958d756e03903
plm-tech/07-环境差距分析.md     15676B  sha256:c8658521e8e31379
plm-tech/08-前端实现规格.md     22593B  sha256:6eac019e687c1013
plm-tech/09-工作流引擎与元数据扩展设计.md     76978B  sha256:b3dd977387ed7601
plm-tech/10-流程角色与任务分派设计.md     66009B  sha256:e88e9e75e6807e96
plm-tech/10-语义查重与AI查重服务设计.md     10966B  sha256:c4bfd31da5f60dd9
plm-tech/11-检索索引与全文检索引擎重构方案.md     23965B  sha256:240808ce09dab63d
plm-tech/12-产品级通用规格-评审机制与列表范式.md     36946B  sha256:a46e48cb4ef15ca9
plm-tech/13-产品级通用规格-工程门禁与数据对账机制.md     27829B  sha256:45489b81a2a4a50d
plm-tech/14-产品级通用规格-交付完整性-可复用构件与通用UI纪律.md     31111B  sha256:70421ff5aa9ebc03
plm-tech/15-交付物基线与实交付三态.md     15322B  sha256:fd1109b93de930ea
plm-tech/16-性能保障规格.md     46138B  sha256:119cf3bb321bb051
plm-tech/17-测试方法与测试代码规格.md     45588B  sha256:ec96f04eca613afb
plm-tech/18-接口契约与状态一致性规格.md     23121B  sha256:940a72413507d828
plm-tech/19-产品级通用规格-安全规格.md     26055B  sha256:8c494c31c957e85d
plm-tech/20-账户与密码管理设计.md     46639B  sha256:ece620c3f74f1ee5
plm-tech/21-治理台与权限治理设计.md     36960B  sha256:078f80d10f797521
plm-tech/22-CBB资产库业务逻辑与关系模型设计.md     76962B  sha256:2b99cc09683c983d
plm-tech/23-变更域三单据与工作台设计.md     30643B  sha256:9e6d8341a1c96438
plm-tech/24-工作台设计-面向人的个人工作汇聚.md     43077B  sha256:a0342483b16e9619
plm-tech/25-基于AI Agent的项目任务自动分解设计报告.md     56473B  sha256:1dc78f6179252180
plm-tech/26-项目目标与达成率设计.md     63010B  sha256:96d128a16092ade3
plm-tech/27-项目变更单设计.md     53100B  sha256:c788b7cfcf77cbaa
plm-tech/28-资金对象与币种换算设计.md     15302B  sha256:6751df48f0a59d81
plm-tech/29-任务交付物绑定与归集设计.md     17299B  sha256:45fd23d73c8599f1
plm-tech/30-BOM递归构建与三态版本对比设计.md     54247B  sha256:7d19a3ab9f676c13
plm-tech/31-BOM业务模型梳理.md     63098B  sha256:51872133394e4172
plm-tech/backup/02.pre-migration.md      9285B  sha256:68e02353362e9ac8
plm-tech/backup/06.pre-migration.md     27060B  sha256:e1d62237ebde434f
plm-tech/backup/08-appendix-B4-section.md     18007B  sha256:501c0297c44e9ac8
plm-tech/backup/08.pre-migration.md     30930B  sha256:83d7e5f4994bb855
plm-tech/backup/README.md      2280B  sha256:b4f20d49ea590fc1
plm-tech/frontend/01-design-tokens-shell-layout.md     36002B  sha256:bc4d341c234e7aba
plm-tech/frontend/02-datagrid-aggrid.md     36498B  sha256:bd13973f0771eb14
plm-tech/frontend/03-detail-panel.md     59681B  sha256:c59d69becf17948b
plm-tech/frontend/04-interactions-part1.md     42892B  sha256:754c147b7f4f1d8a
plm-tech/frontend/05-interactions-part2a.md     48348B  sha256:c89bff0306737b92
plm-tech/frontend/06-interactions-part2b.md     37852B  sha256:5c99b6e36f2b9e59
plm-tech/frontend/07-keyboard-conventions-gotchas-files.md     27365B  sha256:9cfcb52634c93de5
plm-tech/ipd-extension/01-现状盘点.md     12929B  sha256:1c5063a915ec68e4
plm-tech/ipd-extension/02-差距分析.md     13692B  sha256:2a9023a5a9879dde
plm-tech/ipd-extension/03-迭代重构演进方案.md     28469B  sha256:bb9bf829261787f5
plm-tech/ipd-extension/04-验收断言矩阵与风险.md      8980B  sha256:ae9ca5c5a4661da6
plm-tech/ipd-extension/README.md      2157B  sha256:9daeebb7ece47425
plm-tech/README.md     37052B  sha256:6c035228a270a642
```
