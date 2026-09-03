# BazaarLink Probe 接口清单

以下接口基于对 `https://bazaarlink.ai` 的实际探测整理，作为本项目对接官方 API 的依据；和官方 [probe-api-skill.md](https://bazaarlink.ai/probe-api-skill.md) 不一致的地方已标出。以线上实际响应为准。

Origin: `https://bazaarlink.ai`。

## 本项目内部接口

`POST /api/my-runs` 是数据站「我的检测」的提交入口：把 `baseUrl`、`apiKey`、`modelId` 转发到官方 `/api/probe/run`，立刻写入摘要，再异步补全结果。API Key 不得写入数据库或日志。

`POST /internal/submissions` 仍给 CLI 在已有 `runId` 时入库，只接受 `runId`、`baseUrl`、`requestModel`、时间和非敏感分组字段。API Key 不得发送到该接口。

`GET /api/runs/:id/live` 会去官方轮询进度；检测结束后再拉 `history/{id}` 补全本机记录。

接口只持久化检测摘要和待补全任务，立即返回 `202`。`enrich-submissions` 命令异步读取官方 `/api/probe/history/{id}` 并补全结果，失败按持久化退避时间重试。

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
| `/probe/relay` | 目录表：host / 检测次数 / 不同日期 / 模型数。解析到 352 行 |
| `/probe/relay/{host}` | 分模型表：宣称模型 / 指紋判定 / 實際家族 / 檢測次數 / 最後檢測。判定：`相符` `家族相符` `替換` `未確定` |
| `/en/probe/relay` | 英文同结构，判定：Match / Family match / Substitution / Unknown |

## 不存在

`/api/probe/pulse`、`/api/probe/popular`、`/api/probe/stats`、`/api/probe/relays`、`/api/probe/hosts` — 都是 404 HTML。
