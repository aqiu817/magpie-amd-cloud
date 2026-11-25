// magpie-amd-cloud 单测：映射函数以官方文档样例 JSON 为 fixture，网络测试用桩替换 globalThis.fetch。
// 运行：node --test test/

import test from "node:test"
import assert from "node:assert/strict"

import {
  FALLBACK_MODELS,
  LAB_FALLBACK_MODELS,
  catalogToModels,
  entryToModel,
  isChatModel,
  perMillion,
} from "../lib/catalog.mjs"
import { usageToMagpie } from "../lib/usage.mjs"
import {
  recordCost,
  spentFor,
  costOfResponse,
  costOfStreamText,
  estimateWindow,
  setLedgerDir,
} from "../lib/points.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MODEL_API_BASE,
  PLATFORM_API_BASE,
  LAB_MODEL_API_BASE,
  LAB_CONSOLE_URL,
  LAB_PROFILE_URL,
  USER_AGENT,
  fetchJSON,
} from "../lib/platform.mjs"
// 入口的双插件工厂：真实验证两个供应商的钩子形状（不发网络请求）
import { AmdCloudPlugin, AmdCloudLabPlugin } from "../index.mjs"

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
  // 国际站 TokenLab（2026-11-13 真实 key 只读核实 + muse 实录）
  assert.equal(LAB_MODEL_API_BASE, "https://api.tokenlab.amd.com/v1")
  assert.equal(LAB_CONSOLE_URL, "https://notebooks.amd.com/tokenlab")
  assert.equal(LAB_PROFILE_URL, "https://notebooks.amd.com/profile")
  assert.match(USER_AGENT, /^magpie-amd-cloud\//)
})

// ---------- 双供应商工厂 ----------

test("factory produces two providers with distinct ids, names and bases", async () => {
  // magpie 契约：导出的函数被调用一次，返回 hooks
  const hooksCn = await AmdCloudPlugin()
  const hooksLab = await AmdCloudLabPlugin()

  assert.equal(hooksCn.auth.provider, "amd-cloud")
  assert.equal(hooksLab.auth.provider, "amd-cloud-lab")

  const cfgCn = {}
  const cfgLab = {}
  await hooksCn.config(cfgCn)
  await hooksLab.config(cfgLab)
  assert.equal(cfgCn.provider["amd-cloud"].api, MODEL_API_BASE)
  assert.equal(cfgLab.provider["amd-cloud-lab"].api, LAB_MODEL_API_BASE)
  assert.equal(cfgCn.provider["amd-cloud"].name, "AMD Cloud")
  assert.equal(cfgLab.provider["amd-cloud-lab"].name, "AMD Cloud Lab")

  // 兜底表各就各位
  assert.equal(Object.keys(cfgCn.provider["amd-cloud"].models).length, 2)
  assert.equal(Object.keys(cfgLab.provider["amd-cloud-lab"].models).length, 7)

  // lab 无用量端点：窗口来自本地预估（未记录请求时为空），并指向个人页
  const u = await hooksLab.auth.usage(async () => ({ type: "api", key: "factory-test-key" }))
  assert.deepEqual(u.windows, [])
  assert.match(u.error, /notebooks\.amd\.com\/profile/)
  assert.equal(u.plan, "AMD Cloud Lab")
  // 两站的 key 输入提示各按各的前缀
  assert.equal(hooksCn.auth.methods[0].placeholder, "rc-…")
  assert.equal(hooksLab.auth.methods[0].placeholder, "tl-…")

  // provider.models 未登录时原样返回
  const sentinel = { a: 1 }
  assert.equal(await hooksLab.provider.models(sentinel, {}), sentinel)
})

