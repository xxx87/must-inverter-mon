const EventEmitter = require("events");
const { spawn } = require("child_process");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMac(mac) {
  return String(mac || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, ":");
}

class JbdBatteryPoller extends EventEmitter {
  constructor(options) {
    super();
    this.batteries = (options.batteries || [])
      .filter((b) => b && b.mac && b.id)
      .map((b) => ({ id: b.id, mac: normalizeMac(b.mac) }));
    this.pollInterval = options.pollInterval || 15000;
    this.enabled = options.enabled !== false && this.batteries.length > 0;
    this._running = false;
    this.last = {};
    this.pythonBin =
      process.env.BMS_PYTHON || path.join(__dirname, ".venv-bms", "bin", "python");
    this.scriptPath = path.join(__dirname, "bms_bleak.py");
  }

  async start() {
    if (!this.enabled || this._running) return;
    this._running = true;
    console.log(
      "[BMS] started via bleak, devices:",
      this.batteries.map((b) => `${b.id}=${b.mac}`).join(", ")
    );
    this._loop().catch((e) => console.error("[BMS] loop crashed:", e.message));
  }

  stop() {
    this._running = false;
  }

  getLast() {
    return { ...this.last };
  }

  async _loop() {
    while (this._running) {
      for (const bat of this.batteries) {
        if (!this._running) break;
        try {
          const data = await this._pollOne(bat);
          if (data && !data.error) {
            this.last[bat.id] = data;
            this.emit("data", data);
            console.log(
              `[BMS] ${bat.id}: SoC ${data.soc}% ${data.voltage}V ${data.current}A`
            );
          } else if (data && data.error) {
            console.error(`[BMS] ${bat.id} error:`, data.error);
          }
        } catch (e) {
          console.error(`[BMS] ${bat.id} error:`, e.message);
        }
        await sleep(2000);
      }
      await sleep(this.pollInterval);
    }
  }

  _pollOne(bat) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.pythonBin,
        [this.scriptPath, "--mac", bat.mac, "--id", bat.id],
        { cwd: __dirname }
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("poll timeout"));
      }, 45000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const line = (stdout || stderr).trim().split("\n").filter(Boolean).pop();
        if (!line) {
          return reject(new Error(stderr.trim() || `exit ${code}`));
        }
        try {
          const parsed = JSON.parse(line);
          if (code !== 0 && parsed.error) return resolve(parsed);
          if (code !== 0) return reject(new Error(parsed.error || stderr || `exit ${code}`));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`bad json: ${line}`));
        }
      });
    });
  }
}

module.exports = { JbdBatteryPoller };
