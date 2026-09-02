/* Pulse table: clone official chrome, virtualize rows, load progressively.
   Fail open: if the official 8-col table never appears, this script does nothing. */
(function () {
  if (window.__blPulseVirt) return;
  if (/[?&]blperf=off(?:[&#]|$)/.test(location.search)) return;
  window.__blPulseVirt = true;

  var HEALTH = { online: "#22c55e", degraded: "#eab308", error: "#f59e0b", offline: "#ef4444", unknown: "#94a3b8" };
  var VERDICT = { trusted: "var(--pass)", suspect: "var(--warn)", untrusted: "var(--accent)", insufficient: "var(--neutral)" };
  var KIND = { pass: "#22c55e", family: "#f59e0b", swap: "#ef4444", empty: "var(--border)" };
  var VERDICT_RANK = { untrusted: 0, suspect: 1, insufficient: 2, trusted: 3 };
  var HEALTH_RANK = { offline: 0, error: 1, degraded: 2, unknown: 3, online: 4 };
  var OVERSCAN = 8;
  var EST_ROW = 76;

  var cards = [];
  var filtered = [];
  var heights = [];
  var labels = {
    health: { online: "Online", degraded: "Degraded", error: "Error", offline: "Offline", unknown: "Unknown" },
    verdict: { trusted: "Trusted", suspect: "Suspect", untrusted: "Untrusted", insufficient: "Insufficient" },
    today: "today",
    daysAgo: "d ago",
    stale: "stale",
    heatmapTitle: "Heatmap",
    legendPass: "match",
    legendFamily: "family",
    legendSwap: "swap",
    legendEmpty: "empty",
    section_match: "MATCH",
    section_family: "FAMILY",
    section_swap: "SWAP",
    section_unknown: "UNKNOWN",
  };
  var expanded = "";
  var detailCard = null;
  var virtTable = null;
  var virtBody = null;
  var lastKey = "";
  var ready = false;
  var fullReady = false;
  var paintScheduled = false;
  var painting = false;
  var harvested = false;
  var rowStyle = "";
  var cellStyles = [];

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

  function readLS(key, fallback) {
    try {
      var raw = window.localStorage.getItem("pulse:" + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function scoreColor(n) {
    if (n == null) return "var(--fg-subtle)";
    if (n >= 80) return "#22c55e";
    if (n >= 60) return "#eab308";
    if (n >= 40) return "#f59e0b";
    return "#ef4444";
  }

  function relTime(iso) {
    if (!iso) return "—";
    var t = Date.now() - new Date(iso).getTime();
    if (t < 0) return "just now";
    var n = Math.floor(t / 60000);
    if (n < 1) return "just now";
    if (n < 60) return n + "m";
    var h = Math.floor(n / 60);
    return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
  }

  function legendSwatch(color, text) {
    return (
      "<span><span style=\"display:inline-block;width:8px;height:8px;background:" +
      color +
      ';border-radius:1px;margin-right:3px;vertical-align:-1px"></span>' +
      esc(text) +
      "</span>"
    );
  }

  function cellBg(cell) {
    var base = KIND[cell.kind] || KIND.empty;
    if (cell.coverageWarning) {
      return "repeating-linear-gradient(45deg, " + base + " 0 3px, rgba(0,0,0,0.35) 3px 5px)";
    }
    return base;
  }

  function findSearchInput() {
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var p = inputs[i].getAttribute("placeholder") || "";
      if (/relay|host|model|搜|篩|中转|中轉/i.test(p)) return inputs[i];
      if ((inputs[i].style && inputs[i].style.width === "260px") || /width:\s*260/.test(inputs[i].getAttribute("style") || "")) {
        return inputs[i];
      }
    }
    return null;
  }

  function findSortSelect() {
    var sels = document.querySelectorAll("select");
    for (var i = 0; i < sels.length; i++) {
      if (sels[i].querySelector('option[value="verdict-worst"]')) return sels[i];
    }
    return null;
  }

  function findOfficialTable() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].getAttribute("data-bl-virt")) continue;
      var cols = tables[i].querySelectorAll("col");
      if (cols.length === 8) return tables[i];
      var ths = tables[i].tHead && tables[i].tHead.rows[0] ? tables[i].tHead.rows[0].cells.length : 0;
      if (ths === 8 && tables[i].querySelector("tbody tr")) return tables[i];
    }
    return null;
  }

  function findFilterCard() {
    var input = findSearchInput();
    if (!input) return null;
    var el = input;
    for (var i = 0; i < 16 && el; i++) {
      var st = (el.getAttribute && el.getAttribute("style")) || "";
      if (/border-radius:\s*12px/.test(st) && /padding:\s*20px/.test(st)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findToolbarRow(card) {
    var input = findSearchInput();
    if (!input || !card) return null;
    var el = input;
    while (el.parentElement && el.parentElement !== card) el = el.parentElement;
    return el.parentElement === card ? el : null;
  }

  function harvest(official) {
    if (!official) return;
    var row = official.tBodies[0] && official.tBodies[0].querySelector("tr");
    if (row && row.cells.length && !cellStyles.length) {
      rowStyle = row.getAttribute("style") || rowStyle;
      cellStyles = [];
      for (var i = 0; i < row.cells.length; i++) {
        cellStyles[i] = row.cells[i].getAttribute("style") || "";
      }
    }
    if (!row || row.cells.length < 3 || harvested) return;
    var hostSpans = row.cells[0].querySelectorAll("span");
    var host = hostSpans.length > 1 ? hostSpans[1].textContent : "";
    var card = null;
    for (var j = 0; j < cards.length; j++) {
      if (cards[j].host === host) {
        card = cards[j];
        break;
      }
    }
    if (!card) return;
    var healthSpans = row.cells[1].querySelectorAll("span");
    var healthTxt = healthSpans.length ? healthSpans[healthSpans.length - 1].textContent.trim() : "";
    var verdictSpan = row.cells[2].querySelector("span span") || row.cells[2].querySelector("span");
    var verdictTxt = verdictSpan ? verdictSpan.textContent.trim() : "";
    if (card.health && healthTxt) labels.health[card.health] = healthTxt;
    if (card.verdict && verdictTxt) labels.verdict[card.verdict] = verdictTxt;
    harvested = true;
  }

  function hideOfficialList(card, official) {
    var wrap = official && official.parentElement;
    if (wrap && wrap.getAttribute("data-bl-virt-wrap") !== "1") {
      wrap.style.display = "none";
      wrap.setAttribute("data-bl-official-list", "1");
    }
    if (!card) return;
    var kids = card.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.getAttribute("data-bl-virt-wrap") === "1") continue;
      var st = el.getAttribute("style") || "";
      if (/padding:\s*40px/.test(st) && /text-align:\s*center/i.test(st)) {
        el.style.display = "none";
      }
    }
  }

  function filters() {
    var input = findSearchInput();
    var sel = findSortSelect();
    return {
      q: input ? input.value : readLS("search", ""),
      verdict: readLS("verdictFilter", "all") || "all",
      sort: (sel && sel.value) || readLS("sortKey", "verdict-worst") || "verdict-worst",
      hideExpired: readLS("hideExpired", true) !== false,
    };
  }

  function applyFilter(src, f) {
    var q = String(f.q || "").trim().toLowerCase();
    var verdict = f.verdict && f.verdict !== "all" ? f.verdict : "";
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (verdict && c.verdict !== verdict) continue;
      if (q) {
        var hay = c._q;
        if (!hay) {
          var ids = "";
          var ms = c.models || [];
          for (var j = 0; j < ms.length; j++) ids += " " + (ms[j].claimedModelId || "");
          hay = (c.host + " " + c.baseUrl + ids).toLowerCase();
        }
        if (hay.indexOf(q) < 0) continue;
      }
      out.push(c);
    }
    out.sort(function (a, b) {
      switch (f.sort) {
        case "verdict-worst":
          return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.passRate - b.passRate;
        case "verdict-best":
          return VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || b.passRate - a.passRate;
        case "passRate-asc":
          return a.passRate - b.passRate;
        case "passRate-desc":
          return b.passRate - a.passRate;
        case "lastProbed-desc":
          return String(b.lastProbedAt || "").localeCompare(String(a.lastProbedAt || ""));
        case "lastProbed-asc":
          return String(a.lastProbedAt || "").localeCompare(String(b.lastProbedAt || ""));
        case "firstSeen-desc":
          return String(b.firstSeenAt || "").localeCompare(String(a.firstSeenAt || ""));
        case "firstSeen-asc":
          return String(a.firstSeenAt || "").localeCompare(String(b.firstSeenAt || ""));
        case "models-desc":
          return (b.claimedModelCount || 0) - (a.claimedModelCount || 0);
        case "latency-asc":
          return (a.avgLatencyMs != null ? a.avgLatencyMs : 1e9) - (b.avgLatencyMs != null ? b.avgLatencyMs : 1e9);
        case "score-desc":
          return (b.bestScore != null ? b.bestScore : -1) - (a.bestScore != null ? a.bestScore : -1);
        case "score-asc":
          return (a.bestScore != null ? a.bestScore : 1e9) - (b.bestScore != null ? b.bestScore : 1e9);
        case "health-worst":
          return HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
        case "host-asc":
          return String(a.host || "").localeCompare(String(b.host || ""));
        default:
          return 0;
      }
    });
    return out;
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

  function tdStyle(i, extra) {
    var base = cellStyles[i] || "padding:12px 8px;vertical-align:middle";
    return extra ? base + ";" + extra : base;
  }

  function sparkHtml(card) {
    var av = card.availability || [];
    if (!av.length) {
      return (
        '<div style="display:flex;align-items:center;gap:5px;font-size:12px;color:' +
        HEALTH[card.health] +
        ';font-weight:600"><span style="width:8px;height:8px;border-radius:50%;background:' +
        HEALTH[card.health] +
        '"></span>' +
        esc(labels.health[card.health] || card.health) +
        "</div>"
      );
    }
    var html = '<div style="display:flex;gap:1.5px;align-items:center">';
    for (var i = 0; i < av.length; i++) {
      var s = av[i].s || "unknown";
      var title = (av[i].t ? new Date(av[i].t).toLocaleTimeString() + " · " : "") + s + (av[i].ms != null ? " · " + av[i].ms + "ms" : "");
      html +=
        '<div title="' +
        esc(title) +
        '" style="width:4px;height:16px;border-radius:1px;background:' +
        (HEALTH[s] || HEALTH.unknown) +
        ';opacity:.85"></div>';
    }
    return html + "</div>";
  }

  function miniHeat(card) {
    var rows = card.heatmap || [];
    if (!rows.length) return '<div style="font-size:10px;color:var(--fg-subtle)">—</div>';
    var html = '<div style="display:grid;grid-template-columns:repeat(10, 8px);gap:1.5px">';
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells || [];
      for (var t = 0; t < cells.length; t++) {
        var age = 9 - t;
        var when = age === 0 ? labels.today : age + " " + labels.daysAgo;
        var cell = cells[t];
        html +=
          '<div title="' +
          esc((rows[r].claimedModelId || "") + " · " + when + " — " + (cell.kind || "")) +
          '" style="width:8px;height:8px;border-radius:1px;background:' +
          cellBg(cell) +
          '"></div>';
      }
    }
    return html + "</div>";
  }

  function rowHtml(card, open) {
    var stale =
      card.staleProbeCount > 0
        ? '<div style="font-size:10px;color:var(--fg-subtle);margin-top:2px">+ ' +
          card.staleProbeCount +
          " " +
          esc(labels.stale) +
          "</div>"
        : "";
    var trSt =
      (rowStyle ? rowStyle + ";" : "") +
      "border-bottom:" +
      (open ? "none" : "1px solid var(--border)") +
      ";background:" +
      (open ? "var(--sl3)" : "transparent") +
      ";cursor:pointer";
    return (
      '<tr data-bl-host="' +
      esc(card.host) +
      '" data-bl-url="' +
      esc(card.baseUrl) +
      '" style="' +
      trSt +
      '">' +
      '<td style="' +
      tdStyle(0) +
      '">' +
      "<div><span style=\"font-size:10px;color:var(--fg-subtle);margin-right:4px\">" +
      (open ? "▾" : "▸") +
      '</span><span style="font-family:ui-monospace, monospace;font-weight:600;font-size:14px;color:var(--fg)">' +
      esc(card.host) +
      "</span></div>" +
      '<div style="font-size:11px;font-family:ui-monospace, monospace;color:var(--fg-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
      esc(card.baseUrl) +
      '">' +
      esc(card.baseUrl) +
      "</div>" +
      stale +
      "</td>" +
      '<td style="' +
      tdStyle(1) +
      '">' +
      sparkHtml(card) +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--fg-muted);font-family:ui-monospace, monospace;margin-top:4px;gap:6px">' +
      '<span style="color:' +
      HEALTH[card.health] +
      ';font-weight:600">' +
      esc(labels.health[card.health] || card.health) +
      "</span><span>" +
      (card.uptimePct != null ? card.uptimePct + "%" : "—") +
      "</span></div></td>" +
      '<td style="' +
      tdStyle(2) +
      '"><div style="display:flex;flex-direction:column;gap:4px">' +
      '<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:' +
      VERDICT[card.verdict] +
      '"><span style="width:8px;height:8px;border-radius:50%;background:' +
      VERDICT[card.verdict] +
      '"></span>' +
      esc(labels.verdict[card.verdict] || card.verdict) +
      "</span>" +
      miniHeat(card) +
      "</div></td>" +
      '<td style="' +
      tdStyle(3, "text-align:right;font-family:ui-monospace, monospace") +
      '">' +
      (card.claimedModelCount != null ? card.claimedModelCount : "—") +
      "</td>" +
      '<td style="' +
      tdStyle(4, "text-align:right;font-family:ui-monospace, monospace;color:" + scoreColor(card.bestScore) + ";font-weight:" + (card.bestScore != null ? 600 : 400)) +
      '">' +
      (card.bestScore != null ? card.bestScore : "—") +
      "</td>" +
      '<td style="' +
      tdStyle(5, "text-align:right;font-family:ui-monospace, monospace;color:var(--fg-muted)") +
      '">' +
      (card.avgLatencyMs != null ? card.avgLatencyMs + "ms" : "—") +
      "</td>" +
      '<td style="' +
      tdStyle(6, "text-align:right;font-family:ui-monospace, monospace;color:var(--fg-muted)") +
      '">' +
      relTime(card.lastProbedAt) +
      "</td>" +
      '<td style="' +
      tdStyle(7, "text-align:right;font-family:ui-monospace, monospace;color:var(--fg-muted)") +
      '">' +
      relTime(card.firstSeenAt) +
      "</td></tr>"
    );
  }

  function heatmapBox(card, hideExpired) {
    var rows = (card.heatmap || []).filter(function (r) {
      if (!hideExpired) return true;
      return (r.cells || []).some(function (c) {
        return c.kind && c.kind !== "empty";
      });
    });
    if (!rows.length) return '<div style="font-size:11px;color:var(--fg-muted);padding:8px 0">—</div>';
    var html =
      '<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<span style="font-size:11px;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.05em">' +
      esc(labels.heatmapTitle) +
      "</span>" +
      '<span style="display:flex;gap:10px;font-size:10px;color:var(--fg-muted)">' +
      legendSwatch(KIND.pass, labels.legendPass) +
      legendSwatch(KIND.family, labels.legendFamily) +
      legendSwatch(KIND.swap, labels.legendSwap) +
      legendSwatch("var(--border)", labels.legendEmpty) +
      "</span></div>" +
      '<div style="display:grid;grid-template-columns:minmax(180px, 240px) repeat(10, 14px);gap:2px;font-size:10px">';
    for (var i = 0; i < rows.length; i++) {
      html +=
        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-muted)" title="' +
        esc(rows[i].claimedModelId || "") +
        '">' +
        esc(rows[i].claimedModelId || "") +
        "</div>";
      var cells = rows[i].cells || [];
      for (var t = 0; t < cells.length; t++) {
        html += '<div style="width:14px;height:14px;border-radius:2px;background:' + cellBg(cells[t]) + '"></div>';
      }
    }
    return html + "</div></div>";
  }

  function modelSection(card, kind) {
    var color =
      kind === "match" ? VERDICT.trusted : kind === "family" ? VERDICT.suspect : kind === "swap" ? VERDICT.untrusted : "var(--fg-subtle)";
    var models = (card.models || []).filter(function (m) {
      return m.bucket === kind;
    });
    if (!models.length) return "";
    var html =
      '<div style="margin-top:14px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:' +
      color +
      ';margin-bottom:6px">' +
      esc(labels["section_" + kind] || kind) +
      " (" +
      models.length +
      ")</div>";
    html += '<table style="width:100%;font-size:11px;border-collapse:collapse"><tbody>';
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      html +=
        '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:6px;font-family:ui-monospace, monospace">' +
        esc(m.claimedModelId || "") +
        "</td>" +
        '<td style="padding:6px;color:var(--fg-muted)">' +
        esc(m.servedFamily || m.canonicalModelId || "") +
        "</td>" +
        '<td style="padding:6px;text-align:right;font-family:ui-monospace, monospace;color:' +
        scoreColor(m.bestScore) +
        '">' +
        (m.bestScore != null ? m.bestScore : "—") +
        "</td>" +
        '<td style="padding:6px;text-align:right;color:var(--fg-muted)">' +
        (m.lastLatencyMs != null ? m.lastLatencyMs + "ms" : "—") +
        "</td>" +
        '<td style="padding:6px;text-align:right;color:var(--fg-muted)">' +
        relTime(m.lastProbedAt) +
        "</td></tr>";
    }
    return html + "</tbody></table></div>";
  }

  function detailHtml(card, hideExpired) {
    var inner =
      heatmapBox(card, hideExpired) +
      modelSection(card, "swap") +
      modelSection(card, "family") +
      modelSection(card, "match") +
      (hideExpired ? "" : modelSection(card, "unknown"));
    return (
      '<tr data-bl-detail="1" style="background:var(--sl2);border-bottom:1px solid var(--border)">' +
      '<td colspan="8" style="padding:14px 18px 18px 30px">' +
      inner +
      "</td></tr>"
    );
  }

  function spacer(h) {
    if (h <= 0) return "";
    return '<tr data-bl-spacer="1" style="height:' + h + 'px"><td colspan="8" style="padding:0;border:none"></td></tr>';
  }

  function onBodyClick(ev) {
    var tr = ev.target && ev.target.closest ? ev.target.closest("tr[data-bl-host]") : null;
    if (!tr) return;
    var host = tr.getAttribute("data-bl-host");
    if (expanded === host) {
      expanded = "";
      detailCard = null;
      schedulePaint();
      return;
    }
    expanded = host;
    detailCard = null;
    schedulePaint();
    nativeFetch("/api/probe/relay-verdicts?q=" + encodeURIComponent(host) + "&exact=1&limit=1")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if ((data.cards || [])[0]) detailCard = data.cards[0];
        schedulePaint();
      })
      .catch(function () {});
  }

  function mountVirt(official) {
    var card = findFilterCard();
    if (!card || !official) return false;
    harvest(official);
    if (!virtTable) {
      virtTable = official.cloneNode(false);
      virtTable.setAttribute("data-bl-virt", "1");
      var cg = official.querySelector("colgroup");
      if (cg) virtTable.appendChild(cg.cloneNode(true));
      else {
        virtTable.innerHTML =
          '<colgroup><col style="width:26%"><col style="width:10%"><col style="width:16%"><col style="width:8%"><col style="width:8%"><col style="width:10%"><col style="width:11%"><col style="width:11%"></colgroup>';
      }
      if (official.tHead) virtTable.appendChild(official.tHead.cloneNode(true));
      virtBody = document.createElement("tbody");
      virtTable.appendChild(virtBody);
      virtBody.addEventListener("click", onBodyClick);
    }
    var wrap = virtTable.parentElement;
    if (!wrap || wrap.getAttribute("data-bl-virt-wrap") !== "1") {
      wrap = official.parentElement ? official.parentElement.cloneNode(false) : document.createElement("div");
      wrap.setAttribute("data-bl-virt-wrap", "1");
      if (!wrap.style.overflowX) wrap.style.overflowX = "auto";
      wrap.appendChild(virtTable);
    }
    hideOfficialList(card, official);
    var row = findToolbarRow(card);
    if (row && row.parentNode === card) {
      var next = row.nextElementSibling;
      if (next !== wrap) card.insertBefore(wrap, next);
    } else if (wrap.parentNode !== card) {
      card.appendChild(wrap);
    }
    return true;
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

  function paintInner() {
    var f = filters();
    var key = f.q + "|" + f.verdict + "|" + f.sort;
    if (key !== lastKey) {
      filtered = applyFilter(cards, f);
      heights = new Array(filtered.length);
      for (var i = 0; i < filtered.length; i++) heights[i] = EST_ROW;
      lastKey = key;
    }

    var official = findOfficialTable();
    if (official) harvest(official);
    if (!filtered.length) {
      if (virtTable) virtTable.style.display = "none";
      return;
    }
    if (!mountVirt(official)) return;
    virtTable.style.display = "";

    var top = virtTable.getBoundingClientRect().top;
    var scrollY = Math.max(0, -top);
    var start = indexAt(scrollY);
    start = Math.max(0, start - OVERSCAN);
    var viewH = window.innerHeight + OVERSCAN * EST_ROW * 2;
    var end = start;
    var acc = 0;
    while (end < filtered.length && acc < viewH) {
      acc += heights[end] || EST_ROW;
      end += 1;
    }
    end = Math.min(filtered.length, end + OVERSCAN);

    var html = spacer(offsetOf(start));
    for (var n = start; n < end; n++) {
      var card = filtered[n];
      var open = expanded && (card.host === expanded || card.baseUrl === expanded);
      html += rowHtml(card, open);
      if (open) html += detailHtml(detailCard || card, f.hideExpired);
    }
    html += spacer(offsetOf(filtered.length) - offsetOf(end));
    virtBody.innerHTML = html;

    var vis = virtBody.querySelectorAll("tr[data-bl-host]");
    for (var v = 0; v < vis.length; v++) {
      var idx = start + v;
      var h = vis[v].offsetHeight;
      var next = vis[v].nextElementSibling;
      if (next && next.getAttribute("data-bl-detail")) h += next.offsetHeight;
      if (h > 0) heights[idx] = h;
    }
  }

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(paint);
  }

  function indexCards(list) {
    var i = 0;
    function chunk() {
      var end = Math.min(i + 400, list.length);
      for (; i < end; i++) {
        var c = list[i];
        var ids = "";
        var ms = c.models || [];
        for (var j = 0; j < ms.length; j++) ids += " " + (ms[j].claimedModelId || "");
        c._q = (String(c.host || "") + " " + String(c.baseUrl || "") + ids).toLowerCase();
      }
      if (i < list.length) setTimeout(chunk, 0);
    }
    chunk();
  }

  function applyData(data, isBoot) {
    var next = (data && data.cards) || [];
    if (!next.length) return;
    if (isBoot && fullReady) return;
    if (isBoot && cards.length > next.length) return;
    cards = next;
    if (!isBoot) indexCards(cards);
    else {
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var ids = "";
        var ms = c.models || [];
        for (var j = 0; j < ms.length; j++) ids += " " + (ms[j].claimedModelId || "");
        c._q = (String(c.host || "") + " " + String(c.baseUrl || "") + ids).toLowerCase();
      }
    }
    ready = true;
    if (!isBoot) fullReady = true;
    lastKey = "";
    schedulePaint();
  }

  function loadIndex() {
    var bootP = window.__blPulseBootP;
    var indexP = window.__blPulseIndexP;
    if (bootP && bootP.then) {
      bootP
        .then(function (data) {
          applyData(data, true);
        })
        .catch(function () {});
    }
    var full =
      indexP && indexP.then
        ? indexP
        : nativeFetch("/__bl/pulse-index.json").then(function (r) {
            return r.json();
          });
    full
      .then(function (data) {
        applyData(data, false);
      })
      .catch(function () {
        return nativeFetch("/api/probe/relay-verdicts?mode=index")
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            applyData(data, false);
          });
      });
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
      "change",
      function (ev) {
        if (ev.target && (ev.target.tagName === "SELECT" || ev.target.tagName === "INPUT")) schedulePaint();
      },
      true,
    );
    document.addEventListener(
      "click",
      function () {
        setTimeout(schedulePaint, 50);
      },
      true,
    );
    window.addEventListener("scroll", schedulePaint, { passive: true });
    window.addEventListener("resize", schedulePaint);
  }

  bind();
  loadIndex();

  var mountTries = 0;
  function waitMount() {
    if (ready) schedulePaint();
    mountTries += 1;
    if (mountTries < 180) requestAnimationFrame(waitMount);
  }
  waitMount();

  var obsTimer = 0;
  var obs = new MutationObserver(function (muts) {
    if (!ready || painting) return;
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (virtTable && (t === virtTable || virtTable.contains(t))) continue;
      clearTimeout(obsTimer);
      obsTimer = setTimeout(schedulePaint, 40);
      return;
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
