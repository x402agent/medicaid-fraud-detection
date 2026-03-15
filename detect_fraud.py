#!/usr/bin/env python3
"""
Medicaid Fraud Detection Pipeline
===================================
Integrates:
1. Google Document AI (custom processor) — structured data extraction from PDF reports
2. Google Gemini API — AI-powered fraud pattern analysis with structured JSON output
3. Vertex AI — enhanced ML anomaly scoring
4. Statistical anomaly detection — z-scores, Benford's Law, temporal patterns

Pipeline Flow:
  CSV → Statistical Analysis → Document AI (PDF extract) → Gemini Fraud Analysis → Report
"""

import csv
import json
import os
import sys
import math
import base64
import time
import statistics
import argparse
from collections import defaultdict, Counter
from datetime import datetime
from io import BytesIO

import pandas as pd
import requests
from dotenv import load_dotenv

# Load environment
load_dotenv()

# ── Google GenAI SDK ──
from google import genai

# ── Configuration ──────────────────────────────────────────────
CSV_PATH = "medicaid-provider-spending.csv"
OUTPUT_DIR = "fraud_analysis"
CHUNK_SIZE = 1_000_000

# API Keys from .env
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
VERTEX_API_KEY = os.getenv("VERTEX_API_KEY", "")
GOOGLE_PROJECT_ID = os.getenv("GOOGLE_PROJECT_ID", "mawdbot")
GOOGLE_PROJECT_NUMBER = os.getenv("GOOGLE_PROJECT_NUMBER", "691016932195")

# Document AI
DOCAI_PROCESSOR_ID = os.getenv("GOOGLE_DATA_ID", "f9f3ab408f414eea")
DOCAI_ENDPOINT = os.getenv(
    "GOOGLE_PREDICTION_ENDPOINT",
    f"https://us-documentai.googleapis.com/v1/projects/{GOOGLE_PROJECT_NUMBER}/locations/us/processors/{DOCAI_PROCESSOR_ID}:process",
)

# Use the best available API key
API_KEY = GEMINI_API_KEY or GOOGLE_API_KEY

# ── Initialize Gemini Client ──
client = genai.Client(api_key=API_KEY)
MODEL = "gemini-2.5-flash"


def ensure_dirs():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(os.path.join(OUTPUT_DIR, "provider_reports"), exist_ok=True)
    os.makedirs(os.path.join(OUTPUT_DIR, "docai_results"), exist_ok=True)


def classify_risk_level(z_score: float) -> str:
    """Map z-score to a risk tier used across backend/frontend."""
    if z_score > 10:
        return "CRITICAL"
    if z_score > 5:
        return "HIGH"
    if z_score > 3:
        return "MEDIUM"
    if z_score > 1:
        return "ELEVATED"
    return "LOW"


# ═══════════════════════════════════════════════════════════════
# PHASE 1: Statistical Anomaly Detection
# ═══════════════════════════════════════════════════════════════


def benford_analysis(values: list[float]) -> dict:
    """
    Apply Benford's Law to detect potential fraud in payment amounts.
    In natural datasets, the leading digit follows a specific distribution.
    Significant deviations suggest data manipulation.
    """
    expected = {
        1: 0.301,
        2: 0.176,
        3: 0.125,
        4: 0.097,
        5: 0.079,
        6: 0.067,
        7: 0.058,
        8: 0.051,
        9: 0.046,
    }

    leading_digits = Counter()
    valid_count = 0
    for val in values:
        abs_val = abs(val)
        if abs_val >= 1:
            leading_digit = int(str(abs_val)[0])
            if 1 <= leading_digit <= 9:
                leading_digits[leading_digit] += 1
                valid_count += 1

    if valid_count < 100:
        return {
            "compliant": True,
            "chi_squared": 0,
            "message": "Too few values for Benford analysis",
        }

    # Chi-squared test
    chi_squared = 0
    deviations = {}
    for digit in range(1, 10):
        observed = leading_digits.get(digit, 0) / valid_count
        exp = expected[digit]
        chi_squared += ((observed - exp) ** 2) / exp
        deviations[str(digit)] = {
            "observed": round(observed, 4),
            "expected": round(exp, 4),
            "deviation": round(abs(observed - exp), 4),
        }

    # Critical value for chi-squared with 8 df at p=0.05 is 15.507
    compliant = chi_squared < 15.507

    return {
        "compliant": compliant,
        "chi_squared": round(chi_squared, 4),
        "digit_deviations": deviations,
        "message": (
            "PASS: Payment amounts follow Benford's Law"
            if compliant
            else "⚠️ FAIL: Payment amounts deviate from Benford's Law — possible manipulation"
        ),
    }


