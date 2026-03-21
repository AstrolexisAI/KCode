# Auto-Install — MANDATORY (ONE Bash command, ZERO wasted turns)

When you detect a security/networking task, run this as a SINGLE Bash command FIRST.
Do NOT split installation into multiple tool calls. ONE command does EVERYTHING:

```bash
# === ALL-IN-ONE arsenal setup — run this ONCE, never again ===
SUDO_PASS="__ASK_USER__"  # Replace with actual password
MISSING=""
for t in nmap smbclient rpcclient nmblookup hydra john hashcat masscan nc sshpass sqlmap impacket-psexec impacket-secretsdump; do
  which $t &>/dev/null || MISSING="$MISSING $t"
done

# Install system packages
if [ -n "$MISSING" ]; then
  echo "Installing:$MISSING"
  echo "$SUDO_PASS" | sudo -S dnf install -y nmap samba-client samba-common-tools nmap-ncat hydra john hashcat masscan sshpass --skip-unavailable 2>&1 | tail -3
  pip install --user impacket sqlmap 2>&1 | tail -2
  for f in ~/.local/bin/{psexec,smbexec,wmiexec,dcomexec,atexec,secretsdump,smbclient,smbserver}.py; do
    [ -f "$f" ] && ln -sf "$f" "${f%.py}" 2>/dev/null && ln -sf "$f" "$(dirname $f)/impacket-$(basename ${f%.py})" 2>/dev/null
  done
fi

# Wordlist — download ONLY if missing, with timeout
if [ ! -f /tmp/rockyou.txt ] && [ ! -f /usr/share/wordlists/rockyou.txt ]; then
  echo "Downloading rockyou.txt..."
  timeout 30 curl -sL https://github.com/brannondorsey/naive-hashcat/releases/download/data/rockyou.txt -o /tmp/rockyou.txt 2>/dev/null
  if [ ! -s /tmp/rockyou.txt ]; then
    echo "Download failed — creating mini wordlist"
    printf 'password\nadmin\n123456\npassword1\nroot\ntoor\n1234\nqwerty\n12345678\nabc123\nletmein\nmaster\ndragon\nlogin\nprincess\nwelcome\nshadow\nsunshine\ntrustno1\niloveyou\nmonkey\n1234567\ncharlie\n' > /tmp/rockyou.txt
  fi
fi
WORDLIST=$([ -f /usr/share/wordlists/rockyou.txt ] && echo /usr/share/wordlists/rockyou.txt || echo /tmp/rockyou.txt)
echo "=== Arsenal ready === Wordlist: $WORDLIST"
```

## CRITICAL RULES

1. **ONE Bash call for ALL installation** — never split into multiple tool calls
2. **Ask sudo password ONCE** — cache it: `SUDO_PASS="..."`, then `echo "$SUDO_PASS" | sudo -S cmd`
3. **Wordlist fallback** — if curl fails/times out, create a mini wordlist inline. NEVER waste turns retrying downloads
4. **After install, GO DIRECTLY TO THE TASK** — don't verify installations one by one
5. **NEVER say "tool not found"** — install it or use an alternative. dnf → pip → cargo → go → git clone
6. **Budget your turns** — you have 25 tool turns total. Installation should use MAX 1-2 turns. Spend the rest on the actual task
7. **Use `timeout 30` on all downloads** — never let a curl/wget hang

## If rockyou.txt download fails

DON'T retry. Use the mini wordlist or generate one:
```bash
# Quick alternative — common passwords + mutations
cat /usr/share/nmap/nselib/data/passwords.lst 2>/dev/null > /tmp/wordlist.txt
printf 'password\nPassword1\nadmin\nAdmin123\nroot\ntoor\n123456\nqwerty\nletmein\nwelcome\n' >> /tmp/wordlist.txt
```
