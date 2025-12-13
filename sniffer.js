const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;
const OPTIONS = { baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none" };

// Диапазон поиска. Судя по CSV, самое интересное лежит тут:
// 25205 (Battery V), 25206 (Inverter V), 25207 (Grid V)
// Начнем немного заранее, чтобы поймать смещение.
const START_ADDR = 25200;
const END_ADDR = 25220;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sniff() {
  try {
    await client.connectRTU(SERIAL_PORT, OPTIONS);
    client.setID(SLAVE_ID);
    client.setTimeout(1500);

    console.log(`Подключено. Сканируем по одному регистру с ${START_ADDR} по ${END_ADDR}...`);
    console.log("----------------------------------------------------------------");
    console.log("WireAddr | Raw Value | Значение / 10 | Гипотеза");
    console.log("----------------------------------------------------------------");

    for (let addr = START_ADDR; addr <= END_ADDR; addr++) {
      try {
        // Читаем ТОЛЬКО ОДИН регистр за раз
        // await sleep(100); // Небольшая пауза для стабильности
        const data = await client.readHoldingRegisters(addr, 1);

        if (data && data.data) {
          const raw = data.data[0];
          const scaled = (raw * 0.1).toFixed(1);

          let guess = "";

          // Эвристика (гадаем по значению)
          if (raw > 2000 && raw < 2500) guess = "<-- Сеть/Выход 220-240В?";
          if (raw > 200 && raw < 600) guess = "<-- АКБ 24/48В?";
          if (raw === 5000) guess = "<-- Частота 50Гц?";
          if (raw >= 0 && raw <= 6) guess = "<-- Статус?";

          console.log(`${addr}    | ${raw.toString().padEnd(9)} | ${scaled.padEnd(13)} | ${guess}`);
        }
      } catch (err) {
        console.log(`${addr}    | ERROR     |               | ${err.message}`);
        // Если ошибка, пробуем переоткрыть порт (иногда помогает при зависании)
        // но в простом случае просто идем дальше
      }
    }
  } catch (e) {
    console.error("Глобальная ошибка:", e.message);
  } finally {
    client.close();
  }
}

sniff();
