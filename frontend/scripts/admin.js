(function () {
  "use strict";

  var API_BASE = window.APP_CONFIG && window.APP_CONFIG.API_BASE;
  if (!API_BASE) return;

  var token = localStorage.getItem("token");
  var errorEl = document.getElementById("auth-error") || document.getElementById("error");
  var loginPanel = document.getElementById("login-panel");
  var dashboard = document.getElementById("dashboard");
  var loginForm = document.getElementById("login-form");

  function showError(text) {
    if (!errorEl) return;
    errorEl.textContent = text || "";
    errorEl.classList.toggle("visible", Boolean(text));
  }

  function clearError() {
    showError("");
  }

  function setHtml(id, html) {
    var node = document.getElementById(id);
    if (node) node.innerHTML = html;
  }

  function panelState(text, tone) {
    return '<p class="admin-panel-state ' + (tone || "") + '">' + escapeHtml(text) + "</p>";
  }

  function setDashboardLoading() {
    setHtml(
      "stats",
      '<div class="stat-card is-loading"><b>...</b><span>Members</span></div>' +
        '<div class="stat-card is-loading"><b>...</b><span>Online</span></div>' +
        '<div class="stat-card is-loading"><b>...</b><span>Messages</span></div>' +
        '<div class="stat-card is-loading"><b>...</b><span>Admins</span></div>'
    );
    var health = document.getElementById("health");
    if (health) {
      health.className = "health";
      health.textContent = "Checking services...";
    }
    setHtml("online", '<li class="empty">Checking who is online...</li>');
    setHtml("members", panelState("Loading members..."));
    setHtml("messages", panelState("Loading recent messages..."));
  }

  function setMode(mode) {
    document.body.classList.toggle("admin-auth", mode === "login");
    document.body.classList.toggle("admin-dash", mode === "dash");
    if (loginPanel) loginPanel.classList.toggle("hidden", mode !== "login");
    if (dashboard) dashboard.classList.toggle("hidden", mode !== "dash");
  }

  function showLogin(message) {
    setMode("login");
    if (message) showError(message);
  }

  function showDashboard() {
    setMode("dash");
    clearError();
    var nameEl = document.getElementById("console-username");
    var storedName = localStorage.getItem("username") || "";
    if (nameEl && storedName) nameEl.textContent = storedName;
    var railAvatar = document.getElementById("rail-avatar");
    if (railAvatar && storedName) railAvatar.textContent = storedName.charAt(0).toUpperCase();
  }

  function headers() {
    return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function api(path, options) {
    options = options || {};
    var response = await fetch(API_BASE + path, Object.assign({ credentials: "include" }, options, { headers: headers() }));
    var data = await response.json().catch(function () {
      return {};
    });
    if (response.status === 401 || response.status === 403) {
      var err = new Error(
        response.status === 403 ? "This account is not an admin." : "Please sign in as admin."
      );
      err.auth = true;
      throw err;
    }
    if (!response.ok) {
      var detail = data.detail;
      throw new Error(typeof detail === "string" ? detail : "Request failed");
    }
    return data;
  }

  async function loadOverview() {
    var data = await api("/admin/overview");
    setHtml(
      "stats",
      '<div class="stat-card"><b>' +
      data.members +
      "</b><span>Members</span></div>" +
      '<div class="stat-card"><b>' +
      data.online.count +
      "</b><span>Online / " +
      data.online.max_users +
      " max</span></div>" +
      '<div class="stat-card"><b>' +
      data.messages +
      "</b><span>Messages</span></div>" +
      '<div class="stat-card"><b>' +
      data.admins +
      "</b><span>Admins</span></div>"
    );

    var pg = data.postgres && data.postgres.connected;
    var rd = data.redis && data.redis.connected;
    var health = document.getElementById("health");
    if (health) {
      health.className = "health " + (pg && rd ? "ok" : "bad");
      health.textContent =
        "Postgres " +
        (pg ? "up" : "down") +
        " · Redis " +
        (rd ? "up" : "down") +
        " · write queue " +
        data.message_writer_queue;
    }

    var onlineInfo = data.online || {};
    var online = onlineInfo.users || [];
    setHtml(
      "online",
      online.length
        ? online.map(function (name) {
            return "<li>" + escapeHtml(name) + "</li>";
          }).join("")
        : '<li class="empty">Nobody is in a room right now</li>'
    );
  }

  async function loadMembers() {
    var members = await api("/admin/members");
    if (!members.length) {
      setHtml("members", '<p class="empty">No members yet.</p>');
      return;
    }
    setHtml(
      "members",
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>' +
      members
        .map(function (m) {
          var email = (m.email || "").trim();
          return (
            "<tr><td>" +
            escapeHtml(m.username) +
            (m.is_admin ? ' <span class="pill">Admin</span>' : "") +
            "</td><td class=\"admin-email\">" +
            (email ? escapeHtml(email) : "—") +
            "</td><td>" +
            formatTime(m.created_at) +
            '</td><td class="row-actions">' +
            '<button class="btn-ghost" type="button" data-role="' +
            escapeHtml(m.username) +
            '" data-admin="' +
            (m.is_admin ? "0" : "1") +
            '">' +
            (m.is_admin ? "Remove admin" : "Make admin") +
            "</button>" +
            '<button class="btn-danger" type="button" data-remove="' +
            escapeHtml(m.username) +
            '">Remove</button></td></tr>'
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  async function loadMessages() {
    var messages = await api("/admin/messages");
    if (!messages.length) {
      setHtml("messages", '<p class="empty">No messages yet.</p>');
      return;
    }
    var newest = messages.slice().reverse();
    setHtml(
      "messages",
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>From</th><th>Message</th><th>When</th><th></th></tr></thead><tbody>' +
      newest
        .map(function (m) {
          return (
            "<tr><td>" +
            escapeHtml(m.username) +
            '</td><td class="msg">' +
            escapeHtml(m.message) +
            "</td><td>" +
            formatTime(m.created_at) +
            '</td><td><button class="btn-danger" type="button" data-msg="' +
            m.id +
            '">Delete</button></td></tr>'
          );
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  async function loadDashboard() {
    showDashboard();
    setDashboardLoading();
    var authError = null;
    await Promise.all([
      loadOverview().catch(function (err) {
        if (err.auth) authError = err;
        else {
          setHtml("stats", panelState(err.message || "Could not load overview.", "bad"));
          var health = document.getElementById("health");
          if (health) {
            health.className = "health bad";
            health.textContent = err.message || "Could not load health.";
          }
          setHtml("online", '<li class="empty">Online status unavailable</li>');
        }
      }),
      loadMembers().catch(function (err) {
        if (err.auth) authError = err;
        else setHtml("members", panelState(err.message || "Could not load members.", "bad"));
      }),
      loadMessages().catch(function (err) {
        if (err.auth) authError = err;
        else setHtml("messages", panelState(err.message || "Could not load messages.", "bad"));
      }),
    ]);
    if (authError) showLogin(authError.message);
  }

  document.getElementById("members").addEventListener("click", async function (event) {
    var btn = event.target.closest("button");
    if (!btn) return;
    try {
      if (btn.dataset.role) {
        await api("/admin/members/" + encodeURIComponent(btn.dataset.role), {
          method: "PATCH",
          body: JSON.stringify({ is_admin: btn.dataset.admin === "1" }),
        });
      }
      if (btn.dataset.remove) {
        var removeOk = window.appConfirm
          ? await window.appConfirm({
              title: "Remove member?",
              body: "Remove " + btn.dataset.remove + " from the community.",
              confirmLabel: "Remove",
              danger: true,
            })
          : confirm("Remove " + btn.dataset.remove + " from the community?");
        if (!removeOk) return;
        await api("/admin/members/" + encodeURIComponent(btn.dataset.remove), { method: "DELETE" });
      }
      await loadOverview();
      await loadMembers();
    } catch (err) {
      if (err.auth) showLogin(err.message);
      else showError(err.message);
    }
  });

  document.getElementById("messages").addEventListener("click", async function (event) {
    var btn = event.target.closest("button");
    if (!btn || !btn.dataset.msg) return;
    var deleteOk = window.appConfirm
      ? await window.appConfirm({
          title: "Delete message?",
          body: "This removes it for everyone in the community.",
          confirmLabel: "Delete",
          danger: true,
        })
      : confirm("Delete this message for everyone?");
    if (!deleteOk) return;
    try {
      await api("/admin/messages/" + btn.dataset.msg, { method: "DELETE" });
      await loadOverview();
      await loadMessages();
    } catch (err) {
      if (err.auth) showLogin(err.message);
      else showError(err.message);
    }
  });

  if (loginForm) {
    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearError();
      var submit = loginForm.querySelector("[type='submit']");
      if (submit) submit.disabled = true;
      try {
        var response = await fetch(API_BASE + "/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("login-username").value.trim(),
            password: document.getElementById("login-password").value,
          }),
        });
        var data = await response.json();
        if (!response.ok) {
          showError(typeof data.detail === "string" ? data.detail : "Sign in failed.");
          return;
        }
        if (!data.is_admin) {
          showLogin("This account is not an admin.");
          return;
        }
        token = data.access_token;
        localStorage.setItem("token", token);
        localStorage.setItem("username", data.username);
        localStorage.setItem("is_admin", "true");
        var nameEl = document.getElementById("console-username");
        if (nameEl) nameEl.textContent = data.username;
        var railAvatar = document.getElementById("rail-avatar");
        if (railAvatar) railAvatar.textContent = data.username.charAt(0).toUpperCase();
        await loadDashboard();
      } catch (err) {
        showError(err.message || "Sign in failed.");
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  document.querySelectorAll("[data-toggle-password]").forEach(function (button) {
    button.addEventListener("click", function () {
      var input = document.getElementById(button.getAttribute("aria-controls"));
      if (!input) return;
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      button.setAttribute("aria-pressed", show ? "true" : "false");
    });
  });

  async function start() {
    if (!token) {
      showLogin();
      return;
    }
    await loadDashboard();
  }

  start();
})();
