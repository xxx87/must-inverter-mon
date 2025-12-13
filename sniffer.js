const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;
const OPTIONS = { baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none" };

// Діапазон пошуку. Судячи з CSV, найцікавіше лежить тут:
// 25205 (Battery V), 25206 (Inverter V), 25207 (Grid V)
// Почнемо трохи заздалегідь, щоб зловити зсув.
const START_ADDR = 25200;
const END_ADDR = 25220;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sniff() {
  try {
    await client.connectRTU(SERIAL_PORT, OPTIONS);
    client.setID(SLAVE_ID);
    client.setTimeout(1500);

    console.log(`Підключено. Скануємо по одному регістру з ${START_ADDR} по ${END_ADDR}...`);
    console.log("----------------------------------------------------------------");
    console.log("WireAddr | Raw Value | Значення / 10 | Гіпотеза");
    console.log("----------------------------------------------------------------");

    for (let addr = START_ADDR; addr <= END_ADDR; addr++) {
      try {
        // Читаємо ТІЛЬКИ ОДИН регістр за раз
        // await sleep(100); // Невелика пауза для стабільності
        const data = await client.readHoldingRegisters(addr, 1);

        if (data && data.data) {
          const raw = data.data[0];
          const scaled = (raw * 0.1).toFixed(1);

          let guess = "";

          // Евристика (вгадуємо за значенням)
          if (raw > 2000 && raw < 2500) guess = "<-- Мережа/Вихід 220-240В?";
          if (raw > 200 && raw < 600) guess = "<-- АКБ 24/48В?";
          if (raw === 5000) guess = "<-- Частота 50Гц?";
          if (raw >= 0 && raw <= 6) guess = "<-- Статус?";

          console.log(`${addr}    | ${raw.toString().padEnd(9)} | ${scaled.padEnd(13)} | ${guess}`);
        }
      } catch (err) {
        console.log(`${addr}    | ПОМИЛКА     |               | ${err.message}`);
        // Якщо помилка, пробуємо перевідкрити порт (іноді допомагає при зависанні)
        // але в простому випадку просто йдемо далі
      }
    }
  } catch (e) {
    console.error("Глобальна помилка:", e.message);
  } finally {
    client.close();
  }
}

sniff();
