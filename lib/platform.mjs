// AMD Radeon Cloud API 地址与调用封装。
// Model API（推理 + 模型目录 + 额度 /usage）都在 developer.amd.com.cn 主机上，
// 请求由 magpie 网关转成 chat completions 后交给 loader 的 fetch，baseURL 已指向这里。
// PLATFORM_API_BASE 是文档标注的 Platform API 主机——2026-11-01 实测它不收 API 密钥
//（/api/* 一律 401"Login required"，仅浏览器会话可用），仅留作参考，插件不再调用。

export const MODEL_API_BASE = "https://developer.amd.com.cn/radeon/api/v1"
export const PLATFORM_API_BASE = "https://radeon-global.anruicloud.com"
// 国际站 TokenLab（AMD AI Notebooks）：同一套 OpenAI 兼容协议，key 独立签发（tl- 前缀、
// 30 天有效）；无用量查询端点（/v1/usage 等 404）——points 是 30 天周期总量（非每日重置），
// 用量与续期都在个人页。2026-11-13 用真实 key 只读核实。
export const LAB_MODEL_API_BASE = "https://api.tokenlab.amd.com/v1"
export const LAB_CONSOLE_URL = "https://notebooks.amd.com/tokenlab"
export const LAB_PROFILE_URL = "https://notebooks.amd.com/profile"

export const PLUGIN_VERSION = "0.1.0"
export const USER_AGENT = `magpie-amd-cloud/${PLUGIN_VERSION}`

// GET 一个 Model API 的 JSON 端点。不抛异常：网络失败返回
// { ok: false, status: 0, error }，HTTP 错误也原样带回状态码和响应体。
export async function fetchJSON(url, key, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      // 非 JSON 响应保持 null，让调用方按状态码处理
    }
    return {
      ok: res.ok, status: res.status, data,
      ...(res.status === 429 ? { retryAfter: res.headers.get("Retry-After") } : {}),
    }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}
