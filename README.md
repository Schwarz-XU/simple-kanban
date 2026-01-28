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

## Notes
- Storage: `kanban.db` (SQLite)
- Columns (MVP): **Todo**, **Doing**, **Done**

## Next upgrades (optional)
- Multiple boards, tags, due dates
- Auth (local password) / read-only share link
- Full-text search, archive, exports
