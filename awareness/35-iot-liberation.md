# IoT Device Liberation — Flash Custom Firmware for Total Local Control

You help the user achieve **100% local control** of their IoT devices.
**NO cloud dependencies. NO third-party APIs. NO phone-home telemetry.**
The goal is SOVEREIGNTY: every device on the network obeys the user, not a corporation.

## WHY: Tuya/Sonoff cloud = remote control backdoor
- Tuya cloud can disable devices remotely, push firmware updates, collect usage data
- eWeLink (Sonoff) same problem — devices phone home constantly
- If the company goes bankrupt or changes ToS, devices become bricks
- **Solution**: Flash open-source firmware → pure local HTTP/MQTT control

## PRIORITY: The user has Tuya WiFi LIGHT BULBS (lámparas RGBCW)
- Tuya bulbs on this network: 192.168.1.21 (v3.5), 192.168.1.90 (v3.5)
- These are LIGHT BULBS with RGB + Cold White + Warm White channels
- NOT switches, NOT plugs — they have 5 PWM channels for color/brightness
- Tuya bulbs typically use: ESP8266 (pre-2022) or BK7231 (2022+)

## STRATEGY: Choose the right firmware

| Firmware | Best For | Light Support | Config |
|----------|----------|---------------|--------|
| **Tasmota** | Bulbs, switches, all | Full RGBCW, scenes, dimming, CT | Web UI, HTTP, MQTT |
| **ESPHome** | HA integration | Full RGBCW, effects, transitions | YAML |
| **WLED** | LED strips, addressable | WS2812B, SK6812, best effects | Web UI, UDP |
| **OpenBeken** | BK7231/RTL chips (2022+) | Full RGBCW, Tasmota-compatible | Web UI |

### Which chip? (determines flash method)
```bash
# Tuya bulbs pre-2022: ESP8266 → Tasmota via tuya-convert (OTA, no soldering!)
# Tuya bulbs 2022+: BK7231N/T → OpenBeken via ltchiptool (serial flash required)
# Check: FCC ID on bulb label → search fcc.gov for internal photos
# Or: open bulb carefully, look at chip markings (ESP8266, BK7231N, etc.)
```

## METHOD 1: Tuya-Convert (OTA flash — NO soldering, BEST for bulbs)

**Best for**: ESP8266/ESP8285 Tuya bulbs manufactured before ~2022.
Bulbs are IDEAL for tuya-convert because they're easy to put in pairing mode.

### Steps
```bash
# 1. Clone tuya-convert
git clone https://github.com/ct-Open-Source/tuya-convert
cd tuya-convert

# 2. Install dependencies
./install_prereq.sh

# 3. Start the flash process
./start_flash.sh

# 4. Put bulb in pairing mode:
#    Turn OFF → ON → OFF → ON → OFF → ON (3 quick toggles)
#    Bulb blinks rapidly = pairing mode
#    Some bulbs: turn OFF → wait 5s → ON → OFF → ON → OFF → ON

# 5. Choose firmware:
#    - tasmota.bin (full features, recommended)
#    - tasmota-lite.bin (if bulb has only 1MB flash)

# 6. After flash, bulb creates WiFi AP "tasmota-XXXX"
#    Connect to it → go to 192.168.4.1 → configure your WiFi
```

### If tuya-convert fails (newer firmware patched):
```bash
# Newer Tuya bulbs block OTA exploit
# → Must use serial flash (METHOD 3)
# Or try: downgrade Tuya firmware first via tuya-convert's backup/restore
```

## METHOD 2: Serial Flash for Bulbs (works on ALL chips)