def detect_temporal_anomalies(provider_monthly: dict[str, list]) -> list[dict]:
    """
    Detect sudden spikes, drops, or abnormal patterns in monthly billing.
    """
    anomalies = []

    for npi, monthly_data in provider_monthly.items():
        if len(monthly_data) < 6:
            continue

        # Sort by month
        monthly_data.sort(key=lambda x: x["month"])
        payments = [m["paid"] for m in monthly_data]

        mean_pay = statistics.mean(payments)
        std_pay = statistics.stdev(payments) if len(payments) > 1 else 0

        if std_pay == 0:
            continue

        for m in monthly_data:
            z = (m["paid"] - mean_pay) / std_pay
            if abs(z) > 3:
                anomalies.append(
                    {
                        "provider_npi": npi,
                        "month": m["month"],
                        "payment": m["paid"],
                        "z_score": round(z, 2),
                        "provider_mean": round(mean_pay, 2),
                        "anomaly_type": "SPIKE" if z > 0 else "DROP",
                        "severity": "CRITICAL" if abs(z) > 5 else "HIGH",
                    }
                )

    return anomalies


def compute_fraud_indicators(chunk_size=CHUNK_SIZE) -> dict:
    """
    Process the full CSV to compute statistical fraud indicators.
    Uses vectorized operations for speed.
    """
    print("\n🔍 Phase 1: Statistical Anomaly Detection...")

    # Accumulators
    provider_totals = defaultdict(
        lambda: {
            "total_paid": 0.0,
            "total_claims": 0,
            "total_benes": 0,
            "hcpcs_codes": set(),
            "months": set(),
        }
    )
    provider_monthly = defaultdict(list)
    all_payments = []
    billing_equals_servicing = 0
    total_rows = 0

    for chunk in pd.read_csv(
        CSV_PATH,
        chunksize=chunk_size,
        dtype={
            "BILLING_PROVIDER_NPI_NUM": str,
            "SERVICING_PROVIDER_NPI_NUM": str,
            "HCPCS_CODE": str,
            "CLAIM_FROM_MONTH": str,
            "TOTAL_UNIQUE_BENEFICIARIES": "Int64",
            "TOTAL_CLAIMS": "Int64",
            "TOTAL_PAID": float,
        },
    ):
        chunk["TOTAL_PAID"] = chunk["TOTAL_PAID"].fillna(0)
        chunk["TOTAL_CLAIMS"] = chunk["TOTAL_CLAIMS"].fillna(0)
        chunk["TOTAL_UNIQUE_BENEFICIARIES"] = chunk[
            "TOTAL_UNIQUE_BENEFICIARIES"
        ].fillna(0)

        # Self-referral detection
        same_npi = (
            chunk["BILLING_PROVIDER_NPI_NUM"] == chunk["SERVICING_PROVIDER_NPI_NUM"]
        )
        billing_equals_servicing += same_npi.sum()

        # Vectorized groupby for this chunk
        grp = chunk.groupby("BILLING_PROVIDER_NPI_NUM")

        for npi, group in grp:
            stats = provider_totals[npi]
            stats["total_paid"] += group["TOTAL_PAID"].sum()
            stats["total_claims"] += group["TOTAL_CLAIMS"].sum()
            stats["total_benes"] += group["TOTAL_UNIQUE_BENEFICIARIES"].sum()
            stats["hcpcs_codes"].update(group["HCPCS_CODE"].dropna().unique())
            stats["months"].update(group["CLAIM_FROM_MONTH"].dropna().unique())

            # Monthly data for temporal analysis (sample for memory)
            for _, row in group.head(5).iterrows():
                provider_monthly[npi].append(
                    {
                        "month": row["CLAIM_FROM_MONTH"],
                        "paid": float(row["TOTAL_PAID"]),
                        "claims": int(row["TOTAL_CLAIMS"]),
                    }
                )

        # Collect payment amounts for Benford's Law (sample)
        sample = (
            chunk["TOTAL_PAID"].dropna().sample(min(10000, len(chunk)), random_state=42)
        )
        all_payments.extend(sample.tolist())

        total_rows += len(chunk)
        if total_rows % 10_000_000 == 0:
            print(f"   📊 {total_rows:,} rows processed...")

    print(f"   ✅ Processed {total_rows:,} rows, {len(provider_totals):,} providers")

    # ── Compute Z-scores for all providers ──
    all_paid = [s["total_paid"] for s in provider_totals.values()]
    global_mean = statistics.mean(all_paid)
    global_std = statistics.stdev(all_paid) if len(all_paid) > 1 else 1
    global_median = statistics.median(all_paid)

    # ── Build provider risk tiers ──
    outlier_providers = []
    providers_z_gt_1 = []
    tiered_providers = {
        "critical": [],
        "high": [],
        "medium": [],
        "elevated": [],
    }

    for npi, stats in provider_totals.items():
        z = (stats["total_paid"] - global_mean) / global_std if global_std > 0 else 0
        if z <= 1:
            continue

        claims_per_bene = (
            stats["total_claims"] / max(stats["total_benes"], 1) * len(stats["months"])
        )
        avg_per_claim = stats["total_paid"] / max(stats["total_claims"], 1)
        risk_level = classify_risk_level(z)

        provider_record = {
            "npi": npi,
            "total_paid": round(stats["total_paid"], 2),
            "total_claims": stats["total_claims"],
            "z_score": round(z, 2),
            "unique_procedures": len(stats["hcpcs_codes"]),
            "procedures": sorted(stats["hcpcs_codes"])[:10],
            "months_active": len(stats["months"]),
            "avg_payment_per_claim": round(avg_per_claim, 2),
            "claims_per_beneficiary_per_month": round(claims_per_bene, 2),
            "self_billing": True,  # Will be refined
            "risk_level": risk_level,
        }

        providers_z_gt_1.append(provider_record)

        if risk_level == "CRITICAL":
            tiered_providers["critical"].append(provider_record)
        elif risk_level == "HIGH":
            tiered_providers["high"].append(provider_record)
        elif risk_level == "MEDIUM":
            tiered_providers["medium"].append(provider_record)
        elif risk_level == "ELEVATED":
            tiered_providers["elevated"].append(provider_record)

        if z > 3:
            outlier_providers.append(provider_record)

    outlier_providers.sort(key=lambda x: x["z_score"], reverse=True)
    providers_z_gt_1.sort(key=lambda x: x["z_score"], reverse=True)
    for tier in tiered_providers.values():
        tier.sort(key=lambda x: x["z_score"], reverse=True)

    # ── Benford's Law analysis ──
    print("   📐 Running Benford's Law analysis...")
    benford = benford_analysis(all_payments)

    # ── Temporal anomalies ──
    print("   📅 Detecting temporal anomalies...")
    temporal = detect_temporal_anomalies(provider_monthly)

    # ── Summary stats ──
    results = {
        "metadata": {
            "total_rows": total_rows,
            "total_providers": len(provider_totals),
            "analysis_date": datetime.now().isoformat(),
            "self_referral_rows": int(billing_equals_servicing),
            "self_referral_pct": round(
                billing_equals_servicing / max(total_rows, 1) * 100, 2
            ),
        },
        "global_statistics": {
            "mean_total_paid": round(global_mean, 2),
            "median_total_paid": round(global_median, 2),
            "std_total_paid": round(global_std, 2),
        },
        "outlier_providers": outlier_providers[:100],  # Top 100
        "benford_analysis": benford,
        "temporal_anomalies": temporal[:200],  # Top 200
        "high_risk_count": len(tiered_providers["critical"]) + len(tiered_providers["high"]),
        "medium_risk_count": len(tiered_providers["medium"]),
        "elevated_risk_count": len(tiered_providers["elevated"]),
        "risk_tier_counts": {
            "critical": len(tiered_providers["critical"]),
            "high": len(tiered_providers["high"]),
            "medium": len(tiered_providers["medium"]),
            "elevated": len(tiered_providers["elevated"]),
            "total_flagged_z_gt_1": len(providers_z_gt_1),
        },
        "risk_tier_files": {
            "critical": "fraud_analysis/all_providers_critical.json",
            "high": "fraud_analysis/all_providers_high.json",
            "medium": "fraud_analysis/all_providers_medium.json",
            "elevated": "fraud_analysis/all_providers_elevated.json",
            "z_gt_1": "fraud_analysis/all_providers_z_gt_1.json",
        },
    }

    # Save intermediate results
    stats_path = os.path.join(OUTPUT_DIR, "statistical_analysis.json")
    with open(stats_path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"   📁 Saved to {stats_path}")

    # Save tiered provider files for full pyramid analysis
    tier_specs = {
        "critical": {
            "filename": "all_providers_critical.json",
            "description": "Providers with z-score > 10",
            "threshold": "z > 10",
        },
        "high": {
            "filename": "all_providers_high.json",
            "description": "Providers with 5 < z-score <= 10",
            "threshold": "5 < z <= 10",
        },
        "medium": {
            "filename": "all_providers_medium.json",
            "description": "Providers with 3 < z-score <= 5",
            "threshold": "3 < z <= 5",
        },
        "elevated": {
            "filename": "all_providers_elevated.json",
            "description": "Providers with 1 < z-score <= 3",
            "threshold": "1 < z <= 3",
        },
    }

    for tier_name, spec in tier_specs.items():
        tier_payload = {
            "metadata": {
                **results["metadata"],
                "tier": tier_name.upper(),
                "threshold": spec["threshold"],
                "description": spec["description"],
                "provider_count": len(tiered_providers[tier_name]),
                "generated_from": "detect_fraud.py",
            },
            "providers": tiered_providers[tier_name],
        }
        tier_path = os.path.join(OUTPUT_DIR, spec["filename"])
        with open(tier_path, "w") as f:
            json.dump(tier_payload, f, indent=2, default=str)
        print(f"   📁 Saved {tier_name.upper()} tier ({len(tiered_providers[tier_name]):,}) to {tier_path}")

    combined_path = os.path.join(OUTPUT_DIR, "all_providers_z_gt_1.json")
    combined_payload = {
        "metadata": {
            **results["metadata"],
            "threshold": "z > 1",
            "provider_count": len(providers_z_gt_1),
            "generated_from": "detect_fraud.py",
        },
        "providers": providers_z_gt_1,
    }
    with open(combined_path, "w") as f:
        json.dump(combined_payload, f, indent=2, default=str)
    print(f"   📁 Saved all flagged providers ({len(providers_z_gt_1):,}) to {combined_path}")

    return results


