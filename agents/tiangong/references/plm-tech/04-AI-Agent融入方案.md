# 04 · AI Agent 融入方案（基于 DeepSeek Harness）

> 定位：将 ADR-8（Agent + RAG + 工具网关 + 可信治理）落实为**基于 DeepSeek Harness（DSH）的可实施架构**。
> 输入：`docs/plm-design/05-技术架构设计.md` §7 AI 技术架构、`04-应用架构设计.md` §5 AI 服务层。
> 核心约束：BR-20——AI 产出永远为"草案/建议"，不得成为签署人；AI 介入全程留痕。

> **实现栈对齐（2026-09-05，S0）**：本文档的 8 个领域 Agent（DSH subagent）+ MCP 工具网关 + RAG(pgvector) + 六铁律为完整目标架构（**计划 S6 落地**）。当前已就绪：**MCP 工具网关骨架**——`ipd/mcp/plm-service-adapter`（需求/项目域 6 工具，stdio，经 jcode 网关调用，权限穿透 user_from_env/scope_defs）；权限穿透机制与本文档 §3.2 一致（DSH env 身份声明 + MCP 网关委托门 V-037/V-055）。RAG/8 Agent/六铁律（T_AI_TRACE）留 S6，按 PoC-8/9 验证后引入。见 `phase-plan.md`。

---

## 1. 为什么选 DeepSeek Harness

### 1.1 DSH 能力与 PLM 需求映射

| PLM AI 需求 | DSH 原生能力 | 映射方式 |
|---|---|---|
| Agent 编排（多角色 Agent 协同） | `subagent`（并行委派）、`workflow`（批量编排）、`ralph`（fresh-agent 内省） | 每个领域 Agent = 一个 DSH subagent |
| 工具网关（查询/计算/文档生成/Resolver） | MCP 协议（Model Context Protocol） | PLM 工具注册为 MCP server，DSH Agent 通过 MCP 调用 |
| 权限穿透（用户身份携带） | env 身份声明（`IPD_IDENTITY_USER`+`IPD_IDENTITY_ROLES`） | 每个用户会话启动独立 Agent，env 注入身份 |
| 审计留痕 | 会话日志 + 自定义 T_AI_TRACE | DSH Agent 输出 + 自定义审计写入 |
| 上下文感知 | 会话上下文 + 自定义 GridContext 协议 | GridContext 注入 Agent prompt |
| 私有化推理 | vLLM + 企业大模型网关 | DSH 配置 provider 指向私有 vLLM 端点 |
| 知识库/RAG | 自定义 MCP 工具 + pgvector | RAG 检索注册为 MCP 工具 |

### 1.2 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLM AI Agent 架构                             │
│                                                                  │
│  [前端] AI 副驾面板 / 单元格 ✦ / Agent 任务监控                   │
│      │                                                           │
│      ▼                                                           │
│  [DeepSeek Harness] Agent 编排层                                  │
│      ├── 角色 Agent ×8（各域专家，subagent 并行）                  │
│      ├── workflow（批量编排：如变更分析五维并行）                   │
│      └── 上下文管理（GridContext + 会话历史）                     │
│      │                                                           │
│      ▼                                                           │
│  [MCP 工具网关] 统一工具调用层                                    │
│      ├── 查询工具（物料/BOM/需求/变更/追溯，经权限穿透）           │
│      ├── 计算工具（风险矩阵/RTM 覆盖率/统计）                     │
│      ├── 文档生成（注册文档骨架/DHF 成册/报告）                   │
│      ├── Resolver（逻辑 ID 解析→摘要+深链+权限过滤）              │
│      └── RAG 检索（pgvector + 知识图谱）                          │
│      │                                                           │
│      ▼                                                           │
│  [模型管理] DeepSeek V3/R1 + vLLM 私有化推理                     │
│      ├── 模型版本注册（纳入配置管理，升级视同软件变更）             │
│      ├── 性能与漂移监控                                          │
│      └── 灰度发布                                                │
│      │                                                           │
│      ▼                                                           │
│  [AI 审计] T_AI_TRACE（模型版本/prompt hash/上下文/采纳）         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 角色 Agent 定义（8 个领域 Agent）