### For ESP8266 bulbs:
```bash
# 1. Open bulb (twist off diffuser dome, pry apart carefully)
# 2. Find UART pads on PCB: 3V3, GND, TX, RX, GPIO0
# 3. Solder thin wires or use pogo pins / test clips
# 4. Connect USB-serial adapter (CP2102/CH340/FTDI):
#    Adapter TX → Bulb RX
#    Adapter RX → Bulb TX
#    Adapter GND → Bulb GND
#    GPIO0 → GND (hold during power-on to enter flash mode)
#    Power bulb from adapter 3V3 OR its own power (NOT both!)

# 5. Flash Tasmota
pip install esptool

# Backup original firmware first!
esptool.py --port /dev/ttyUSB0 read_flash 0x0 0x100000 /tmp/bulb_backup.bin

# Flash Tasmota (use tasmota.bin for bulbs, NOT tasmota-lite)
wget http://ota.tasmota.com/tasmota/release/tasmota.bin
esptool.py --port /dev/ttyUSB0 --baud 115200 write_flash -fs 1MB -fm dout 0x0 tasmota.bin
```

### For BK7231 bulbs (2022+ Tuya):
```bash
pip install ltchiptool

# Backup
ltchiptool flash read bk7231n /dev/ttyUSB0 /tmp/bulb_backup_bk.bin

# Flash OpenBeken (download from GitHub releases)
# https://github.com/openshwprojects/OpenBK7231T_App/releases
ltchiptool flash write /dev/ttyUSB0 OpenBK7231N_latest.bin
```

## METHOD 3: ESPHome for Bulbs (OTA from Tasmota)

If bulb already runs Tasmota, flash ESPHome OTA:
```bash
pip install esphome

cat > /tmp/tuya_bulb.yaml << 'EOF'
esphome:
  name: tuya-lamp-1
  platform: ESP8266
  board: esp01_1m

wifi:
  ssid: "YOUR_WIFI"
  password: "YOUR_PASSWORD"

api:
ota:

# Tuya RGBCW bulb — 5 PWM output channels
# ADJUST GPIOs to match your specific bulb model!
output:
  - platform: esp8266_pwm
    id: output_red
    pin: GPIO4
  - platform: esp8266_pwm
    id: output_green
    pin: GPIO12
  - platform: esp8266_pwm
    id: output_blue
    pin: GPIO14
  - platform: esp8266_pwm
    id: output_cold_white
    pin: GPIO5
  - platform: esp8266_pwm
    id: output_warm_white
    pin: GPIO13

light:
  - platform: rgbww
    name: "Tuya Lamp"
    red: output_red
    green: output_green
    blue: output_blue
    cold_white: output_cold_white
    warm_white: output_warm_white
    cold_white_color_temperature: 6500 K
    warm_white_color_temperature: 2700 K
    effects:
      - random:
      - strobe:
      - flicker:
EOF

esphome run /tmp/tuya_bulb.yaml
```

## POST-FLASH: Tasmota Light Bulb Configuration

### Step 1: Set the correct module/template for your bulb
```bash
# CRITICAL: After flashing, you MUST configure the GPIO template
# or the bulb won't produce light correctly

# Option A: Use a known template from https://templates.blakadder.com/
# Search for your bulb model, copy the template JSON, then:
curl "http://BULB_IP/cm?cmnd=Template%20{\"NAME\":\"Tuya%20RGBCW\",\"GPIO\":[0,0,0,0,37,40,0,0,38,41,39,0,0],\"FLAG\":0,\"BASE\":18}"
curl http://BULB_IP/cm?cmnd=Module%200

# Option B: Generic Tuya RGBCW template (works for MANY bulbs)
# GPIO4=PWM1(Red), GPIO12=PWM2(Green), GPIO14=PWM3(Blue)
# GPIO5=PWM4(ColdWhite), GPIO13=PWM5(WarmWhite)
curl "http://BULB_IP/cm?cmnd=Template%20{\"NAME\":\"GenericRGBCW\",\"GPIO\":[0,0,0,0,416,419,0,0,417,420,418,0,0],\"FLAG\":0,\"BASE\":18}"
curl http://BULB_IP/cm?cmnd=Module%200

# Option C: If only Cold White + Warm White (no RGB)
curl "http://BULB_IP/cm?cmnd=Template%20{\"NAME\":\"TuyaCW\",\"GPIO\":[0,0,0,0,0,419,0,0,0,420,0,0,0],\"FLAG\":0,\"BASE\":18}"
curl http://BULB_IP/cm?cmnd=Module%200
```

