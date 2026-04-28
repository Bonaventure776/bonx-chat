// public/app.js
// ═══════════════════════════════════════════════
// BONX CHAT — Frontend Logic
// ═══════════════════════════════════════════════

// ─────────────────────────────────────────────
// CONFIG
// Change this to your Render URL when deployed
// ─────────────────────────────────────────────
const SERVER_URL = window.location.origin;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let socket       = null;
let myUsername   = "";
let typingTimer  = null;
let isTyping     = false;
let mediaRecorder = null;
let audioChunks   = [];

// ─────────────────────────────────────────────
// DOM ELEMENTS
// ─────────────────────────────────────────────
const joinScreen    = document.getElementById("join-screen");
const chatApp       = document.getElementById("chat-app");
const usernameInput = document.getElementById("username-input");
const messagesArea  = document.getElementById("messages");
const messageInput  = document.getElementById("message-input");
const usersList     = document.getElementById("users-list");
const typingEl      = document.getElementById("typing-indicator");
const typingText    = document.getElementById("typing-text");
const onlineCount   = document.getElementById("online-count");
const myUsernameEl  = document.getElementById("my-username");
const voiceBtn      = document.getElementById("voice-btn");

// Allow pressing Enter to join
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinChat();
});

// ─────────────────────────────────────────────
// JOIN CHAT
// ─────────────────────────────────────────────
function joinChat() {
  const username = usernameInput.value.trim();

  if (!username || username.length < 2) {
    usernameInput.style.borderColor = "#e74c3c";
    usernameInput.placeholder = "Username must be at least 2 characters";
    return;
  }

  myUsername = username;

  // Connect socket
  socket = io(SERVER_URL);

  // Register all socket event listeners
  setupSocketListeners();

  // Tell server we're online
  socket.emit("user:join", myUsername);

  // Switch screens
  joinScreen.classList.add("hidden");
  chatApp.classList.remove("hidden");
  myUsernameEl.textContent = `@${myUsername}`;
  messageInput.focus();
}

// ─────────────────────────────────────────────
// SOCKET EVENT LISTENERS
// ─────────────────────────────────────────────
function setupSocketListeners() {

  // Load message history
  socket.on("messages:history", (msgs) => {
    messagesArea.innerHTML = "";
    msgs.forEach(renderMessage);
    scrollToBottom();
  });

  // New message arrives
  socket.on("message:new", (msg) => {
    renderMessage(msg);
    scrollToBottom();

    // Send seen receipt if we're looking at chat
    if (msg.senderId && msg.senderId !== socket.id && !document.hidden) {
      socket.emit("message:seen", { messageId: msg.id });
    }
  });

  // Our message was delivered
  socket.on("message:delivered", ({ messageId }) => {
    updateTick(messageId, "delivered");
  });

  // Our message was seen
  socket.on("message:seen-update", ({ messageId }) => {
    updateTick(messageId, "seen");
  });

  // Message deleted by sender
  socket.on("message:deleted", ({ messageId }) => {
    const bubble = document.querySelector(`[data-id="${messageId}"] .bubble`);
    if (bubble) {
      bubble.innerHTML = "<em>This message was deleted</em>";
      bubble.classList.add("deleted");
    }
  });

  // Typing indicator
  socket.on("typing:show", ({ username }) => {
    typingText.textContent = `${username} is typing`;
    typingEl.classList.remove("hidden");
    scrollToBottom();
  });

  socket.on("typing:hide", () => {
    typingEl.classList.add("hidden");
  });

  // Online users update
  socket.on("users:update", (users) => {
    renderUsersList(users);
    onlineCount.textContent = `${users.length} online`;
  });
}

// ─────────────────────────────────────────────
// RENDER A MESSAGE
// ─────────────────────────────────────────────
function renderMessage(msg) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("msg-wrapper");
  wrapper.setAttribute("data-id", msg.id);

  // System message
  if (msg.type === "system") {
    wrapper.innerHTML = `<div class="system-bubble">${escHtml(msg.text)}</div>`;
    messagesArea.appendChild(wrapper);
    return;
  }

  const isMe = msg.username === myUsername;
  wrapper.classList.add(isMe ? "outgoing" : "incoming");

  // Sender name (for incoming only)
  const senderHtml = !isMe
    ? `<div class="msg-sender">${escHtml(msg.username)}</div>`
    : "";

  // Message content
  const contentHtml = buildContentHtml(msg);

  // Timestamp
  const timeStr = formatTime(msg.timestamp);

  // Tick marks (outgoing only)
  const tickHtml = isMe
    ? `<span class="msg-ticks" id="tick-${msg.id}">✓</span>`
    : "";

  wrapper.innerHTML = `
    ${senderHtml}
    <div class="bubble ${msg.deleted ? "deleted" : ""}">
      ${contentHtml}
      <div class="msg-meta">
        <span class="msg-time">${timeStr}</span>
        ${tickHtml}
      </div>
    </div>
  `;

  // Long-press to delete own messages
  if (isMe) {
    let pressTimer;
    wrapper.addEventListener("mousedown", () => {
      pressTimer = setTimeout(() => confirmDelete(msg.id), 700);
    });
    wrapper.addEventListener("mouseup",   () => clearTimeout(pressTimer));
    wrapper.addEventListener("mouseleave",() => clearTimeout(pressTimer));
  }

  messagesArea.appendChild(wrapper);
}

