#!/usr/bin/env python3
"""ACD Germany - dealer lead management with a map of Germany.

Zero-dependency server (Python 3.9+ standard library only):

    python3 app.py            # http://localhost:8000
    python3 app.py --port 9000 --db /path/to/leads.db

Data is stored in a local SQLite database (default: data/leads.db).
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DEFAULT_DB = os.path.join(BASE_DIR, "data", "leads.db")

STATUSES = ["new", "contacted", "meeting", "negotiation", "dealer", "on_hold", "rejected"]
PRIORITIES = ["low", "medium", "high"]

# Editable lead fields and their type ("str", "float", "int").
LEAD_FIELDS = {
    "company": "str",
    "contact_name": "str",
    "email": "str",
    "phone": "str",
    "website": "str",
    "street": "str",
    "postal_code": "str",
    "city": "str",
    "state": "str",
    "lat": "float",
    "lng": "float",
    "status": "str",
    "priority": "str",
    "source": "str",
    "assigned_to": "str",
    "brands": "str",
    "notes": "str",
    "next_action": "str",
    "next_action_date": "str",
}

DEFAULT_SETTINGS = {
    # Minimum distance (km) wanted between two dealers / leads.
    "min_distance_km": 50,
    # Statuses that are ignored in the "too close" check.
    "ignore_statuses": ["rejected"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    website TEXT DEFAULT '',
    street TEXT DEFAULT '',
    postal_code TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    lat REAL,
    lng REAL,
    status TEXT NOT NULL DEFAULT 'new',
    priority TEXT NOT NULL DEFAULT 'medium',
    source TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '',
    brands TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    next_action TEXT DEFAULT '',
    next_action_date TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'note',
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ValidationError(Exception):
    pass


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points in kilometres."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def find_conflicts(leads, min_distance_km, ignore_statuses=()):
    """Return all pairs of located leads that are closer than min_distance_km."""
    located = [
        l for l in leads
        if l.get("lat") is not None and l.get("lng") is not None
        and l.get("status") not in ignore_statuses
    ]
    conflicts = []
    for i, a in enumerate(located):
        for b in located[i + 1:]:
            d = haversine_km(a["lat"], a["lng"], b["lat"], b["lng"])
            if d < min_distance_km:
                conflicts.append({"a": a["id"], "b": b["id"], "distance_km": round(d, 1)})
    conflicts.sort(key=lambda c: c["distance_km"])
    return conflicts


# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #
class Store:
    def __init__(self, path):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    # -- leads -------------------------------------------------------------- #
    @staticmethod
    def clean_lead(data, partial=False):
        if not isinstance(data, dict):
            raise ValidationError("Expected a JSON object")
        out = {}
        for key, kind in LEAD_FIELDS.items():
            if key not in data:
                continue
            value = data[key]
            if kind == "float":
                if value in (None, ""):
                    out[key] = None
                else:
                    try:
                        out[key] = float(str(value).replace(",", "."))
                    except ValueError:
                        raise ValidationError(f"'{key}' must be a number")
            else:
                out[key] = "" if value is None else str(value).strip()
        if not partial or "company" in out:
            if not out.get("company"):
                raise ValidationError("Company name is required")
        if "status" in out:
            out["status"] = out["status"] or "new"
            if out["status"] not in STATUSES:
                raise ValidationError(f"Unknown status '{out['status']}'")
        if "priority" in out:
            out["priority"] = out["priority"] or "medium"
            if out["priority"] not in PRIORITIES:
                raise ValidationError(f"Unknown priority '{out['priority']}'")
        if out.get("lat") is not None and not -90 <= out["lat"] <= 90:
            raise ValidationError("Latitude out of range")
        if out.get("lng") is not None and not -180 <= out["lng"] <= 180:
            raise ValidationError("Longitude out of range")
        return out

    def list_leads(self):
        rows = self.conn.execute(
            """SELECT l.*, (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id)
                   AS activity_count
               FROM leads l ORDER BY l.company COLLATE NOCASE"""
        ).fetchall()
        return [dict(r) for r in rows]

    def get_lead(self, lead_id):
        row = self.conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        return dict(row) if row else None

    def create_lead(self, data):
        lead = self.clean_lead(data)
        lead.setdefault("status", "new")
        lead.setdefault("priority", "medium")
        ts = now_iso()
        lead["created_at"] = lead["updated_at"] = ts
        cols = ", ".join(lead)
        marks = ", ".join("?" for _ in lead)
        with self.lock, self.conn:
            cur = self.conn.execute(
                f"INSERT INTO leads ({cols}) VALUES ({marks})", list(lead.values())
            )
            lead_id = cur.lastrowid
            self.conn.execute(
                "INSERT INTO activities (lead_id, type, text, created_at) VALUES (?,?,?,?)",
                (lead_id, "system", "Lead created", ts),
            )
        return self.get_lead(lead_id)

    def update_lead(self, lead_id, data):
        old = self.get_lead(lead_id)
        if not old:
            return None
        changes = self.clean_lead(data, partial=True)
        if not changes:
            return old
        ts = now_iso()
        changes["updated_at"] = ts
        assignments = ", ".join(f"{k} = ?" for k in changes)
        with self.lock, self.conn:
            self.conn.execute(
                f"UPDATE leads SET {assignments} WHERE id = ?", [*changes.values(), lead_id]
            )
            if "status" in changes and changes["status"] != old["status"]:
                self.conn.execute(
                    "INSERT INTO activities (lead_id, type, text, created_at) VALUES (?,?,?,?)",
                    (lead_id, "status",
                     f"Status changed from '{old['status']}' to '{changes['status']}'", ts),
                )
        return self.get_lead(lead_id)

    def delete_lead(self, lead_id):
        with self.lock, self.conn:
            cur = self.conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
        return cur.rowcount > 0

    # -- activities --------------------------------------------------------- #
    def list_activities(self, lead_id):
        rows = self.conn.execute(
            "SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC, id DESC",
            (lead_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def add_activity(self, lead_id, data):
        if not self.get_lead(lead_id):
            return None
        text = str((data or {}).get("text", "")).strip()
        if not text:
            raise ValidationError("Activity text is required")
        kind = str((data or {}).get("type", "note")).strip() or "note"
        ts = now_iso()
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO activities (lead_id, type, text, created_at) VALUES (?,?,?,?)",
                (lead_id, kind, text, ts),
            )
            self.conn.execute("UPDATE leads SET updated_at = ? WHERE id = ?", (ts, lead_id))
        row = self.conn.execute("SELECT * FROM activities WHERE id = ?", (cur.lastrowid,))
        return dict(row.fetchone())

    def delete_activity(self, activity_id):
        with self.lock, self.conn:
            cur = self.conn.execute("DELETE FROM activities WHERE id = ?", (activity_id,))
        return cur.rowcount > 0

    # -- settings ----------------------------------------------------------- #
    def get_settings(self):
        settings = dict(DEFAULT_SETTINGS)
        for row in self.conn.execute("SELECT key, value FROM settings"):
            settings[row["key"]] = json.loads(row["value"])
        return settings

    def update_settings(self, data):
        if not isinstance(data, dict):
            raise ValidationError("Expected a JSON object")
        clean = {}
        if "min_distance_km" in data:
            try:
                value = float(data["min_distance_km"])
            except (TypeError, ValueError):
                raise ValidationError("Minimum distance must be a number")
            if not 0 < value <= 1000:
                raise ValidationError("Minimum distance must be between 0 and 1000 km")
            clean["min_distance_km"] = value
        if "ignore_statuses" in data:
            values = data["ignore_statuses"]
            if not isinstance(values, list) or any(v not in STATUSES for v in values):
                raise ValidationError("ignore_statuses must be a list of known statuses")
            clean["ignore_statuses"] = values
        with self.lock, self.conn:
            for key, value in clean.items():
                self.conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(value)),
                )
        return self.get_settings()

    # -- CSV ---------------------------------------------------------------- #
    CSV_COLUMNS = ["id", *LEAD_FIELDS.keys(), "created_at", "updated_at"]

    def export_csv(self):
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=self.CSV_COLUMNS, extrasaction="ignore",
                                delimiter=";")
        writer.writeheader()
        for lead in self.list_leads():
            writer.writerow(lead)
        return buf.getvalue()

    def import_csv(self, text):
        text = text.lstrip("﻿")
        if not text.strip():
            raise ValidationError("The CSV file is empty")
        first_line = text.splitlines()[0]
        delimiter = ";" if first_line.count(";") >= first_line.count(",") else ","
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
        created, updated, errors = 0, 0, []
        for line_no, row in enumerate(reader, start=2):
            row = {(k or "").strip().lower(): (v or "") for k, v in row.items()}
            data = {k: row[k] for k in LEAD_FIELDS if k in row}
            try:
                lead_id = int(row["id"]) if row.get("id", "").strip() else None
                if lead_id and self.get_lead(lead_id):
                    self.update_lead(lead_id, data)
                    updated += 1
                else:
                    self.create_lead(data)
                    created += 1
            except (ValidationError, ValueError) as exc:
                errors.append(f"Line {line_no}: {exc}")
        return {"created": created, "updated": updated, "errors": errors}


# --------------------------------------------------------------------------- #
# Geocoding (OpenStreetMap Nominatim, max. 1 request per second)
# --------------------------------------------------------------------------- #
_geocode_lock = threading.Lock()
_geocode_last = [0.0]
_geocode_cache = {}


def geocode(query):
    query = query.strip()
    if not query:
        raise ValidationError("Empty search")
    if query in _geocode_cache:
        return _geocode_cache[query]
    params = urllib.parse.urlencode({
        "q": query, "format": "jsonv2", "addressdetails": 1, "limit": 5,
        "countrycodes": "de", "accept-language": "de",
    })
    req = urllib.request.Request(
        f"https://nominatim.openstreetmap.org/search?{params}",
        headers={"User-Agent": "ACD-Germany-Lead-Manager/1.0"},
    )
    with _geocode_lock:
        wait = 1.0 - (time.time() - _geocode_last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
        finally:
            _geocode_last[0] = time.time()
    results = []
    for item in raw:
        addr = item.get("address", {})
        street = " ".join(p for p in (addr.get("road", ""), addr.get("house_number", "")) if p)
        results.append({
            "label": item.get("display_name", ""),
            "lat": float(item["lat"]),
            "lng": float(item["lon"]),
            "street": street,
            "postal_code": addr.get("postcode", ""),
            "city": addr.get("city") or addr.get("town") or addr.get("village")
                    or addr.get("municipality", ""),
            "state": addr.get("state", ""),
        })
    _geocode_cache[query] = results
    return results


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(SimpleHTTPRequestHandler):
    store = None  # set in make_server()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if os.environ.get("ACD_QUIET"):
            return
        super().log_message(fmt, *args)

    # -- helpers ------------------------------------------------------------ #
    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length).decode("utf-8-sig") if length else ""

    def read_json(self):
        raw = self.read_body()
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            raise ValidationError("Invalid JSON")

    def route(self, method):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            return False
        try:
            self.dispatch(method, path)
        except ValidationError as exc:
            self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except (urllib.error.URLError, TimeoutError) as exc:
            self.send_error_json(HTTPStatus.BAD_GATEWAY, f"Geocoding service unavailable: {exc}")
        return True

    def dispatch(self, method, path):
        s = self.store
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        if path == "/api/meta" and method == "GET":
            return self.send_json({"statuses": STATUSES, "priorities": PRIORITIES})

        if path == "/api/leads":
            if method == "GET":
                return self.send_json(s.list_leads())
            if method == "POST":
                return self.send_json(s.create_lead(self.read_json()), HTTPStatus.CREATED)

        m = re.fullmatch(r"/api/leads/(\d+)", path)
        if m:
            lead_id = int(m.group(1))
            if method == "GET":
                lead = s.get_lead(lead_id)
            elif method == "PUT":
                lead = s.update_lead(lead_id, self.read_json())
            elif method == "DELETE":
                if s.delete_lead(lead_id):
                    return self.send_json({"ok": True})
                lead = None
            else:
                return self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")
            if lead is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Lead not found")
            return self.send_json(lead)

        m = re.fullmatch(r"/api/leads/(\d+)/activities", path)
        if m:
            lead_id = int(m.group(1))
            if not s.get_lead(lead_id):
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Lead not found")
            if method == "GET":
                return self.send_json(s.list_activities(lead_id))
            if method == "POST":
                return self.send_json(s.add_activity(lead_id, self.read_json()),
                                      HTTPStatus.CREATED)

        m = re.fullmatch(r"/api/activities/(\d+)", path)
        if m and method == "DELETE":
            if s.delete_activity(int(m.group(1))):
                return self.send_json({"ok": True})
            return self.send_error_json(HTTPStatus.NOT_FOUND, "Activity not found")

        if path == "/api/settings":
            if method == "GET":
                return self.send_json(s.get_settings())
            if method == "PUT":
                return self.send_json(s.update_settings(self.read_json()))

        if path == "/api/conflicts" and method == "GET":
            settings = s.get_settings()
            return self.send_json(find_conflicts(
                s.list_leads(), settings["min_distance_km"], settings["ignore_statuses"]))

        if path == "/api/geocode" and method == "GET":
            return self.send_json(geocode(query.get("q", [""])[0]))

        if path == "/api/export.csv" and method == "GET":
            body = s.export_csv().encode("utf-8-sig")
            stamp = datetime.now().strftime("%Y-%m-%d")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="leads-{stamp}.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/import" and method == "POST":
            return self.send_json(s.import_csv(self.read_body()))

        return self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")

    # -- verbs -------------------------------------------------------------- #
    def do_GET(self):
        if not self.route("GET"):
            super().do_GET()

    def do_POST(self):
        if not self.route("POST"):
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")

    def do_PUT(self):
        if not self.route("PUT"):
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")

    def do_DELETE(self):
        if not self.route("DELETE"):
            self.send_error_json(HTTPStatus.NOT_FOUND, "Not found")


def make_server(host, port, db_path):
    handler = type("BoundHandler", (Handler,), {"store": Store(db_path)})
    return ThreadingHTTPServer((host, port), handler)


def main():
    parser = argparse.ArgumentParser(description="ACD Germany lead manager")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Interface to bind (use 0.0.0.0 to share on your network)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=os.environ.get("ACD_DB", DEFAULT_DB),
                        help="Path to the SQLite database file")
    args = parser.parse_args()
    server = make_server(args.host, args.port, args.db)
    print(f"ACD Germany lead manager running on http://{args.host}:{args.port}")
    print(f"Database: {os.path.abspath(args.db)}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