test("lab fallback pricing matches the console (2026-11-13)", () => {
  const lab = LAB_FALLBACK_MODELS
  // DeepSeek 双子：in/out 与 cache_read 三档中的前两档
  assert.deepEqual(lab["DeepSeek-V4-Flash"].cost, { input: 0.14, output: 0.28, cache_read: 0.0028 })
  assert.deepEqual(lab["DeepSeek-V4.1-Flash"].cost, { input: 0.28, output: 0.56, cache_read: 0.0056 })
  // 其余五家同价：0.035 / 0.07 / 0.0007
  for (const id of ["Gemma-4-31B-IT", "MiniCPM5-2B", "MiniCPM-V-4.7-1B", "MiniCPM-V-4.7-35B-A3B", "Qwen3.8-27B"]) {
    assert.deepEqual(lab[id].cost, { input: 0.035, output: 0.07, cache_read: 0.0007 }, id)
  }
  // VLM 标记（text+image）与控制台一致
  for (const id of ["DeepSeek-V4.1-Flash", "Gemma-4-31B-IT", "MiniCPM-V-4.7-1B", "MiniCPM-V-4.7-35B-A3B", "Qwen3.8-27B"]) {
    assert.deepEqual(lab[id].modalities.input, ["text", "image"], id)
  }
  assert.equal(lab["MiniCPM5-2B"].modalities, undefined)
  assert.equal(lab["DeepSeek-V4-Flash"].modalities, undefined)
})

test("entryToModel keeps base cost when catalog has no pricing (TokenLab shape)", () => {
  const labEntry = {
    id: "Gemma-4-31B-IT",
    context_length: 262144,
    supported_parameters: ["temperature", "tools"],
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    object: "model",
    owned_by: "amd",
    // 注意：无 pricing、无 providers 字段
  }
  const m = entryToModel(labEntry, LAB_FALLBACK_MODELS["Gemma-4-31B-IT"])
  assert.deepEqual(m.cost, { input: 0.035, output: 0.07, cache_read: 0.0007 })
  assert.equal(m.limit.context, 262144)
  assert.deepEqual(m.modalities.input, ["text", "image"])

  // 国内站目录给了 pricing 时仍以目录为准（回归）
  const cn = entryToModel(DOC_MODEL_ENTRY, FALLBACK_MODELS["DeepSeek-V4-Flash"])
  assert.deepEqual(cn.cost, { input: 0.14, output: 0.28, cache_read: 0.0028 })
})

// ---------- model catalog refresh ----------

const FALLBACK = { Fallback: { id: "Fallback" } }
const catalogResponse = (id) => Response.json({ data: [{ id }] })
const apiAuth = (key) => ({ auth: { type: "api", key } })

function modelServer(t, fetch) {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = Date.UTC(2026, 10, 24)
  globalThis.fetch = fetch
  Date.now = () => now
  t.after(() => {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  })
  return (ms) => { now += ms }
}

test("model catalog refreshes after 60 seconds and is isolated by site and key", async (t) => {
  const calls = []
  const advance = modelServer(t, async (url, { headers }) => {
    assert.ok([MODEL_API_BASE + "/models", LAB_MODEL_API_BASE + "/models"].includes(url))
    calls.push([url, headers.authorization])
    return catalogResponse("model-" + calls.length)
  })
  const cn = (await AmdCloudPlugin()).provider
  const lab = (await AmdCloudLabPlugin()).provider
  assert.deepEqual(await cn.models(FALLBACK, {}), FALLBACK)
  assert.equal(calls.length, 0)
  const list = async (provider, key) => Object.keys(await provider.models(FALLBACK, apiAuth(key)))

  assert.deepEqual(await list(cn, "cache-key-a"), ["model-1"])
  advance(59_999)
  assert.deepEqual(await list(cn, "cache-key-a"), ["model-1"])
  assert.deepEqual(await list(cn, "cache-key-b"), ["model-2"])
  assert.deepEqual(await list(lab, "cache-key-a"), ["model-3"])
  advance(1)
  assert.deepEqual(await list(cn, "cache-key-a"), ["model-4"])
  assert.deepEqual(calls, [
    [MODEL_API_BASE + "/models", "Bearer cache-key-a"],
    [MODEL_API_BASE + "/models", "Bearer cache-key-b"],
    [LAB_MODEL_API_BASE + "/models", "Bearer cache-key-a"],
    [MODEL_API_BASE + "/models", "Bearer cache-key-a"],
  ])
})

