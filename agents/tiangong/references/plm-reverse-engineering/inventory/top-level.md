# 分片：项目根（top-level）

> 登记 `D:\project\jcode\` 根下的入口文件与一级目录。子目录内部清单见其余分片。

| ID | 路径 | 用途 | 写者 | 入口 | → 权威树 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-001 | Cargo.toml | Rust 工作空间清单：90 个成员 crate、依赖/特性、bin 目标 | 人 | Cargo.toml | — | as-built | def:同指针 | → Cargo.toml |
| D-002 | Cargo.lock | 依赖精确锁定，保证可复现构建 | 生成器 | Cargo.lock | — | as-built | def:同指针 | → Cargo.lock |
| D-003 | README.md | 项目门面：功能总览、安装、快捷键、截图 | 人 | README.md | — | as-built | TODO | → README.md |
| D-004 | CONTRIBUTING.md | 贡献指南：issue/PR 流程与复现要求 | 人 | CONTRIBUTING.md | — | as-built | TODO | → CONTRIBUTING.md |
| D-005 | RELEASING.md | 双发布路径：本地快发与 CI 全量发版 | 人 | RELEASING.md | — | as-built | TODO | → RELEASING.md |
| D-006 | LICENSE | MIT 许可文本 | 人 | LICENSE | — | as-built | def:同指针 | → LICENSE |
| D-007 | OAUTH.md | OAuth 与 API-key 鉴权方式、凭据优先级 | 人 | OAUTH.md | ontology:AUTH_CREDENTIAL_SOURCES | as-built | TODO | → OAUTH.md |
| D-008 | TELEMETRY.md | 匿名遥测采集范围、开关与 transcript 分享政策 | 人 | TELEMETRY.md | business-rules:遥测隐私边界 | as-built | TODO | → TELEMETRY.md |
| D-009 | AGENTS.md.bak | 仓库级 agent 守则历史副本（现行版已移除） | 人 | AGENTS.md.bak | — | as-built | def:同指针 | → AGENTS.md.bak |
| D-010 | .gitattributes | 行尾/二进制/LFS 属性规则 | 人 | .gitattributes | — | as-built | def:同指针 | → .gitattributes |
| D-011 | .gitignore | Rust+Node 混合仓库的忽略规则总表 | 人 | .gitignore | — | as-built | def:同指针 | → .gitignore |
| D-012 | .gitignore.plm-app | PLM 前端后端构建产物补充忽略规则 | 人 | .gitignore.plm-app | — | as-built | def:同指针 | → .gitignore.plm-app |
| D-013 | score_shard.py | 对导出 transcript 分片做质量打分的一次性分析脚本 | agent | score_shard.py | — | as-built | def:同指针 | → score_shard.py |
| D-014 | plm-review-workbench-ui.mjs | PLM 评审工作台 UI 脚本占位（当前 0 字节） | 人 | plm-review-workbench-ui.mjs | — | as-built | def:同指针 | → plm-review-workbench-ui.mjs |
| D-015 | check.log / check2.log / probe.log | 一次性检查与探针运行日志残留 | 生成器 | check2.log | — | as-built | def:同指针 | → check2.log |
| D-016 | cbb-ui-screenshot.png | 根目录散落的界面截图残留（非 README 用图） | 生成器 | screenshot.png | — | as-built | def:同指针 | → cbb-ui-screenshot.png |
| D-017 | docs/ | 全部说明层文档：jcode 本体架构 + PLM/IPD 设计 | agent | docs/README.md | — | as-built | def:同指针 | → docs/ |
| D-018 | src/ | 根 crate `jcode`：main 入口、lib 门面、CLI 与附属 bin | 人 | src/main.rs | — | as-built | def:同指针 | → src/main.rs |
| D-019 | crates/ | 90 个拆分 crate：TUI、provider、harness-api、desktop2 等 | 人 | crates/jcode-harness-api/Cargo.toml | — | as-built | def:同指针 | → crates/jcode-harness-api/Cargo.toml |
| D-020 | sdk/ | 对外 SDK：TypeScript 客户端与 npm 平台二进制包 | 人 | sdk/typescript/README.md | interfaces:Harness API | as-built | def:同指针 | → sdk/typescript/ |
| D-021 | tests/ | 跨 crate 集成测试：e2e 场景、provider 矩阵、黄金截图 | 人 | tests/e2e/main.rs | — | as-built | def:同指针 | → tests/e2e/main.rs |
| D-022 | ipd/ | IPD 研发管理平台：plm-app 前后端、agents、知识库、部署 | 人 | ipd/README.md | — | as-built | def:同指针 | → ipd/ |
| D-023 | ios/ | Swift 实现的 jcode 移动端（Sources/TestHarness/Tests） | 人 | ios/Package.swift | — | as-built | def:同指针 | → ios/Package.swift |
| D-024 | telemetry-worker/ | Cloudflare Worker（SQL-over-HTTP，**无 `src/` 目录**）：接收匿名遥测并出 SQL 看板 | 人 | telemetry-worker/wrangler.toml | — | as-built | def:同指针 | → telemetry-worker/wrangler.toml |
| D-025 | scripts/ | 脚本库：基准、门禁预算、复现、安装与发布脚本 | 人 | scripts/install.sh | — | as-built | def:同指针 | → scripts/install.sh |
| D-026 | tools/ | 文档工具：Markdown 转 PDF 导出脚本 | 人 | tools/Export-MarkdownToPdf.ps1 | — | as-built | def:同指针 | → tools/Export-MarkdownToPdf.ps1 |
| D-027 | changelog/ | 每版本发布说明 JSON 与汇总索引，供更新界面读取 | 生成器 | changelog/index.json | — | as-built | def:同指针 | → changelog/index.json |
| D-028 | assets/ | README 与打包用素材：图标、演示时间线、架构配图 | 人 | assets/app-icons/Jcode.icns | — | as-built | def:同指针 | → assets/app-icons/Jcode.icns |
| D-029 | .github/ | CI 流水线与协作策略：10 个 workflow + 3 个脚本 | CI | .github/workflows/ci.yml | — | as-built | def:同指针 | → .github/workflows/ci.yml |
| D-030 | .cargo/ | Cargo 构建配置（构建器/链接器选择，CI 会覆盖） | 人 | .cargo/config.toml | — | as-built | def:同指针 | → .cargo/config.toml |
| D-031 | .claude/ | Claude Code 侧的项目配置：MCP 服务器清单 | 人 | .claude/mcp.json | — | as-built | def:同指针 | → .claude/mcp.json |
| D-032 | .jcode/ | jcode 自身的项目级配置：skills 与迁移规格 | 人 | .jcode/semantic-todo-migration-spec.md | — | as-built | def:同指针 | → .jcode/ |
| D-033 | .creature/ | creature 电容器（多技能工作记忆/电容），非人维护，仅登记不改 | 外部系统 | .creature/kb/ | — | as-built | def:同指针 | → .creature/kb/ |
| D-034 | .codegraph/ | 代码图索引产物，供检索工具查询 | 生成器 | .codegraph/ | — | as-built | def:同指针 | → .codegraph/ |
| D-035 | raw-req-ref/ | 原始需求参考资料快照，只读归档 | 外部系统 | raw-req-ref/ | — | as-built | def:同指针 | → raw-req-ref/ |
| D-036 | .tmp/ / .verify/ | 临时与验证中间产物目录，可随时删除重建 | 生成器 | .tmp/ | — | as-built | def:同指针 | → .tmp/ |
| D-037 | target/ | Cargo 构建输出目录，可重建 | 生成器 | target/ | — | as-built | def:同指针 | → target/ |
