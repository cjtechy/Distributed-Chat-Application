(function () {
  "use strict";

  function ensureAppDialog() {
    var root = document.getElementById("app-dialog");
    if (root) return root;
    root = document.createElement("div");
    root.id = "app-dialog";
    root.className = "app-dialog";
    root.hidden = true;
    root.innerHTML =
      '<div class="app-dialog-backdrop" data-dialog-cancel></div>' +
      '<div class="app-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">' +
      '<h2 id="app-dialog-title"></h2>' +
      '<p id="app-dialog-body"></p>' +
      '<textarea id="app-dialog-input" rows="4" hidden></textarea>' +
      '<div class="app-dialog-actions">' +
      '<button type="button" class="btn-ghost" data-dialog-cancel>Cancel</button>' +
      '<button type="button" class="btn-danger" id="app-dialog-confirm">OK</button>' +
      "</div></div>";
    document.body.appendChild(root);
    return root;
  }

  function openAppDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var root = ensureAppDialog();
      var title = root.querySelector("#app-dialog-title");
      var body = root.querySelector("#app-dialog-body");
      var input = root.querySelector("#app-dialog-input");
      var confirmBtn = root.querySelector("#app-dialog-confirm");
      var settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        root.hidden = true;
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }

      function onKey(event) {
        if (event.key === "Escape") close(options.prompt ? null : false);
      }

      title.textContent = options.title || "Are you sure?";
      body.textContent = options.body || "";
      body.hidden = !options.body;
      confirmBtn.textContent = options.confirmLabel || "OK";
      confirmBtn.className = options.danger ? "btn-danger" : "btn-primary";
      if (options.prompt) {
        input.hidden = false;
        input.value = options.value || "";
      } else {
        input.hidden = true;
        input.value = "";
      }

      root.hidden = false;
      document.addEventListener("keydown", onKey);
      confirmBtn.onclick = function () {
        close(options.prompt ? input.value : true);
      };
      root.querySelectorAll("[data-dialog-cancel]").forEach(function (el) {
        el.onclick = function () {
          close(options.prompt ? null : false);
        };
      });
      if (options.prompt) {
        input.focus();
        input.select();
      } else {
        confirmBtn.focus();
      }
    });
  }

  window.appConfirm = function (options) {
    return openAppDialog(Object.assign({ prompt: false }, options));
  };
  window.appPrompt = function (options) {
    return openAppDialog(Object.assign({ prompt: true, danger: false }, options));
  };

  var NOTIFY_KEY = "chat_notify_prefs";
  var NOTIFY_DEFAULTS = {
    messageSound: true,
    messageWhileTyping: true,
    typingSound: true,
    voiceSound: true,
    callSound: true,
    vibrate: true
  };

  function readNotifyPrefs() {
    var merged = Object.assign({}, NOTIFY_DEFAULTS);
    try {
      var raw = localStorage.getItem(NOTIFY_KEY);
      if (!raw) return merged;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.keys(NOTIFY_DEFAULTS).forEach(function (key) {
          if (typeof parsed[key] === "boolean") merged[key] = parsed[key];
        });
      }
    } catch (err) {}
    return merged;
  }

  window.chatNotify = {
    defaults: NOTIFY_DEFAULTS,
    get: readNotifyPrefs,
    enabled: function (key) {
      var prefs = readNotifyPrefs();
      if (Object.prototype.hasOwnProperty.call(prefs, key)) return prefs[key];
      return true;
    },
    set: function (partial) {
      var next = Object.assign(readNotifyPrefs(), partial || {});
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(next));
      return next;
    }
  };

  var LANG_KEY = "chat_lang";
  var APP_LANGS = [
    { id: "device", name: "Device language", hint: "Use this phone's language" },
    { id: "en", name: "English", hint: "English" },
    { id: "en-GB", name: "English (UK)", hint: "English (United Kingdom)" },
    { id: "he", name: "Hebrew", hint: "עברית" },
    { id: "ar", name: "Arabic", hint: "العربية" },
    { id: "el", name: "Greek", hint: "Ελληνικά" },
    { id: "ru", name: "Russian", hint: "Русский" },
    { id: "tr", name: "Turkish", hint: "Türkçe" },
    { id: "fr", name: "French", hint: "Français" },
    { id: "de", name: "German", hint: "Deutsch" },
    { id: "es", name: "Spanish", hint: "Español" },
    { id: "uk", name: "Ukrainian", hint: "Українська" }
  ];

  function selectedLangId() {
    var id = localStorage.getItem(LANG_KEY) || "device";
    var known = APP_LANGS.some(function (item) { return item.id === id; });
    return known ? id : "device";
  }

  function langHtmlTag(id) {
    if (id === "device") return (navigator.language || "en").split("-")[0] || "en";
    return id;
  }

  function languageSummary() {
    var id = selectedLangId();
    if (id === "device") {
      var navLow = (navigator.language || "en").toLowerCase();
      var match = APP_LANGS.filter(function (item) { return item.id !== "device"; })
        .slice()
        .sort(function (a, b) { return b.id.length - a.id.length; })
        .find(function (item) {
          var code = item.id.toLowerCase();
          return navLow === code || navLow.indexOf(code + "-") === 0 || (code.indexOf("-") === -1 && navLow.split("-")[0] === code);
        });
      return (match ? match.hint : (navigator.language || "en")) + " (device's language)";
    }
    var item = APP_LANGS.find(function (row) { return row.id === id; });
    return item ? item.hint : "English";
  }

  function applyAppLang() {
    document.documentElement.lang = langHtmlTag(selectedLangId());
    var label = document.getElementById("settings-language-label");
    if (label) label.textContent = languageSummary();
  }

  window.chatLang = {
    list: APP_LANGS,
    get: selectedLangId,
    set: function (id) {
      localStorage.setItem(LANG_KEY, id);
      applyAppLang();
      return id;
    },
    summary: languageSummary
  };

  applyAppLang();

  var token = localStorage.getItem("token");
  var username = localStorage.getItem("username");
  var next = window.location.pathname || "/console";
  var path = (window.location.pathname || "").replace(/\/$/, "") || "/console";
  path = path.replace(/\/index\.html$/i, "").replace(/\.html$/i, "") || "/console";
  if (path.indexOf("/console/chat") === 0) path = "/console";
  if (path.indexOf("/console/settings") === 0) path = "/console/settings";
  if (!token || !username) {
    if (path === "/admin" || path === "/admin.html") return;
    window.location.replace("/auth/login?next=" + encodeURIComponent(next));
    return;
  }

  var nameEl = document.getElementById("console-username");
  if (nameEl) nameEl.textContent = username;
  if (nameEl && !document.getElementById("rail-avatar")) {
    var railAvatar = document.createElement("span");
    railAvatar.className = "rail-avatar";
    railAvatar.id = "rail-avatar";
    railAvatar.setAttribute("aria-hidden", "true");
    nameEl.before(railAvatar);
  }

  var settingsName = document.getElementById("settings-username");
  if (settingsName) settingsName.textContent = username;

  var settingsAvatar = document.getElementById("settings-avatar");
  if (settingsAvatar) settingsAvatar.textContent = username ? username.charAt(0).toUpperCase() : "?";

  document.querySelectorAll("#tab-avatar, #rail-avatar").forEach(function (avatar) {
    avatar.textContent = username ? username.charAt(0).toUpperCase() : "?";
  });

  var adminLink = document.getElementById("console-admin");
  function setAdminVisible(isAdmin) {
    document.querySelectorAll("#console-admin, .js-admin-link").forEach(function (link) {
      link.hidden = !isAdmin;
    });
  }
  if (localStorage.getItem("is_admin") === "true") setAdminVisible(true);

  var navPath = path;
  document.querySelectorAll(".console-links a[href], .wa-tab[data-nav]").forEach(function (link) {
    var href = link.getAttribute("data-nav") || link.getAttribute("href");
    if (href === navPath || (href === "/console" && (navPath === "/console" || navPath === "/console/index.html"))) {
      link.setAttribute("aria-current", "page");
    }
  });

  var API_BASE = window.APP_CONFIG && window.APP_CONFIG.API_BASE;
  var authHeaders = { Authorization: "Bearer " + token };

  function clearSession() {
    if (API_BASE) {
      fetch(API_BASE + "/logout", {
        method: "POST",
        credentials: "include",
        headers: authHeaders,
      }).catch(function () {});
    }
    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("is_admin");
    window.location.replace("/auth/login?next=/console");
  }

  var logout = document.getElementById("console-logout");
  var moreBtn = document.getElementById("inbox-more-btn");
  var moreMenu = document.getElementById("inbox-more-menu");
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      var open = moreMenu.hidden;
      moreMenu.hidden = !open;
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    moreMenu.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    document.addEventListener("click", function () {
      moreMenu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
    });
  }
  if (logout) logout.addEventListener("click", clearSession);
  var logoutSettings = document.getElementById("console-logout-settings");
  if (logoutSettings) logoutSettings.addEventListener("click", clearSession);

  var menu = document.getElementById("console-menu");
  var nav = document.getElementById("console-nav");
  if (menu && nav) {
    menu.addEventListener("click", function () {
      nav.classList.toggle("open");
    });
  }

  if (!API_BASE) return;

  function badgeLabel(count) {
    var n = Number(count) || 0;
    if (n <= 0) return "";
    return n > 99 ? "99+" : String(n);
  }

  function paintNavBadge(href, count) {
    document.querySelectorAll('.console-links a[href="' + href + '"], .wa-tab[data-nav="' + href + '"]').forEach(function (link) {
      var badge = link.querySelector(".nav-badge");
      var label = badgeLabel(count);
      if (!label) {
        if (badge) badge.remove();
        link.removeAttribute("data-unread");
        return;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-badge";
        var ico = link.querySelector(".wa-tab-ico") || link;
        ico.appendChild(badge);
      }
      badge.textContent = label;
      link.setAttribute("data-unread", label);
    });
  }

  function applyInbox(data) {
    if (!data) return;
    paintNavBadge("/console", (Number(data.groups) || 0) + (Number(data.directs) || 0));
    paintNavBadge("/console/group", data.groups);
    paintNavBadge("/console/direct", data.directs);
  }

  function loadInbox() {
    return fetch(API_BASE + "/inbox", { headers: authHeaders })
      .then(function (response) {
        if (response.status === 401) {
          clearSession();
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then(applyInbox)
      .catch(function () {});
  }

  window.applyInbox = applyInbox;
  window.refreshInbox = loadInbox;
  loadInbox();
  setInterval(loadInbox, 12000);

  function fillSettingsEmail(email) {
    var text = (email || "").trim();
    var hero = document.getElementById("settings-email");
    if (hero) hero.textContent = text || "Add email";
    var input = document.getElementById("settings-email-input");
    if (input && document.activeElement !== input) input.value = text;
  }

  function pingMe() {
    return fetch(API_BASE + "/me", { headers: authHeaders })
      .then(function (response) {
        if (response.status === 401) {
          clearSession();
          return null;
        }
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (data) {
        if (!data) return;
        localStorage.setItem("is_admin", data.is_admin ? "true" : "false");
        setAdminVisible(Boolean(data.is_admin));
        fillSettingsEmail(data.email);
      })
      .catch(function () {
        setAdminVisible(localStorage.getItem("is_admin") === "true");
      });
  }

  pingMe();
  setInterval(pingMe, 12000);

  function avatarHue(name) {
    var hue = 0;
    String(name || "").split("").forEach(function (ch) {
      hue = (hue * 33 + ch.charCodeAt(0)) % 360;
    });
    return hue;
  }

  function formatPresence(item) {
    if (item && item.online) return "online";
    var raw = item && item.last_seen;
    if (raw == null || raw === "") return "last seen recently";
    var date;
    if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
      var n = Number(raw);
      if (n < 1e12) n *= 1000;
      date = new Date(n);
    } else {
      date = new Date(raw);
    }
    if (Number.isNaN(date.getTime())) return "last seen recently";
    var now = new Date();
    var time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    var dayDiff = Math.round((startToday - startThat) / 86400000);
    if (dayDiff === 0) return "last seen today at " + time;
    if (dayDiff === 1) return "last seen yesterday at " + time;
    if (dayDiff < 7) {
      return "last seen " + date.toLocaleDateString([], { weekday: "long" }) + " at " + time;
    }
    return "last seen " + date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function inboxTime(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    var now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function threadSnippet(item) {
    if (item.show_presence) return formatPresence(item);
    var text = item.last_message || "";
    if (!text) return item.is_direct ? "Private chat" : "No messages yet";
    if (item.last_sender && !item.is_direct) {
      return item.last_sender + ": " + text;
    }
    return text;
  }

  function makeAvatar(name, online) {
    var wrap = document.createElement("span");
    wrap.className = "avatar";
    wrap.textContent = (name || "?").charAt(0).toUpperCase();
    wrap.style.background = "hsl(" + avatarHue(name) + ", 42%, 36%)";
    wrap.style.color = "#fff";
    if (online) {
      var dot = document.createElement("span");
      dot.className = "online-dot";
      wrap.appendChild(dot);
    }
    return wrap;
  }

  function threadRow(item, extra) {
    var name = item.name || item.peer || item.username || "Chat";
    var unread = Number(item.unread_count) || 0;
    var clickable = Boolean(item.id) && !extra;
    var row = document.createElement(clickable ? "a" : "div");
    row.className = "wa-thread" + (unread ? " has-unread" : "");
    if (clickable) {
      row.href = "/console/chat?group=" + encodeURIComponent(item.id);
      var activeGroup = new URLSearchParams(window.location.search).get("group");
      if (activeGroup && String(item.id) === activeGroup) row.classList.add("is-active");
    }
    row.appendChild(makeAvatar(name, Boolean(item.online)));

    var body = document.createElement("div");
    body.className = "wa-thread-body";

    var top = document.createElement("div");
    top.className = "wa-thread-top";
    var title = document.createElement("span");
    title.className = "wa-thread-name";
    title.textContent = name;
    var time = document.createElement("span");
    time.className = "wa-thread-time";
    time.textContent = inboxTime(item.last_at);
    top.append(title, time);

    var bottom = document.createElement("div");
    bottom.className = "wa-thread-bottom";
    var snippet = document.createElement("span");
    snippet.className = "wa-thread-snippet" + (item.show_presence && item.online ? " is-online" : "");
    snippet.textContent = threadSnippet(item);
    bottom.appendChild(snippet);
    if (unread) {
      var badge = document.createElement("span");
      badge.className = "nav-badge";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      bottom.appendChild(badge);
    }
    body.append(top, bottom);
    row.appendChild(body);

    if (extra) {
      var actions = document.createElement("div");
      actions.className = "wa-thread-actions";
      actions.appendChild(extra);
      row.appendChild(actions);
    }
    return row;
  }

  window.chatUi = {
    SKELETON_TIMEOUT_MS: 8000,
    threadRow: threadRow,
    makeAvatar: makeAvatar,
    formatPresence: formatPresence,
    empty: function (text) {
      var el = document.createElement("p");
      el.className = "wa-empty";
      el.textContent = text;
      return el;
    },
    skeletonThreads: function (count) {
      var frag = document.createDocumentFragment();
      var n = count || 6;
      var i;
      for (i = 0; i < n; i += 1) {
        var row = document.createElement("div");
        row.className = "sk-thread";
        row.setAttribute("aria-hidden", "true");
        row.innerHTML = '<span class="sk-bone sk-avatar"></span><div class="sk-lines"><span class="sk-bone sk-name"></span><span class="sk-bone sk-snip"></span></div><span class="sk-bone sk-time"></span>';
        frag.appendChild(row);
      }
      return frag;
    },
    showSkeleton: function (el, count) {
      if (!el) return;
      el.setAttribute("aria-busy", "true");
      el.replaceChildren(window.chatUi.skeletonThreads(count));
    },
    timeoutPanel: function (message, onRetry) {
      var wrap = document.createElement("div");
      wrap.className = "sk-timeout";
      var p = document.createElement("p");
      p.textContent = message || "This is taking too long.";
      wrap.appendChild(p);
      if (typeof onRetry === "function") {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-primary";
        btn.textContent = "Retry";
        btn.addEventListener("click", onRetry);
        wrap.appendChild(btn);
      }
      return wrap;
    },
    armSkeletonTimeout: function (onTimeout, ms) {
      var finished = false;
      var timer = setTimeout(function () {
        timer = null;
        if (finished) return;
        finished = true;
        if (typeof onTimeout === "function") onTimeout();
      }, typeof ms === "number" ? ms : window.chatUi.SKELETON_TIMEOUT_MS);
      return function () {
        finished = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };

  function startIncomingCalls() {
    if (!window.ChatCall) return;
    window.ChatCall.init({
      getUsername: function () { return localStorage.getItem("username") || ""; },
      getToken: function () { return localStorage.getItem("token") || ""; },
      getApiBase: function () { return (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || ""; },
    });
  }

  if (window.ChatCall) {
    startIncomingCalls();
  } else {
    var callScript = document.createElement("script");
    callScript.src = "/scripts/call.js?v=layout";
    callScript.onload = startIncomingCalls;
    document.body.appendChild(callScript);
  }

  var emailSave = document.getElementById("settings-email-save");
  var emailInput = document.getElementById("settings-email-input");
  if (emailSave && emailInput) {
    emailSave.addEventListener("click", function () {
      var status = document.getElementById("settings-email-status");
      emailSave.disabled = true;
      var payload = JSON.stringify({ email: emailInput.value.trim() });
      function submitEmail(method) {
        return fetch(API_BASE + "/me", {
          method: method,
          credentials: "include",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeaders),
          body: payload,
        }).then(function (response) {
          return response.text().then(function (text) {
            var data = {};
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (err) {
                data = { detail: text };
              }
            }
            return { ok: response.ok, status: response.status, data: data };
          });
        });
      }
      function emailSaveError(result) {
        var detail = result.data && result.data.detail;
        if (Array.isArray(detail)) detail = detail.map(function (item) { return item.msg || item; }).join(" ");
        if (result.status === 405 || /method not allowed/i.test(String(detail || ""))) {
          return "Email updates are not implemented yet.";
        }
        return detail || "Could not save email";
      }
      submitEmail("PATCH")
        .then(function (response) {
          if (response.status === 405) return submitEmail("POST");
          return response;
        })
        .then(function (result) {
          if (!result.ok) {
            throw new Error(emailSaveError(result));
          }
          fillSettingsEmail(result.data.email);
          if (status) status.textContent = "Saved";
        })
        .catch(function (err) {
          var message = err.message || "Could not save email";
          if (/method not allowed/i.test(message)) message = "Email updates are not implemented yet.";
          if (status) status.textContent = message;
        })
        .then(function () {
          emailSave.disabled = false;
        });
    });
  }

  var langList = document.getElementById("language-list");
  if (langList) {
    var checkSvg =
      '<svg class="settings-check" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
    APP_LANGS.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-item settings-toggle";
      btn.setAttribute("data-lang", item.id);
      btn.innerHTML =
        '<span class="settings-copy"><b></b><small></small></span>' + checkSvg;
      btn.querySelector("b").textContent = item.name;
      btn.querySelector("small").textContent = item.hint;
      langList.appendChild(btn);
    });
    function paintLang() {
      var current = selectedLangId();
      langList.querySelectorAll("[data-lang]").forEach(function (btn) {
        var on = btn.getAttribute("data-lang") === current;
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    paintLang();
    langList.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-lang]");
      if (!btn) return;
      window.chatLang.set(btn.getAttribute("data-lang"));
      paintLang();
    });
    var langSearch = document.getElementById("language-search");
    if (langSearch) {
      langSearch.addEventListener("input", function () {
        var q = langSearch.value.trim().toLowerCase();
        langList.querySelectorAll("[data-lang]").forEach(function (btn) {
          var hay = (btn.textContent || "").toLowerCase();
          btn.hidden = Boolean(q) && hay.indexOf(q) === -1;
        });
      });
    }
  }

  document.querySelectorAll("[data-notify]").forEach(function (btn) {
    var key = btn.getAttribute("data-notify");
    function paint(on) {
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    paint(window.chatNotify.enabled(key));
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      var next = btn.getAttribute("aria-pressed") !== "true";
      var patch = {};
      patch[key] = next;
      window.chatNotify.set(patch);
      paint(next);
    });
  });

  var inboxList = document.getElementById("inbox-list");
  if (!inboxList) return;

  var inboxItems = [];
  var inboxFilter = "all";
  var inboxCount = document.getElementById("inbox-count");
  var searchWrap = document.getElementById("inbox-search-wrap");
  var searchInput = document.getElementById("inbox-search");
  var searchBtn = document.getElementById("inbox-search-btn");

  function paintInbox(filter) {
    var query = String(filter || "").trim().toLowerCase();
    var items = inboxItems.filter(function (item) {
      if (inboxFilter === "unread" && !(Number(item.unread_count) > 0)) return false;
      if (inboxFilter === "groups" && item.is_direct) return false;
      if (!query) return true;
      var hay = [item.name, item.peer, item.last_message, item.last_sender]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.indexOf(query) !== -1;
    });
    inboxList.replaceChildren();
    inboxList.removeAttribute("aria-busy");
    if (!items.length) {
      inboxList.appendChild(window.chatUi.empty(query ? "No chats match that search." : "No chats yet — start one from Direct or Groups."));
      return;
    }
    items.forEach(function (item) {
      inboxList.appendChild(threadRow(item));
    });
  }

  if (searchBtn && searchWrap) {
    searchBtn.addEventListener("click", function () {
      searchWrap.classList.toggle("open");
      if (searchWrap.classList.contains("open") && searchInput) searchInput.focus();
    });
  }
  document.querySelectorAll(".wa-chip[data-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      inboxFilter = chip.getAttribute("data-filter") || "all";
      document.querySelectorAll(".wa-chip[data-filter]").forEach(function (el) {
        el.setAttribute("aria-pressed", el === chip ? "true" : "false");
      });
      paintInbox(searchInput && searchInput.value);
    });
  });
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      paintInbox(searchInput.value);
    });
  }

  var cancelInboxTimeout = null;

  function loadInboxThreads() {
    if (cancelInboxTimeout) cancelInboxTimeout();
    window.chatUi.showSkeleton(inboxList, 7);
    cancelInboxTimeout = window.chatUi.armSkeletonTimeout(function () {
      inboxList.replaceChildren();
      inboxList.removeAttribute("aria-busy");
      inboxList.appendChild(window.chatUi.timeoutPanel("Chats took too long to load.", loadInboxThreads));
    });

    Promise.all([
      fetch(API_BASE + "/groups", { headers: authHeaders, timeoutMs: window.chatUi.SKELETON_TIMEOUT_MS }).then(function (r) {
        return r.ok ? r.json() : [];
      }),
      fetch(API_BASE + "/direct", { headers: authHeaders, timeoutMs: window.chatUi.SKELETON_TIMEOUT_MS }).then(function (r) {
        return r.ok ? r.json() : [];
      }),
    ])
      .then(function (results) {
        if (cancelInboxTimeout) cancelInboxTimeout();
        var groups = Array.isArray(results[0]) ? results[0] : [];
        var directs = Array.isArray(results[1]) ? results[1] : [];
        inboxItems = groups
          .filter(function (group) { return group.is_member && !group.is_direct; })
          .concat(directs)
          .sort(function (a, b) {
            var aTime = Date.parse(a.last_at || a.created_at || 0) || 0;
            var bTime = Date.parse(b.last_at || b.created_at || 0) || 0;
            return bTime - aTime;
          });
        var unreadTotal = inboxItems.reduce(function (sum, item) {
          return sum + (Number(item.unread_count) || 0);
        }, 0);
        if (inboxCount) {
          if (unreadTotal > 0) {
            inboxCount.hidden = false;
            inboxCount.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
          } else {
            inboxCount.hidden = true;
          }
        }
        paintInbox(searchInput && searchInput.value);
      })
      .catch(function () {
        if (cancelInboxTimeout) cancelInboxTimeout();
        inboxList.replaceChildren();
        inboxList.removeAttribute("aria-busy");
        inboxList.appendChild(window.chatUi.timeoutPanel("Could not load chats right now.", loadInboxThreads));
      });
  }

  loadInboxThreads();
})();
