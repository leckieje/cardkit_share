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
    sectors = defaultdict(int)

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
        if sector:
            sectors[sector] += 1

    top_firms = sorted(firms.items(), key=lambda x: -len(x[1]["deals"]))[:5]
    top_sectors = sorted(sectors.items(), key=lambda x: -x[1])[:5]

    summary = f"Unique deals: {len(deals)}\n"
    summary += f"Unique PE firms: {len(firms)}\n"
    summary += f"Top sectors: {', '.join(f'{s} ({c} rows)' for s, c in top_sectors)}\n"
    summary += f"Top PE firms:\n"
    for name, info in top_firms:
        summary += f"  - {name}: {len(info['deals'])} deals, sectors: {', '.join(list(info['sectors'])[:3])}, platforms: {', '.join(list(info['platforms'])[:3])}, acquisitions: {', '.join(info['acquisitions'][:3])}\n"

    # Firm-by-sector breakdown: for every firm, list deal count per sector
    summary += "Firm activity by sector:\n"
    firm_sector_map = defaultdict(lambda: defaultdict(int))
    for row in period_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and sector and deal_code:
            firm_sector_map[firm][sector] += 1
    for firm_name, sector_counts in sorted(firm_sector_map.items(), key=lambda x: -sum(x[1].values()))[:10]:
        sector_str = ", ".join(f"{s}({c})" for s, c in sorted(sector_counts.items(), key=lambda x: -x[1]))
        summary += f"  - {firm_name}: {sector_str}\n"

    return summary, len(deals)


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
    sectors = defaultdict(int)

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
        if sector:
            sectors[sector] += 1

    top_firms = sorted(firms.items(), key=lambda x: -len(x[1]["deals"]))[:5]
    top_sectors = sorted(sectors.items(), key=lambda x: -x[1])[:5]

    summary = f"Unique deals: {len(deals)}\n"
    summary += f"Unique PE firms: {len(firms)}\n"
    summary += f"Top sectors: {', '.join(f'{s} ({c} rows)' for s, c in top_sectors)}\n"
    summary += f"Top PE firms:\n"
    for name, info in top_firms:
        summary += f"  - {name}: {len(info['deals'])} deals, sectors: {', '.join(list(info['sectors'])[:3])}, platforms: {', '.join(list(info['platforms'])[:3])}, acquisitions: {', '.join(info['acquisitions'][:3])}\n"

    # Firm-by-sector breakdown
    summary += "Firm activity by sector:\n"
    firm_sector_map = defaultdict(lambda: defaultdict(int))
    for row in period_rows:
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        deal_code = str(row[1]) if len(row) > 1 and row[1] else ""
        if firm and sector and deal_code:
            firm_sector_map[firm][sector] += 1
    for firm_name, sector_counts in sorted(firm_sector_map.items(), key=lambda x: -sum(x[1].values()))[:10]:
        sector_str = ", ".join(f"{s}({c})" for s, c in sorted(sector_counts.items(), key=lambda x: -x[1]))
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

    # Compute sector YoY changes for the current period
    from collections import defaultdict
    current_sector_rows = filter_rows_by_period(rows, year, month, half)
    yoy_sector_rows = filter_rows_by_period(rows, year - 1, month, half)
    current_sectors = defaultdict(int)
    yoy_sectors = defaultdict(int)
    for row in current_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        if sector:
            current_sectors[sector] += 1
    for row in yoy_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        if sector:
            yoy_sectors[sector] += 1
    sector_changes = []
    for sector in current_sectors:
        curr = current_sectors[sector]
        prev = yoy_sectors.get(sector, 0)
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

    # Sector YoY changes
    current_sector_rows = filter_rows_by_quarter(rows, year, quarter)
    yoy_sector_rows = filter_rows_by_quarter(rows, year - 1, quarter)
    current_sectors = defaultdict(int)
    yoy_sectors = defaultdict(int)
    for row in current_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        if sector:
            current_sectors[sector] += 1
    for row in yoy_sector_rows:
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        if sector:
            yoy_sectors[sector] += 1
    sector_changes = []
    for sector in current_sectors:
        curr = current_sectors[sector]
        prev = yoy_sectors.get(sector, 0)
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

    yearly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(int), "firm_deals": defaultdict(int)})
    monthly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(int), "firm_deals": defaultdict(int)})
    half_monthly = defaultdict(lambda: {"deals": set(), "firms": set(), "platforms": set(), "sectors": defaultdict(int), "firm_deals": defaultdict(int)})

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
                bucket["firm_deals"][firm] += 1
            if platform:
                bucket["platforms"].add(platform)
            if sector:
                bucket["sectors"][sector] += 1

    # Per-firm sector breakdown across all years
    firm_sectors = defaultdict(lambda: defaultdict(int))
    for row in rows:
        try:
            datetime.strptime(str(row[0]), "%m/%d/%Y")
        except (ValueError, IndexError):
            continue
        firm = str(row[5]).strip() if len(row) > 5 and row[5] else ""
        sector = str(row[11]).strip() if len(row) > 11 and row[11] else ""
        if firm and sector:
            firm_sectors[firm][sector] += 1

    # Format as readable text
    lines = []
    lines.append("=== YEARLY AGGREGATES ===")
    for year in sorted(yearly.keys()):
        b = yearly[year]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -x[1])[:10]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -x[1])[:10]
        lines.append(f"\n{year}: {len(b['deals'])} unique deals, {len(b['firms'])} unique PE firms, {len(b['platforms'])} platform cos.")
        lines.append(f"  Top sectors: {', '.join(f'{s}({c})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({c})' for f,c in top_firms)}")

    lines.append("\n\n=== MONTHLY AGGREGATES ===")
    for month in sorted(monthly.keys()):
        b = monthly[month]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -x[1])[:5]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -x[1])[:5]
        lines.append(f"\n{month}: {len(b['deals'])} deals, {len(b['firms'])} firms, {len(b['platforms'])} platforms")
        lines.append(f"  Sectors: {', '.join(f'{s}({c})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({c})' for f,c in top_firms)}")

    lines.append("\n\n=== FIRST-HALF MONTHLY AGGREGATES (days 1-15) ===")
    for half_key in sorted(half_monthly.keys()):
        b = half_monthly[half_key]
        top_sectors = sorted(b["sectors"].items(), key=lambda x: -x[1])[:5]
        top_firms = sorted(b["firm_deals"].items(), key=lambda x: -x[1])[:5]
        label = half_key.replace("-H1", " 1st half")
        lines.append(f"\n{label}: {len(b['deals'])} deals, {len(b['firms'])} firms")
        lines.append(f"  Sectors: {', '.join(f'{s}({c})' for s,c in top_sectors)}")
        lines.append(f"  Top firms: {', '.join(f'{f}({c})' for f,c in top_firms)}")

    lines.append("\n\n=== FIRM ACTIVITY BY SECTOR (all-time) ===")
    for firm_name, sector_counts in sorted(firm_sectors.items(), key=lambda x: -sum(x[1].values()))[:20]:
        sector_str = ", ".join(f"{s}({c})" for s, c in sorted(sector_counts.items(), key=lambda x: -x[1]))
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
    ctx += f"\n\n=== SAMPLE RAW DATA (most recent {sample_limit} rows) ===\n"
    from datetime import datetime
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
