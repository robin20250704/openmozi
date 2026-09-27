---
name: plm-requirement-registration
description: PLM 客服子技能③——登记操作规程。把已过质量门的 draft.json 以固定身份登记进 PLM 项目 87 并完成台账回写与回执。含登记前置检查清单、草稿字段三分类映射（登记时写/并入正文/留分析人）、Idempotency-Key 与两层查重的语义、命令面与调用序、失败处置表（REQ_FIELD_STAGE_LOCKED/PROJECT_REQUIRED/ATTR_INVALID/403/401/浏览器超时/证书拦截/空 body 200 异常）、登记后动作与"不代替责任人流转状态"红线。适用：要真正把一条需求写进 PLM 时。
---

# 子技能③：登记操作规程

> 上位机制见 `SKILL.md` §四（查重门/质量门/权限门）与 §七（执行协议）。
> **实测口径（2026-09-27）**：下文与 `.work/plm-probe/registration-contract.md` 冲突处，**一律以本文件（= 事实源 `SKILL.md`）为准**——该勘验报告在"登记不挂项目也行""`verification` 可用"等处已被实测否证。

## 一、登记前置检查清单（缺一不登记）

1. **`.env` 存在**（`D:\project\ai-creature\.env`，已 gitignore）：含 `PLM_USER`（实测 `robinzeng`）/ `PLM_PASSWORD` / `PLM_WEB_BASE`，可选 `PLM_DEFAULT_PROJECT_ID=87`。**口令只提键名，不提值**。
2. **质量门已过**（四判据 + 四元输出 = 通过）；"证否/升级讨论"的条目**不走本流程**。
3. **查重已过**（`dedup` 无命中；或命中已走三条出路之一）。
4. **`check` 全绿**（8 步：`.env` / PLM 可达性 / 真表单 SSO / `requirement.create` 权限 / 默认项目可用性 / 需求分类 / **词表一致性** / 令牌缓存）。**任一步红 ⇒ 不带病登记，先修再跑。**
5. **草稿字段已按 §二 三分类落位**（该写请求体的写了，该进正文的进了，该留分析人的没碰）。
6. **先 `--dry-run`**：看一遍将提交的请求体与"阶段约束剥离清单"，确认无误再真提交。

## 二、草稿字段三分类映射（**最关键，务必写准**）

| 类别 | 字段 | 处置 | 为什么 |
| --- | --- | --- | --- |
| **① 登记时就写**（客观描述；`PROPOSED` 阶段可写） | `title`、`content`、`reqType`、`reqClassId`、`sourceType`、`stdClause`、`paramName`、`parentId`、`projectId` | 进请求体 | 这些是**客观事实**：客服是描述者，不是裁决者 |
| **⛔ 死锁区：登记时无论怎么填都会被拒** | `paramValue`、`paramUom`、`verification` | 工具**本地硬拒并改道**：量化要求写进 `content` 的【量化期望】段（`paramName` 本身可写） | 填了 `paramValue` ⇒ 服务端 `assertVerifiable` 要求 `verifyMethod` + `verification` 同时非空（`RequirementService.java:1136-1142`）；而 `verifyMethod` 属「分析后才可填」⇒ **带它被阶段锁拒**（`REQ_FIELD_STAGE_LOCKED`，判定在前）、**不带它被可验证性校验拒**（`VERIFICATION_REQUIRED`，判定在后）。两条各自正确的规则在交集处形成死锁，而服务端两次报错都不会告诉你"它们互相排斥"。**这就是"宁可本地报错讲清楚、也不让服务端打回"最典型的场景** |
| **② 并入正文「分析输入」段**（分析后才可填，**不写请求体**） | `priority`、`appealsDim`、`dfxDimension`、`verifyMethod`、`userPersona`、`userTags`、`solution` | 由工具**自动追加**到 `content` 末尾的「分析输入 · 由客服采集，待分析人裁定」段，并在终端与台账回显 | 新建需求恒为 `PROPOSED`，服务端 `RequirementService.assertStageAllowsOnCreate` 会拒收带值的"分析后才可填"字段（元数据 `t_attr_template.is_post_analysis_only`，V144）⇒ 命中即 `400 REQ_FIELD_STAGE_LOCKED`。**这是"客服只采客观事实、不替分析人下结论"的机制体现**（"谁都能标 P0 等于没有优先级"） |
| **③ 留分析人**（登记时不出现，也不进正文结论段） | 分析归类、方案设计、验证策略、用户画像的最终形态 | **一个字都不写** | 越界即污染分析输入；客服的建议只能以"建议 + 待裁定"形态出现 |
| **例外（白名单豁免）** | `sourceChannel`（`SOURCE_CHANNEL_STAGE_EXEMPT`：分发前必录、发起阶段必须能填） | 工具**默认仍不写**（少一个写入面就少一类 400）；确需登记来源时在草稿里**显式给** | 写 `attrs` 会触发 `validateIpdAttrs` 的格式校验链 |

