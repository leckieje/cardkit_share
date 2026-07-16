import os
import json
import time
from flask import Blueprint, request, jsonify
from dotenv import load_dotenv
from google import genai

load_dotenv()

ai_bp = Blueprint("ai", __name__)

GCP_PROJECT = os.environ.get("GCP_PROJECT", "dj-newsrm-stag-aiml")
GCP_LOCATION = os.environ.get("GCP_LOCATION", "us-central1")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_client = None

# Aggregate cache: avoids recomputing on every chat message
_agg_cache = {"text": None, "rows_hash": None, "computed_at": 0}
AGG_CACHE_TTL = 300  # 5 minutes


def get_client():
    global _client
    if _client is None:
        _client = genai.Client(vertexai=True, project=GCP_PROJECT, location=GCP_LOCATION)
    return _client


def get_cached_aggregates(rows):
    """Return cached aggregates text if the data hasn't changed, else recompute."""
    now = time.time()
    rows_hash = len(rows)  # cheap proxy: row count changes when data updates
    if (_agg_cache["text"] and
            _agg_cache["rows_hash"] == rows_hash and
            (now - _agg_cache["computed_at"]) < AGG_CACHE_TTL):
        return _agg_cache["text"]
    result = compute_aggregates(rows)
    _agg_cache["text"] = result
    _agg_cache["rows_hash"] = rows_hash
    _agg_cache["computed_at"] = now
    return result


def get_server_rows():
    """Get rows from the server-side GCS cache (avoids frontend re-upload)."""
    # Import inside function to avoid circular import (app.py imports ai.py as blueprint)
    import app as _app
    cached = _app.read_from_gcs()
    if cached:
        return cached.get("headers", []), cached.get("rows", [])
    return [], []


def filter_rows_by_period(rows, year, month, half="full"):
    from datetime import datetime
    filtered = []
    for row in rows:
        try:
            d = datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        if d.year != year or d.month != month:
            continue
        if half == "first" and d.day > 15:
            continue
        if half == "second" and d.day <= 15:
            continue
        filtered.append(row)
    return filtered


def filter_rows_by_quarter(rows, year, quarter):
    from datetime import datetime
    start_month = (quarter - 1) * 3 + 1
    end_month = quarter * 3
    filtered = []
    for row in rows:
        try:
            d = datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        if d.year == year and start_month <= d.month <= end_month:
            filtered.append(row)
    return filtered