> 对应 `04-应用架构设计.md` §5 Agent 编排器的角色 Agent 清单。

### 2.1 Agent 角色矩阵

| Agent | 能力边界 | 工具白名单 | 权限角色 | 典型场景 |
|---|---|---|---|---|
| **系统工程师 Agent** | 需求分解/RTM 维护/设计追溯 | requirement.*, trace.*, item.query | SYSTEM_ENG | J1 建料查重；需求分解建议 |
| **风险分析 Agent** | FMEA 生成/风险矩阵/措施闭环 | risk.*, fmea.*, requirement.link | RISK_MANAGER | FMEA 评分建议；风险控制措施推荐 |
| **RA Agent** | 注册影响评估/路径判定/文档组装 | registration.*, eco.query, item.query | RA | J2 注册维度评估；J4 注册文档骨架 |
| **变更分析 Agent** | 影响范围分析/五维评估初稿/任务包 | eco.*, item.query, bom.query, trace.whereUsed | DESIGN_OWNER | J2 五维评估初稿（核心 Agent） |
| **测试工程 Agent** | 回归用例推荐/测试报告/偏差分析 | test.*, trace.*, baseline.query | VERIFICATION_ENG | J2 V&V 维度评估；回归范围推荐 |
| **文档官 Agent** | DHF 成册/受控发布/一致性比对 | doc.*, dhf.assemble, baseline.query | DCC | J4 文档组装；J5 DHF 一键成册 |
| **供应链哨兵 Agent** | PCN 解析/影响清单/AVL 校验 | supplier.*, item.query, eco.create | SQE | J2 PCN 触发 ECR；供应商风险预警 |
| **投诉侦听 Agent** | 投诉聚类/趋势分析/转 ECR | complaint.*, eco.create, item.query | QE | J6 投诉聚类；同类投诉激增预警 |

### 2.2 Agent 注册（DSH subagent 模式）

每个 Agent 作为 DSH 的一个 subagent 注册，通过 MCP 协议调用 PLM 工具：

```yaml
# 变更分析 Agent 配置示例
agent: change-analysis-agent
description: "变更影响分析专家——自动生成五维评估初稿"
model: deepseek-v3
tools:
  - eco.query          # 查询 ECR/ECO
  - item.query        # 查询物料
  - bom.query         # 查询 BOM
  - bom.whereUsed     # where-used 反查
  - trace.whereUsed   # 追溯链反查
  - registration.checkPath  # 注册路径判定
  - erp.getInventory  # ERP 库存实时取数
  - resolver.resolve  # 逻辑 ID 解析
permissions:
  role: DESIGN_OWNER
  scope: [item:read, bom:read, eco:read, trace:read, registration:read]
prompt_template: |
  你是医疗器械 PLM 的变更分析专家。
  当前上下文：{grid_context}
  ECR 信息：{ecr_info}
  
  请分析以下内容并生成评估初稿：
  1. 波及物料/BOM/文档/软件清单（使用 bom.whereUsed）
  2. 注册影响判定（使用 registration.checkPath）
  3. 风险影响（是否引入新危险源）
  4. 回归测试范围（使用 trace.whereUsed 推荐受影响用例集）
  5. 制造影响（使用 erp.getInventory 查库存/在途）
  
  每条结论必须附带 📎 引用（PLM:TYPE:CODE#REV）。
  无引用不回答；无据可据时明确说"无法判断"。
```

### 2.3 变更分析 Agent 工作流（J2 核心）

