const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;

// Налаштування порту жорстко, як в mbpoll
const OPTIONS = {
  baudRate: 19200,
  dataBits: 8,
  stopBits: 1,
  parity: "none"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readInverter() {
  try {
    console.log("1. Відкриваємо порт...");
    await client.connectRTU(SERIAL_PORT, OPTIONS);

    // ВАЖЛИВО: Встановлюємо ID і таймаут ПІСЛЯ відкриття
    client.setID(SLAVE_ID);
    client.setTimeout(2000); // Збільшуємо таймаут до 2 сек

    console.log("2. Чекаємо стабілізації лінії (1 сек)...");
    await sleep(1000); // Даємо інвертору "покашляти"

    // ВАЖЛИВО: Іноді в буфері лежить сміття від попереднього підключення.
    // Можна спробувати очистити його порожнім читанням, але поки просто читаємо акуратно.

    console.log("3. Читаємо ОДИН регістр (Battery Voltage)...");

    // Адреса 25205 (CSV) -> 25204 (Код). Читаємо довжину 1.
    // Якщо знову CRC error, спробуємо readInputRegisters замість readHoldingRegisters
    const data = await client.readHoldingRegisters(25204, 1);

    if (data && data.data) {
      const rawVal = data.data[0];
      const voltage = rawVal * 0.1;
      console.log(`>>> УСПІХ! Raw: ${rawVal}, Напруга АКБ: ${voltage.toFixed(1)} V`);
    } else {
      console.log("Дані порожні");
    }
  } catch (e) {
    console.error("!!! ПОМИЛКА:", e.message);
    if (e.name === "TransactionTimedOutError") {
      console.error("Порада: Інвертор не відповів вчасно. Перевір ID і швидкість.");
    }
  } finally {
    client.close(() => {
      console.log("Порт закрито.");
    });
  }
}

readInverter();
