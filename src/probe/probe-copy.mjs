// 官方 Probe 页面文案（zh-CN，2026-09-03 从 bazaarlink.ai/probe JS 抽出）。
// 哈希类名不复用；只复用标签、筛选项和模式说明。

export const officialProbeCopy = {
  lang: "zh-CN",
  source: "https://bazaarlink.ai/probe",
  history: {
    filterUrlPlaceholder: "筛选 URL…",
    histColRelay: "中转站",
    histColModel: "模型",
    histColScore: "识别",
    histColStatus: "影响判定题数",
    histColScoreValue: "分数",
    histColTime: "时间",
    histBandAll: "全部",
    histBand80: "80+",
    histBand50: "50+",
    histBandBelow50: "<50",
    histBandRunning: "进行中",
    histEmpty: "没有符合筛选条件的记录",
    histQuickModeScoreLabel: "快速测试",
    histQuickModeNote: "快速模式跳过质量评分",
    histDeterminationCount: "{0} / {1} 题影响判定",
    histCoverageTooltip: "少数题目缺漏不是无法判定的原因；题目全到齐时仍约两成无法判定",
    quickModeInconclusiveTooltip: "完整检测可能可以判定",
    fullModeInconclusiveTooltip: "已完整检测，仍无法判定",
    histStatusInconclusive: "无法判定",
    histStatusRunning: "进行中",
    histStatusFailed: "检测失败",
    histIdentityMismatch: "模型不符 · ",
  },
  modes: [
    {
      id: "quick",
      label: "快速",
      summary: "只做身份判定。分数栏显示「快速测试」，影响判定题数显示「快速模式跳过质量评分」。",
      note: "快速模式跳过质量评分",
      extra: "完整检测可能可以判定",
    },
    {
      id: "full",
      label: "完整",
      summary: "执行 96 项标准测试与最多 2 项选用测试（最多 98 项），输出 0–100 评分。",
      extra: "已完整检测，仍无法判定",
    },
    {
      id: "deep",
      label: "深度",
      summary: "在完整检测之上再跑长上下文检查。",
      extra: "适合深挖质量 / 长上下文",
    },
  ],
  explanation: {
    heading: "判定说明",
    learnTabLabel: "我们如何判定",
    title: "LLM 中转站 / 反向代理 API 品质检测",
    body: "输入任何 OpenAI 相容的中转站或反向代理端点，执行 96 项标准测试与 2 项选用测试（最多 98 项），检查模型偷换、Token 膨胀、System Prompt 注入、依赖劫持、密钥窃取与签名篡改，并输出 0–100 评分。",
    coverage: "少数题目缺漏不是无法判定的原因；题目全到齐时仍约两成无法判定",
  },
};

export function modelIdsFrom(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.models || payload?.data || payload?.items || [];
  return [...new Set(list.map((item) => {
    if (typeof item === "string") return item.trim();
    return String(item?.modelId || item?.id || item?.name || "").trim();
  }).filter(Boolean))];
}
