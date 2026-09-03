/* History tab: feed merged (official + local SQLite) pages into the official React state.
   The table is rendered entirely by official code; we only add a pager under it.
   Fail open: if the state setter cannot be found, page 1 still shows merged data. */
(function () {
  if (window.__blHistVirt) return;
  if (/[?&]blperf=off(?:[&#]|$)/.test(location.search)) return;
  window.__blHistVirt = true;

  var PAGE = 50;
  var query = { q: "", band: "all", page: 1 };
  try {
    var savedPage = Number(sessionStorage.getItem("bl:hist:page") || 1);
    if (savedPage > 1) query.page = savedPage;
    sessionStorage.removeItem("bl:hist:page");
  } catch (e) {}
  var last = null; // last payload from /__bl/history-page.json
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

  function historyTabActive() {
    try {
      return new URLSearchParams(location.search).get("tab") === "history";
    } catch (e) {
      return false;
    }
  }

  function pageUrl(q) {
    return (
      "/__bl/history-page.json?limit=" + PAGE +
      "&page=" + encodeURIComponent(String(q.page || 1)) +
      "&q=" + encodeURIComponent(q.q || "") +
      "&band=" + encodeURIComponent(q.band || "all")
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
    var input = findSearch();
    var el = input;
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
      if (tables[i].querySelectorAll("col").length === 6) return tables[i];
      var ths = tables[i].tHead && tables[i].tHead.rows[0] ? tables[i].tHead.rows[0].cells.length : 0;
      if (ths === 6) return tables[i];
    }
    return null;
  }

  function pills(card) {
    var out = [];
    if (!card) return out;
    var buttons = card.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var st = buttons[i].getAttribute("style") || "";
      if (/border-radius:\s*999px/.test(st)) out.push(buttons[i]);
    }
    return out;
  }

  function readBand(card) {
    var list = pills(card);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].getAttribute("style") || "";
      var active = /background:\s*var\(--fg\)/.test(st);
      if (active && !pillActiveStyle) pillActiveStyle = st;
      if (!active && !pillStyle) pillStyle = st;
      if (!active) continue;
      var txt = (list[i].textContent || "").trim();
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
    if (!Array.isArray(arr) || !rows) return false;
    if (arr.length !== rows.length) return false;
    if (!arr.length) return true;
    return arr[0] && rows[0] && arr[0].id === rows[0].id && arr[arr.length - 1].id === rows[rows.length - 1].id;
  }

  function scanHooks(fiber, rows) {
    var hook = fiber && fiber.memoizedState;
    var hg = 0;
    while (hook && typeof hook === "object" && hg++ < 80) {
      if (hook.queue && typeof hook.queue.dispatch === "function" && sameRows(hook.memoizedState, rows)) {
        return hook.queue.dispatch;
      }
      hook = hook.next;
    }
    return null;
  }

  function findDispatch(rows) {
    var table = findTable();
    var fiber = fiberOf(table);
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
    var html = btn("‹ 上一页", p <= 1 || loading, p - 1);
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

  function makePager(pos) {
    var pager = document.createElement("div");
    pager.setAttribute("data-bl-hist-pager", pos);
    pager.setAttribute("style", "display:flex;align-items:center;flex-wrap:wrap;gap:8px;" + (pos === "top" ? "margin-bottom:14px" : "margin-top:14px"));
    pager.addEventListener("click", function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest("button[data-bl-page]") : null;
      if (!b || b.disabled) return;
      goTo(Number(b.getAttribute("data-bl-page")));
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

  function placePager(pos, table, html) {
    var pager = document.querySelector('[data-bl-hist-pager="' + pos + '"]');
    if (!pager) pager = makePager(pos);
    var wrap = table.parentElement || table;
    var parent = wrap.parentNode;
    if (!parent) return;
    var want = pos === "top" ? wrap : wrap.nextSibling;
    if (pager.parentNode !== parent || (pos === "top" ? pager.nextSibling !== wrap : pager.previousSibling !== wrap)) {
      parent.insertBefore(pager, want);
    }
    pager.style.display = last.pages > 1 ? "flex" : "none";
    if (pager.getAttribute("data-bl-html") !== html) {
      pager.setAttribute("data-bl-html", html);
      pager.innerHTML = html;
    }
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
    document.body.setAttribute("data-bl-hist-page", String(last && historyTabActive() ? last.page : 1));
  }

  function renderPager() {
    var table = findTable();
    var pagers = document.querySelectorAll("[data-bl-hist-pager]");
    if (!historyTabActive() || !table || !last) {
      for (var i = 0; i < pagers.length; i++) pagers[i].style.display = "none";
      if (document.body) document.body.removeAttribute("data-bl-hist-page");
      return;
    }
    readBand(findCard());
    setRunningVisibility();
    placePager("bottom", table, pagerHtml());
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
        if (!dispatch && last) dispatch = findDispatch(last.history);
        if (!inject(data)) {
          // Cannot reach the React state: reload and let the first-paint rewrite fetch this page.
          try {
            sessionStorage.setItem("bl:hist:page", String(query.page));
          } catch (e) {}
          location.reload();
          return;
        }
        renderPager();
      })
      .catch(function () {
        loading = false;
        renderPager();
      });
  }

  function goTo(page) {
    if (!last) return;
    if (page < 1 || page > last.pages || page === query.page) return;
    if (window.console && console.debug) console.debug("[bl-hist] goTo", page, "dispatch", !!dispatch);
    load({ q: query.q, band: query.band, page: page });
    var table = findTable();
    var card = findCard();
    var anchor = card || table;
    if (anchor && anchor.getBoundingClientRect().top < 0) anchor.scrollIntoView({ block: "start" });
  }

  function syncFilters() {
    if (!historyTabActive()) return;
    var card = findCard();
    var input = findSearch();
    var q = input ? String(input.value || "").trim() : "";
    var band = readBand(card);
    if (q === query.q && band === query.band) return;
    load({ q: q, band: band, page: 1 });
  }

  function afterOfficialFetch(data) {
    // Official code just stored data.history in its state; remember it and locate the setter.
    last = data;
    requestAnimationFrame(function () {
      dispatch = findDispatch(data.history) || dispatch;
      renderPager();
    });
  }

  /* ---------- wiring ---------- */

  if (typeof window.__blOnResponse === "function") {
    window.__blOnResponse(/^\/__bl\/history-page\.json$/, afterOfficialFetch);
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
    setTimeout(renderPager, 80);
  });
})();
