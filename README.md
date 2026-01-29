# Kanban Bob (local macOS Kanban)

A compact local Kanban board you run on your Mac. Data is stored in a local SQLite file.

## Run (uv)

```bash
cd kanban-bob
uv venv
uv sync
uv run python app.py
```

Open: http://127.0.0.1:5123

## Run as a background service (Linux / WSL / systemd)

If you run Kanban from a terminal (or VS Code), closing the terminal will stop it.
On Linux-like systems with **systemd**, you can run it as a user service.

### 1) Create a user service

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/kanban.service
```

Paste (adjust `WorkingDirectory` and `ExecStart`):

```ini
[Unit]
Description=Simple Kanban (Flask)

[Service]
WorkingDirectory=/home/<USER>/projects/simple-kanban
ExecStart=/home/<USER>/.local/bin/uv run python app.py
Restart=always
RestartSec=2
Environment=KANBAN_HOST=127.0.0.1
Environment=KANBAN_PORT=5123

[Install]
WantedBy=default.target
```

Important:
- `WorkingDirectory` must be the folder containing `app.py`.
- Use the **absolute path** to `uv` (find it via `which uv`) because systemd services
  often have a minimal `PATH`.

### 2) Enable + start

```bash
systemctl --user daemon-reload
systemctl --user enable --now kanban.service
systemctl --user status kanban.service
```

### 3) Logs

```bash
journalctl --user -u kanban.service -n 100 --no-pager
```

### (Optional) Keep the service running after logout

```bash
loginctl enable-linger $USER
```

## Notes
- Storage: `kanban.db` (SQLite)
- Columns: **Backlog**, **Todo**, **Doing**, **Done**

## Next upgrades (optional)
- Multiple boards, tags, due dates
- Auth (local password) / read-only share link
- Full-text search, archive, exports
