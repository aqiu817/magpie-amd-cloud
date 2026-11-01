// magpie-amd-cloud：把 AMD Radeon Cloud（AMD GPU Cloud）的免费共享 Model APIs
// 变成 magpie 供应商 `amd-cloud`。
//
// 入口只导出这一个插件函数——magpie 会把入口文件的每个导出函数都当成插件调用，
// 辅助函数全部放在 lib/ 里（见插件开发文档「模块导出什么」）。
//
// 接入方式：agent 请求由 magpie 网关统一转成 chat completions（@ai-sdk/openai-compatible），
// 插件的 loader 提供 baseURL，鉴权头由 magpie 按 API key 登录自动补上
// （Authorization: Bearer rc-…），我们只额外改写 User-Agent。
// 额度走 Model API 主机的 /v1/usage（2026-11-01 真实密钥实测：文档写的 Platform API
// /api/profile/model-usage 不收 API 密钥，仅浏览器会话可用）。

import { MODEL_API_BASE, PLUGIN_VERSION, USER_AGENT, fetchJSON } from "./lib/platform.mjs"
import { FALLBACK_MODELS, catalogToModels } from "./lib/catalog.mjs"
import { usageToMagpie } from "./lib/usage.mjs"

const PROVIDER = "amd-cloud"
// 官方限流：每密钥 30 RPM / 8 并发；账号 20 RPM。并发交给 magpie 的 maxConcurrency 把关。
const MAX_CONCURRENCY = 8

export async function AmdCloudPlugin() {
  return {
    // 供应商与静态兜底模型。用 ??= 以免覆盖用户在 plugins.json 里的同名配置。
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "AMD Cloud",
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: MODEL_API_BASE,
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: MAX_CONCURRENCY,
      methods: [{ type: "api", label: "AMD Radeon Cloud API key", placeholder: "rc-…" }],
      // key 原样保存（不做 authorize）：无效 key 由首个请求的 401 触发 magpie 的账号标记。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        return {
          baseURL: MODEL_API_BASE,
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set("user-agent", USER_AGENT)
            return fetch(input, { ...init, headers })
          },
        }
      },
      // 额度：滚动 24h 花费窗口，来自 Model API 主机的 /v1/usage（与推理同一把密钥）。
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
    },

    // 每个账号的模型：运行时拉共享目录（官方要求不写死模型名），失败保留静态列表。
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api") return provider.models
        try {
          const res = await fetchJSON(`${MODEL_API_BASE}/models`, auth.key)
          if (!res.ok) return provider.models
          return catalogToModels(res.data, provider.models)
        } catch {
          return provider.models
        }
      },
    },
  }
}
