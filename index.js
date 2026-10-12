"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");
const governor = require("./cpuGovernor");

// ============================================================
// EXPRESS - Wispbyte / Render keep-alive (MUST bind open port)
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let bot = null;
let isReconnecting = false;
let reconnectTimeoutId = null;
let connectionTimeoutId = null;

const botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
};

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    reconnectAttempts: botState.reconnectAttempts,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  res.type("text/plain").send(getLogs().join("\n") || "No logs yet");
});

const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP keep-alive on port ${server.address().port}`);
});

server.on("error", (err) => {
  addLog(`[Server] error: ${err.message}`);
  if (err.code === "EADDRINUSE") {
    const fb = Number(PORT) + 1;
    addLog(`[Server] trying fallback port ${fb}`);
    try { server.listen(fb, "0.0.0.0"); } catch (e) {}
  }
});

// ============================================================
// Governor
// ============================================================
governor.start();
governor.onChange((low) => {
  addLog(`[Governor] ${low ? "LOW POWER mode ON" : "Normal mode"}`);
});

// ============================================================
// Bot
// ============================================================
function clearBotTimeouts() {
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts += 1;
  const base = (config.utils && config.utils["auto-reconnect-delay"]) || 2000;
  const max = (config.utils && config.utils["max-reconnect-delay"]) || 120000;
  const delay = Math.min(base * Math.min(botState.reconnectAttempts, 10), max);
  addLog(`[Bot] Reconnect in ${Math.round(delay / 1000)}s (attempt ${botState.reconnectAttempts})`);
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
  reconnectTimeoutId = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

function createBot() {
  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skip");
    return;
  }

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (_) {}
    bot = null;
  }

  const host = config.server.ip;
  const port = config.server.port;
  const version =
    config.server.version && String(config.server.version).trim() !== ""
      ? config.server.version
      : false;

  addLog(`[Bot] Connecting to ${host}:${port} (version=${version || "auto"})`);

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

    try {
      bot.loadPlugin(pathfinder);
    } catch (e) {
      addLog(`[Bot] pathfinder load warning: ${e.message}`);
    }

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - no spawn");
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (_) {}
        bot = null;
        botState.connected = false;
        scheduleReconnect();
      }
    }, 60000);

    bot.once("login", () => {
      addLog("[Bot] Logged in");
      botState.lastActivity = Date.now();
    });

    bot.once("spawn", () => {
      clearBotTimeouts();
      botState.connected = true;
      botState.reconnectAttempts = 0;
      botState.lastActivity = Date.now();
      addLog("[Bot] Spawned on server");

      try {
        if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
          const pw = config.utils["auto-auth"].password;
          setTimeout(() => {
            try {
              bot.chat(`/login ${pw}`);
              addLog("[Bot] Sent /login");
            } catch (_) {}
          }, 1500);
        }
      } catch (_) {}

      if (config.utils && config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
        setInterval(() => {
          if (!bot || !bot.entity) return;
          if (governor.isLow()) return;
          try {
            bot.setControlState("jump", true);
            setTimeout(() => {
              try { bot.setControlState("jump", false); } catch (_) {}
            }, 400);
          } catch (_) {}
        }, governor.scale(30000));
      }
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "end"}`);
      botState.connected = false;
      bot = null;
      if (config.utils && config.utils["auto-reconnect"] !== false) {
        scheduleReconnect();
      }
    });

    bot.on("kicked", (reason) => {
      addLog(`[Bot] Kicked: ${reason}`);
      botState.connected = false;
    });

    bot.on("error", (err) => {
      addLog(`[Bot] Error: ${err.message || err}`);
      botState.errors.push({ message: String(err.message || err), time: Date.now() });
      if (botState.errors.length > 50) botState.errors = botState.errors.slice(-25);
    });

    bot.on("messagestr", (msg) => {
      if (config.utils && config.utils["chat-log"]) {
        addLog(`[Chat] ${msg}`);
      }
    });
  } catch (e) {
    addLog(`[Bot] createBot failed: ${e.message}`);
    scheduleReconnect();
  }
}

process.on("uncaughtException", (err) => {
  addLog(`[FATAL] uncaughtException: ${err.message}`);
  botState.connected = false;
  isReconnecting = false;
  setTimeout(() => scheduleReconnect(), 8000);
});

process.on("unhandledRejection", (reason) => {
  addLog(`[FATAL] unhandledRejection: ${reason}`);
});

process.on("SIGTERM", () => {
  addLog("[System] SIGTERM ignored — staying alive for Wispbyte");
});

process.on("SIGINT", () => {
  addLog("[System] SIGINT ignored — staying alive for Wispbyte");
});

addLog("=".repeat(50));
addLog("  Minecraft AFK Bot - Wispbyte Edition");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version}`);
addLog(`PORT keep-alive: ${PORT}`);
addLog("=".repeat(50));

createBot();
