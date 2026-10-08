# UI ↔ 业务/后台 缺口：项目管理域（现行缺陷 + 已修处置）

> 从 [ui-gaps-open-domains.md](ui-gaps-open-domains.md) **按域拆出**——
> 该文件回写处置后越了标准树分片上限（150 行 / 12 288 B），按判据**拆片**而非把行写短。
> 计划任务域（MSG-01）留在原文件；BOM编辑 域见 [ui-gaps-open-bom.md](ui-gaps-open-bom.md)；
> 横切面见 [ui-gaps-open.md](ui-gaps-open.md)。

---

## PRJ-01 项目页同一文件内并存两套项目生命周期词表
**分类**：C（概念重复）+ B（UI↔后台不一致） · **严重度**：中 · **域**：项目管理

**现象**：交付物的「关联阶段」下拉列死 11 个阶段值，而同一文件早已接入服务端流程定义、并在另外三处正确使用。

**前端证据**：
```tsx
// ProjectsPage.tsx:192  —— 已在作用域内拿到服务端状态词表
const { states: PRJ_STATUSES, transitionsFrom: allLifecycle, visibleTransitions: nextLifecycle,
        editableStatuses, stateLabel: prjStateLabel } = useFlow('project', myRoles);
// ProjectsPage.tsx:1007 —— 筛选栏正确使用
<ProjectFilterBar value={filter} onChange={onFilterChange} statusOptions={PRJ_STATUSES}>
// ProjectsPage.tsx:1128 —— 生命周期计数正确使用
{...}（{Math.max(1, PRJ_STATUSES.indexOf(selected.status) + 1)}/{PRJ_STATUSES.length}）
// ProjectsPage.tsx:1330 —— 同一页面内唯一的硬编码副本
{['立项', '概念', '计划', '开发', '验证', '注册申报', '设计转换', '上市', '维护', '退市', '已终止']
  .map((s) => <option key={s} value={s}>{s}</option>)}
```

**权威与通道**：
- `flows/project-flow.yaml:3-47` —— `states` 声明 11 项（10 生命周期 + 终态 `已终止`）。
- `GET /api/v1/_platform/flows/{flowId}`（`platform-controller`）—— 通用流程定义读面端点。
- `src/hooks/useFlow.ts:111` —— `useFlow(flowId, myRoles)` 即该端点的封装，带模块级缓存（`:100`）。

**影响**：当前两套值**一致**，故不是功能故障。但 `project-flow.yaml` 恰恰是会变的源——
`:34-47` 记录它 2026-09-25 才补齐 `已终止` 终态（此前前端/库/YAML 三处各说一套）。
下次该 YAML 增删阶段时，本下拉静默停留旧值，而同页筛选栏会跟着变 ⇒ **同一页面两个下拉给出不同选项**。

**建议**：`ProjectsPage.tsx:1330` 直接改用同作用域的 `PRJ_STATUSES`（零新增请求）。

### 处置（2026-10-05 · D-16）已修
硬编码副本删除，改为同作用域的 `PRJ_STATUSES`（`useFlow('project', myRoles)` 的 `states`）。
**零新增请求**（该 hook 已在 `:192` 挂在同一组件里）。复核不是"看着像一样"——
逐字节比对了 11 个值与 `flows/project-flow.yaml` 的 `states` 声明，**11/11 相同**。

---

## PRJ-02 TDP 产出页违反本域已明立的「终态从服务端读」裁定
**分类**：C（概念重复）+ B（UI↔后台不一致） · **严重度**：中 · **域**：项目管理

**现象**：`PipelineLifecyclePage` 已把终态词表从常量表改为服务端下发，**同一份裁定漏改了 `TdpOutputsPage`**。

**前端证据**：
```tsx
// TdpOutputsPage.tsx:445
return !!p?.status && ['已终止', '退市'].includes(String(p.status));
```

**裁定原文**（`PipelineLifecyclePage.tsx:70-78`）：
> 项目的**终态**（终止与退市的终点）——**从服务端读，不在前端抄常量表**。
> 2026-09-28（用户裁定补后端能力缺口）：此前的实现本是一张就地常量表（`['已终止','退市']`）……
> **那种「必须记得同步」的约定就是同一事实两处实现**（终态集合来自登记表，界面却另存一份）。
> 后端已补 `GET /pipeline/terminal-status`（含 `reason`），界面改为读它。

**权威与通道**：
- `GET /api/v1/pipeline/terminal-status`（`pipeline-controller`）—— **端点已存在**。
- `V162__pipeline-exclude-terminal-statuses.sql:34` `CREATE TABLE t_pipeline_terminal_status`；
  `:40-43` 登记 2 行；`:53-55` 自检断言「登记的每个终态都必须是**库 CHECK 真正允许的值**」。

**影响**：终态集合是**可增长数据**（V162 做成表正是为了「能被 SQL 断言」）。新增第三个终态时，
`PipelineLifecyclePage` 自动跟随，`TdpOutputsPage` 的提示会静默失效 ⇒
用户在已终止/退市项目上仍被允许登记产出，界面不作提示。

**建议**：`TdpOutputsPage.tsx:445` 复用 `PipelineLifecyclePage` 已接的 `/pipeline/terminal-status`。

### 处置（2026-10-05 · D-16）已修
`TdpOutputsPage` 挂载后取 `GET /pipeline/terminal-status`，以返回的 `string[]` 判定
（`projectTerminalHint(p, terminal)`），并新增 `data-testid="tdp-terminal-err"` 的取数失败提示块。
**失败即提示、不静默降级**——否则一次网络抖动就会让"终态"悄悄退回本轮重点要消灭的常量表。
该端点是**本仓自有的 PRJ-02 侧权威**（`V162` 建成表正是为了可被 SQL 断言），
不是新造的接口，故未新增任何后端代码。

> **同页同轮的另一处顺带修掉**：`ProjectsPage` 里程碑区新增 `data-testid="msc-scope-note"`，
> 写明项目里程碑与任务侧里程碑标记**不是一回事**（MSG-01 的界面侧处置）——
> 两处必须一起看，只改甘特图会留下半个解释。