```
ECR 提交
  → 变更分析 Agent 启动（DSH subagent）
  ├── 并行调用 5 个工具：
  │   ├── bom.whereUsed(affected_items) → 波及清单
  │   ├── registration.checkPath(items) → 注册路径判定
  │   ├── risk.queryHazards(items) → 风险影响
  │   ├── trace.whereUsed(items) → 回归用例集
  │   └── erp.getInventory(items) → 库存/在途
  │
  → 汇总生成五维评估初稿（结构化 JSON）
  → 每条结论附带 📎 引用
  → 写入 AI_GENERATED 状态建议对象
  → 通知相关人员"AI 初稿已生成，请核对"
  → 人工核对（网格视图，可增删行）→ 电子签 → 正式评估
```

**DSH workflow 实现**：
```javascript
// 变更分析 workflow（DSH workflow 脚本）
return await parallel([
  () => agent("使用 bom.whereUsed 分析波及清单", { schema: affectedItemsSchema }),
  () => agent("使用 registration.checkPath 判定注册路径", { schema: regPathSchema }),
  () => agent("分析风险影响", { schema: riskImpactSchema }),
  () => agent("推荐回归测试范围", { schema: testRangeSchema }),
  () => agent("查询 ERP 库存影响", { schema: mfgImpactSchema }),
]).then(results => {
  // 汇总五维评估初稿
  return assembleEvaluationDraft(results);
});
```

---

## 3. MCP 工具网关

### 3.1 工具注册架构

```
MCP Server (PLM Tools)
  ├── 查询工具
  │   ├── item.query        # 物料查询（经权限过滤）
  │   ├── bom.query         # BOM 查询
  │   ├── bom.whereUsed     # where-used 反查
  │   ├── requirement.query # 需求查询
  │   ├── eco.query         # 变更查询
  │   ├── trace.whereUsed   # 追溯链反查
  │   ├── trace.matrix      # RTM 矩阵
  │   └── baseline.query    # 基线查询
  ├── 计算工具
  │   ├── risk.calcMatrix   # 风险矩阵 S×P
  │   ├── rtm.coverage      # RTM 覆盖率
  │   └── stats.aggregate   # 统计聚合
  ├── 文档工具
  │   ├── doc.generate      # 文档生成
  │   ├── dhf.assemble      # DHF 成册
  │   └── doc.compare       # 一致性比对
  ├── 变更工具
  │   ├── eco.create        # 创建 ECR（AI 产出=草稿）
  │   └── eco.affectedList  # 受影响对象清单
  ├── Resolver
  │   └── resolver.resolve  # 逻辑 ID → 摘要+深链+权限
  └── RAG 检索
      ├── rag.search        # 知识库检索
      └── rag.cite          # 引用验证
```

### 3.2 权限穿透机制

**DSH env 身份声明**：
```bash
# 每个用户会话启动独立 Agent 进程
PLM_AGENT_USER=zhangming \
PLM_AGENT_ROLES=DESIGN_ENGINEER,PROJECT_MEMBER \
PLM_AGENT_ORG=ORG-SZ-F1 \
PLM_AGENT_PROJECT=P-102 \
dsh agent --config change-analysis-agent
```

**工具调用权限校验**：
```java
// MCP 工具调用前置权限校验
@McpTool(name = "item.query")
public List<Item> queryItems(@McpParam String filter) {
    // 1. 从 env 获取用户身份
    var userId = EnvContext.getUserId();      // zhangming
    var roles = EnvContext.getRoles();         // [DESIGN_ENGINEER, PROJECT_MEMBER]
    var orgId = EnvContext.getOrgId();         // ORG-SZ-F1

    // 2. 权限过滤前置（BR-20 铁律 5：权限先于智能）
    var aclFilter = aclService.buildFilter(userId, roles, orgId);

    // 3. 合并用户 filter + ACL filter
    var combined = Filter.and(filter, aclFilter);

    // 4. 查询（无权对象连"存在"都不透露）
    return itemRepo.query(combined);
}
```

### 3.3 Resolver（逻辑 ID 解析服务）

