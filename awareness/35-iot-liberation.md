# IoT Device Liberation — Flash Custom Firmware for Total Local Control

You help the user achieve **100% local control** of their IoT devices.
**NO cloud dependencies. NO third-party APIs. NO phone-home telemetry.**
The goal is SOVEREIGNTY: every device on the network obeys the user, not a corporation.

## WHY: Tuya/Sonoff cloud = remote control backdoor
- Tuya cloud can disable devices remotely, push firmware updates, collect usage data
- eWeLink (Sonoff) same problem — devices phone home constantly
- If the company goes bankrupt or changes ToS, devices become bricks
- **Solution**: Flash open-source firmware → pure local HTTP/MQTT control

## STRATEGY: Choose the right firmware

| Firmware | Protocol | Port | Best For | Config |
|----------|----------|------|----------|--------|
| **Tasmota** | HTTP REST + MQTT | 80 | Switches, plugs, lights, sensors | Web UI |
| **ESPHome** | HTTP API + MQTT | 80/6053 | HA integration, YAML config | YAML |
| **WLED** | HTTP + UDP | 80 | LED strips, addressable LEDs | Web UI |
| **OpenBeken** | HTTP + MQTT | 80 | BK7231/RTL8710 chips (newer Tuya) | Web UI |

### Which chip does the device have?
```bash
# Most Tuya devices pre-2022: ESP8266 or ESP8285 → use Tasmota or ESPHome
# Tuya devices 2022+: BK7231N or BK7231T → use OpenBeken or LibreTiny
# Sonoff devices: ESP8266 or ESP32 → use Tasmota
# To identify: check FCC ID on device label → search fcc.gov for internal photos
```

## METHOD 1: Tuya-Convert (OTA flash — NO soldering)

**Best for**: ESP8266/ESP8285 Tuya devices manufactured before ~2022.
Newer devices have patched the OTA vulnerability — use serial flash instead.

### Requirements
- Linux machine with WiFi adapter that supports AP mode
- The Tuya device in pairing mode (hold button 5-10s)
- Docker installed

### Steps
```bash
# 1. Clone tuya-convert
git clone https://github.com/ct-Open-Source/tuya-convert
cd tuya-convert

# 2. Install dependencies
./install_prereq.sh

# 3. Start the flash process
./start_flash.sh
# This creates a fake Tuya cloud AP
# When the device connects to pair, it intercepts and flashes custom firmware

# 4. Put device in pairing mode (hold button 5-10s until LED blinks fast)
# 5. Device connects to the fake AP
# 6. Choose firmware to flash:
#    - tasmota.bin (recommended for switches/plugs)
#    - tasmota-lite.bin (minimal, for devices with small flash)
#    - Or provide your own .bin file

# 7. After flash, device reboots with Tasmota
# Connect to WiFi AP "tasmota-XXXX" → configure your WiFi
```

### If tuya-convert fails (newer firmware):
```bash
# Check if device has new anti-flash firmware:
# - Device does NOT enter pairing mode normally
# - tuya-convert says "device not compatible"
# → Use serial flash method instead (Method 3)
```

## METHOD 2: ESPHome OTA (for devices already running Tasmota)

If device already has Tasmota, flash ESPHome over-the-air:
```bash
# 1. Install ESPHome
pip install esphome

# 2. Create config
cat > /tmp/tuya_device.yaml << 'EOF'
esphome:
  name: tuya-switch-1
  platform: ESP8266
  board: esp01_1m

wifi:
  ssid: "YOUR_WIFI"
  password: "YOUR_PASSWORD"

api:
  password: ""

ota:
  password: ""

switch:
  - platform: gpio
    name: "Tuya Switch"
    pin: GPIO12  # Most Tuya switches use GPIO12 for relay
    id: relay

binary_sensor:
  - platform: gpio
    name: "Tuya Button"
    pin:
      number: GPIO0  # Most Tuya devices use GPIO0 for button
      inverted: true
    on_press:
      - switch.toggle: relay

status_led:
  pin:
    number: GPIO13  # Status LED (varies by device)
    inverted: true
EOF

# 3. Compile and flash OTA (if device is already running Tasmota)
esphome run /tmp/tuya_device.yaml
# Enter the device's IP when prompted
```

## METHOD 3: Serial Flash (hardware — works on ALL devices)

**For devices where OTA doesn't work** (newer firmware, BK7231 chips, etc.)
Requires: USB-to-serial adapter (FTDI, CP2102, CH340) ~$3

