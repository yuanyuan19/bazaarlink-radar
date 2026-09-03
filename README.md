# bazaarlink-radar

面向 [BazaarLink Probe](https://bazaarlink.ai/probe?tab=pulse) 的命令行工具：查询检测记录、筛选中转站，另附一个本地镜像（合并公开检测采集、缓解官方页面卡顿）。

BazaarLink Probe 本身已经能检测中转站。本项目不去重复实现检测，只消费它公开的结果，把常用的查询和筛选做成一条命令，同时用本地镜像缓解官方页面一次灌入整站造成的卡顿。

## 定位

- **只用现成的，不另起炉灶**：检测走官方公开 API，不写自己的探针，也不改动或评价官方的判定算法。
- **一次检测只是抽样**：相符表示这次证据不支持偷换，不代表保证没换。近亲型号有分辨上限。
- **CLI + 镜像共用 SQLite**：命令行（给人、给 Agent 用）与镜像后台采集共用 `probe-history.sqlite`；镜像在官方页面上增强 Pulse 与公开检测表。

## 安装

需要 Node 22+（用到了内置的 `node:sqlite` 和 `node:test`）。

```text
git clone https://github.com/yuanyuan19/bazaarlink-radar.git
cd bazaarlink-radar
npm install
node src/cli.mjs help
```

API Key 用环境变量传，不要写到仓库里，也不要写进 `data/`：

```text
set BL_PROBE_API_KEY=sk-你的测试Key
```

## 命令

### 检测（消耗目标端点的 token）

官方限速约每 IP 每分钟 5 次，CLI 已内建排队和 429 退避。

```text
node src/cli.mjs run --base-url https://upstream.example/v1 --api-key %BL_PROBE_API_KEY% --model anthropic/claude-opus-5 --mode quick --wait --pretty
node src/cli.mjs status <runId> --pretty
node src/cli.mjs stop <runId>
node src/cli.mjs retest <runId> --probe-id <id>
```

`--mode`：`quick` 只验身份（20–40s）；`full` 跑整套判定（60–180s）；`deep` 再加长上下文（3–5min）。

退出码约定：`0` 成功；`2` 换模、渗水、注水等业务失败；`1` 传输、限流或用法错误。

### 公开数据（不需要 Key）

```text
node src/cli.mjs history --limit 20 --pretty
node src/cli.mjs history --host yiyuantoken --model opus --pretty
node src/cli.mjs relays --pretty
node src/cli.mjs relay www.yiyuantoken.com --pretty
node src/cli.mjs pulse --pretty
node src/cli.mjs verdicts --host a6api --pretty
node src/cli.mjs rank --model opus --pretty
node src/cli.mjs fraud --pretty
node src/cli.mjs models --pretty
node src/cli.mjs baselines --model opus --pretty
node src/cli.mjs prices --model opus --pretty
node src/cli.mjs endpoints --limit 50 --pretty
node src/cli.mjs fleet --canonical claudeopus5 --pretty
node src/cli.mjs active --pretty
```

`rank` 是「帮我找某个模型的最佳中转」的主入口，排序规则固定写在实现里：

1. 只收公开 relay 目录里样本量够的端点（默认 ≥15 次、≥5 个不同日期；官方还排除 OpenRouter、DeepSeek 这类直连厂）。
2. 按 `--model` 子串过滤宣称的型号（`opus` 会匹配 `claude-opus-5` 等）。
3. 优先 `confirmedMismatch=false` 且身份相符（Match 而不是 Substitution）。
4. 再看近期分数中位数、错误率、最近一次检测时间。
5. 输出带 `disclaimer`：相符不是长期保证。

### 本地镜像

```text
node src/cli.mjs serve --port 8787 --db data/cache/probe-history.sqlite
```

- **Pulse**：http://127.0.0.1:8787/probe?tab=pulse — 克隆官方 8 列表格 + 虚拟滚动。
- **公开检测**：http://127.0.0.1:8787/probe?tab=history — 官方当前窗口 + SQLite 里更早的采集记录，合并去重、虚拟滚动、服务端分页搜索。

镜像把官方 HTML/JS/CSS 拉下来、注入性能补丁，API 原样转发。除了 Pulse 大表和公开检测表，其它区块都是官方原版。

`serve` 启动后会：

1. 按自适应间隔轮询官方 `/api/probe/history` 入库（与 `ingest-history --if-due` 相同）。
2. 周期性补全 CLI 提交的 pending run（`enrich-submissions`）。

`?blperf=off` 关闭注入、只当纯代理，用来对比排障。改完注入后要强制刷新（Ctrl+F5）。细节见 `src/mirror/inject/README.md`。

### 检测记录入库

CLI `run` 会把摘要写入 SQLite（`--db PATH`）。API Key 只转发到官方，不入库、不写日志。可选设置 `KEY_FINGERPRINT_SECRET` 来生成不可逆的 Key 关联指纹。

```text
node src/cli.mjs run --base-url https://upstream.example/v1 --api-key %BL_PROBE_API_KEY% --model anthropic/claude-opus-5 --db data/cache/probe-history.sqlite
```

补全任务持久化在 SQLite 中，失败会退避重试。镜像进程内会自动跑；也可手动：

```text
node src/cli.mjs enrich-submissions --db data/cache/probe-history.sqlite --limit 10
```

官方 `/api/probe/history` 最多返回约 100 条，不翻页、丢得快。本地按 `id` 去重攒起来，在镜像公开检测 Tab 里与官方窗口合并展示。默认每 30 分钟拉一次；如果某个窗口几乎全是新记录（可能漏了），间隔会自动降到 5 分钟，平静后再回到 30 分钟。

```text
node src/cli.mjs ingest-history --once --pretty   # 拉一次
node src/cli.mjs ingest-history                   # 常驻轮询（不必与 serve 同时开）
```

数据库是 SQLite（WAL），存于 `data/cache/probe-history.sqlite`，已加入 gitignore。

## Docker 部署（VPS）

把 `.env.example` 复制为 `.env`，准备持久化目录后启动：

```text
mkdir -p data backups deploy/certs
docker compose build
docker compose --profile jobs run --rm --no-deps maintenance migrate
docker compose up -d gateway mirror
```

把 `deploy/nginx/insight.conf` 里的示例域名替换成实际域名，在 `deploy/certs` 准备好证书后再开放 HTTPS。SQLite 数据和备份留在 VPS 本地磁盘。

维护任务仍可用 systemd timer（备份、清理）；采集已内置在 `mirror` 服务里，一般不必再单独跑 ingest timer。

## 给 Agent 用

```text
cd bazaarlink-radar
node src/cli.mjs rank --model opus --pretty
node src/cli.mjs relay www.yiyuantoken.com --pretty
node src/cli.mjs run --base-url ... --api-key %BL_PROBE_API_KEY% --model ... --mode full --wait --pretty
```

不用去开卡死的原站刮数据。`ops`、`opus` 都会按 Opus 过滤。

## 安全

- Key 只用于一次检测；本地不写进 `data/`、不进 git、不进日志。
- 用可撤销的低额测试 Key。
- 镜像不做中间人，不装根证书，不破 Turnstile，不绕过官方限流。

发现安全问题时，不要往公开 Issue 里贴 API Key、检测结果中的敏感信息或其它凭据。报告方式见 [SECURITY.md](SECURITY.md)。

## 能力边界

一次检测只是抽样。相符表示这次证据不支持偷换，不表示保证没换。中转可以只对部分流量换模，也可以在检测时切回正货。近亲型号（同族型号）有分辨上限。

## Disclaimer

本项目是独立的第三方工具，与 BazaarLink 及其运营者没有隶属、授权、赞助或认可关系。项目名里引用 "BazaarLink" 只是为了说明互操作对象，不代表官方来源或背书。相关商标归各自所有者所有。

本项目消费 BazaarLink 公开的检测结果。使用时请自行确认你对目标端点有合法访问权限，并遵守 BazaarLink 与我们适用的服务条款、隐私政策及第三方限流规则。

本软件按「现状」提供，不附带任何明示或暗示的担保。因使用本软件产生的任何直接或间接后果，由使用者自行承担。