```java
@McpTool(name = "resolver.resolve")
public ResolveResult resolve(@McpParam String logicalId) {
    // PLM:ITEM:E-000123#B → 对象摘要+类型+深链路由+当前用户权限
    var parsed = LogicalId.parse(logicalId);  // {type=ITEM, code=E-000123, rev=B}
    var obj = repo.findByLogicalId(parsed);

    if (obj == null) {
        // Resolver 404 → AI 引用标红（无引用不回答的落地机制）
        return ResolveResult.notFound(logicalId);
    }

    // 权限过滤
    if (!aclService.canRead(currentUser(), obj)) {
        return ResolveResult.denied(logicalId);  // 无权不透露存在
    }

    return ResolveResult.ok()
        .summary(obj.getSummary())
        .type(obj.getType())
        .deepLink("/items/" + obj.getId())
        .permissions(aclService.getPermissions(currentUser(), obj))
        .build();
}
```

---

## 4. RAG 知识库

### 4.1 知识库组成

```
RAG 知识库
  ├── 产品知识图谱（物料/BOM/需求/风险/测试的关联图）
  ├── 法规标准库（21 CFR 820 / ISO 13485 / IEC 62304 / ISO 14971 条文）
  ├── 历史库
  │   ├── 历史 FMEA（同品类经验复用）
  │   ├── 历史变更（ECO 模式学习）
  │   └── 历史投诉（聚类模式）
  └── 文档库（DHF/DMR 文档全文索引）
```

### 4.2 向量存储（pgvector）

```sql
-- 知识库向量表
CREATE TABLE t_knowledge_chunk (
    id          BIGINT PRIMARY KEY,
    source_type VARCHAR(32),        -- 'REGULATION'/'FMEA'/'ECO'/'COMPLAINT'/'DOC'
    source_id   BIGINT,
    chunk_text  TEXT,               -- 文本块
    embedding   vector(1536),       -- 向量（DeepSeek embedding）
    metadata    JSONB,              -- {regulation: '21 CFR 820.30', section: '(e)'}
    acl_id      BIGINT              -- 权限过滤
);

-- 向量索引
CREATE INDEX idx_knowledge_vec ON t_knowledge_chunk
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 4.3 RAG 检索流程

```
用户问题 → DeepSeek embedding → pgvector 相似检索（top-k=10）
  → 权限过滤（acl_id 先过滤）
  → 重排序（相关性 + 权限 + 时效）
  → 拼接上下文 + 引用来源
  → DeepSeek V3 生成回答
  → 每条结论附带 📎 引用 chip
  → Resolver 验证引用（404 标红）
```

### 4.4 强制引用（无引用不回答）

**铁律 3 落地**：
```java
public String askAgent(String question, GridContext ctx) {
    // 1. RAG 检索
    var chunks = ragService.search(question, ctx, currentUser());
    
    if (chunks.isEmpty()) {
        // 无据可据 → 明确拒答
        return "根据现有知识库无法回答此问题。请补充相关信息或联系管理员。";
    }

    // 2. 构造 prompt（强制引用）
    var prompt = """
        基于以下知识库内容回答问题。每条结论必须标注来源引用。
        知识库内容：
        %s
        
        问题：%s
        
        要求：
        - 每条结论附带 📎 引用（PLM:TYPE:CODE#REV 或法规条款编号）
        - 无引用的内容不得输出
        - 无据可据时明确说"无法判断"
        """.formatted(chunks, question);

    // 3. 调用模型
    var answer = deepSeekClient.chat(prompt, ctx);

    // 4. 引用验证（Resolver 验证每个引用）
    var citations = extractCitations(answer);
    for (var cite : citations) {
        var resolved = resolver.resolve(cite);
        if (!resolved.isOk()) {
            // 标红无效引用
            answer = answer.replace(cite, cite + " ⚠️无效引用");
        }
    }

    // 5. AI 审计
    aiTraceService.record(question, answer, citations, modelVersion, ctx);

    return answer;
}
```

---

## 5. 上下文协议（AI 看得见用户正在看什么）

### 5.1 GridContext（设计文档 §7.2）

```typescript
interface GridContext {
  // 用户当前视图
  view_type: 'BOM_TREE' | 'ITEM_LIST' | 'ECO_AFFECTED' | 'REQ_MATRIX' | 'FMEA_SHEET' | ...;
  object_type: string;              // 'ITEM', 'ECO', 'REQ'
  
