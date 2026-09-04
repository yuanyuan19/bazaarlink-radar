/* History tab: feed snapshot pages (local SQLite, kept live by the mirror) into the official React state.
   The table is rendered entirely by official code; we only add a pager under it and keep ?page= in the URL.
   Fail open: if the state setter cannot be found, the first paint still shows the requested page. */
(function () {
  if (window.__blHistVirt) return;
  if (/[?&]blperf=off(?:[&#]|$)/.test(location.search)) return;
  window.__blHistVirt = true;

  var PAGE = 50;
  var query = { q: "", band: "all", page: pageFromUrl(), asOf: "" };
  var last = null;
  var dispatch = null;
  var loading = false;
  var debounceTimer = 0;
  var pillStyle = "";
  var pillActiveStyle = "";

  var nativeFetch = function () {
    return (window.__blNativeFetch || window.fetch.bind(window)).apply(window, arguments);
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function params() {
    try {
      return new URLSearchParams(location.search);
    } catch (e) {
      return new URLSearchParams("");
    }
  }

  function historyTabActive() {
    return params().get("tab") === "history";
  }

  function pageFromUrl() {
    var n = Number(params().get("page") || 1);
    return n >= 1 ? Math.floor(n) : 1;
  }

  function writePageToUrl(page) {
    try {
      var u = new URL(location.href);
      if (page > 1) u.searchParams.set("page", String(page));
      else u.searchParams.delete("page");
      if (u.toString() !== location.href) history.replaceState(history.state, "", u.toString());
    } catch (e) {}
  }

  function pageUrl(q) {
    return (
      "/__bl/history-page.json?limit=" + PAGE +
      "&page=" + encodeURIComponent(String(q.page || 1)) +
      "&q=" + encodeURIComponent(q.q || "") +
      "&band=" + encodeURIComponent(q.band || "all") +
      (q.asOf ? "&asOf=" + encodeURIComponent(q.asOf) : "")
    );
  }

  // perf.js asks us how to rewrite the official history list request.
  window.__blHistRewrite = function (url) {
    var raw = String(url || "");
    if (!/\/api\/probe\/history\/?(\?|$)/.test(raw.split("#")[0])) return raw;
    if (/\/api\/probe\/history\/[^?]/.test(raw)) return raw;
    return pageUrl(query);
  };

  /* ---------- DOM lookup ---------- */

  function findSearch() {
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var p = inputs[i].getAttribute("placeholder") || "";
      if (/筛选\s*URL|篩選\s*URL|filter\s*url/i.test(p)) return inputs[i];
    }
    return null;
  }

  function findCard() {
    var el = findSearch();
    for (var i = 0; i < 18 && el; i++) {
      var st = (el.getAttribute && el.getAttribute("style")) || "";
      if (/max-width:\s*1100px/.test(st)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findTable() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      var ths = tables[i].tHead && tables[i].tHead.rows[0] ? tables[i].tHead.rows[0].cells.length : 0;
      if (ths === 6) return tables[i];
    }
    return null;
  }

  function readBand(card) {
    if (!card) return "all";
    var buttons = card.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var st = buttons[i].getAttribute("style") || "";
      if (!/border-radius:\s*999px/.test(st)) continue;
      if (buttons[i].closest("[data-bl-hist-pager]")) continue;
      var active = /background:\s*var\(--fg\)/.test(st);
      if (active && !pillActiveStyle) pillActiveStyle = st;
      if (!active && !pillStyle) pillStyle = st;
      if (!active) continue;
      var txt = (buttons[i].textContent || "").trim();
      if (txt === "80+") return "80";
      if (txt === "50+") return "50";
      if (txt === "<50") return "low";
      if (/进行中|進行中|running/i.test(txt)) return "running";
      return "all";
    }
    return "all";
  }

  /* ---------- React state access ---------- */

  function fiberOf(node) {
    if (!node) return null;
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0) return node[keys[i]];
    }
    return null;
  }

  function sameRows(arr, rows) {
    if (!Array.isArray(arr) || !rows || arr.length !== rows.length) return false;
    if (!arr.length) return true;
    return arr[0] && rows[0] && arr[0].id === rows[0].id && arr[arr.length - 1].id === rows[rows.length - 1].id;
  }

  function scanHooks(fiber, rows) {
    var hook = fiber && fiber.memoizedState;
    var hg = 0;
    while (hook && typeof hook === "object" && hg++ < 80) {
      if (hook.queue && typeof hook.queue.dispatch === "function" && sameRows(hook.memoizedState, rows)) return hook.queue.dispatch;
      hook = hook.next;
    }
    return null;
  }

  function findDispatch(rows) {
    var fiber = fiberOf(findTable());
    var guard = 0;
    while (fiber && guard++ < 60) {
      var d = scanHooks(fiber, rows) || scanHooks(fiber.alternate, rows);
      if (d) return d;
      fiber = fiber.return;
    }
    return null;
  }

  function inject(data) {
    last = data;
    if (!dispatch) return false;
    try {
      dispatch(data.history || []);
      return true;
    } catch (e) {
      dispatch = null;
      return false;
    }
  }

  /* ---------- pager (styled like the official band pills / filter input) ---------- */

  var PILL = "font:inherit;font-size:12px;padding:5px 12px;border-radius:999px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg-muted)";
  var PILL_ON = "font:inherit;font-size:12px;padding:5px 12px;border-radius:999px;cursor:default;border:1px solid var(--fg);background:var(--fg);color:#fff";
  var INPUT = "font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);width:56px;text-align:center";

  function btn(label, disabled, page) {
    var st = pillStyle || PILL;
    if (disabled) st += ";opacity:.4;cursor:default";
    return '<button type="button" data-bl-page="' + page + '"' + (disabled ? " disabled" : "") + ' style="' + esc(st) + '">' + esc(label) + "</button>";
  }

  function pagerHtml() {
    var p = last.page, n = last.pages;
    var html = "";
    if (last.newerCount > 0) {
      html += '<button type="button" data-bl-refresh style="' + esc(pillStyle || PILL) + '">↻ ' + esc(last.newerCount + " 条新记录") + "</button>";
    }
    html += btn("‹ 上一页", p <= 1 || loading, p - 1);
    var show = [];
    for (var i = Math.max(1, p - 2); i <= Math.min(n, p + 2); i++) show.push(i);
    if (show[0] > 1) html += btn("1", loading, 1) + (show[0] > 2 ? '<span style="color:var(--fg-subtle)">…</span>' : "");
    for (var j = 0; j < show.length; j++) {
      var k = show[j];
      html += k === p ? '<button type="button" disabled style="' + esc(pillActiveStyle || PILL_ON) + '">' + k + "</button>" : btn(String(k), loading, k);
    }
    if (show[show.length - 1] < n) html += (show[show.length - 1] < n - 1 ? '<span style="color:var(--fg-subtle)">…</span>' : "") + btn(String(n), loading, n);
    html += btn("下一页 ›", p >= n || loading, p + 1);
    html +=
      '<span style="display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--fg-subtle)">' +
      esc("第 " + p + " / " + n + " 页 · 共 " + last.total + " 条") +
      '<span style="margin-left:8px">跳到</span><input data-bl-jump type="number" min="1" max="' + n + '" placeholder="' + p + '" style="' + esc(INPUT) + '"><span>页</span></span>';
    return html;
  }

  function makePager() {
    var pager = document.createElement("div");
    pager.setAttribute("data-bl-hist-pager", "1");
    pager.setAttribute("style", "display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px");
    pager.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      if (t.closest("button[data-bl-refresh]")) return refresh();
      var b = t.closest("button[data-bl-page]");
      if (b && !b.disabled) goTo(Number(b.getAttribute("data-bl-page")));
    });
    pager.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || !ev.target || !ev.target.hasAttribute("data-bl-jump")) return;
      ev.preventDefault();
      var v = Number(ev.target.value);
      if (v >= 1 && last && v <= last.pages) goTo(v);
      ev.target.value = "";
    });
    return pager;
  }

  function setRunningVisibility() {
    // Official code prepends the live "running" rows on every render; they belong to the head of the list only.
    var st = document.querySelector("style[data-bl-hist-style]");
    if (!st) {
      st = document.createElement("style");
      st.setAttribute("data-bl-hist-style", "1");
      st.textContent = 'body[data-bl-hist-page]:not([data-bl-hist-page="1"]) table tr[data-running-row],body[data-bl-hist-page]:not([data-bl-hist-page="1"]) a[data-history-card][data-running-row]{display:none}';
      (document.head || document.documentElement).appendChild(st);
    }
    document.body.setAttribute("data-bl-hist-page", String(last.page));
  }

  function renderPager() {
    var table = findTable();
    var pager = document.querySelector("[data-bl-hist-pager]");
    if (!historyTabActive() || !table || !last) {
      if (pager) pager.style.display = "none";
      if (document.body) document.body.removeAttribute("data-bl-hist-page");
      return;
    }
    readBand(findCard());
    setRunningVisibility();
    if (!pager) pager = makePager();
    var wrap = table.parentElement || table;
    var parent = wrap.parentNode;
    if (!parent) return;
    if (pager.parentNode !== parent || pager.previousSibling !== wrap) parent.insertBefore(pager, wrap.nextSibling);
    pager.style.display = last.pages > 1 || last.newerCount > 0 ? "flex" : "none";
    var html = pagerHtml();
    if (pager.getAttribute("data-bl-html") !== html) {
      pager.setAttribute("data-bl-html", html);
      pager.innerHTML = html;
    }
  }

  /* ---------- loading ---------- */

  function load(next) {
    if (loading) return;
    loading = true;
    query = next;
    renderPager();
    nativeFetch(pageUrl(query))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        loading = false;
        query.page = data.page;
        query.asOf = data.asOf || query.asOf;
        if (!dispatch && last) dispatch = findDispatch(last.history);
        if (!inject(data)) {
          writePageToUrl(query.page);
          location.reload();
          return;
        }
        writePageToUrl(query.page);
        renderPager();
      })
      .catch(function () {
        loading = false;
        renderPager();
      });
  }

  function scrollTop() {
    var anchor = findCard() || findTable();
    if (anchor && anchor.getBoundingClientRect().top < 0) anchor.scrollIntoView({ block: "start" });
  }

  function goTo(page) {
    if (!last || page < 1 || page > last.pages || page === query.page) return;
    load({ q: query.q, band: query.band, page: page, asOf: query.asOf });
    scrollTop();
  }

  // New records arrived after the snapshot: move the anchor forward and start over from page 1.
  function refresh() {
    load({ q: query.q, band: query.band, page: 1, asOf: "" });
    scrollTop();
  }

  function syncFilters() {
    if (!historyTabActive()) return;
    var input = findSearch();
    var q = input ? String(input.value || "").trim() : "";
    var band = readBand(findCard());
    if (q === query.q && band === query.band) return;
    load({ q: q, band: band, page: 1, asOf: query.asOf });
  }

  function afterOfficialFetch(data) {
    // The official code just stored data.history in its state; remember it and locate the setter.
    last = data;
    query.page = data.page || query.page;
    query.asOf = data.asOf || query.asOf;
    requestAnimationFrame(function () {
      dispatch = findDispatch(data.history) || dispatch;
      writePageToUrl(query.page);
      renderPager();
    });
  }

  // The mirror keeps SQLite live; ask it periodically whether anything newer than the anchor exists.
  // Page 1 simply moves its snapshot forward (official code never re-fetches its list, so a finished
  // run only shows up after a full reload); deeper pages keep their anchor so paging stays gap-free.
  function pollNewer() {
    if (!historyTabActive() || !last || loading) return;
    nativeFetch(pageUrl({ q: query.q, band: query.band, page: query.page, asOf: query.asOf }) + "&limit=1")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !last) return;
        if (data.newerCount > 0 && query.page === 1) {
          load({ q: query.q, band: query.band, page: 1, asOf: "" });
          return;
        }
        if (data.newerCount !== last.newerCount) {
          last.newerCount = data.newerCount;
          renderPager();
        }
      })
      .catch(function () {});
  }

  /* ---------- wiring ---------- */

  if (typeof window.__blOnResponse === "function") {
    window.__blOnResponse(/^\/__bl\/history-page\.json$/, function (data, url) {
      if (/[?&]limit=1(&|$)/.test(String(url))) return;
      afterOfficialFetch(data);
    });
  }

  document.addEventListener("input", function (ev) {
    if (!ev.target || ev.target.tagName !== "INPUT" || ev.target.hasAttribute("data-bl-jump")) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(syncFilters, 250);
  }, true);
  document.addEventListener("click", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest("[data-bl-hist-pager]")) return;
    setTimeout(syncFilters, 40);
  }, true);

  var obsTimer = 0;
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.closest && t.closest("[data-bl-hist-pager]")) continue;
      if (t === document.body && muts[i].type === "attributes") continue;
      clearTimeout(obsTimer);
      obsTimer = setTimeout(renderPager, 60);
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  ["pushState", "replaceState"].forEach(function (name) {
    var orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function () {
      var out = orig.apply(this, arguments);
      setTimeout(renderPager, 80);
      return out;
    };
  });
  window.addEventListener("popstate", function () {
    var p = pageFromUrl();
    if (historyTabActive() && last && p !== query.page) load({ q: query.q, band: query.band, page: p, asOf: query.asOf });
    setTimeout(renderPager, 80);
  });

  setInterval(pollNewer, 15000);
})();
