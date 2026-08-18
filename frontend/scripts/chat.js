(function () {
"use strict";
    const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "";
    const WS_BASE = (window.APP_CONFIG && window.APP_CONFIG.WS_BASE) || "";
    const groupParam = new URLSearchParams(window.location.search).get("group");
    let storedGroup = "";
    try {
      storedGroup = sessionStorage.getItem("chat_group") || "";
    } catch {
      storedGroup = "";
    }
    let groupId = Math.max(0, parseInt(groupParam || storedGroup || "0", 10) || 0);
    const groupNameEl = document.getElementById("group-name");
    const groupHeadingEl = document.getElementById("group-heading");
    const groupBlurbEl = document.getElementById("group-blurb");
    const groupTagEl = document.getElementById("group-tag");
    const chatPanel = document.getElementById("chat-panel");
    const userAvatar = document.getElementById("user-avatar");
    const logoutBtn = document.getElementById("logout");
    const adminLink = document.getElementById("admin-link");
    const statusEl = document.getElementById("status");
    const messagesEl = document.getElementById("messages");
    const chatForm = document.getElementById("chat-form");
    const messageEl = document.getElementById("message");
    const sendEl = document.getElementById("send");
    const typingEl = document.getElementById("typing-indicator");
    const onlineListEl = document.getElementById("online-list");
    if (groupBlurbEl) groupBlurbEl.textContent = "Opening room…";

    let token = localStorage.getItem("token");
    let username = localStorage.getItem("username");
    let socket = null;
    let connectGen = 0;
    let typingSendTimeout = null;
    let reconnectLoopTimer = null;
    let reconnectOfflineTimer = null;
    let reconnectStartedAt = 0;
    let manualDisconnect = false;
    const RECONNECT_INTERVAL_MS = 3000;
    const RECONNECT_TIMEOUT_MS = 12000;
    const typingUsers = new Map();
    const onlineUsers = new Set();
    const pendingMessages = new Map();
    let pendingSeq = 0;
    const viewedMessageIds = new Set();
    const deliveredMessageIds = new Set();
    const pendingViewIds = new Set();
    const pendingDeliveredIds = new Set();
    const ackedDeliveredIds = new Set();
    let viewFlushTimer = null;
    let deliveredFlushTimer = null;
    let viewObserver = null;

    function getViewObserver() {
      if (viewObserver || !messagesEl) return viewObserver;
      viewObserver = new IntersectionObserver(
        (entries) => {
          if (document.visibilityState !== "visible") return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = entry.target;
            if (!row.classList.contains("received")) continue;
            const id = row.id.replace("message-", "");
            if (!id || id.startsWith("pending-")) continue;
            queueViewed(id);
            viewObserver.unobserve(row);
          }
        },
        { root: messagesEl, threshold: 0.55 }
      );
      return viewObserver;
    }

    function formatError(detail) {
      if (!detail) return "Something went wrong.";
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        return detail.map((item) => item.msg || String(item)).join(" ");
      }
      if (typeof detail === "object" && detail.msg) return detail.msg;
      return String(detail);
    }

    function formatTime(isoString) {
      if (!isoString) return "";
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function reconnectStatusMessage() {
      if (reconnectStartedAt && Date.now() - reconnectStartedAt >= RECONNECT_TIMEOUT_MS) {
        return "Chat subsystem currently offline";
      }
      return "Reconnecting...";
    }

    function stopReconnect() {
      manualDisconnect = true;
      stopReconnectLoop();
    }

    function stopReconnectLoop() {
      if (reconnectLoopTimer) {
        clearInterval(reconnectLoopTimer);
        reconnectLoopTimer = null;
      }
      if (reconnectOfflineTimer) {
        clearTimeout(reconnectOfflineTimer);
        reconnectOfflineTimer = null;
      }
      reconnectStartedAt = 0;
    }

    function beginReconnect() {
      if (manualDisconnect || !token || !chatPanel.classList.contains("active") || reconnectLoopTimer) {
        return;
      }

      reconnectStartedAt = Date.now();
      setStatus(false, "Reconnecting...");
      connectSocket(true);

      reconnectOfflineTimer = setTimeout(() => {
        if (manualDisconnect || (socket && socket.readyState === WebSocket.OPEN)) {
          return;
        }
        setStatus(false, "Chat subsystem currently offline");
      }, RECONNECT_TIMEOUT_MS);

      reconnectLoopTimer = setInterval(() => {
        if (manualDisconnect || !token || !chatPanel.classList.contains("active")) {
          stopReconnectLoop();
          return;
        }
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          return;
        }
        connectSocket(true);
      }, RECONNECT_INTERVAL_MS);
    }

    function disconnectSocket() {
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        socket = null;
      }
    }

    function updateOnlineList() {
      const others = [...onlineUsers].filter((name) => name !== username).sort();
      const allOnline = username ? [username, ...others] : [...onlineUsers].sort();

      if (onlineListEl) {
        onlineListEl.innerHTML = allOnline.length
          ? allOnline.map((name) => {
              const isYou = name === username;
              return `<li class="${isYou ? "you" : ""}"><span class="dot"></span><span>${escapeHtml(name)}${isYou ? " (you)" : ""}</span></li>`;
            }).join("")
          : `<li><span class="dot"></span><span>No one online</span></li>`;
      }

      if (others.length === 0) {
        statusEl.textContent = "Online — waiting for others";
        return;
      }
      if (others.length === 1) {
        statusEl.textContent = `${others[0]} is online`;
        return;
      }
      statusEl.textContent = `${others.length} people online`;
    }

    function setStatus(connected, message) {
      if (statusEl) {
        statusEl.classList.toggle("disconnected", !connected);
        if (!connected) {
          statusEl.textContent = message || "Connecting...";
        } else {
          updateOnlineList();
        }
      }
      if (sendEl) sendEl.disabled = false;
    }

    function addSystemMessage(text) {
      if (!messagesEl) return;
      const item = document.createElement("div");
      item.className = "system-message";
      item.textContent = text;
      messagesEl.appendChild(item);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function isProtocolError(text) {
      return /Send JSON like|Invalid JSON/i.test(String(text || ""));
    }

    function addMessage(data) {
      if (data.error) {
        const text = formatError(data.error);
        if (isProtocolError(text)) return;
        addSystemMessage(text);
        return;
      }
      if (data.id && settlePending(data)) return;
      renderMessage(data);
    }

    function isPendingStatus(status) {
      return status === "sending" || status === "retrying" || status === "failed";
    }

    function receiptStatus(data, isOwn) {
      if (!isOwn) return "";
      if (isPendingStatus(data.status)) return data.status;
      const id = String(data.id);
      if (data.status === "viewed" || data.viewed || viewedMessageIds.has(id)) {
        return "viewed";
      }
      if (data.status === "delivered" || data.delivered || deliveredMessageIds.has(id)) {
        return "delivered";
      }
      return "sent";
    }

    function statusLabel(status) {
      if (status === "failed") return "Retry send";
      if (status === "retrying") return "Retrying";
      if (status === "sending") return "Sending";
      if (status === "viewed") return "Viewed";
      if (status === "delivered") return "Delivered";
      return "Sent";
    }

    function queueReceipt(id, pendingSet, timerName, flushFn) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || numeric <= 0) return;
      pendingSet.add(numeric);
      if (timerName === "view" && viewFlushTimer) return;
      if (timerName === "delivered" && deliveredFlushTimer) return;
      const timer = setTimeout(flushFn, 400);
      if (timerName === "view") viewFlushTimer = timer;
      else deliveredFlushTimer = timer;
    }

    function queueViewed(id) {
      queueReceipt(id, pendingViewIds, "view", flushViewed);
    }

    function queueDelivered(id) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || numeric <= 0) return;
      if (ackedDeliveredIds.has(numeric)) return;
      ackedDeliveredIds.add(numeric);
      queueReceipt(id, pendingDeliveredIds, "delivered", flushDelivered);
    }

    function flushReceipt(pendingSet, type, timerSetter) {
      timerSetter();
      if (!pendingSet.size) return;
      const ids = [...pendingSet];
      pendingSet.clear();
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        ids.forEach((id) => pendingSet.add(id));
        return;
      }
      socket.send(JSON.stringify({ type, ids }));
    }

    function flushViewed() {
      flushReceipt(pendingViewIds, "viewed", () => { viewFlushTimer = null; });
    }

    function flushDelivered() {
      flushReceipt(pendingDeliveredIds, "delivered", () => { deliveredFlushTimer = null; });
    }

    function applyReceipt(ids, kind) {
      (ids || []).forEach((id) => {
        if (kind === "viewed") {
          viewedMessageIds.add(String(id));
          deliveredMessageIds.add(String(id));
        } else {
          deliveredMessageIds.add(String(id));
        }
        const row = document.getElementById(`message-${id}`);
        if (!row || !row.classList.contains("sent")) return;
        const btn = row.querySelector(".send-status");
        if (!btn || btn.classList.contains("sending") || btn.classList.contains("retrying") || btn.classList.contains("failed")) {
          return;
        }
        if (kind === "delivered" && btn.classList.contains("viewed")) return;
        const next = kind === "viewed" || viewedMessageIds.has(String(id)) ? "viewed" : "delivered";
        btn.className = `send-status ${next}`;
        btn.setAttribute("aria-label", statusLabel(next));
      });
    }

    function observeReceipts(row) {
      if (!row || !row.classList.contains("received")) return;
      const observer = getViewObserver();
      if (observer) observer.observe(row);
    }

    function renderMessage(data) {
      const isOwn = data.username === username;
      const status = receiptStatus(data, isOwn);
      if (status === "viewed") viewedMessageIds.add(String(data.id));
      if (status === "delivered" || status === "viewed") deliveredMessageIds.add(String(data.id));
      let row = document.getElementById(`message-${data.id}`);
      if (!row) {
        row = document.createElement("div");
        row.id = `message-${data.id}`;
        messagesEl.appendChild(row);
      }

      row.className = `message-row ${isOwn ? "sent" : "received"}`;
      if (isPendingStatus(status)) {
        row.classList.add("pending");
      }

      const sender = isOwn ? "" : `<div class="sender">${escapeHtml(data.username)}</div>`;
      const canEdit = isOwn && !isPendingStatus(status) && data.id && !String(data.id).startsWith("pending-");
      const actions = canEdit
        ? `<span class="actions">
            <button type="button" class="edit-btn" data-id="${data.id}">Edit</button>
            <button type="button" class="delete-btn" data-id="${data.id}">Delete</button>
          </span>`
        : "";
      const sendStatus = isOwn
        ? `<button type="button" class="send-status ${status}" ${
            status === "failed" ? `data-retry="${data.id}"` : ""
          } aria-label="${statusLabel(status)}" ${status === "failed" ? "" : "tabindex='-1'"}></button>`
        : "";

      row.innerHTML = `
        <div class="bubble">
          ${sender}
          <div class="text">${escapeHtml(data.message)}</div>
          <div class="meta">
            <span class="time">${formatTime(data.created_at)}</span>
            ${sendStatus}
            ${actions}
          </div>
        </div>`;

      observeReceipts(row);
      if (!isOwn && data.id && !String(data.id).startsWith("pending-")) {
        queueDelivered(data.id);
        if (document.visibilityState === "visible") markRoomRead();
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function markPending(id, status) {
      const pending = pendingMessages.get(id);
      if (!pending) return;
      pending.status = status;
      renderMessage({
        id,
        username,
        message: pending.message,
        created_at: pending.created_at,
        status,
      });
    }

    function clearPendingTimer(id) {
      const pending = pendingMessages.get(id);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
    }

    function schedulePendingTimeout(id) {
      const pending = pendingMessages.get(id);
      if (!pending) return;
      clearPendingTimer(id);
      pending.timer = setTimeout(() => {
        if (!pendingMessages.has(id)) return;
        markPending(id, "failed");
      }, 8000);
    }

    function sendPending(id, { retrying = false } = {}) {
      const pending = pendingMessages.get(id);
      if (!pending) return;
      markPending(id, retrying ? "retrying" : "sending");
      schedulePendingTimeout(id);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        const waiting = Boolean(reconnectLoopTimer) || (socket && socket.readyState === WebSocket.CONNECTING);
        markPending(id, waiting ? "retrying" : "failed");
        if (!waiting) clearPendingTimer(id);
        return;
      }
      socket.send(JSON.stringify({ message: pending.message }));
    }

    function settlePending(data) {
      if (data.username !== username || !data.id || String(data.id).startsWith("pending-")) {
        return false;
      }
      for (const [pendingId, pending] of pendingMessages) {
        if (pending.message !== data.message) continue;
        clearPendingTimer(pendingId);
        pendingMessages.delete(pendingId);
        const row = document.getElementById(`message-${pendingId}`);
        if (row) row.id = `message-${data.id}`;
        renderMessage({ ...data });
        return true;
      }
      return false;
    }

    function reconcilePendingFromHistory() {
      const confirmed = [...messagesEl.querySelectorAll(".message-row.sent:not(.pending) .text")].map(
        (el) => el.textContent
      );
      for (const [id, pending] of [...pendingMessages]) {
        const index = confirmed.lastIndexOf(pending.message);
        if (index === -1) {
          renderMessage({
            id,
            username,
            message: pending.message,
            created_at: pending.created_at,
            status: pending.status || "retrying",
          });
          continue;
        }
        clearPendingTimer(id);
        pendingMessages.delete(id);
        confirmed.splice(index, 1);
      }
    }

    function removeMessage(messageId) {
      const item = document.getElementById(`message-${messageId}`);
      if (item) item.remove();
    }

    async function editMessage(messageId) {
      const item = document.getElementById(`message-${messageId}`);
      if (!item) return;

      const currentText = item.querySelector(".text")?.textContent || "";
      const newText = prompt("Edit your message:", currentText);
      if (newText === null) return;

      const trimmed = newText.trim();
      if (!trimmed || trimmed === currentText) return;

      const response = await fetch(`${API_BASE}/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: trimmed }),
      });

      const data = await response.json();
      if (!response.ok) {
        addSystemMessage(formatError(data.detail) || "Could not edit message.");
        return;
      }

      renderMessage(data);
    }

    async function deleteMessageById(messageId) {
      if (!confirm("Delete this message for everyone?")) return;

      const response = await fetch(`${API_BASE}/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (!response.ok) {
        addSystemMessage(formatError(data.detail) || "Could not delete message.");
        return;
      }

      removeMessage(messageId);
    }

    function updateTypingIndicator() {
      const names = [...typingUsers.keys()];
      if (names.length === 0) {
        typingEl.textContent = "";
        return;
      }
      if (names.length === 1) {
        typingEl.textContent = `${names[0]} is typing...`;
        return;
      }
      typingEl.textContent = `${names.join(", ")} are typing...`;
    }

    function showTyping(name) {
      if (!name || name === username) return;

      if (typingUsers.has(name)) {
        clearTimeout(typingUsers.get(name));
      }

      typingUsers.set(
        name,
        setTimeout(() => {
          typingUsers.delete(name);
          updateTypingIndicator();
        }, 2000)
      );
      updateTypingIndicator();
    }

    function clearTypingIndicators() {
      typingUsers.forEach((timeoutId) => clearTimeout(timeoutId));
      typingUsers.clear();
      typingEl.textContent = "";
    }

    function clearOnlineUsers() {
      onlineUsers.clear();
      updateOnlineList();
    }

    function handleSocketMessage(data) {
      if (data.type === "error") {
        stopReconnect();
        setStatus(false, data.error || "Not allowed in this room.");
        addSystemMessage(data.error || "Connection rejected.");
        disconnectSocket();
        return;
      }
      if (data.group_id != null && Number(data.group_id) !== groupId && data.type !== "group_full") {
        return;
      }
      if (data.type === "group_full") {
        stopReconnect();
        const maxUsers = data.max_users || 1000;
        setStatus(false, `Group is full (${maxUsers} users max). Try again later.`);
        addSystemMessage(data.error || `This group has reached its limit of ${maxUsers} users.`);
        disconnectSocket();
        return;
      }
      if (data.type === "online_list") {
        onlineUsers.clear();
        (data.users || []).forEach((name) => onlineUsers.add(name));
        updateOnlineList();
        return;
      }
      if (data.type === "online") {
        onlineUsers.add(data.username);
        updateOnlineList();
        return;
      }
      if (data.type === "offline") {
        onlineUsers.delete(data.username);
        updateOnlineList();
        return;
      }
      if (data.type === "typing") {
        showTyping(data.username);
        return;
      }
      if (data.type === "delete") {
        removeMessage(data.id);
        return;
      }
      if (data.type === "update") {
        renderMessage(data);
        return;
      }
      if (data.type === "viewed") {
        applyReceipt(data.ids || (data.id != null ? [data.id] : []), "viewed");
        return;
      }
      if (data.type === "delivered") {
        applyReceipt(data.ids || (data.id != null ? [data.id] : []), "delivered");
        return;
      }
      if (data.message && data.username && data.id) {
        if (!settlePending(data)) renderMessage(data);
      } else if (data.message && data.username) {
        addMessage(data);
      } else if (data.error) {
        const text = formatError(data.error);
        if (!isProtocolError(text)) addMessage(data);
      }
    }

    function sendTypingSignal() {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (typingSendTimeout) return;

      socket.send(JSON.stringify({ type: "typing" }));
      typingSendTimeout = setTimeout(() => {
        typingSendTimeout = null;
      }, 1000);
    }

    function showAuth() {
      stopReconnect();
      disconnectSocket();
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      localStorage.removeItem("is_admin");
      window.location.replace("/auth/login?next=" + encodeURIComponent("/console/chat?group=" + groupId));
    }

    function applyGroup(group) {
      const name = group && group.name ? group.name : "Group";
      const isDirect = Boolean(group && group.is_direct);
      document.body.classList.toggle("direct-chat", isDirect);
      if (groupNameEl) groupNameEl.textContent = name;
      if (groupHeadingEl) groupHeadingEl.textContent = name;
      if (groupTagEl) {
        groupTagEl.textContent = isDirect ? "Direct message" : (group && group.is_default ? "Default room" : "Group");
      }
      if (groupBlurbEl) {
        groupBlurbEl.textContent = isDirect
          ? "Private conversation — only the two of you can see this."
          : ((group && group.member_count ? group.member_count : 0) === 1
            ? "1 member in this room."
            : `${group && group.member_count ? group.member_count : 0} members in this room.`);
      }
      if (messageEl) {
        messageEl.placeholder = isDirect ? `Message ${name}` : "Share something with the community";
      }
      document.title = name + " — Distributed Chat";
    }

    let readFlushTimer = null;
    function markRoomRead() {
      if (!API_BASE || !token || !groupId) return;
      if (readFlushTimer) return;
      readFlushTimer = setTimeout(async () => {
        readFlushTimer = null;
        try {
          const response = await fetch(`${API_BASE}/groups/${groupId}/read`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) return;
          const inbox = await response.json();
          if (typeof window.applyInbox === "function") window.applyInbox(inbox);
        } catch {
          // Keep existing badges if marking read fails.
        }
      }, 250);
    }

    async function resolveGroupId() {
      if (groupId) return groupId;
      try {
        const response = await fetch(`${API_BASE}/groups`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === 401) {
          showAuth();
          return 0;
        }
        const groups = response.ok ? await response.json() : [];
        const mine = Array.isArray(groups) ? groups.filter((group) => group.is_member && !group.is_direct) : [];
        const community = mine.find((group) => group.is_default) || mine[0];
        groupId = community ? Number(community.id) : 1;
      } catch {
        groupId = 1;
      }
      return groupId;
    }

    async function loadGroup() {
      const response = await fetch(`${API_BASE}/groups/${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        showAuth();
        return null;
      }
      if (!response.ok) {
        let detail = "Could not open this room.";
        try {
          const body = await response.json();
          detail = formatError(body.detail) || detail;
        } catch {
          // Keep the fallback message if the body is not JSON.
        }
        applyGroup({ name: "Unavailable", member_count: 0, is_default: false, is_direct: false });
        addSystemMessage(detail);
        return null;
      }
      const group = await response.json();
      try {
        sessionStorage.setItem("chat_group", String(groupId));
      } catch {
        // Ignore storage failures in restricted browsers.
      }
      applyGroup(group);
      return group;
    }

    async function loadHistory({ replace = false } = {}) {
      const response = await fetch(`${API_BASE}/messages?group_id=${encodeURIComponent(groupId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error("Could not load message history.");
      }
      const history = await response.json();
      if (replace && messagesEl) messagesEl.innerHTML = "";
      history.forEach(renderMessage);
    }

    async function showChat() {
      manualDisconnect = false;
      if (chatPanel) chatPanel.classList.add("active");
      if (userAvatar) userAvatar.textContent = username ? username[0].toUpperCase() : "?";
      if (adminLink) {
        adminLink.classList.toggle("visible", localStorage.getItem("is_admin") === "true");
      }
      if (sendEl) sendEl.disabled = false;
      if (!API_BASE) {
        addSystemMessage("API_BASE is missing from config.js.");
        return;
      }
      try {
        await resolveGroupId();
        const group = await loadGroup();
        if (!group) return;
        markRoomRead();
        try {
          await loadHistory();
        } catch (error) {
          addSystemMessage(error.message || "Could not load message history.");
        }
        connectSocket();
      } catch (error) {
        addSystemMessage(error.message || "Could not open this room.");
      }
    }

    async function connectSocket(isReconnect = false) {
      if (manualDisconnect || !token) {
        return;
      }
      if (!WS_BASE) {
        setStatus(false, "Messaging server is not configured.");
        addSystemMessage("WS_BASE is missing from config.js, so live chat cannot connect.");
        return;
      }

      const gen = ++connectGen;
      disconnectSocket();
      setStatus(false, isReconnect ? reconnectStatusMessage() : "Connecting...");

      let ticket = null;
      try {
        const response = await fetch(`${API_BASE}/ws-ticket`, {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const data = await response.json();
          ticket = data.ticket || null;
        }
      } catch {
        ticket = null;
      }
      if (gen !== connectGen || manualDisconnect) {
        return;
      }

      socket = new WebSocket(`${WS_BASE}/ws?group=${encodeURIComponent(groupId)}`);
      const current = socket;

      socket.addEventListener("open", async () => {
        if (socket !== current) return;
        if (ticket) {
          current.send(JSON.stringify({ type: "auth", ticket, token }));
        } else {
          current.send(JSON.stringify({ type: "auth", token }));
        }
        stopReconnectLoop();
        setStatus(true);
        clearTypingIndicators();
        try {
          if (isReconnect) {
            clearOnlineUsers();
            await loadHistory({ replace: true });
          }
          reconcilePendingFromHistory();
          messagesEl.querySelectorAll(".message-row.received").forEach(observeReceipts);
          flushDelivered();
          flushViewed();
          for (const [id, pending] of pendingMessages) {
            if (pending.status === "failed" || pending.status === "sending" || pending.status === "retrying") {
              sendPending(id, { retrying: true });
            }
          }
        } catch (error) {
          addSystemMessage(error.message);
        }
      });

      socket.addEventListener("close", () => {
        if (socket !== current) {
          return;
        }
        if (manualDisconnect) {
          return;
        }
        clearTypingIndicators();
        clearOnlineUsers();
        for (const [id, pending] of pendingMessages) {
          if (pending.status === "sending" || pending.status === "retrying") {
            markPending(id, "retrying");
          }
        }
        beginReconnect();
      });

      socket.addEventListener("error", () => {
        if (!manualDisconnect) {
          setStatus(false, reconnectStatusMessage());
        }
      });

      socket.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        handleSocketMessage(data);
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        fetch(`${API_BASE}/logout`, {
          method: "POST",
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).catch(() => {});
        localStorage.removeItem("token");
        localStorage.removeItem("username");
        localStorage.removeItem("is_admin");
        token = null;
        username = null;
        showAuth();
      });
    }

    if (messageEl) messageEl.addEventListener("input", sendTypingSignal);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !messagesEl) return;
      messagesEl.querySelectorAll(".message-row.received").forEach(observeReceipts);
      flushDelivered();
      flushViewed();
      markRoomRead();
    });

    if (messagesEl) messagesEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;

      if (target.classList.contains("send-status") && target.dataset.retry) {
        const pendingId = target.dataset.retry;
        if (pendingMessages.has(pendingId) && target.classList.contains("failed")) {
          sendPending(pendingId, { retrying: true });
        }
        return;
      }

      const messageId = target.dataset.id;
      if (!messageId) return;

      if (target.classList.contains("edit-btn")) {
        editMessage(messageId);
      } else if (target.classList.contains("delete-btn")) {
        deleteMessageById(messageId);
      }
    });

    if (chatForm) chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = messageEl.value.trim();
      if (!message) return;

      pendingSeq += 1;
      const id = `pending-${Date.now()}-${pendingSeq}`;
      pendingMessages.set(id, {
        message,
        created_at: new Date().toISOString(),
        status: "sending",
        timer: null,
      });
      messageEl.value = "";
      messageEl.focus();
      sendPending(id);
    });

    async function refreshAdminFlag() {
      if (!token) return;
      try {
        const response = await fetch(`${API_BASE}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const data = await response.json();
        localStorage.setItem("is_admin", data.is_admin ? "true" : "false");
        if (adminLink) adminLink.classList.toggle("visible", Boolean(data.is_admin));
        var consoleAdmin = document.getElementById("console-admin");
        if (consoleAdmin) consoleAdmin.hidden = !data.is_admin;
      } catch {
        // Keep cached role if /me is unavailable.
      }
    }

    if (token && username) {
      showChat().catch((error) => {
        addSystemMessage(error.message || "Could not start chat.");
      });
      refreshAdminFlag();
    } else {
      window.location.replace("/auth/login?next=" + encodeURIComponent("/console/chat"));
    }
})();