# ═══════════════════════════════════════════════════════════════
# PHASE 2: Document AI Processing
# ═══════════════════════════════════════════════════════════════


def create_provider_pdf(providers: list[dict]) -> bytes:
    """Create a PDF summary of suspicious providers for Document AI processing."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, LETTER
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        SimpleDocTemplate,
        Table,
        TableStyle,
        Paragraph,
        Spacer,
    )
    from reportlab.lib.styles import getSampleStyleSheet

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(LETTER),
        leftMargin=0.4 * inch,
        rightMargin=0.4 * inch,
        topMargin=0.4 * inch,
        bottomMargin=0.4 * inch,
    )

    styles = getSampleStyleSheet()
    elements = []

    elements.append(
        Paragraph(
            "<b>Medicaid Fraud Detection — Suspicious Provider Report</b>",
            styles["Title"],
        )
    )
    elements.append(
        Paragraph(
            f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}", styles["Normal"]
        )
    )
    elements.append(Spacer(1, 12))

    # Table
    headers = [
        "NPI",
        "Total Paid",
        "Claims",
        "Z-Score",
        "Procedures",
        "Months",
        "Avg $/Claim",
        "Risk",
    ]
    table_data = [headers]

    for p in providers[:50]:
        risk = (
            "🔴 CRITICAL"
            if p["z_score"] > 10
            else "🟠 HIGH" if p["z_score"] > 5 else "🟡 MEDIUM"
        )
        table_data.append(
            [
                p["npi"],
                f"${p['total_paid']:,.2f}",
                f"{p['total_claims']:,}",
                f"{p['z_score']:.1f}",
                str(p["unique_procedures"]),
                str(p["months_active"]),
                f"${p['avg_payment_per_claim']:,.2f}",
                risk,
            ]
        )

    col_widths = [
        1.1 * inch,
        1.3 * inch,
        0.8 * inch,
        0.7 * inch,
        0.7 * inch,
        0.6 * inch,
        1.0 * inch,
        1.0 * inch,
    ]
    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#b71c1c")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 7),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 1), (-1, -1), 6),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [colors.white, colors.HexColor("#fff3f3")],
                ),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ]
        )
    )
    elements.append(table)

    doc.build(elements)
    pdf_bytes = buffer.getvalue()
    buffer.close()
    return pdf_bytes


def process_with_document_ai(pdf_bytes: bytes) -> dict:
    """
    Send PDF to Google Document AI custom processor for structured extraction.
    Uses the Vertex AI key for authentication.
    """
    print("\n📄 Phase 2: Document AI Processing...")

    b64_content = base64.b64encode(pdf_bytes).decode("utf-8")

    request_body = {
        "skipHumanReview": True,
        "rawDocument": {
            "mimeType": "application/pdf",
            "content": b64_content,
        },
    }

    # Save request for reference
    request_path = os.path.join(OUTPUT_DIR, "docai_request.json")
    with open(request_path, "w") as f:
        json.dump(request_body, f)

    # Try with API key authentication first
    headers = {
        "Content-Type": "application/json; charset=utf-8",
    }

    # Use API key param for Document AI
    url = f"{DOCAI_ENDPOINT}?key={API_KEY}"

    print(f"   📡 Sending to Document AI processor: {DOCAI_PROCESSOR_ID}")
    print(f"   📦 PDF size: {len(pdf_bytes) / 1024:.1f} KB")

    try:
        response = requests.post(url, headers=headers, json=request_body, timeout=120)

        if response.status_code == 200:
            result = response.json()
            # Save the full response
            result_path = os.path.join(
                OUTPUT_DIR, "docai_results", "extraction_result.json"
            )
            with open(result_path, "w") as f:
                json.dump(result, f, indent=2)
            print(f"   ✅ Document AI extraction successful")
            print(f"   📁 Saved to {result_path}")

            # Extract key info from Document AI response
            doc = result.get("document", {})
            extracted = {
                "text_length": len(doc.get("text", "")),
                "pages": len(doc.get("pages", [])),
                "entities": [
                    {
                        "type": e.get("type", ""),
                        "mention_text": e.get("mentionText", ""),
                        "confidence": e.get("confidence", 0),
                    }
                    for e in doc.get("entities", [])
                ],
                "tables": len(
                    [p for page in doc.get("pages", []) for p in page.get("tables", [])]
                ),
            }
            return extracted
        else:
            print(
                f"   ⚠️ Document AI returned {response.status_code}: {response.text[:500]}"
            )
            # Try with Vertex API key
            return try_vertex_docai(request_body)
    except Exception as e:
        print(f"   ⚠️ Document AI request failed: {e}")
        return try_vertex_docai(request_body)


def try_vertex_docai(request_body: dict) -> dict:
    """Fallback: Try Document AI with Vertex API key."""
    print("   🔄 Trying with Vertex AI key...")

    url = f"{DOCAI_ENDPOINT}?key={VERTEX_API_KEY}"
    headers = {"Content-Type": "application/json; charset=utf-8"}

    try:
        response = requests.post(url, headers=headers, json=request_body, timeout=120)
        if response.status_code == 200:
            result = response.json()
            result_path = os.path.join(
                OUTPUT_DIR, "docai_results", "extraction_result_vertex.json"
            )
            with open(result_path, "w") as f:
                json.dump(result, f, indent=2)
            print(f"   ✅ Document AI (Vertex) extraction successful")

            doc = result.get("document", {})
            return {
                "text_length": len(doc.get("text", "")),
                "pages": len(doc.get("pages", [])),
                "entities": [
                    {
                        "type": e.get("type", ""),
                        "mention_text": e.get("mentionText", ""),
                        "confidence": e.get("confidence", 0),
                    }
                    for e in doc.get("entities", [])
                ],
                "tables": len(
                    [p for page in doc.get("pages", []) for p in page.get("tables", [])]
                ),
            }
        else:
            print(f"   ❌ Vertex Document AI also failed: {response.status_code}")
            print(f"      Response: {response.text[:300]}")
            return {
                "error": f"Document AI unavailable: {response.status_code}",
                "text_length": 0,
            }
    except Exception as e:
        print(f"   ❌ Vertex Document AI error: {e}")
        return {"error": str(e), "text_length": 0}


# ═══════════════════════════════════════════════════════════════
# PHASE 3: Gemini AI Fraud Analysis
# ═══════════════════════════════════════════════════════════════


def analyze_with_gemini(statistical_results: dict, docai_results: dict) -> dict:
    """
    Use Gemini to perform deep fraud pattern analysis on the statistical findings.
    Generates structured fraud reports with actionable recommendations.
    """
    print("\n🤖 Phase 3: Gemini AI Fraud Pattern Analysis...")

    # Prepare the context for Gemini
    top_providers = statistical_results.get("outlier_providers", [])[:20]
    benford = statistical_results.get("benford_analysis", {})
    temporal = statistical_results.get("temporal_anomalies", [])[:30]
    metadata = statistical_results.get("metadata", {})
    global_stats = statistical_results.get("global_statistics", {})

    system_prompt = """You are an expert Medicaid fraud investigator and data analyst. 
