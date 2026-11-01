// magpie-amd-cloud 单测：映射函数以官方文档样例 JSON 为 fixture，网络测试用桩替换 globalThis.fetch。
// 运行：node --test test/

import test from "node:test"
import assert from "node:assert/strict"

import { FALLBACK_MODELS, catalogToModels, entryToModel, isChatModel, perMillion } from "../lib/catalog.mjs"
import { usageToMagpie } from "../lib/usage.mjs"
import {
  MODEL_API_BASE,
  PLATFORM_API_BASE,
  USER_AGENT,
  fetchJSON,
} from "../lib/platform.mjs"

// ---------- fixtures（逐字段取自 radeon-cloud-docs 的样例响应） ----------

const DOC_MODEL_ENTRY = {
  id: "DeepSeek-V4-Flash",
  name: "DeepSeek-V4-Flash",
  aliases: [],
  description: "Radeon DeepSeek V4 Flash served by the AMD GPU Cloud",
  family: "deepseek",
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
    tokenizer: "GPT",
  },
  top_provider: { is_moderated: true },
  providers: [
    {
      providerId: "radeon-deepseek",
      externalId: "DeepSeek-V4-Flash",
      pricing: {
        prompt: "0.00000014",
        completion: "0.00000028",
        input_cache_read: "0.0000000028",
      },
      streaming: true,
      vision: false,
      tools: true,
      reasoning: true,
      stability: "stable",
    },
  ],
  pricing: {
    prompt: "0.00000014",
    completion: "0.00000028",
    input_cache_read: "0.0000000028",
  },
  context_length: 1048576,
  supported_parameters: [
    "temperature",
    "max_tokens",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "stream",
    "response_format",
    "tools",
  ],
  json_output: true,
  structured_outputs: true,
  free: true,
  stability: "stable",
}

// ---------- platform ----------

test("addresses match the official docs", () => {
  assert.equal(MODEL_API_BASE, "https://developer.amd.com.cn/radeon/api/v1")
  assert.equal(PLATFORM_API_BASE, "https://radeon-global.anruicloud.com")
  assert.match(USER_AGENT, /^magpie-amd-cloud\//)
})

test("fetchJSON sets Bearer and UA headers", async () => {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ pong: true }), { status: 200 })
  }
  try {
    const r = await fetchJSON("https://example.test/api", "rc-abc")
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.deepEqual(r.data, { pong: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get("authorization"), "Bearer rc-abc")
    assert.equal(calls[0].headers.get("user-agent"), USER_AGENT)
  } finally {
    globalThis.fetch = orig
  }
})

test("fetchJSON maps 4xx to ok:false with status", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "no" }), { status: 401 })
  try {
    const r = await fetchJSON("https://example.test/api", "rc-abc")
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
  } finally {
    globalThis.fetch = orig
  }
})

test("fetchJSON maps network failure to status 0", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  try {
    const r = await fetchJSON("https://example.test/api", "rc-abc")
    assert.equal(r.ok, false)
    assert.equal(r.status, 0)
    assert.match(r.error, /ECONNREFUSED/)
  } finally {
    globalThis.fetch = orig
  }
})

// ---------- catalog ----------

test("perMillion converts per-token USD to per-million USD", () => {
  assert.equal(perMillion("0.00000014"), 0.14)
  assert.equal(perMillion("0.00000028"), 0.28)
  assert.equal(perMillion("0.0000000028"), 0.0028)
  assert.equal(perMillion("bogus"), null)
  assert.equal(perMillion(undefined), null)
})

test("entryToModel maps the doc entry", () => {
  const m = entryToModel(DOC_MODEL_ENTRY)
  assert.equal(m.id, "DeepSeek-V4-Flash")
  assert.equal(m.name, "DeepSeek-V4-Flash")
  assert.equal(m.limit.context, 1048576)
  assert.equal(m.reasoning, true)
  assert.equal(m.tool_call, true)
  assert.deepEqual(m.cost, { input: 0.14, output: 0.28, cache_read: 0.0028 })
  assert.equal(m.free, true)
  assert.equal(m.status, undefined)
  // 纯文本模型不应带 modalities
  assert.equal(m.modalities, undefined)
})

