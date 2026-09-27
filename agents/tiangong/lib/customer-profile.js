// agents/tiangong/lib/customer-profile.js
//
// 小天没有"跨会话客户档案"这个数据源 —— 这是**有意的空实现**，不是遗漏。
//
// 背景：框架的 `runWithProfile` 会按 `libDir` 加载 `customer-profile.js` 并调用 `loadProfileText()`，
// 用它给本轮消息拼一段"已知客户档案"尾部（君无忧用它避免反复问地址/电话）。
// 小天这边没有对应的业务后端：PLM 的使用者身份、角色、项目都在 PLM 系统里，
// 由 `plm_whoami_plm` / `plm_whoami` 两个工具**按需查询**，不该每轮都灌进提示词。
//
// 为什么仍要留这个文件（而不是让它继续缺失）：
//   缺失时框架会打 `Profile load failed; continuing without profile` 警告 —— 那是**降级路径的告警**，
//   用来暴露"本该有档案却加载不到"的真故障。让一个已知的空能力长期占用那条告警，
//   会让真正的档案故障淹没在噪音里（本项目的经典失败形态：告警一多就没人看）。
//   提供空实现之后：警告消失，"档案为空"变成显式事实而不是异常。
//
// 返回空串 = "本轮没有档案可注入"。渠道后缀由框架自己拼（`buildChannelSuffix`），不经本文件。
export async function loadProfileText(_identity) {
  return "";
}

export default { loadProfileText };