  // 筛选与排序状态
  filter_state: {
    class_id?: number;             // 分类筛选
    status?: string;               // 状态筛选
    custom?: Record<string, any>;  // 自定义筛选
  };
  
  // 选中的单元格（坐标体系）
  selected_cells: CellCoord[];     // [{obj_id, rev, attr_code}]
  
  // 聚焦对象
  focused_object?: LogicalID;      // PLM:ITEM:E-000123#B
  
  // 项目上下文（UI 原型项目上下文条）
  project_context?: {
    project_id: LogicalID;         // PLM:PROJ:R3
    phase: string;                 // 'G3'
    gate_progress: number;         // 0.92
  };
  
  // 用户身份
  user: {
    id: string;
    roles: string[];
    org_id: string;
  };
}
```

### 5.2 上下文注入

```javascript
// 前端：AI 副驾面板发送问题时携带上下文
const context = buildGridContext(gridApi, currentUser, projectContext);
const answer = await askAI(question, context);

// 后端：Agent 接收上下文，注入 prompt
function buildPrompt(question, context) {
  return `
    当前用户：${context.user.id}（${context.user.roles.join(',')}）
    当前视图：${context.view_type}（${context.object_type}）
    聚焦对象：${context.focused_object ?? '无'}
    筛选条件：${JSON.stringify(context.filter_state)}
    选中单元格：${context.selected_cells.length} 个
    
    问题：${question}
    
    请基于当前上下文回答。如需查看具体对象，使用 resolver.resolve。
  `;
}
```

---

## 6. 可信 AI 六条铁律的技术落地（BR-20）

| 铁律 | 技术机制 | 实现位置 |
|---|---|---|
| **AI 永远不是签署人** | AI 产出 = `AI_GENERATED` 状态建议对象；签署仅 `T_USER` 可完成（BR-04）；签名服务校验 `signer_id` 必须是真实用户 | 签名服务 + 状态机 |
| **AI 审计追踪** | `T_AI_TRACE` 全量记录：`{agent_id, model_ver, prompt_hash, context_snapshot, output_ref, human_action, approver_id}`；模型版本入配置管理 | AI 审计服务 |
| **无引用不回答** | RAG 强制引用 + Resolver 验证；无据可据明确拒答；无效引用标红 | RAG 服务 + Resolver |
| **确定性封装** | 合规判定 = LLM 理解 + **确定性规则引擎裁决**（温度=0）；如注册路径判定：LLM 理解变更描述 → 规则引擎判定 NMPA/FDA/MDR 路径 | 规则引擎 + LLM |
| **权限先于智能** | RAG/工具调用全程携带用户身份（env 声明）；先 ACL 过滤后检索；无权对象连"存在"都不透露 | MCP 工具网关 + ACL |
| **AI 功能验证** | GAMP5/CSA：冻结模型版本、定义预期用途、漂移监控、重大升级再验证；模型版本纳入配置管理 | 模型管理 + CSV 流程 |

### 6.1 确定性封装详解

**场景**：注册路径判定（J2 注册维度评估）

```
变更描述（自然语言）
  → LLM 理解（DeepSeek V3，温度=0.3）
    → 提取结构化信息：{changed_components, declared_items, markets}
  → 确定性规则引擎裁决（温度=0）
    → 规则 1：declared_items 变更 + market=NMPA + class=III → "许可变更"
    → 规则 2：declared_items 变更 + market=FDA + class=II → "30天通知"
    → 规则 3：declared_items 变更 + market=CE → "MDR重大变更判定"
  → 输出：注册路径判定结论 + 依据条款 + 📎 引用