You have deep knowledge of healthcare billing fraud patterns including:
- Upcoding (billing for more expensive procedures than performed)
- Unbundling (billing separately for bundled procedures)
- Phantom billing (billing for services never rendered)
- Identity theft / Patient farming
- Kickback schemes (self-referrals)
- Impossible day billing (more hours billed than exist)
- Geographic impossibilities
- "Hot" HCPCS codes associated with fraud (T1019, T1015, etc.)

Analyze the provided Medicaid spending data and produce a comprehensive fraud investigation report.
Be specific about which providers show the strongest indicators of fraud and why.
Reference actual NPI numbers, dollar amounts, and statistical metrics in your analysis."""

    analysis_prompt = f"""
## MEDICAID FRAUD DETECTION ANALYSIS REQUEST

### Dataset Overview
- Total claims rows: {metadata.get('total_rows', 'N/A'):,}
- Total unique providers: {metadata.get('total_providers', 'N/A'):,}
- Self-referral rate: {metadata.get('self_referral_pct', 'N/A')}% ({metadata.get('self_referral_rows', 0):,} rows)
- Analysis date: {metadata.get('analysis_date', 'N/A')}

### Global Payment Statistics
- Mean total paid per provider: ${global_stats.get('mean_total_paid', 0):,.2f}
- Median total paid per provider: ${global_stats.get('median_total_paid', 0):,.2f}
- Std deviation: ${global_stats.get('std_total_paid', 0):,.2f}

