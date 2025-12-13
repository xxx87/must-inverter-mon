🇺🇦 [Українська версія / Ukrainian version](README_UA.md)

# Must PV18 Solar Monitor & Control System ☀️🔋

This is an Open Source solution for local monitoring and control of **Must PV18** series solar inverters (specifically PV18-3024 VPM and similar models) using **Node.js** and **Raspberry Pi**.

The project allows you to abandon slow and internet-dependent Chinese Wi-Fi monitoring solutions in favor of a fully local, fast, and secure solution.

## 🚀 Features

- **⚡ Real-time monitoring:** Get data on voltage, current, load, and network status every few seconds.
- **📊 Local history:** Built-in **SQLite** database stores historical metrics. If the internet goes down, your data won't be lost.
- **🏠 Home Assistant:** Full integration via **MQTT** (Auto Discovery or manual configuration).
- **📈 Grafana / InfluxDB:** Send metrics to InfluxDB for professional graphing.
- **🖥️ Web UI:** Custom lightweight web interface (Dark Mode), optimized for Kiosk mode on Raspberry Pi with a small screen.
- **🛠️ Control:** Ability to change inverter settings (source priority, charging currents, etc.) via API.

---

## 📂 Project Structure and File Purposes

The repository contains not only the final application but also utilities that helped reverse-engineer the inverter protocol.

### 🔹 Main Files:

- **`server.js`** — **Main application file.** This is the "brain" of the system. It:
  - Starts an Express web server.
  - Polls the inverter via Modbus RTU in an infinite loop.
  - Manages a command queue for writes (changing settings).
  - Writes data to SQLite, MQTT, and InfluxDB.
- **`public/`** — Folder with web interface (HTML/CSS/JS) for displaying data in a browser.

### 🔹 Development and Debugging Utilities (Dev Tools):

- **`sniffer.js`** — **"Sniper".** Script for targeted data search. It reads registers one by one with error handling. Used to find correct addresses (match CSV documentation with reality) and determine address offsets.
- **`scan.js`** — **"Scanner".** Attempts to read registers in blocks (10-30 at a time). Helps quickly see an array of data, but may cause CRC errors on some controllers that don't support batch reading.
- **`monitor.js`** — **CLI monitor.** Simple version of the program without a web server and databases. Simply outputs current metrics to the Linux console. Perfect for quick connection testing.

---

## 🛠️ Requirements

1.  **Hardware:**
    - Raspberry Pi (any version, even 2B/3B) or any Linux/Windows PC.
    - USB Type-A → USB Type-B cable (standard "printer" cable) to connect to the inverter's USB port (it has a built-in USB-Serial chip).
2.  **Software:**
    - Node.js (v14 or higher).
    - User group `dialout` (for USB port access on Linux).

## ⚙️ Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/xxx87/must-inverter-mon.git
    cd must-inverter-mon
    ```

2.  **Install dependencies:**

    ```bash
    yarn install
    ```

3.  **Configuration:**
    Create a .env file and edit it according to your needs:

    ```bash
    cp .env.example .env
    ```

4.  **Run:**

    ```bash
    node server.js
    ```

    The web interface will be available at: `http://Your-Raspberry-IP:3000`

## 🏠 Home Assistant Integration

Data is published to the `home/solar/json` topic (full object) and individual topics. Example sensor configuration in `configuration.yaml`:

```yaml
mqtt:
  sensor:
    - name: "Solar Battery Voltage"
      state_topic: "home/solar/battery_v"
      unit_of_measurement: "V"
      device_class: voltage
    - name: "Solar Load Power"
      state_topic: "home/solar/load_power"
      unit_of_measurement: "W"
      device_class: power
```

## ⚠️ Disclaimer

This software is provided "as is". The author is not responsible for any equipment damage. Changing inverter settings through scripts is done at your own risk. Always check the documentation for your inverter model.

---

Created with ❤️ and Node.js
