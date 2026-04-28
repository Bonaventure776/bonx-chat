// server/index.js
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT        = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Create uploads folder if it doesn't exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// ─────────────────────────────────────────────
// MULTER — FILE STORAGE
// ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4",  "video/webm", "video/ogg",
    "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("File type not allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// ─────────────────────────────────────────────
// IN-MEMORY STORAGE
// ─────────────────────────────────────────────
const users    = new Map(); // socketId → { id, username, joinedAt }
const messages = [];        // all messages in memory

// ─────────────────────────────────────────────
// FILE UPLOAD ROUTE
// ─────────────────────────────────────────────
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const fileUrl = `/uploads/${req.file.filename}`;

  res.json({
    url:          fileUrl,
    originalName: req.file.originalname,
    mimetype:     req.file.mimetype,
    size:         req.file.size
  });
});

// ─────────────────────────────────────────────
// GET MESSAGE HISTORY
// ─────────────────────────────────────────────
app.get("/messages", (req, res) => {
  res.json(messages.slice(-100)); // return last 100 messages
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "✅ Bonx Chat server running", users: users.size });
});

// ─────────────────────────────────────────────
// SOCKET.IO — REAL-TIME LOGIC
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── User joins ────────────────────────────
  socket.on("user:join", (username) => {
    const user = {
      id:       socket.id,
      username: username.trim(),
      joinedAt: new Date()
    };

    users.set(socket.id, user);

    // Send message history to the new user
    socket.emit("messages:history", messages.slice(-100));

    // Tell everyone who is online
    io.emit("users:update", Array.from(users.values()));

    // System message: user joined
    const joinMsg = buildMessage({
      type:     "system",
      text:     `${user.username} joined Bonx Chat`,
      username: "System"
    });
    messages.push(joinMsg);
    io.emit("message:new", joinMsg);

    console.log(`👤 ${user.username} joined`);
  });

  // ── Text message ──────────────────────────
  socket.on("message:send", (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const msg = buildMessage({
      type:     "text",
      text:     data.text,
      username: user.username,
      senderId: socket.id
    });

    messages.push(msg);
    io.emit("message:new", msg);

    // Send delivered confirmation back to sender
    socket.emit("message:delivered", { messageId: msg.id });
  });

  // ── Media message (image / video / voice) ─
  socket.on("message:media", (data) => {
    /*
      data = {
        url,
        mediaType: "image" | "video" | "voice",
        originalName
      }
    */
    const user = users.get(socket.id);
    if (!user) return;

    const msg = buildMessage({
      type:         data.mediaType,
      text:         data.originalName || "",
      url:          data.url,
      username:     user.username,
      senderId:     socket.id
    });

    messages.push(msg);
    io.emit("message:new", msg);
    socket.emit("message:delivered", { messageId: msg.id });
  });

  // ── Typing indicator ──────────────────────
  socket.on("typing:start", () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.broadcast.emit("typing:show", { username: user.username });
  });

  socket.on("typing:stop", () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.broadcast.emit("typing:hide", { username: user.username });
  });

  // ── Seen receipt ──────────────────────────
  socket.on("message:seen", ({ messageId }) => {
    // Find message and update status
    const msg = messages.find((m) => m.id === messageId);
    if (msg) msg.status = "seen";

    // Tell the original sender
    const senderSocket = io.sockets.sockets.get(msg?.senderId);
    if (senderSocket) {
      senderSocket.emit("message:seen-update", { messageId });
    }
  });

  // ── Delete message ────────────────────────
  socket.on("message:delete", ({ messageId }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx !== -1 && messages[idx].senderId === socket.id) {
      messages[idx].deleted = true;
      messages[idx].text    = "This message was deleted";
      io.emit("message:deleted", { messageId });
    }
  });

  // ── Disconnect ────────────────────────────
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit("users:update", Array.from(users.values()));

      const leaveMsg = buildMessage({
        type:     "system",
        text:     `${user.username} left Bonx Chat`,
        username: "System"
      });
      messages.push(leaveMsg);
      io.emit("message:new", leaveMsg);

      console.log(`👋 ${user.username} disconnected`);
    }
  });
});

// ─────────────────────────────────────────────
// HELPER: Build a message object
// ─────────────────────────────────────────────
function buildMessage({ type, text, url, username, senderId }) {
  return {
    id:        uuidv4(),
    type,
    text:      text  || "",
    url:       url   || null,
    username,
    senderId:  senderId || null,
    timestamp: new Date().toISOString(),
    status:    "sent",
    deleted:   false
  };
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Bonx Chat running → http://localhost:${PORT}`);
});