def extract_period_from_question(question):
    """Parse a time period from a natural-language question. Returns (year, month, half, quarter) or Nones."""
    import re
    from datetime import datetime

    q = question.lower()
    now = datetime.now()

    month_names = {
        "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
        "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }

    # Detect quarter (e.g. "Q1 2025", "first quarter 2025")
    quarter_match = re.search(r'\bq([1-4])\s*(\d{4})?\b', q)
    if not quarter_match:
        quarter_words = {"first": 1, "second": 2, "third": 3, "fourth": 4}
        qw_match = re.search(r'\b(first|second|third|fourth)\s+quarter\b', q)
        if qw_match:
            quarter_num = quarter_words[qw_match.group(1)]
            year_match = re.search(r'\b(20\d{2})\b', q)
            year = int(year_match.group(1)) if year_match else now.year
            return (year, None, None, quarter_num)
    else:
        quarter_num = int(quarter_match.group(1))
        year = int(quarter_match.group(2)) if quarter_match.group(2) else now.year
        return (year, None, None, quarter_num)

    # Detect month
    month = None
    for name, num in month_names.items():
        if re.search(r'\b' + name + r'\b', q):
            month = num
            break

    if not month:
        return (None, None, None, None)

    # Detect year
    year_match = re.search(r'\b(20\d{2})\b', q)
    year = int(year_match.group(1)) if year_match else now.year

    # Detect half
    half = "full"
    if re.search(r'\b(first\s+half|1st\s+half|first\s+15|days?\s*1.?15)\b', q):
        half = "first"
    elif re.search(r'\b(second\s+half|2nd\s+half|last\s+half|days?\s*16.?3[01])\b', q):
        half = "second"

    return (year, month, half, None)


def extract_entities_from_question(question, rows):
    """Extract firm, platform, sector, or acquire company mentioned in the question.
    Returns dict with matched column filters: {col_idx: value}."""
    import re
    q_lower = question.lower()

    # Words that commonly appear in questions but shouldn't match entity names
    stop_words = {"first", "second", "third", "fourth", "last", "half", "full",
                  "quarter", "month", "year", "deals", "deal", "show", "me",
                  "the", "in", "by", "for", "of", "and", "all", "how", "many",
                  "what", "which", "who", "done", "made", "did", "do", "from",
                  "to", "with", "about", "most", "top", "recent", "new"}

    # Build lookup sets from unique values in the data
    col_map = {5: set(), 9: set(), 10: set(), 11: set()}
    for row in rows:
        for col_idx in col_map:
            val = str(row[col_idx]).strip() if len(row) > col_idx and row[col_idx] else ""
            if val:
                col_map[col_idx].add(val)

    matches = {}
    for col_idx, values in col_map.items():
        # Only consider values with at least 4 chars and not a stop word
        candidates = [v for v in values if len(v) >= 4 and v.lower() not in stop_words]
        # Sort by length descending to prioritize longer (more specific) matches
        candidates.sort(key=len, reverse=True)
        for val in candidates:
            val_lower = val.lower()
            # Always use word boundary matching to avoid substring false positives
            # (e.g. "Format" inside "information")
            if re.search(r'\b' + re.escape(val_lower) + r'\b', q_lower):
                matches[col_idx] = val
                break

    return matches


def build_targeted_sample(rows, period_rows, entity_filters, aggregates_text, period_year, period_month, period_half):
    """Build a targeted sample: filter period rows by mentioned entities.
    Cross-check against aggregates and do a broader search if counts don't match."""
    from datetime import datetime

    if not period_rows or not entity_filters:
        return period_rows, None

    # Filter period rows by entity matches
    targeted = []
    for row in period_rows:
        match = True
        for col_idx, val in entity_filters.items():
            row_val = str(row[col_idx]).strip() if len(row) > col_idx and row[col_idx] else ""
            if row_val != val:
                match = False
                break
        if match:
            targeted.append(row)

    # Cross-check: try to find expected count from aggregates
    # Look for the firm name + count in the aggregate text
    expected_count = None
    if 5 in entity_filters:
        import re
        firm_name = entity_filters[5]
        # Aggregates format: "FirmName: X deals"
        pattern = re.escape(firm_name) + r':\s*(\d+)\s*deal'
        agg_match = re.search(pattern, aggregates_text, re.IGNORECASE)
        if agg_match:
            expected_count = int(agg_match.group(1))

    discrepancy_note = None
    if expected_count and len(targeted) < expected_count:
        # Targeted filter found fewer rows than aggregates say exist —
        # do a broader search across ALL rows (not just period) for this entity
        broader = []
        for row in rows:
            row_val = str(row[5]).strip() if len(row) > 5 and row[5] else ""
            if 5 in entity_filters and row_val == entity_filters[5]:
                try:
                    d = datetime.strptime(str(row[0]), "%m/%d/%Y")
                    if d.year == period_year and d.month == period_month:
                        if period_half == "first" and d.day <= 15:
                            broader.append(row)
                        elif period_half == "second" and d.day > 15:
                            broader.append(row)
                        elif period_half == "full":
                            broader.append(row)
                except (ValueError, IndexError):
                    pass

        if len(broader) > len(targeted):
            targeted = broader

        if len(targeted) < expected_count:
            discrepancy_note = f"Note: Aggregates indicate {expected_count} deals for {entity_filters.get(5, 'this entity')} in this period, but only {len(targeted)} rows found in the raw data."

    return targeted, discrepancy_note


def build_data_context(rows, headers, month_label, period_rows, mom_rows, yoy_rows):
    ctx = f"Dataset: WSJ Pro Add-On Deals database.\n"
    ctx += f"Columns: {', '.join(headers)}\n"
    ctx += f"Total rows in dataset: {len(rows)}\n\n"

    ctx += f"Selected period: {month_label}\n"
    ctx += f"Deals in period: {len(period_rows)} rows\n\n"

    if period_rows:
        ctx += "Period data (first 200 rows):\n"
        for row in period_rows[:200]:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"

    if mom_rows is not None:
        ctx += f"\nPrevious month data ({len(mom_rows)} rows, first 100):\n"
        for row in mom_rows[:100]:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"

    if yoy_rows is not None:
        ctx += f"\nSame month last year data ({len(yoy_rows)} rows, first 100):\n"
        for row in yoy_rows[:100]:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"

    return ctx


def compute_period_summary(rows, year, month, half):
    """Compute stats for a specific period from raw rows."""
    from collections import defaultdict
    period_rows = filter_rows_by_period(rows, year, month, half)
    deals = set()
    firms = defaultdict(lambda: {"deals": set(), "sectors": set(), "platforms": set(), "acquisitions": []})
    sectors = defaultdict(set)  # sector -> set of deal codes

    for row in period_rows:
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        platform = str(row[9]).strip() if len(row) > 9 and row[9] else ""
        acquisition = str(row[10]).strip() if len(row) > 10 and row[10] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""

        if deal_code:
            deals.add(deal_code)
        if firm:
            firms[firm]["deals"].add(deal_code)
            if sector:
                firms[firm]["sectors"].add(sector)
            if platform:
                firms[firm]["platforms"].add(platform)
            if acquisition:
                firms[firm]["acquisitions"].append(acquisition)
        if sector and deal_code:
            sectors[sector].add(deal_code)

    top_firms = sorted(firms.items(), key=lambda x: -len(x[1]["deals"]))[:5]
    top_sectors = sorted(sectors.items(), key=lambda x: -len(x[1]))[:5]

    summary = f"Unique deals: {len(deals)}\n"
    summary += f"Unique PE firms: {len(firms)}\n"
    summary += f"Top sectors: {', '.join(f'{s} ({len(c)} deals)' for s, c in top_sectors)}\n"
    summary += f"Top PE firms:\n"
    for name, info in top_firms:
        summary += f"  - {name}: {len(info['deals'])} deals, sectors: {', '.join(list(info['sectors'])[:3])}, platforms: {', '.join(list(info['platforms'])[:3])}, acquisitions: {', '.join(info['acquisitions'][:3])}\n"

    # Firm-by-sector breakdown: for every firm, list unique deal count per sector
    summary += "Firm activity by sector:\n"
    firm_sector_map = defaultdict(lambda: defaultdict(set))
    for row in period_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and sector and deal_code:
            firm_sector_map[firm][sector].add(deal_code)
    for firm_name, sector_deals in sorted(firm_sector_map.items(), key=lambda x: -sum(len(v) for v in x[1].values()))[:10]:
        sector_str = ", ".join(f"{s}({len(d)})" for s, d in sorted(sector_deals.items(), key=lambda x: -len(x[1])))
        summary += f"  - {firm_name}: {sector_str}\n"

    return summary, len(deals)


def build_top_firms_detail(rows, year, month, half, top_firms_list):
    """Build a detailed breakdown of the top firms' actual deals for the auto-card prompt."""
    period_rows = filter_rows_by_period(rows, year, month, half)
    top_firm_names = set(name for name, _ in top_firms_list[:5])
    detail = ""
    for firm_name, deal_count in top_firms_list[:5]:
        detail += f"\n{firm_name} ({deal_count} deals):\n"
        for row in period_rows:
            row_firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
            if row_firm == firm_name:
                date = str(row[0]) if row[0] else ""
                platform = str(row[9]).strip() if len(row) > 9 and row[9] else ""
                acquisition = str(row[10]).strip() if len(row) > 10 and row[10] else ""
                sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
                detail += f"  - {date}: platform={platform}, acquired={acquisition}, sector={sector}\n"
    return detail


def compute_historical_context(rows, month, half):
    """Compute deal counts for the same month/half across all years for historical comparison."""
    from datetime import datetime
    from collections import defaultdict

    year_deals = defaultdict(set)
    for row in rows:
        try:
            d = datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        if d.month != month:
            continue
        if half == "first" and d.day > 15:
            continue
        if half == "second" and d.day <= 15:
            continue
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if deal_code:
            year_deals[d.year].add(deal_code)

    return {y: len(deals) for y, deals in sorted(year_deals.items())}


def compute_quarter_summary(rows, year, quarter):
    """Compute stats for a specific quarter from raw rows."""
    from collections import defaultdict
    period_rows = filter_rows_by_quarter(rows, year, quarter)
    deals = set()
    firms = defaultdict(lambda: {"deals": set(), "sectors": set(), "platforms": set(), "acquisitions": []})
    sectors = defaultdict(set)  # sector -> set of deal codes

    for row in period_rows:
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        platform = str(row[9]).strip() if len(row) > 9 and row[9] else ""
        acquisition = str(row[10]).strip() if len(row) > 10 and row[10] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""

        if deal_code:
            deals.add(deal_code)
        if firm:
            firms[firm]["deals"].add(deal_code)
            if sector:
                firms[firm]["sectors"].add(sector)
            if platform:
                firms[firm]["platforms"].add(platform)
            if acquisition:
                firms[firm]["acquisitions"].append(acquisition)
        if sector and deal_code:
            sectors[sector].add(deal_code)

    top_firms = sorted(firms.items(), key=lambda x: -len(x[1]["deals"]))[:5]
    top_sectors = sorted(sectors.items(), key=lambda x: -len(x[1]))[:5]

    summary = f"Unique deals: {len(deals)}\n"
    summary += f"Unique PE firms: {len(firms)}\n"
    summary += f"Top sectors: {', '.join(f'{s} ({len(c)} deals)' for s, c in top_sectors)}\n"
    summary += f"Top PE firms:\n"
    for name, info in top_firms:
        summary += f"  - {name}: {len(info['deals'])} deals, sectors: {', '.join(list(info['sectors'])[:3])}, platforms: {', '.join(list(info['platforms'])[:3])}, acquisitions: {', '.join(info['acquisitions'][:3])}\n"

    # Firm-by-sector breakdown (unique deals)
    summary += "Firm activity by sector:\n"
    firm_sector_map = defaultdict(lambda: defaultdict(set))
    for row in period_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and sector and deal_code:
            firm_sector_map[firm][sector].add(deal_code)
    for firm_name, sector_deals in sorted(firm_sector_map.items(), key=lambda x: -sum(len(v) for v in x[1].values()))[:10]:
        sector_str = ", ".join(f"{s}({len(d)})" for s, d in sorted(sector_deals.items(), key=lambda x: -len(x[1])))
        summary += f"  - {firm_name}: {sector_str}\n"

    return summary, len(deals)


def compute_historical_quarters(rows, quarter):
    """Compute deal counts for the same quarter across all years."""
    from datetime import datetime
    from collections import defaultdict

    start_month = (quarter - 1) * 3 + 1
    end_month = quarter * 3
    year_deals = defaultdict(set)
    for row in rows:
        try:
            d = datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        if start_month <= d.month <= end_month:
            deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
            if deal_code:
                year_deals[d.year].add(deal_code)

    return {y: len(deals) for y, deals in sorted(year_deals.items())}


@ai_bp.route("/auto-card", methods=["POST"])
def auto_card():
    data = request.json or {}
    headers = data.get("headers", [])
    rows = data.get("rows", [])
    year = data.get("year")
    period_type = data.get("period_type", "month")

    if not rows or not year:
        return jsonify({"error": "rows and year are required"}), 400

    if period_type == "quarter":
        return auto_card_quarter(data, rows, headers, year)

    month = data.get("month")
    half = data.get("half", "full")

    if not month:
        return jsonify({"error": "month is required for monthly mode"}), 400

    month_names_short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                         'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    month_names_full = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December']
    month_full = month_names_full[month - 1]
    month_label = f"{month_names_short[month - 1]} {year}"
    if half == "first":
        month_label += " (1st half)"

    # Compute stats for current, previous month, and YoY
    current_summary, current_deals = compute_period_summary(rows, year, month, half)

    prev_year = year if month > 1 else year - 1
    prev_month = month - 1 if month > 1 else 12
    mom_summary, mom_deals = compute_period_summary(rows, prev_year, prev_month, half)

    yoy_summary, yoy_deals = compute_period_summary(rows, year - 1, month, half)

    mom_pct = round(((current_deals - mom_deals) / mom_deals) * 100) if mom_deals else 0
    yoy_pct = round(((current_deals - yoy_deals) / yoy_deals) * 100) if yoy_deals else 0

    # Historical context: same month/half across all years
    historical = compute_historical_context(rows, month, half)
    historical_str = ", ".join(f"{y}: {c} deals" for y, c in historical.items())

    # Compute sector YoY changes for the current period (unique deals, not rows)
    from collections import defaultdict
    current_sector_rows = filter_rows_by_period(rows, year, month, half)
    yoy_sector_rows = filter_rows_by_period(rows, year - 1, month, half)
    current_sectors = defaultdict(set)
    yoy_sectors = defaultdict(set)
    for row in current_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]).strip() if len(row) > 1 and row[1] else ""
        if sector and deal_code:
            current_sectors[sector].add(deal_code)
    for row in yoy_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]).strip() if len(row) > 1 and row[1] else ""
        if sector and deal_code:
            yoy_sectors[sector].add(deal_code)
    sector_changes = []
    for sector in current_sectors:
        curr = len(current_sectors[sector])
        prev = len(yoy_sectors.get(sector, set()))
        pct = round(((curr - prev) / prev) * 100) if prev else None
        sector_changes.append((sector, curr, prev, pct))
    sector_changes.sort(key=lambda x: x[1], reverse=True)
    sector_yoy_str = "\n".join(
        f"  - {s}: {c} deals now vs {p} last year ({pct:+d}%)" if pct is not None else f"  - {s}: {c} deals (new)"
        for s, c, p, pct in sector_changes[:8]
    )

    period_title = f"{month_full.upper()} SPOTLIGHT"

    # Build period reference for the prompt
    if half == "first":
        period_ref = f"the first half of {month_full}"
    elif half == "second":
        period_ref = f"the second half of {month_full}"
    else:
        period_ref = month_full

    # Build structured stats for verification
    from collections import defaultdict as _dd
    top_firms_list = []
    period_rows_for_firms = filter_rows_by_period(rows, year, month, half)
    firm_deals = {}
    for row in period_rows_for_firms:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and deal_code:
            if firm not in firm_deals:
                firm_deals[firm] = set()
            firm_deals[firm].add(deal_code)
    top_firms_list = sorted(firm_deals.items(), key=lambda x: -len(x[1]))[:10]
    top_firms_list = [(name, len(deals)) for name, deals in top_firms_list]

    top_sectors_list = [(s, c, p) for s, c, p, _ in sector_changes[:8]]

    stats = {
        "deal_count": current_deals,
        "yoy_pct": yoy_pct,
        "mom_pct": mom_pct,
        "yoy_deals": yoy_deals,
        "mom_deals": mom_deals,
        "top_firms": top_firms_list,
        "top_sectors": [(s, c) for s, c, _ in top_sectors_list],
    }

    # Build verified facts block (placed FIRST in prompt to anchor the model)
    verified_facts = f"""=== VERIFIED FACTS — USE ONLY THESE NUMBERS ===
Deal count this period: {current_deals}
YoY change: {yoy_pct:+d}% (from {yoy_deals} deals last year)
MoM change: {mom_pct:+d}% (from {mom_deals} deals previous month)
bigNumberHed MUST be: "{yoy_pct:+d}%"

Top PE firms (by unique deal count):
"""
    for fname, fcount in top_firms_list[:5]:
        verified_facts += f"  - {fname}: {fcount} deals\n"
    verified_facts += "\nTop sectors:\n"
    for sname, scurr, sprev in top_sectors_list[:5]:
        s_yoy = round(((scurr - sprev) / sprev) * 100) if sprev else None
        if s_yoy is not None:
            verified_facts += f"  - {sname}: {scurr} deals ({s_yoy:+d}% YoY)\n"
        else:
            verified_facts += f"  - {sname}: {scurr} deals (new)\n"
    verified_facts += f"\nHistorical (same period by year): {historical_str}\n"

    prompt = f"""{verified_facts}

=== EXAMPLES OF GOOD OUTPUT ===

Example 1 (full month, YoY +21%):
{{"primary": "AUGUST SPOTLIGHT", "bigNumberHed": "+21%", "bigNumberDek": "", "line1": "The number of add-on deals tracked by WSJ Pro grew 21% in July from a year earlier. The period's 233 deals were the most since January and marked the most active July since recording began in 2017.", "line2": "BHMS Investments completed 10 add-on deals and helped push growth in the Insurance sector to 12% on a yearly basis. The firm was joined by Ares Management and Lightyear Capital that each completed 7 add-on deals."}}

Example 2 (full month, YoY +14%, MoM -11%):
{{"primary": "DECEMBER SPOTLIGHT", "bigNumberHed": "+14%", "bigNumberDek": "", "line1": "The number of add-on deals in November grew 14% from a year earlier, according to data tracked by WSJ Pro. On a monthly basis, deal counts were down 11% from October.", "line2": "Insurance showed the greatest declines among sectors with at least 15 deals, dropping 30% year over year. Health Care Life Sciences saw the largest gains with deal counts growing 27%."}}

Example 3 (1st half, YoY +53%):
{{"primary": "JULY SPOTLIGHT", "bigNumberHed": "+53%", "bigNumberDek": "", "line1": "The number of add-on deals tracked by WSJ Pro grew 53% in the first half of July from a year earlier. The period's 119 deals were the fastest start to the month since 2021.", "line2": "BHMS Investments was the most active with 5 add-on deals. The private equity firm focused on the Insurance sector with expansions of its King Risk Partners and Inzone Insurance Services platforms."}}

Example 4 (1st half, YoY +23%):
{{"primary": "DECEMBER SPOTLIGHT", "bigNumberHed": "+23%", "bigNumberDek": "", "line1": "Total add-on deals tracked by WSJ Pro grew 23% in the first half of December from a year earlier. The period's 133 deals marks the fastest start to the month since 2021.", "line2": "TPG was the most active in the period. The Texas-based private equity firm completed five add-on deals in the Security and Financial Services sectors."}}

Example 5 (full month, YoY +5%, MoM +34%):
{{"primary": "OCTOBER SPOTLIGHT", "bigNumberHed": "+5%", "bigNumberDek": "", "line1": "The number of add-on deals tracked by WSJ Pro grew 5% in September from a year earlier. The period's 250 deals were the most since January and a 34% increase from deal counts in August.", "line2": "Health Care and Life Sciences accounted for more than 15% of add-on deals over the past month. New Mountain Capital led investments in the sector with acquisitions that included Digital Owl and Pieces Technologies."}}

Example 6 (full month, MoM -21%):
{{"primary": "SEPTEMBER SPOTLIGHT", "bigNumberHed": "-21%", "bigNumberDek": "", "line1": "August posted the lowest number of add-on deals for any month so far this year, according to data tracked by WSJ Pro. The period's 185 deals marked a 21% decline from July but still rose 11% from August 2024.", "line2": "TA Associates completed 5 add-on deals in August with investments in the Financial Services sector that included acquisitions of ESQ Data Solutions and the digital banking platform Apiture."}}

=== RULES (non-negotiable) ===
- bigNumberHed is ALWAYS the YoY % change with sign: "+14%" or "-21%"
- line1 MUST contain the phrase "tracked by WSJ Pro" or "according to data tracked by WSJ Pro" — every single time.
- line1: 2-3 tight sentences. Vary your opening. Use deal count, historical rank, and MoM change naturally.
- line2: 1-2 sentences. Pick ONE angle: top firm + named acquisitions, OR sector trend with YoY %. Don't cram both.
- NEVER use parentheses in any output field. Write everything inline.
- Write numbers under 10 as words. Use "period's" not "period has."
- Never use "approximately," "notably," "significant," "robust," or "showcasing." No AI filler.
- The title for this card is always "{period_title}".

=== DATA FOR THIS CARD: {month_label} ===

{current_summary}
Previous month: {mom_pct:+d}% change ({mom_deals} → {current_deals} deals)
Year over year: {yoy_pct:+d}% change ({yoy_deals} → {current_deals} deals)

Sector YoY:
{sector_yoy_str}

=== RAW DEAL DATA FOR TOP FIRMS (use for accurate names in line2) ===
{build_top_firms_detail(rows, year, month, half, top_firms_list)}

=== CRITICAL: VERIFY BEFORE OUTPUT ===
- bigNumberHed MUST be exactly "{yoy_pct:+d}%" — no rounding, no changes.
- Any deal count you write in line1 or line2 MUST match the VERIFIED FACTS above.
- Any firm name in line2 MUST appear in the "Top PE firms" list above.
- Any sector name MUST appear in the "Top sectors" list above.
- If a fact is not in the verified data above, DO NOT include it.

=== OUTPUT ===
Respond with ONLY the JSON object. No markdown, no explanation."""

    try:
        client = get_client()
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        result = json.loads(text)
        result["_stats"] = stats
        return jsonify(result)
    except json.JSONDecodeError:
        return jsonify({"error": "AI returned invalid JSON", "raw": text}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def auto_card_quarter(data, rows, headers, year):
    from collections import defaultdict
    quarter = data.get("quarter")
    if not quarter:
        return jsonify({"error": "quarter is required for quarterly mode"}), 400

    quarter_names = {1: "first", 2: "second", 3: "third", 4: "fourth"}
    quarter_label = f"Q{quarter} {year}"

    current_summary, current_deals = compute_quarter_summary(rows, year, quarter)

    # Previous quarter
    prev_q = quarter - 1 if quarter > 1 else 4
    prev_q_year = year if quarter > 1 else year - 1
    qoq_summary, qoq_deals = compute_quarter_summary(rows, prev_q_year, prev_q)

    # Same quarter last year
    yoy_summary, yoy_deals = compute_quarter_summary(rows, year - 1, quarter)

    qoq_pct = round(((current_deals - qoq_deals) / qoq_deals) * 100) if qoq_deals else 0
    yoy_pct = round(((current_deals - yoy_deals) / yoy_deals) * 100) if yoy_deals else 0

    # Historical quarterly context
    historical = compute_historical_quarters(rows, quarter)
    historical_str = ", ".join(f"{y}: {c} deals" for y, c in historical.items())

    # Sector YoY changes (unique deals, not rows)
    current_sector_rows = filter_rows_by_quarter(rows, year, quarter)
    yoy_sector_rows = filter_rows_by_quarter(rows, year - 1, quarter)
    current_sectors = defaultdict(set)
    yoy_sectors = defaultdict(set)
    for row in current_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]).strip() if len(row) > 1 and row[1] else ""
        if sector and deal_code:
            current_sectors[sector].add(deal_code)
    for row in yoy_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]).strip() if len(row) > 1 and row[1] else ""
        if sector and deal_code:
            yoy_sectors[sector].add(deal_code)
    sector_changes = []
    for sector in current_sectors:
        curr = len(current_sectors[sector])
        prev = len(yoy_sectors.get(sector, set()))
        pct = round(((curr - prev) / prev) * 100) if prev else None
        sector_changes.append((sector, curr, prev, pct))
    sector_changes.sort(key=lambda x: x[1], reverse=True)
    sector_yoy_str = "\n".join(
        f"  - {s}: {c} deals now vs {p} last year ({pct:+d}%)" if pct is not None else f"  - {s}: {c} deals (new)"
        for s, c, p, pct in sector_changes[:8]
    )

    period_title = "QUARTERLY SPOTLIGHT"

    # Build structured stats for quarterly verification
    top_firms_list = []
    firm_deals = {}
    for row in current_sector_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and deal_code:
            if firm not in firm_deals:
                firm_deals[firm] = set()
            firm_deals[firm].add(deal_code)
    top_firms_list = sorted(firm_deals.items(), key=lambda x: -len(x[1]))[:10]
    top_firms_list = [(name, len(deals)) for name, deals in top_firms_list]

    top_sectors_list = [(s, c, p) for s, c, p, _ in sector_changes[:8]]

    stats = {
        "deal_count": current_deals,
        "yoy_pct": yoy_pct,
        "qoq_pct": qoq_pct,
        "yoy_deals": yoy_deals,
        "qoq_deals": qoq_deals,
        "top_firms": top_firms_list,
        "top_sectors": [(s, c) for s, c, _ in top_sectors_list],
    }

    # Build verified facts block
    verified_facts = f"""=== VERIFIED FACTS — USE ONLY THESE NUMBERS ===
Deal count this quarter: {current_deals}
YoY change: {yoy_pct:+d}% (from {yoy_deals} deals in Q{quarter} {year - 1})
QoQ change: {qoq_pct:+d}% (from {qoq_deals} deals in Q{prev_q} {prev_q_year})
bigNumberHed MUST be: "{yoy_pct:+d}%"

Top PE firms (by unique deal count):
"""
    for fname, fcount in top_firms_list[:5]:
        verified_facts += f"  - {fname}: {fcount} deals\n"
    verified_facts += "\nTop sectors:\n"
    for sname, scurr, sprev in top_sectors_list[:5]:
        s_yoy = round(((scurr - sprev) / sprev) * 100) if sprev else None
        if s_yoy is not None:
            verified_facts += f"  - {sname}: {scurr} deals ({s_yoy:+d}% YoY)\n"
        else:
            verified_facts += f"  - {sname}: {scurr} deals (new)\n"
    verified_facts += f"\nHistorical (Q{quarter} by year): {historical_str}\n"

    prompt = f"""{verified_facts}

=== EXAMPLES OF GOOD OUTPUT ===

Example 1 (Q3, YoY +12%, QoQ +7%):
{{"primary": "QUARTERLY SPOTLIGHT", "bigNumberHed": "+12%", "bigNumberDek": "", "line1": "The number of add-on deals completed in Q3 2025 grew 12% from a year earlier, according to data tracked by WSJ Pro. The period's 607 deals were the most in any quarter since Q1 2022.", "line2": "Add-on deal counts increased 7% from Q2 2025. The Real Estate Construction sector helped drive much of that growth with a 42% expansion in the number of deals over that time."}}

Example 2 (Q1, YoY +12%):
{{"primary": "ADD-ON SPOTLIGHT", "bigNumberHed": "+12%", "bigNumberDek": "", "line1": "The number of add-on deals tracked by WSJ Pro grew 12% in the first quarter of 2025 compared to a year earlier. The period's 650 deals amounted to the highest quarterly count since Q1 2022.", "line2": "January saw the greatest deal activity with 262 add-ons. The monthly total was 13% higher than the first month of 2024 and the third highest monthly count over the past five years."}}

=== RULES (non-negotiable) ===
- bigNumberHed is ALWAYS the YoY % change with sign: "+12%" or "-8%"
- line1 MUST contain the phrase "tracked by WSJ Pro" or "according to data tracked by WSJ Pro" — every single time.
- line1: 2 tight sentences. State the YoY change, then the deal count with historical context.
- line2: 1-2 sentences. ONE angle: sector trend with QoQ detail, OR most active month/firm.
- NEVER use parentheses in any output field. Write everything inline.
- Write numbers under 10 as words. No AI filler words.
- Never use "approximately," "notably," "significant," "robust," or "showcasing."
- Title is always "{period_title}".

=== DATA FOR THIS CARD: {quarter_label} ===

{current_summary}
Previous quarter (Q{prev_q} {prev_q_year}): {qoq_pct:+d}% change ({qoq_deals} → {current_deals} deals)
Year over year (Q{quarter} {year - 1}): {yoy_pct:+d}% change ({yoy_deals} → {current_deals} deals)

Sector YoY:
{sector_yoy_str}

=== CRITICAL: VERIFY BEFORE OUTPUT ===
- bigNumberHed MUST be exactly "{yoy_pct:+d}%" — no rounding, no changes.
- Any deal count you write in line1 or line2 MUST match the VERIFIED FACTS above.
- Any firm name in line2 MUST appear in the "Top PE firms" list above.
- Any sector name MUST appear in the "Top sectors" list above.
- If a fact is not in the verified data above, DO NOT include it.

=== OUTPUT ===
Respond with ONLY the JSON object. No markdown, no explanation."""

    try:
        client = get_client()
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        result = json.loads(text)
        result["_stats"] = stats
        return jsonify(result)
    except json.JSONDecodeError:
        return jsonify({"error": "AI returned invalid JSON", "raw": text}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ai_bp.route("/verify-card", methods=["POST"])
def verify_card():
    """Verify generated card text against computed ground truth."""
    data = request.json or {}
    rows = data.get("rows", [])
    card = data.get("card", {})
    year = data.get("year")
    period_type = data.get("period_type", "month")

    if not rows or not year or not card:
        return jsonify({"error": "rows, year, and card are required"}), 400

    # Compute ground truth
    if period_type == "quarter":
        quarter = data.get("quarter")
        if not quarter:
            return jsonify({"error": "quarter is required"}), 400
        _, current_deals = compute_quarter_summary(rows, year, quarter)
        prev_q = quarter - 1 if quarter > 1 else 4
        prev_y = year if quarter > 1 else year - 1
        _, prev_deals = compute_quarter_summary(rows, prev_y, prev_q)
        _, yoy_deals = compute_quarter_summary(rows, year - 1, quarter)
    else:
        month = data.get("month")
        half = data.get("half", "full")
        if not month:
            return jsonify({"error": "month is required"}), 400
        _, current_deals = compute_period_summary(rows, year, month, half)
        prev_month = month - 1 if month > 1 else 12
        prev_year = year if month > 1 else year - 1
        _, prev_deals = compute_period_summary(rows, prev_year, prev_month, half)
        _, yoy_deals = compute_period_summary(rows, year - 1, month, half)

    yoy_pct = round(((current_deals - yoy_deals) / yoy_deals) * 100) if yoy_deals else 0

    issues = []

    # Check bigNumberHed matches computed YoY%
    expected_hed = f"{yoy_pct:+d}%"
    actual_hed = card.get("bigNumberHed", "")
    if actual_hed != expected_hed:
        issues.append({
            "field": "bigNumberHed",
            "claim": actual_hed,
            "actual": expected_hed,
            "severity": "error",
        })

    # Check if deal count mentioned in line1 matches
    import re
    line1 = card.get("line1", "")
    line2 = card.get("line2", "")
    deal_count_matches = re.findall(r'\b(\d{2,4})\s+deals?\b', line1 + " " + line2)
    for match in deal_count_matches:
        num = int(match)
        if num != current_deals and num != yoy_deals and num != prev_deals:
            issues.append({
                "field": "line1" if match in line1 else "line2",
                "claim": f"{num} deals",
                "actual": f"Current: {current_deals}, YoY: {yoy_deals}, Prev: {prev_deals}",
                "severity": "warning",
            })

    # Check firm names exist in data
    if period_type == "quarter":
        period_rows = filter_rows_by_quarter(rows, year, data.get("quarter"))
    else:
        period_rows = filter_rows_by_period(rows, year, data.get("month"), data.get("half", "full"))

    firms_in_data = set()
    for row in period_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        if firm:
            firms_in_data.add(firm.lower())

    # Use AI to extract firm names mentioned in line2 for checking
    try:
        client = get_client()
        extract_prompt = f"""Extract all PE firm names mentioned in this text. Return ONLY a JSON array of strings.
Text: "{line2}"
If no firm names are mentioned, return [].
Return ONLY the JSON array, no markdown."""
        response = client.models.generate_content(model=GEMINI_MODEL, contents=extract_prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        mentioned_firms = json.loads(text)
        for firm in mentioned_firms:
            if firm.lower() not in firms_in_data:
                issues.append({
                    "field": "line2",
                    "claim": f"Firm: {firm}",
                    "actual": "Not found in period data",
                    "severity": "error",
                })
    except Exception:
        pass

    return jsonify({
        "verified": len(issues) == 0,
        "issues": issues,
        "computed_stats": {
            "deal_count": current_deals,
            "yoy_pct": yoy_pct,
        },
    })


def compute_aggregates(rows):
    """Compute full dataset aggregates so Gemini has accurate stats without needing all rows."""
    from datetime import datetime
    from collections import defaultdict

    yearly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(set), "firm_deals": defaultdict(set)})
    monthly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(set), "firm_deals": defaultdict(set)})
    half_monthly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(set), "firm_deals": defaultdict(set)})

    for row in rows:
        try:
            d = datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue

        year_key = str(d.year)
        month_key = f"{d.year}-{d.month:02d}"

        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        platform = str(row[9]).strip() if len(row) > 9 and row[9] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""

        buckets = [yearly[year_key], monthly[month_key]]
        if d.day <= 15:
            buckets.append(half_monthly[f"{d.year}-{d.month:02d}-H1"])

        for bucket in buckets:
            if deal_code:
                bucket["deals"].add(deal_code)
            if firm:
                bucket["firms"].add(firm)
                if deal_code:
                    bucket["firm_deals"][firm].add(deal_code)
            if platform:
                bucket["platforms"].add(platform)
            if sector and deal_code:
                bucket["sectors"][sector].add(deal_code)

    # Per-firm sector breakdown across all years (unique deals)
    firm_sectors = defaultdict(lambda: defaultdict(set))
    for row in rows:
        try:
            datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and sector and deal_code:
            firm_sectors[firm][sector].add(deal_code)

    # Format as readable text
    lines = []
    lines.append("=== YEARLY AGGREGATES ===")
    for year in sorted(yearly.keys()):
        b = yearly[year]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -len(x[1]))[:10]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -len(x[1]))[:10]
        lines.append(f"\n{year}: {len(b['deals'])} unique deals, {len(b['firms'])} unique PE firms, {len(b['platforms'])} platform cos.")
        lines.append(f"  Top sectors: {', '.join(f'{s}({len(c)})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({len(c)})' for f,c in top_firms)}")

    lines.append("\n\n=== MONTHLY AGGREGATES ===")
    for month in sorted(monthly.keys()):
        b = monthly[month]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -len(x[1]))[:5]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -len(x[1]))[:5]
        lines.append(f"\n{month}: {len(b['deals'])} deals, {len(b['firms'])} firms, {len(b['platforms'])} platforms")
        lines.append(f"  Sectors: {', '.join(f'{s}({len(c)})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({len(c)})' for f,c in top_firms)}")

    lines.append("\n\n=== FIRST-HALF MONTHLY AGGREGATES (days 1-15) ===")
    for half_key in sorted(half_monthly.keys()):
        b = half_monthly[half_key]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -len(x[1]))[:5]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -len(x[1]))[:5]
        label = half_key.replace("-H1", " 1st half")
        lines.append(f"\n{label}: {len(b['deals'])} deals, {len(b['firms'])} firms")
        lines.append(f"  Sectors: {', '.join(f'{s}({len(c)})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({len(c)})' for f,c in top_firms)}")

    lines.append("\n\n=== FIRM ACTIVITY BY SECTOR (all-time) ===")
    for firm_name, sector_deals in sorted(firm_sectors.items(), key=lambda x: -sum(len(v) for v in x[1].values()))[:20]:
        sector_str = ", ".join(f"{s}({len(d)})" for s, d in sorted(sector_deals.items(), key=lambda x: -len(x[1])))
        lines.append(f"  {firm_name}: {sector_str}")

    return "\n".join(lines)