**词表（服务端为准，工具 `check` 会比对漂移）**：
- `reqType`（9）：`UR/SR/REG/RC/DFX/COST/MKT/DSVC/SRV2`
- `sourceType`（8）：`MARKET/STANDARD/RISK/CAPA/CLINICAL/OTHER/PLM_SELF/REGULATION`
- `sourceChannel`（5）：`MARKET/CUSTOMER/REGULATION/COMPETITOR/INTERNAL` —— **与 `sourceType` 不是同一套词表**
- `priority`：`HIGH/MEDIUM/LOW`｜`dfxDimension`：`DFM/DFR/DFT/DFU/SAFETY/ENV/COST/IP/COMPLIANCE`｜`verifyMethod`：`TEST/ANALYSIS/INSPECTION/DEMO`｜`appealsDim`：`PRICE/QUALITY/TIME/VARIETY/SERVICE/CHANNEL/BRAND/RELATIONSHIP`
- `reqClassId`（9）：1 功能 FUNCTION｜2 性能 PERFORMANCE｜3 安全 SAFETY｜4 可靠性 RELIABILITY｜5 准入法规 REGULATORY｜6 可用性 USABILITY｜7 可制造可供应 MANUFACTURABILITY｜8 可测试性 TESTABILITY｜9 成本 COST

**项目（必填）**：`projectId=87` = `PRJ-2026-0087 天工AI PLM 1.0`（全库唯一含 "PLM"；`REQ-2026-3xxx` 序列全在此项目下）。**必须指定**——缺项目不仅挂不上，**后续批准会被 `400 PROJECT_REQUIRED` 卡死**（此时只能返工补字段）。
**项目解析纪律**：87 是"当下默认值"，正确做法是 `projects --keyword PLM` 动态解析；**解析不到就停下来报警，不要猜一个 id**（挂到别的项目 = 需求进了错的 backlog，比不登记更糟）。

## 三、`Idempotency-Key` 与两层查重（各自解决不同的问题）

**两层查重（防"同一痛点两个编号"）**：
1. **本地台账 fingerprint**（`plm-registration-ledger.md`）：工具对"规范化标题 + 正文前 400 字"取哈希；**同一 fingerprint 已登记过 ⇒ 拒绝重发**（`--allow-duplicate` 可覆盖）。**为什么**：PLM 创建接口**没有语义幂等**，不带键的重复 POST 会**真建两条**（`t_requirement` 无标题唯一约束）。
2. **提交前相似度查重**：服务端 `keyword` 收窄（取标题前 6 个长词）+ 本地**加权 Jaccard**（标题词权重 3、正文词权重 1），默认阈值 **0.55**，**命中即拦下**。**为什么两层**：台账只能挡住"字节级相同"，挡不住"换个说法说同一件事"；相似度查重补这一层，而纯关键词检索会有大量假阴性。

**`Idempotency-Key`（opt-in 幂等键，值 = 草稿 fingerprint）**：
- 语义（**实测**）：同键 24h 内重放**只看 `(key, method, path)`、不看 body**——同键换内容仍返回**第一次的响应**（响应头 `Idempotent-Replay: true`）。
- **因此**：① 每次"登记意图"一个新键；**改了内容就必须换键**（本工具的 fingerprint 含正文，改内容即改键）；② **重试同一次登记必须原样复用同一个键**（网络超时后重发不会产生第二条）；③ **绝不能拿幂等键当查重用**（不同键 = 两条真需求）。
- **代价**：幂等键只能防"同一意图重复落库"，**防不了"两个不同意图说了同一件事"**——所以两道门都要，缺一不可。

