// cpuGovernor.js - CPU/RAM badhne par bot ko khud "low power mode" mein daal deta hai.
// Use: const governor = require('./cpuGovernor'); governor.start();
//
// Limits (host ke cap se thoda neeche rakho). Wispbyte free = 35% of one vCPU.
// Env variables se badal sakte ho: CPU_HIGH, CPU_LOW, MEM_HIGH_MB, MEM_LOW_MB

const CHECK_MS = 5000;                                   // har 5 second mein check
const CPU_HIGH = Number(process.env.CPU_HIGH || 34);     // isse upar -> low mode ON
const CPU_LOW  = Number(process.env.CPU_LOW  || 28);     // isse neeche -> normal mode wapas
const MEM_HIGH = Number(process.env.MEM_HIGH_MB || 400); // RSS MB, isse upar -> low mode ON
const MEM_LOW  = Number(process.env.MEM_LOW_MB  || 320); // isse neeche -> normal

let low = false;
let smoothed = 0;
let timer = null;
let lastUsage = process.cpuUsage();
let lastTime = process.hrtime.bigint();
const listeners = [];

function tick() {
  const now = process.hrtime.bigint();
  const used = process.cpuUsage(lastUsage);              // pichle check se ab tak ka CPU time
  const elapsedUs = Number(now - lastTime) / 1000;
  lastUsage = process.cpuUsage();
  lastTime = now;

  const cpuPct = ((used.user + used.system) / elapsedUs) * 100; // % of ONE core
  smoothed = smoothed * 0.6 + cpuPct * 0.4;                     // spikes ko smooth karo
  const memMb = process.memoryUsage().rss / 1024 / 1024;

  const shouldBeLow = low
    ? !(smoothed <= CPU_LOW && memMb <= MEM_LOW)   // wapas normal tabhi jab dono neeche aayein
    : (smoothed >= CPU_HIGH || memMb >= MEM_HIGH);

  if (shouldBeLow !== low) {
    low = shouldBeLow;
    console.log(`[Governor] ${low ? 'LOW POWER ON' : 'Normal mode'} (CPU ${smoothed.toFixed(1)}%, RAM ${memMb.toFixed(0)} MB)`);
    listeners.forEach((cb) => { try { cb(low); } catch (e) { console.error('[Governor]', e.message); } });
  }
}

module.exports = {
  start() { if (!timer) timer = setInterval(tick, CHECK_MS); },
  stop()  { clearInterval(timer); timer = null; },
  isLow() { return low; },
  onChange(cb) { listeners.push(cb); },          // cb(true) = low power, cb(false) = normal
  scale(ms) { return low ? ms * 4 : ms; },       // low mode mein interval 4 guna bada
};