### Benford's Law Analysis
{json.dumps(benford, indent=2)}

### Top 20 Statistical Outlier Providers (by z-score)
{json.dumps(top_providers, indent=2)}

### Notable Temporal Anomalies (sudden spikes/drops)
{json.dumps(temporal[:30], indent=2)}

### Document AI Extraction Summary
{json.dumps(docai_results, indent=2)}

### High/Medium Risk Counts
- Critical/High Risk (z > 5): {statistical_results.get('high_risk_count', 0)}
- Medium Risk (3 < z ≤ 5): {statistical_results.get('medium_risk_count', 0)}

---

Please provide a comprehensive fraud investigation report with:
1. **Executive Summary** — Key findings overview
2. **Top Fraud Suspects** — The most suspicious providers with specific evidence
3. **Pattern Analysis** — Common fraud patterns detected across providers  
4. **HCPCS Code Analysis** — Suspicious procedure code usage patterns
5. **Self-Referral Analysis** — Providers billing and servicing the same claims
6. **Benford's Law Implications** — What the digit distribution tells us
7. **Temporal Pattern Findings** — Billing spikes and anomalies
8. **Recommended Actions** — Specific investigation steps for each high-risk provider
9. **Risk Scoring Matrix** — Categorize all flagged providers into risk tiers
"""

    print("   📡 Sending analysis request to Gemini 2.5 Flash...")

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=analysis_prompt,
            config={
                "system_instruction": system_prompt,
                "temperature": 0.3,
                "max_output_tokens": 16000,
            },
        )

        report_text = response.text
        print(f"   ✅ Gemini analysis complete ({len(report_text):,} chars)")

        # Save the full report
        report_path = os.path.join(OUTPUT_DIR, "gemini_fraud_report.md")
        with open(report_path, "w") as f:
            f.write(f"# Medicaid Fraud Detection Report\n")
            f.write(f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"**Model**: {MODEL}\n")
            f.write(
                f"**Dataset**: {metadata.get('total_rows', 0):,} claims, {metadata.get('total_providers', 0):,} providers\n\n"
            )
            f.write("---\n\n")
            f.write(report_text)

        print(f"   📁 Report saved to {report_path}")
        return {"report": report_text, "report_path": report_path}

    except Exception as e:
        print(f"   ❌ Gemini analysis failed: {e}")
        return {"error": str(e)}


def generate_structured_risk_scores(top_providers: list) -> list[dict]:
    """
    Use Gemini with structured JSON output to score each provider's fraud risk.
    """
    print("\n📊 Phase 3b: Gemini Structured Risk Scoring...")

    # Process in batches of 10
    all_scores = []

    for i in range(0, min(len(top_providers), 50), 10):
        batch = top_providers[i : i + 10]
        batch_num = i // 10 + 1

        prompt = f"""Analyze these Medicaid providers and score their fraud risk.

