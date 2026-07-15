import json
import os
from datetime import datetime, timedelta, timezone

from google.auth import default
from google.cloud import storage
from googleapiclient.discovery import build

SPREADSHEET_ID = os.environ.get(
    "SPREADSHEET_ID", "1q_Cbi9mF2mPYCcgeihes7uxQ1lw3Iq67RFznZuwUz0w"
)
RANGE = os.environ.get("SHEET_RANGE", "'RESULT_ADDONS'")
BUCKET_NAME = os.environ.get("GCS_BUCKET", "dj-newsroom-stag-shared")
BLOB_PREFIX = os.environ.get("GCS_PREFIX", "jon_leckie")
BLOB_NAME = f"{BLOB_PREFIX}/result_addons.json"

SHEETS_EPOCH = datetime(1899, 12, 30)


def convert_serial_dates(rows, date_col=0):
    for row in rows:
        if date_col < len(row) and isinstance(row[date_col], (int, float)):
            try:
                dt = SHEETS_EPOCH + timedelta(days=int(row[date_col]))
                row[date_col] = dt.strftime("%m/%d/%Y")
            except (ValueError, OverflowError):
                pass


def sync_sheet(request=None):
    """Cloud Function entry point. Reads the sheet and writes JSON to GCS."""
    creds, _ = default()
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)

    result = (
        service.spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range=RANGE,
            valueRenderOption="UNFORMATTED_VALUE",
            dateTimeRenderOption="SERIAL_NUMBER",
        )
        .execute()
    )

    rows = result.get("values", [])
    headers = [str(c) for c in rows[0]] if rows else []
    data_rows = rows[1:] if len(rows) > 1 else []

    convert_serial_dates(data_rows)

    payload = {
        "headers": headers,
        "rows": data_rows,
        "total": len(data_rows),
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }

    client = storage.Client()
    bucket = client.bucket(BUCKET_NAME)
    blob = bucket.blob(BLOB_NAME)
    blob.upload_from_string(json.dumps(payload), content_type="application/json")

    msg = f"Synced {len(data_rows)} rows at {payload['synced_at']}"
    print(msg)
    return msg


if __name__ == "__main__":
    sync_sheet()
