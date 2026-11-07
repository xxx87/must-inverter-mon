#!/usr/bin/env python3
"""Poll JBD/Xiaoxiang BMS over BLE via BlueZ D-Bus."""
import argparse
import asyncio
import json
import sys
import time

from dbus_fast.aio import MessageBus
from dbus_fast.constants import BusType
from dbus_fast import Variant

BLUEZ = "org.bluez"
ADAPTER = "/org/bluez/hci0"
NOTIFY_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"
CMD_BASIC = bytes([0xDD, 0xA5, 0x03, 0x00, 0xFF, 0xFD, 0x77])
CMD_CELLS = bytes([0xDD, 0xA5, 0x04, 0x00, 0xFF, 0xFC, 0x77])


def mac_to_path(mac: str) -> str:
    return f"{ADAPTER}/dev_" + mac.upper().replace(":", "_")


def u16(buf, offset):
    return (buf[offset] << 8) | buf[offset + 1]


def s16(buf, offset):
    v = u16(buf, offset)
    return v - 0x10000 if v > 0x7FFF else v


def extract_frames(buf: bytearray):
    frames = []
    start = -1
    for i, b in enumerate(buf):
        if b == 0xDD:
            start = i
        if start >= 0 and b == 0x77 and i > start:
            frames.append(bytes(buf[start : i + 1]))
            start = -1
    return frames


def parse_basic(frame: bytes):
    if len(frame) < 27 or frame[0] != 0xDD or frame[1] != 0x03 or frame[-1] != 0x77:
        return None
    if frame[2] != 0x00:
        return None
    length = frame[3]
    d = frame[4 : 4 + length]
    if len(d) < 23:
        return None
    ntc_count = d[22]
    temps = []
    off = 23
    for _ in range(ntc_count):
        if off + 1 >= len(d):
            break
        raw = u16(d, off)
        temps.append(round((raw - 2731) / 10, 1))
        off += 2
    voltage = round(u16(d, 0) / 100, 2)
    current = round(s16(d, 2) / 100, 2)
    return {
        "voltage": voltage,
        "current": current,
        "power": round(voltage * current, 1),
        "soc": d[19],
        "capacity_ah": round(u16(d, 4) / 100, 2),
        "full_capacity_ah": round(u16(d, 6) / 100, 2),
        "cycles": u16(d, 8),
        "protection": u16(d, 16),
        "fet": d[20],
        "cell_count": d[21],
        "temperatures": temps,
        "temperature": temps[0] if temps else None,
    }


def parse_cells(frame: bytes):
    if len(frame) < 7 or frame[0] != 0xDD or frame[1] != 0x04 or frame[-1] != 0x77:
        return None
    if frame[2] != 0x00:
        return None
    length = frame[3]
    d = frame[4 : 4 + length]
    cells = [u16(d, i) for i in range(0, len(d) - 1, 2)]
    if not cells:
        return None
    return {
        "cells_mv": cells,
        "cell_min_mv": min(cells),
        "cell_max_mv": max(cells),
        "cell_delta_mv": max(cells) - min(cells),
    }


async def get_managed_objects(bus):
    intro = await bus.introspect(BLUEZ, "/")
    obj = bus.get_proxy_object(BLUEZ, "/", intro)
    manager = obj.get_interface("org.freedesktop.DBus.ObjectManager")
    return await manager.call_get_managed_objects()


async def ensure_powered(bus):
    intro = await bus.introspect(BLUEZ, ADAPTER)
    obj = bus.get_proxy_object(BLUEZ, ADAPTER, intro)
    props = obj.get_interface("org.freedesktop.DBus.Properties")
    powered = await props.call_get("org.bluez.Adapter1", "Powered")
    if not powered.value:
        await props.call_set("org.bluez.Adapter1", "Powered", Variant("b", True))


async def discover_until(bus, mac: str, timeout: float = 12.0):
    path = mac_to_path(mac)
    intro = await bus.introspect(BLUEZ, ADAPTER)
    obj = bus.get_proxy_object(BLUEZ, ADAPTER, intro)
    adapter = obj.get_interface("org.bluez.Adapter1")
    try:
        await adapter.call_set_discovery_filter({"Transport": Variant("s", "le")})
    except Exception:
        pass
    await adapter.call_start_discovery()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            objects = await get_managed_objects(bus)
            if path in objects:
                return path
            await asyncio.sleep(0.4)
    finally:
        try:
            await adapter.call_stop_discovery()
        except Exception:
            pass
    raise RuntimeError(f"not found: {mac}")


