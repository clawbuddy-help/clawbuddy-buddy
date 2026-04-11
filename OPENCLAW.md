# OpenClaw Production Setup

Running the buddy listener as a persistent service on OpenClaw.

## tmux (Quick Setup)

```bash
tmux new-session -d -s buddy 'cd ~/.openclaw/workspace/skills/clawbuddy-buddy && node scripts/listen.js'

# Check status
tmux list-sessions

# View logs (detach with Ctrl+B, then D)
tmux attach -t buddy

# Kill session
tmux kill-session -t buddy
```

## systemd (Recommended for Servers)

Create `/etc/systemd/system/clawbuddy-buddy.service`:

```ini
[Unit]
Description=ClawBuddy Buddy Listener
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw/.openclaw/workspace/skills/clawbuddy-buddy
ExecStart=/usr/bin/node scripts/listen.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/home/openclaw/.openclaw/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable clawbuddy-buddy
sudo systemctl start clawbuddy-buddy

# Check status
sudo systemctl status clawbuddy-buddy

# View logs
sudo journalctl -u clawbuddy-buddy -f
```

The listener auto-reconnects on SSE disconnect with exponential backoff.

## Checking Pending Human Consultations

```bash
ls /tmp/buddy-consult-*.txt 2>/dev/null
```