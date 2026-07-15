import json
import os
import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

# GCS cache configuration
GCS_BUCKET = os.getenv("GCS_BUCKET", "dj-newsroom-stag-shared")
GCS_PREFIX = os.getenv("GCS_PREFIX", "jon_leckie")
GCS_BLOB = f"{GCS_PREFIX}/result_addons.json"
GCS_LOCAL_TTL = int(os.getenv("GCS_LOCAL_TTL", "300"))  # re-read from bucket every 5 min

_gcs_cache = {"data": None, "loaded_at": 0}


def read_from_gcs():
    """Read cached sheet data from GCS. Returns dict or None."""
    now = time.time()
    if _gcs_cache["data"] and (now - _gcs_cache["loaded_at"]) < GCS_LOCAL_TTL:
        return _gcs_cache["data"]
    try:
        from google.cloud import storage as gcs_lib
        client = gcs_lib.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(GCS_BLOB)
        if not blob.exists():
            return None
        raw = blob.download_as_text()
        data = json.loads(raw)
        _gcs_cache["data"] = data
        _gcs_cache["loaded_at"] = now
        return data
    except Exception:
        return _gcs_cache["data"]

from gsheets import SheetsClient

app = Flask(__name__)
CORS(app, origins=[os.getenv("ALLOWED_ORIGIN", "http://localhost:3000")])

from ai import ai_bp
app.register_blueprint(ai_bp, url_prefix="/ai")

FIELD_ORDER = ["primary", "bigNumberHed", "bigNumberDek", "line1", "line2"]

import re

SPREADSHEET_URL_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]+)")


def extract_spreadsheet_id(raw):
    """Accept a full Google Sheets URL or a bare spreadsheet ID."""
    match = SPREADSHEET_URL_RE.search(raw)
    if match:
        return match.group(1)
    return raw.split("/")[0].split("?")[0]


def get_client():
    env_file = os.getenv("GOOGLE_ENV_FILE")
    if env_file:
        return SheetsClient.from_env(env_file)
    return SheetsClient.from_env()


@app.route("/read", methods=["GET"])
def read_sheet():
    raw_id = request.args.get("spreadsheet")
    range_str = request.args.get("range")

    if not raw_id or not range_str:
        return jsonify({"error": "spreadsheet and range params required"}), 400

    spreadsheet_id = extract_spreadsheet_id(raw_id)

    try:
        client = get_client()
        spreadsheet = client.spreadsheet(spreadsheet_id)
        rows = spreadsheet.cells.read(range_str)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    cards = []
    for row in rows:
        card = {}
        for i, field in enumerate(FIELD_ORDER):
            if i < len(row) and row[i]:
                card[field] = str(row[i])
        if card:
            cards.append(card)

    return jsonify({"cards": cards, "fields": FIELD_ORDER})


def convert_dates(data_rows, date_col=0):
    """Convert serial date numbers to MM/DD/YYYY strings."""
    from datetime import datetime, timedelta
    SHEETS_EPOCH = datetime(1899, 12, 30)
    for row in data_rows:
        if date_col < len(row) and isinstance(row[date_col], (int, float)):
            try:
                dt = SHEETS_EPOCH + timedelta(days=int(row[date_col]))
                row[date_col] = dt.strftime("%m/%d/%Y")
            except (ValueError, OverflowError):
                pass


@app.route("/raw", methods=["GET"])
def read_raw():
    """Return all rows/columns without field mapping — for table display."""
    raw_id = request.args.get("spreadsheet")
    range_str = request.args.get("range")
    after = request.args.get("after")  # Optional: only return rows after this date (MM/DD/YYYY)

    if not raw_id or not range_str:
        return jsonify({"error": "spreadsheet and range params required"}), 400

    # Try GCS cache first
    cached = read_from_gcs()
    synced_at = None
    if cached:
        headers = cached.get("headers", [])
        data_rows = cached.get("rows", [])
        synced_at = cached.get("synced_at")
    else:
        # Fallback: read directly from Google Sheets
        spreadsheet_id = extract_spreadsheet_id(raw_id)
        try:
            client = get_client()
            spreadsheet = client.spreadsheet(spreadsheet_id)
            rows = spreadsheet.cells.read(range_str, value_render="UNFORMATTED_VALUE")
        except Exception as e:
            return jsonify({"error": str(e)}), 500

        if not rows:
            return jsonify({"headers": [], "rows": []})

        headers = [str(c) for c in rows[0]] if rows else []
        data_rows = rows[1:] if len(rows) > 1 else []
        convert_dates(data_rows)

    if after:
        from datetime import datetime
        try:
            cutoff = datetime.strptime(after, "%m/%d/%Y")
            data_rows = [r for r in data_rows if r and r[0] and
                         datetime.strptime(str(r[0]), "%m/%d/%Y") > cutoff]
        except ValueError:
            pass

    response = {"headers": headers, "rows": data_rows, "total": len(data_rows)}
    if synced_at:
        response["synced_at"] = synced_at
    return jsonify(response)


@app.route("/sheets", methods=["GET"])
def list_sheets():
    """Return sheet names for a given spreadsheet so users know valid range prefixes."""
    raw_id = request.args.get("spreadsheet")
    if not raw_id:
        return jsonify({"error": "spreadsheet param required"}), 400

    spreadsheet_id = extract_spreadsheet_id(raw_id)
    try:
        client = get_client()
        spreadsheet = client.spreadsheet(spreadsheet_id)
        props = spreadsheet.get_sheet_properties()
        names = [p.title for p in props]
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"sheets": names})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.getenv("SHEETS_SERVICE_PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=os.getenv("FLASK_DEBUG", "0") == "1")
