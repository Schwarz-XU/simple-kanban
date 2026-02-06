from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, render_template, request

APP_HOST = os.environ.get("KANBAN_HOST", "127.0.0.1")
APP_PORT = int(os.environ.get("KANBAN_PORT", "5123"))
DB_PATH = os.environ.get("KANBAN_DB", os.path.join(os.path.dirname(__file__), "kanban.db"))

COLUMNS = ["backlog", "todo", "doing", "done"]
DEFAULT_BOARD_NAME = "Main"

app = Flask(__name__)


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def has_column(con: sqlite3.Connection, table: str, column: str) -> bool:
    rows = con.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


def ensure_default_board(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT id FROM boards ORDER BY id LIMIT 1").fetchone()
    if row:
        return int(row["id"])
    ts = now_iso()
    cur = con.execute(
        "INSERT INTO boards(name, created_at, updated_at) VALUES(?,?,?)",
        (DEFAULT_BOARD_NAME, ts, ts),
    )
    return int(cur.lastrowid)


def prune_unused_tags(con: sqlite3.Connection) -> int:
    """Delete tags that are not referenced by any task.

    Returns number of deleted rows.
    """
    cur = con.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM task_tags)"
    )
    return int(cur.rowcount)


def init_db() -> None:
    with db() as con:
        # Boards
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS boards (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )

        # Tasks (legacy-compatible)
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              board_id INTEGER,
              title TEXT NOT NULL,
              description TEXT DEFAULT '',
              status TEXT NOT NULL,
              position REAL NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(board_id) REFERENCES boards(id)
            )
            """
        )

        # Tags
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS tags (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              color TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS task_tags (
              task_id INTEGER NOT NULL,
              tag_id INTEGER NOT NULL,
              PRIMARY KEY (task_id, tag_id),
              FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
            )
            """
        )

        # Checklist items (subtasks)
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS checklist_items (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id INTEGER NOT NULL,
              text TEXT NOT NULL,
              done INTEGER NOT NULL DEFAULT 0,
              position REAL NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
            """
        )

        # Migration for older DBs that lack board_id
        if not has_column(con, "tasks", "board_id"):
            con.execute("ALTER TABLE tasks ADD COLUMN board_id INTEGER")

        default_board_id = ensure_default_board(con)
        con.execute("UPDATE tasks SET board_id=? WHERE board_id IS NULL", (default_board_id,))

        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_board_status_pos ON tasks(board_id, status, position)"
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id)")

        con.execute("CREATE INDEX IF NOT EXISTS idx_checklist_task_pos ON checklist_items(task_id, position)")
        # best-effort cleanup: remove tags no longer in use
        prune_unused_tags(con)
        con.execute("CREATE INDEX IF NOT EXISTS idx_checklist_task_done ON checklist_items(task_id, done)")


def board_id_from_request(default: Optional[int] = None) -> Optional[int]:
    raw = request.args.get("board_id")
    if raw is None:
        return default
    try:
        return int(raw)
    except Exception:
        return None


TAG_PALETTE = [
    "#60a5fa",  # blue
    "#34d399",  # green
    "#f59e0b",  # amber
    "#f472b6",  # pink
    "#a78bfa",  # violet
    "#22c55e",  # emerald
    "#fb7185",  # rose
    "#38bdf8",  # sky
    "#f97316",  # orange
    "#14b8a6",  # teal
]


def color_for_tag(name: str) -> str:
    # Deterministic, stable color per tag name.
    h = 0
    for ch in name.lower():
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return TAG_PALETTE[h % len(TAG_PALETTE)]


def normalize_tag_names(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
        return [p for p in parts if p]
    if isinstance(raw, list):
        out: List[str] = []
        for x in raw:
            if x is None:
                continue
            s = str(x).strip()
            if s:
                out.append(s)
        return out
    return []


def upsert_tags(con: sqlite3.Connection, tag_names: List[str]) -> List[Tuple[int, str, str]]:
    """Return list of (tag_id, name, color) for the provided names."""
    ts = now_iso()
    result: List[Tuple[int, str, str]] = []
    for name in tag_names:
        row = con.execute("SELECT id, name, color FROM tags WHERE name=?", (name,)).fetchone()
        if row:
            result.append((int(row["id"]), str(row["name"]), str(row["color"])) )
            continue
        color = color_for_tag(name)
        cur = con.execute(
            "INSERT INTO tags(name, color, created_at, updated_at) VALUES(?,?,?,?)",
            (name, color, ts, ts),
        )
        result.append((int(cur.lastrowid), name, color))
    return result


def set_task_tags(con: sqlite3.Connection, task_id: int, tag_names: List[str]) -> None:
    tag_names = list(dict.fromkeys(tag_names))  # de-dupe, keep order
    con.execute("DELETE FROM task_tags WHERE task_id=?", (task_id,))
    if not tag_names:
        return
    tags = upsert_tags(con, tag_names)
    for tag_id, _, _ in tags:
        con.execute("INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES(?,?)", (task_id, tag_id))


def get_tags_for_tasks(con: sqlite3.Connection, task_ids: List[int]) -> Dict[int, List[Dict[str, str]]]:
    if not task_ids:
        return {}
    placeholders = ",".join(["?"] * len(task_ids))
    rows = con.execute(
        f"""
        SELECT tt.task_id AS task_id, t.name AS name, t.color AS color
        FROM task_tags tt
        JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id IN ({placeholders})
        ORDER BY t.name
        """,
        task_ids,
    ).fetchall()
    out: Dict[int, List[Dict[str, str]]] = {tid: [] for tid in task_ids}
    for r in rows:
        tid = int(r["task_id"])
        out.setdefault(tid, []).append({"name": str(r["name"]), "color": str(r["color"])})
    return out


def get_checklist_for_tasks(con: sqlite3.Connection, task_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    if not task_ids:
        return {}
    placeholders = ",".join(["?"] * len(task_ids))
    rows = con.execute(
        f"""
        SELECT id, task_id, text, done, position, created_at, updated_at
        FROM checklist_items
        WHERE task_id IN ({placeholders})
        ORDER BY task_id, position
        """,
        task_ids,
    ).fetchall()
    out: Dict[int, List[Dict[str, Any]]] = {tid: [] for tid in task_ids}
    for r in rows:
        tid = int(r["task_id"])
        out.setdefault(tid, []).append(
            {
                "id": int(r["id"]),
                "text": str(r["text"]),
                "done": bool(r["done"]),
                "position": float(r["position"]),
            }
        )
    return out


@app.get("/")
def index():
    return render_template("index.html", columns=COLUMNS)


@app.get("/api/boards")
def api_list_boards():
    with db() as con:
        rows = con.execute("SELECT id, name, created_at, updated_at FROM boards ORDER BY id").fetchall()
    return jsonify({"boards": [dict(r) for r in rows]})


@app.post("/api/boards")
def api_create_board():
    data = request.get_json(force=True, silent=False) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    ts = now_iso()
    with db() as con:
        try:
            cur = con.execute(
                "INSERT INTO boards(name, created_at, updated_at) VALUES(?,?,?)",
                (name, ts, ts),
            )
        except sqlite3.IntegrityError:
            return jsonify({"error": "board name already exists"}), 409
        board_id = int(cur.lastrowid)
        row = con.execute("SELECT id, name, created_at, updated_at FROM boards WHERE id=?", (board_id,)).fetchone()
    return jsonify({"board": dict(row)}), 201


@app.delete("/api/boards/<int:board_id>")
def api_delete_board(board_id: int):
    """Hard delete a board and all its tasks.

    Note: tasks.board_id doesn't use ON DELETE CASCADE in older DBs, so we
    delete tasks explicitly.
    """
    with db() as con:
        default_board_id = ensure_default_board(con)
        # Don't allow deleting the last remaining board.
        cnt = con.execute("SELECT COUNT(*) AS c FROM boards").fetchone()["c"]
        if int(cnt) <= 1:
            return jsonify({"error": "cannot delete the last remaining board"}), 400

        row = con.execute("SELECT id, name FROM boards WHERE id=?", (board_id,)).fetchone()
        if not row:
            return jsonify({"error": "board not found"}), 404

        # Prevent deleting the implicit default board id when it's the only one (handled above),
        # but allow deleting it if others exist.
        con.execute("DELETE FROM tasks WHERE board_id=?", (board_id,))
        cur = con.execute("DELETE FROM boards WHERE id=?", (board_id,))
        if cur.rowcount == 0:
            return jsonify({"error": "board not found"}), 404

        # Ensure there's still a default board and tasks don't point to null.
        _ = ensure_default_board(con)
        con.execute("UPDATE tasks SET board_id=? WHERE board_id IS NULL", (default_board_id,))

    return jsonify({"ok": True, "deleted": {"id": int(row["id"]), "name": str(row["name"])}})


@app.get("/api/tasks")
def api_list_tasks():
    with db() as con:
        default_board_id = ensure_default_board(con)
        bid = board_id_from_request(default_board_id)
        if bid is None:
            return jsonify({"error": "invalid board_id"}), 400
        rows = con.execute(
            """
            SELECT id, board_id, title, description, status, position, created_at, updated_at
            FROM tasks
            WHERE board_id=?
            ORDER BY status, position
            """,
            (bid,),
        ).fetchall()
        tasks = [dict(r) for r in rows]
        ids = [int(t["id"]) for t in tasks]
        tags_map = get_tags_for_tasks(con, ids)
        checklist_map = get_checklist_for_tasks(con, ids)
        for t in tasks:
            tid = int(t["id"])
            t["tags"] = tags_map.get(tid, [])
            t["checklist"] = checklist_map.get(tid, [])
    return jsonify({"tasks": tasks, "columns": COLUMNS, "board_id": bid})


@app.post("/api/tasks")
def api_create_task():
    data = request.get_json(force=True, silent=False) or {}
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    status = (data.get("status") or "todo").strip().lower()
    board_id = data.get("board_id")
    tags = normalize_tag_names(data.get("tags"))

    if not title:
        return jsonify({"error": "title is required"}), 400
    if status not in COLUMNS:
        return jsonify({"error": f"invalid status; must be one of {COLUMNS}"}), 400

    with db() as con:
        default_board_id = ensure_default_board(con)
        if board_id is None:
            board_id = default_board_id
        try:
            board_id = int(board_id)
        except Exception:
            return jsonify({"error": "invalid board_id"}), 400

        # place at end of column within board
        row = con.execute(
            "SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE board_id=? AND status=?",
            (board_id, status),
        ).fetchone()
        max_pos = float(row["m"] or 0)
        position = max_pos + 1000.0
        ts = now_iso()
        cur = con.execute(
            "INSERT INTO tasks(board_id, title, description, status, position, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
            (board_id, title, description, status, position, ts, ts),
        )
        task_id = int(cur.lastrowid)
        set_task_tags(con, task_id, tags)
        task = con.execute(
            "SELECT id, board_id, title, description, status, position, created_at, updated_at FROM tasks WHERE id=?",
            (task_id,),
        ).fetchone()
        task_dict = dict(task)
        task_dict["tags"] = get_tags_for_tasks(con, [task_id]).get(task_id, [])
    return jsonify({"task": task_dict}), 201


@app.patch("/api/tasks/<int:task_id>")
def api_update_task(task_id: int):
    data: Dict[str, Any] = request.get_json(force=True, silent=False) or {}

    fields: Dict[str, Any] = {}
    tags: Optional[List[str]] = None

    if "title" in data:
        fields["title"] = (data.get("title") or "").strip()
    if "description" in data:
        fields["description"] = (data.get("description") or "").strip()
    if "status" in data:
        fields["status"] = (data.get("status") or "").strip().lower()
        if fields["status"] not in COLUMNS:
            return jsonify({"error": f"invalid status; must be one of {COLUMNS}"}), 400
    if "position" in data:
        try:
            fields["position"] = float(data.get("position"))
        except Exception:
            return jsonify({"error": "position must be a number"}), 400
    if "board_id" in data:
        try:
            fields["board_id"] = int(data.get("board_id"))
        except Exception:
            return jsonify({"error": "invalid board_id"}), 400
    if "tags" in data:
        tags = normalize_tag_names(data.get("tags"))

    # Allow tag-only updates.
    if not fields and tags is None:
        return jsonify({"error": "no updatable fields provided"}), 400

    # If we're changing tags, still bump updated_at.
    fields["updated_at"] = now_iso()

    sets = ", ".join([f"{k}=?" for k in fields.keys()])
    vals = list(fields.values())

    with db() as con:
        cur = con.execute(f"UPDATE tasks SET {sets} WHERE id=?", (*vals, task_id))
        if cur.rowcount == 0:
            return jsonify({"error": "task not found"}), 404
        if tags is not None:
            set_task_tags(con, task_id, tags)
        task = con.execute(
            "SELECT id, board_id, title, description, status, position, created_at, updated_at FROM tasks WHERE id=?",
            (task_id,),
        ).fetchone()
        task_dict = dict(task)
        task_dict["tags"] = get_tags_for_tasks(con, [task_id]).get(task_id, [])
    return jsonify({"task": task_dict})


@app.get("/api/tags")
def api_list_tags():
    """List tags currently in use.

    A tag is considered "existing" if it is assigned to at least one task.

    If `board_id` is provided, only tags used by tasks on that board are returned.
    """
    with db() as con:
        default_board_id = ensure_default_board(con)
        bid = board_id_from_request(default_board_id)
        if bid is None:
            return jsonify({"error": "invalid board_id"}), 400

        rows = con.execute(
            """
            SELECT g.id, g.name, g.color, g.created_at, g.updated_at, COUNT(tt.task_id) AS usage
            FROM tags g
            JOIN task_tags tt ON tt.tag_id = g.id
            JOIN tasks t ON t.id = tt.task_id
            WHERE t.board_id = ?
            GROUP BY g.id
            HAVING usage > 0
            ORDER BY g.name
            """,
            (bid,),
        ).fetchall()
    return jsonify({"tags": [dict(r) for r in rows], "board_id": bid})


@app.get("/api/tasks/<int:task_id>/checklist")
def api_list_checklist(task_id: int):
    with db() as con:
        # Ensure task exists
        row = con.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            return jsonify({"error": "task not found"}), 404
        items = con.execute(
            "SELECT id, text, done, position FROM checklist_items WHERE task_id=? ORDER BY position",
            (task_id,),
        ).fetchall()
    return jsonify({"task_id": task_id, "items": [dict(i) for i in items]})


@app.post("/api/tasks/<int:task_id>/checklist")
def api_create_checklist_item(task_id: int):
    data = request.get_json(force=True, silent=False) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    ts = now_iso()
    with db() as con:
        row = con.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            return jsonify({"error": "task not found"}), 404
        r = con.execute(
            "SELECT COALESCE(MAX(position),0) AS m FROM checklist_items WHERE task_id=?",
            (task_id,),
        ).fetchone()
        pos = float(r["m"] or 0) + 1000.0
        cur = con.execute(
            "INSERT INTO checklist_items(task_id, text, done, position, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (task_id, text, 0, pos, ts, ts),
        )
        item_id = int(cur.lastrowid)
        item = con.execute(
            "SELECT id, task_id, text, done, position, created_at, updated_at FROM checklist_items WHERE id=?",
            (item_id,),
        ).fetchone()
    return jsonify({"item": dict(item)}), 201


@app.patch("/api/checklist/<int:item_id>")
def api_update_checklist_item(item_id: int):
    data: Dict[str, Any] = request.get_json(force=True, silent=False) or {}
    fields: Dict[str, Any] = {}
    if "text" in data:
        fields["text"] = (data.get("text") or "").strip()
    if "done" in data:
        fields["done"] = 1 if bool(data.get("done")) else 0
    if "position" in data:
        try:
            fields["position"] = float(data.get("position"))
        except Exception:
            return jsonify({"error": "position must be a number"}), 400

    if not fields:
        return jsonify({"error": "no updatable fields provided"}), 400

    fields["updated_at"] = now_iso()
    sets = ", ".join([f"{k}=?" for k in fields.keys()])
    vals = list(fields.values())

    with db() as con:
        cur = con.execute(f"UPDATE checklist_items SET {sets} WHERE id=?", (*vals, item_id))
        if cur.rowcount == 0:
            return jsonify({"error": "item not found"}), 404
        item = con.execute(
            "SELECT id, task_id, text, done, position FROM checklist_items WHERE id=?",
            (item_id,),
        ).fetchone()
    return jsonify({"item": dict(item)})


@app.delete("/api/checklist/<int:item_id>")
def api_delete_checklist_item(item_id: int):
    with db() as con:
        cur = con.execute("DELETE FROM checklist_items WHERE id=?", (item_id,))
        if cur.rowcount == 0:
            return jsonify({"error": "item not found"}), 404
    return jsonify({"ok": True})


@app.delete("/api/tasks/<int:task_id>")
def api_delete_task(task_id: int):
    with db() as con:
        cur = con.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        if cur.rowcount == 0:
            return jsonify({"error": "task not found"}), 404
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host=APP_HOST, port=APP_PORT, debug=False)