For each provider, return a JSON array of objects with exactly these fields:
- "npi": the provider NPI string
- "risk_level": one of "CRITICAL", "HIGH", "MEDIUM", "LOW"  
- "risk_score": integer 0-100 (100 = highest fraud risk)
- "primary_indicators": array of top 3 fraud indicator strings
- "recommended_action": one of "IMMEDIATE_AUDIT", "ENHANCED_MONITORING", "ROUTINE_REVIEW", "CLEAR"
- "fraud_type_suspected": most likely fraud type string

Providers to analyze:
{json.dumps(batch, indent=2)}

Return ONLY the JSON array, no other text."""

        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=prompt,
                config={
                    "temperature": 0.1,
                    "max_output_tokens": 4000,
                    "response_mime_type": "application/json",
                },
            )

            scores = json.loads(response.text)
            all_scores.extend(scores)
            print(f"   ✅ Batch {batch_num}: Scored {len(scores)} providers")

        except Exception as e:
            print(f"   ⚠️ Batch {batch_num} scoring failed: {e}")
            # Generate fallback scores based on z-scores
            for p in batch:
                z = p.get("z_score", 0)
                all_scores.append(
                    {
                        "npi": p["npi"],
                        "risk_level": (
                            "CRITICAL" if z > 10 else "HIGH" if z > 5 else "MEDIUM"
                        ),
                        "risk_score": min(int(z * 10), 100),
                        "primary_indicators": [
                            "statistical_outlier",
                            f"z_score_{z:.1f}",
                        ],
                        "recommended_action": (
                            "IMMEDIATE_AUDIT" if z > 10 else "ENHANCED_MONITORING"
                        ),
                        "fraud_type_suspected": "unknown_requires_manual_review",
                    }
                )

        # Rate limiting
        time.sleep(1)

    # Save structured scores
    scores_path = os.path.join(OUTPUT_DIR, "risk_scores.json")
    with open(scores_path, "w") as f:
        json.dump(all_scores, f, indent=2)
    print(f"   📁 Risk scores saved to {scores_path}")

    return all_scores


# ═══════════════════════════════════════════════════════════════
# PHASE 4: Vertex AI Enhanced Analysis
# ═══════════════════════════════════════════════════════════════


def analyze_with_vertex(statistical_results: dict) -> dict:
    """
    Use Vertex AI endpoint for enhanced analysis with different model capabilities.
    Falls back gracefully if Vertex is not configured.
    """
    print("\n🔬 Phase 4: Vertex AI Enhanced Analysis...")

    if not VERTEX_API_KEY:
        print("   ⚠️ No VERTEX_API_KEY found, skipping Vertex analysis")
        return {"skipped": True}

    # Use Vertex AI REST endpoint directly
    url = f"https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key={VERTEX_API_KEY}"

    top_5 = statistical_results.get("outlier_providers", [])[:5]

    prompt = f"""As a healthcare fraud analytics expert using Vertex AI, perform a deep-dive analysis on these top 5 suspicious Medicaid providers.

