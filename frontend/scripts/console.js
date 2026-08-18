(function () {
  "use strict";

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

  var adminLink = document.getElementById("console-admin");
  if (adminLink && localStorage.getItem("is_admin") === "true") {
    adminLink.hidden = false;
  }

  document.querySelectorAll(".console-links a[href]").forEach(function (link) {
    var href = link.getAttribute("href");
    if (href === path || (href === "/console" && (path === "/console" || path === "/console/index.html"))) {
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
    var link = document.querySelector('.console-links a[href="' + href + '"]');
    if (!link) return;
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

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

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

  var onlineEl = document.getElementById("stat-online");
  var recentList = document.getElementById("recent-list");
  var dashGroups = document.getElementById("dash-groups");
  var dashDirects = document.getElementById("dash-directs");
  if (!onlineEl && !recentList && !dashGroups && !dashDirects) return;

  fetch(API_BASE + "/groups", { headers: authHeaders })
    .then(function (response) {
      return response.ok ? response.json() : [];
    })
    .then(function (groups) {
      if (!Array.isArray(groups)) groups = [];
      if (dashGroups) {
        dashGroups.replaceChildren();
        var mine = groups.filter(function (group) { return group.is_member && !group.is_direct; });
        if (!mine.length) {
          var empty = document.createElement("li");
          empty.textContent = "No groups yet — create one from Groups.";
          dashGroups.appendChild(empty);
        } else {
          mine.slice(0, 6).forEach(function (group) {
            var li = document.createElement("li");
            var link = document.createElement("a");
            link.href = "/console/chat?group=" + encodeURIComponent(group.id);
            link.textContent = group.name;
            li.appendChild(link);
            if (group.unread_count) {
              var badge = document.createElement("span");
              badge.className = "nav-badge";
              badge.textContent = group.unread_count > 99 ? "99+" : String(group.unread_count);
              li.appendChild(badge);
            }
            dashGroups.appendChild(li);
          });
        }
      }

      if (dashDirects) {
        fetch(API_BASE + "/direct", { headers: authHeaders })
          .then(function (response) {
            return response.ok ? response.json() : [];
          })
          .then(function (chats) {
            dashDirects.replaceChildren();
            if (!Array.isArray(chats) || !chats.length) {
              var emptyDm = document.createElement("li");
              emptyDm.textContent = "No private chats yet — start one from Direct.";
              dashDirects.appendChild(emptyDm);
              return;
            }
            chats.slice(0, 6).forEach(function (chat) {
              var li = document.createElement("li");
              var link = document.createElement("a");
              link.href = "/console/chat?group=" + encodeURIComponent(chat.id);
              link.textContent = chat.name || chat.peer || "Direct";
              li.appendChild(link);
              if (chat.unread_count) {
                var dmBadge = document.createElement("span");
                dmBadge.className = "nav-badge";
                dmBadge.textContent = chat.unread_count > 99 ? "99+" : String(chat.unread_count);
                li.appendChild(dmBadge);
              }
              dashDirects.appendChild(li);
            });
          })
          .catch(function () {
            dashDirects.replaceChildren();
            var failed = document.createElement("li");
            failed.textContent = "Could not load direct messages.";
            dashDirects.appendChild(failed);
          });
      }

      var community = groups.find(function (group) { return group.is_default; }) || groups[0];
      var groupId = community ? community.id : 1;
      return Promise.all([
        fetch(API_BASE + "/online?group_id=" + encodeURIComponent(groupId), { headers: authHeaders }).then(function (r) {
          return r.ok ? r.json() : null;
        }),
        fetch(API_BASE + "/messages?group_id=" + encodeURIComponent(groupId), { headers: authHeaders }).then(function (r) {
          return r.ok ? r.json() : null;
        }),
        fetch(API_BASE + "/status", { headers: authHeaders }).then(function (r) {
          return r.ok ? r.json() : null;
        }),
      ]);
    })
    .then(function (results) {
      var online = results[0];
      var messages = results[1];
      var status = results[2];
      if (online) {
        setText("stat-online", String(online.count || 0));
      }
      if (Array.isArray(messages)) {
        setText("stat-messages", String(messages.length));
        if (recentList) {
          recentList.replaceChildren();
          var slice = messages.slice(-5).reverse();
          if (!slice.length) {
            var empty = document.createElement("li");
            empty.textContent = "No messages yet — be the first in the room.";
            recentList.appendChild(empty);
          } else {
            slice.forEach(function (item) {
              var li = document.createElement("li");
              var who = document.createElement("strong");
              who.textContent = item.username || "Someone";
              li.append(who, document.createTextNode(" — " + (item.message || "")));
              recentList.appendChild(li);
            });
          }
        }
      }
      if (status) {
        var redis = status.redis;
        var postgres = status.postgres;
        setText("stat-redis", redis && redis.connected ? "Up" : "Down");
        setText("stat-postgres", postgres && postgres.connected ? "Up" : "Down");
      }
    })
    .catch(function () {
      if (recentList) {
        recentList.replaceChildren();
        var li = document.createElement("li");
        li.textContent = "Could not load activity right now.";
        recentList.appendChild(li);
      }
    });
})();
