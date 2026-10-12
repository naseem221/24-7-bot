"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");
// [CPU-GOVERNOR 1/4] CPU governor load karo (cpuGovernor.js isi folder mein honi chahiye)
const governor = require("./cpuGovernor");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos/Wispbyte alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Minimal keep-alive route for Wispbyte panel (detects open port)
app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
  });
});

app.get("/ping", (req, res) => res.send("pong"));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("[Server] HTTP keep-alive on port", server.address().port);
});

server.on("error", (err) => {
  console.error("[Server] error:", err.message);
  if (err.code === "EADDRINUSE") {
    const fallback = Number(PORT) + 1;
    server.listen(fallback, "0.0.0.0");
  }
});

// Prevent panel from stopping process
process.on("SIGTERM", () => console.log("[System] SIGTERM ignored"));
process.on("SIGINT", () => console.log("[System] SIGINT ignored"));

// Load the rest of the bot after keep-alive is up
// (restored full logic will replace this stub in next commit if needed)
console.log("[Boot] Keep-alive server started. Loading bot...");

// --- Minimal createBot so process never exits empty ---
function createBot() {
  console.log("[Bot] createBot called - full bot code needs restore from previous good commit");
  console.log("[Bot] Server:", config.server && config.server.ip);
}
createBot();

// Keep event loop alive forever
setInterval(() => {}, 60000);
