# 工具登记（tool-registry）· PLM 客服

> 读取时机：任何需要"看事实"或"动手"之前，先在此选型；不可用沿降级链兜底。
> 环境可用性探测：`node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs check`

| 层级 | 工具 | 位置 | 用途 | 环境可用性（2026-09-27 实测） |
| --- | --- | --- | --- | --- |
| **T0 登记器官** | `plm-req.cjs` | `references/tools/` | 登记/查重/查单/台账/项目/分类/自检 | 可用（`check` 7 步全绿） |
| **T0 登录器官** | `plm-sso.cjs` | `references/tools/` | `.env` 凭据 → 真浏览器 SSO → token（缓存/refresh/重登三级） | 可用 |
| **T0 浏览器** | Chrome / Edge（headless=new + `--ignore-certificate-errors`） | 系统安装路径；`PLM_CHROME_PATH` 可覆盖 | SSO 授权码流必经（UAT 已关闭 password grant） | 已找到 Chrome 153 |
| **T0 电容器** | `plm-kb.cjs` | `references/tools/` | 工作区 KB 初始化 / 检索 / 追加条目 / 体检 | 见工具自带 `--help` |
| **T1 检索** | 工作区 `grep`/`glob`/`read` | DSH 内置 | KB 与只读源码检索 | 可用 |
| **T1 检索** | `.creature/tools/capacitor.cjs` | 工作区（若存在，交付型实例的家园工具） | 索引化检索/追加/体检；**本 skill 的 KB 用 `plm-` 前缀命名以避免与它抢域** | 视工作区而定 |
| **T1 检索** | `capacitor brief` / `query` | `.creature/tools/` | 开工包与分级检索（比手读文件省 token） | 视工作区而定 |
| **T2 只读事实源** | `D:\project\jcode`（手册 18 章 + 源码） | 只读 | 权威依据取证 | 可用，**只读**（C-01） |
| **T2 只读事实源** | `D:\project\jcode\docs\plm-user-guide\` | 只读 | 面向用户的手册：答复优先引这里 | 可用 |
| **T3 远端** | MCP 网关 / OpenProject API | 未核实 | 本 skill 不依赖；**不用于登记需求** | 未核实 |

## 降级链（每一列都是"上一级不可用时怎么办"）

| 动作 | 首选 | 降级 1 | 降级 2 | 兜底 |
| --- | --- | --- | --- | --- |
| 取 token | 缓存 token（未过期） | `refresh_token` 续期（不弹浏览器） | 完整 SSO 真表单登录 | 报错并请人确认 `.env` 与账号状态 |
| 浏览器 | 复用本工具自建实例（专用端口 9334） | 自起新实例 | 换 Edge | 有头模式（`PLM_HEADLESS=0`）人工看登录过程 |
| 查重 | 服务端 `?keyword=` + 本地相似度 | 本地台账 fingerprint | 人工按标题浏览 `list --project 87` | 明确告知"未能查重完成"，**不登记** |
| 知识检索 | `plm-faq.md` | `plm-known-deviations.md` | `plm-module-map.md` | 只读源码/手册 + 标"未核实" |
| 浏览器僵尸 | `doctor` 清理孤儿进程 | 换端口 | 重启终端 | 报告 + 请人工清理 |

## 关键命令速记

```bash
# 环境自检（开工第一步）
node .dsh/skills/creature-plm-customer-service/references/tools/plm-req.cjs check
# 定位承接项目 / 需求分类
node .../plm-req.cjs projects --keyword PLM
node .../plm-req.cjs classes
# 查重（拿不准就先查）
node .../plm-req.cjs dedup --title "【BOM】互替组顺序错乱"
# 登记（先 dry-run，再真提交）
node .../plm-req.cjs submit -f .creature/tasks/plm-cs-xxx/draft.json --dry-run
node .../plm-req.cjs submit -f .creature/tasks/plm-cs-xxx/draft.json
# 回读
node .../plm-req.cjs get REQ-2026-3230 --flow
node .../plm-req.cjs track
```
