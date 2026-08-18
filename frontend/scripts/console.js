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

  var token = localStorage.getItem("token");
  var username = localStorage.getItem("username");
  var next = window.location.pathname || "/console";
  var path = (window.location.pathname || "").replace(/\/$/, "") || "/console";
  if (!token || !username) {
    if (path === "/admin" || path === "/admin.html") return;
    window.location.replace("/auth/login?next=" + encodeURIComponent(next));
    return;
  }

  var nameEl = document.getElementById("console-username");
  if (nameEl) nameEl.textContent = username;

  var settingsName = document.getElementById("settings-username");
  if (settingsName) settingsName.textContent = username;

  var tabAvatar = document.getElementById("tab-avatar");
  if (tabAvatar) tabAvatar.textContent = username ? username.charAt(0).toUpperCase() : "?";

  var adminLink = document.getElementById("console-admin");
  if (adminLink && localStorage.getItem("is_admin") === "true") {
    adminLink.hidden = false;
  }

  var navPath = path.indexOf("/console/chat") === 0 ? "/console" : path;
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
        link.appendChild(badge);
      }
      badge.textContent = label;
      link.setAttribute("data-unread", label);
    });
  }

  function applyInbox(data) {
    if (!data) return;
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

  function fillSettingsRole(isAdmin) {
    var roleEl = document.getElementById("settings-role");
    if (!roleEl) return;
    roleEl.textContent = isAdmin ? "Admin" : "Member";
    if (adminLink) adminLink.hidden = !isAdmin;
  }

  fetch(API_BASE + "/me", { headers: authHeaders })
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
      fillSettingsRole(Boolean(data.is_admin));
    })
    .catch(function () {
      fillSettingsRole(localStorage.getItem("is_admin") === "true");
    });

  function avatarHue(name) {
    var hue = 0;
    String(name || "").split("").forEach(function (ch) {
      hue = (hue * 33 + ch.charCodeAt(0)) % 360;
    });
    return hue;
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
    if (clickable) row.href = "/console/chat?group=" + encodeURIComponent(item.id);
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
    snippet.className = "wa-thread-snippet";
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
    callScript.src = "/scripts/call.js?v=glare";
    callScript.onload = startIncomingCalls;
    document.body.appendChild(callScript);
  }

  var inboxList = document.getElementById("inbox-list");
  if (!inboxList) return;

  var inboxItems = [];
  var inboxCount = document.getElementById("inbox-count");
  var searchWrap = document.getElementById("inbox-search-wrap");
  var searchInput = document.getElementById("inbox-search");
  var searchBtn = document.getElementById("inbox-search-btn");

  function paintInbox(filter) {
    var query = String(filter || "").trim().toLowerCase();
    var items = inboxItems.filter(function (item) {
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
