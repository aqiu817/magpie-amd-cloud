// magpie-amd-cloud：把 AMD 的两个免费共享模型 API 站点变成 magpie 供应商。
//
// 入口导出两个插件函数——magpie 会把入口文件的每个导出函数都当成插件调用，
// 辅助函数全部放在 lib/ 里（见插件开发文档「模块导出什么」）：
//   AmdCloudPlugin()    → 供应商 `amd-cloud`     国内站 Radeon Cloud（developer.amd.com.cn）
//   AmdCloudLabPlugin() → 供应商 `amd-cloud-lab` 国际站 TokenLab（api.tokenlab.amd.com）
//
// 接入方式：agent 请求由 magpie 网关统一转成 chat completions（@ai-sdk/openai-compatible），
// 插件的 loader 提供 baseURL，鉴权头由 magpie 按 API key 登录自动补上
// （Authorization: Bearer …），我们只额外改写 User-Agent。
//
// 两站差异：
//   国内站：额度走 Model API 主机的 /v1/usage（滚动 24h 花费窗口，pts 点数口径）。
//   国际站：key 在 notebooks.amd.com/tokenlab 手动签发、30 天有效；无用量查询端点
//          （/v1/usage 等 2026-11-13 实测 404），额度只在控制台显示。

import {
  MODEL_API_BASE,
  LAB_MODEL_API_BASE,
  LAB_CONSOLE_URL,
  LAB_PROFILE_URL,
  PLUGIN_VERSION,
  USER_AGENT,
  fetchJSON,
} from "./lib/platform.mjs"
import { FALLBACK_MODELS, LAB_FALLBACK_MODELS, catalogToModels } from "./lib/catalog.mjs"
import { usageToMagpie } from "./lib/usage.mjs"
import { recordCost, estimateWindow, setLedgerDir, costOfResponse, costOfStreamText } from "./lib/points.mjs"

// 官方限流：每密钥 30 RPM / 8 并发（国内站文档）；账号 20 RPM。两站共用口径。
const MAX_CONCURRENCY = 8
const MODEL_REFRESH_MS = 60_000

function retryDelay(header, now) {
  const value = header?.trim() ?? ""
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(MODEL_REFRESH_MS, delay) : MODEL_REFRESH_MS
}

// lab 的 fetch：透传请求，并从响应里抓 usage.cost（TokenLab 自报的 points 消耗，
// 非标字段）按账号持久化累计——magpie 网关不认识该字段，插件自己记账给 usage 钩子用。
// 流式响应的 usage 在最后一个 chunk，后台 reader 逐块累计缓冲后提取（不阻塞主流）。
function labFetch(key) {
  return async function fetch(input, init) {
    const headers = new Headers(init?.headers)
    headers.set("user-agent", USER_AGENT)
    // 注意：这里必须用全局 fetch——loader 返回的 fetch 会替换宿主里的同名引用，
    // 直接写 fetch() 会递归调用自己（真机实测栈溢出 502）
    const res = await globalThis.fetch(input, { ...init, headers })
    try {
      const url = String(input)
      if (res.ok && url.includes("/chat/completions")) {
        const model = (() => {
          try {
            return JSON.parse(String(init?.body)).model
          } catch {
            return undefined
          }
        })()
        const ct = res.headers.get("content-type") ?? ""
        if (ct.includes("text/event-stream")) {
          // clone 给后台 reader 扫描，不碰返回给 magpie 的那条流
          const clone = res.clone()
          ;(async () => {
            const reader = clone.body?.getReader?.()
            if (!reader) return
            const dec = new TextDecoder()
            let buf = ""
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              // 只保留尾部，cost 在末尾 usage chunk（控内存）
              if (buf.length > 8000) buf = buf.slice(-4000)
            }
            buf += dec.decode()
            const cost = costOfStreamText(buf)
            if (cost != null) recordCost(key, model, cost)
          })().catch(() => {})
        } else {
          const body = await res.clone().json().catch(() => null)
          const cost = body && costOfResponse(body)
          if (cost != null) recordCost(key, model ?? body?.model, cost)
        }
      }
    } catch {
      // 记账失败不影响请求本身
    }
    return res
  }
}

