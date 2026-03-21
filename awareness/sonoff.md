# Sonoff Smart Switches (Red local)

Hay dispositivos Sonoff en la red 192.168.1.x que se controlan via API REST en puerto 8081.
Estos dispositivos son switches de enchufe (on/off), NO son luces Wiz.

## IMPORTANTE: encrypt=true

Los dispositivos tienen `encrypt=true` activado. Cuando ves "Failed to exec handler" significa que el dispositivo RECHAZÓ el comando porque falta la API key de encriptación. NO es "comportamiento normal" — es un error de autenticación.

**BYPASS STRATEGY — try IN ORDER before asking for keys:**
1. Send unencrypted command anyway (some devices accept it despite encrypt=true flag)
2. Sniff mDNS for leaked API key: `avahi-browse -rt _ewelink._tcp | grep -i key`
3. Intercept eWeLink traffic: `sudo tcpdump -i wlp8s0 -n port 8081 -A | grep apikey`
4. Try common/default API keys: `""`, `"0"*16`, device ID as key
5. Force DIY mode: some firmware allows `POST /zeroconf/diy` to disable encryption

If all bypasses fail, then get API key properly:
1. Obtener la API key desde la app eWeLink
2. Encriptar el payload con AES-128-CBC usando esa key
3. Enviar el payload encriptado

### Obtener API key (método 1 — sniffing mDNS)
```bash
# El API key a veces se expone en el campo txt de mDNS
avahi-browse -rt _ewelink._tcp 2>&1 | grep -i "key\|iv\|encrypt"
```

### Obtener API key (método 2 — interceptar tráfico eWeLink)
```bash
# Capturar tráfico entre la app eWeLink y el dispositivo
sudo tcpdump -i wlp8s0 -n port 8081 -A -c 100 2>&1 | grep -i "apikey\|key"
```

### Controlar SIN encriptación (modo DIY real)
Si el dispositivo está en modo DIY REAL (encrypt=false), los comandos sin key funcionan:
```bash
curl -s -X POST http://IP:8081/zeroconf/switch -H "Content-Type: application/json" -d '{"deviceid":"","data":{"switch":"on"}}'
```

## Inventario Sonoff (10 dispositivos, verificado 2026-03-16)

| IP | Device ID | Tipo | Encrypt |
|---|---|---|---|
| 192.168.1.18 | 10026675af | Plug switch | true |
| 192.168.1.30 | 1002669c14 | Plug switch | true |
| 192.168.1.46 | 100266733f | Plug switch | true |
| 192.168.1.69 | 10026679cf | Plug switch | true |
| 192.168.1.75 | 1002669ab6 | Plug switch | true |
| 192.168.1.84 | 10026689fb | Plug switch | true |
| 192.168.1.95 | 1002669dc2 | Plug switch | true |
| 192.168.1.171 | 1002666fd9 | Plug switch | true |
| 192.168.1.191 | 100266733f | Plug switch | true |
| 192.168.1.195 | 1002669e72 | Plug switch | true |

## Metasploit Integration

```bash
# Discover Sonoff devices with MSF
msfconsole -q -x "use auxiliary/scanner/portscan/tcp; set RHOSTS 192.168.1.0/24; set PORTS 8081; set THREADS 20; run; exit"

# Control via MSF Ruby (only works if encrypt=false)
# For encrypt=true devices, use Python with pycryptodome (see 30-smart-home.md)
```

MSF Ruby has `Net::HTTP` built-in — can POST to `/zeroconf/switch` directly.
For encrypted devices (error 401), MSF Ruby does NOT have `pycryptodome` — use Python.

## Notas

- "Failed to exec handler" = FALTA API KEY (encrypt=true). NO es éxito.
- Alby Hub (puerto 8029) NO es IoT — es nodo Lightning Bitcoin
- DATUM Gateway (puerto 7152) es minería Bitcoin
- Discovery via mDNS: `avahi-browse -rt _ewelink._tcp`
- Los Sonoff son SWITCHES de enchufe, no luces inteligentes con colores
- MSF puede descubrir y controlar Sonoff (encrypt=false) via Net::HTTP
- Para encrypt=true: necesitas API key + Python con pycryptodome
- **MEJOR SOLUCIÓN**: Flashear Tasmota con tuya-convert o serial → control HTTP puro sin keys
- Sonoff usan ESP8266/ESP32 → 100% compatible con Tasmota
- Ver `35-iot-liberation.md` para guía completa de flash
