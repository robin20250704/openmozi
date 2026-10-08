# 值域权威收口：密级与创新类别升格为库 CHECK（2026-10-05 · D-18）

> **本分片是什么**：`ui-gaps-open.md` 横切面缺陷 **SYS-01** 的处置后半段。
> 前半段（普查、为什么否掉 (a)、`ui-only` 防线、解析器自测）留在 [ui-gaps-open.md](ui-gaps-open.md) §三 3.1–3.3；
> 本分片专记**密级 / 创新类别两个词表的升格**——因为它们的病根与 SYS-01 其余 7 处**不是同一个**：
> 那 7 处是「前端抄了后端」，这两处是**前端和后端都声明了闭集、但谁都不强制**（假权威）。
> 读本分片前请先看 [ui-gaps-open.md](ui-gaps-open.md) §二 的双侧证据。
>
> 关联：`conflicts.md` C-032（已修）/ C-036 / C-037，`decisions.md` D-18。

## 一、为什么这两处要单独立项

SYS-01 普查了 9 个词表，**其中 7 处有真权威**（库 CHECK 或后端常量），只有 2 处是「声明了、不强制」：

| # | 词表 | 前端值集 | 声明方 | 实际是否强制 |
| --- | --- | --- | --- | --- |
| 1 | 密级 `t_document.security_level` | 内部/秘密/机密 | `DocumentDtos.java:24` `SECURITY_LEVELS` | ❌ 从不比对 |
| 2 | 创新类别 `t_project.project_class` | A/B/C | `ProjectVocabulary.PROJECT_CLASSES` | ❌ 从不比对 |

⚠ 措辞纪律：**不能说「权威不存在」**——权威**声明了**，只是没人拿它校验。
密级那处更特殊：库里还混着 `INTERNAL`（英文），是**数据缺陷**，与「缺约束」是两件事，别混为一谈。

## 二、用户裁定（2026-10-05 · D-18）

这两处是否**升格为强制闭集**，我没有替用户决定——若补 CHECK 而库里已存越界行，迁移会**直接失败**；
若只补校验不补 CHECK，仍是「看起来有权威」。用户裁定：

| 问题 | 裁定 | 落地 |
| --- | --- | --- |
| 值域权威怎么建 | **先补 CHECK 约束** | `V214__enforce-security-level-and-project-class.sql` |
| 值域怎么下发到前端 | **不建读 `pg_constraint` 的端点** | 维持 `check-vocab-parity` 离线断言 |

⇒ SYS-01 的 (a)「把 `/enums` 推广到 8 处」**已被永久否掉**（不是待裁定）。落地后不靠运行期下发，
靠**两条离线机械断言**把前后端值域钉在一起。

## 三、V214 实际做了什么（须与 §二 分开读：裁定是「补约束」，落地多了一步「先清存量」）

**为什么不能只加 CHECK**：库里本就有越界行，加约束会当场失败。这不是假设——干跑中把归一 UPDATE 删掉试过一次，
`ERROR: check constraint "t_document_security_level_check" ... is violated by some row`。
故 V214 = **先归一存量 → 再加约束 → 断言 → 留痕**（顺序不可调换）。

| 列 | 声明值域 | 库里实测越界值 | 处置 | 纪律来源 |
| --- | --- | --- | --- | --- |
| `t_document.security_level` | 内部/秘密/机密 | **`INTERNAL` × 58**（plm）/ × 235（plm_test） | 归一为「内部」 | 同词翻译到已声明权威，不猜 |
| `t_project.project_class` | A/B/C（可空） | **`PDP` × 9**（plm）/ × 1（plm_test） | 置 `NULL` | 抄 `V72:121-122`「置 NULL 表示未填，**不做推断**」 |

⚠ **两处越界不是一类病，别混**：
密级是**异语言写法**（值本身有明确对应，翻译无损）；
创新类别是**串轴**——`PDP` 属 `prj_type`（项目类型），被写进了 `project_class`（创新类别）。
本项目共**三根轴**：`project_class`(A/B/C, 可编辑) / `innovation_type`(HW/SW/ALGO/STRUCTURE, 有 CHECK, UI 无编辑字段)
/ `prj_type`(PDP/TDP/PLATFORM/CUSTOM, 有 CHECK, 仅创建时)。串轴在**两个方向上都真实发生过**
（`V72/V73` 治了 A/B/C→innovation_type，V214 补上 prj_type→project_class 这另一半）。

**并存的服务端校验**（超出字面裁定，但必须做）：只加 CHECK 不加校验，越界写入会从「静默落库」变成
**500 约束异常**——500 是新造的缺陷。故 `DocumentService.validateSecurityLevel` 与
`ProjectService.validateProjectClass` 同步落地，形状对齐既有的 `validateInnovationType`。
三个校验器**一律拒绝、不静默翻译**，`INTERNAL`→内部 的兼容**只由迁移承担**，不留在写入路径上。

**验证**（D-13 正/负探针，两库各跑 5 例全过，回滚后数据与约束数均复原）：

| 探针 | 结果 |
| --- | --- |
| 正向 密级=秘密 / 创新类别=B | ✅ 写入成功（约束未把正常业务锁死） |
| 负向 密级=INTERNAL / TOP SECRET | ✅ `check_violation` 拒绝 |
| 负向 创新类别=PDP（串轴） | ✅ `check_violation` 拒绝 |
| `ROLLBACK` 后 `INTERNAL`/`PDP` 行数、约束数 | ✅ 复原为 0 条约束（确认未落库） |

⚠ **一条待部署的机械断言**：`npm run check:vocab` 现在**如实报 2 条 FAIL**（密级/创新类别「快照里没有该 CHECK」）。
这是对的——V214 尚未被 Flyway 应用，CHECK 还不存在于库。部署后重跑 `npm run check:vocab:refresh`（预期 151→153）即转绿。
**不手工补跑迁移**：绕过 Flyway 会让 `flyway_schema_history` 与实况失配，下次启动直接校验失败。

## 四、第二次自测抓到的：会崩的判据等于没有判据

把两条注册项从 `ui-only`/`java-const` 升为 `db-check` 时，我**改了 kind 却漏了 `db` 定位字段**，
脚本直接 `TypeError: Cannot read properties of undefined (reading 'table')` 崩退出。

问题不在这次笔误，在**崩掉的退出码不可读**——同一个 `exit 1` 既可能是"词表真的不一致"，
也可能是"注册表写错了"，接 CI 的人分不开，于是选择忽略整条输出。
已补**配置守卫**：权威指针缺失报成明确的配置错并继续跑完其余条目，不再中断。
同 §3.3 一脉：**判据不仅要能证否，还要能指出自己哪里错了**。

⚠ 附带订正了失败文案：原写「约束被删了？」是**误导**——V214 的约束是**还没建**（待 Flyway 应用），
不是被删。两种成因已分开表述，否则会有人去追一条并不存在的删除记录。

## 五、留待下一批次（本轮只登记，不擅自动手）

- **`innovation_type` 在 UI 上没有编辑字段**——受 CHECK 保护的那根轴用户**改不了**，
  可编辑的 `project_class` 此前又**无约束**。护栏装反了（`conflicts.md` C-036）。
  属**产品缺口**不是数据缺陷，加字段要先定"谁该填技术性质"，不在本轮授权内。
- `t_offering_line_type_ck` / `t_offering_line_ref_type_ck` 为 `NOT VALID`——存量行从未回检。
- 7 处未核实断点维持登记（见 [ui-logic-gap-analysis.md](ui-logic-gap-analysis.md) 序 6）。
