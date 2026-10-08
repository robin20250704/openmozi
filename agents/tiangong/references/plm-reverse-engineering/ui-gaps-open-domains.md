# UI ↔ 业务/后台 缺口：现行缺陷（按域）

> 覆盖度声明与处置顺序见 [ui-logic-gap-analysis.md](ui-logic-gap-analysis.md)；跨域横切面见 [ui-gaps-open.md](ui-gaps-open.md)。
> 每条双侧证据。复核请换解析路径（`gaps.md` §④ 有全假告警前例）。
>
> **本文件域范围：计划任务（MSG-01）。** 项目管理 域（PRJ-01 / PRJ-02）见
> [ui-gaps-open-project.md](ui-gaps-open-project.md)；BOM编辑 域（BOM-01）见
> [ui-gaps-open-bom.md](ui-gaps-open-bom.md)；横切面 **SYS-01** 见 [ui-gaps-open.md](ui-gaps-open.md)。
>
> **2026-10-05 更新**：用户裁定 `请开始修改`（D-6 对所列缺陷已解除），
> MSG-01 **已修**，内附「处置」小节写明改了什么、依据哪份权威、拿什么证明。
> **原文证据一律保留不改写**——审计留档的价值就在于
> 能看见"当初凭什么这么判"，而不只是"现在是什么样"。

---

## MSG-01 「里程碑」一词在系统中指两样互不关联的东西
**分类**：C（概念冲突/重复） · **严重度**：中 · **域**：计划任务 / 项目管理

**现象**：同一个中文词「里程碑」，在任务里是**形状开关**，在项目里是**时间点实体**；两表零外键。

**A 方——任务上的布尔标记（形状）**：
```java
// V167__task-domain-foundation.sql:102  —— 列在 t_project_task 上
is_milestone   BOOLEAN NOT NULL DEFAULT false,
```
```tsx
// TasksPage.tsx:968  —— UI 字段名就叫「里程碑」，可选项是「是 / 否」
{ code: 'milestone', label: '里程碑', kind: 'select',
  enum: [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] },
```
它的**全部**作用（`TaskDtos.java:224` 原话）：
> `milestones` 里程碑条数（**渲染成菱形而非长条**）

即 `TaskService.java:616-621` 数出条数供甘特图画菱形，`TaskExportService.java:91,174` 导出成「是/否」列。**不参与任何业务判定。**

**B 方——项目级里程碑实体（时间点）**：
```sql
-- V20__project-product-milestone.sql:17-29
CREATE TABLE IF NOT EXISTS t_milestone (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES t_project(id),
    name TEXT NOT NULL, planned_date DATE, actual_date DATE,
    status TEXT NOT NULL DEFAULT 'PENDING'
           CHECK (status IN ('PENDING','ACHIEVED','MISSED')),
    gate_code TEXT,  -- 可选：关联阶段门（G1-G7）
    ...
);
```
`ProjectsPage.tsx:1361-1362`（项目详情「里程碑」页签）的空态提示把它的语义讲得很清楚：
> 暂无里程碑；添加项目**关键时间点**（如 EVT/DVT/PVT、注册申报）。

**零外键证明**：209 个迁移中**不存在任何 `ALTER TABLE t_milestone`**（全仓 grep 仅 V20 那一处 CREATE），
`t_milestone` 没有 `task_id`；`t_project_task` 也没有指向 `t_milestone` 的列。

**影响（用户误读路径）**：在「计划任务」里把某任务的「里程碑」置为**是**，合理预期是
该任务随即出现在项目详情的「里程碑」页签里。**实际不会**——它只改了甘特图上这条是菱形还是长条。
两处用了同一个词，一个是**形状**、一个是**时间点**，且界面上没有任何一处提示二者不是一回事。

**建议**（三选一，均为改声明/改标签，不动数据结构）：
- (a) 把任务上的字段标签改成**说明其真实作用**的措辞（如「甘特图菱形标记」/「按里程碑样式绘制」）——成本最低、零风险；
- (b) 在项目「里程碑」页签补一句「此处的里程碑是项目关键时间点，与任务列表里的『里程碑』标记不是一回事」；
- (c) 建立 `t_milestone.task_id` 真关联——**代价最大，且要先回答"一个任务能否属于多个里程碑"**，
  在这个问题定论前**不要**选 (c)。

### 处置（2026-10-05 · D-16）已修 · 采纳 (a)，并按用户裁定排除 (c)
用户原话：`计划任务中，选择里程碑，仅在甘特图中展示菱形标注就好。暂不用与项目关联。`
即 **(c) 明确不做**（不建 `t_milestone.task_id`、不改数据结构、零 API 变更），
按 (a) 改标签——**让标签说出它真实的作用**。改 4 处：

| 位置 | 原文 | 改后 |
|---|---|---|
| `TasksPage.tsx` 字段标签 | `里程碑` | `里程碑（甘特图菱形标记）` |
| `TaskGanttPage.tsx:346` 图例 | `◆ 里程碑` | `◆ 里程碑标记` |
| `TaskGanttPage.tsx:346` 下 | （无解释） | 新增一行副文：菱形只是**形状**，不是项目里程碑实体 |
| `ProjectsPage.tsx` 里程碑页签 | （无互斥提示） | 页签标题后新增 `data-testid="msc-scope-note"` 说明块 |

**为什么只改文案、不改字段名**：`milestone` 是**线上 API 的字段名**（`TaskDtos.java:224`），
改名是破坏性变更且对用户零收益；真正的病因是**标签没说清**，标签才是病根。
这也是本仓既有写法（消歧靠标签里的括号补充说明，如「里程碑（甘特图菱形标记）」）。

---

## 其余两域已按域拆出
- **PRJ-01 / PRJ-02（项目管理）** → [ui-gaps-open-project.md](ui-gaps-open-project.md)
- **BOM-01（BOM编辑）** → [ui-gaps-open-bom.md](ui-gaps-open-bom.md)

> 拆片原因：2026-10-05 回写处置后本文件越了标准树分片上限（150 行 / 12 288 B），
> 按判据**按域拆片而非把行写短**。本文件现只承载**计划任务域（MSG-01）**。



