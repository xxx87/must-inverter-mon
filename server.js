require("dotenv").config({ override: true });

const ModbusRTU = require("modbus-serial");
const express = require("express");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const mqtt = require("mqtt");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const { JbdBatteryPoller } = require("./bms");

const CONFIG = {
  serial: {
    port: process.env.SERIAL_PORT || "/dev/ttyUSB0",
    baud: parseInt(process.env.SERIAL_BAUD) || 19200,
    id: parseInt(process.env.SERIAL_ID) || 4
  },
  mqtt: {
    url: process.env.MQTT_URL,
    port: process.env.MQTT_PORT || 1883,
    prefix: process.env.MQTT_PREFIX || "home/solar",
    username: process.env.MQTT_USERNAME || "",
    password: process.env.MQTT_PASSWORD || ""
  },
  influx: {
    enabled: process.env.INFLUX_ENABLED === "true",
    url: process.env.INFLUX_URL,
    token: process.env.INFLUX_TOKEN || "",
    org: process.env.INFLUX_ORG || "",
    bucket: process.env.INFLUX_BUCKET || "solar_bucket"
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 5000,
  bms: {
    enabled: process.env.BMS_ENABLED !== "false",
    pollInterval: parseInt(process.env.BMS_POLL_INTERVAL) || 15000,
    batteries: [
      { id: "battery1", mac: process.env.BMS_BATTERY1_MAC || "" },
      { id: "battery2", mac: process.env.BMS_BATTERY2_MAC || "" }
    ].filter((b) => b.mac)
  }
};

// --- КАРТА РЕГИСТРІВ (БЕЗ ЗСУВУ!) ---
// scale: на що помножити сире число. signed: чи є мінус.
const REGISTERS = [
  // === МОНІТОРИНГ (Read Only) ===
  // work_state (25201) прибрано: на PV18-3224 часто не читається і давав NaN в MQTT
  { id: "battery_v", addr: 25205, scale: 0.1 },
  { id: "inverter_v", addr: 25206, scale: 0.1 },
  { id: "grid_v", addr: 25207, scale: 0.1 },
  { id: "bus_v", addr: 25208, scale: 0.1 }, // Напруга шини DC
  { id: "grid_freq", addr: 25209, scale: 0.01 },
  { id: "inverter_current", addr: 25210, scale: 0.1 },
  { id: "grid_power", addr: 25214, scale: 1, signed: true }, // Вт (Купівля/Продаж)
  { id: "load_power", addr: 25215, scale: 1, signed: true }, // Вт (Навантаження дому)
  { id: "battery_current", addr: 25274, scale: 0.1, signed: true }, // Струм АКБ (Заряд/Розряд)
  { id: "temperature", addr: 25233, scale: 1 }, // Температура радіатора
  { id: "error_code", addr: 25261, scale: 1 }, // Помилки
  { id: "warning_code", addr: 25265, scale: 1 }, // Попередження

  // === НАЛАШТУВАННЯ (Read/Write) ===
  // Читаємо їх, щоб відображати поточний стан
  { id: "set_output_priority", addr: 20109, scale: 1 }, // Energy use mode
  { id: "set_max_charge_amp", addr: 20125, scale: 0.1 }, // Grid max charger current
  { id: "battery_low_voltage", addr: 20127, scale: 0.1 }, // Battery low voltage (inverter)
  // PV Charger Control: Bulk/C.V. = Absorption, Float = Float (protocol sheet5)
  { id: "bulk_voltage", addr: 10104, scale: 0.1 }, // Absorption / C.V.
  { id: "float_voltage", addr: 10103, scale: 0.1 }, // Float
  { id: "stop_charge_voltage", addr: 20119, scale: 0.1 }, // Battery stop charging voltage
  { id: "stop_discharge_voltage", addr: 20118, scale: 0.1 } // Battery stop discharging voltage
];

// --- ІНІЦІАЛІЗАЦІЯ ---
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const adapter = new FileSync("inverter_data.json");
const db = low(adapter);
db.defaults({ history: [] }).write();

const sevenDaysAgo = Date.now() - 7 * 86400000;
db.get("history")
  .remove((item) => item.timestamp < sevenDaysAgo)
  .write();

let lastStatus = {};
let lastBatteries = {};

// MQTT & Influx
const mqttClient = mqtt.connect(CONFIG.mqtt.url, CONFIG.mqtt);
let influxWriteApi = null;
if (CONFIG.influx.enabled) {
  console.log(
    `[Influx] enabled → ${CONFIG.influx.url} org=${CONFIG.influx.org} bucket=${CONFIG.influx.bucket}`
  );
  const influxDB = new InfluxDB({ url: CONFIG.influx.url, token: CONFIG.influx.token });
  influxWriteApi = influxDB.getWriteApi(CONFIG.influx.org, CONFIG.influx.bucket, "ms");
  influxWriteApi.useDefaultTags({ source: "must-inverter" });
} else {
  console.log("[Influx] disabled");
}

const bmsPoller = new JbdBatteryPoller({
  enabled: CONFIG.bms.enabled,
  pollInterval: CONFIG.bms.pollInterval,
  batteries: CONFIG.bms.batteries
});

bmsPoller.on("data", (data) => {
  lastBatteries[data.id] = data;
  const base = `${CONFIG.mqtt.prefix}/${data.id}`;
  mqttClient.publish(`${base}/json`, JSON.stringify(data));
  const flat = {
    soc: data.soc,
    voltage: data.voltage,
    current: data.current,
    power: data.power,
    capacity_ah: data.capacity_ah,
    full_capacity_ah: data.full_capacity_ah,
    cycles: data.cycles,
    temperature: data.temperature,
    cell_min_mv: data.cell_min_mv,
    cell_max_mv: data.cell_max_mv,
    cell_delta_mv: data.cell_delta_mv
  };
  for (const [key, value] of Object.entries(flat)) {
    if (value !== undefined && value !== null) {
      mqttClient.publish(`${base}/${key}`, String(value));
    }
  }
});

// Modbus
const client = new ModbusRTU();
let writeQueue = []; // Черга команд на запис

// --- ДОПОМІЖНІ ФУНКЦІЇ ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function toSigned16(val) {
  return val > 32767 ? val - 65536 : val;
}

