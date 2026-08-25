(function (global) {
  "use strict";

  const CALL_TYPES = {
    invite: "call_invite",
    accept: "call_accept",
    reject: "call_reject",
    hangup: "call_hangup",
    offer: "call_offer",
    answer: "call_answer",
    ice: "call_ice",
    sfuOffer: "call_sfu_offer",
  };

  const state = {
    opts: null,
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    mode: "p2p",
    callId: null,
    media: "video",
    role: null,
    localStream: null,
    peers: new Map(),
    incoming: null,
    connected: false,
    sfuPc: null,
    host: null,
    bound: false,
    pollTimer: null,
    polling: false,
    groupId: null,
    pendingAccept: null,
  };

  const CALL_RING_TIMEOUT_MS = 40000;
  let ringTimeoutTimer = null;

  function el(id) {
    return document.getElementById(id);
  }

  function ensureOverlay() {
    if (el("call-overlay")) return;
    const root = document.createElement("div");
    root.id = "call-overlay";
    root.className = "call-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div id="call-ring" class="call-ring" hidden>
        <div class="call-ring-shell">
          <div class="call-ring-glow" aria-hidden="true"></div>
          <div class="call-ring-avatar-wrap">
            <div id="call-ring-avatar" class="call-ring-avatar">?</div>
          </div>
          <span id="call-ring-label" class="call-ring-label">Call</span>
          <h2 id="call-ring-name">Calling...</h2>
          <p id="call-ring-status">Ringing</p>
          <div class="call-ring-actions">
            <button id="call-reject" class="call-btn call-btn-reject" type="button" aria-label="Decline call">
              <span class="call-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.89.33 1.76.62 2.59a2 2 0 0 1-.45 2.11L8 9.72a16 16 0 0 0 6.28 6.28l1.3-1.28a2 2 0 0 1 2.11-.45c.83.29 1.7.5 2.59.62A2 2 0 0 1 22 16.92Z"/><path d="m15 9 6-6"/><path d="m21 9-6-6"/></svg>
              </span>
              <span>Decline</span>
            </button>
            <button id="call-cancel" class="call-btn call-btn-reject" type="button" aria-label="Cancel call" hidden>
              <span class="call-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.89.33 1.76.62 2.59a2 2 0 0 1-.45 2.11L8 9.72a16 16 0 0 0 6.28 6.28l1.3-1.28a2 2 0 0 1 2.11-.45c.83.29 1.7.5 2.59.62A2 2 0 0 1 22 16.92Z"/><path d="m15 9 6-6"/><path d="m21 9-6-6"/></svg>
              </span>
              <span>Cancel</span>
            </button>
            <button id="call-accept" class="call-btn call-btn-accept" type="button" aria-label="Accept call">
              <span class="call-btn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.89.33 1.76.62 2.59a2 2 0 0 1-.45 2.11L8 9.72a16 16 0 0 0 6.28 6.28l1.3-1.28a2 2 0 0 1 2.11-.45c.83.29 1.7.5 2.59.62A2 2 0 0 1 22 16.92Z"/></svg>
              </span>
              <span>Accept</span>
            </button>
          </div>
        </div>
      </div>
      <div id="call-active" class="call-active" hidden>
        <div id="call-remotes" class="call-remotes"></div>
        <video id="call-local" class="call-local" autoplay playsinline muted hidden></video>
        <div class="call-active-meta">
          <strong id="call-title">Call</strong>
          <span id="call-status">Connecting…</span>
        </div>
        <div class="call-controls">
          <button id="call-mute" class="call-ctrl" type="button" aria-label="Mute">
            <span class="call-ctrl-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>
            </span>
            <span>Mic</span>
          </button>
          <button id="call-camera" class="call-ctrl" type="button" aria-label="Camera">
            <span class="call-ctrl-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5 3V8l-5 3Z"/><rect x="3" y="6" width="13" height="12" rx="2"/></svg>
            </span>
            <span>Cam</span>
          </button>
          <button id="call-hangup" class="call-ctrl call-ctrl-end" type="button" aria-label="End call">
            <span class="call-ctrl-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.89.33 1.76.62 2.59a2 2 0 0 1-.45 2.11L8 9.72a16 16 0 0 0 6.28 6.28l1.3-1.28a2 2 0 0 1 2.11-.45c.83.29 1.7.5 2.59.62A2 2 0 0 1 22 16.92Z"/><path d="m15 9 6-6"/><path d="m21 9-6-6"/></svg>
            </span>
            <span>End</span>
          </button>
        </div>
      </div>`;
    document.body.appendChild(root);
    if (!document.querySelector('link[href*="chat.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/assets/chat.css?v=layout";
      document.head.appendChild(link);
    }
  }

  function postSignal(payload) {
    const gid = Number(payload.group_id || activeGroupId()) || 0;
    const body = Object.assign({}, payload, { group_id: gid });
    const base = apiBase();
    const auth = token();
    if (!base || !auth) return Promise.resolve({ ok: false, data: {} });
    if (!body.group_id && body.type !== CALL_TYPES.reject && body.type !== CALL_TYPES.hangup) {
      return Promise.resolve({ ok: false, data: {} });
    }
    return fetch(`${base}/webrtc/signal`, {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 8000,
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { ok: response.ok, data: data || {} };
        });
      })
      .then(function (result) {
        return result;
      })
      .catch(function () {
        return { ok: false, data: {} };
      });
  }

  function send(payload) {
    return postSignal(payload).then(function (result) {
      return Boolean(result && result.ok);
    });
  }

  function username() {
    return (state.opts && state.opts.getUsername && state.opts.getUsername()) || "";
  }

  function groupId() {
    return (state.opts && state.opts.getGroupId && state.opts.getGroupId()) || 0;
  }

  function activeGroupId() {
    return Number(
      (state.incoming && state.incoming.group_id) || state.groupId || groupId() || 0
    ) || 0;
  }

  function peerName() {
    return (state.opts && state.opts.getPeer && state.opts.getPeer()) || "";
  }

  function token() {
    return (state.opts && state.opts.getToken && state.opts.getToken()) || "";
  }

  function apiBase() {
    return (state.opts && state.opts.getApiBase && state.opts.getApiBase()) || "";
  }

  function setCallButtonsEnabled(enabled) {
    ["video-call-btn", "audio-call-btn"].forEach((id) => {
      const btn = el(id);
      if (btn) btn.disabled = !enabled;
    });
  }

  function show(node, visible) {
    if (!node) return;
    node.hidden = !visible;
  }

  function setStatusText(text) {
    const status = el("call-status");
    if (status) status.textContent = text || "";
  }

  function clearRingTimeout() {
    if (ringTimeoutTimer) {
      clearTimeout(ringTimeoutTimer);
      ringTimeoutTimer = null;
    }
  }

  function armRingTimeout(callId) {
    clearRingTimeout();
    const id = callId || state.callId || (state.incoming && state.incoming.call_id);
    ringTimeoutTimer = setTimeout(function () {
      ringTimeoutTimer = null;
      const ring = el("call-ring");
      if (!ring || ring.hidden) return;
      const sameOutgoing = state.role === "caller" && state.callId && state.callId === id;
      const sameIncoming = state.incoming && state.incoming.call_id === id;
      if (!sameOutgoing && !sameIncoming) return;
      const status = el("call-ring-status");
      if (status) status.textContent = "No answer";
      if (sameIncoming) rejectIncoming();
      else hangup();
    }, CALL_RING_TIMEOUT_MS);
  }

  function setOverlay(open, kind) {
    const overlay = el("call-overlay");
    if (!overlay) return;
    if (open) document.body.appendChild(overlay);
    overlay.hidden = !open;
    overlay.dataset.kind = kind || "";
    document.body.classList.toggle("in-call", Boolean(open));
    flashTitle(open && kind === "incoming");
  }

  let titleTimer = null;
  let originalTitle = "";

  function flashTitle(on) {
    if (titleTimer) {
      clearInterval(titleTimer);
      titleTimer = null;
    }
    if (!on) {
      if (originalTitle) document.title = originalTitle;
      originalTitle = "";
      return;
    }
    originalTitle = document.title || "Chat";
    let tick = false;
    titleTimer = setInterval(() => {
      document.title = tick ? originalTitle : "Incoming call";
      tick = !tick;
    }, 900);
    document.title = "Incoming call";
  }

  function initialFor(name) {
    return String(name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  let audioCtx = null;
  let ringtoneTimer = null;
  let ringtoneNodes = [];
  let vibrateTimer = null;

  function getAudioCtx() {
    const Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function unlockAudio() {
    getAudioCtx();
  }

  function stopRingtone() {
    if (ringtoneTimer) {
      clearTimeout(ringtoneTimer);
      ringtoneTimer = null;
    }
    if (vibrateTimer) {
      clearInterval(vibrateTimer);
      vibrateTimer = null;
    }
    ringtoneNodes.forEach((node) => {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    });
    ringtoneNodes = [];
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function playTonePair(ctx, freqs, duration, gainValue) {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.02);
    gain.gain.setValueAtTime(gainValue, now + duration - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    gain.connect(ctx.destination);
    freqs.forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + duration);
      ringtoneNodes.push(osc);
    });
    ringtoneNodes.push(gain);
  }

  function startRingtone(kind) {
    stopRingtone();
    if (global.chatNotify && typeof global.chatNotify.enabled === "function" && !global.chatNotify.enabled("callSound")) {
      if (kind === "in" && global.chatNotify.enabled("vibrate") && navigator.vibrate) {
        navigator.vibrate([180, 80, 180]);
      }
      return;
    }
    const ctx = getAudioCtx();
    if (!ctx) return;

    if (kind === "in") {
      const burst = () => {
        if (!ctx) return;
        playTonePair(ctx, [520, 660], 0.22, 0.12);
        ringtoneTimer = setTimeout(() => {
          playTonePair(ctx, [520, 660], 0.22, 0.12);
          ringtoneTimer = setTimeout(burst, 1400);
        }, 280);
      };
      burst();
      if (navigator.vibrate) {
        navigator.vibrate([180, 80, 180, 80, 180, 900]);
        vibrateTimer = setInterval(() => {
          navigator.vibrate([180, 80, 180, 80, 180, 900]);
        }, 1600);
      }
      return;
    }

    const ringback = () => {
      playTonePair(ctx, [440, 480], 1.1, 0.08);
      ringtoneTimer = setTimeout(ringback, 3000);
    };
    ringback();
  }

  function showRing(kind, name, status, playSound) {
    ensureOverlay();
    const ring = el("call-ring");
    const ringName = el("call-ring-name");
    const ringStatus = el("call-ring-status");
    const ringLabel = el("call-ring-label");
    const avatar = el("call-ring-avatar");
    if (ringLabel) ringLabel.textContent = kind === "in" ? "Incoming call" : "Outgoing call";
    if (ringName) ringName.textContent = name || "Call";
    if (ringStatus) ringStatus.textContent = status || "";
    if (avatar) avatar.textContent = initialFor(name);
    if (ring) ring.classList.toggle("is-ringing", kind === "out" && /ringing/i.test(String(status || "")));
    show(ring, true);
    show(el("call-active"), false);
    show(el("call-accept"), kind === "in");
    show(el("call-reject"), kind === "in");
    show(el("call-cancel"), kind === "out");
    setOverlay(true, kind === "in" ? "incoming" : "outgoing");
    if (playSound !== false) startRingtone(kind === "in" ? "in" : "out");
  }

  function showLive(name, status) {
    ensureOverlay();
    clearRingTimeout();
    stopRingtone();
    const title = el("call-title");
    if (title) title.textContent = name || "Call";
    setStatusText(status || "Connecting…");
    show(el("call-ring"), false);
    show(el("call-active"), true);
    setOverlay(true, "active");
  }

  function attachLocalVideo() {
    const video = el("call-local");
    if (!video || !state.localStream) return;
    video.srcObject = state.localStream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    video.hidden = state.media !== "video";
  }

  function remoteContainer() {
    return el("call-remotes");
  }

  function ensureRemoteVideo(peer) {
    const wrap = remoteContainer();
    if (!wrap) return null;
    let node = wrap.querySelector(`[data-peer="${CSS.escape(peer)}"]`);
    if (node) return node.querySelector("video");
    node = document.createElement("div");
    node.className = "call-remote";
    node.dataset.peer = peer;
    node.innerHTML = `<video autoplay playsinline></video><span class="call-remote-name">${escapeHtml(peer)}</span>`;
    wrap.appendChild(node);
    wrap.classList.add("has-remotes");
    return node.querySelector("video");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clearRemotes() {
    const wrap = remoteContainer();
    if (wrap) {
      wrap.innerHTML = "";
      wrap.classList.remove("has-remotes");
    }
  }

  async function loadIce() {
    const base = apiBase();
    const auth = token();
    if (!base || !auth) return;
    try {
      const response = await fetch(`${base}/webrtc/ice`, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        state.iceServers = data.iceServers;
      }
      if (data.mode === "sfu" && data.sfu) state.mode = "sfu";
      else state.mode = "p2p";
    } catch {
      state.mode = "p2p";
    }
  }

  async function getLocalStream(media) {
    const constraints = {
      audio: true,
      video: media === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function closePeer(peer) {
    const entry = state.peers.get(peer);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {
      // Ignore.
    }
    state.peers.delete(peer);
    const wrap = remoteContainer();
    const node = wrap && wrap.querySelector(`[data-peer="${CSS.escape(peer)}"]`);
    if (node) node.remove();
    if (wrap && !wrap.querySelector(".call-remote")) wrap.classList.remove("has-remotes");
  }

  function closeAllPeers() {
    for (const peer of [...state.peers.keys()]) closePeer(peer);
    if (state.sfuPc) {
      try {
        state.sfuPc.close();
      } catch {
        // Ignore.
      }
      state.sfuPc = null;
    }
  }

  function stopLocal() {
    if (!state.localStream) return;
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    const video = el("call-local");
    if (video) video.srcObject = null;
  }

  async function resetCall() {
    const callId = state.callId;
    closeAllPeers();
    stopLocal();
    if (state.mode === "sfu" && callId && apiBase() && token()) {
      fetch(`${apiBase()}/webrtc/sfu/${encodeURIComponent(callId)}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}` },
      }).catch(() => {});
    }
    state.callId = null;
    state.role = null;
    state.incoming = null;
    state.host = null;
    state.groupId = null;
    state.media = "video";
    clearRingTimeout();
    stopRingtone();
    clearRemotes();
    const ring = el("call-ring");
    if (ring) ring.classList.remove("is-ringing");
    setOverlay(false);
    show(el("call-ring"), false);
    show(el("call-active"), false);
    setCallButtonsEnabled(true);
  }

  function createPeerConnection(peer) {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    const entry = { pc, makingOffer: false, ignoreOffer: false, polite: username() < peer };
    state.peers.set(peer, entry);

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !state.callId) return;
      send({
        type: CALL_TYPES.ice,
        call_id: state.callId,
        to: peer,
        candidate: event.candidate.toJSON(),
      });
    };

    pc.ontrack = (event) => {
      const video = ensureRemoteVideo(peer);
      if (video) {
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setStatusText("Reconnecting…");
      }
      if (pc.connectionState === "connected") setStatusText("Connected");
    };

    return entry;
  }

  async function negotiateOffer(peer) {
    const entry = state.peers.get(peer) || createPeerConnection(peer);
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      send({
        type: CALL_TYPES.offer,
        call_id: state.callId,
        to: peer,
        sdp: entry.pc.localDescription.sdp,
      });
    } finally {
      entry.makingOffer = false;
    }
  }

  async function handleOffer(from, sdp) {
    const entry = state.peers.get(from) || createPeerConnection(from);
    const offerCollision = entry.makingOffer || entry.pc.signalingState !== "stable";
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;
    await entry.pc.setRemoteDescription({ type: "offer", sdp });
    if (state.localStream) {
      const senders = entry.pc.getSenders().map((item) => item.track && item.track.kind);
      state.localStream.getTracks().forEach((track) => {
        if (!senders.includes(track.kind)) entry.pc.addTrack(track, state.localStream);
      });
    }
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    send({
      type: CALL_TYPES.answer,
      call_id: state.callId,
      to: from,
      sdp: entry.pc.localDescription.sdp,
    });
  }

  async function handleAnswer(from, sdp) {
    const entry = state.peers.get(from);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: "answer", sdp });
  }

  async function handleIce(from, candidate) {
    const entry = state.peers.get(from);
    if (!entry || !candidate) return;
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // Candidate may arrive before remote description.
    }
  }

  async function waitIceComplete(pc) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2500);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  async function joinSfu() {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.sfuPc = pc;
    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
    }
    pc.ontrack = (event) => {
      const peer = event.streams[0] && event.streams[0].id ? event.streams[0].id : "remote";
      const video = ensureRemoteVideo(peer);
      if (video) {
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.play().catch(() => {});
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    const response = await fetch(`${apiBase()}/webrtc/sfu/${encodeURIComponent(state.callId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        group_id: groupId(),
        media: state.media,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "SFU join failed");
    await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
  }

  async function handleSfuOffer(sdp) {
    if (!state.sfuPc || !sdp) return;
    await state.sfuPc.setRemoteDescription({ type: "offer", sdp });
    const answer = await state.sfuPc.createAnswer();
    await state.sfuPc.setLocalDescription(answer);
    await waitIceComplete(state.sfuPc);
    await fetch(`${apiBase()}/webrtc/sfu/${encodeURIComponent(state.callId)}/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sdp: state.sfuPc.localDescription.sdp }),
    });
  }

  async function isCalleeOnline() {
    if (state.opts && typeof state.opts.getPeerOnline === "function" && state.opts.getPeerOnline()) {
      return true;
    }
    const peer = peerName();
    if (!peer) return true;
    const base = apiBase();
    const gid = groupId();
    const auth = token();
    if (!base || !gid || !auth) return false;
    try {
      const response = await fetch(`${base}/groups/${gid}`, {
        headers: { Authorization: `Bearer ${auth}` },
        timeoutMs: 4000,
      });
      if (!response.ok) return false;
      const group = await response.json();
      if (group.is_direct) return Boolean(group.online);
      return true;
    } catch {
      return false;
    }
  }

  async function startCall(media) {
    if (state.callId || state.incoming) return;
    ensureOverlay();
    state.media = media;
    state.role = "caller";
    state.host = username();
    state.callId = global.crypto?.randomUUID ? crypto.randomUUID() : `call-${Date.now()}`;
    state.groupId = groupId();
    const name = peerName() || "Group call";
    showRing("out", name, "Calling...", false);
    setCallButtonsEnabled(false);
    armRingTimeout(state.callId);
    const online = await isCalleeOnline();
    if (!state.callId || state.role !== "caller") return;
    const ring = el("call-ring");
    const ringStatus = el("call-ring-status");
    if (online) {
      if (ringStatus) ringStatus.textContent = "Ringing";
      if (ring) ring.classList.add("is-ringing");
      startRingtone("out");
    } else if (ringStatus) {
      ringStatus.textContent = "They're not online";
      if (ring) ring.classList.remove("is-ringing");
    }
    const result = await postSignal({
      type: CALL_TYPES.invite,
      call_id: state.callId,
      media,
      to: peerName() || undefined,
    });
    if (result.data && result.data.busy) {
      if (ringStatus) ringStatus.textContent = "Busy";
      if (ring) ring.classList.remove("is-ringing");
      stopRingtone();
      clearRingTimeout();
      const endedId = state.callId;
      setTimeout(function () {
        if (state.callId === endedId) resetCall();
      }, 1600);
      return;
    }
    if (!result.ok) {
      if (ringStatus) ringStatus.textContent = "Could not reach them. Try again.";
      if (ring) ring.classList.remove("is-ringing");
      stopRingtone();
      return;
    }
    try {
      state.localStream = await getLocalStream(media);
      attachLocalVideo();
    } catch {
      const status = el("call-ring-status");
      if (status) status.textContent = "Allow camera and microphone when they pick up.";
    }
  }

  async function acceptIncoming() {
    const invite = state.incoming;
    if (!invite) return;
    const current = Number(groupId() || 0);
    const target = Number(invite.group_id || 0);
    if (target && current !== target) {
      sessionStorage.setItem(
        "dc_join_call",
        JSON.stringify(Object.assign({}, invite, { autoAccept: true }))
      );
      global.location.href = "/console/chat?group=" + encodeURIComponent(target);
      return;
    }
    if (!state.localStream) {
      try {
        state.localStream = await getLocalStream(invite.media || "video");
      } catch {
        const status = el("call-ring-status");
        if (status) status.textContent = "Allow camera and microphone to join.";
        return;
      }
    }
    state.callId = invite.call_id;
    state.media = invite.media || "video";
    state.role = "callee";
    state.host = invite.from || null;
    state.groupId = invite.group_id || groupId();
    state.incoming = null;
    attachLocalVideo();
    showLive(invite.from || "Call", "Connecting…");
    send({ type: CALL_TYPES.accept, call_id: state.callId, to: invite.from, group_id: invite.group_id });
    if (state.mode === "sfu") {
      try {
        await joinSfu();
        setStatusText("Connected");
      } catch (error) {
        setStatusText(error.message || "Could not join the call.");
      }
    }
    setCallButtonsEnabled(false);
  }

  function takePendingJoin() {
    try {
      const pending = sessionStorage.getItem("dc_join_call");
      if (!pending) return;
      sessionStorage.removeItem("dc_join_call");
      const data = JSON.parse(pending);
      const auto = Boolean(data.autoAccept);
      delete data.autoAccept;
      if (!data || data.type !== CALL_TYPES.invite) return;
      if (auto) {
        state.incoming = data;
        showRing("in", data.from || "Someone", "Connecting…");
        if (state.connected) {
          acceptIncoming().catch(() => {});
        } else {
          state.pendingAccept = data;
        }
      } else {
        handle(data);
      }
    } catch {
      // Ignore bad pending-call payloads.
    }
  }

  function rejectIncoming() {
    clearRingTimeout();
    const invite = state.incoming;
    if (invite) {
      send({ type: CALL_TYPES.reject, call_id: invite.call_id, to: invite.from, group_id: invite.group_id });
    }
    state.incoming = null;
    stopRingtone();
    setOverlay(false);
    show(el("call-ring"), false);
  }

  function hangup() {
    if (state.callId) {
      const isGroup = !peerName();
      send({
        type: CALL_TYPES.hangup,
        call_id: state.callId,
        to: peerName() || undefined,
        scope: isGroup && state.role === "caller" ? "all" : "leave",
      });
    }
    resetCall();
  }

  function mineWinsGlare(theirCallId) {
    return String(state.callId || "") <= String(theirCallId || "");
  }

  function yieldToInvite(invite) {
    const oldId = state.callId;
    const peer = invite.from;
    if (oldId) {
      send({ type: CALL_TYPES.hangup, call_id: oldId, to: peer, group_id: invite.group_id });
    }
    state.callId = null;
    state.role = null;
    state.incoming = invite;
    state.groupId = invite.group_id || state.groupId;
    const status = el("call-ring-status");
      if (status) status.textContent = "Connecting...";
    acceptIncoming().catch(() => {});
  }

  function resolveSimultaneousInvite(invite) {
    if (!invite || !invite.call_id) return true;
    if (invite.call_id === state.callId) return true;
    if (mineWinsGlare(invite.call_id)) {
      const status = el("call-ring-status");
      if (status) status.textContent = "Connecting...";
      return true;
    }
    yieldToInvite(invite);
    return true;
  }

  function dismissIncoming(data) {
    const callId = data && data.call_id ? data.call_id : data;
    if (!state.incoming || state.incoming.call_id !== callId) return false;
    if (data && data.from && state.incoming.from && data.from !== state.incoming.from && !data.to) return false;
    state.incoming = null;
    stopRingtone();
    setOverlay(false);
    show(el("call-ring"), false);
    return true;
  }

  function isDirectCall() {
    return Boolean(peerName());
  }

  function handleRemoteReject(data) {
    if (!data || (data.to && data.to !== username())) return;
    if (dismissIncoming(data)) return;
    if (!state.callId || data.call_id !== state.callId) return;
    if (isDirectCall()) {
      resetCall();
      return;
    }
    const status = el("call-ring-status");
    if (state.role === "caller" && status && data.from) {
      status.textContent = `${data.from} declined`;
    }
    if (data.from) closePeer(data.from);
    if (state.peers.size) setStatusText("Connected");
  }

  function handleRemoteHangup(data) {
    if (!data || (data.to && data.to !== username())) return;
    if (dismissIncoming(data)) return;
    if (!state.callId || data.call_id !== state.callId) return;
    if (isDirectCall()) {
      resetCall();
      return;
    }
    const from = data.from || "";
    if (from && from === state.host && state.role !== "caller") {
      resetCall();
      return;
    }
    if (from) closePeer(from);
    setStatusText(state.peers.size || state.sfuPc ? "Connected" : "Waiting for others...");
  }

  function toggleMute() {
    if (!state.localStream) return;
    const audio = state.localStream.getAudioTracks()[0];
    if (!audio) return;
    audio.enabled = !audio.enabled;
    el("call-mute")?.classList.toggle("is-off", !audio.enabled);
  }

  function toggleCamera() {
    if (!state.localStream) return;
    const video = state.localStream.getVideoTracks()[0];
    if (!video) return;
    video.enabled = !video.enabled;
    el("call-camera")?.classList.toggle("is-off", !video.enabled);
  }

  async function onAcceptFrom(from) {
    if (!state.callId || from === username()) return;
    if (!state.localStream) {
      try {
        state.localStream = await getLocalStream(state.media);
        attachLocalVideo();
      } catch {
        setStatusText("Allow camera and microphone to connect.");
        return;
      }
    }
    setStatusText("Connecting…");
    showLive(from, "Connecting…");
    if (state.mode === "sfu") {
      if (state.sfuPc) return;
      try {
        await joinSfu();
        setStatusText("Connected");
      } catch (error) {
        setStatusText(error.message || "Could not start media.");
      }
      return;
    }
    await negotiateOffer(from);
  }

  function handle(data) {
    if (!data || !data.type) return false;
    if (!String(data.type).startsWith("call_")) return false;
    if (data.to && data.to !== username() && data.type !== CALL_TYPES.hangup) {
      return true;
    }
    if (data.from === username() && data.type !== CALL_TYPES.sfuOffer) return true;

    if (data.type === CALL_TYPES.invite) {
      if (state.incoming && state.incoming.call_id === data.call_id) return true;
      if (state.callId && state.role === "caller") {
        return resolveSimultaneousInvite(data);
      }
      if (state.callId) {
        send({ type: CALL_TYPES.reject, call_id: data.call_id, to: data.from, group_id: data.group_id });
        return true;
      }
      state.incoming = data;
      showRing(
        "in",
        data.from || "Someone",
        data.media === "audio" ? "Incoming voice call" : "Incoming video call"
      );
      armRingTimeout(data.call_id);
      return true;
    }

    if (data.type === CALL_TYPES.accept) {
      if (data.call_id && state.callId && data.call_id !== state.callId) return true;
      onAcceptFrom(data.from);
      return true;
    }

    if (data.type === CALL_TYPES.reject) {
      handleRemoteReject(data);
      return true;
    }
    if (data.type === CALL_TYPES.hangup) {
      handleRemoteHangup(data);
      return true;
    }

    if (data.type === CALL_TYPES.offer && data.sdp) {
      handleOffer(data.from, data.sdp);
      return true;
    }
    if (data.type === CALL_TYPES.answer && data.sdp) {
      handleAnswer(data.from, data.sdp);
      return true;
    }
    if (data.type === CALL_TYPES.ice) {
      handleIce(data.from, data.candidate);
      return true;
    }
    if (data.type === CALL_TYPES.sfuOffer && data.sdp) {
      handleSfuOffer(data.sdp);
      return true;
    }
    return true;
  }

  function onPeerOffline(name) {
    if (!state.callId || !name) return;
    closePeer(name);
  }

  async function pollInbox() {
    const base = apiBase();
    const auth = token();
    if (!base || !auth || state.incoming || state.polling) return;
    if (state.callId && state.role !== "caller") return;
    state.polling = true;
    try {
      const response = await fetch(`${base}/webrtc/inbox`, {
        headers: { Authorization: `Bearer ${auth}` },
        timeoutMs: 4000,
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.invite && data.invite.type === CALL_TYPES.invite) {
        handle(data.invite);
      }
    } catch {
      // Keep polling quietly.
    } finally {
      state.polling = false;
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    ensureOverlay();
    const unlock = () => unlockAudio();
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    el("video-call-btn")?.addEventListener("click", () => startCall("video"));
    el("audio-call-btn")?.addEventListener("click", () => startCall("audio"));
    el("call-accept")?.addEventListener("click", () => acceptIncoming().catch(() => {}));
    el("call-reject")?.addEventListener("click", rejectIncoming);
    el("call-cancel")?.addEventListener("click", hangup);
    el("call-hangup")?.addEventListener("click", hangup);
    el("call-mute")?.addEventListener("click", toggleMute);
    el("call-camera")?.addEventListener("click", toggleCamera);
  }

  global.ChatCall = {
    init(opts) {
      state.opts = Object.assign(state.opts || {}, opts || {});
      bind();
      loadIce();
      setCallButtonsEnabled(true);
      if (!state.pollTimer) {
        pollInbox();
        state.pollTimer = setInterval(pollInbox, 800);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) pollInbox();
        });
      }
      try {
        takePendingJoin();
      } catch {
        // Ignore bad pending-call payloads.
      }
    },
    handle,
    onPeerOffline,
    setConnected(connected) {
      state.connected = Boolean(connected);
      setCallButtonsEnabled(!state.callId && !state.incoming);
      if (connected && state.pendingAccept) {
        state.incoming = state.pendingAccept;
        state.pendingAccept = null;
        acceptIncoming().catch(() => {});
      }
    },
    hangup,
  };
})(window);
