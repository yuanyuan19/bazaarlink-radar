/* bazaarlink-radar: stagger APIs, skip offscreen paint, slim the Pulse
   first paint so React does not hydrate 6000 rows. Fail open. */
(function () {
  if (window.__blPerf) return;
  if (/[?&]blperf=off(?:[&#]|$)/.test(location.search)) return;
  window.__blPerf = true;

  var MAX_ACTIVE = 2;
  var RELEASE_MS = 1200;
  var FAR = 1.5;
  var NEAR = "150%";
  var SCAN_LIMIT = 400;
  var MAX_DEPTH = 4;
  var MIN_HEIGHT = 240;

  function rewriteVerdictsUrl(url) {
    var raw = String(url || "");
    var path = raw.split("?")[0];
    if (!/\/api\/probe\/relay-verdicts\/?$/.test(path)) return raw;
    if (/[?&](limit|mode|exact)=/.test(raw)) return raw;
    return raw + (raw.indexOf("?") >= 0 ? "&" : "?") + "limit=24";
  }

  function rewriteHistoryUrl(url) {
    var raw = String(url || "");
    var path = raw.split("?")[0];
    if (!/\/api\/probe\/history\/?$/.test(path)) return raw;
    if (/[?&]limit=/.test(raw)) return raw;
    return raw + (raw.indexOf("?") >= 0 ? "&" : "?") + "limit=50";
  }

  function rewritePerfUrl(url) {
    var next = rewriteVerdictsUrl(url);
    return rewriteHistoryUrl(next);
  }

  /* ---------- 1. stagger same-origin API GETs ---------- */

  var active = 0;
  var queue = [];
  var released = false;

  function release() {
    if (released) return;
    released = true;
    pump();
  }

  function pump() {
    while (released && active < MAX_ACTIVE && queue.length) {
      active += 1;
      queue.shift()();
    }
  }

  function settle() {
    active = active > 0 ? active - 1 : 0;
    pump();
  }

  function slot() {
    return new Promise(function (resolve) {
      queue.push(resolve);
      pump();
    });
  }

  setTimeout(release, RELEASE_MS);
  addEventListener("load", release);
  requestAnimationFrame(function () {
    requestAnimationFrame(release);
  });

  function deferrable(method, url) {
    if (String(method || "GET").toUpperCase() !== "GET") return false;
    var u;
    try {
      u = new URL(String(url), location.href);
    } catch (e) {
      return false;
    }
    if (u.origin !== location.origin || u.pathname.indexOf("/api/") !== 0) return false;
    if (/[?&](mode|exact)=/.test(u.search)) return false;
    return true;
  }

  var nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch) {
    window.__blNativeFetch = nativeFetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var next = rewritePerfUrl(url);
      if (next !== url) {
        if (typeof input === "string") input = next;
        else if (input && typeof Request !== "undefined" && input instanceof Request) input = new Request(next, input);
        url = next;
      }
      var method = (init && init.method) || (input && input.method) || "GET";
      if (!deferrable(method, url)) return nativeFetch(input, init);
      return slot().then(function () {
        var p;
        try {
          p = nativeFetch(input, init);
        } catch (err) {
          settle();
          throw err;
        }
        return p.then(
          function (res) {
            settle();
            return res;
          },
          function (err) {
            settle();
            throw err;
          },
        );
      });
    };
  }

  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    window.XMLHttpRequest = function () {
      var xhr = new NativeXHR();
      var open = xhr.open;
      var send = xhr.send;
      xhr.open = function (method, url) {
        xhr.__blUrl = rewritePerfUrl(url);
        arguments[1] = xhr.__blUrl;
        xhr.__blDefer = deferrable(method, xhr.__blUrl);
        return open.apply(xhr, arguments);
      };
      xhr.send = function () {
        if (!xhr.__blDefer) return send.apply(xhr, arguments);
        var args = arguments;
        xhr.addEventListener("loadend", settle, { once: true });
        slot().then(function () {
          try {
            send.apply(xhr, args);
          } catch (err) {
            settle();
          }
        });
      };
      return xhr;
    };
    window.XMLHttpRequest.prototype = NativeXHR.prototype;
  }

  /* ---------- 2. let the browser skip rendering of far-offscreen blocks ---------- */

  var style = document.createElement("style");
  style.setAttribute("data-bl-perf", "1");
  style.textContent =
    "[data-bl-defer]{content-visibility:auto;contain-intrinsic-size:auto var(--bl-h,600px)}";
  (document.head || document.documentElement).appendChild(style);

  /* Table internals are excluded: content-visibility on rows or cells changes
     column sizing, which would be a visible layout change. */
  var SKIP = {
    HTML: 1,
    HEAD: 1,
    BODY: 1,
    SCRIPT: 1,
    STYLE: 1,
    LINK: 1,
    TABLE: 1,
    THEAD: 1,
    TBODY: 1,
    TFOOT: 1,
    TR: 1,
    TD: 1,
    TH: 1,
    COL: 1,
    COLGROUP: 1,
    CAPTION: 1,
    SELECT: 1,
    OPTION: 1,
    OPTGROUP: 1,
    SVG: 1,
    CANVAS: 1,
  };

  var io =
    window.IntersectionObserver &&
    new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          undefer(entries[i].target);
          io.unobserve(entries[i].target);
        }
      },
      { rootMargin: NEAR },
    );

  var touching = false;

  function undefer(el) {
    touching = true;
    el.removeAttribute("data-bl-defer");
    el.style.removeProperty("--bl-h");
    touching = false;
  }

  function defer(el, height) {
    touching = true;
    el.style.setProperty("--bl-h", Math.round(height) + "px");
    el.setAttribute("data-bl-defer", "");
    touching = false;
    if (io) io.observe(el);
  }

  function measure(el) {
    if (!el || el.nodeType !== 1) return 0;
    if (SKIP[el.tagName.toUpperCase()]) return 0;
    if (el.hasAttribute("data-bl-defer") || el.hasAttribute("data-bl-virt-wrap") || el.hasAttribute("data-bl-official-list")) return 0;
    if (el.parentElement && el.parentElement.closest("[data-bl-defer]")) return 0;
    if (document.activeElement && el.contains(document.activeElement)) return 0;
    var cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "sticky") return 0;
    if (cs.display === "inline" || cs.display === "contents") return 0;
    var r = el.getBoundingClientRect();
    if (r.height < MIN_HEIGHT) return 0;
    if (r.top < window.innerHeight * FAR) return 0;
    if (el.children.length < 3 && r.height < 600) return 0;
    return r.height;
  }

  function scan() {
    var root = document.querySelector("main") || document.body;
    if (!root || !io) return;
    var q = [];
    for (var i = 0; i < root.children.length; i++) q.push([root.children[i], 0]);
    var seen = 0;
    while (q.length && seen < SCAN_LIMIT) {
      var pair = q.shift();
      var el = pair[0];
      var depth = pair[1];
      seen += 1;
      var h = measure(el);
      if (h) {
        defer(el, h);
        continue;
      }
      if (depth >= MAX_DEPTH) continue;
      for (var j = 0; j < el.children.length; j++) q.push([el.children[j], depth + 1]);
    }
  }

  var scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = 0;
      if (window.requestIdleCallback) requestIdleCallback(scan, { timeout: 1000 });
      else scan();
    }, 200);
  }

  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (touching) return;
      scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  addEventListener("scroll", scheduleScan, { passive: true });
  addEventListener("resize", scheduleScan);

  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", scheduleScan);
  } else {
    scheduleScan();
  }
})();
