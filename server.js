require("dotenv").config();

const ModbusRTU = require("modbus-serial");
const express = require("express");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const mqtt = require("mqtt");
const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

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
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 5000
};

// --- КАРТА РЕГИСТРІВ (БЕЗ ЗСУВУ!) ---
// scale: на що помножити сире число. signed: чи є мінус.
const REGISTERS = [
  // === МОНІТОРИНГ (Read Only) ===
  { id: "work_state", addr: 25201, type: "status" }, // 2:OffGrid, 3:GridTie...
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
  { id: "set_output_priority", addr: 20109, scale: 1 }, // 1:Sol, 2:Uti, 3:SBU
  { id: "set_max_charge_amp", addr: 20125, scale: 0.1 },
  { id: "set_ac_charge_amp", addr: 20127, scale: 0.1 },
  { id: "set_bulk_voltage", addr: 20119, scale: 0.1 },
  { id: "set_float_voltage", addr: 20120, scale: 0.1 },
  { id: "set_cut_off_voltage", addr: 20121, scale: 0.1 }
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
db.get("history").remove((item) => item.timestamp < sevenDaysAgo).write();

let lastStatus = {};

// MQTT & Influx
const mqttClient = mqtt.connect(CONFIG.mqtt.url, CONFIG.mqtt);
let influxWriteApi = null;
if (CONFIG.influx.enabled) {
  const influxDB = new InfluxDB({ url: CONFIG.influx.url, token: CONFIG.influx.token });
  influxWriteApi = influxDB.getWriteApi(CONFIG.influx.org, CONFIG.influx.bucket);
}

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
    client.close();
    setTimeout(startLoop, 5000);
  }
}

function handleData(data) {
  console.log(
    `[${new Date().toLocaleTimeString()}] Bat:${data.battery_v}V Load:${data.load_power}W Grid:${data.grid_power}W`
  );

  // A. MQTT (Окремі топики + загальний JSON)
  mqttClient.publish(`${CONFIG.mqtt.prefix}/json`, JSON.stringify(data));
  // Для Home Assistant Autodiscovery зручно мати окремі топики:
  for (const [key, value] of Object.entries(data)) {
    if (key !== "timestamp") {
      mqttClient.publish(`${CONFIG.mqtt.prefix}/${key}`, value.toString());
    }
  }

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
  db.get("history").remove((item) => item.timestamp < sevenDaysAgo).write();

  // C. InfluxDB
  if (influxWriteApi) {
    const point = new Point("pv18_status")
      .floatField("battery_v", data.battery_v)
      .intField("load_power", data.load_power)
      .intField("grid_power", data.grid_power)
      .intField("temp", data.temperature);
    influxWriteApi.writePoint(point);
  }
}

// --- REST API ДЛЯ FRONTEND ---

app.get("/api/status", (req, res) => {
  const history = db.get("history").value();
  const last = history.length > 0 ? history[history.length - 1] : null;
  res.json(last || lastStatus || {});
});

app.get("/api/history", (req, res) => {
  const hours = req.query.hours || 6;
  const limit = Date.now() - hours * 3600 * 1000;
  const all = db.get("history").value();
  const rows = all
    .filter((item) => item.timestamp > limit)
    .sort((a, b) => a.timestamp - b.timestamp);
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
});
