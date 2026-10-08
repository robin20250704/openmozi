# 评审签署、订正与阶段守卫（review-sign-and-correction）

> 本片声明评审域的**记录与事后修正**路径：签署 / 作废、受控订正通道、阶段流转守卫。
> 门序守卫、结论值域、条件文本与判定资格在同目录 `review-gates.md`。
> 评审门与阶段机的映射关系属 `ontology` 树；接口签名属 `interfaces` 树。
> 设计口径见 `→ docs/plm-tech/12-产品级通用规格-评审机制与列表范式.md#2. 评审机制通用规格（G-REV）`。
> 证据级别：全部 `有代码校验`（抛点行号已核实）。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- |
| R-102 | 评审已 DECIDED → 再签署 400「评审已判定，不可再签署（BR-04 WORM）」；已签署过 → 400「已签署（WORM，不可重复）」 | 无 | 签署不可重复 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#sign` |
| R-103 | 作废签署必须写理由（≥?）→ 400 `VOID_REASON_REQUIRED`；仅可作废 `SIGN` 记录（否决票须走 `/vetoes/{id}/release`）；仅原签署人本人、主席或 admin 可作废 | 无 | 无理由作废被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#voidSignature` |
| R-104 | 订正通道：`reason` trim 后 <10 字 → 400 `CORRECTION_REASON_REQUIRED`；`conclusion` 为空 → 400；原评审未 DECIDED → 400 `REVIEW_NOT_DECIDED`；原评审已被订正 → 400 `REVIEW_ALREADY_SUPERSEDED` | 无第二签署人时允许自评，仅打标 | 多轮订正禁止在中间轮分叉出第二条链 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#correctReview` |
| R-105 | 订正必须能沿用原评审的已判定清单项快照；`copied == 0` → 400 `CORRECTION_NO_ITEMS`，此类评审请走正常流程重新发起 | 无 | 保证订正与原评审判据同口径 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#correctReview` |
| R-106 | 订正评审**不重跑**机器预检：`precheck_result` 记录订正元数据而非预检结论 | 无 | 重跑会要求门当下是绿的，而门之所以要订正往往正是它红/错 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#correctReview` |
| R-107 | 阶段流转 `from→to` 若在 `t_gate_map` 映射到某个 **DCP**，须该项目该门 DECIDED 且链尾结论 ∈ `{GO,GO_WITH_RISK}`，否则 400 `STAGE_GUARD_BLOCKED` | 未映射到 DCP 的流转（监管子步骤等）不守卫；TR 为阶段内门不设阶段端点 | 存量路径零回归；阶段跳门被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertStageGuard` |
| R-108 | "已放行"判定必须按**链尾**（`status='DECIDED' AND conclusion ∈ 放行集 AND superseded_by_id IS NULL`），否则订正成 FAIL 会因旧 GO 仍满足门线而静默放行 | 无 | 比不订正更危险的静默漏洞被堵 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#hasApprovedDcp` |