For each provider, analyze:
1. Pattern of HCPCS code usage and potential upcoding/unbundling
2. Claim volume reasonableness given beneficiary counts
3. Payment amount distributions and anomalies
4. Comparison to industry benchmarks
5. Specific fraud typology most likely involved

Providers:
{json.dumps(top_5, indent=2)}

Provide a detailed technical analysis with specific numeric thresholds and benchmarks."""

    try:
        response = requests.post(
            url,
            json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8000},
            },
            timeout=60,
        )

        if response.status_code == 200:
            data = response.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]

            vertex_path = os.path.join(OUTPUT_DIR, "vertex_deep_analysis.md")
            with open(vertex_path, "w") as f:
                f.write(f"# Vertex AI Deep Fraud Analysis\n")
                f.write(
                    f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"
                )
                f.write(text)

            print(f"   ✅ Vertex AI analysis complete")
            print(f"   📁 Saved to {vertex_path}")
            return {"analysis": text, "path": vertex_path}
        else:
            print(
                f"   ⚠️ Vertex AI returned {response.status_code}: {response.text[:200]}"
            )
            return {"error": f"Status {response.status_code}"}

    except Exception as e:
        print(f"   ⚠️ Vertex AI analysis failed: {e}")
        return {"error": str(e)}


# ═══════════════════════════════════════════════════════════════
# PHASE 5: Final Report Generation
# ═══════════════════════════════════════════════════════════════


def generate_final_report(
    statistical: dict, docai: dict, gemini: dict, risk_scores: list, vertex: dict
):
    """Compile all analysis results into a comprehensive final report."""
    print("\n📝 Phase 5: Compiling Final Report...")

    metadata = statistical.get("metadata", {})
    global_stats = statistical.get("global_statistics", {})

    critical_providers = [s for s in risk_scores if s.get("risk_level") == "CRITICAL"]
    high_providers = [s for s in risk_scores if s.get("risk_level") == "HIGH"]
    immediate_audits = [
        s for s in risk_scores if s.get("recommended_action") == "IMMEDIATE_AUDIT"
    ]

    report = f"""# 🔴 MEDICAID FRAUD DETECTION — COMPREHENSIVE REPORT
**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
**Pipeline**: Statistical Analysis → Document AI → Gemini AI → Vertex AI

---

## 📊 Dataset Summary

| Metric | Value |
|--------|-------|
| Total Claims | {metadata.get('total_rows', 0):,} |
| Unique Providers | {metadata.get('total_providers', 0):,} |
| Self-Referral Rate | {metadata.get('self_referral_pct', 0)}% |
| Mean Provider Payment | ${global_stats.get('mean_total_paid', 0):,.2f} |
| Median Provider Payment | ${global_stats.get('median_total_paid', 0):,.2f} |

## 🚨 Risk Summary

| Risk Level | Count | Action Required |
|------------|-------|-----------------|
| 🔴 CRITICAL | {len(critical_providers)} | Immediate Audit |
| 🟠 HIGH | {len(high_providers)} | Enhanced Monitoring |
| 🟡 MEDIUM | {statistical.get('medium_risk_count', 0)} | Periodic Review |
| Total Flagged | {len(risk_scores)} | Various |

## 🎯 Immediate Audit Recommendations

{chr(10).join(f"- **NPI {p['npi']}**: Risk Score {p.get('risk_score', 'N/A')}/100 — {p.get('fraud_type_suspected', 'Unknown')} — {', '.join(p.get('primary_indicators', []))}" for p in immediate_audits[:20])}

## 📐 Benford's Law Analysis

{statistical.get('benford_analysis', {}).get('message', 'Not available')}
- Chi-squared statistic: {statistical.get('benford_analysis', {}).get('chi_squared', 'N/A')}

## 📅 Temporal Anomalies

Found **{len(statistical.get('temporal_anomalies', []))}** temporal anomalies (sudden spikes/drops):
{chr(10).join(f"- NPI {a['provider_npi']}: {a['anomaly_type']} in {a['month']} — ${a['payment']:,.2f} (z={a['z_score']})" for a in statistical.get('temporal_anomalies', [])[:10])}

## 📄 Document AI Extraction

- Pages processed: {docai.get('pages', 0)}
- Entities extracted: {len(docai.get('entities', []))}
- Tables found: {docai.get('tables', 0)}

## 🤖 AI Analysis Reports

### Gemini Report
{gemini.get('report', 'See gemini_fraud_report.md')[:2000]}{'...' if len(gemini.get('report', '')) > 2000 else ''}

### Vertex AI Analysis
{'See vertex_deep_analysis.md for full report' if not vertex.get('skipped') else 'Vertex AI analysis was skipped'}

---

## 📁 Output Files

| File | Description |
|------|-------------|
| `fraud_analysis/statistical_analysis.json` | Raw statistical indicators |
| `fraud_analysis/risk_scores.json` | Per-provider AI risk scores |
| `fraud_analysis/gemini_fraud_report.md` | Full Gemini analysis narrative |
| `fraud_analysis/vertex_deep_analysis.md` | Vertex AI deep-dive |
| `fraud_analysis/final_report.md` | This report |
| `fraud_analysis/docai_results/` | Document AI extraction results |

