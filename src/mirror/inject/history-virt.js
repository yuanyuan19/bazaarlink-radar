/* History tab: clone official 6-col table, merge local ingested rows, virtual scroll.
   Fail open: if the official history table never appears, this script does nothing. */
(function () {
  if (window.__blHistVirt) return;
  if (/[?&]blperf=off(?:[&#]|$)/.test(location.search)) return;
  window.__blHistVirt = true;

  var OVERSCAN = 10;
  var EST_ROW = 52;
  var PAGE = 50;

  var labels = {
    filterUrlPlaceholder: "筛选 URL…",
    histQuickModeScoreLabel: "快速测试",
    histQuickModeNote: "快速模式跳过质量评分",
    histCoverageTooltip: "少数题目缺漏不是无法判定的原因；题目全到齐时仍约两成无法判定",
    histStatusInconclusive: "无法判定",
    histStatusRunning: "进行中",
    histIdentityMismatch: "模型不符 · ",
    histEmpty: "没有符合筛选条件的记录",
  };

  var officialRows = [];
  var localRows = [];
  var localTotal = 0;
  var localOffset = 0;
  var localLoading = false;
  var merged = [];
  var filtered = [];
  var heights = [];
  var lastKey = "";
  var ready = false;
  var virtTable = null;
  var virtBody = null;
  var rowStyle = "";
  var cellStyles = [];
  var paintScheduled = false;
  var painting = false;

  var nativeFetch = function () {
    return (window.__blNativeFetch || window.fetch.bind(window)).apply(window, arguments);
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function historyTabActive() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get("tab") === "history";
    } catch (e) {
      return /[?&]tab=history(?:[&#]|$)/.test(location.search);
    }
  }

  function displayScore(row) {
    if (row.displayScore != null) return row.displayScore;
    if (row.score == null || row.score === "") return null;
    var n = Number(row.score);
    if (!Number.isFinite(n)) return null;
    return Math.round(n <= 1 ? n * 100 : n);
  }

  function isRunning(row) {
    if (row.totalProbes != null && row.doneProbes != null) return Number(row.doneProbes) < Number(row.totalProbes);
    if (row.status === "running" || row.status === "queued") return true;
    return false;
  }

  function quickish(row) {
    if (row.identityOnly) return true;
    var ds = displayScore(row);
    return ds == null && !isRunning(row) && !(row.errorCount > 0);
  }

  function hostFromUrl(url) {
    try {
      return new URL(String(url || "")).hostname.replace(/^www\./, "");
    } catch (e) {
      return String(url || "").replace(/^https?:\/\//, "").split("/")[0];
    }
  }

  function findHistorySearch() {
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var p = inputs[i].getAttribute("placeholder") || "";
      if (/筛选\s*URL/i.test(p)) return inputs[i];
      var st = inputs[i].getAttribute("style") || "";
      if (/width:\s*220px/.test(st)) return inputs[i];
    }
    return null;
  }

  function findHistoryCard() {
    var input = findHistorySearch();
    if (!input) return null;
    var el = input;
    for (var i = 0; i < 18 && el; i++) {
      var st = (el.getAttribute && el.getAttribute("style")) || "";
      if (/max-width:\s*1100px/.test(st) || /maxWidth:\s*1100/.test(st)) return el;
      el = el.parentElement;
    }
    return input.parentElement ? input.parentElement.parentElement : null;
  }

  function findOfficialHistoryTable() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].getAttribute("data-bl-hist-virt")) continue;
      var cols = tables[i].querySelectorAll("col");
      if (cols.length === 6) return tables[i];
      var ths = tables[i].tHead && tables[i].tHead.rows[0] ? tables[i].tHead.rows[0].cells.length : 0;
      if (ths === 6 && tables[i].querySelector("tbody tr")) return tables[i];
    }
    return null;
  }

  function readBand() {
    var card = findHistoryCard();
    if (!card) return "all";
    var buttons = card.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].textContent || "").trim();
      var st = buttons[i].getAttribute("style") || "";
      if (!/border-radius:\s*999px/.test(st) && !/borderRadius:\s*999/.test(st)) continue;
      if (/background:\s*var\(--accent\)|background:var\(--accent\)/.test(st)) {
        if (txt === "80+") return "80";
        if (txt === "50+") return "50";
        if (txt === "<50") return "low";
        if (/进行中/.test(txt)) return "running";
        return "all";
      }
    }
    return "all";
  }

  function filters() {
    var input = findHistorySearch();
    return {
      q: input ? String(input.value || "").trim().toLowerCase() : "",
      band: readBand(),
    };
  }

  function rowHaystack(row) {
    return (
      String(row.baseUrl || "") +
      " " +
      String(row.modelId || "") +
      " " +
      String(row.host || hostFromUrl(row.baseUrl)) +
      " " +
      String(row.id || "")
    ).toLowerCase();
  }

  function applyBand(rows, band) {
    if (!band || band === "all") return rows;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var ds = displayScore(row);
      var running = isRunning(row);
      if (band === "running") {
        if (running) out.push(row);
        continue;
      }
      if (running) continue;
      if (band === "80" && ds != null && ds >= 80) out.push(row);
      else if (band === "50" && ds != null && ds >= 50) out.push(row);
      else if (band === "low" && ds != null && ds < 50) out.push(row);
    }
    return out;
  }

  function applyFilter(src, f) {
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (f.q && rowHaystack(src[i]).indexOf(f.q) < 0) continue;
      out.push(src[i]);
    }
    out.sort(function (a, b) {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    return applyBand(out, f.band);
  }

  function officialIds() {
    var set = {};
    for (var i = 0; i < officialRows.length; i++) set[String(officialRows[i].id)] = 1;
    return set;
  }

  function mergeAll() {
    var ids = officialIds();
    var out = officialRows.slice();
    for (var i = 0; i < localRows.length; i++) {
      if (!ids[String(localRows[i].id)]) out.push(localRows[i]);
    }
    out.sort(function (a, b) {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    merged = out;
  }

  function harvest(official) {
    if (!official) return;
    var row = official.tBodies[0] && official.tBodies[0].querySelector("tr");
    if (row && row.cells.length >= 6 && !cellStyles.length) {
      rowStyle = row.getAttribute("style") || "cursor:pointer;border-bottom:1px solid var(--border)";
      cellStyles = [];
      for (var i = 0; i < row.cells.length; i++) {
        cellStyles[i] = row.cells[i].getAttribute("style") || "padding:10px 8px;vertical-align:middle";
      }
    }
  }

  function hideOfficialList(card, official) {
    var wrap = official && official.parentElement;
    if (wrap && wrap.getAttribute("data-bl-hist-wrap") !== "1") {
      wrap.style.display = "none";
      wrap.setAttribute("data-bl-official-hist", "1");
    }
    if (!card) return;
    var kids = card.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.getAttribute("data-bl-hist-wrap") === "1") continue;
      var st = el.getAttribute("style") || "";
      if (/padding:\s*40px/.test(st) && /text-align:\s*center/i.test(st)) el.style.display = "none";
    }
  }

  function tdStyle(i, extra) {
    var base = cellStyles[i] || "padding:10px 8px;vertical-align:middle";
    return extra ? base + ";" + extra : base;
  }

  function relTime(iso) {
    if (!iso) return "—";
    var t = Date.now() - new Date(iso).getTime();
    if (t < 0) return "刚刚";
    var n = Math.floor(t / 60000);
    if (n < 1) return "刚刚";
    if (n < 60) return n + " 分钟前";
    var h = Math.floor(n / 60);
    if (h < 24) return h + " 小时前";
    return Math.floor(h / 24) + " 天前";
  }

  function identCell(row) {
    if (isRunning(row)) {
      return '<span style="color:var(--fg-subtle);font-size:12px">' + esc(labels.histStatusRunning) + "</span>";
    }
    if (row.confirmedMismatch) {
      return (
        '<span style="color:#ef4444;font-size:12px;font-weight:600">' +
        esc(labels.histIdentityMismatch) +
        esc(row.mostSimilarDisplayName || "—") +
        "</span>"
      );
    }
    if (row.identityConfirmed) {
      return '<span style="color:#22c55e;font-size:12px;font-weight:600">✓ 相符</span>';
    }
    return '<span style="color:var(--fg-subtle);font-size:12px">' + esc(labels.histStatusInconclusive) + "</span>";
  }

  function progressCell(row) {
    if (isRunning(row)) {
      var done = row.doneProbes || 0;
      var total = row.totalProbes || "?";
      return esc(done + " / " + total);
    }
    if (quickish(row) && !(row.errorCount > 0)) {
      return '<span style="color:var(--fg-subtle);font-size:12px">' + esc(labels.histQuickModeNote) + "</span>";
    }
    if (row.errorCount > 0) {
      return (
        '<span style="color:#f59e0b;font-size:12px" title="' +
        esc(labels.histCoverageTooltip) +
        '">⚠ 缺 ' +
        esc(row.errorCount) +
        " 题</span>"
      );
    }
    return "—";
  }

  function scoreCell(row) {
    if (isRunning(row)) return "—";
    var ds = displayScore(row);
    if (ds == null || ds === 0) {
      return '<span style="color:var(--fg-subtle);font-size:12px">' + esc(labels.histQuickModeScoreLabel) + "</span>";
    }
    var color = ds >= 80 ? "#22c55e" : ds >= 60 ? "#eab308" : ds >= 40 ? "#f59e0b" : "#ef4444";
    return '<span style="font-weight:700;color:' + color + '">' + esc(ds) + "</span>";
  }

  function rowHtml(row) {
    var host = row.host || hostFromUrl(row.baseUrl);
    var mark = (host || "?").slice(0, 1).toUpperCase();
    return (
      '<tr data-bl-run="' +
      esc(row.id) +
      '" style="' +
      esc(rowStyle || "cursor:pointer;border-bottom:1px solid var(--border)") +
      '">' +
      '<td style="' +
      esc(tdStyle(0)) +
      '"><div style="display:flex;align-items:center;gap:8px"><span style="width:24px;height:24px;border-radius:6px;background:var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">' +
      esc(mark) +
      '</span><span style="font-size:13px;font-weight:600;word-break:break-all">' +
      esc(host || row.baseUrl || "—") +
      "</span></div></td>" +
      '<td style="' +
      esc(tdStyle(1)) +
      '"><span style="font-size:12px;color:var(--fg-subtle)">' +
      esc(row.modelId || "—") +
      "</span></td>" +
      '<td style="' +
      esc(tdStyle(2)) +
      '">' +
      identCell(row) +
      "</td>" +
      '<td style="' +
      esc(tdStyle(3)) +
      '">' +
      progressCell(row) +
      "</td>" +
      '<td style="' +
      esc(tdStyle(4, "text-align:right") ) +
      '">' +
      scoreCell(row) +
      "</td>" +
      '<td style="' +
      esc(tdStyle(5)) +
      '"><span style="font-size:12px;color:var(--fg-subtle)" title="' +
      esc(row.createdAt || "") +
      '">' +
      esc(relTime(row.createdAt)) +
      "</span></td></tr>"
    );
  }

  function offsetOf(i) {
    var y = 0;
    var n = Math.min(i, heights.length);
    for (var k = 0; k < n; k++) y += heights[k] || EST_ROW;
    return y;
  }

  function indexAt(y) {
    var acc = 0;
    for (var i = 0; i < heights.length; i++) {
      acc += heights[i] || EST_ROW;
      if (acc > y) return i;
    }
    return Math.max(0, heights.length - 1);
  }

  function spacer(h) {
    return h > 0 ? '<tr aria-hidden="true"><td colspan="6" style="height:' + h + 'px;padding:0;border:0"></td></tr>' : "";
  }

  function mountVirt(official) {
    var card = findHistoryCard();
    if (!card || !official) return false;
    harvest(official);
    if (!virtTable) {
      virtTable = official.cloneNode(false);
      virtTable.setAttribute("data-bl-hist-virt", "1");
      var cg = official.querySelector("colgroup");
      if (cg) virtTable.appendChild(cg.cloneNode(true));
      if (official.tHead) virtTable.appendChild(official.tHead.cloneNode(true));
      virtBody = document.createElement("tbody");
      virtTable.appendChild(virtBody);
      virtBody.addEventListener("click", function (ev) {
        var tr = ev.target && ev.target.closest ? ev.target.closest("tr[data-bl-run]") : null;
        if (!tr) return;
        var id = tr.getAttribute("data-bl-run");
        if (id) location.href = "/probe?runId=" + encodeURIComponent(id);
      });
    }
    var wrap = virtTable.parentElement;
    if (!wrap || wrap.getAttribute("data-bl-hist-wrap") !== "1") {
      wrap = official.parentElement ? official.parentElement.cloneNode(false) : document.createElement("div");
      wrap.setAttribute("data-bl-hist-wrap", "1");
      if (!wrap.style.overflowX) wrap.style.overflowX = "auto";
      wrap.appendChild(virtTable);
    }
    hideOfficialList(card, official);
    var input = findHistorySearch();
    if (input) {
      var toolbar = input.parentElement;
      while (toolbar && toolbar.parentElement !== card) toolbar = toolbar.parentElement;
      if (toolbar && toolbar.parentNode === card) {
        var next = toolbar.nextElementSibling;
        if (next !== wrap) card.insertBefore(wrap, next);
      } else if (wrap.parentNode !== card) {
        card.appendChild(wrap);
      }
    } else if (wrap.parentNode !== card) {
      card.appendChild(wrap);
    }
    return true;
  }

  function maybeLoadMore(f) {
    if (localLoading) return;
    if (localOffset >= localTotal) return;
    localLoading = true;
    var exclude = Object.keys(officialIds()).join(",");
    var url =
      "/__bl/history.json?offset=" +
      encodeURIComponent(String(localOffset)) +
      "&limit=" +
      PAGE +
      "&excludeIds=" +
      encodeURIComponent(exclude) +
      "&q=" +
      encodeURIComponent(f.q || "") +
      "&band=" +
      encodeURIComponent(f.band || "all");
    nativeFetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        localTotal = Number(data.total) || 0;
        var batch = (data.history || []).slice();
        var ids = {};
        for (var i = 0; i < localRows.length; i++) ids[String(localRows[i].id)] = 1;
        for (var j = 0; j < batch.length; j++) {
          if (!ids[String(batch[j].id)]) {
            localRows.push(batch[j]);
            ids[String(batch[j].id)] = 1;
          }
        }
        localOffset += batch.length;
        mergeAll();
        lastKey = "";
        schedulePaint();
      })
      .catch(function () {})
      .finally(function () {
        localLoading = false;
      });
  }

  function paintInner() {
    if (!historyTabActive()) return;
    var f = filters();
    var key = f.q + "|" + f.band;
    if (key !== lastKey) {
      filtered = applyFilter(merged, f);
      heights = new Array(filtered.length);
      for (var i = 0; i < filtered.length; i++) heights[i] = EST_ROW;
      lastKey = key;
    }

    var official = findOfficialHistoryTable();
    if (official) harvest(official);

    if (!filtered.length) {
      if (virtTable) virtTable.style.display = "none";
      var card = findHistoryCard();
      if (card && !card.querySelector("[data-bl-hist-empty]")) {
        var empty = document.createElement("div");
        empty.setAttribute("data-bl-hist-empty", "1");
        empty.setAttribute("style", "padding:40px;text-align:center;color:var(--fg-subtle)");
        empty.textContent = labels.histEmpty;
        card.appendChild(empty);
      }
      return;
    }
    var emptyEl = document.querySelector("[data-bl-hist-empty]");
    if (emptyEl) emptyEl.remove();

    if (!mountVirt(official)) return;
    virtTable.style.display = "";

    var top = virtTable.getBoundingClientRect().top;
    var scrollY = Math.max(0, -top);
    var start = Math.max(0, indexAt(scrollY) - OVERSCAN);
    var viewH = window.innerHeight + OVERSCAN * EST_ROW * 2;
    var end = start;
    var acc = 0;
    while (end < filtered.length && acc < viewH) {
      acc += heights[end] || EST_ROW;
      end += 1;
    }
    end = Math.min(filtered.length, end + OVERSCAN);

    if (end >= filtered.length - OVERSCAN) maybeLoadMore(f);

    var html = spacer(offsetOf(start));
    for (var n = start; n < end; n++) html += rowHtml(filtered[n]);
    html += spacer(offsetOf(filtered.length) - offsetOf(end));
    virtBody.innerHTML = html;

    var vis = virtBody.querySelectorAll("tr[data-bl-run]");
    for (var v = 0; v < vis.length; v++) {
      var idx = start + v;
      var h = vis[v].offsetHeight;
      if (h > 0) heights[idx] = h;
    }
  }

  function paint() {
    paintScheduled = false;
    if (!ready) return;
    painting = true;
    try {
      paintInner();
    } finally {
      painting = false;
    }
  }

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(paint);
  }

  function onOfficialHistory(data) {
    officialRows = (data && data.history) || [];
    mergeAll();
    ready = true;
    lastKey = "";
    schedulePaint();
  }

  function loadLocalBoot() {
    var exclude = Object.keys(officialIds()).join(",");
    var bootP = window.__blHistBootP;
    var p =
      bootP && bootP.then
        ? bootP
        : nativeFetch("/__bl/history-boot.json?excludeIds=" + encodeURIComponent(exclude)).then(function (r) {
            return r.json();
          });
    p.then(function (data) {
      localRows = (data && data.history) || [];
      localTotal = Number(data.total) || localRows.length;
      localOffset = localRows.length;
      mergeAll();
      ready = true;
      lastKey = "";
      schedulePaint();
    }).catch(function () {
      ready = true;
      schedulePaint();
    });
  }

  function patchFetch() {
    if (!window.fetch || window.__blHistFetchPatched) return;
    window.__blHistFetchPatched = true;
    var base = window.__blNativeFetch || window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var p = base(input, init);
      if (!historyTabActive() || url.indexOf("/api/probe/history") < 0) return p;
      return p.then(function (res) {
        if (!res.ok) return res;
        return res
          .clone()
          .json()
          .then(function (data) {
            onOfficialHistory(data);
            return res;
          })
          .catch(function () {
            return res;
          });
      });
    };
  }

  function bind() {
    document.addEventListener(
      "input",
      function (ev) {
        if (ev.target && ev.target.tagName === "INPUT") schedulePaint();
      },
      true,
    );
    document.addEventListener(
      "click",
      function () {
        setTimeout(schedulePaint, 40);
      },
      true,
    );
    window.addEventListener("scroll", schedulePaint, { passive: true });
    window.addEventListener("resize", schedulePaint);
    window.addEventListener("popstate", function () {
      setTimeout(function () {
        if (historyTabActive()) schedulePaint();
      }, 60);
    });
  }

  function loadLabels() {
    nativeFetch("/__bl/probe-copy.json")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.history) {
          for (var k in data.history) {
            if (Object.prototype.hasOwnProperty.call(data.history, k)) labels[k] = data.history[k];
          }
        }
      })
      .catch(function () {});
  }

  function start() {
    if (!historyTabActive()) return;
    patchFetch();
    loadLabels();
    loadLocalBoot();
    bind();
    var tries = 0;
    function wait() {
      schedulePaint();
      tries += 1;
      if (tries < 240) requestAnimationFrame(wait);
    }
    wait();
    var obsTimer = 0;
    var obs = new MutationObserver(function (muts) {
      if (!ready || painting) return;
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (virtTable && (t === virtTable || virtTable.contains(t))) continue;
        clearTimeout(obsTimer);
        obsTimer = setTimeout(schedulePaint, 50);
        return;
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  start();
})();
