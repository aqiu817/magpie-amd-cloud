// GET /v1/models 目录条目 → magpie/OpenCode Model 的映射。纯函数，便于单测。
//
// Radeon Cloud 的模型目录随时会变（官方明确要求运行时解析、不写死模型名），
// FALLBACK_MODELS 只是拉不到目录时的兜底，字段取自官方文档 2026-11 的当前目录。
// limit.output 为保守假设：官方未公布各模型的最大输出 token 数。

export const FALLBACK_MODELS = {
  "DeepSeek-V4-Flash": {
    name: "DeepSeek-V4-Flash",
    limit: { context: 1048576, output: 16384 },
    reasoning: true,
    tool_call: true,
    variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
    cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
  },
  "Qwen3.8-Flash-Next": {
    name: "Qwen3.8-Flash-Next",
    limit: { context: 262144, output: 16384 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    variants: { none: {}, low: {}, medium: {}, xhigh: {} },
    cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
  },
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 目录 pricing 是每 token 的美元价（字符串小数）；magpie cost 是每百万 token 的美元价。
export function perMillion(v) {
  const n = num(v)
  return n == null ? null : Math.round(n * 1e12) / 1e6
}

// 单个目录条目 → Model。base 是静态表 / models.dev 里的同名模型，同名字段以目录为准，
// 目录没给的（variants、output 上限）沿用 base。
export function entryToModel(entry, base) {
  const prov = Array.isArray(entry?.providers) && entry.providers[0] ? entry.providers[0] : {}
  const arch = entry?.architecture ?? {}
  const pricing = entry?.pricing ?? prov.pricing ?? {}
  const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : null

  const model = {
    ...(base ?? {}),
    id: entry.id,
    name: entry.name ?? entry.id,
    limit: {
      // 目录里 0 视为未知（内部服务条目都这样），落到 base 或保守默认
      context: num(entry?.context_length) || base?.limit?.context || 131072,
      output: base?.limit?.output ?? 16384,
    },
    reasoning: prov.reasoning ?? base?.reasoning ?? false,
    tool_call: prov.tools ?? base?.tool_call ?? false,
  }

  if (inputs && inputs.some((m) => m !== "text")) {
    model.modalities = { input: inputs, output: arch.output_modalities ?? ["text"] }
  } else {
    delete model.modalities
  }

  const cost = {}
  const input = perMillion(pricing.prompt)
  const output = perMillion(pricing.completion)
  const cacheRead = perMillion(pricing.input_cache_read)
  if (input != null) cost.input = input
  if (output != null) cost.output = output
  if (cacheRead != null) cost.cache_read = cacheRead
  if (Object.keys(cost).length) model.cost = cost
  else delete model.cost

  if (entry?.free === true) model.free = true
  else if (entry?.free === false) delete model.free

  if (entry?.stability === "deprecated") model.status = "deprecated"

  return model
}

// 目录会混着 Model Ops 的内部路由/决策服务（output=decision）、语音（audio）和
// 文档解析（ocr）等非聊天模型——它们的 supported_parameters 为空、输出不是文本，
// 没法当 chat completions 模型用。这里只收能聊天的条目。
export function isChatModel(entry) {
  const out = entry?.architecture?.output_modalities
  if (Array.isArray(out) && out.length && !out.includes("text")) return false
  const params = entry?.supported_parameters
  if (Array.isArray(params) && params.length === 0) return false
  return true
}

// 整个 /v1/models 响应 → { id: Model }。空目录视为异常，由调用方兜底回静态表。
export function catalogToModels(payload, providerModels = {}) {
  const list = Array.isArray(payload?.data) ? payload.data : []
  if (!list.length) throw new Error("catalog is empty")
  const out = {}
  for (const entry of list) {
    if (entry?.id && isChatModel(entry)) out[entry.id] = entryToModel(entry, providerModels[entry.id])
  }
  if (!Object.keys(out).length) throw new Error("catalog has no chat models")
  return out
}
