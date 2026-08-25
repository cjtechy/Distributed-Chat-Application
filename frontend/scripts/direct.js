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
    if (window.chatUi) {
      return window.chatUi.threadRow({
        id: chat.id,
        name: chat.name || chat.peer || "Direct",
        unread_count: chat.unread_count,
        last_message: chat.last_message || "",
        last_at: chat.last_at,
        last_sender: chat.last_sender,
        is_direct: true,
        online: chat.online,
        last_seen: chat.last_seen,
        show_presence: !chat.last_message,
      });
    }
    if (window.chatUi) {
      return window.chatUi.threadRow({
        id: chat.id,
        name: chat.name || chat.peer || "Direct",
        unread_count: chat.unread_count,
        last_message: chat.last_message || "Private conversation",
        last_at: chat.last_at,
        last_sender: chat.last_sender,
        is_direct: true,
        online: chat.online,
        last_seen: chat.last_seen,
      });
    }
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
    if (window.chatUi) {
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
      return window.chatUi.threadRow({
        name: person.username,
        show_presence: true,
        online: person.online,
        last_seen: person.last_seen,
        is_direct: true,
      }, button);
    }
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

  var chats = [];
  var people = [];
  var view = "chats";
  var searchInput = document.getElementById("direct-search");
  var fab = document.getElementById("direct-fab");

  function query() {
    return String(searchInput && searchInput.value || "").trim().toLowerCase();
  }

  function matchesQuery(text) {
    var q = query();
    if (!q) return true;
    return String(text || "").toLowerCase().indexOf(q) !== -1;
  }

  function setView(next) {
    view = next;
    document.querySelectorAll("[data-direct-filter]").forEach(function (chip) {
      chip.setAttribute("aria-pressed", chip.getAttribute("data-direct-filter") === view ? "true" : "false");
    });
    paint();
  }

  function fillList(el, nodes, emptyText) {
    if (!el) return;
    el.replaceChildren();
    el.removeAttribute("aria-busy");
    if (!nodes.length) {
      el.appendChild(window.chatUi
        ? window.chatUi.empty(emptyText)
        : (function () {
            var empty = document.createElement("p");
            empty.className = "lead";
            empty.textContent = emptyText;
            return empty;
          })());
      return;
    }
    nodes.forEach(function (node) {
      el.appendChild(node);
    });
  }

  function paint() {
    var q = query();
    var searching = q.length > 0;
    if (form) form.hidden = searching || view !== "people";

    var shownChats = chats.filter(function (chat) {
      return matchesQuery(chat.name || chat.peer || "");
    });
    var shownPeople = people.filter(function (person) {
      return matchesQuery(person.username);
    });

    if (searching) {
      chatsEl.hidden = shownChats.length === 0;
      if (peopleEl) peopleEl.hidden = false;
      if (shownChats.length) {
        fillList(chatsEl, shownChats.map(chatCard), "");
      } else {
        chatsEl.replaceChildren();
      }
      fillList(
        peopleEl,
        shownPeople.map(personCard),
        shownChats.length ? "" : "No usernames match “" + q + "”."
      );
      if (!shownPeople.length && peopleEl && shownChats.length) {
        peopleEl.replaceChildren();
      }
      return;
    }

    chatsEl.hidden = view !== "chats";
    if (peopleEl) peopleEl.hidden = view !== "people";
    if (view === "chats") {
      fillList(chatsEl, shownChats.map(chatCard), "No private chats yet. Open People or search a username.");
      return;
    }
    fillList(peopleEl, shownPeople.map(personCard), "No other members to message yet.");
  }

  function loadChats() {
    return fetch(API_BASE + "/direct", {
      headers: headers,
      timeoutMs: window.chatUi ? window.chatUi.SKELETON_TIMEOUT_MS : 8000,
    })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load direct messages.");
        return response.json();
      })
      .then(function (data) {
        chats = Array.isArray(data) ? data : [];
        paint();
      });
  }

  function loadPeople() {
    if (!peopleEl) return Promise.resolve();
    return fetch(API_BASE + "/people", {
      headers: headers,
      timeoutMs: window.chatUi ? window.chatUi.SKELETON_TIMEOUT_MS : 8000,
    })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not load members.");
        return response.json();
      })
      .then(function (data) {
        people = Array.isArray(data) ? data : [];
        paint();
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

  var cancelDirectTimeout = null;

  function loadDirectPage() {
    if (window.chatUi) {
      if (cancelDirectTimeout) cancelDirectTimeout();
      window.chatUi.showSkeleton(chatsEl, 3);
      if (peopleEl) window.chatUi.showSkeleton(peopleEl, 3);
      cancelDirectTimeout = window.chatUi.armSkeletonTimeout(function () {
        chatsEl.replaceChildren();
        chatsEl.removeAttribute("aria-busy");
        chatsEl.appendChild(window.chatUi.timeoutPanel("Direct chats took too long to load.", loadDirectPage));
        if (peopleEl) {
          peopleEl.replaceChildren();
          peopleEl.removeAttribute("aria-busy");
        }
      });
    }
    Promise.all([loadChats(), loadPeople()])
      .then(function () {
        if (cancelDirectTimeout) cancelDirectTimeout();
        paint();
      })
      .catch(function (err) {
        if (cancelDirectTimeout) cancelDirectTimeout();
        if (chatsEl) {
          chatsEl.replaceChildren();
          chatsEl.removeAttribute("aria-busy");
        }
        if (peopleEl) {
          peopleEl.replaceChildren();
          peopleEl.removeAttribute("aria-busy");
        }
        if (window.chatUi && chatsEl) {
          chatsEl.appendChild(window.chatUi.timeoutPanel(err.message || "Could not load direct messages.", loadDirectPage));
        } else {
          showError(err.message || "Could not load direct messages.");
        }
      });
  }

  document.querySelectorAll("[data-direct-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      setView(chip.getAttribute("data-direct-filter") || "chats");
    });
  });
  if (searchInput) {
    searchInput.addEventListener("input", paint);
  }
  if (fab) {
    fab.addEventListener("click", function () {
      setView("people");
      var input = document.getElementById("direct-username");
      if (input) input.focus();
    });
  }

  loadDirectPage();
})();