def is_verify_intent(question):
    import re
    patterns = [
        r'\bverif(y|ied|ication)\b',
        r'\bcheck\b.*(line|card|text|accurate|correct)',
        r'\baccurate\b',
        r'\bcorrect\b.*(line|card|text|number)',
        r'\bis\s+(line\s*[12]|the card)\b',
        r'\bfact.?check\b',
    ]
    q = question.lower()
    return any(re.search(p, q) for p in patterns)


def build_verify_context(card_values, card_context, rows):
    """Build verification context from card values and period data."""
    year = card_context.get("year")
    period_type = card_context.get("period_type", "month")

    if not year:
        return ""

    if period_type == "quarter":
        quarter = card_context.get("quarter")
        if not quarter:
            return ""
        summary, deal_count = compute_quarter_summary(rows, year, quarter)
        prev_q = quarter - 1 if quarter > 1 else 4
        prev_y = year if quarter > 1 else year - 1
        _, prev_deals = compute_quarter_summary(rows, prev_y, prev_q)
        _, yoy_deals = compute_quarter_summary(rows, year - 1, quarter)
    else:
        month = card_context.get("month")
        half = card_context.get("half", "full")
        if not month:
            return ""
        summary, deal_count = compute_period_summary(rows, year, month, half)
        prev_month = month - 1 if month > 1 else 12
        prev_year = year if month > 1 else year - 1
        _, prev_deals = compute_period_summary(rows, prev_year, prev_month, half)
        _, yoy_deals = compute_period_summary(rows, year - 1, month, half)

    yoy_pct = round(((deal_count - yoy_deals) / yoy_deals) * 100) if yoy_deals else 0
    mom_pct = round(((deal_count - prev_deals) / prev_deals) * 100) if prev_deals else 0

    ctx = "\n\n=== CARD VERIFICATION DATA ===\n"
    ctx += f"Current card field values:\n"
    for field, val in card_values.items():
        ctx += f"  {field}: {val}\n"
    ctx += f"\nCOMPUTED GROUND TRUTH for this period:\n"
    ctx += f"  Deal count: {deal_count}\n"
    ctx += f"  YoY change: {yoy_pct:+d}% ({yoy_deals} -> {deal_count})\n"
    ctx += f"  Period-over-period change: {mom_pct:+d}% ({prev_deals} -> {deal_count})\n"
    ctx += f"\n{summary}\n"
    ctx += "\nCompare each claim in the card text against these computed stats. "
    ctx += "Report which numbers match, which don't, and which firm/sector names are confirmed in the data.\n"
    return ctx