test("concurrent model queries share one request but keep each caller's model defaults", async (t) => {
  let requests = 0
  let release
  const paused = new Promise((resolve) => { release = resolve })
  modelServer(t, async () => {
    requests++
    await paused
    return catalogResponse("X")
  })
  const one = (await AmdCloudPlugin()).provider
  const two = (await AmdCloudPlugin()).provider
  const auth = apiAuth("parallel-key")
  const results = Promise.all([
    one.models({ X: { limit: { output: 4096 } } }, auth),
    two.models({ id: "amd-cloud", models: { X: { limit: { output: 8192 } } } }, auth),
    one.models(FALLBACK, auth),
  ])
  release()
  const models = await results
  assert.equal(requests, 1)
  assert.deepEqual(models.map((m) => m.X.limit.output), [4096, 8192, 16384])
})

test("429 serves the last good catalog throughout Retry-After without blocking chat or usage", async (t) => {
  let lists = 0
  const advance = modelServer(t, async (url) => {
    if (url === MODEL_API_BASE + "/chat/completions") return Response.json({ object: "chat.completion" })
    if (url === MODEL_API_BASE + "/usage") return Response.json({ status: "not_available" })
    assert.equal(url, MODEL_API_BASE + "/models")
    if (++lists === 2) return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
    return catalogResponse("model-" + lists)
  })
  const hooks = await AmdCloudPlugin()
  const auth = apiAuth("rate-limited-key")
  const list = async () => Object.keys(await hooks.provider.models(FALLBACK, auth))
  assert.deepEqual(await list(), ["model-1"])
  advance(60_000)
  assert.deepEqual(await Promise.all([list(), list(), list()]), [["model-1"], ["model-1"], ["model-1"]])
  const loader = await hooks.auth.loader(async () => auth.auth)
  const chat = await loader.fetch(MODEL_API_BASE + "/chat/completions", { method: "POST" })
  assert.equal((await chat.json()).object, "chat.completion")
  assert.match((await hooks.auth.usage(async () => auth.auth)).error, /暂不可用/)
  advance(119_999)
  assert.deepEqual(await list(), ["model-1"])
  assert.equal(lists, 2)
  advance(1)
  assert.deepEqual(await list(), ["model-3"])
})

const cold429Cases = [
  ["HTTP date", () => new Date(Date.now() + 90_000).toUTCString(), 90_000],
  ["missing header", () => null, 60_000],
  ["malformed header", () => "bad", 60_000],
  ["short delay", () => "5", 60_000],
]

for (const [name, header, delay] of cold429Cases) {
  test(`cold 429 with ${name} serves Magpie fallback until refresh is allowed`, async (t) => {
    let requests = 0
    const advance = modelServer(t, async () => {
      const retryAfter = header()
      if (++requests === 1) {
        return new Response(null, {
          status: 429,
          headers: retryAfter == null ? {} : { "Retry-After": retryAfter },
        })
      }
      return catalogResponse("recovered")
    })
    const { provider } = await AmdCloudLabPlugin()
    const supplied = { id: "amd-cloud-lab", models: FALLBACK }
    const list = () => provider.models(supplied, apiAuth("cold-" + name))
    assert.equal(await provider.models(supplied), FALLBACK)
    for (const elapsed of [0, delay - 1]) {
      advance(elapsed)
      const models = await list()
      assert.deepEqual(Object.keys(models), ["Fallback"])
      assert.equal(models[Symbol.for("magpie.fellBack")], true)
      assert.equal(requests, 1)
    }
    advance(1)
    assert.deepEqual(Object.keys(await list()), ["recovered"])
    assert.equal(requests, 2)
  })
}

