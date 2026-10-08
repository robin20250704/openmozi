#!/usr/bin/env node
// agents/tiangong/scripts/faq-digest.mjs — 人工整理 FAQ 的**唯一入口**（2026-09-28 新增）
//
// 小天能做的到"记候选"为止（append-only，见 tools/plm-faq-propose.js）；从候选到 faq.json
// 的那一步需要判断力，所以留给**人**，而这个脚本就是人做那一步时的读数面板：
//
//   node agents/tiangong/scripts/faq-digest.mjs            # 看聚类 + 达阈值的草稿
//   node agents/tiangong/scripts/faq-digest.mjs --json     # 机器可读
//   node agents/tiangong/scripts/faq-digest.mjs --threshold 5
//
// 它只读 53112（GET），**不会**写任何文件——合并由人手动改 data/faq.json 后重启后端。
//
// 为什么不做"一键并入"：并入意味着把若干次口语化答法固化成对外口径，这是编辑决定；
// 做成脚本只差一个 --apply，而那个开关迟早会被"我扫一下"点掉。阈值 + 草稿 + 人工，是刻意的慢。
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TIANGONG_API_URL || "http://127.0.0.1:53112";
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const thIdx = argv.indexOf("--threshold");
const threshold = thIdx >= 0 ? Number(argv[thIdx + 1]) : undefined;

/** 供人合并的 id 前缀：沿用现有 faq.json 的命名法（FAQ-<归类缩写>-NNN），中文类名回落为 FAQ-NEW */
const PREFIX = {
  "界面与页面": "FAQ-UI", "登录与身份": "FAQ-AUTH", "流程与状态": "FAQ-FLOW", "数据与字段": "FAQ-DATA",
  "导出与下载": "FAQ-EXP", "权限与治理": "FAQ-PERM", "术语与对象": "FAQ-TERM", "故障与排查": "FAQ-ERR",
};

async function main() {
  const url = new URL(`${BASE}/api/faq/candidates/digest`);
  if (threshold) url.searchParams.set("threshold", String(threshold));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`后端 ${res.status}：${BASE} 起没起？（先跑部署脚本）`);
  const d = await res.json();
  const live = await (await fetch(`${BASE}/health`)).json().catch(() => null);

  if (asJson) {
    console.log(JSON.stringify({ ...d, health: live }, null, 2));
    return;
  }

  console.log(`FAQ 候选摘要｜阈值 ${d.threshold} 种问法 / 归类｜候选 ${d.total} 条${d.malformed ? `｜坏行 ${d.malformed}（要查）` : ""}`);
  if (live) console.log(`知识库 ${live.faqCount} 条｜分类 ${live.categories} 个${live.sample_data ? "｜⚠ 示例数据" : ""}`);
  if (!d.total) {
    console.log("\n还没有候选。小天每答完一轮 PLM 事实会记一条——没有候选说明它还没被真正问过。");
    return;
  }

  // 重复提示要**两个分支都给**：大量重复往往出现在未达阈值的归类里（同一个问题被反复问），
  // 那正是人最容易把"一次提问"误读成"共性问题"的地方——只有 ready 分支提示等于没提示。
  const dupLine = (g) => g.events > g.distinct
    ? `  ⚠ 有 ${g.events - g.distinct} 次是同一问法的重复（客户重问 / 验收回归 / 机器人重连），过闸的是**问法种类**。`
    : "";

  if (d.ready.length) {
    console.log(`\n══ 已达阈值，可考虑合并（${d.ready.length} 类）══`);
    for (const g of d.ready) {
      console.log(`\n■ ${g.category}｜${g.events} 次提问 / ${g.distinct} 种问法｜首见 ${(g.first_asked_at ?? "").slice(0, 10)}`);
      console.log(dupLine(g));
      console.log(`  问法：\n${g.questions.map((q) => `    - ${q}`).join("\n")}`);
      console.log(`  草稿答案（逐条核对，冲突的条目要人工裁决）：\n${g.draft.answer.split("\n").map((l) => `    ${l}`).join("\n")}`);
      console.log(`  建议 id：${PREFIX[g.category] ?? "FAQ-NEW"}-<下一个序号>（keywords 取 ${JSON.stringify(g.draft.keywords)}）`);
    }
    console.log("\n合并步骤：核对草稿 → 改 data/faq.json → 重启 53112 → 用 plm_faq_search 抽查能否命中。");
  } else {
    console.log("\n还没有归类攒够阈值种数的问法。");
  }
  if (d.pending.length) {
    console.log(`\n进行中（未达阈值）：`);
    for (const p of d.pending) {
      console.log(`  - ${p.category}：${p.distinct}/${d.threshold} 种问法（还差 ${p.need} 种，共 ${p.events} 次提问）`);
      console.log(dupLine(p));
    }
  }
}

main().catch((e) => { console.error(`[faq-digest] ${e.message}`); process.exit(1); });