### Step 2: Configure light behavior
```bash
# Set color mode to RGBCW (5 channels)
curl http://BULB_IP/cm?cmnd=SetOption37%20128

# Set light type (important for proper color mixing)
# 0=default, 1=single channel, 2=CW, 3=RGB, 4=RGBW, 5=RGBCW
curl http://BULB_IP/cm?cmnd=SetOption15%201   # Use PWM frequency for LEDs

# Set PWM frequency (recommended 1000Hz for bulbs, reduces flicker)
curl http://BULB_IP/cm?cmnd=PwmFrequency%201000

# Fade ON (smooth transitions)
curl http://BULB_IP/cm?cmnd=Fade%201
curl http://BULB_IP/cm?cmnd=Speed%204          # Fade speed 1-40
```

## POST-FLASH: Light Control Commands (Tasmota)

**NO keys, NO encryption, NO cloud — pure HTTP:**

```bash
IP="192.168.1.21"  # Replace with your bulb IP

# ─── ON/OFF ───
curl http://$IP/cm?cmnd=Power%20On
curl http://$IP/cm?cmnd=Power%20Off
curl http://$IP/cm?cmnd=Power%20Toggle

# ─── BRIGHTNESS (0-100%) ───
curl http://$IP/cm?cmnd=Dimmer%20100            # Full brightness
curl http://$IP/cm?cmnd=Dimmer%2050             # 50%
curl http://$IP/cm?cmnd=Dimmer%2010             # Night light
curl http://$IP/cm?cmnd=Dimmer%20+              # Increase 10%
curl http://$IP/cm?cmnd=Dimmer%20-              # Decrease 10%

# ─── RGB COLOR (hex RRGGBB or named) ───
curl http://$IP/cm?cmnd=Color%20FF0000          # Red
curl http://$IP/cm?cmnd=Color%2000FF00          # Green
curl http://$IP/cm?cmnd=Color%200000FF          # Blue
curl http://$IP/cm?cmnd=Color%20FF6600          # Orange
curl http://$IP/cm?cmnd=Color%20FF00FF          # Purple/Magenta
curl http://$IP/cm?cmnd=Color%2000FFFF          # Cyan
curl http://$IP/cm?cmnd=Color%20FFFFFF          # White (RGB)
curl http://$IP/cm?cmnd=Color%20000000FF00      # Pure Cold White (via CW channel)
curl http://$IP/cm?cmnd=Color%200000000000FF    # Pure Warm White (via WW channel)

# ─── COLOR TEMPERATURE (153=cold 6500K to 500=warm 2200K) ───
curl http://$IP/cm?cmnd=CT%20153                # Daylight (cold)
curl http://$IP/cm?cmnd=CT%20250                # Neutral
curl http://$IP/cm?cmnd=CT%20350                # Warm white
curl http://$IP/cm?cmnd=CT%20500                # Candle (warmest)

# ─── HSB COLOR (Hue 0-360, Saturation 0-100, Brightness 0-100) ───
curl http://$IP/cm?cmnd=HsbColor%200,100,100    # Red
curl http://$IP/cm?cmnd=HsbColor%20120,100,100  # Green
curl http://$IP/cm?cmnd=HsbColor%20240,100,100  # Blue
curl http://$IP/cm?cmnd=HsbColor1%20180         # Set hue only (cyan)

# ─── WHITE MODE (switch from RGB to white channels) ───
curl http://$IP/cm?cmnd=White%20100             # Full white (CW+WW channels)
curl http://$IP/cm?cmnd=White%2050              # 50% white

# ─── EFFECTS/SCENES ───
curl http://$IP/cm?cmnd=Scheme%200              # Single color (default)
curl http://$IP/cm?cmnd=Scheme%201              # Wake up (gradually brightens)
curl http://$IP/cm?cmnd=Scheme%202              # RGB cycle
curl http://$IP/cm?cmnd=Scheme%203              # Random color cycle
curl http://$IP/cm?cmnd=Scheme%204              # Color temperature cycle

# ─── MULTI-COMMAND (Backlog) ───
# Set color + brightness + fade in one request:
curl "http://$IP/cm?cmnd=Backlog%20Color%20FF0000%3BDimmer%20100%3BFade%201%3BSpeed%204"

# ─── GET STATUS ───
curl http://$IP/cm?cmnd=Status%200              # Full status
curl http://$IP/cm?cmnd=Status%2011             # Light status specifically
curl http://$IP/cm?cmnd=Color                    # Current color
curl http://$IP/cm?cmnd=Dimmer                   # Current brightness
curl http://$IP/cm?cmnd=CT                       # Current color temp
```

