# 注入了哪几处

由 `serve` 在原站 `</head>` 前插入 boot 预取 + `perf.js` + `pulse-virt.js` + `history-virt.js`。官方打包 JS 不改。`?blperf=off` 关掉注入，只当纯代理。

## 针对性替换：Pulse「端点状态监控」表

这是原站卡死的原因（一次灌入约 6800 行 / 9MB）。只换这一张表：

1. **首屏**：把官方对该接口的请求改成 `limit=24`，React 先画出官方自己的前 24 行（表头、列宽、单元格 inline style 都是官方的）。
2. **克隆**：虚拟表用 `cloneNode` 复制官方 `<table>` 的 class / style / `<colgroup>` / `<thead>`，再复制它的 overflow 容器。文案和列顺序跟官方走，官方改表头我们跟着改。
3. **渐进**：`<head>` 里并行拉 `/__bl/pulse-boot.json`（前 48 行）和 gzip 全量 index；boot 一到就接上虚拟滚动，index 到了搜索/滚动覆盖全集。
4. **懒渲染**：tbody 只保留视口附近的行。点开一行再按 host 拉完整卡片做展开详情。
5. **Fail-open**：找不到 8 列表格就不接管，页面停在官方那 24 行，不会空白。

## 针对性替换：公开检测（history Tab）表

官方 `/api/probe/history` 最多约 100 条且不翻页。镜像在后台定时采集进 SQLite，并在 history Tab **不改一个像素**：表格完全由官方 React 代码渲染，我们只换数据、加一条翻页。

1. **数据**：官方页面首屏请求 `/api/probe/history?limit=50`，被 `perf.js` 改写为 `/__bl/history-page.json?page=1&q=&band=`。镜像服务端把官方窗口（缓存 15s）按 q/band 过滤后排前面，再接上本地库里 `id`/`run_uuid` 都不在官方集合里的记录，切成每页 50 条。每一项字段与官方接口同形，官方组件原样渲染。
2. **翻页**：表格下方加一条翻页（按钮样式从官方 band pills 的 inline style 复制）。点击后拉对应页，通过 React fiber 找到存放 `history` 的 state setter 直接喂入；找不到就把页码存 `sessionStorage` 并刷新，由首屏改写加载。
3. **搜索 / 分数档**：沿用官方输入框和 pills，变化后从服务端重新拉第 1 页（合并后的全集里搜），官方自带的客户端过滤跑一遍等于空操作。
4. **不做**：不克隆表格、不虚拟滚动、不自己画行。

其它 Tab、表单、判定树、比价都不替换。

## perf.js 对其它区块

| hook | 做什么 |
|---|---|
| `__blOnResponse(regex, fn)` | 给其它注入脚本的响应钩子，命中路径的 JSON 响应会被复制一份回调，不影响官方 React 拿到的原响应 |
| 同源 `/api/**` GET 排队 | 首屏最多 2 个并发，`load` 或 1.2s 后放开。`mode=` / `exact=` 不排队 |
| relay-verdicts / history 首请求瘦身 | 无 `limit=` 时分别加 `limit=24` / `limit=50` |
| `content-visibility: auto` | 距视口 1.5 屏以外的大容器跳过绘制；表格内部和虚拟表容器排除 |

## 明确不做

- 不改官方检测 API 语义，不缓存 POST `/api/probe/run`。
- 不折叠判定树、不藏其它 Tab。
- 不把单元格结构写死成另一套 UI：列壳来自官方 clone；行内容用官方 CSS 变量和从首行 harvest 的 inline style。

## 排障

`?blperf=off` 对比原代理。看 `[mirror]` 日志确认 `/api/probe/run` 仍打到官方。
