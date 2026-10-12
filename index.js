"use strict";

// Ultra-early log so we know THIS file is running
console.log("[BOOT] index.js starting...");
console.log("[BOOT] Node", process.version, "CWD", process.cwd());
console.log("[BOOT] JS_FILE env:", process.env.JS_FILE || "(not set)");
console.log("[BOOT] PORT env:", process.env.PORT || "(not set)");
console.log("[BOOT] SERVER_PORT env:", process.env.SERVER_PORT || "(not set)");

// Wispbyte / Pterodactyl usually inject SERVER_PORT (not PORT)
const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || 3000;
console.log("[BOOT] Using listen port:", PORT);

// Keep process alive no matter what
process.stdin.resume();
setInterval(() => {}, 1 << 30);

process.on("SIGTERM", () => console.log("[System] SIGTERM ignored"));
process.on("SIGINT", () => console.log("[System] SIGINT ignored"));
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

let express, app, server;
try {
  express = require("express");
  app = express();
  app.get("/", (_req, res) => res.send("Bot is running!"));
  app.get("/ping", (_req, res) => res.send("pong"));
  app.get("/health", (_req, res) =>
    res.json({ ok: true, uptime: process.uptime(), port: PORT })
  );
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log("[Server] HTTP keep-alive listening on 0.0.0.0:" + PORT);
  });
  server.on("error", (err) => {
    console.error("[Server] listen error:", err.message);
    if (err.code === "EADDRINUSE") {
      const fb = PORT + 1;
      console.log("[Server] trying port", fb);
      try { server.listen(fb, "0.0.0.0"); } catch (e) {}
    }
  });
} catch (e) {
  console.error("[BOOT] Express failed:", e.message);
}

let addLog, getLogs, mineflayer, pathfinder, config, governor;
try {
  ({ addLog, getLogs } = require("./logger"));
  mineflayer = require("mineflayer");
  ({ pathfinder } = require("mineflayer-pathfinder"));
  config = require("./settings.json");
  governor = require("./cpuGovernor");
  console.log("[BOOT] All modules loaded OK");
} catch (e) {
  console.error("[BOOT] Module load failed:", e.message);
  console.error(e.stack);
  return;
}

function log(msg) {
  try { addLog(msg); } catch (_) { console.log(msg); }
}

log("=".repeat(50));
log("  Minecraft AFK Bot - Wispbyte Edition");
log("=".repeat(50));
log("Server: " + config.server.ip + ":" + config.server.port);
log("Version: " + config.server.version);
log("Keep-alive PORT: " + PORT);
log("=".repeat(50));

try { governor.start(); } catch (e) { log("[Governor] start failed: " + e.message); }

let bot = null;
let isReconnecting = false;
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
const botState = {
  connected: false,
  reconnectAttempts: 0,
  startTime: Date.now(),
};

if (app) {
  app.get("/logs", (_req, res) => {
    try {
      res.type("text/plain").send(getLogs().join("\n") || "No logs yet");
    } catch (e) {
      res.status(500).send(String(e.message));
    }
  });
  app.get("/status", (_req, res) => {
    res.json({
      connected: botState.connected,
      attempts: botState.reconnectAttempts,
      uptime: Math.floor(process.uptime()),
    });
  });
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts += 1;
  const base = (config.utils && config.utils["auto-reconnect-delay"]) || 2000;
  const max = (config.utils && config.utils["max-reconnect-delay"]) || 120000;
  const delay = Math.min(base * Math.min(botState.reconnectAttempts, 10), max);
  log("[Bot] Reconnect in " + Math.round(delay / 1000) + "s (attempt " + botState.reconnectAttempts + ")");
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
  reconnectTimeoutId = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

function createBot() {
  if (isReconnecting) return;

  if (bot) {
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  const host = config.server.ip;
  const port = config.server.port;
  const version =
    config.server.version && String(config.server.version).trim() !== ""
      ? config.server.version
      : false;

  log("[Bot] Connecting to " + host + ":" + port + " (version=" + (version || "auto") + ")");

  try {
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type || "offline",
      host,
      port,
      version,
      hideErrors: false,
      checkTimeoutInterval: 600000,
    });

    try { bot.loadPlugin(pathfinder); } catch (e) {
      log("[Bot] pathfinder: " + e.message);
    }

    if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        log("[Bot] Connection timeout");
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        botState.connected = false;
        scheduleReconnect();
      }
    }, 60000);

    bot.once("login", () => log("[Bot] Logged in"));

    bot.once("spawn", () => {
      if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
      botState.connected = true;
      botState.reconnectAttempts = 0;
      log("[Bot] Spawned on server");

      try {
        if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
          const pw = config.utils["auto-auth"].password;
          setTimeout(() => {
            try { bot.chat("/login " + pw); log("[Bot] Sent /login"); } catch (_) {}
          }, 1500);
        }
      } catch (_) {}

      if (config.utils && config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
        setInterval(() => {
          if (!bot || !bot.entity) return;
          try {
            if (governor && governor.isLow && governor.isLow()) return;
            bot.setControlState("jump", true);
            setTimeout(() => {
              try { bot.setControlState("jump", false); } catch (_) {}
            }, 400);
          } catch (_) {}
        }, 30000);
      }
    });

    bot.on("end", (reason) => {
      log("[Bot] Disconnected: " + (reason || "end"));
      botState.connected = false;
      bot = null;
      if (!config.utils || config.utils["auto-reconnect"] !== false) scheduleReconnect();
    });

    bot.on("kicked", (reason) => {
      log("[Bot] Kicked: " + reason);
      botState.connected = false;
    });

    bot.on("error", (err) => {
      log("[Bot] Error: " + (err.message || err));
    });

    bot.on("messagestr", (msg) => {
      if (config.utils && config.utils["chat-log"]) log("[Chat] " + msg);
    });
  } catch (e) {
    log("[Bot] createBot failed: " + e.message);
    scheduleReconnect();
  }
}

createBot();
console.log("[BOOT] createBot() called — process will stay alive");