```

**关键**：LLM 只做"理解"（提取结构化信息），不做"裁决"（合规结论由确定性规则引擎给出）——避免 AI 幻觉进入合规结论。

### 6.2 AI 审计表

```sql
CREATE TABLE t_ai_trace (
    id              BIGINT PRIMARY KEY,
    agent_id        VARCHAR(64) NOT NULL,       -- 'change-analysis-agent'
    model_ver       VARCHAR(32) NOT NULL,       -- 'deepseek-v3-2024-12'
    prompt_hash     VARCHAR(64) NOT NULL,       -- SHA-256(prompt)
    context_snapshot_id BIGINT,                  -- 上下文快照引用
    output_ref      VARCHAR(128),               -- 产出对象逻辑 ID
    output_status   VARCHAR(16) DEFAULT 'AI_GENERATED',
    human_action    VARCHAR(16),                -- ACCEPT/REJECT/MODIFY
    human_action_by BIGINT REFERENCES t_user(id),
    human_action_on TIMESTAMPTZ,
    created_on      TIMESTAMPTZ DEFAULT now()
);

-- WORM 存储：只增不改
ALTER TABLE t_ai_trace SET (autovacuum_enabled = true);
-- 应用层禁止 UPDATE/DELETE
```

---

## 7. 模型管理

### 7.1 模型版本注册

```sql
CREATE TABLE t_model_version (
    id              BIGINT PRIMARY KEY,
    model_code      VARCHAR(64) NOT NULL,       -- 'deepseek-v3'
    version         VARCHAR(32) NOT NULL,       -- '2024-12-20'
    endpoint        VARCHAR(256),               -- vLLM 端点或 API 网关
    is_active       BOOLEAN DEFAULT FALSE,
    validated_on    DATE,                       -- CSV 验证日期
    validation_report_id BIGINT,                -- 验证报告引用
    drift_threshold DECIMAL,                    -- 漂移告警阈值
    UNIQUE (model_code, version)
);
```

### 7.2 模型升级流程（视同软件变更）

```
新模型版本发布
  → 注册 t_model_version（is_active=false）
  → 验证环境生效
  → 定义预期用途 + 验证测试（GAMP5/CSA）
  → 漂移监控（与旧版本对比输出差异）
  → CCB 审批（模型升级 = 配置项变更）
  → 灰度发布（10% → 50% → 100%）
  → is_active=true，旧版本 is_active=false
  → 审计记录
```

### 7.3 私有化推理

```
企业数据中心 GPU 节点池
  ├── vLLM 推理服务（DeepSeek V3/R1 模型）
  ├── 负载均衡（GPU 节点 HPA）
  └── 队列削峰（Agent 长任务异步化）

DSH 配置：
  provider: custom
  base_url: http://vllm-service:8000/v1
  model: deepseek-v3
  api_key: ${VLLM_API_KEY}  # 内网，无需外部 API key
