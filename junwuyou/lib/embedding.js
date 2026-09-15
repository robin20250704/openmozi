// embedding.js — BGE-small-zh-v1.5 + bge-reranker-base ONNX 推理（L-026 强制降级）
// 设计参考：jcode-embedding Embedder + CrossEncoder（Rust crate，借设计不借代码）
//
// 模型路径：
//   BGE_EMBED_PATH  (默认 /home/mozi/.mozi/models/bge-small-zh-v1.5)
//   BGE_RERANK_PATH (默认 /home/mozi/.mozi/models/bge-reranker-base)
//
// 运行时：
//   P1 阶段：onnxruntime-node（CPU ONNX Runtime）
//   P2 阶段：可选 ONNX Runtime GPU（DirectML / CUDA）
//
// 加载失败：写入 unavailable 标志，不抛错；fa-search-engine 调用时跳过 L4/L5

import path from "node:path";
import fs from "node:fs";

const EMBED_PATH = process.env.BGE_EMBED_PATH || "/home/mozi/.mozi/models/bge-small-zh-v1.5";
const RERANK_PATH = process.env.BGE_RERANK_PATH || "/home/mozi/.mozi/models/bge-reranker-base";

let embedder = null;
let reranker = null;
let embedderAttempted = false;
let rerankerAttempted = false;

function exists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * L-044: 解析 ONNX 模型文件路径——兼容两种常见布局
 *  - HuggingFace 原始导出：<modelDir>/onnx/model.onnx
 *  - 扁平/量化导出：<modelDir>/model.onnx（本机 .mozi/models 即此布局）
 * 之前硬编码 "onnx/model.onnx"，而实际模型在根目录 → 加载必然失败（向量层静默降级）
 */
