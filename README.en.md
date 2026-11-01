# magpie-amd-cloud

English | [中文](README.md)

Connect [AMD Radeon Cloud](https://amd-aim.github.io/radeon-cloud-docs/) (AMD GPU Cloud) **free shared Model APIs** to [magpie](https://usemagpie.ai/) as a provider plugin. Once connected, every agent — Claude Code, Codex, OpenCode and more — can call Radeon GPU models through magpie as `amd-cloud/<model>`, with quota visible right inside magpie.

Zero dependencies, zero build: a plain OpenCode v1 provider plugin loaded in place from a folder.

## What you get after connecting

- **Plugins → Installed**: an AMD Cloud card (icon, version).
- **Provider row**: `amd-cloud (AMD Cloud, N models)  signed in`. Logging in again with another key adds another account.
- **Quota card + `magpie quota`**: a "spend (24h rolling)" window — percent used, `$used / $limit`, reset countdown (rolling period: resets 24 hours after the first billed request of the cycle, not at a fixed midnight); the account shows its organization ID (`oneclick-org-…`).
- **Model picker / agents**: `amd-cloud/DeepSeek-V4-Flash`, `amd-cloud/Qwen3.8-Flash-Next` and every other chat model — after sign-in the list is fetched live from `GET /v1/models`, no hardcoded names, new models appear automatically.
- **Gateway `GET /v1/magpie/quotas`** exposes the same quota to external tooling.
- 401 marks the account for re-login, 429/5xx fail over to the next account/model — all native magpie behavior.

## How to connect

Prerequisite: a verified AMD Radeon Cloud account (pending accounts are not issued API keys).

1. **Get a key**: sign in to the Radeon Cloud console; a key is issued the first time you open Token Factory or launch an instance. Shown in the model details dialog and your Profile page, shaped like `rc-` + 48 hex chars.
2. **Add the plugin**:
   ```sh
   magpie plugin add /path/to/magpie-amd-cloud   # loaded in place from the folder
   # or in the app: Plugins → Add plugin → folder path
   ```
3. **Sign in**:
   ```sh
   magpie plugin login amd-cloud    # paste the rc-… key
   ```
4. **Verify**:
   ```sh
   magpie provider test amd-cloud   # one tiny request per model
   magpie quota                     # spend window
   ```

Then pick `amd-cloud/DeepSeek-V4-Flash` etc. in your agent. Repeat `magpie plugin login amd-cloud` with another key for multi-account.

## Models (reconciled with the live catalog on 2026-11-01: 15 entries, 10 of them chat models; `GET /v1/models` is the live source of truth)

The catalog also contains 5 non-chat entries — Clef/d3/d3-flash are Model Ops internal routing/decision services (output `decision`), OmniVoice is speech (`audio`), MinerU2.5-Pro is document parsing (`ocr`). The plugin keeps only entries whose output modality includes `text` and that declare request parameters.

| Model | Context | Image input | $/M (in/out) |
| --- | --- | --- | --- |
| DeepSeek-V4.1-Flash | 1,048,576 | ✅ | 0.28 / 0.56 |
| DeepSeek-V4-Flash | 1,048,576 | ❌ | 0.14 / 0.28 |
| GLM-5.3-Flash | 262,144 | ❌ | 0.28 / 0.56 |
| MiMo-V2.6-Flash | 1,048,576 | ✅ | 0.14 / 0.28 |
| Qwen3.8-Flash-Next | 262,144 | ✅ | 0.14 / 0.28 |
| Qwen3.8-27B | 262,144 | ✅ | 0.035 / 0.07 |
| Gemma-4-31B-IT | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM-V-4.7-1B | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM-V-4.7-35B-A3B | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM5-2B | 131,072 | ❌ | 0.035 / 0.07 |

Effort levels (`reasoning_effort` → magpie `variants`, switch in the model picker): DeepSeek-V4-Flash has six (minimal→max, no thinking by default), Qwen3.8-Flash-Next four (none/low/medium/xhigh, **thinking on by default at xhigh**) — `medium`/`low` verified accepted. Other models are mapped from catalog metadata (context/pricing/capabilities); the catalog carries no effort info for them.

## Behavior notes (official docs + real-machine findings)

- **The gateway rebuilds request bodies**: shared endpoints accept a fixed field set (`temperature`, `max_tokens`, `top_p`, `tools`, …); `stop`, `seed`, `top_k`, `logit_bias` etc. are **silently dropped**.
- **Qwen3.8-Flash-Next accepts a single `system` message, in position 0**, with the `system` role (not `developer`); DeepSeek-family has no such limit.
- **Qwen3.8-Flash-Next thinks by default (xhigh)** — omitting `reasoning_effort` does not turn thinking off; pick the `none` variant to disable.
- Chat completions only: no `/v1/responses`, embeddings, or image generation on shared endpoints.
- Non-streaming requests cap at 10 minutes; for streaming the cap applies to the gap between chunks.
- Rate limits: 30 RPM / 8 concurrent per key (plugin `maxConcurrency` is 8), 20 RPM per account (`rpm_limit` from `/v1/usage`), plus a rolling-period spend cap; 429 carries `Retry-After` and magpie fails over automatically.
- **Each model also has its own shared concurrency cap** (e.g. 32 for GLM-5.3-Flash); when full it returns `model_concurrency_rate_limit_exceeded` — just switch models, your account is not throttled.
- Unknown model names are rejected by the gateway with `400` before reaching the backend.
- **The quota endpoint differs from the docs**: the documented Platform API `/api/profile/model-usage` rejects API keys (401, browser session only); the plugin actually uses `GET /v1/usage` on the Model API host, and the "daily" cap is a rolling 24h period (`daily_reset_timezone: null`).

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| Quota says "no API key issued" | Generate one in the console (Token Factory / Profile) |
| 403 `account_not_verified` | Account still under review; keys are issued after approval |
| 401 / asked to sign in again | Key invalid or rotated (re-issuing revokes the old one immediately); run `magpie plugin login amd-cloud` again |
| Frequent 429 | Check `code`: `model_concurrency_rate_limit_exceeded` = that model's shared concurrency is full, switch models; `token_*`/`ip_*` = key/IP RPM or concurrency limits; adding more accounts (keys) lets magpie spread the load |
| `Requested model … not supported` | Model not in the shared catalog; check the list under `magpie plugin` |

## Privacy & security

- Keys are stored in magpie's config directory (`plugin-auth.json`, permission 600).
- The plugin talks to exactly **one** official host: `developer.amd.com.cn` (inference, model catalog and quota `/v1/usage`). It sees what any request to the vendor sees — your conversation, tools and their results — and logs/uploads nothing else.

## Development

```sh
node --test test/amd-cloud.test.mjs   # 21 unit tests: catalog mapping / chat filter / usage mapping + fetch wrapper (stubbed global fetch)
```

Sandbox check (keeps your real magpie config untouched):

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache USERPROFILE=$sb MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
m plugin add /path/to/magpie-amd-cloud
m plugin --json
```

### Assumptions to verify

- `limit.output = 16384` is a conservative guess; the max output token count is not published.
- Effort variants: DeepSeek `medium` and Qwen3.8-Flash-Next `low` verified accepted (2026-11-01); the rest follow the official model pages, not exercised one by one.
- The static fallback covers only the two documented models; everything else comes from the live catalog once signed in.

## License

MIT