// Build the HTML for message content based on type
function buildContentHtml(msg) {
  if (msg.deleted) return "<em>This message was deleted</em>";

  switch (msg.type) {
    case "image":
      return `
        <img
          class="chat-image"
          src="${msg.url}"
          alt="Image"
          onclick="openImage('${msg.url}')"
          loading="lazy"
        />
      `;

    case "video":
      return `
        <video class="chat-video" controls preload="metadata">
          <source src="${msg.url}" />
          Your browser does not support video.
        </video>
      `;

    case "voice":
      return `
        <div class="voice-player">
          🎤 <span class="voice-label">Voice message</span>
          <audio controls src="${msg.url}" preload="metadata"></audio>
        </div>
      `;

    default: // text
      return `<span>${escHtml(msg.text)}</span>`;
  }
}

// ─────────────────────────────────────────────
// SEND TEXT MESSAGE
// ─────────────────────────────────────────────
function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text || !socket) return;

  socket.emit("message:send", {
    text,
    messageType: "text"
  });

  messageInput.value = "";
  stopTypingSignal();
}

// ─────────────────────────────────────────────
// HANDLE TYPING INDICATOR
// ─────────────────────────────────────────────
function handleInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
}

function handleTyping() {
  if (!socket) return;

  if (!isTyping) {
    isTyping = true;
    socket.emit("typing:start");
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTypingSignal, 1500);
}

function stopTypingSignal() {
  if (isTyping) {
    isTyping = false;
    socket?.emit("typing:stop");
  }
  clearTimeout(typingTimer);
}

// ─────────────────────────────────────────────
// FILE UPLOAD (Image / Video)
// ─────────────────────────────────────────────
async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file || !socket) return;

  // Reset input so same file can be selected again
  event.target.value = "";

  showToast(`⬆ Uploading ${file.name}…`);

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res  = await fetch(`${SERVER_URL}/upload`, {
      method: "POST",
      body:   formData
    });

    if (!res.ok) throw new Error("Upload failed");

    const data = await res.json();
    hideToast();

    // Determine type
    const mediaType = file.type.startsWith("image/") ? "image" : "video";

    // Tell server via socket
    socket.emit("message:media", {
      url:          data.url,
      mediaType,
      originalName: data.originalName
    });

  } catch (err) {
    hideToast();
    showToast("❌ Upload failed. Try again.");
    setTimeout(hideToast, 3000);
    console.error("Upload error:", err);
  }
}

// ─────────────────────────────────────────────
// VOICE RECORDING
// ─────────────────────────────────────────────
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks  = [];

    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = uploadVoiceMessage;
    mediaRecorder.start();

    voiceBtn.classList.add("recording");
    voiceBtn.title = "Release to send";

  } catch (err) {
    alert("Microphone access denied. Please allow microphone in browser settings.");
    console.error("Mic error:", err);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  voiceBtn.classList.remove("recording");
  voiceBtn.title = "Hold to record voice";
}

async function uploadVoiceMessage() {
  if (audioChunks.length === 0) return;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm")
    ? "audio/webm"
    : "audio/ogg";

  const blob     = new Blob(audioChunks, { type: mimeType });
  const ext      = mimeType.includes("webm") ? "webm" : "ogg";
  const file     = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType });

  showToast("⬆ Sending voice message…");

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res  = await fetch(`${SERVER_URL}/upload`, {
      method: "POST",
      body:   formData
    });

    if (!res.ok) throw new Error("Voice upload failed");

    const data = await res.json();
    hideToast();

    socket.emit("message:media", {
      url:          data.url,
      mediaType:    "voice",
      originalName: "Voice message"
    });

  } catch (err) {
    hideToast();
    showToast("❌ Voice send failed.");
    setTimeout(hideToast, 3000);
  }
}

// ─────────────────────────────────────────────
// DELETE MESSAGE
// ─────────────────────────────────────────────
function confirmDelete(messageId) {
  if (confirm("Delete this message?")) {
    socket.emit("message:delete", { messageId });
  }
}

// ─────────────────────────────────────────────
// RENDER ONLINE USERS LIST
// ─────────────────────────────────────────────
function renderUsersList(users) {
  usersList.innerHTML = "";

  if (users.length === 0) {
    usersList.innerHTML = `<li style="color:var(--text-muted);padding:10px;font-size:13px;">
      No users online
    </li>`;
    return;
  }

  users.forEach((user) => {
    const li = document.createElement("li");
    li.className = "user-item";

    const initial = user.username.charAt(0).toUpperCase();
    const isMe    = user.username === myUsername;

    li.innerHTML = `
      <div class="user-avatar">${initial}</div>
      <div>
        <div class="user-name">${escHtml(user.username)} ${isMe ? "(you)" : ""}</div>
        <div class="user-status">● online</div>
      </div>
    `;
    usersList.appendChild(li);
  });
}

// ─────────────────────────────────────────────
// UPDATE TICK MARKS
// ─────────────────────────────────────────────
function updateTick(messageId, status) {
  const tick = document.getElementById(`tick-${messageId}`);
  if (!tick) return;

  if (status === "delivered") {
    tick.textContent = "✓✓";
  } else if (status === "seen") {
    tick.textContent = "✓✓";
    tick.classList.add("seen");
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function scrollToBottom() {
  messagesArea.scrollTo({ top: messagesArea.scrollHeight, behavior: "smooth" });
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openImage(url) {
  window.open(url, "_blank");
}

let toastEl = null;
function showToast(msg) {
  hideToast();
  toastEl = document.createElement("div");
  toastEl.className = "upload-toast";
  toastEl.textContent = msg;
  document.body.appendChild(toastEl);
}

function hideToast() {
  if (toastEl) { toastEl.remove(); toastEl = null; }
}