// --- МОНІТОРИНГ ---
async function startLoop() {
  try {
    console.log("Відкриваємо порт...");
    await client.connectRTU(CONFIG.serial.port, { baudRate: CONFIG.serial.baud, parity: "none" });
    client.setID(CONFIG.serial.id);
    client.setTimeout(1500);

    while (true) {
      // 1. Є ЩО ЗАПИСАТИ? (Команди від користувача)
      while (writeQueue.length > 0) {
        const cmd = writeQueue.shift();
        console.log(`[WRITE] Адреса: ${cmd.addr}, Значення: ${cmd.val}`);
        try {
          // ПРЯМА АДРЕСАЦІЯ (БЕЗ -1)
          await client.writeRegister(cmd.addr, cmd.val);
          console.log("--> Записано успішно");
        } catch (e) {
          console.error("--> Помилка запису:", e.message);
        }
        await sleep(500); // Пауза після запису
      }

      // 2. ЧИТАЄМО ДАТЧИКИ
      let snapshot = { timestamp: Date.now() };

      for (let reg of REGISTERS) {
        try {
          // ПРЯМА АДРЕСАЦІЯ (БЕЗ -1)
          let res = await client.readHoldingRegisters(reg.addr, 1);
          let val = res.data[0];

          if (reg.signed) val = toSigned16(val);
          let finalVal = val * reg.scale;

          // Округлюємо до 1 знака (для краси)
          if (reg.scale < 1) finalVal = Math.round(finalVal * 10) / 10;

          snapshot[reg.id] = finalVal;

          // Коротка пауза, щоб інвертор не захлинувся
          await sleep(100);
        } catch (e) {
          // console.error(`Помилка читання ${reg.id}: ${e.message}`);
        }
      }

      // 3. ОБРОБКА ДАНИХ
      if (Object.keys(snapshot).length > 3) {
        handleData(snapshot);
      }

      // Чекаємо до наступного циклу
      await sleep(CONFIG.pollInterval);
    }
  } catch (e) {
    console.error("КРИТИЧНА ПОМИЛКА (ПЕРЕЗАПУСК):", e.message);
    if (client.isOpen) {
      client.close(() => {
        console.log("Порт закрито, перезапуск через 5 сек...");
      });
    }
    setTimeout(startLoop, 5000);
  }
}

