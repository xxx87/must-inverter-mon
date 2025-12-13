const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;

// Настройки порта жестко, как в mbpoll
const OPTIONS = {
  baudRate: 19200,
  dataBits: 8,
  stopBits: 1,
  parity: "none"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readInverter() {
  try {
    console.log("1. Открываем порт...");
    await client.connectRTU(SERIAL_PORT, OPTIONS);

    // ВАЖНО: Устанавливаем ID и таймаут ПОСЛЕ открытия
    client.setID(SLAVE_ID);
    client.setTimeout(2000); // Увеличим таймаут до 2 сек

    console.log("2. Ждем стабилизации линии (1 сек)...");
    await sleep(1000); // Даем инвертору "прокашляться"

    // ВАЖНО: Иногда в буфере лежит мусор от прошлого подключения.
    // Можно попробовать очистить его пустым чтением, но пока просто читаем аккуратно.

    console.log("3. Читаем ОДИН регистр (Battery Voltage)...");

    // Адрес 25205 (CSV) -> 25204 (Код). Читаем длину 1.
    // Если снова CRC error, попробуем readInputRegisters вместо readHoldingRegisters
    const data = await client.readHoldingRegisters(25204, 1);

    if (data && data.data) {
      const rawVal = data.data[0];
      const voltage = rawVal * 0.1;
      console.log(`>>> УСПЕХ! Raw: ${rawVal}, Напряжение АКБ: ${voltage.toFixed(1)} V`);
    } else {
      console.log("Данные пусты");
    }
  } catch (e) {
    console.error("!!! ОШИБКА:", e.message);
    if (e.name === "TransactionTimedOutError") {
      console.error("Совет: Инвертор не ответил вовремя. Проверь ID и скорость.");
    }
  } finally {
    client.close(() => {
      console.log("Порт закрыт.");
    });
  }
}

readInverter();