```

---

## 8. AI 副驾前端集成

### 8.1 三种 AI 介入形态（对应 UI 原型三模态 C）

| 形态 | 组件 | 触发 | UI 表现 |
|---|---|---|---|
| 单元格 ✦ | `<CellAIAction>` | 点击 ✦ 图标 | 浮层：查重/建议/判定 |
| 副驾面板 | `<AICopilotPanel>` | 右栏对话 | 对话+引用 chip+一键动作 |
| 任务级 Agent | `<AgentTaskView>` | 待办触发 | 待审网格视图（AI 产出→人确认） |

### 8.2 副驾面板组件

```typescript
// AI 副驾面板（对应 UI 原型右栏 280px）
function AICopilotPanel({ context }: { context: GridContext }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  async function ask(question: string) {
    setLoading(true);
    // 携带 GridContext 发送
    const answer = await api.askAI({ question, context });
    setMessages([...messages, 
      { role: 'user', content: question },
      { role: 'assistant', content: answer.text, citations: answer.citations }
    ]);
    setLoading(false);
  }

  return (
    <div className="w-[280px] border-l">
      <ChatHistory messages={messages} />
      <CitationChips citations={messages.flatMap(m => m.citations ?? [])} />
      <ChatInput onSend={ask} loading={loading} />
    </div>
  );
}
```

### 8.3 引用 chip 组件

```typescript
// 引用 chip（📎 PLM:TYPE:CODE#REV）
function CitationChip({ logicalId }: { logicalId: string }) {
  const [resolved, setResolved] = useState<ResolveResult | null>(null);

  useEffect(() => {
    api.resolve(logicalId).then(setResolved);
  }, [logicalId]);

  if (resolved?.status === 'not_found') {
    return <span className="text-red-500">📎 {logicalId} ⚠️无效引用</span>;
  }
  if (resolved?.status === 'denied') {
    return <span className="text-gray-400">📎 {logicalId}（无权限）</span>;
  }
  return (
    <a href={resolved?.deepLink} className="text-violet-600 hover:underline">
      📎 {logicalId}
    </a>
  );
}
```

---

## 9. Agent 长任务异步化

**场景**：变更分析 Agent 需调用 5 个工具并行查询，耗时 5~10s。

**方案**：
```
用户触发 Agent → 创建异步任务（T_AI_TASK）
  → 返回 task_id → 前端显示"AI 分析中..."
  → Agent 后台执行（DSH subagent）
  → 完成后 WebSocket 推送结果
  → 前端展示"AI 初稿已生成，请核对"
```

```sql
CREATE TABLE t_ai_task (
    id              BIGINT PRIMARY KEY,
    agent_id        VARCHAR(64) NOT NULL,
    trigger_type    VARCHAR(32),        -- 'ECR_SUBMITTED'/'COMPLAINT'/'MANUAL'
    trigger_ref     VARCHAR(128),       -- ECR-2025-0023
    status          VARCHAR(16),        -- RUNNING/COMPLETED/FAILED
    result_ref      VARCHAR(128),       -- 产出对象逻辑 ID
    started_on      TIMESTAMPTZ,
    completed_on    TIMESTAMPTZ
);
```

---

## 10. 性能 SLO

| 场景 | 指标 | 保障机制 |
|---|---|---|
| AI 问答（含 RAG） | P95 < 8s | 向量检索 < 1s + 模型推理 < 5s + 引用验证 < 1s + **传输与前端渲染余量 1s**（2026-09-17 裁定：原三项相加 7s、余量用途未写明属漏项；余量不得被前项挪用——任一环节超支即视为该环节超支，不得互相借用） |
| 引用命中率 | 100% | RAG 强制引用 + Resolver 验证 |
| Agent 长任务 | < 30s | 并行工具调用 + 异步化 |
| 单元格 ✦ 查重 | < 2s | 模糊匹配 + 缓存 |
| AI 副驾上下文构建 | < 100ms | GridContext 前端构建 |

---

## 11. 与 UI 原型的映射

| UI 原型 | AI 介入 | Agent | 实现方式 |
|---|---|---|---|
| 00 AI 工作台 | 副驾面板+待办 AI 卡 | 全部 Agent | 副驾对话+任务监控 |
| 01 物料库 | 单元格 ✦ 查重 | 系统工程师 Agent | 模糊匹配 |
| 02 BOM 编辑器 | ✦ 节点建议 | 变更分析 Agent | where-used 分析 |
| 03 变更详情 | 五维评估初稿 | 变更分析 Agent | workflow 并行 |
| 06 阶段门 | ✦ 催办建议 | — | AI 副驾 |
| J5 审核 | 自然语言查询 | 文档官 Agent | RAG+深链 |
| J6 投诉 | 聚类分析 | 投诉侦听 Agent | 聚类+趋势 |

*下一篇：[05-工作包拆解](05-工作包拆解.md)——8 模块 + 6 旅程 → WBS 工作包分解。*