---

*Generated by Medicaid Fraud Detection Pipeline v1.0*
*Powered by Google Document AI, Gemini 2.5 Flash, and Vertex AI*
"""

    report_path = os.path.join(OUTPUT_DIR, "final_report.md")
    with open(report_path, "w") as f:
        f.write(report)

    print(f"   ✅ Final report saved to {report_path}")

    # Also save a machine-readable summary
    summary = {
        "generated": datetime.now().isoformat(),
        "total_rows": metadata.get("total_rows", 0),
        "total_providers": metadata.get("total_providers", 0),
        "critical_risk_providers": len(critical_providers),
        "high_risk_providers": len(high_providers),
        "immediate_audits_needed": len(immediate_audits),
        "benford_compliant": statistical.get("benford_analysis", {}).get(
            "compliant", None
        ),
        "temporal_anomalies_found": len(statistical.get("temporal_anomalies", [])),
        "self_referral_pct": metadata.get("self_referral_pct", 0),
        "top_suspects": [
            {
                "npi": s["npi"],
                "score": s.get("risk_score", 0),
                "type": s.get("fraud_type_suspected", ""),
            }
            for s in critical_providers[:10]
        ],
    }
    summary_path = os.path.join(OUTPUT_DIR, "summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    return report_path


# ═══════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════


def main():
    parser = argparse.ArgumentParser(description="Medicaid Fraud Detection Pipeline")
    parser.add_argument(
        "--skip-stats",
        action="store_true",
        help="Skip Phase 1 if statistical_analysis.json exists",
    )
    parser.add_argument(
        "--skip-docai", action="store_true", help="Skip Document AI processing"
    )
    parser.add_argument(
        "--skip-vertex", action="store_true", help="Skip Vertex AI analysis"
    )
    parser.add_argument(
        "--providers-limit", type=int, default=50, help="Number of providers to analyze"
    )
    args = parser.parse_args()

    print("=" * 70)
    print("  🔴 MEDICAID FRAUD DETECTION PIPELINE")
    print("  Powered by Google Document AI + Gemini + Vertex AI")
    print("=" * 70)
    print(f"\n  📋 Configuration:")
    print(f"     API Key: {'✅ Set' if API_KEY else '❌ Missing'} ({API_KEY[:10]}...)")
    print(f"     Vertex Key: {'✅ Set' if VERTEX_API_KEY else '❌ Missing'}")
    print(f"     Doc AI Processor: {DOCAI_PROCESSOR_ID}")
    print(f"     Project: {GOOGLE_PROJECT_ID} ({GOOGLE_PROJECT_NUMBER})")

    ensure_dirs()

    # Phase 1: Statistical Analysis
    stats_path = os.path.join(OUTPUT_DIR, "statistical_analysis.json")
    if args.skip_stats and os.path.exists(stats_path):
        print(f"\n⏭️  Phase 1: Loading existing analysis from {stats_path}")
        with open(stats_path) as f:
            statistical_results = json.load(f)
    else:
        statistical_results = compute_fraud_indicators()

    # Phase 2: Document AI
    if args.skip_docai:
        print("\n⏭️  Phase 2: Skipping Document AI")
        docai_results = {"skipped": True}
    else:
        pdf_bytes = create_provider_pdf(
            statistical_results.get("outlier_providers", [])
        )
        # Save the PDF
        pdf_path = os.path.join(OUTPUT_DIR, "suspicious_providers.pdf")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
        print(f"   📁 PDF saved to {pdf_path}")
        docai_results = process_with_document_ai(pdf_bytes)

    # Phase 3: Gemini Analysis
    gemini_results = analyze_with_gemini(statistical_results, docai_results)
    risk_scores = generate_structured_risk_scores(
        statistical_results.get("outlier_providers", [])[: args.providers_limit]
    )

    # Phase 4: Vertex AI
    if args.skip_vertex:
        print("\n⏭️  Phase 4: Skipping Vertex AI")
        vertex_results = {"skipped": True}
    else:
        vertex_results = analyze_with_vertex(statistical_results)

    # Phase 5: Final Report
    report_path = generate_final_report(
        statistical_results, docai_results, gemini_results, risk_scores, vertex_results
    )

    print("\n" + "=" * 70)
    print("  ✅ FRAUD DETECTION PIPELINE COMPLETE!")
    print("=" * 70)
    print(
        f"""
  📁 All results in: {OUTPUT_DIR}/
  📄 Final Report: {report_path}

  🚀 Next Steps:
     1. Review the final report: cat {report_path}
     2. Examine high-risk providers: cat {OUTPUT_DIR}/risk_scores.json
     3. Read the Gemini analysis: cat {OUTPUT_DIR}/gemini_fraud_report.md
     4. Upload HF dataset: huggingface-cli upload <user>/medicaid-fraud hf_dataset/
"""
    )


if __name__ == "__main__":
    main()