async def wait_prop(props, iface, name, want, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        val = await props.call_get(iface, name)
        if val.value == want:
            return True
        await asyncio.sleep(0.25)
    return False


async def poll_one(mac: str):
    mac = mac.upper()
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    await ensure_powered(bus)
    path = await discover_until(bus, mac)

    intro = await bus.introspect(BLUEZ, path)
    dev_obj = bus.get_proxy_object(BLUEZ, path, intro)
    device = dev_obj.get_interface("org.bluez.Device1")
    props = dev_obj.get_interface("org.freedesktop.DBus.Properties")

    try:
        await props.call_set("org.bluez.Device1", "Trusted", Variant("b", True))
    except Exception:
        pass

    connected = (await props.call_get("org.bluez.Device1", "Connected")).value
    if not connected:
        await device.call_connect()
        ok = await wait_prop(props, "org.bluez.Device1", "Connected", True, 12)
        if not ok:
            raise RuntimeError("connect failed")

    ok = await wait_prop(props, "org.bluez.Device1", "ServicesResolved", True, 15)
    if not ok:
        raise RuntimeError("services not resolved")

    # refresh introspection after services appear
    await asyncio.sleep(0.5)
    objects = await get_managed_objects(bus)
    notify_path = write_path = None
    for obj_path, ifaces in objects.items():
        if not obj_path.startswith(path + "/"):
            continue
        char = ifaces.get("org.bluez.GattCharacteristic1")
        if not char:
            continue
        uuid = char["UUID"].value.lower()
        if uuid == NOTIFY_UUID:
            notify_path = obj_path
        elif uuid == WRITE_UUID:
            write_path = obj_path
    if not notify_path or not write_path:
        raise RuntimeError("FF01/FF02 not found")

    n_intro = await bus.introspect(BLUEZ, notify_path)
    w_intro = await bus.introspect(BLUEZ, write_path)
    n_obj = bus.get_proxy_object(BLUEZ, notify_path, n_intro)
    w_obj = bus.get_proxy_object(BLUEZ, write_path, w_intro)
    notify = n_obj.get_interface("org.bluez.GattCharacteristic1")
    write = w_obj.get_interface("org.bluez.GattCharacteristic1")
    n_props = n_obj.get_interface("org.freedesktop.DBus.Properties")

    rx = bytearray()
    basic = None
    cells = None
    done = asyncio.Event()

    def on_props_changed(iface, changed, _invalidated):
        nonlocal basic, cells
        if iface != "org.bluez.GattCharacteristic1":
            return
        if "Value" not in changed:
            return
        data = bytes(changed["Value"].value)
        rx.extend(data)
        for frame in extract_frames(rx):
            b = parse_basic(frame)
            if b:
                basic = b
            c = parse_cells(frame)
            if c:
                cells = c
        if basic and cells:
            done.set()
        elif basic and len(rx) > 40:
            done.set()

    n_props.on_properties_changed(on_props_changed)
    await notify.call_start_notify()
    await asyncio.sleep(0.2)
    await write.call_write_value(CMD_BASIC, {"type": Variant("s", "command")})
    await asyncio.sleep(0.4)
    await write.call_write_value(CMD_CELLS, {"type": Variant("s", "command")})

    try:
        await asyncio.wait_for(done.wait(), timeout=8.0)
    except asyncio.TimeoutError:
        pass
    if basic and not cells:
        await asyncio.sleep(1.5)
    try:
        await notify.call_stop_notify()
    except Exception:
        pass
    try:
        await device.call_disconnect()
    except Exception:
        pass

    if not basic:
        raise RuntimeError("no basic frame")
    out = dict(basic)
    if cells:
        out.update(cells)
    out["mac"] = mac.lower()
    out["timestamp"] = int(time.time() * 1000)
    return out


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mac", required=True)
    parser.add_argument("--id", required=True)
    args = parser.parse_args()
    try:
        data = await poll_one(args.mac)
        data["id"] = args.id
        print(json.dumps(data, separators=(",", ":")))
    except Exception as e:
        print(
            json.dumps({"id": args.id, "mac": args.mac.lower(), "error": str(e)}),
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