@ai_bp.route("/chat", methods=["POST"])
def chat():
    data = request.json or {}
    headers = data.get("headers", [])
    rows = data.get("rows", [])
    question = data.get("question", "").strip()
    history = data.get("history", [])
    card_values = data.get("card_values")
    card_context = data.get("card_context")

    if not question:
        return jsonify({"error": "question is required"}), 400

    # Use server-side cached data if rows not provided (faster — avoids re-upload)
    if not rows:
        headers, rows = get_server_rows()
    if not rows:
        return jsonify({"error": "No data available. Load a spreadsheet first."}), 400

    total_rows = len(rows)
    aggregates = get_cached_aggregates(rows)

    # Reduce sample rows when history is present to stay within token budget
    sample_limit = 50 if history else 100

    ctx = f"Dataset: WSJ Pro Add-On Deals database.\n"
    ctx += f"Columns: {', '.join(headers)}\n"
    ctx += f"Total rows: {total_rows}\n\n"
    ctx += aggregates

    # Try to extract a time period from the question and send relevant rows
    from datetime import datetime
    period_year, period_month, period_half, period_quarter = extract_period_from_question(question)
    period_rows = None
    if period_quarter and period_year:
        period_rows = filter_rows_by_quarter(rows, period_year, period_quarter)
    elif period_month and period_year:
        period_rows = filter_rows_by_period(rows, period_year, period_month, period_half or "full")

    # Extract entity filters (firm, platform, sector, etc.) from the question
    entity_filters = extract_entities_from_question(question, rows)

    if period_rows and entity_filters:
        # Targeted: filter period rows by mentioned entities, cross-check against aggregates
        targeted, discrepancy_note = build_targeted_sample(
            rows, period_rows, entity_filters, aggregates,
            period_year, period_month, period_half or "full"
        )
        entity_desc = ", ".join(f"col{k}={v}" for k, v in entity_filters.items())
        ctx += f"\n\n=== TARGETED ROWS FOR QUERY ({len(targeted)} rows matching: {entity_desc}) ===\n"
        for row in targeted:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"
        if discrepancy_note:
            ctx += f"\n{discrepancy_note}\n"
        # Also include remaining period rows for broader context
        ctx += f"\n=== ALL OTHER ROWS IN PERIOD ({len(period_rows) - len(targeted)} rows) ===\n"
        targeted_set = set(id(r) for r in targeted)
        for row in period_rows:
            if id(row) not in targeted_set:
                ctx += json.dumps(row, ensure_ascii=False) + "\n"
    elif period_rows:
        ctx += f"\n\n=== ALL ROWS FOR REQUESTED PERIOD ({len(period_rows)} rows) ===\n"
        for row in period_rows:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"
    else:
        ctx += f"\n\n=== SAMPLE RAW DATA (most recent {sample_limit} rows) ===\n"
        dated_rows = []
        for row in rows:
            try:
                d = datetime.strptime(str(row[0]), "%m/%d/%Y")
                dated_rows.append((d, row))
            except (ValueError, IndexError):
                pass
        dated_rows.sort(key=lambda x: x[0], reverse=True)
        for _, row in dated_rows[:sample_limit]:
            ctx += json.dumps(row, ensure_ascii=False) + "\n"

    # Add verification context if this is a verify intent with card values
    verify_ctx = ""
    if card_values and card_context and is_verify_intent(question):
        verify_ctx = build_verify_context(card_values, card_context, rows)

    period_note = ""
    if period_rows and entity_filters:
        period_note = """- The "TARGETED ROWS FOR QUERY" section contains ALL rows matching the entity and period you asked about. This is COMPLETE data, not a sample.
- List EVERY row in the targeted section when answering. Do not say data is missing if rows appear there.
- The "ALL OTHER ROWS IN PERIOD" section has the remaining deals in the same time period for broader context."""
    elif period_rows:
        period_note = """- The "ALL ROWS FOR REQUESTED PERIOD" section contains EVERY row for that time period — it is complete, not a sample.
- When answering about that period, search through ALL provided period rows carefully. Do not say data is missing if it appears in those rows."""

    system_prompt = f"""You are a data analyst for WSJ Pro, answering questions about the Add-On Deals database.

Rules:
- ONLY answer based on the aggregated statistics and sample data provided below. Do NOT use outside knowledge.
- If the data doesn't contain enough information to answer, say so clearly.
- Do NOT hallucinate facts or numbers. Every number you cite must come from the aggregates or sample data.
- Deal Code is unique per deal. Multiple rows with the same Deal Code = multiple PE firms in one deal.
- The aggregates below are computed from ALL {total_rows} rows in the database. Use them for counts and rankings.
- Column "Updated WSJ Name" (index 5) is the PE firm name.
- Column "Platform Co." (index 9) is the platform company.
- Column "Co. Acquire" (index 10) is the acquisition target (add-on).
- Column "Sector" (index 11) is the industry.
- Column 0 is the date in MM/DD/YYYY format.
- Be concise but thorough. Use specific numbers.
{period_note}

{ctx}{verify_ctx}"""

    try:
        client = get_client()

        # Build multi-turn contents for conversational context
        contents = [
            {"role": "user", "parts": [{"text": system_prompt}]},
            {"role": "model", "parts": [{"text": "Understood. I'll answer based only on the data provided."}]},
        ]

        # Add conversation history (last few exchanges)
        for msg in history[-6:]:
            role = "user" if msg.get("role") == "user" else "model"
            content = msg.get("content", "")
            if content:
                contents.append({"role": role, "parts": [{"text": content}]})

        # Add current question
        contents.append({"role": "user", "parts": [{"text": question}]})

        response = client.models.generate_content(model=GEMINI_MODEL, contents=contents)
        return jsonify({"answer": response.text.strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