test("entryToModel keeps base variants and output limit, overrides context", () => {
  const base = FALLBACK_MODELS["DeepSeek-V4-Flash"]
  const m = entryToModel(DOC_MODEL_ENTRY, base)
  assert.deepEqual(m.variants, base.variants)
  assert.equal(m.limit.output, 16384)
  assert.equal(m.limit.context, 1048576)
})

test("entryToModel flags image input and deprecated stability", () => {
  const m = entryToModel({
    id: "X",
    context_length: 1000,
    stability: "deprecated",
    free: false,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    providers: [{ tools: true, reasoning: false, vision: true }],
  })
  assert.deepEqual(m.modalities.input, ["text", "image"])
  assert.equal(m.status, "deprecated")
  assert.equal(m.free, undefined)
  assert.equal(m.reasoning, false)
  assert.equal(m.tool_call, true)
})

test("entryToModel: base capabilities kept when catalog omits providers; explicit catalog values win", () => {
  const base = { ...FALLBACK_MODELS["Qwen3.8-Flash-Next"], free: true }
  // providers 缺失 → 沿用 base 的能力位
  const m = entryToModel(
    {
      id: "Qwen3.8-Flash-Next",
      context_length: 262144,
      free: false,
      architecture: { input_modalities: ["text"] },
      providers: [],
    },
    base,
  )
  assert.equal(m.free, undefined)
  assert.equal(m.modalities, undefined)
  assert.equal(m.reasoning, true)
  // providers 显式给出 false → 以目录为准
  const m2 = entryToModel(
    { id: "X", providers: [{ tools: false, reasoning: false }] },
    { reasoning: true, tool_call: true },
  )
  assert.equal(m2.reasoning, false)
  assert.equal(m2.tool_call, false)
})

test("catalogToModels keys by id and throws on empty", () => {
  const models = catalogToModels({ data: [DOC_MODEL_ENTRY] }, FALLBACK_MODELS)
  assert.deepEqual(Object.keys(models), ["DeepSeek-V4-Flash"])
  assert.throws(() => catalogToModels({ data: [] }), /catalog is empty/)
  assert.throws(() => catalogToModels(null), /catalog is empty/)
})

test("fallback models cover the two documented models", () => {
  assert.deepEqual(Object.keys(FALLBACK_MODELS).sort(), ["DeepSeek-V4-Flash", "Qwen3.8-Flash-Next"])
  assert.equal(FALLBACK_MODELS["DeepSeek-V4-Flash"].limit.context, 1048576)
  assert.equal(FALLBACK_MODELS["Qwen3.8-Flash-Next"].limit.context, 262144)
  assert.deepEqual(FALLBACK_MODELS["Qwen3.8-Flash-Next"].modalities.input, ["text", "image"])
  // 实时目录 free 全为 false（调用按定价计入每日额度），兜底表不应声称免费
  assert.equal(FALLBACK_MODELS["DeepSeek-V4-Flash"].free, undefined)
  assert.equal(FALLBACK_MODELS["Qwen3.8-Flash-Next"].free, undefined)
  // 实时目录两家同价（2026-11 对账）：$0.14 / $0.28 每百万
  assert.deepEqual(FALLBACK_MODELS["Qwen3.8-Flash-Next"].cost, { input: 0.14, output: 0.28, cache_read: 0.0028 })
})

// ---------- 实时目录的过滤与边界（2026-11-01 真实目录对账） ----------

test("isChatModel filters aux-router / audio / ocr services", () => {
  // Clef/d3/d3-flash：Model Ops 内部决策服务
  assert.equal(isChatModel({ id: "Clef", supported_parameters: [], architecture: { output_modalities: ["decision"] } }), false)
  // OmniVoice：语音
  assert.equal(isChatModel({ id: "OmniVoice", supported_parameters: [], architecture: { output_modalities: ["audio"] } }), false)
  // MinerU2.5-Pro：文档解析（输出 ocr，无接受参数）
  assert.equal(isChatModel({ id: "MinerU2.5-Pro", supported_parameters: [], architecture: { output_modalities: ["ocr"] } }), false)
  // 正常聊天模型
  assert.equal(isChatModel({ id: "X", supported_parameters: ["temperature", "tools"], architecture: { output_modalities: ["text"] } }), true)
  // 字段缺失时不误杀
  assert.equal(isChatModel({ id: "Y" }), true)
})