function handleData(data) {
  console.log(
    `[${new Date().toLocaleTimeString()}] Bat:${data.battery_v}V Load:${data.load_power}W Grid:${data.grid_power}W`
  );

  // A. MQTT (окремі топики + JSON без null/NaN)
  const mqttData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "timestamp") {
      mqttData[key] = value;
      continue;
    }
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    mqttData[key] = value;
    mqttClient.publish(`${CONFIG.mqtt.prefix}/${key}`, String(value));
  }
  mqttClient.publish(`${CONFIG.mqtt.prefix}/json`, JSON.stringify(mqttData));

  lastStatus = data;

  db.get("history")
    .push({
      timestamp: data.timestamp,
      battery_v: data.battery_v,
      load_power: data.load_power,
      grid_power: data.grid_power,
      solar_power: 0
    })
    .write();

  const sevenDaysAgo = Date.now() - 7 * 86400000;
  db.get("history")
    .remove((item) => item.timestamp < sevenDaysAgo)
    .write();

  // C. InfluxDB
  if (influxWriteApi) {
    try {
      const point = new Point("pv18_status");
      if (typeof data.battery_v === "number" && !Number.isNaN(data.battery_v)) {
        point.floatField("battery_v", data.battery_v);
      }
      if (typeof data.load_power === "number" && !Number.isNaN(data.load_power)) {
        point.intField("load_power", Math.round(data.load_power));
      }
      if (typeof data.grid_power === "number" && !Number.isNaN(data.grid_power)) {
        point.intField("grid_power", Math.round(data.grid_power));
      }
      if (typeof data.temperature === "number" && !Number.isNaN(data.temperature)) {
        point.intField("temp", Math.round(data.temperature));
      }
      if (typeof data.battery_current === "number" && !Number.isNaN(data.battery_current)) {
        point.floatField("battery_current", data.battery_current);
      }
      influxWriteApi.writePoint(point);
      influxWriteApi.flush().catch((e) => console.error("[Influx] flush:", e.message || e));
    } catch (e) {
      console.error("[Influx] write:", e.message || e);
    }
  }
}

// --- REST API ДЛЯ FRONTEND ---

app.get("/api/status", (req, res) => {
  res.json({
    ...(lastStatus || {}),
    batteries: lastBatteries
  });
});

app.get("/api/history", (req, res) => {
  const hours = req.query.hours || 6;
  const limit = Date.now() - hours * 3600 * 1000;
  const all = db.get("history").value();
  const rows = all.filter((item) => item.timestamp > limit).sort((a, b) => a.timestamp - b.timestamp);
  res.json(rows);
});

// Управління (POST /api/set)
app.post("/api/set", (req, res) => {
  const { id, value } = req.body;

  // Шукаємо регістр у нашому списку
  const reg = REGISTERS.find((r) => r.id === id);
  if (!reg) return res.status(400).json({ error: "Невідомий параметр" });

  // Зворотне масштабування (Наприклад, хочемо поставити 27.5В -> треба відправити 275)
  let rawVal = Math.round(value / reg.scale);

  writeQueue.push({ addr: reg.addr, val: rawVal });

  res.json({ success: true, message: `Команда ${id}=${value} (raw ${rawVal}) додана до черги` });
});

// ЗАПУСК
app.listen(3000, () => {
  console.log("СЕРВЕР ЗАПУЩЕНО на порту 3000");
  startLoop();
  bmsPoller.start().catch((e) => console.error("[BMS] start failed:", e.message));
});