### For ESP8266/ESP8285 (Tuya pre-2022, all Sonoff):
```bash
# 1. Open device, find UART pads (3.3V, GND, TX, RX)
# 2. Connect USB-serial adapter:
#    Adapter TX → Device RX
#    Adapter RX → Device TX
#    Adapter GND → Device GND
#    Adapter 3.3V → Device 3.3V (or power device normally)
#    GPIO0 → GND (to enter flash mode)

# 3. Flash Tasmota
pip install esptool
esptool.py --port /dev/ttyUSB0 --baud 115200 write_flash -fs 1MB -fm dout 0x0 tasmota.bin

# Download latest tasmota.bin:
# wget http://ota.tasmota.com/tasmota/release/tasmota.bin
```

### For BK7231N/BK7231T (newer Tuya 2022+):
```bash
# These chips are NOT ESP — use ltchiptool instead
pip install ltchiptool

# 1. Connect USB-serial adapter (same wiring as ESP)
# 2. Enter flash mode: hold CEN button while powering on

# 3. Read current firmware (backup!)
ltchiptool flash read bk7231n /dev/ttyUSB0 /tmp/backup_firmware.bin

# 4. Flash OpenBeken
# Download from: https://github.com/openshwprojects/OpenBK7231T_App/releases
ltchiptool flash write /dev/ttyUSB0 OpenBK7231N_1.17.315.bin

# After flash, connect to WiFi AP "OpenBK7231N_XXXX" → configure
```

### For RTL8710BN (some newer Tuya):
```bash
# Use ltchiptool (same tool, different chip)
ltchiptool flash read rtl8710bn /dev/ttyUSB0 /tmp/backup.bin
ltchiptool flash write /dev/ttyUSB0 OpenRTL8710BN_firmware.bin
```

## POST-FLASH: Control Commands (Tasmota)

After flashing Tasmota, control is via simple HTTP — **NO keys, NO encryption, NO cloud**:

```bash
# Turn ON
curl http://192.168.1.X/cm?cmnd=Power%20On

# Turn OFF
curl http://192.168.1.X/cm?cmnd=Power%20Off

# Toggle
curl http://192.168.1.X/cm?cmnd=Power%20Toggle

# Get status
curl http://192.168.1.X/cm?cmnd=Status%200

# Set WiFi
curl "http://192.168.1.X/cm?cmnd=Backlog%20SSID1%20MyWiFi%3BPassword1%20MyPass"

# Set MQTT broker (for Home Assistant)
curl "http://192.168.1.X/cm?cmnd=Backlog%20MqttHost%20192.168.1.100%3BMqttUser%20mqtt%3BMqttPassword%20pass"

# OTA update
curl "http://192.168.1.X/cm?cmnd=OtaUrl%20http://ota.tasmota.com/tasmota/release/tasmota.bin"
curl http://192.168.1.X/cm?cmnd=Upgrade%201

# Restart
curl http://192.168.1.X/cm?cmnd=Restart%201

# Set device name
curl "http://192.168.1.X/cm?cmnd=DeviceName%20Living%20Room%20Light"

# For LIGHTS (Tasmota with PWM/RGB):
curl http://192.168.1.X/cm?cmnd=Dimmer%2050        # 50% brightness
curl http://192.168.1.X/cm?cmnd=Color%20FF0000      # Red
curl http://192.168.1.X/cm?cmnd=CT%20300             # Color temp 300 (warm)
curl http://192.168.1.X/cm?cmnd=Scheme%203           # Color cycle effect
```

### Tasmota Templates (common Tuya devices)
```bash
# After flashing, configure the GPIO template for your device.
# Find your device template at: https://templates.blakadder.com/

# Apply template via HTTP:
curl "http://192.168.1.X/cm?cmnd=Template%20{YOUR_TEMPLATE_JSON}"
curl http://192.168.1.X/cm?cmnd=Module%200  # Activate template
```

## POST-FLASH: Control Commands (OpenBeken for BK7231)

```bash
# Turn ON (channel 1)
curl http://192.168.1.X/cm?cmnd=POWER%20ON

# Turn OFF
curl http://192.168.1.X/cm?cmnd=POWER%20OFF

# Get status
curl http://192.168.1.X/api/status

# OpenBeken is mostly Tasmota-compatible for HTTP commands
```

## POST-FLASH: Control Commands (ESPHome)