test("catalogToModels drops non-chat entries and keeps chat models", () => {
  const models = catalogToModels(
    {
      data: [
        DOC_MODEL_ENTRY,
        { id: "OmniVoice", supported_parameters: [], architecture: { output_modalities: ["audio"] } },
      ],
    },
    FALLBACK_MODELS,
  )
  assert.deepEqual(Object.keys(models), ["DeepSeek-V4-Flash"])
  assert.throws(() => catalogToModels({ data: [{ id: "Clef", supported_parameters: [] }] }), /no chat models/)
})

test("entryToModel treats context_length 0 as unknown", () => {
  const m = entryToModel({ id: "X", context_length: 0, supported_parameters: ["tools"] })
  assert.equal(m.limit.context, 131072)
  const m2 = entryToModel({ id: "X", context_length: 0, supported_parameters: ["tools"] }, FALLBACK_MODELS["DeepSeek-V4-Flash"])
  assert.equal(m2.limit.context, 1048576)
})

// ---------- usage ----------

// 2026-11-01 真实密钥实测的 /v1/usage 响应（节选，字段名逐字保留）
const LIVE_USAGE_OK = {
  organization_id: "oneclick-org-13126",
  project_id: "oneclick-project-13126",
  rpm_limit: 20,
  daily_cost_limit_usd: 1,
  daily_cost_used_usd: 0.003631599933896723,
  daily_cost_remaining_usd: 0.9963684000661033,
  daily_reset_timezone: null,
  daily_reset_at: "2026-11-02T10:04:33.114Z",
  daily_reset_epoch: 1793613873,
  period_started_at: "2026-11-01T10:04:33.114Z",
  period_duration_value: 1,
  period_duration_unit: "day",
  window_hours: 24,
  today: { requests: 3, errors: 0, total_tokens: 12897, cost: 0.003631599945947528 },
  all_time: { requests: 140, errors: 12, total_tokens: 6001854, cost: 0.6166182160377502 },
  by_model: [{ model: "DeepSeek-V4-Flash", requests: 1, total_tokens: 15 }],
}

test("usageToMagpie maps the live /v1/usage response to a rolling window", () => {
  const u = usageToMagpie(LIVE_USAGE_OK)
  assert.equal(u.plan, "AMD Cloud")
  assert.equal(u.user, "oneclick-org-13126")
  assert.equal(u.windows.length, 1)
  const w = u.windows[0]
  assert.equal(w.name, "花费（24h 滚动）")
  assert.equal(w.used, 0.4)
  assert.equal(w.limit, 1)
  assert.equal(w.amount, 0.003631599933896723)
  assert.equal(w.unit, "USD")
  assert.equal(w.span, 86400)
  assert.equal(w.resetsAt, "2026-11-02T10:04:33.114Z")
  assert.equal(w.display, "$0.0036 / $1")
})

test("usageToMagpie labels non-24h rolling windows", () => {
  const w = usageToMagpie({ ...LIVE_USAGE_OK, window_hours: 12, daily_cost_used_usd: 0.5 }).windows[0]
  assert.equal(w.name, "花费（12h 滚动）")
  assert.equal(w.span, 43200)
  assert.equal(w.used, 50)
})

test("usageToMagpie falls back to epoch reset when ISO missing", () => {
  const w = usageToMagpie({ ...LIVE_USAGE_OK, daily_reset_at: undefined }).windows[0]
  assert.equal(w.resetsAt, 1793613873 * 1000)
})

test("usageToMagpie over 100% stays over 100%", () => {
  const w = usageToMagpie({ ...LIVE_USAGE_OK, daily_cost_used_usd: 12 }).windows[0]
  assert.equal(w.used, 1200)
})

test("usageToMagpie handles zero limit", () => {
  const u = usageToMagpie({ ...LIVE_USAGE_OK, daily_cost_limit_usd: 0 })
  assert.deepEqual(u.windows, [])
  assert.equal(u.user, "oneclick-org-13126")
})

test("usageToMagpie maps service statuses to readable errors", () => {
  assert.match(usageToMagpie({ status: "not_configured" }).error, /尚未签发 API 密钥/)
  assert.match(usageToMagpie({ status: "not_available" }).error, /暂不可用/)
  assert.match(usageToMagpie({ status: "weird" }).error, /weird/)
})

test("usageToMagpie guards empty payloads", () => {
  for (const bad of [null, undefined, "x", 42]) {
    assert.match(usageToMagpie(bad).error, /响应为空/)
  }
})
