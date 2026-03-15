#!/usr/bin/env python3
"""
Prepare Medicaid Provider Spending CSV for Google Document AI
=============================================================
1. Reads a sample of the CSV (configurable rows)
2. Converts it to a well-formatted PDF table
3. Base64-encodes the PDF
4. Creates request.json for the Document AI API
"""

import csv
import base64
import json
import os
import sys
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, LETTER
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

# ── Configuration ──────────────────────────────────────────────
CSV_PATH = "medicaid-provider-spending.csv"
SAMPLE_ROWS = 500          # Number of data rows to include in the PDF
OUTPUT_PDF = "medicaid_sample.pdf"
OUTPUT_JSON = "request.json"

# Document AI endpoint info (from user's request)
DOCAI_ENDPOINT = (
    "https://us-documentai.googleapis.com/v1/"
    "projects/691016932195/locations/us/"
    "processors/f9f3ab408f414eea:process"
)


def read_csv_sample(csv_path: str, max_rows: int) -> tuple[list[str], list[list[str]]]:
    """Read header + N rows from the CSV."""
    headers = []
    rows = []
    with open(csv_path, "r", newline="") as f:
        reader = csv.reader(f)
        headers = next(reader)
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            rows.append(row)
    return headers, rows


def create_pdf(headers: list[str], rows: list[list[str]], output_path: str) -> bytes:
    """Generate a landscape PDF table from CSV data."""
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(LETTER),
        leftMargin=0.5 * inch,
        rightMargin=0.5 * inch,
        topMargin=0.5 * inch,
        bottomMargin=0.5 * inch,
    )

    styles = getSampleStyleSheet()
    elements = []

    # Title
    title = Paragraph(
        "<b>Medicaid Provider Spending Data</b> — "
        f"Sample ({len(rows)} rows)",
        styles["Title"],
    )
    elements.append(title)
    elements.append(Spacer(1, 12))

    # Column display names (shorter for table)
    col_names = [
        "Billing NPI",
        "Servicing NPI",
        "HCPCS",
        "Claim Month",
        "Beneficiaries",
        "Claims",
        "Total Paid ($)",
    ]

    # Build table data
    table_data = [col_names]
    for row in rows:
        formatted_row = list(row)
        # Format the dollar amount
        if len(formatted_row) >= 7:
            try:
                val = float(formatted_row[6])
                formatted_row[6] = f"${val:,.2f}"
            except (ValueError, IndexError):
                pass
        table_data.append(formatted_row)

    # Column widths
    col_widths = [1.2 * inch, 1.2 * inch, 0.8 * inch, 1.0 * inch, 1.1 * inch, 0.8 * inch, 1.3 * inch]

    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        # Header
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a237e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        # Data rows
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
        ("TOPPADDING", (0, 1), (-1, -1), 3),
        # Alternating row colors
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f5f5")]),
        # Grid
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        # Right-align numeric columns
        ("ALIGN", (4, 0), (-1, -1), "RIGHT"),
    ]))

    elements.append(table)
    doc.build(elements)

    pdf_bytes = buffer.getvalue()
    buffer.close()

    # Also save to file for inspection
    with open(output_path, "wb") as f:
        f.write(pdf_bytes)

    return pdf_bytes


def create_request_json(pdf_bytes: bytes, output_path: str):
    """Create the Document AI request.json with base64-encoded PDF."""
    b64_content = base64.b64encode(pdf_bytes).decode("utf-8")

    request_body = {
        "skipHumanReview": True,
        "rawDocument": {
            "mimeType": "application/pdf",
            "content": b64_content,
        },
    }

    with open(output_path, "w") as f:
        json.dump(request_body, f, indent=2)

    return len(b64_content)


def main():
    print("=" * 60)
    print("  Medicaid Data → Document AI Pipeline")
    print("=" * 60)

    # Step 1: Read CSV sample
    print(f"\n📄 Reading {SAMPLE_ROWS} rows from {CSV_PATH}...")
    headers, rows = read_csv_sample(CSV_PATH, SAMPLE_ROWS)
    print(f"   ✓ Loaded {len(rows)} rows with {len(headers)} columns")
    print(f"   Columns: {', '.join(headers)}")

    # Step 2: Create PDF
    print(f"\n📊 Generating PDF table → {OUTPUT_PDF}...")
    pdf_bytes = create_pdf(headers, rows, OUTPUT_PDF)
    pdf_size_mb = len(pdf_bytes) / (1024 * 1024)
    print(f"   ✓ PDF created: {pdf_size_mb:.2f} MB")

    # Step 3: Create request.json
    print(f"\n📦 Creating {OUTPUT_JSON}...")
    b64_len = create_request_json(pdf_bytes, OUTPUT_JSON)
    json_size_mb = os.path.getsize(OUTPUT_JSON) / (1024 * 1024)
    print(f"   ✓ request.json created: {json_size_mb:.2f} MB")
    print(f"   ✓ Base64 content length: {b64_len:,} chars")

    # Step 4: Print the curl command
    print("\n" + "=" * 60)
    print("  🚀 Ready! Run this curl command:")
    print("=" * 60)
    print(f"""
curl -X POST \\
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \\
  -H "Content-Type: application/json; charset=utf-8" \\
  -d @{OUTPUT_JSON} \\
  "{DOCAI_ENDPOINT}"
""")

    # Check if gcloud is available
    if os.system("which gcloud > /dev/null 2>&1") != 0:
        print("⚠️  WARNING: gcloud CLI not found. Install it from:")
        print("   https://cloud.google.com/sdk/docs/install")
        print("   Then run: gcloud auth application-default login")


if __name__ == "__main__":
    main()