```bash
# ESPHome uses its native API on port 6053, but also supports HTTP:
curl http://192.168.1.X/switch/tuya_switch/turn_on
curl http://192.168.1.X/switch/tuya_switch/turn_off
curl http://192.168.1.X/switch/tuya_switch/toggle

# For lights:
curl -X POST http://192.168.1.X/light/tuya_light/turn_on -d '{"brightness": 200}'
curl http://192.168.1.X/light/tuya_light/turn_off
```

## Metasploit Integration (post-flash devices)

Once devices run Tasmota/OpenBeken, they're simple HTTP servers — easy MSF targets:
```bash
# Discover all Tasmota devices
msfconsole -q -x "use auxiliary/scanner/http/http_version; set RHOSTS 192.168.1.0/24; set RPORT 80; set THREADS 20; run; exit"

# Mass control via MSF Ruby
cat > /tmp/tasmota_control.rc << 'RCEOF'
<ruby>
require 'net/http'
require 'json'

# IPs of flashed Tasmota devices
targets = %w[192.168.1.21 192.168.1.90]

targets.each do |ip|
  begin
    # Get status
    uri = URI("http://#{ip}/cm?cmnd=Status%200")
    res = Net::HTTP.get_response(uri)
    if res.code == "200"
      info = JSON.parse(res.body) rescue {}
      name = info.dig("Status", "DeviceName") || "unknown"
      power = info.dig("Status", "Power") || "?"
      print_good("#{ip} — #{name} — Power: #{power}")

      # Turn ON
      Net::HTTP.get(URI("http://#{ip}/cm?cmnd=Power%20On"))
      print_good("#{ip} — TURNED ON")
    else
      print_error("#{ip} — HTTP #{res.code}")
    end
  rescue => e
    print_error("#{ip} — #{e.message}")
  end
end
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/tasmota_control.rc
```

## Batch Flash Script (flash multiple devices)
```bash
#!/bin/bash
# Flash all Tuya devices on the network with Tasmota
# Requires: devices already in Tasmota (for OTA) or tuya-convert for first flash

TASMOTA_URL="http://ota.tasmota.com/tasmota/release/tasmota.bin"

# List of device IPs to OTA update
DEVICES=(192.168.1.21 192.168.1.90)

for ip in "${DEVICES[@]}"; do
    echo "=== Flashing $ip ==="
    # Set OTA URL
    curl -s "http://$ip/cm?cmnd=OtaUrl%20$TASMOTA_URL" > /dev/null
    # Trigger upgrade
    result=$(curl -s "http://$ip/cm?cmnd=Upgrade%201")
    echo "  $ip: $result"
    echo "  Waiting 60s for reboot..."
    sleep 60
    # Verify
    status=$(curl -s "http://$ip/cm?cmnd=Status" 2>/dev/null)
    if [ -n "$status" ]; then
        echo "  $ip: ONLINE after flash"
    else
        echo "  $ip: still rebooting or failed"
    fi
done
```

## GPIO Pinouts (common Tuya devices)

| Device Type | Relay | Button | LED | LED_i |
|-------------|-------|--------|-----|-------|
| Tuya plug (generic) | GPIO12 | GPIO0 | GPIO13 | yes |
| Tuya bulb E27 | PWM: GPIO4,5,12,14 | — | — | — |
| Tuya power strip | GPIO12,5,4,15 | GPIO16 | GPIO2 | yes |
| Sonoff Basic | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff Mini | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff S26 plug | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff TH | GPIO12 | GPIO0 | GPIO13 | yes |

## Decision Tree

```
Device has ESP8266/ESP8285?
├── YES → tuya-convert (OTA, no soldering)
│   ├── Works → Flash Tasmota → HTTP control on port 80
│   └── Fails (new firmware) → Serial flash with esptool
│
├── Device has BK7231N/T?
│   └── Serial flash with ltchiptool → OpenBeken → HTTP control
│
├── Device has RTL8710BN?
│   └── Serial flash with ltchiptool → OpenBeken → HTTP control
│
└── Unknown chip?
    └── Open device → identify chip markings → search templates.blakadder.com
```

## Key Points
- **After flashing**: devices are simple HTTP servers — `curl` controls everything
- **NO keys, NO encryption, NO cloud** — pure local HTTP on port 80
- **Tasmota web UI**: browse to device IP for visual control + configuration
- **MQTT**: connect to local broker for Home Assistant/Node-RED integration
- **OTA updates**: controlled by YOU, not by Tuya's cloud servers
- **Backup first**: always dump original firmware before flashing (for rollback)