**执行顺序（工具内置，不可跳）**：字段校验 → 台账 fingerprint 门 → 相似度查重门 → `--dry-run` 出口 → 真提交（带 `Idempotency-Key`）→ 台账记账。

## 四、命令面与调用序（照抄）

```bash
# 在工作区根 D:\project\ai-creature 执行
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs check                 # 环境自检（8 步）
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs whoami                # 确认身份与角色
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs projects --keyword PLM # 解析 projectId
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs dedup --title "…" --content "…"   # 提交前查重
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs submit -f draft.json --dry-run    # 看请求体
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs submit -f draft.json              # 真写
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs get REQ-2026-NNNN --flow          # 回读取证
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs track                             # 台账对账
```
**退出码语义**（用于脚本化判断）：`0` 成功 ｜ `2` 用法/草稿校验失败 ｜ `3` 台账 fingerprint 重复（或 dedup 有命中）｜ `4` 相似度查重命中被拦 ｜ `1` 命令失败（网络/HTTP 错误等）。**非 0 不等于"系统坏了"**——`3`/`4` 是**门工作正常**的证据。

## 五、失败处置表（照症状查，**不猜、不硬试**）

| 症状 | 真因 | 处置 |
| --- | --- | --- |
| `400 REQ_FIELD_STAGE_LOCKED` | 请求含"分析后才可填"字段（**阶段约束，不是权限问题**） | 移出请求体、并入正文「分析输入」段；工具已默认剥离 `priority/dfxDimension/verifyMethod/appealsDim` 等 ⇒ 若仍报，说明草稿里还有别的后置字段，**逐步删字段重试并把字段名记入** `plm-lessons.md` |
| `400 PROJECT_REQUIRED` | 需求未挂项目 ⇒ 无法批准 | 草稿补 `projectId=87`；不要挂不存在的 id（会 `400 REF_TARGET_MISSING`） |
| `400 ATTR_INVALID`（如 `REQ.sourceType 非法值: CUSTOMER`） | **两套词表抄混** | 按 §二 词表改正；`check` 的"词表一致性"步会提前报红（服务端元数据 vs 本地常量） |
| `400 VERIFICATION_REQUIRED` | 填了 `paramValue` 却没给验收准则 | 补验收准则，或去掉 `paramValue` 把量化要求写进正文交给分析人 |
| `400 DATA_CONFLICT` | `reqClassId` / `parentId` 填了不存在的 id（创建时不做存在性预检，靠 DB 外键兜底） | 用 `classes` 取正确分类 id；`parentId` 用真实存在的需求 id |
| `403 FORBIDDEN` | 当前身份无 `requirement.create`，或对象级 ABAC | `whoami` 看角色；**不重试**；按 `SKILL.md` §十 的两类 403 文案分路 |
| `401 UNAUTHORIZED` | token 缺失/过期；或脚本未带 Bearer 直连 | 正常：未带 Bearer 一律 401（**预期行为**）。走 refresh 续期；UAT **禁止 password grant**（`unauthorized_client`） |
| 浏览器登录超时（"等待 SSO token 超时"） | 证书拦截页挂死 / 表单未渲染 / 站点不可达 | 先 `doctor`（清孤儿浏览器）→ `login --force` → 仍失败**读报错里的 URL 与页面片段**（工具会打印，据此区分"已登录态"与"站点不可达"），再上报 |
| 卡在**证书拦截页** | 复用了 `:9222` 上**别的 harness 起的** headless Chrome（无 `--ignore-certificate-errors`），UAT 自签证书 ⇒ headless 无人可点 ⇒ **静默挂死** | **绝不复用外部实例**；工具会在专用端口 **9334** 自起（参数与回收都由自己负责）。教训：**"端口在" ≠ "能用"** |
| 误判"已登录"而跳过填表 | `Page.navigate` 在 nginx 返回首页时就 resolve，首页 JS 稍后才 302 到 Keycloak ⇒ 此时读 `location.href` 得出错误结论 | 工具已改为**等站点切走或表单出现**再决定填不填；若自行写脚本，**必须照此**，否则会白等到超时并报出与真因无关的话 |
| 空 body `POST /requirements` **返回 200** | ⚠ 异常情况（工具 `check` 第 4 步专门探这一步） | **立即人工核对是否产生垃圾条目**（`list` 看最新条）；确认即按作废流程处理 + 写 `plm-lessons.md`；**不得**把它读成"权限自检通过" |
| `--dry-run` 后以为已登记 | dry-run 不落库 | 认**是否有 `reqCode`** 与台账新行 |
| 会话缓存失效（静默重登） | 身份或环境变了（工具在 `user`/`base` 不一致时**自动作废**） | 这是有意设计（防"以别人的身份登记"）；`login --force` 重登 |
| 命令末尾出现 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | Windows 上 fetch keep-alive 连接关闭期的 libuv 断言 | **不影响退出码与业务结果**（工具已延迟退出缓解）；看业务输出是否完整，**不要重试** |
| 幂等重放（`Idempotent-Replay: true`） | 同 fingerprint 此前已登记成功 | 本次**未新建**第二条；用返回的编号去 `get --flow` 确认，**不要因为"没看到新编号"再提交一次** |