function resolveOnnxFile(modelDir) {
  const candidates = [
    path.join(modelDir, "onnx", "model.onnx"),
    path.join(modelDir, "model.onnx"),
    path.join(modelDir, "onnx", "model_quantized.onnx"),
    path.join(modelDir, "model_quantized.onnx"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  throw new Error(`no onnx model file found in ${modelDir} (tried: ${candidates.map((c) => path.basename(c)).join(", ")})`);
}

/**
 * L-044: 加载 tokenizer（强制离线，且正确指向本地模型目录）
 *
 * 踩坑记录：@xenova/transformers v2 的 getModelFile 内部固定做
 *   localPath = pathJoin(env.localModelPath, path_or_repo_id, filename)
 * 即**永远**把 env.localModelPath 拼在最前。若直接传 Windows 绝对路径
 * （"C:/Users/.../bge-small-zh-v1.5"），会被当成 repo id 拼成
 *   models/C:/Users/.../tokenizer.json   → 找不到文件
 * 正确做法：env.localModelPath = 模型父目录，from_pretrained 只传目录名。
 */
async function loadTokenizer(modelDir) {
  const { AutoTokenizer, env } = await import("@xenova/transformers");
  env.allowLocalModels = true;
  env.allowRemoteModels = false; // 模型已在本地，禁止访问 HuggingFace（离线环境会 fetch failed）

  const parentDir = path.dirname(modelDir);
  const modelName = path.basename(modelDir);
  env.localModelPath = parentDir.endsWith("/") || parentDir.endsWith("\\") ? parentDir : parentDir + "/";

  return await AutoTokenizer.from_pretrained(modelName, { local_files_only: true });
}

/**
 * L-045: 把 tokenizer 输出转成 onnxruntime int64 张量数据
 * @xenova/transformers v2 输出 BigInt64Array（int64），旧代码用 Int32Array.from()
 * 转 BigInt 会抛 "Cannot convert a BigInt value to a number"；
 * 且 onnxruntime-node 的 "int64" 张量要求 BigInt64Array。
 */
function toInt64Data(v) {
  const arr = v && v.data ? v.data : v;
  if (arr instanceof BigInt64Array) return arr;
  const out = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = BigInt(arr[i]);
  return out;
}

// ========== Embedder ==========
class Embedder {
  constructor(session, tokenizer) {
    this.session = session;
    this.tokenizer = tokenizer;
    this.dim = 512;
  }

  static async load(modelDir) {
    if (!exists(modelDir)) throw new Error(`model dir not found: ${modelDir}`);
    // 动态 import：避免未安装 onnxruntime-node 时阻塞 plugin 加载
    const ort = await import("onnxruntime-node");
    const tokenizer = await loadTokenizer(modelDir);
    const session = await ort.InferenceSession.create(resolveOnnxFile(modelDir), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return new Embedder(session, tokenizer);
  }

  async embed(text) {
    const inputs = await this.tokenizer(text, { padding: true, truncation: true, max_length: 512 });
    const ort = await import("onnxruntime-node");
    const feeds = {};
    // 仅喂模型实际声明的输入（避免多喂 token_type_ids 等导致报错）
    const declared = this.session.inputNames || [];
    for (const [k, v] of Object.entries(inputs)) {
      if (declared.length && !declared.includes(k)) continue;
      const arr = v && v.data ? v.data : v;
      feeds[k] = new ort.Tensor("int64", toInt64Data(arr), v.dims || [1, arr.length]);
    }
    const output = await this.session.run(feeds);
    // BGE 输出 last_hidden_state；按 [batch, seq, hidden] 取 [CLS] 位置做句向量
    const lastHidden = output.last_hidden_state || output[Object.keys(output)[0]];
    const data = lastHidden.data;
    const dims = lastHidden.dims;
    const hiddenDim = dims[dims.length - 1];
    const vec = new Float32Array(hiddenDim);
    for (let i = 0; i < hiddenDim; i++) vec[i] = data[i];
    // L2 normalize（cosine 距离要求单位向量）
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
    return Array.from(vec);
  }
}

// ========== Reranker ==========
class Reranker {
  constructor(session, tokenizer) {
    this.session = session;
    this.tokenizer = tokenizer;
  }

  static async load(modelDir) {
    if (!exists(modelDir)) throw new Error(`model dir not found: ${modelDir}`);
    const ort = await import("onnxruntime-node");
    const tokenizer = await loadTokenizer(modelDir);
    const session = await ort.InferenceSession.create(resolveOnnxFile(modelDir), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return new Reranker(session, tokenizer);
  }

  async score(query, passage) {
    // L-048: @xenova/transformers v2 的配对输入参数名是 **text_pair**（下划线），
    // 旧代码用 textPair（驼峰）会被静默忽略 → passage 从未进入模型 →
    // 同一文档任意两段得分完全相同（reranker 退化为只读 query）。
    const inputs = await this.tokenizer(query, {
      text_pair: passage,
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const ort = await import("onnxruntime-node");
    const feeds = {};
    // 仅喂模型实际声明的输入（bge-reranker 通常无 token_type_ids，多喂会报错）
    const declared = this.session.inputNames || [];
    for (const [k, v] of Object.entries(inputs)) {
      if (declared.length && !declared.includes(k)) continue;
      const arr = v && v.data ? v.data : v;
      feeds[k] = new ort.Tensor("int64", toInt64Data(arr), v.dims || [1, arr.length]);
    }
    const output = await this.session.run(feeds);
    const logits = output.logits || output[Object.keys(output)[0]];
    return Array.from(logits.data)[0];
  }
}

// ========== 单例 lazy load ==========
export async function getEmbedder() {
  if (embedder) return embedder;
  if (embedderAttempted) return null;
  embedderAttempted = true;
  try {
    embedder = await Embedder.load(EMBED_PATH);
    console.log(`[embedding] BGE embedder loaded: ${EMBED_PATH}`);
    return embedder;
  } catch (e) {
    console.error(`[embedding] BGE embedder FAILED (${EMBED_PATH}):`, e.message);
    return null;
  }
}

export async function getReranker() {
  if (reranker) return reranker;
  if (rerankerAttempted) return null;
  rerankerAttempted = true;
  try {
    reranker = await Reranker.load(RERANK_PATH);
    console.log(`[embedding] BGE reranker loaded: ${RERANK_PATH}`);
    return reranker;
  } catch (e) {
    console.error(`[embedding] BGE reranker FAILED (${RERANK_PATH}):`, e.message);
    return null;
  }
}

export function isEmbedderAvailable() {
  return embedder !== null;
}

export function isRerankerAvailable() {
  return reranker !== null;
}
