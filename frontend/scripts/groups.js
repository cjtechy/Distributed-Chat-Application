(function () {
  "use strict";

  var listMine = document.getElementById("mine-groups");
  var listOther = document.getElementById("other-groups");
  var form = document.getElementById("group-form");
  if (!listMine || !window.APP_CONFIG) return;

  var API_BASE = window.APP_CONFIG.API_BASE;
  var token = localStorage.getItem("token");
  var errorEl = document.getElementById("group-error");
  var headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };

  function showError(message) {
    if (!errorEl) return;
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function card(group, mine) {
    var article = document.createElement("article");
    article.className = "panel-card";

    var title = document.createElement("h2");
    title.textContent = group.name;
    article.appendChild(title);
    if (mine && group.unread_count) {
      var badge = document.createElement("span");
      badge.className = "card-badge";
      badge.textContent = group.unread_count > 99 ? "99+" : String(group.unread_count);
      article.appendChild(badge);
    }

    var meta = document.createElement("p");
    var members = group.member_count === 1 ? "1 member" : (group.member_count || 0) + " members";
    var owner = group.is_default ? "Default room" : "Created by " + (group.created_by || "someone");
    meta.textContent = owner + " · " + members;
    article.appendChild(meta);

    if (mine) {
      var open = document.createElement("a");
      open.className = "btn-primary";
      open.href = "/console/chat?group=" + encodeURIComponent(group.id);
      open.textContent = "Open chat";
      article.appendChild(open);
    } else {
      var join = document.createElement("button");
      join.className = "btn-primary";
      join.type = "button";
      join.textContent = "Join";
      join.addEventListener("click", function () {
        join.disabled = true;
        fetch(API_BASE + "/groups/" + group.id + "/join", {
          method: "POST",
          headers: headers,
        })
          .then(function (response) {
            return response.json().then(function (data) {
              return { ok: response.ok, data: data };
            });
          })
          .then(function (result) {
            if (!result.ok) {
              showError(result.data.detail || "Could not join this group.");
              join.disabled = false;
              return;
            }
            window.location.href = "/console/chat?group=" + encodeURIComponent(group.id);
          })
          .catch(function () {
            showError("Could not join this group.");
            join.disabled = false;
          });
      });
      article.appendChild(join);
    }
    return article;
  }

  function render(groups) {
    listMine.replaceChildren();
    if (listOther) listOther.replaceChildren();
    var mine = groups.filter(function (group) { return group.is_member && !group.is_direct; });
    var others = groups.filter(function (group) { return !group.is_member && !group.is_direct; });
    if (!mine.length) {
      var empty = document.createElement("p");
      empty.className = "lead";
      empty.textContent = "You are not in any groups yet.";
      listMine.appendChild(empty);
    } else {
      mine.forEach(function (group) { listMine.appendChild(card(group, true)); });
    }
    if (listOther) {
      if (!others.length) {
        var none = document.createElement("p");
        none.className = "lead";
        none.textContent = "No other groups to join right now.";
        listOther.appendChild(none);
      } else {
        others.forEach(function (group) { listOther.appendChild(card(group, false)); });
      }
    }
  }

  function load() {
    return fetch(API_BASE + "/groups", { headers: headers })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load groups.");
        return response.json();
      })
      .then(render)
      .catch(function (err) {
        showError(err.message || "Could not load groups.");
      });
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      showError("");
      var input = document.getElementById("group-name");
      var name = input && input.value.trim();
      if (!name || name.length < 2) {
        showError("Name must be at least 2 characters.");
        return;
      }
      var submit = form.querySelector("[type='submit']");
      if (submit) submit.disabled = true;
      fetch(API_BASE + "/groups", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ name: name }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (submit) submit.disabled = false;
          if (!result.ok) {
            var detail = result.data && result.data.detail;
            showError(typeof detail === "string" ? detail : "Could not create the group.");
            return;
          }
          if (input) input.value = "";
          window.location.href = "/console/chat?group=" + encodeURIComponent(result.data.id);
        })
        .catch(function () {
          if (submit) submit.disabled = false;
          showError("Could not create the group.");
        });
    });
  }

  load();
})();