## 六、登记后动作（回写 + 回执 + 回访）

1. **台账自动回写** `plm-registration-ledger.md`：登记时间 / `reqCode` / `projectId` / 标题 / fingerprint / 登记时状态 / 登记人 / 备注（含 `reqType` 与后置字段列表）。**人工只读**；修正状态须注明来源与时间，避免与运行态不一致时无从判断谁对。
2. **回读取证**：`get <reqCode> --flow` 取运行态与 9 段流程阶段（确认 status = `PROPOSED`、projectId = 87、下一步处理角色是谁）。
3. **告知用户（回执口径，必须三点齐）**：
   - **编号 + 标题**（例：`REQ-2026-3230`）；
   - **后续流程**：**`robinzeng` 批准 → 交付智能体开发实施**（项目既有口径，见 `D:\project\jcode\ipd\agents\skills\pdm-feedback-to-requirement.md`），并说明可在**需求管理 `/requirements`** 查看/跟踪；
   - **后置字段去向**：优先级/DFX/价值维度等**已在正文「分析输入」段**，将转给分析人在进入 `ANALYZED` 后补录——**这一句必须说**，否则分析人看不到客服采集的诉求强度。
4. **回访闭环**：后续用 `track` / `get <编号> --flow` 回读；状态推进或退回时**主动回访**用户，并回填 `plm-requirement-outcome-tracker.md`（是否被分析人采纳、下一步是谁、是否被作废/合并）。
5. **同步电容器**：用户原话回填 `plm-voice-of-customer.md`（不改写）；主题簇计数同步到 `plm-pain-clusters.md`；本次踩到的坑**即时**写 `plm-lessons.md`。

## 七、红线（写在这里，登记前扫一眼）

- **不代替责任人流转状态**：`PROPOSED→ANALYZED→APPROVED→…` 是**别人**的节拍；本器官**只做登记**与**只读回访**。不批准、不验收、不判定、不签署、不作废（作废不可回退，且属治理动作）。
- **不改库、不改主数据、不教用户绕过**（手改数据 / 跳过分页筛选 / 跳过评审门 / 挂不相关引用对象）——绕过污染受控证据链（审计是 append-only hash 链），事后无法对账。
- **不写口令与 token**：`.env` 只提键名；token 只进 `.creature/.cache/plm-session.json`（gitignored，600 权限，只含 token）；**任何产物、终端输出、台账都不得含口令/token 明文**。
- **不改 `references/tools/`**：工具的行为是实测过的；要改行为先改 `SKILL.md`/`plm-lessons.md` 并留证据。
- **爆炸半径意识**：真实写操作只有 `POST /api/v1/requirements` 一件，产物是一条可作废但**不可回退**的 `PROPOSED` 条目 ⇒ 登记前必须已过**查重门 + 质量门**；**宁可这一轮不登记（把草稿留给下一轮补齐证据），也不要落一条要作废的条目**。
