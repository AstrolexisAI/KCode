# Smart Home — IoT Device Control Guide

You are the home network GOD. You know every protocol, every port, every device.

## CRITICAL: Device Types — NEVER confuse them

**Wiz = LIGHTS (UDP 38899)** — color bulbs, scenes, dimming. NO HTTP. NO mDNS.
**Sonoff = SWITCHES (HTTP 8081)** — on/off plugs. mDNS `_ewelink._tcp`. NOT lights.
**These are COMPLETELY DIFFERENT devices. NEVER control one with the other's protocol.**

| Brand | Protocol | Port | Discovery | Control Method |
|-------|----------|------|-----------|----------------|
| **Wiz** (luces) | UDP | 38899 | UDP broadcast | UDP JSON commands |
| **Sonoff/eWeLink** (switches) | HTTP REST | 8081 | mDNS `_ewelink._tcp` | POST /zeroconf/* (needs API key if encrypt=true) |
| **Tasmota** | HTTP | 80 | mDNS `_http._tcp` | GET /cm?cmnd=Power%20On |
| **Shelly** | HTTP | 80 | mDNS `_http._tcp` | GET /relay/0?turn=on |
| **TP-Link Kasa** | TCP | 9999 | UDP broadcast 255.255.255.255:9999 | Encrypted JSON over TCP |
| **Tuya** | TCP | 6668 | UDP broadcast | Encrypted protocol (needs local key) |
| **Philips Hue** | HTTP REST | 80/443 | mDNS `_hue._tcp` | PUT /api/<key>/lights/1/state |
| **MQTT devices** | MQTT | 1883 | N/A | Publish to topics |

## Wiz Lights — Complete Control Guide

Wiz lights use **UDP port 38899** (NOT HTTP). They respond to JSON messages over UDP.
**NO authentication needed** — any device on the LAN can control them.

### FASTEST approach (use this by default):
1. **Discover**: `sudo nmap -sU -p 38899 192.168.1.0/24 --open` → finds all Wiz IPs
2. **Control**: `echo '{"id":1,"method":"setState","params":{"state":true}}' | socat - UDP:IP:38899`

That's it. Two commands. Don't overcomplicate it.
Only use Metasploit for Wiz if the user specifically asks for it.

### Discovery (find all Wiz lights on the network)
```bash
# Method 1: UDP broadcast discovery
echo '{"method":"registration","params":{"phoneMac":"AAAAAAAAAAAA","register":false,"phoneIp":"192.168.1.2","id":"1"}}' | \
  socat - UDP-DATAGRAM:192.168.1.255:38899,broadcast,sp=38899 &
sleep 2; kill %1 2>/dev/null

# Method 2: Python script (more reliable)
python3 -c "
import socket, json, time
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.settimeout(3)
sock.bind(('', 38899))
msg = json.dumps({'method':'registration','params':{'phoneMac':'AAAAAAAAAAAA','register':False,'phoneIp':'0.0.0.0','id':'1'}})
sock.sendto(msg.encode(), ('192.168.1.255', 38899))
while True:
    try:
        data, addr = sock.recvfrom(1024)
        print(f'{addr[0]}: {json.loads(data)}')
    except socket.timeout:
        break
sock.close()
"

# Method 3: nmap UDP scan
nmap -sU -p 38899 192.168.1.0/24 --open
```

### Control Commands (all via UDP to port 38899)

```bash
# Turn ON
echo '{"id":1,"method":"setState","params":{"state":true}}' | \
  socat - UDP:192.168.1.X:38899

# Turn OFF
echo '{"id":1,"method":"setState","params":{"state":false}}' | \
  socat - UDP:192.168.1.X:38899

# Set brightness (10-100)
echo '{"id":1,"method":"setPilot","params":{"dimming":80}}' | \
  socat - UDP:192.168.1.X:38899

# Set color (RGB)
echo '{"id":1,"method":"setPilot","params":{"r":255,"g":0,"b":0,"dimming":100}}' | \
  socat - UDP:192.168.1.X:38899

# Set color temperature (warm 2200K to cool 6500K)
echo '{"id":1,"method":"setPilot","params":{"temp":4000,"dimming":100}}' | \
  socat - UDP:192.168.1.X:38899

# Set scene (1-32)
echo '{"id":1,"method":"setPilot","params":{"sceneId":4}}' | \
  socat - UDP:192.168.1.X:38899

# Get current state
echo '{"id":1,"method":"getPilot","params":{}}' | \
  socat - UDP:192.168.1.X:38899

# Get device info (firmware, model, MAC)
echo '{"id":1,"method":"getSystemConfig","params":{}}' | \
  socat - UDP:192.168.1.X:38899
```

### Wiz Scene IDs
| ID | Scene | ID | Scene |
|----|-------|----|-------|
| 1 | Ocean | 17 | Stop |
| 2 | Romance | 18 | Christmas |
| 3 | Sunset | 19 | Halloween |
| 4 | Party | 20 | Candlelight |
| 5 | Fireplace | 21 | Golden White |
| 6 | Cozy | 22 | Pulse |
| 7 | Forest | 23 | Steampunk |
| 8 | Pastel Colors | 24 | Rhythm |
| 9 | Wake Up | 25 | Bedtime |
| 10 | Bedtime | 26 | Warm White |
| 11 | Warm White | 27 | Daylight |
| 12 | Daylight | 28 | Cool White |
| 13 | Cool White | 29 | Night Light |
| 14 | Night Light | 30 | Focus |
| 15 | Focus | 31 | Relax |
| 16 | Relax | 32 | True Colors |

### Python Control Script (batch operations)
```python
import socket, json, time

def wiz_send(ip, method, params={}):
    """Send a command to a Wiz light and return the response."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    msg = json.dumps({"id": 1, "method": method, "params": params})
    sock.sendto(msg.encode(), (ip, 38899))
    try:
        data, _ = sock.recvfrom(1024)
        return json.loads(data)
    except socket.timeout:
        return None
    finally:
        sock.close()

def wiz_on(ip):    return wiz_send(ip, "setState", {"state": True})
def wiz_off(ip):   return wiz_send(ip, "setState", {"state": False})
def wiz_color(ip, r, g, b, dim=100): return wiz_send(ip, "setPilot", {"r":r,"g":g,"b":b,"dimming":dim})
def wiz_temp(ip, temp, dim=100):      return wiz_send(ip, "setPilot", {"temp":temp,"dimming":dim})
def wiz_scene(ip, scene_id):          return wiz_send(ip, "setPilot", {"sceneId": scene_id})
def wiz_status(ip): return wiz_send(ip, "getPilot")
def wiz_info(ip):   return wiz_send(ip, "getSystemConfig")
```

### Troubleshooting
- **No response on UDP 38899**: Light is offline or on different subnet
- **Install socat if missing**: `sudo dnf install -y socat` or `sudo apt install -y socat`
- **Wiz lights need NO authentication** — they accept commands from any device on the LAN
- **Wiz ≠ Sonoff**: Wiz are LIGHTS (color, brightness, scenes). Sonoff are SWITCHES (on/off only, port 8081)

## Sonoff/eWeLink Switches — Complete Control Guide

Sonoff devices use **HTTP REST on port 8081** with the Zeroconf/eWeLink LAN protocol.
**Most Sonoff devices have `encrypt=true`** — commands need AES-128-CBC encryption with the device's API key.

### FASTEST approach (use this by default):
1. **Discover**: `avahi-browse -rt _ewelink._tcp` → finds all Sonoff IPs + device IDs
2. **Control (no encrypt)**: `curl -s -X POST http://IP:8081/zeroconf/switch -d '{"deviceid":"","data":{"switch":"on"}}'`
3. **Control (encrypt=true)**: Need API key → use Python script below

If `encrypt=true` and you don't have the API key, the device returns `"error": 401` or `"Failed to exec handler"`.
That is NOT success — it means authentication failed.

### Discovery
```bash
# Method 1: mDNS (best — returns device ID, encrypt status, API key hint)
avahi-browse -rt _ewelink._tcp 2>&1

# Method 2: nmap TCP scan
nmap -sT -p 8081 192.168.1.0/24 --open

# Method 3: Metasploit mDNS query
msfconsole -q -x "use auxiliary/scanner/mdns/query; set RHOSTS 192.168.1.0/24; run; exit"

# Method 4: Metasploit TCP port scan
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 8081; set THREADS 20; run; exit"
```

### Control Commands (HTTP REST on port 8081)
```bash
# Turn ON (encrypt=false only)
curl -s -X POST http://IP:8081/zeroconf/switch \
  -H "Content-Type: application/json" \
  -d '{"deviceid":"","data":{"switch":"on"}}'

# Turn OFF
curl -s -X POST http://IP:8081/zeroconf/switch \
  -H "Content-Type: application/json" \
  -d '{"deviceid":"","data":{"switch":"off"}}'

# Get device info
curl -s -X POST http://IP:8081/zeroconf/info \
  -H "Content-Type: application/json" \
  -d '{"deviceid":"","data":{}}'

# Get WiFi signal strength
curl -s -X POST http://IP:8081/zeroconf/signal_strength \
  -H "Content-Type: application/json" \
  -d '{"deviceid":"","data":{}}'
```

### Encrypted Control (encrypt=true) — Python
```python
import socket, json, hashlib, base64, time
from Crypto.Cipher import AES  # pip install pycryptodome

def sonoff_send(ip, deviceid, apikey, data, port=8081):
    """Send encrypted command to Sonoff device."""
    key = hashlib.md5(apikey.encode()).digest()
    iv = b'0000000000000000'  # 16 bytes of '0'
    plaintext = json.dumps(data).encode()
    # PKCS7 padding
    pad_len = 16 - (len(plaintext) % 16)
    plaintext += bytes([pad_len] * pad_len)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    encrypted = base64.b64encode(cipher.encrypt(plaintext)).decode()
    payload = {
        "sequence": str(int(time.time() * 1000)),
        "deviceid": deviceid,
        "selfApikey": "123",
        "iv": base64.b64encode(iv).decode(),
        "encrypt": True,
        "data": encrypted
    }
    import requests
    r = requests.post(f"http://{ip}:{port}/zeroconf/switch",
                      json=payload, timeout=5)
    return r.json()

# Usage:
# sonoff_send("192.168.1.18", "10026675af", "YOUR_API_KEY", {"switch": "on"})
```

### Get API Key
```bash
# Method 1: Sniff mDNS (sometimes exposed in TXT records)
avahi-browse -rt _ewelink._tcp 2>&1 | grep -i "key\|iv\|encrypt\|apikey"

# Method 2: Intercept eWeLink app traffic
sudo tcpdump -i wlp8s0 -n port 8081 -A -c 100 2>&1 | grep -i "apikey\|key"

# Method 3: Extract from eWeLink cloud API (need account)
# Use https://github.com/AlexxIT/SonoffLAN or Home Assistant eWeLink integration
```

### Metasploit Integration for Sonoff
```bash
# Discover + enumerate Sonoff devices, then control with curl
cat > /tmp/sonoff_scan.rc << 'EOF'
<ruby>
require 'net/http'
require 'json'

targets = %w[192.168.1.18 192.168.1.30 192.168.1.46 192.168.1.69 192.168.1.75
             192.168.1.84 192.168.1.95 192.168.1.171 192.168.1.191 192.168.1.195]

targets.each do |ip|
  begin
    uri = URI("http://#{ip}:8081/zeroconf/info")
    req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json')
    req.body = '{"deviceid":"","data":{}}'
    http = Net::HTTP.new(uri.host, uri.port)
    http.open_timeout = 3
    http.read_timeout = 3
    res = http.request(req)
    info = JSON.parse(res.body) rescue {}
    if info["error"] == 0
      print_good("#{ip} — Sonoff online: #{info}")
    else
      print_warning("#{ip} — encrypt=true (error #{info['error']})")
    end
  rescue => e
    print_error("#{ip} — offline: #{e.message}")
  end
end
</ruby>
exit
EOF
msfconsole -q -r /tmp/sonoff_scan.rc
```

## Tuya Devices — Complete Control Guide

Tuya devices use **encrypted TCP on port 6668** (v3.3+) or **port 6667** (v3.1).
**Authentication required** — needs `device_id` and `local_key` from the Tuya cloud API.
Without the local key, you CANNOT control Tuya devices locally.

### FASTEST approach:
1. **Discover**: `sudo nmap -sT -p 6668,6667 192.168.1.0/24 --open` → finds all Tuya IPs
2. **Get keys**: Use `tinytuya` wizard to get device IDs + local keys from Tuya cloud
3. **Control**: Use `tinytuya` Python library

### Discovery
```bash
# Method 1: nmap TCP scan (Tuya listens on 6668 for v3.3+, 6667 for v3.1)
sudo nmap -sT -p 6667,6668 192.168.1.0/24 --open

# Method 2: UDP broadcast discovery (Tuya devices respond to broadcast on 6666/6667)
python3 -c "
import socket, json
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.settimeout(5)
sock.bind(('', 6666))
print('Listening for Tuya broadcasts on UDP 6666...')
while True:
    try:
        data, addr = sock.recvfrom(4096)
        # Tuya broadcasts are partially encrypted but contain IP and device ID
        print(f'{addr[0]}: {data[:100]}')
    except socket.timeout:
        break
sock.close()
"

# Method 3: Metasploit TCP port scan
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 6667,6668; set THREADS 20; run; exit"

# Method 4: tinytuya scan (best — auto-decrypts broadcast, shows device info)
python3 -m tinytuya scan
```

### Get Local Keys (REQUIRED before control)
```bash
# Install tinytuya
pip install tinytuya

# Run the wizard — needs Tuya IoT Platform credentials
# 1. Create account at https://iot.tuya.com
# 2. Create Cloud Project → get Access ID + Access Secret
# 3. Link your Tuya/Smart Life app devices to the project
python3 -m tinytuya wizard
# This creates devices.json with device_id + local_key for each device
```

### Control Commands (Python with tinytuya)
```python
import tinytuya

# Connect to device
d = tinytuya.OutletDevice(
    dev_id='DEVICE_ID_HERE',
    address='192.168.1.X',
    local_key='LOCAL_KEY_HERE',
    version=3.3  # or 3.1 for older devices
)

# Turn ON (DPS 1 = main switch for most devices)
d.turn_on()   # equivalent to d.set_value(1, True)

# Turn OFF
d.turn_off()  # equivalent to d.set_value(1, False)

# Get status
status = d.status()
print(status)  # {'dps': {'1': True, '2': 0, ...}}

# Set specific DPS values (device-dependent)
d.set_value(2, 50)   # e.g., brightness for a dimmer
d.set_value(3, 'white')  # e.g., mode for a light

# For Tuya light bulbs:
# DPS 1 = on/off, DPS 2 = mode ('white'/'colour'/'scene'/'music')
# DPS 3 = brightness (10-1000), DPS 4 = color temp (0-1000)
# DPS 5 = colour as hex 'RRGGBB0000ffff'
```

### Raw TCP Control (without tinytuya — advanced)
```python
import socket, json, hashlib, struct, time
from Crypto.Cipher import AES  # pip install pycryptodome

def tuya_send(ip, dev_id, local_key, dps, port=6668):
    """Send command to Tuya device using v3.3 protocol."""
    key = local_key.encode('latin1')
    payload = json.dumps({
        "devId": dev_id, "uid": dev_id, "t": str(int(time.time())),
        "dps": dps, "gwId": dev_id
    }).encode()
    # v3.3: AES-ECB encrypt, then wrap in Tuya protocol frame
    pad_len = 16 - (len(payload) % 16)
    payload += bytes([pad_len] * pad_len)
    cipher = AES.new(key, AES.MODE_ECB)
    encrypted = cipher.encrypt(payload)
    # Tuya v3.3 frame: prefix(4) + seqno(4) + cmd(4) + len(4) + data + crc(4) + suffix(4)
    PREFIX = b'\x00\x00\x55\xaa'
    SUFFIX = b'\x00\x00\xaa\x55'
    cmd = 7  # CONTROL command
    version_header = b'3.3\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'  # 15 bytes
    data = version_header + encrypted
    frame = PREFIX + struct.pack('>III', 1, cmd, len(data) + 8) + data
    crc = hashlib.md5(frame).digest()[-8:]  # CRC placeholder
    frame += crc + SUFFIX
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect((ip, port))
    sock.send(frame)
    response = sock.recv(4096)
    sock.close()
    return response

# Turn ON: tuya_send("192.168.1.X", "DEVICE_ID", "LOCAL_KEY", {"1": True})
# Turn OFF: tuya_send("192.168.1.X", "DEVICE_ID", "LOCAL_KEY", {"1": False})
```

### Metasploit Integration for Tuya
```bash
# Step 1: Discover Tuya devices with MSF port scan
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 6667,6668; set THREADS 20; run; exit"

# Step 2: Store results and probe with Python
cat > /tmp/tuya_probe.rc << 'RCEOF'
<ruby>
require 'socket'
require 'json'

print_status("Probing for Tuya devices on TCP 6668...")
# List of IPs found by nmap/MSF scan — replace with actual results
targets = %w[192.168.1.50 192.168.1.51 192.168.1.52]

targets.each do |ip|
  begin
    sock = TCPSocket.new(ip, 6668)
    sock.setsockopt(1, 20, [3, 0].pack("l_2"))  # SOL_SOCKET=1, SO_RCVTIMEO=20
    print_good("#{ip}:6668 — Tuya device ONLINE (TCP connected)")
    sock.close
  rescue => e
    print_error("#{ip}:6668 — offline: #{e.message}")
  end
end

print_status("To control Tuya devices, use: python3 -m tinytuya (needs local_key)")
print_status("Get keys with: python3 -m tinytuya wizard")
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/tuya_probe.rc
```

### Troubleshooting Tuya
- **"No response"**: Device might use port 6667 (v3.1) instead of 6668 (v3.3)
- **"Decrypt failed"**: Wrong `local_key` or wrong protocol version
- **"Device not found"**: Tuya devices only broadcast on UDP 6666 — listen for them
- **Getting local keys**: The ONLY reliable method is `tinytuya wizard` with Tuya IoT Platform credentials
- **DPS mapping**: Each device type has different DPS (Data Point Schema). Use `d.status()` to discover available DPS IDs

## Network Diagnostics for IoT

### Find all IoT devices
```bash
# ARP scan (fast, finds everything)
sudo arp-scan -l 2>/dev/null || ip neigh show | grep -v FAILED

# mDNS discovery (finds smart home devices)
avahi-browse -art 2>&1 | grep -E "ewelink|wiz|tasmota|shelly|hue|mqtt"

# nmap IoT port sweep
nmap -sT -T4 -p 80,1883,8081,8883,9999,38899 192.168.1.0/24 --open

# MAC address OUI lookup (identify manufacturer)
# First 3 octets of MAC → manufacturer
# D8:0D:17 = TP-Link, 68:57:2D = Wiz, EC:FA:BC = Espressif (Sonoff/Tuya)
```

### Common IoT Issues & Fixes
- **Device not responding**: Check if it's on the same VLAN/subnet. IoT often uses guest network.
- **Intermittent connectivity**: Check WiFi signal strength, channel congestion.
- **Can't discover**: Some routers block UDP broadcast. Check AP isolation settings.
- **MQTT not connecting**: Check broker port 1883 (unencrypted) or 8883 (TLS).