// 两个供应商共享同一套钩子形状，只差 id / 展示名 / baseURL / 兜底表 / usage 实现 / key 形状 /
// fetch 形状（lab 要在响应里抓 points 记账）。
function makePlugin({ provider, name, base, fallbacks, usage, keyPlaceholder = "rc-…", makeFetch }) {
  // 站点由工厂隔离；同一 key 只保留一份目录和一次在途刷新。
  const catalogs = new Map()

  async function listModels(key) {
    let entry = catalogs.get(key)
    if (!entry) {
      entry = { refreshAt: 0 }
      catalogs.set(key, entry)
    }
    if (entry.pending) return entry.pending
    if (Date.now() < entry.refreshAt) return entry.current

    entry.pending = (async () => {
      const res = await fetchJSON(`${base}/models`, key)
      const now = Date.now()
      entry.refreshAt = now + (res.status === 429 ? retryDelay(res.retryAfter, now) : MODEL_REFRESH_MS)
      entry.current = undefined
      if (res.status === 429) {
        entry.current = entry.lastGood
      } else if (res.ok) {
        try {
          // 验证目录后再缓存原始响应，保留每个调用方自己的模型默认值。
          catalogToModels(res.data)
          entry.current = entry.lastGood = res.data
        } catch {
          // 空目录或无聊天模型时，保留上一次成功的目录供 429 使用。
        }
      }
      return entry.current
    })().finally(() => { entry.pending = undefined })
    return entry.pending
  }

  return async function plugin({ directory } = {}) {
    // 两站都可能需要知道配置目录（lab 用于账本）；有 directory 就设上，
    // points.mjs 也有固定路径兜底所以不传也能工作。
    if (directory) setLedgerDir(directory)
    return {
      // 供应商与静态兜底模型。用 ??= 以免覆盖用户在 plugins.json 里的同名配置。
      config: async (cfg) => {
        cfg.provider ??= {}
        cfg.provider[provider] ??= {
          name,
          npm: "@ai-sdk/openai-compatible", // chat completions
          api: base,
          models: fallbacks,
        }
      },

      auth: {
        provider,
        maxConcurrency: MAX_CONCURRENCY,
        methods: [{ type: "api", label: `${name} API key`, placeholder: keyPlaceholder }],
        // key 原样保存（不做 authorize）：无效 key 由首个请求的 401 触发 magpie 的账号标记。
        async loader(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "api") return {}
          if (makeFetch) {
            // lab：自定义 fetch 里要抓 usage.cost，本身已设 UA；key 从 auth.key 取
            return { baseURL: base, fetch: makeFetch(auth.key ?? auth.accountId) }
          }
          return {
            baseURL: base,
            async fetch(input, init) {
              const headers = new Headers(init?.headers)
              headers.set("user-agent", USER_AGENT)
              return fetch(input, { ...init, headers })
            },
          }
        },
        usage,
      },

      provider: {
        id: provider,
        async models(providerModels, { auth } = {}) {
          const hostProvider = providerModels.id === provider
          const defaults = hostProvider ? providerModels.models : providerModels
          if (auth?.type !== "api" || !auth.key) return defaults
          const catalog = await listModels(auth.key)
          if (catalog) return catalogToModels(catalog, defaults)
          if (!hostProvider) return defaults
          // 告诉 magpie 静态表不是实时目录，即使本次查询没有发 HTTP 请求。
          return { ...defaults, [Symbol.for("magpie.fellBack")]: true }
        },
      },
    }
  }
}

export const AmdCloudPlugin = makePlugin({
  provider: "amd-cloud",
  name: "AMD Cloud",
  base: MODEL_API_BASE,
  fallbacks: FALLBACK_MODELS,
  // 国内站额度：滚动 24h 花费窗口（pts 口径），来自 Model API 主机的 /v1/usage。
  async usage(getAuth) {
    const auth = await getAuth()
    if (auth?.type !== "api") return { error: "尚未登录 AMD Cloud", windows: [] }
    const u = await fetchJSON(`${MODEL_API_BASE}/usage`, auth.key)
    if (!u.ok) {
      if (u.status === 401) {
        return { error: "AMD Cloud 密钥无效，请重新登录", windows: [] }
      }
      return {
        error:
          u.status === 0
            ? `AMD Cloud 不可达：${u.error}`
            : `AMD Cloud 用量查询失败（HTTP ${u.status}）`,
        windows: [],
      }
    }
    return usageToMagpie(u.data)
  },
})

export const AmdCloudLabPlugin = makePlugin({
  provider: "amd-cloud-lab",
  name: "AMD Cloud Lab",
  base: LAB_MODEL_API_BASE,
  fallbacks: LAB_FALLBACK_MODELS,
  keyPlaceholder: "tl-…",
  makeFetch: labFetch,
  // 国际站没有用量端点（/v1/usage 404）；points 是 30 天周期总量（非每日重置）。
  // 窗口给「本地预估已用」：插件从每次响应的 usage.cost 自行累计（进程内），
  // 与个人页的实际余额对不上属预期——精确值与续期都在个人页操作。
  async usage(getAuth) {
    const auth = await getAuth()
    if (auth?.type !== "api") {
      return { plan: "AMD Cloud Lab", error: "尚未登录 AMD Cloud Lab", windows: [] }
    }
    const est = estimateWindow(auth.key ?? auth.accountId ?? "default")
    return {
      ...est,
      error: `Points（30 天周期总量）与实际用量、续期请到个人页：${LAB_PROFILE_URL}`,
    }
  },
})
