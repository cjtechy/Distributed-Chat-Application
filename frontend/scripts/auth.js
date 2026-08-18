(function () {
  "use strict";

  var form = document.getElementById("auth-form");
  if (!form || !window.APP_CONFIG) return;

  var API_BASE = window.APP_CONFIG.API_BASE;
  var mode = form.getAttribute("data-mode") || "login";
  var errorEl = document.getElementById("auth-error");
  var submitBtn = form.querySelector("[type='submit']");
  var btnLabel = submitBtn && submitBtn.querySelector(".btn-label");
  var defaultLabel = btnLabel ? btnLabel.textContent : "";
  var usernameInput = document.getElementById("auth-username");
  var passwordInput = document.getElementById("auth-password");
  var confirmInput = document.getElementById("auth-password-confirm");
  var usernameCount = document.getElementById("username-count");
  var usernameStatus = document.getElementById("username-status");
  var usernameHint = document.getElementById("username-hint");
  var strengthWrap = document.getElementById("password-strength");
  var strengthBar = strengthWrap && strengthWrap.querySelector(".strength-bar");
  var strengthLabel = document.getElementById("strength-label");
  var capsWarn = document.getElementById("caps-warn");

  function safeNext(raw) {
    if (!raw || raw.charAt(0) !== "/" || raw.indexOf("//") === 0 || raw.indexOf("\\") !== -1) {
      return "/console";
    }
    return raw;
  }

  var next = safeNext(new URLSearchParams(window.location.search).get("next"));

  if (localStorage.getItem("token") && localStorage.getItem("username")) {
    window.location.replace(next);
    return;
  }

  document.querySelectorAll("[data-auth-alt], .auth-switch a").forEach(function (link) {
    if (next === "/console") return;
    var url = new URL(link.getAttribute("href"), window.location.origin);
    url.searchParams.set("next", next);
    link.setAttribute("href", url.pathname + url.search);
  });

  function fieldErrorEl(name) {
    return form.querySelector('[data-error-for="' + name + '"]');
  }

  function setFieldError(name, message) {
    var el = fieldErrorEl(name);
    var input =
      name === "username" ? usernameInput : name === "confirm" ? confirmInput : passwordInput;
    if (el) {
      el.textContent = message || "";
      el.classList.toggle("visible", Boolean(message));
    }
    if (input) {
      input.classList.toggle("is-invalid", Boolean(message));
      input.setAttribute("aria-invalid", message ? "true" : "false");
    }
  }

  function clearErrors() {
    errorEl.classList.remove("visible");
    errorEl.textContent = "";
    ["username", "password", "confirm"].forEach(function (name) {
      setFieldError(name, "");
    });
  }

  function showFormError(text) {
    errorEl.textContent = text;
    errorEl.classList.add("visible");
  }

  function formatError(detail) {
    if (!detail) return "Something went wrong.";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map(function (item) { return item.msg || String(item); }).join(" ");
    }
    return "Request failed.";
  }

  function passwordScore(value) {
    var score = 0;
    if (value.length >= 6) score += 1;
    if (value.length >= 10 || /[A-Z]/.test(value) && /[0-9]/.test(value)) score += 1;
    if (value.length >= 12 && /[^A-Za-z0-9]/.test(value)) score += 1;
    return Math.min(3, score);
  }

  function updateUsernameCount() {
    if (!usernameCount) return;
    usernameCount.textContent = usernameInput.value.trim().length + " / 32";
  }

  var usernameCheckTimer = null;
  var usernameCheckAbort = null;
  var usernameAvailability = { name: "", available: null, checking: false };

  function setUsernameStatus(state, text) {
    if (!usernameStatus) return;
    usernameStatus.className = "username-status";
    if (!text) {
      usernameStatus.textContent = "";
      usernameInput.classList.remove("is-available");
      if (usernameHint) usernameHint.style.display = "";
      return;
    }
    usernameStatus.textContent = text;
    usernameStatus.classList.add("visible", state);
    if (usernameHint) usernameHint.style.display = "none";
    usernameInput.classList.toggle("is-available", state === "ok");
  }

  function checkUsernameAvailable(username) {
    if (usernameCheckAbort) usernameCheckAbort.abort();
    usernameCheckAbort = new AbortController();
    usernameAvailability = { name: username, available: null, checking: true };
    setUsernameStatus("checking", "Checking if this username is free…");
    return fetch(API_BASE + "/username-available?username=" + encodeURIComponent(username), {
      signal: usernameCheckAbort.signal,
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (usernameInput.value.trim() !== username) return usernameAvailability;
        if (!result.ok) {
          usernameAvailability = { name: username, available: null, checking: false };
          setUsernameStatus("", "");
          return usernameAvailability;
        }
        usernameAvailability = {
          name: username,
          available: Boolean(result.data.available),
          checking: false,
        };
        if (result.data.available) {
          setFieldError("username", "");
          setUsernameStatus("ok", "Username is available");
        } else {
          setUsernameStatus("taken", "Username is taken");
          setFieldError("username", "Try a different username.");
        }
        return usernameAvailability;
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return usernameAvailability;
        usernameAvailability = { name: username, available: null, checking: false };
        setUsernameStatus("", "");
        return usernameAvailability;
      });
  }

  function scheduleUsernameCheck() {
    updateUsernameCount();
    if (mode !== "register") return;
    var username = usernameInput.value.trim();
    if (usernameCheckTimer) clearTimeout(usernameCheckTimer);
    if (usernameCheckAbort) usernameCheckAbort.abort();
    usernameAvailability = { name: username, available: null, checking: false };
    if (username.length < 3) {
      setFieldError("username", "");
      setUsernameStatus("", "");
      return;
    }
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setFieldError("username", "Use 3–32 letters, numbers, or underscores.");
      setUsernameStatus("", "");
      return;
    }
    usernameAvailability.checking = true;
    setUsernameStatus("checking", "Checking if this username is free…");
    usernameCheckTimer = setTimeout(function () {
      checkUsernameAvailable(username);
    }, 400);
  }

  function updateStrength() {
    if (!strengthWrap || !strengthBar) return;
    var value = passwordInput.value;
    if (!value) {
      strengthWrap.classList.remove("visible");
      return;
    }
    var level = passwordScore(value);
    strengthWrap.classList.add("visible");
    strengthBar.setAttribute("data-level", String(level));
    if (strengthLabel) {
      strengthLabel.textContent =
        level >= 3 ? "Strong password" : level === 2 ? "Decent — a bit longer is better" : "Too short or easy to guess";
    }
  }

  if (usernameInput) {
    usernameInput.addEventListener("input", scheduleUsernameCheck);
    updateUsernameCount();
  }
  if (passwordInput && mode === "register") {
    passwordInput.addEventListener("input", updateStrength);
  }

  document.querySelectorAll("[data-toggle-password]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("aria-controls"));
      if (!input) return;
      var hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      btn.textContent = hidden ? "Hide" : "Show";
      btn.setAttribute("aria-pressed", hidden ? "true" : "false");
    });
  });

  function updateCaps(event) {
    if (!capsWarn || !event.getModifierState) return;
    capsWarn.classList.toggle("visible", event.getModifierState("CapsLock"));
  }
  [passwordInput, confirmInput].forEach(function (input) {
    if (!input) return;
    input.addEventListener("keydown", updateCaps);
    input.addEventListener("keyup", updateCaps);
  });

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    form.setAttribute("aria-busy", isLoading ? "true" : "false");
    if (!btnLabel) return;
    if (isLoading) {
      btnLabel.textContent = mode === "register" ? "Creating account…" : "Signing in…";
      if (!submitBtn.querySelector(".spinner")) {
        var spinner = document.createElement("span");
        spinner.className = "spinner";
        spinner.setAttribute("aria-hidden", "true");
        submitBtn.insertBefore(spinner, btnLabel);
      }
    } else {
      btnLabel.textContent = defaultLabel;
      var existing = submitBtn.querySelector(".spinner");
      if (existing) existing.remove();
    }
  }

  function validate() {
    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    var ok = true;

    if (!username) {
      setFieldError("username", "Enter your username.");
      ok = false;
    } else if (mode === "register" && !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setFieldError("username", "Use 3–32 letters, numbers, or underscores.");
      ok = false;
    } else if (mode === "register" && (username.length < 3 || username.length > 32)) {
      setFieldError("username", "Username must be 3 to 32 characters.");
      ok = false;
    }

    if (!password) {
      setFieldError("password", "Enter your password.");
      ok = false;
    } else if (mode === "register" && password.length < 6) {
      setFieldError("password", "Password must be at least 6 characters.");
      ok = false;
    }

    if (mode === "register") {
      if (usernameAvailability.available === false && usernameAvailability.name === username) {
        setFieldError("username", "That username is taken.");
        ok = false;
      }
      if (!confirmInput.value) {
        setFieldError("confirm", "Confirm your password.");
        ok = false;
      } else if (confirmInput.value !== password) {
        setFieldError("confirm", "Passwords don’t match.");
        ok = false;
      }
    }

    if (!ok) {
      var firstInvalid = form.querySelector(".is-invalid");
      if (firstInvalid) firstInvalid.focus();
    }
    return ok;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearErrors();
    if (!validate()) return;

    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    setLoading(true);

    var ready = Promise.resolve(usernameAvailability);
    if (mode === "register") {
      var needsCheck =
        usernameAvailability.name !== username ||
        usernameAvailability.checking ||
        usernameAvailability.available === null;
      if (needsCheck) {
        if (usernameCheckTimer) clearTimeout(usernameCheckTimer);
        ready = checkUsernameAvailable(username);
      }
    }

    ready
      .then(function (availability) {
        if (mode === "register" && availability && availability.available === false) {
          setFieldError("username", "That username is taken.");
          usernameInput.focus();
          throw new Error("taken");
        }
        return fetch(API_BASE + "/" + mode, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username, password: password }),
        });
      })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, status: response.status, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var message = formatError(result.data.detail) || "Authentication failed.";
          if (/taken/i.test(message)) {
            setFieldError("username", message);
            setUsernameStatus("taken", "Username is taken");
            usernameInput.focus();
          } else if (result.status === 401) {
            setFieldError("password", "Check your username and password.");
            showFormError(message);
            passwordInput.focus();
            passwordInput.select();
          } else if (result.status === 429) {
            showFormError("Too many attempts. Try again shortly.");
          } else {
            showFormError(message);
          }
          return;
        }
        localStorage.setItem("token", result.data.access_token);
        localStorage.setItem("username", result.data.username);
        localStorage.setItem("is_admin", result.data.is_admin ? "true" : "false");
        window.location.replace(next);
      })
      .catch(function (err) {
        if (err && err.message === "taken") return;
        showFormError("Could not reach the server. Try again.");
      })
      .finally(function () {
        setLoading(false);
      });
  });
})();
