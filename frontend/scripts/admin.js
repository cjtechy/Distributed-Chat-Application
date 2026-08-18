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
    document.getElementById("stats").innerHTML =
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
      "</b><span>Admins</span></div>";

    var pg = data.postgres && data.postgres.connected;
    var rd = data.redis && data.redis.connected;
    var health = document.getElementById("health");
    health.className = "health " + (pg && rd ? "ok" : "bad");
    health.textContent =
      "Postgres " +
      (pg ? "up" : "down") +
      " · Redis " +
      (rd ? "up" : "down") +
      " · write queue " +
      data.message_writer_queue;

    var online = data.online.users || [];
    document.getElementById("online").innerHTML = online.length
      ? online.map(function (name) {
          return "<li>" + escapeHtml(name) + "</li>";
        }).join("")
      : '<li class="empty">Nobody is in a room right now</li>';
  }

  async function loadMembers() {
    var members = await api("/admin/members");
    if (!members.length) {
      document.getElementById("members").innerHTML = '<p class="empty">No members yet.</p>';
      return;
    }
    document.getElementById("members").innerHTML =
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Name</th><th>Joined</th><th>Role</th><th></th></tr></thead><tbody>' +
      members
        .map(function (m) {
          return (
            "<tr><td>" +
            escapeHtml(m.username) +
            "</td><td>" +
            formatTime(m.created_at) +
            "</td><td>" +
            (m.is_admin ? '<span class="pill">Admin</span>' : "Member") +
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
      "</tbody></table></div>";
  }

  async function loadMessages() {
    var messages = await api("/admin/messages");
    if (!messages.length) {
      document.getElementById("messages").innerHTML = '<p class="empty">No messages yet.</p>';
      return;
    }
    var newest = messages.slice().reverse();
    document.getElementById("messages").innerHTML =
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
      "</tbody></table></div>";
  }

  async function loadDashboard() {
    await loadOverview();
    await loadMembers();
    await loadMessages();
    showDashboard();
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
        if (!confirm("Remove " + btn.dataset.remove + " from the community?")) return;
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
    if (!confirm("Delete this message for everyone?")) return;
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
    try {
      await loadDashboard();
    } catch (err) {
      if (err.auth) showLogin(err.message);
      else {
        showLogin();
        showError(err.message);
      }
    }
  }

  start();
})();
