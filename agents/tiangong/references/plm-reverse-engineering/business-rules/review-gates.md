# 评审门与结论口径（review-gates）

> 本片声明评审域的**判据与口径**：启动守卫、门序、结论值域、条件文本、定论 WORM、判定资格（主席签署 / 否决 / 评议 / 指派）。
> **签署与作废、受控订正通道、阶段守卫已拆到同目录 `review-sign-and-correction.md`**（本片原为单片，加「性质/保证」两列后超 12 288 B 上限）。
> 评审门与阶段机的映射关系属 `ontology` 树；接口签名属 `interfaces` 树。
> 设计口径见 `→ docs/plm-tech/12-产品级通用规格-评审机制与列表范式.md#2. 评审机制通用规格（G-REV）`。
> 证据级别：全部 `有代码校验`（抛点行号已核实）。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- |
| R-073 | `t_gate_map` 表为空（V24 种子缺失）→ 启动即抛 `BizException("t_gate_map 为空")` | 无 | 服务拒绝启动 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateMapService.java#load` |
| R-074 | 门点字典 `seq` 非严格全序（存在并列）→ 启动即抛 `GATE_MAP_INCONSISTENT`，拒绝启动 | 无 | 并列会让"前序门"判据漏掉同轮的门；数据是门序唯一事实源 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateMapService.java#load` |
| R-075 | 请求门 G（`t_gate_map.seq = s`）时，同项目**所有 `seq < s` 的门**都必须已有至少一条 `status='DECIDED'` 的评审，否则 400 `GATE_ORDER_VIOLATION` | 无 override 通道；`t_gate_map` 未登记的门码不参与比较 | 跳门被拒；未登记门码无从判断先后 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateOrderGuard.java#assertSatisfied` |
| R-076 | 门序"已定论"= 该门存在**任意一条** DECIDED 行，**不**按链尾 `superseded_by_id IS NULL` 过滤 | 无 | 问的是"这道门做过决定"这一历史事实 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateOrderGuard.java#missingPriorGates` |
| R-077 | 门序守卫必须**先于**机器预检执行；预检只判本门自身完备性 | 无 | 若放在预检之后，调用方先收到"缺 3 份证据"这类与真因无关的提示 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertPriorGatesDecided` |
| R-078 | 本 TR 阻断的目标 DCP 已放行（DECIDED 且结论 GO/GO_WITH_RISK 且链尾）→ 400 `GATE_ORDER_VIOLATION`；带 `lateRequestReason`（≥8 字）可 override 并写审计 `review.late_request_override` | override 后**必须闭环**本次产生的条件使门重新转绿 | 事后污染被拒：补开会把该门已生效判据拉红 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertGateOrder` |
| R-079 | DCP 结论不在 `GO`/`GO_WITH_RISK`/`TERMINATE`/`REDIRECT` → 拒 400「非法结论」 | 无 | 非法结论被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#DCP_LEGAL` |
| R-080 | TR 结论不在 `PASS`/`COND`/`FAIL` → 拒 400「非法结论」 | 无 | 非法结论被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#TR_LEGAL` |
| R-081 | 放行结论集合 = DCP `{GO,GO_WITH_RISK}` ∪ TR `{PASS,COND}`；有条件通过集合 = `{GO_WITH_RISK, COND}` | 无 | 判定"是否放行"必须读这两组，不得就地硬编第三份 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#ALL_OK` |
| R-082 | 结论为 `GO_WITH_RISK` 或 `COND` → 必须给出条件意见（`conditions[]` 或 `conditionNote`），否则 400 `COND_NOTE_REQUIRED` | 无 | 有条件通过不得无条件落库 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#decideChecks` |
| R-083 | 条件文本命中占位黑名单（`1`/`12`/`123`/`1234`/`abc`/`qwe`/`test data`/`占位`/`测试`/`测试条件`/`待定`/`无`/`暂无`）或全为 `x`/`X` → 400 `TEXT_NOT_SUBSTANTIVE` | 无（null/空白直接放行） | 判定是 WORM，事后只能另开订正，不得写占位 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertSubstantive` |
| R-084 | `conditionNote` 或 `conditions[].note` trim 后 <6 字 → 400 `TEXT_TOO_SHORT` | 仅数组形式逐条判内容；单值 `conditionNote` 要求最小长度 | 过短条件被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertSubstantive` |
| R-085 | 评审已是 `DECIDED` → 再判定 400 `REVIEW_ALREADY_DECIDED`（定论即 WORM，生效记录只增不改） | 无 | 静默改判被堵；改判须新发起一次决策评审 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#decideChecks` |
| R-086 | 勾选"签署并记录结论"但当前身份非该 `reviewType` 的主席 → 403 `FORBIDDEN`（DCP=IPMT 主任；TR=技术评审主席） | 无 | 越权合并签署被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertMergedSignAllowed` |
| R-087 | 需要主席签署且本次未签署 → 400 `SIGNER_REQUIRED` | `source='LEGACY'` 的评审跳过此守卫 | 未签署不得判定 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertDecidableNow` |
| R-088 | 存在未解除（ACTIVE）的否决票 → 400 `VETO_PENDING` | 无 | 未解除否决不得签署或记录结论 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertDecidableNow` |
| R-089 | `is_mandatory=TRUE` 的评审项仍有 `conclusion IS NULL` → 400 `MANDATORY_ITEMS_PENDING` | 请求带 escape 时跳过 | 强制项未判完不得定论 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertDecidableNow` |
| R-090 | 判定评审项时，当前用户角色不在该项 `judge_role` 的允许角色集内 → 403 `JUDGE_ROLE_DENIED` | `admin` 豁免 | 越权判定被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/JudgeRoleMatrix.java#allowed` |
| R-091 | 评审项 `judge_role` → 允许角色集为唯一矩阵（如 `ipmt`→`{ipmt_chair,ipmt,ipmt_rep}`；`medical`/`ra`/`clinical`→`{ra}`；`manufacturing`/`process`/`mfg`→`{pdt_mfg}`） | `admin` 全通 | 未登记 `judge_role` 的允许集为空 ⇒ 非 admin 无人可判 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/JudgeRoleMatrix.java#ROLE_BY_JUDGE` |
| R-092 | 否决仅在**主席签署前**有效：评审已 DECIDED → 拒；已有 ACTIVE 的 CHAIR/SIGN → 400 `SIGNED_NO_VETO` | 无 | 签署后不再接受否决；改决策只能新发起评审 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#veto` |
| R-093 | 否决 `reason` 为空 → 400 `VETO_REASON_REQUIRED`；无否决权（DCP=IPMT 成员；TR=质量/PDT 质量代表）→ 403 `FORBIDDEN` | 否决可代理，但须 `assertDelegable` 校验 | 无理由否决被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#veto` |
| R-094 | 解除否决仅限 `ACTIVE` 票，且仅否决人本人或 `admin` 可解除 | 无 | 越权解除 403 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#releaseVeto` |
| R-095 | 评审已 DECIDED 或主席已 ACTIVE 签署 → 提交成员意见 400 `SIGNED_NO_OPINION` | 无 | 定论后不再收意见 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#submitOpinion` |
| R-096 | 成员意见 `reason` 为空 → 400 `OPINION_REASON_REQUIRED`；`suggestedConclusion` 为空 → 400 `OPINION_CONCLUSION_REQUIRED`；不在 DCP 合法集内 → 400 `OPINION_CONCLUSION_INVALID` | 无 | 结构化投资意见三要素缺失被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#submitOpinion` |
| R-097 | 真实持有主席角色者提交个人评议 → 400 `CHAIR_OPINION_NOT_ALLOWED` | `admin` 豁免（只拦真实主席的双重身份） | 避免"个人评议"与"集体评议结论"两个并行权威口径 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#submitOpinion` |
| R-098 | 成员意见引用的 `evidenceDocNos` 在 `t_document` 查不到 → 400 `EVIDENCE_NOT_FOUND` | 空串/空白跳过 | 悬空证据编号被拒（不接受自由文本） | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#submitOpinion` |
| R-099 | 证据包为空 → 400 `EVIDENCE_EMPTY`；引用的文档不存在 → 400 `EVIDENCE_NOT_FOUND`；文档未挂在本次证据包上 → 400 `EVIDENCE_NOT_LINKED` | 无 | 证据必须挂在本次评审上 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#attachEvidence` |
| R-100 | 评审项指派对象不在本项目（成员/PM/创建人/本项目评审参与人）→ 403 `FORBIDDEN_OBJECT` | 无 | 跨项目指派被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assignItem` |
| R-101 | 指派用户不持该项 `judge_role` 的资格角色 → 400 `ASSIGNEE_NOT_QUALIFIED`；用户不存在或未启用 → 400 `ASSIGNEE_REQUIRED` | 无 | 指派给无资格/无效账号被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assignItem` |