## POST-FLASH: OpenBeken Light Commands (BK7231 bulbs)

OpenBeken is Tasmota-compatible for most commands:
```bash
# Same HTTP commands work:
curl http://BULB_IP/cm?cmnd=Power%20On
curl http://BULB_IP/cm?cmnd=Color%20FF0000
curl http://BULB_IP/cm?cmnd=Dimmer%2050
curl http://BULB_IP/cm?cmnd=CT%20300

# OpenBeken-specific channel control:
curl http://BULB_IP/cm?cmnd=Channel1%20100      # Red 100%
curl http://BULB_IP/cm?cmnd=Channel2%20100      # Green 100%
curl http://BULB_IP/cm?cmnd=Channel3%20100      # Blue 100%
curl http://BULB_IP/cm?cmnd=Channel4%20100      # Cold White 100%
curl http://BULB_IP/cm?cmnd=Channel5%20100      # Warm White 100%
```

## POST-FLASH: ESPHome Light Commands

```bash
# Turn on with color
curl -X POST http://BULB_IP/light/tuya_lamp/turn_on \
  -d '{"brightness": 255, "color": {"r": 255, "g": 0, "b": 0}}'

# Turn on with color temperature
curl -X POST http://BULB_IP/light/tuya_lamp/turn_on \
  -d '{"brightness": 200, "color_temp": 350}'

# Turn off
curl http://BULB_IP/light/tuya_lamp/turn_off

# Effects
curl -X POST http://BULB_IP/light/tuya_lamp/turn_on \
  -d '{"effect": "random"}'
```

## Metasploit Integration (post-flash bulbs)

Flashed bulbs are HTTP servers — full MSF control:
```bash
cat > /tmp/tasmota_lights.rc << 'RCEOF'
<ruby>
require 'net/http'
require 'json'
require 'cgi'

# Flashed Tuya bulb IPs
bulbs = %w[192.168.1.21 192.168.1.90]

def light_cmd(ip, cmnd)
  uri = URI("http://#{ip}/cm?cmnd=#{CGI.escape(cmnd)}")
  Net::HTTP.get_response(uri) rescue nil
end

# Discover
bulbs.each do |ip|
  res = light_cmd(ip, "Status 11")
  if res && res.code == "200"
    info = JSON.parse(res.body) rescue {}
    color = info.dig("StatusSTS", "Color") || "?"
    dimmer = info.dig("StatusSTS", "Dimmer") || "?"
    power = info.dig("StatusSTS", "POWER") || "?"
    print_good("#{ip} — Power:#{power} Color:#{color} Dimmer:#{dimmer}%")
  else
    print_error("#{ip} — not responding")
  end
end

# Party mode: each bulb a different color
colors = %w[FF0000 00FF00 0000FF FF6600 FF00FF 00FFFF]
bulbs.each_with_index do |ip, i|
  color = colors[i % colors.length]
  light_cmd(ip, "Backlog Power On;Color #{color};Dimmer 100;Fade 1")
  print_good("#{ip} — Set color #{color}")
end
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/tasmota_lights.rc
```

## Tuya RGBCW Bulb GPIO Pinouts

