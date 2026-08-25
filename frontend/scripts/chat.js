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
    const connectionStatusEl = document.getElementById("connection-status");
    const messagesEmptyEl = document.getElementById("messages-empty");
    const messagesSkeletonEl = document.getElementById("messages-skeleton");
    const chatHeaderEl = document.getElementById("chat-header");
    const skeletonMarkup = messagesSkeletonEl ? messagesSkeletonEl.innerHTML : "";
    let skeletonTimeoutClear = null;
    const messagesEl = document.getElementById("messages");
    const messagesListEl = document.getElementById("messages-list");
    const messagesAnchorEl = document.getElementById("messages-anchor");
    const scrollBottomBtn = document.getElementById("scroll-bottom-btn");
    const scrollBottomCount = document.getElementById("scroll-bottom-count");
    const chatForm = document.getElementById("chat-form");
    const messageEl = document.getElementById("message");
    const sendEl = document.getElementById("send");
    const voiceBtn = document.getElementById("voice-btn");
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
    let recoveryTimer = null;
    let apiOffline = false;
    let recoveryBusy = false;
    let manualDisconnect = false;
    let wasDisconnected = false;
    let connectionState = "connecting";
    let presenceText = "";
    let currentIsDirect = false;
    let currentPeer = "";
    let peerOnline = false;
    let peerLastSeen = "";
    let presencePollTimer = null;

    function startPresencePoll() {
      if (presencePollTimer) return;
      presencePollTimer = setInterval(async () => {
        if (!API_BASE || !token || !groupId || !currentIsDirect) return;
        try {
          const response = await fetch(`${API_BASE}/groups/${groupId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) return;
          const group = await response.json();
          const next = Boolean(group.online);
          if (group.last_seen) peerLastSeen = group.last_seen;
          if (next !== peerOnline) {
            peerOnline = next;
            if (peerOnline) markOwnMessagesDelivered();
            updateOnlineList();
          }
        } catch {
          // Keep the last known presence if this poll fails.
        }
      }, 12000);
    }
    let backOnlineTimer = null;
    const RECONNECT_INTERVAL_MS = 3000;
    const RECONNECT_TIMEOUT_MS = 12000;
    const RECOVERY_INTERVAL_MS = 5000;
    const SCROLL_NEAR_PX = 96;
    const MESSAGE_GROUP_GAP_MS = 2 * 60 * 1000;
    let stickToBottom = true;
    let unreadBelow = 0;
    let scrollRaf = null;
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

    function isNetworkError(error) {
      if (!error) return false;
      if (error.name === "TimeoutError") return true;
      return error instanceof TypeError;
    }

    function networkErrorMessage(error) {
      if (error?.name === "TimeoutError") return "Taking longer than usual — still trying…";
      if (isNetworkError(error)) return "Connecting to server";
      return error?.message || "Could not reach the server.";
    }

    function isConnectionNoise(text) {
      const value = String(text || "").toLowerCase();
      return (
        /reconnect|failed to fetch|could not reach|taking longer|network|server is not configured|database offline/.test(value)
      );
    }

    let presenceTypeTimer = null;
    let shownPresence = "";

    function revealPresence(text) {
      if (!statusEl || text == null) return;
      if (text === shownPresence && statusEl.textContent === text && !presenceTypeTimer) return;
      shownPresence = text;
      if (presenceTypeTimer) {
        clearInterval(presenceTypeTimer);
        presenceTypeTimer = null;
      }
      statusEl.classList.remove("is-typing", "is-animating");
      if (connectionStatusEl) {
        connectionStatusEl.classList.toggle("is-peer-online", text === "online");
      }
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const typeLastSeen = currentIsDirect && text !== "online" && String(text).indexOf("last seen") === 0;
      if (reduce || !typeLastSeen) {
        statusEl.textContent = text;
        if (!reduce) {
          void statusEl.offsetWidth;
          statusEl.classList.add("is-animating");
        }
        return;
      }
      let i = 0;
      statusEl.textContent = "";
      statusEl.classList.add("is-typing");
      presenceTypeTimer = setInterval(function () {
        i += 1;
        statusEl.textContent = text.slice(0, i);
        if (i >= text.length) {
          clearInterval(presenceTypeTimer);
          presenceTypeTimer = null;
          statusEl.classList.remove("is-typing");
        }
      }, 20);
    }

    function setConnectionState(state, message) {
      connectionState = state;
      if (connectionStatusEl) connectionStatusEl.dataset.state = state;
      if (statusEl && message != null) statusEl.textContent = message;
    }

    function showBackOnline() {
      if (backOnlineTimer) {
        clearTimeout(backOnlineTimer);
        backOnlineTimer = null;
      }
      setConnectionState("back", "Back online");
      backOnlineTimer = setTimeout(() => {
        backOnlineTimer = null;
        if (connectionState === "back") {
          connectionState = "connected";
          if (connectionStatusEl) connectionStatusEl.dataset.state = "connected";
          if (statusEl) revealPresence(presenceText || "Connected");
        }
      }, 2200);
    }

    function restoreMessageSkeleton() {
      if (!messagesSkeletonEl || !skeletonMarkup) return;
      messagesSkeletonEl.classList.remove("is-timeout");
      if (!messagesSkeletonEl.querySelector(".sk-bubble")) {
        messagesSkeletonEl.innerHTML = skeletonMarkup;
      }
    }

    function showHistorySkeletonTimeout() {
      if (!messagesSkeletonEl) {
        setHistoryLoading(false);
        return;
      }
      messagesSkeletonEl.classList.remove("is-hidden");
      messagesSkeletonEl.classList.add("is-timeout");
      messagesSkeletonEl.replaceChildren();
      const panel = window.chatUi && window.chatUi.timeoutPanel
        ? window.chatUi.timeoutPanel("This chat took too long to load.", () => {
            restoreMessageSkeleton();
            showChat();
          })
        : null;
      if (panel) messagesSkeletonEl.appendChild(panel);
      if (messagesEmptyEl) messagesEmptyEl.classList.add("is-hidden");
      if (chatHeaderEl) chatHeaderEl.classList.remove("is-loading");
    }

    function setHistoryLoading(loading) {
      if (skeletonTimeoutClear) {
        skeletonTimeoutClear();
        skeletonTimeoutClear = null;
      }
      if (
        !loading &&
        messagesSkeletonEl &&
        messagesSkeletonEl.classList.contains("is-timeout") &&
        !(messagesListEl && messagesListEl.querySelector(".message-row, .system-message"))
      ) {
        return;
      }
      if (loading) {
        restoreMessageSkeleton();
        if (window.chatUi && window.chatUi.armSkeletonTimeout) {
          skeletonTimeoutClear = window.chatUi.armSkeletonTimeout(showHistorySkeletonTimeout);
        }
      }
      if (messagesSkeletonEl) {
        messagesSkeletonEl.classList.toggle("is-hidden", !loading);
        if (!loading) messagesSkeletonEl.classList.remove("is-timeout");
      }
      if (loading && messagesEmptyEl) {
        messagesEmptyEl.classList.add("is-hidden");
      }
      if (!loading) updateEmptyState();
    }

    function updateEmptyState() {
      if (!messagesEmptyEl || !messagesListEl) return;
      if (messagesSkeletonEl && !messagesSkeletonEl.classList.contains("is-hidden")) {
        messagesEmptyEl.classList.add("is-hidden");
        return;
      }
      const hasContent = messagesListEl.querySelector(".message-row, .system-message");
      messagesEmptyEl.classList.toggle("is-hidden", Boolean(hasContent));
    }

    function isNearBottom(threshold = SCROLL_NEAR_PX) {
      if (!messagesEl) return true;
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
    }

    function updateScrollBottomBtn() {
      if (!scrollBottomBtn) return;
      const show = !stickToBottom;
      scrollBottomBtn.hidden = !show;
      scrollBottomBtn.classList.toggle("is-visible", show);
      if (scrollBottomCount) {
        const showCount = show && unreadBelow > 0;
        scrollBottomCount.hidden = !showCount;
        scrollBottomCount.textContent = unreadBelow > 99 ? "99+" : String(unreadBelow);
      }
    }

    function scrollToBottom({ smooth = true, force = false } = {}) {
      if (!messagesEl) return;
      if (!force && !stickToBottom) return;
      stickToBottom = true;
      unreadBelow = 0;
      updateScrollBottomBtn();
      const behavior = smooth ? "smooth" : "instant";
      if (messagesAnchorEl?.scrollIntoView) {
        messagesAnchorEl.scrollIntoView({ behavior, block: "end" });
        return;
      }
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior });
    }

    function queueScrollToBottom(options = {}) {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        scrollToBottom(options);
      });
    }

    function afterIncomingMessage({ isOwn = false, force = false } = {}) {
      applyMessageGrouping();
      if (force || isOwn || stickToBottom || isNearBottom()) {
        queueScrollToBottom({ smooth: !force, force: true });
        return;
      }
      unreadBelow += 1;
      updateScrollBottomBtn();
    }

    function onMessagesScroll() {
      if (!messagesEl) return;
      if (isNearBottom()) {
        stickToBottom = true;
        unreadBelow = 0;
      } else {
        stickToBottom = false;
      }
      updateScrollBottomBtn();
    }

    function applyMessageGrouping() {
      if (!messagesListEl) return;
      const rows = [...messagesListEl.querySelectorAll(".message-row")];
      rows.forEach((row, index) => {
        row.classList.remove("group-first", "group-middle", "group-last", "group-single");
        const prev = rows[index - 1];
        const next = rows[index + 1];
        const user = row.dataset.username || "";
        const time = Date.parse(row.dataset.createdAt || "");
        const prevTime = prev ? Date.parse(prev.dataset.createdAt || "") : NaN;
        const nextTime = next ? Date.parse(next.dataset.createdAt || "") : NaN;
        const continuesPrev =
          prev &&
          prev.dataset.username === user &&
          Number.isFinite(time) &&
          Number.isFinite(prevTime) &&
          time - prevTime < MESSAGE_GROUP_GAP_MS;
        const continuesNext =
          next &&
          next.dataset.username === user &&
          Number.isFinite(time) &&
          Number.isFinite(nextTime) &&
          nextTime - time < MESSAGE_GROUP_GAP_MS;

        if (!continuesPrev && !continuesNext) row.classList.add("group-single");
        else if (!continuesPrev && continuesNext) row.classList.add("group-first");
        else if (continuesPrev && continuesNext) row.classList.add("group-middle");
        else row.classList.add("group-last");

        const senderEl = row.querySelector(".sender");
        if (senderEl) senderEl.hidden = continuesPrev;
      });
    }

    function stopRecoveryLoop() {
      if (recoveryTimer) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
      }
    }

    function markApiOffline(message) {
      apiOffline = true;
      wasDisconnected = true;
      const detail =
        reconnectStartedAt && Date.now() - reconnectStartedAt >= RECONNECT_TIMEOUT_MS
          ? "Connecting to server"
          : message || "Connecting to server";
      const state =
        reconnectStartedAt && Date.now() - reconnectStartedAt >= RECONNECT_TIMEOUT_MS
          ? "offline"
          : "reconnecting";
      setConnectionState(state, detail);
      startRecoveryLoop();
    }

    function markApiOnline() {
      apiOffline = false;
      stopRecoveryLoop();
    }

    async function checkApiHealth() {
      if (!API_BASE) return false;
      try {
        const response = await fetch(`${API_BASE}/health`, { timeoutMs: 5000 });
        if (!response.ok) return false;
        const data = await response.json();
        return Boolean(data.ok);
      } catch {
        return false;
      }
    }

    async function attemptRecovery() {
      if (recoveryBusy || manualDisconnect || !token || !chatPanel?.classList.contains("active")) {
        return false;
      }

      recoveryBusy = true;
      try {
        const healthy = await checkApiHealth();
        if (!healthy) {
          setConnectionState("reconnecting", reconnectStatusMessage());
          return false;
        }

        markApiOnline();
        await resolveGroupId();
        const group = await loadGroup();
        if (!group) return false;

        try {
          await loadHistory({ replace: true });
        } catch (error) {
          if (isNetworkError(error)) {
            markApiOffline(networkErrorMessage(error));
            return false;
          }
        }

        if (!socket || socket.readyState !== WebSocket.OPEN) {
          connectSocket(true);
        } else {
          setStatus(true);
        }

        for (const [id, pending] of pendingMessages) {
          if (pending.status === "failed" || pending.status === "sending" || pending.status === "retrying") {
            sendPending(id, { retrying: true });
          }
        }
        return true;
      } catch (error) {
        if (isNetworkError(error)) {
          markApiOffline(networkErrorMessage(error));
        }
        return false;
      } finally {
        recoveryBusy = false;
      }
    }

    function startRecoveryLoop() {
      if (recoveryTimer || manualDisconnect) return;
      recoveryTimer = setInterval(() => {
        attemptRecovery().catch(() => {});
      }, RECOVERY_INTERVAL_MS);
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
      return "Connecting to server";
    }

    function stopReconnect() {
      manualDisconnect = true;
      stopReconnectLoop();
      stopRecoveryLoop();
      markApiOnline();
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
      wasDisconnected = true;
      setStatus(false, "Connecting to server", "reconnecting");
      connectSocket(true);

      reconnectOfflineTimer = setTimeout(() => {
        if (manualDisconnect || (socket && socket.readyState === WebSocket.OPEN)) {
          return;
        }
        setStatus(false, "Connecting to server", "offline");
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

    function peerPresenceLabel() {
      if (peerOnline) return "online";
      if (window.chatUi && typeof window.chatUi.formatPresence === "function") {
        return window.chatUi.formatPresence({ online: false, last_seen: peerLastSeen });
      }
      return "last seen recently";
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

      if (currentIsDirect) {
        if (currentPeer && others.indexOf(currentPeer) >= 0) peerOnline = true;
        presenceText = peerOnline ? "online" : peerPresenceLabel();
      } else if (others.length === 0) {
        presenceText = username ? "You're the only one here" : "No one online";
      } else if (others.length === 1) {
        presenceText = `${others[0]} is online`;
      } else {
        presenceText = `${others.length} people online`;
      }

      if (connectionState === "connected" && statusEl) {
        revealPresence(presenceText);
      }
    }

    function setStatus(connected, message, mode) {
      if (connected) {
        markApiOnline();
        if (wasDisconnected) {
          showBackOnline();
          wasDisconnected = false;
        } else {
          connectionState = "connected";
          if (connectionStatusEl) connectionStatusEl.dataset.state = "connected";
        }
        updateOnlineList();
      } else if (statusEl || connectionStatusEl) {
        if (mode !== "connecting") wasDisconnected = true;
        if (mode === "connecting") {
          setConnectionState("connecting", message || "Connecting…");
        } else if (mode === "offline") {
          setConnectionState("offline", message || "Connection paused");
        } else if (mode === "error") {
          setConnectionState("error", message || "Connection issue");
        } else {
          const detail = message || reconnectStatusMessage();
          const state =
            reconnectStartedAt && Date.now() - reconnectStartedAt >= RECONNECT_TIMEOUT_MS
              ? "offline"
              : "reconnecting";
          setConnectionState(state, detail);
        }
      }
      if (sendEl) sendEl.disabled = false;
      if (window.ChatCall) window.ChatCall.setConnected(Boolean(connected));
    }

    function addSystemMessage(text) {
      if (!messagesListEl || isConnectionNoise(text) || apiOffline || reconnectLoopTimer) return;
      const item = document.createElement("div");
      item.className = "system-message";
      item.textContent = text;
      messagesListEl.appendChild(item);
      afterIncomingMessage({ force: stickToBottom });
      updateEmptyState();
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
      if (
        data.status === "delivered" ||
        data.delivered ||
        deliveredMessageIds.has(id) ||
        peerIsInApp()
      ) {
        return "delivered";
      }
      return "sent";
    }

    function peerIsInApp() {
      if (currentIsDirect) return Boolean(peerOnline);
      for (const name of onlineUsers) {
        if (name !== username) return true;
      }
      return false;
    }

    function markOwnMessagesDelivered() {
      if (!messagesListEl) return;
      const ids = [];
      messagesListEl.querySelectorAll(".message-row.sent").forEach((row) => {
        const id = String(row.id || "").replace("message-", "");
        if (!id || id.startsWith("pending-")) return;
        ids.push(id);
      });
      if (ids.length) applyReceipt(ids, "delivered");
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

    function tickMarkup(status) {
      if (status === "sent") {
        return '<svg class="tick-icon" viewBox="0 0 16 12" aria-hidden="true"><path d="M2 6.4l3.4 3.4L14 1.8"/></svg>';
      }
      if (status === "delivered" || status === "viewed") {
        return '<svg class="tick-icon" viewBox="0 0 22 12" aria-hidden="true"><path d="M1.4 6.4l3.3 3.4L12.8 1.8"/><path d="M7.2 6.4l3.3 3.4L20.6 1.6"/></svg>';
      }
      return "";
    }

    function setTickButton(btn, status) {
      if (!btn) return;
      btn.className = "send-status " + status;
      btn.setAttribute("aria-label", statusLabel(status));
      if (status === "failed") {
        btn.innerHTML = "";
        return;
      }
      btn.innerHTML = tickMarkup(status);
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
        setTickButton(btn, next);
      });
    }

    function observeReceipts(row) {
      if (!row || !row.classList.contains("received")) return;
      const observer = getViewObserver();
      if (observer) observer.observe(row);
    }

    let notifyCtx = null;
    let notifySoundAt = 0;
    let notifyAudio = null;
    let notifyArmed = false;

    function buildNotifyWavUrl() {
      const sampleRate = 22050;
      const duration = 0.28;
      const count = Math.floor(sampleRate * duration);
      const bytes = new ArrayBuffer(44 + count * 2);
      const view = new DataView(bytes);
      function writeStr(offset, text) {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      }
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + count * 2, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, "data");
      view.setUint32(40, count * 2, true);
      for (let i = 0; i < count; i += 1) {
        const t = i / sampleRate;
        const freq = t < 0.12 ? 1046 : 1396;
        const attack = Math.min(1, i / 180);
        const release = Math.min(1, (count - i) / 900);
        const sample = Math.sin(2 * Math.PI * freq * t) * attack * release * 0.72;
        view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
      }
      return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    }

    function getNotifyAudio() {
      if (notifyAudio) return notifyAudio;
      notifyAudio = new Audio(buildNotifyWavUrl());
      notifyAudio.preload = "auto";
      notifyAudio.volume = 1;
      return notifyAudio;
    }

    function unlockNotifyAudio() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) {
        if (!notifyCtx) notifyCtx = new Ctor();
        if (notifyCtx.state === "suspended") notifyCtx.resume().catch(function () {});
      }
      const audio = getNotifyAudio();
      if (notifyArmed) return;
      audio.volume = 0.01;
      const play = audio.play();
      if (play && typeof play.then === "function") {
        play.then(function () {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = 1;
          notifyArmed = true;
        }).catch(function () {});
      } else {
        notifyArmed = true;
        audio.volume = 1;
      }
    }

    function playMessageSound() {
      unlockNotifyAudio();
      const audio = getNotifyAudio();
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
        const play = audio.play();
        if (play && typeof play.catch === "function") play.catch(function () {});
      } catch {
        // Autoplay may still be blocked until the next tap.
      }
      if (!notifyCtx) return;
      const start = function () {
        const now = notifyCtx.currentTime;
        const gain = notifyCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.28, now + 0.02);
        gain.gain.linearRampToValueAtTime(0.0001, now + 0.24);
        gain.connect(notifyCtx.destination);
        [1046, 1396].forEach(function (freq, index) {
          const osc = notifyCtx.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = freq;
          osc.connect(gain);
          const when = now + index * 0.09;
          osc.start(when);
          osc.stop(when + 0.16);
        });
      };
      if (notifyCtx.state === "suspended") {
        notifyCtx.resume().then(start).catch(function () {});
      } else {
        start();
      }
    }

    function notifyPref(key, fallback) {
      if (window.chatNotify && typeof window.chatNotify.enabled === "function") {
        return window.chatNotify.enabled(key);
      }
      return fallback !== false;
    }

    function playUiCue(kind) {
      if (kind === "type" && !notifyPref("typingSound", true)) return;
      if ((kind === "rec-start" || kind === "rec-stop") && !notifyPref("voiceSound", true)) return;
      unlockNotifyAudio();
      if (!notifyCtx) return;
      const run = function () {
        const now = notifyCtx.currentTime;
        const gain = notifyCtx.createGain();
        gain.connect(notifyCtx.destination);
        if (kind === "type") {
          gain.gain.setValueAtTime(0.09, now);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.035);
          const osc = notifyCtx.createOscillator();
          osc.type = "square";
          osc.frequency.value = 1580 + Math.random() * 280;
          osc.connect(gain);
          osc.start(now);
          osc.stop(now + 0.04);
          return;
        }
        if (kind === "rec-start") {
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.linearRampToValueAtTime(0.24, now + 0.018);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.32);
          [784, 1175].forEach(function (freq, index) {
            const osc = notifyCtx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq;
            osc.connect(gain);
            osc.start(now + index * 0.08);
            osc.stop(now + 0.16 + index * 0.08);
          });
          return;
        }
        if (kind === "rec-stop") {
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.16);
          const osc = notifyCtx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = 523;
          osc.connect(gain);
          osc.start(now);
          osc.stop(now + 0.16);
        }
      };
      if (notifyCtx.state === "suspended") {
        notifyCtx.resume().then(run).catch(function () {});
      } else {
        run();
      }
    }

    function notifyIncomingMessage() {
      if (document.body.classList.contains("in-call")) return;
      if (!notifyPref("messageSound", true)) return;
      const typing = Boolean(messageEl && document.activeElement === messageEl);
      if (typing && !notifyPref("messageWhileTyping", true)) return;
      const t = Date.now();
      if (t - notifySoundAt < 400) return;
      notifySoundAt = t;
      playMessageSound();
      if (notifyPref("vibrate", true) && navigator.vibrate) navigator.vibrate(24);
    }

    function renderMessage(data, options) {
      const isOwn = data.username === username;
      const status = receiptStatus(data, isOwn);
      if (status === "viewed") viewedMessageIds.add(String(data.id));
      if (status === "delivered" || status === "viewed") deliveredMessageIds.add(String(data.id));
      let row = document.getElementById(`message-${data.id}`);
      const isNew = !row;
      if (!row) {
        row = document.createElement("div");
        row.id = `message-${data.id}`;
        messagesListEl.appendChild(row);
      }

      row.dataset.username = data.username || "";
      row.dataset.createdAt = data.created_at || "";
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
          } aria-label="${statusLabel(status)}" ${status === "failed" ? "" : "tabindex='-1'"}>${tickMarkup(status)}</button>`
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
      if (!isOwn && isNew && !(options && options.silent)) {
        notifyIncomingMessage();
      }
      if (!isOwn && data.id && !String(data.id).startsWith("pending-")) {
        queueDelivered(data.id);
        if (document.visibilityState === "visible") markRoomRead();
      }
      afterIncomingMessage({ isOwn, force: isOwn });
      updateEmptyState();
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
      const confirmed = [...messagesListEl.querySelectorAll(".message-row.sent:not(.pending) .text")].map(
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
      updateEmptyState();
    }

    async function editMessage(messageId) {
      const item = document.getElementById(`message-${messageId}`);
      if (!item) return;

      const currentText = item.querySelector(".text")?.textContent || "";
      const newText = window.appPrompt
        ? await window.appPrompt({
            title: "Edit message",
            body: "Change the text everyone will see.",
            value: currentText,
            confirmLabel: "Save",
          })
        : prompt("Edit your message:", currentText);
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
      const ok = window.appConfirm
        ? await window.appConfirm({
            title: "Delete message?",
            body: "This removes it for everyone in the chat.",
            confirmLabel: "Delete",
            danger: true,
          })
        : confirm("Delete this message for everyone?");
      if (!ok) return;

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
        typingEl.textContent = `${names[0]} is typing…`;
      } else {
        typingEl.textContent = `${names.join(", ")} are typing…`;
      }
      if (stickToBottom) queueScrollToBottom({ smooth: true, force: true });
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
      if (data.type && String(data.type).startsWith("call_")) {
        if (window.ChatCall) window.ChatCall.handle(data);
        return;
      }
      if (data.type === "error") {
        stopReconnect();
        setStatus(false, data.error || "Not allowed in this room.", "error");
        addSystemMessage(data.error || "Connection rejected.");
        disconnectSocket();
        return;
      }
      if (data.group_id != null && Number(data.group_id) !== groupId && data.type !== "group_full" && data.type !== "presence") {
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
      if (data.type === "presence") {
        if (data.username && data.username !== username && data.online) {
          if (currentIsDirect && data.username === currentPeer) peerOnline = true;
          markOwnMessagesDelivered();
        }
        if (currentIsDirect && data.username === currentPeer) {
          peerOnline = Boolean(data.online);
          if (data.last_seen) peerLastSeen = data.last_seen;
          else if (!peerOnline) peerLastSeen = new Date().toISOString();
          updateOnlineList();
        }
        return;
      }
      if (data.type === "offline") {
        onlineUsers.delete(data.username);
        updateOnlineList();
        if (window.ChatCall) window.ChatCall.onPeerOffline(data.username);
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
      if (window.ChatCall) window.ChatCall.hangup();
      disconnectSocket();
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      localStorage.removeItem("is_admin");
      window.location.replace("/auth/login?next=" + encodeURIComponent("/console/chat?group=" + groupId));
    }

    function applyGroup(group) {
      const name = group && group.name ? group.name : "Group";
      const isDirect = Boolean(group && group.is_direct);
      currentIsDirect = isDirect;
      currentPeer = isDirect ? (group && (group.peer || group.name) ? (group.peer || group.name) : "") : "";
      peerOnline = Boolean(isDirect && group && group.online);
      peerLastSeen = isDirect && group ? (group.last_seen || group.last_at || "") : "";
      if (isDirect && peerOnline && typeof markOwnMessagesDelivered === "function") {
        markOwnMessagesDelivered();
      }
      document.body.classList.toggle("direct-chat", isDirect);
      if (groupNameEl) groupNameEl.textContent = name;
      if (groupHeadingEl) groupHeadingEl.textContent = name;
      if (userAvatar) {
        userAvatar.textContent = name.charAt(0).toUpperCase();
        let hue = 0;
        for (const ch of name) hue = (hue * 33 + ch.charCodeAt(0)) % 360;
        userAvatar.style.background = `hsl(${hue}, 42%, 36%)`;
        userAvatar.style.color = "#fff";
      }
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
        messageEl.placeholder = "Type a message";
      }
      document.title = name + " — Chat";
      if (chatHeaderEl) chatHeaderEl.classList.remove("is-loading");
      if (isDirect) updateOnlineList();
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
      let response;
      try {
        response = await fetch(`${API_BASE}/groups/${groupId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        markApiOffline(networkErrorMessage(error));
        throw error;
      }
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
        if (response.status >= 500) {
          markApiOffline("Connecting to server");
          throw new Error(detail);
        }
        applyGroup({ name: "Unavailable", member_count: 0, is_default: false, is_direct: false });
        addSystemMessage(detail);
        return null;
      }
      markApiOnline();
      const group = await response.json();
      try {
        sessionStorage.setItem("chat_group", String(groupId));
      } catch {
        // Ignore storage failures in restricted browsers.
      }
      applyGroup(group);
      startPresencePoll();
      return group;
    }

    async function loadHistory({ replace = false } = {}) {
      let response;
      try {
        response = await fetch(`${API_BASE}/messages?group_id=${encodeURIComponent(groupId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: (window.chatUi && window.chatUi.SKELETON_TIMEOUT_MS) || 8000,
        });
      } catch (error) {
        markApiOffline(networkErrorMessage(error));
        throw error;
      }
      if (!response.ok) {
        if (response.status >= 500) {
          markApiOffline("Connecting to server");
        }
        throw new Error("Could not load message history.");
      }
      const history = await response.json();
      if (replace && messagesListEl) messagesListEl.innerHTML = "";
      history.forEach(function (item) {
        renderMessage(item, { silent: true });
      });
      applyMessageGrouping();
      setHistoryLoading(false);
      stickToBottom = true;
      unreadBelow = 0;
      updateScrollBottomBtn();
      queueScrollToBottom({ smooth: false, force: true });
    }

    async function showChat() {
      manualDisconnect = false;
      if (chatPanel) chatPanel.classList.add("active");
      if (adminLink) {
        adminLink.classList.toggle("visible", localStorage.getItem("is_admin") === "true");
      }
      if (sendEl) sendEl.disabled = false;
      setHistoryLoading(true);
      if (!API_BASE) {
        setHistoryLoading(false);
        addSystemMessage("API_BASE is missing from config.js.");
        return;
      }
      try {
        await resolveGroupId();
        const group = await loadGroup();
        if (!group) {
          setHistoryLoading(false);
          if (chatHeaderEl) chatHeaderEl.classList.remove("is-loading");
          if (apiOffline) startRecoveryLoop();
          return;
        }
        markRoomRead();
        try {
          await loadHistory();
        } catch (error) {
          setHistoryLoading(false);
          if (isNetworkError(error)) {
            markApiOffline(networkErrorMessage(error));
          } else if (!isConnectionNoise(error.message)) {
            addSystemMessage(error.message || "Could not load message history.");
          }
        }
        connectSocket();
      } catch (error) {
        setHistoryLoading(false);
        if (chatHeaderEl) chatHeaderEl.classList.remove("is-loading");
        if (isNetworkError(error)) {
          markApiOffline(networkErrorMessage(error));
        } else if (!isConnectionNoise(error.message)) {
          addSystemMessage(error.message || "Could not open this room.");
        }
      }
    }

    async function connectSocket(isReconnect = false) {
      if (manualDisconnect || !token) {
        return;
      }
      if (!WS_BASE) {
        setStatus(false, "Messaging server is not configured.", "error");
        addSystemMessage("WS_BASE is missing from config.js, so live chat cannot connect.");
        return;
      }

      const gen = ++connectGen;
      disconnectSocket();
      setStatus(false, isReconnect ? reconnectStatusMessage() : "Connecting…", isReconnect ? "reconnecting" : "connecting");

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
        markApiOnline();
        setStatus(true);
        clearTypingIndicators();
        try {
          if (isReconnect) {
            clearOnlineUsers();
            await loadHistory({ replace: true });
          }
          reconcilePendingFromHistory();
          messagesListEl.querySelectorAll(".message-row.received").forEach(observeReceipts);
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
          setStatus(false, reconnectStatusMessage(), "reconnecting");
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

    if (messageEl) messageEl.addEventListener("input", () => {
      sendTypingSignal();
      syncComposeButtons();
      if (notifyPref("typingSound", true)) playUiCue("type");
    });

    let mediaRecorder = null;
    let voiceChunks = [];
    let voiceStream = null;
    let voiceBusy = false;

    function defaultMessagePlaceholder() {
      return "Type a message";
    }

    function syncComposeButtons() {
      const hasText = Boolean(messageEl && messageEl.value.trim());
      const recording = Boolean(voiceBtn && voiceBtn.classList.contains("recording"));
      if (recording || voiceBusy) {
        if (voiceBtn) voiceBtn.hidden = false;
        if (sendEl) sendEl.hidden = true;
        return;
      }
      if (sendEl) sendEl.hidden = !hasText;
      if (voiceBtn) voiceBtn.hidden = hasText;
    }

    function resetMessagePlaceholder() {
      if (!messageEl) return;
      messageEl.classList.remove("voice-hint-error");
      messageEl.placeholder = defaultMessagePlaceholder();
    }

    function showVoiceHint(text, isError = false) {
      if (!messageEl) return;
      messageEl.classList.toggle("voice-hint-error", isError);
      messageEl.placeholder = text;
    }

    function setVoiceRecording(active) {
      if (!voiceBtn) return;
      const was = voiceBtn.classList.contains("recording");
      voiceBtn.classList.toggle("recording", active);
      voiceBtn.disabled = voiceBusy && !active;
      voiceBtn.setAttribute("aria-pressed", active ? "true" : "false");
      voiceBtn.setAttribute("aria-label", active ? "Stop recording" : "Record voice message");
      if (active && !was) {
        playUiCue("rec-start");
        if (notifyPref("vibrate", true) && navigator.vibrate) navigator.vibrate(30);
      } else if (!active && was) {
        playUiCue("rec-stop");
      }
      syncComposeButtons();
    }

    function releaseMicStream() {
      if (voiceStream) {
        voiceStream.getTracks().forEach((track) => track.stop());
        voiceStream = null;
      }
    }

    function floatTo16BitPCM(input) {
      const output = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return output;
    }

    function downsample(buffer, fromRate, toRate) {
      if (fromRate === toRate) return buffer;
      const ratio = fromRate / toRate;
      const length = Math.round(buffer.length / ratio);
      const result = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j++) sum += buffer[j];
        result[i] = end > start ? sum / (end - start) : 0;
      }
      return result;
    }

    function encodeWav(samples, sampleRate) {
      const bytesPerSample = 2;
      const blockAlign = bytesPerSample;
      const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
      const view = new DataView(buffer);
      const writeString = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
      };
      writeString(0, "RIFF");
      view.setUint32(4, 36 + samples.length * bytesPerSample, true);
      writeString(8, "WAVE");
      writeString(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, 16, true);
      writeString(36, "data");
      view.setUint32(40, samples.length * bytesPerSample, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++, offset += 2) {
        view.setInt16(offset, samples[i], true);
      }
      return new Blob([view], { type: "audio/wav" });
    }

    async function recordingToWav(blob) {
      const audioContext = new AudioContext();
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer);
        const source = decoded.getChannelData(0);
        const targetRate = 16000;
        const downsampled = downsample(source, decoded.sampleRate, targetRate);
        return encodeWav(floatTo16BitPCM(downsampled), targetRate);
      } finally {
        await audioContext.close().catch(() => {});
      }
    }

    async function uploadVoiceRecording(blob) {
      if (!API_BASE || !token) {
        showVoiceHint("Sign in again to use voice input.", true);
        return;
      }

      voiceBusy = true;
      if (voiceBtn) voiceBtn.disabled = true;
      showVoiceHint("Transcribing…");

      try {
        const wav = await recordingToWav(blob);
        const formData = new FormData();
        formData.append("file", wav, "voice.wav");
        const language = encodeURIComponent(navigator.language || "en-US");
        const response = await fetch(`${API_BASE}/transcribe?language=${language}`, {
          method: "POST",
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
          timeoutMs: 60000,
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
          showAuth();
          return;
        }
        if (!response.ok) {
          showVoiceHint(formatError(data.detail) || "Voice transcription failed.", true);
          return;
        }
        if (messageEl && data.text) {
          const prefix = messageEl.value.trim();
          messageEl.value = prefix ? `${prefix} ${data.text}`.trim() : data.text;
          messageEl.focus();
          messageEl.dispatchEvent(new Event("input"));
        }
        resetMessagePlaceholder();
      } catch (error) {
        showVoiceHint(networkErrorMessage(error) || "Could not transcribe voice.", true);
      } finally {
        voiceBusy = false;
        if (voiceBtn) voiceBtn.disabled = false;
        setVoiceRecording(false);
      }
    }

    function stopVoiceRecording() {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
      }
      releaseMicStream();
      setVoiceRecording(false);
    }

    async function toggleVoiceRecording() {
      if (!voiceBtn || voiceBusy) return;

      if (mediaRecorder && mediaRecorder.state === "recording") {
        showVoiceHint("Transcribing…");
        mediaRecorder.stop();
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        showVoiceHint("This browser does not support microphone recording.", true);
        return;
      }

      try {
        voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        showVoiceHint("Microphone access was denied.", true);
        return;
      }

      voiceChunks = [];
      const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = preferredTypes.find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
      mediaRecorder = mimeType ? new MediaRecorder(voiceStream, { mimeType }) : new MediaRecorder(voiceStream);

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) voiceChunks.push(event.data);
      });

      mediaRecorder.addEventListener("stop", () => {
        releaseMicStream();
        setVoiceRecording(false);
        if (!voiceChunks.length) {
          showVoiceHint("No audio captured — try again.", true);
          return;
        }
        const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        voiceChunks = [];
        uploadVoiceRecording(blob);
      });

      mediaRecorder.start();
      setVoiceRecording(true);
      showVoiceHint("Listening… tap mic to stop");
    }

    if (voiceBtn) {
      voiceBtn.addEventListener("click", () => {
        toggleVoiceRecording().catch(() => {
          voiceBusy = false;
          setVoiceRecording(false);
          releaseMicStream();
          showVoiceHint("Could not start voice recording.", true);
        });
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        stopVoiceRecording();
        return;
      }
      if (apiOffline) {
        attemptRecovery().catch(() => {});
      }
      if (!messagesListEl) return;
      messagesListEl.querySelectorAll(".message-row.received").forEach(observeReceipts);
      flushDelivered();
      flushViewed();
      markRoomRead();
    });

    window.addEventListener("online", () => {
      if (apiOffline || (socket && socket.readyState !== WebSocket.OPEN)) {
        attemptRecovery().catch(() => {});
        if (!reconnectLoopTimer && !manualDisconnect) {
          beginReconnect();
        }
      }
    });

    document.addEventListener("pointerdown", unlockNotifyAudio);
    document.addEventListener("keydown", unlockNotifyAudio);
    document.addEventListener("touchend", unlockNotifyAudio, { passive: true });
    if (messageEl) messageEl.addEventListener("focus", unlockNotifyAudio);
    if (chatForm) chatForm.addEventListener("submit", unlockNotifyAudio);

    if (messagesEl) {
      messagesEl.addEventListener("scroll", onMessagesScroll, { passive: true });
    }

    if (scrollBottomBtn) {
      scrollBottomBtn.addEventListener("click", () => {
        queueScrollToBottom({ smooth: true, force: true });
      });
    }

    if (window.visualViewport && messagesEl) {
      window.visualViewport.addEventListener("resize", () => {
        if (stickToBottom) queueScrollToBottom({ smooth: false, force: true });
      });
    }

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
      syncComposeButtons();
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

    if (window.ChatCall) {
      window.ChatCall.init({
        getSocket: () => socket,
        getUsername: () => username,
        getGroupId: () => groupId,
        getPeer: () => currentPeer,
        getPeerOnline: () => Boolean(peerOnline),
        getToken: () => token,
        getApiBase: () => API_BASE,
      });
    }

    if (token && username) {
      syncComposeButtons();
      showChat().catch((error) => {
        if (isNetworkError(error)) {
          markApiOffline(networkErrorMessage(error));
        } else if (!isConnectionNoise(error.message)) {
          addSystemMessage(error.message || "Could not start chat.");
        }
      });
      refreshAdminFlag();
    } else {
      window.location.replace("/auth/login?next=" + encodeURIComponent("/console/chat"));
    }
})();
