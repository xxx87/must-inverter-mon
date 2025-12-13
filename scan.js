const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const SERIAL_PORT = "/dev/ttyUSB0";
const SLAVE_ID = 4;
const START_ADDR = 25200; // Начало блока Display Message (по проводу)
const COUNT = 30; // Сколько регистров прочитать

const OPTIONS = {
  baudRate: 19200,
  dataBits: 8,
  stopBits: 1,
  parity: "none"
};

async function scanRegisters() {
  try {
    await client.connectRTU(SERIAL_PORT, OPTIONS);
    client.setID(SLAVE_ID);
    client.setTimeout(2000);

    console.log(`--- СКАНИРОВАНИЕ РЕГИСТРОВ [${START_ADDR} .. ${START_ADDR + COUNT}] ---`);

    // Читаем блок данных
    const data = await client.readHoldingRegisters(START_ADDR, COUNT);
    const registers = data.data;

    console.log("Wire Addr\tЗначение\tГипотеза (из CSV)");
    console.log("-------------------------------------------------------------");

    for (let i = 0; i < registers.length; i++) {
      const addr = START_ADDR + i;
      const val = registers[i];

      // Пытаемся угадать, что это за число
      let comment = "";

      // Проверка на статус (Work State, 25201 CSV)
      if (val >= 0 && val <= 6) comment += "[Статус?] ";

      // Проверка на напряжение (~220-240V -> 2200-2400)
      if (val > 2000 && val < 2500) comment += "[220V AC?] ";

      // Проверка на напряжение батареи (~12V/24V/48V -> 120/240/480)
      if (val > 100 && val < 600) comment += "[Батарея V?] ";

      // Проверка на частоту (50.00Hz -> 5000)
      if (val === 5000 || val === 6000) comment += "[50/60 Hz] ";

      console.log(`${addr}\t\t${val}\t\t${comment}`);
    }
  } catch (e) {
    console.error("Ошибка сканирования:", e.message);
  } finally {
    client.close();
  }
}

scanRegisters();
