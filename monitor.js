const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

// --- НАСТРОЙКИ ---
const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;
const BAUD_RATE = 19200;
const POLLING_INTERVAL = 5000; // Опрос раз в 5 секунд

// Карта регистров, которые мы хотим читать (Адреса из CSV)
const SENSORS = [
  { addr: 25201, name: "Status", unit: "", scale: 1, signed: false }, // 2:OffGrid, 3:Grid-Tie...
  { addr: 25205, name: "Battery", unit: "V", scale: 0.1, signed: false },
  { addr: 25206, name: "Inv Voltage", unit: "V", scale: 0.1, signed: false },
  { addr: 25207, name: "Grid Voltage", unit: "V", scale: 0.1, signed: false },
  { addr: 25214, name: "Grid Power", unit: "W", scale: 1, signed: true }, // < 0: покупка, > 0: продажа?
  { addr: 25215, name: "Load Power", unit: "W", scale: 1, signed: true },
  { addr: 25209, name: "Grid Freq", unit: "Hz", scale: 0.01, signed: false } // В CSV 25226 Grid Freq, проверь
];

// Функция паузы
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Преобразование unsigned int16 (0..65535) в signed int16 (-32768..32767)
function toSigned16(val) {
  return val > 32767 ? val - 65536 : val;
}

// Расшифровка статуса (из CSV)
function getStatusString(val) {
  const states = {
    0: "PowerOn",
    1: "SelfTest",
    2: "OffGrid",
    3: "Grid-Tie",
    4: "ByPass",
    5: "Stop",
    6: "GridCharging"
  };
  return states[val] || `Unknown(${val})`;
}

async function connect() {
  try {
    await client.connectRTU(SERIAL_PORT, { baudRate: BAUD_RATE, parity: "none" });
    client.setID(SLAVE_ID);
    client.setTimeout(1500);
    console.log("--> Порт открыт. Начинаем мониторинг...");
    return true;
  } catch (e) {
    console.error("Ошибка подключения:", e.message);
    return false;
  }
}

async function readLoop() {
  if (!client.isOpen) {
    const connected = await connect();
    if (!connected) {
      setTimeout(readLoop, 5000); // Реконнект через 5 сек
      return;
    }
  }

  console.clear();
  console.log(`=== MUST PV18 MONITOR [${new Date().toLocaleTimeString()}] ===`);

  // Читаем датчики по очереди с паузой
  for (const sensor of SENSORS) {
    try {
      // Читаем 1 регистр
      const data = await client.readHoldingRegisters(sensor.addr, 1);
      let val = data.data[0];

      if (sensor.signed) val = toSigned16(val);
      let finalVal = val * sensor.scale;

      // Форматирование вывода
      let displayVal = finalVal.toFixed(sensor.scale < 1 ? 1 : 0);

      // Если это статус - расшифруем
      if (sensor.name === "Status") {
        displayVal = getStatusString(val);
      }

      console.log(`${sensor.name.padEnd(15)}: ${displayVal} ${sensor.unit}`);

      // ВАЖНО: Пауза между регистрами, чтобы инвертор не захлебнулся
      await sleep(50);
    } catch (e) {
      console.log(`${sensor.name.padEnd(15)}: ERROR (${e.message})`);
      // Если ошибка "Port Not Open", прерываем цикл
      if (e.message.includes("Port Not Open")) break;
    }
  }

  console.log("==========================================");

  // Ждем перед следующим полным циклом опроса
  setTimeout(readLoop, POLLING_INTERVAL);
}

// Запуск
readLoop();