test("invalid catalog responses neither replace the last good catalog nor trigger a request burst", async (t) => {
  let requests = 0
  const advance = modelServer(t, async () => {
    if (++requests === 2) return Response.json({ data: [] })
    if (requests === 3) return new Response(null, { status: 429, headers: { "Retry-After": "60" } })
    return catalogResponse("last-good")
  })
  const { provider } = await AmdCloudPlugin()
  const list = () => provider.models(FALLBACK, apiAuth("invalid-catalog-key"))
  assert.deepEqual(Object.keys(await list()), ["last-good"])
  advance(60_000)
  assert.equal(await list(), FALLBACK)
  assert.equal(await list(), FALLBACK)
  assert.equal(requests, 2)
  advance(60_000)
  assert.deepEqual(Object.keys(await list()), ["last-good"])
  assert.equal(requests, 3)
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
  assert.equal(w.name, "点数（24h 滚动）")
  assert.equal(w.used, 0.4)
  assert.equal(w.limit, 1)
  assert.equal(w.amount, 0.003631599933896723)
  // 控制台口径：点数（pts），非美元——1 pt ≡ 1 名义美元
  assert.equal(w.unit, "pts")
  assert.equal(w.display, "0.0036 / 1 pts")
  assert.equal(w.span, 86400)
  assert.equal(w.resetsAt, "2026-11-02T10:04:33.114Z")
})

test("usageToMagpie labels non-24h rolling windows", () => {
  const w = usageToMagpie({ ...LIVE_USAGE_OK, window_hours: 12, daily_cost_used_usd: 0.5 }).windows[0]
  assert.equal(w.name, "点数（12h 滚动）")
  assert.equal(w.span, 43200)
  assert.equal(w.used, 50)
  assert.equal(w.display, "0.5 / 1 pts")
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

// ---------- points 本地预估（lab：usage.cost 非标字段自记账） ----------

test("costOfResponse extracts usage.cost from the chat response (2026-11-13 实测形状)", () => {
  const body = {
    id: "d290c87d",
    object: "chat.completion",
    model: "Qwen3.8-27B",
    choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
    usage: {
      prompt_tokens: 53,
      completion_tokens: 8,
      reasoning_tokens: 8,
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.000002415,
    },
  }
  assert.equal(costOfResponse(body), 0.000002415)
  // 无 cost / 为 0 / 非法的响应
  assert.equal(costOfResponse({ usage: {} }), null)
  assert.equal(costOfResponse({ usage: { cost: 0 } }), null)
  assert.equal(costOfResponse({}), null)
  assert.equal(costOfResponse(null), null)
})

test("costOfStreamText finds cost in SSE chunks", () => {
  const sse = [
    'data: {"id":"x","choices":[{"delta":{"content":"he"}}]}',
    "",
    'data: {"id":"x","choices":[],"usage":{"prompt_tokens":53,"completion_tokens":8,"cost":2.415e-6}}',
    "",
    "data: [DONE]",
  ].join("\n")
  assert.equal(costOfStreamText(sse), 2.415e-6)
  // 无 usage 的流
  assert.equal(costOfStreamText('data: {"choices":[{}]}\n\n'), null)
})

test("recordCost accumulates per account and estimateWindow shapes the usage payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-points-"))
  try {
    setLedgerDir(dir)
    const acct = "test-acct-1"
    assert.equal(recordCost(acct, "Qwen3.8-27B", 0.000002415), true)
    assert.equal(recordCost(acct, "Qwen3.8-27B", 0.000002415), true)
    assert.equal(recordCost(acct, "DeepSeek-V4-Flash", 0.0001), true)
    // 非法值拒收
    assert.equal(recordCost(acct, "X", 0), false)
    assert.equal(recordCost(acct, "X", NaN), false)
    assert.equal(recordCost(acct, "X", -1), false)

    const s = spentFor(acct)
    assert.equal(s.calls, 3)
    assert.ok(Math.abs(s.total - 0.00010483) < 1e-12)

    const est = estimateWindow(acct)
    assert.equal(est.windows.length, 1)
    const w = est.windows[0]
    assert.equal(w.unit, "pts")
    assert.equal(w.limit, 10)
    assert.equal(w.display, "0.000105 / 10 pts")
    assert.match(est.note, /本地预估/)
    assert.match(est.note, /3 次请求/)
    assert.match(est.note, /Qwen3\.8-27B/)
    // 未记录的账号：无窗口
    assert.deepEqual(estimateWindow("never-seen").windows, [])
  } finally {
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
