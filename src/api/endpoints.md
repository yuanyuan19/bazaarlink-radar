# BazaarLink Probe 接口清单

以下接口基于对 `https://bazaarlink.ai` 的实际探测整理，作为本项目对接官方 API 的依据；和官方 [probe-api-skill.md](https://bazaarlink.ai/probe-api-skill.md) 不一致的地方已标出。以线上实际响应为准。

Origin: `https://bazaarlink.ai`。

## 镜像内部接口（`serve`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__bl/health` | 镜像与 SQLite 采集状态 |
| GET | `/__bl/history-boot.json` | 公开检测本地库首屏（默认 48 条，支持 `excludeIds`） |
| GET | `/__bl/history.json` | 公开检测分页搜索（`q`、`band`、`offset`、`limit`、`excludeIds`） |
| GET | `/__bl/probe-copy.json` | 官方 Probe 页面文案（供注入脚本复用标签） |
| GET | `/__bl/pulse-boot.json` | Pulse 首屏 |
| GET | `/__bl/pulse-index.json` | Pulse 全量索引 |

镜像进程内会自动轮询官方 `/api/probe/history` 入库（与 `ingest-history --if-due` 相同逻辑），并周期性执行 `enrich-submissions`。

CLI `run` 写入的摘要直接进 SQLite（`--db PATH`），不再经过独立数据站。

## Skill 已写、探通

| 方法 | 路径 | 结果 |
|---|---|---|
| POST | `/api/probe/run` | 未用真 Key 打。body: `baseUrl, apiKey, modelId, claimedModel?, upstreamFormat?, quickMode?, identityOnly?, sync?, runContextCheck?, lang?, cfTurnstileToken?` |
| GET | `/api/probe/run/{runId}` | 轮询 |
| POST | `/api/probe/run/{runId}/stop` | 同 IP |
| POST | `/api/probe/run/{runId}/retest` | 单题重测 |
| GET | `/api/probe/history` | `{ history: [...], truncated }`。支持 `?limit=`（试过 5 / 50 / 默认约 100） |
| GET | `/api/probe/history/{id}` | 完整 run：`items[98]`, `identityAssessment`, tokens。**响应里没有 `status` 字段**，有 `completedAt` |
| GET | `/api/probe/baselines` | `{ models: string[] }` 30 个 |
| GET | `/api/probe/baselines?modelId=` | `{ modelId, probes: [{ probeId, responseText, updatedAt }] }` |
| GET | `/api/probe/fraud-list` | `{ hosts: [{ host, suspicionCount, spoofRuns, mismatchRuns, detectedFamilies, claimedModels, lastSeen, runIds }] }` |

## 和 Skill 不一致

| Skill 写法 | 实际 |
|---|---|
| GET `/api/probe/models` 建议模型列表 | **GET 405**。建议列表在 **GET `/api/probe/suggested-models`** |
| POST `/api/probe/models` | 400：`baseUrl and apiKey are required`。这是「向目标端点拉模型清单」，不是建议列表 |
| GET `/api/probe/relay` | **404 HTML**。公开目录是页面 `/probe/relay`（HTML 表） |
| 单次完整纪录只有 `/history/{id}` | 另有 HTML 报告页 `/api/probe/report/{id}`（不是 JSON） |

## Skill 没写、页面 JS 在用

| 方法 | 路径 | 结果 |
|---|---|---|
| GET | `/api/probe/suggested-models` | `{ models: [{ modelId, probeCount, recentCount24h, siteCount, matchRate }] }` |
| GET | `/api/probe/traffic-24h` | `{ buckets: [{ hour, probeRuns, distinctUrls }] }` — Pulse 24h 图 |
| GET | `/api/probe/cumulative-history` | `{ points: [{ day, cumulativeCount }] }` |
| GET | `/api/probe/maintenance-status` | `{ maintenance: false }` |
| GET | `/api/probe/model-prices` | `{ models: [{ canonicalModelId, displayName, relayCount }] }` — 比价 Tab |
| GET | `/api/probe/fleet-stats?canonicalModelId=` | `{ canonicalModelId, probes: [{ probeId, avgTtftMs, cntTtft, avgTps, cntTps }] }`。要用 `claudeopus5` 这种 canonical，不要用 `anthropic/claude-opus-5` |
| GET | `/api/probe/endpoints` | 监控 Tab。`{ endpoints: [...200], nextCursor }`。支持 `?limit=`、`?cursor=` |
| GET | `/api/probe/active` | 进行中的 run |
| POST | `/api/probe/detect` | 400：`baseUrl required`（未深挖） |
| GET | `/api/probe/relay-verdicts` | **Pulse / 端點狀態監控**。原站 `{ summary, cards[5677] }` 约 **9.4MB**。镜像：默认前 24 行给官方 React；`?mode=index` 为全量瘦身索引（搜索/虚拟列表）；`?offset=&limit=&q=&verdict=&exact=1` |
| GET | `/api/probe/relay-runs?baseUrl=&model=&limit=20&cursor=` | Pulse 点开某模型后的检测纪录 |

## 页面（HTML，需解析）

| 路径 | 内容 |
|---|---|
| `/probe?tab=pulse` | 工具 + Pulse + 判定树，一次 SSR 很大 |
| `/probe?tab=history` | 公开检测历史（镜像会合并 SQLite 采集并虚拟滚动） |
| `/probe/relay` | 目录表：host / 检测次数 / 不同日期 / 模型数。解析到 352 行 |
| `/probe/relay/{host}` | 分模型表：宣称模型 / 指紋判定 / 實際家族 / 檢測次數 / 最後檢測。判定：`相符` `家族相符` `替換` `未確定` |
| `/en/probe/relay` | 英文同结构，判定：Match / Family match / Substitution / Unknown |

## 不存在

`/api/probe/pulse`、`/api/probe/popular`、`/api/probe/stats`、`/api/probe/relays`、`/api/probe/hosts` — 都是 404 HTML。