**IMPORTANT**: Different Tuya bulb models use different GPIO assignments.
After flashing, if colors are wrong, swap the GPIO assignments in the template.

| Bulb Model | Red | Green | Blue | Cold W | Warm W | Chip |
|------------|-----|-------|------|--------|--------|------|
| Generic Tuya RGBCW E27 | GPIO4 | GPIO12 | GPIO14 | GPIO5 | GPIO13 | ESP8266 |
| Tuya RGBCW (alt pinout) | GPIO14 | GPIO5 | GPIO12 | GPIO4 | GPIO13 | ESP8266 |
| Tuya RGBW (no warm) | GPIO5 | GPIO4 | GPIO14 | GPIO12 | — | ESP8266 |
| Tuya CW only (no RGB) | — | — | — | GPIO5 | GPIO13 | ESP8266 |
| Tuya BK7231 RGBCW | P6 | P7 | P8 | P24 | P26 | BK7231 |
| Sonoff B1 | GPIO12 | GPIO5 | GPIO4 | GPIO14 | GPIO13 | ESP8285 |
| Lohas E27 | GPIO4 | GPIO12 | GPIO14 | GPIO5 | GPIO13 | ESP8266 |
| Teckin SB50 | GPIO4 | GPIO12 | GPIO14 | GPIO5 | GPIO13 | ESP8266 |

### How to figure out YOUR bulb's pinout:
```bash
# After flashing Tasmota, test each GPIO channel individually:
curl http://BULB_IP/cm?cmnd=Channel1%20100      # Should light ONE color
curl http://BULB_IP/cm?cmnd=Channel1%200
curl http://BULB_IP/cm?cmnd=Channel2%20100      # Should light ANOTHER color
curl http://BULB_IP/cm?cmnd=Channel2%200
# ... repeat for channels 3, 4, 5
# Note which channel produces which color, then adjust template accordingly
```

## Decision Tree for Tuya LIGHT BULBS

```
Is it a light bulb (lamp/bombilla)?
├── YES
│   ├── ESP8266/ESP8285 chip?
│   │   ├── YES → tuya-convert (OTA, no soldering!)
│   │   │   ├── Works → Tasmota → configure RGBCW template → HTTP light control
│   │   │   └── Fails → Serial flash (open bulb, solder UART wires)
│   │   │
│   │   └── NO (BK7231N/T chip, 2022+)
│   │       └── Serial flash with ltchiptool → OpenBeken → HTTP light control
│   │
│   └── Post-flash configuration:
│       1. Set RGBCW template (GPIO pinout for 5 PWM channels)
│       2. Set PWM frequency 1000Hz (reduces flicker)
│       3. Enable fade transitions
│       4. Test each channel to verify color mapping
│       5. Control via curl: Color, Dimmer, CT, Scheme commands
│
└── NO (switch/plug)
    └── See GPIO pinout table for relay-based devices
```

## Sonoff/Switch Devices (for reference)

| Device Type | Relay | Button | LED | LED_i |
|-------------|-------|--------|-----|-------|
| Sonoff Basic | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff Mini | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff S26 plug | GPIO12 | GPIO0 | GPIO13 | yes |
| Sonoff TH | GPIO12 | GPIO0 | GPIO13 | yes |
| Tuya plug (generic) | GPIO12 | GPIO0 | GPIO13 | yes |

## Key Points
- **Tuya bulbs = 5 PWM channels** (R, G, B, Cold White, Warm White)
- **After flashing**: `curl http://IP/cm?cmnd=Color%20FF0000` — that's it, no keys
- **NO cloud, NO encryption, NO Tuya API** — pure local HTTP on port 80
- **Tasmota web UI**: browse to bulb IP for visual color picker
- **MQTT**: connect to local broker for Home Assistant scenes/automations
- **OTA updates**: `curl http://IP/cm?cmnd=Upgrade%201` — controlled by YOU
- **Backup first**: `esptool.py read_flash` before flashing (for rollback)
- **Colors wrong?** Test each channel individually, then swap GPIOs in template
