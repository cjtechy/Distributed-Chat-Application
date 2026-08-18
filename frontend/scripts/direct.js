(function () {
  "use strict";

  var chatsEl = document.getElementById("direct-chats");
  var peopleEl = document.getElementById("direct-people");
  var form = document.getElementById("direct-form");
  if (!chatsEl || !window.APP_CONFIG) return;

  var API_BASE = window.APP_CONFIG.API_BASE;
  var token = localStorage.getItem("token");
  var errorEl = document.getElementById("direct-error");
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
    errorEl.textContent = typeof message === "string" ? message : "Something went wrong.";
  }

  function openDirect(username) {
    return fetch(API_BASE + "/direct", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ username: username }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var detail = result.data && result.data.detail;
          throw new Error(typeof detail === "string" ? detail : "Could not start that chat.");
        }
        window.location.href = "/console/chat?group=" + encodeURIComponent(result.data.id);
      });
  }

  function chatCard(chat) {
    var article = document.createElement("article");
    article.className = "panel-card";
    var title = document.createElement("h2");
    title.textContent = chat.name || chat.peer || "Direct";
    article.appendChild(title);
    if (chat.unread_count) {
      var badge = document.createElement("span");
      badge.className = "card-badge";
      badge.textContent = chat.unread_count > 99 ? "99+" : String(chat.unread_count);
      article.appendChild(badge);
    }
    var meta = document.createElement("p");
    meta.textContent = "Private conversation";
    article.appendChild(meta);
    var open = document.createElement("a");
    open.className = "btn-primary";
    open.href = "/console/chat?group=" + encodeURIComponent(chat.id);
    open.textContent = "Open chat";
    article.appendChild(open);
    return article;
  }

  function personCard(person) {
    var article = document.createElement("article");
    article.className = "panel-card";
    var title = document.createElement("h2");
    title.textContent = person.username;
    article.appendChild(title);
    var meta = document.createElement("p");
    meta.textContent = "Send a private message";
    article.appendChild(meta);
    var button = document.createElement("button");
    button.className = "btn-primary";
    button.type = "button";
    button.textContent = "Message";
    button.addEventListener("click", function () {
      button.disabled = true;
      openDirect(person.username).catch(function (err) {
        showError(err.message);
        button.disabled = false;
      });
    });
    article.appendChild(button);
    return article;
  }

  function loadChats() {
    return fetch(API_BASE + "/direct", { headers: headers })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load direct messages.");
        return response.json();
      })
      .then(function (chats) {
        chatsEl.replaceChildren();
        if (!Array.isArray(chats) || !chats.length) {
          var empty = document.createElement("p");
          empty.className = "lead";
          empty.textContent = "No private chats yet. Pick a member below.";
          chatsEl.appendChild(empty);
          return;
        }
        chats.forEach(function (chat) {
          chatsEl.appendChild(chatCard(chat));
        });
      });
  }

  function loadPeople() {
    if (!peopleEl) return Promise.resolve();
    return fetch(API_BASE + "/people", { headers: headers })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load members.");
        return response.json();
      })
      .then(function (people) {
        peopleEl.replaceChildren();
        if (!Array.isArray(people) || !people.length) {
          var empty = document.createElement("p");
          empty.className = "lead";
          empty.textContent = "No other members to message yet.";
          peopleEl.appendChild(empty);
          return;
        }
        people.forEach(function (person) {
          peopleEl.appendChild(personCard(person));
        });
      });
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      showError("");
      var input = document.getElementById("direct-username");
      var name = input && input.value.trim();
      if (!name) {
        showError("Enter a username.");
        return;
      }
      var submit = form.querySelector("[type='submit']");
      if (submit) submit.disabled = true;
      openDirect(name)
        .catch(function (err) {
          showError(err.message);
        })
        .finally(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  Promise.all([loadChats(), loadPeople()]).catch(function (err) {
    showError(err.message || "Could not load direct messages.");
  });
})();
