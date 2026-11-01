// GET /v1/usage 响应 → magpie auth.usage 返回值的映射。纯函数，便于单测。
//
// 2026-11-01 用真实密钥对账：额度端点实际在 Model API 主机上（/radeon/api/v1/usage），
// 文档写的 Platform API /api/profile/model-usage 不收 API 密钥（实测 401，仅浏览器会话）。
// 「每日」花费是滚动周期：从首次计费起算 window_hours（24h）后重置，不是固定零点
// （daily_reset_timezone 为 null）。GPU 实例额度（credits）不在此接口里。

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUSD(v) {
  const n = num(v) ?? 0
  const a = Math.abs(n)
  if (a >= 100) return String(Math.round(n))
  if (a >= 0.01) return String(Math.round(n * 100) / 100)
  return String(Math.round(n * 10000) / 10000)
}

export function usageToMagpie(u) {
  if (!u || typeof u !== "object") {
    return { error: "AMD Cloud 用量响应为空", windows: [] }
  }

  // 防御：响应体若带 status（文档旧样例的形状），非 ok 时按可读错误处理
  if (typeof u.status === "string" && u.status !== "ok") {
    const msg =
      {
        not_configured: "账户尚未签发 API 密钥：先到 AMD Cloud 控制台生成",
        not_available: "AMD Cloud 用量服务暂不可用（未知状态，并非用量为零）",
      }[u.status] ?? `AMD Cloud 用量状态异常：${u.status}`
    return { error: msg, windows: [] }
  }

  const windows = []
  const limit = num(u.daily_cost_limit_usd)
  if (limit != null && limit > 0) {
    const used = num(u.daily_cost_used_usd) ?? 0
    const hours = num(u.window_hours)
    windows.push({
      name: hours && hours !== 24 ? `花费（${hours}h 滚动）` : "花费（24h 滚动）",
      used: Math.round((used / limit) * 1000) / 10,
      resetsAt: u.daily_reset_at ?? (num(u.daily_reset_epoch) ? num(u.daily_reset_epoch) * 1000 : undefined),
      span: hours > 0 ? hours * 3600 : 86400,
      display: `$${fmtUSD(used)} / $${fmtUSD(limit)}`,
      amount: used,
      limit,
      unit: "USD",
    })
  }

  const out = { plan: "AMD Cloud", windows }
  if (typeof u.organization_id === "string" && u.organization_id) out.user = u.organization_id
  return out
}
