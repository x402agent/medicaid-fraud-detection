#!/usr/bin/env python3
"""
HCPCS code anomaly analysis for Medicaid fraud detection.

Outputs:
- fraud_analysis/code_anomalies.json
"""

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

import pandas as pd

CSV_PATH = "medicaid-provider-spending.csv"
OUTPUT_PATH = "fraud_analysis/code_anomalies.json"
CHUNK_SIZE = 1_000_000

# Heuristic bundle pairs for monthly co-billing pattern checks.
# This dataset is month-level aggregated, so these are weak signals.
BUNDLE_RULES = [
    {
        "bundle_name": "ECG global + tracing component",
        "codes": ["93000", "93005"],
        "description": "Frequent co-billing may indicate component unbundling patterns.",
    },
    {
        "bundle_name": "Chest X-ray one-view + two-view",
        "codes": ["71045", "71046"],
        "description": "Repeated monthly co-billing can suggest redundant imaging claims.",
    },
    {
        "bundle_name": "Urinalysis dipstick + microscopy",
        "codes": ["81003", "81001"],
        "description": "Persistent co-billing may indicate unbundled lab billing.",
    },
    {
        "bundle_name": "Transport base + mileage",
        "codes": ["A0428", "A0425"],
        "description": "Expected sometimes, but extreme concentration can indicate abuse.",
    },
]


def parse_args():
    parser = argparse.ArgumentParser(description="Analyze HCPCS code-level fraud anomalies")
    parser.add_argument("--csv", default=CSV_PATH, help="Path to Medicaid CSV")
    parser.add_argument("--output", default=OUTPUT_PATH, help="Output JSON path")
    parser.add_argument("--chunk-size", type=int, default=CHUNK_SIZE, help="Pandas read_csv chunk size")
    parser.add_argument(
        "--candidate-ratio-threshold",
        type=float,
        default=1.5,
        help="Row-level ratio prefilter for provider×code candidate accumulation",
    )
    parser.add_argument(
        "--anomaly-ratio-threshold",
        type=float,
        default=3.0,
        help="Provider×code ratio threshold for final anomaly output",
    )
    parser.add_argument(
        "--min-claims",
        type=int,
        default=20,
        help="Minimum claims for a provider×code combo to be emitted",
    )
    parser.add_argument(
        "--max-anomalies",
        type=int,
        default=25000,
        help="Maximum anomaly rows to keep in output",
    )
    return parser.parse_args()


def ensure_output_dir(path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def flag_from_ratio(ratio: float) -> str:
    if ratio >= 8:
        return "CRITICAL"
    if ratio >= 5:
        return "HIGH"
    if ratio >= 3:
        return "ELEVATED"
    return "LOW"


def analyze_codes(
    csv_path: str,
    output_path: str,
    chunk_size: int,
    candidate_ratio_threshold: float,
    anomaly_ratio_threshold: float,
    min_claims: int,
    max_anomalies: int,
):
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    ensure_output_dir(output_path)
    print("\n🧬 HCPCS Code Anomaly Analysis")
    print(f"   CSV: {csv_path}")
    print(f"   Chunk size: {chunk_size:,}")

    # Pass 1: National code baselines.
    code_totals = defaultdict(lambda: {"paid": 0.0, "claims": 0})
    total_rows = 0
    providers_seen = set()

    print("\n1) Computing national average paid-per-claim by HCPCS...")
    for chunk in pd.read_csv(
        csv_path,
        chunksize=chunk_size,
        dtype={
            "BILLING_PROVIDER_NPI_NUM": str,
            "HCPCS_CODE": str,
            "CLAIM_FROM_MONTH": str,
            "TOTAL_CLAIMS": "Int64",
            "TOTAL_PAID": float,
        },
        usecols=[
            "BILLING_PROVIDER_NPI_NUM",
            "HCPCS_CODE",
            "CLAIM_FROM_MONTH",
            "TOTAL_CLAIMS",
            "TOTAL_PAID",
        ],
    ):
        chunk["TOTAL_PAID"] = chunk["TOTAL_PAID"].fillna(0.0)
        chunk["TOTAL_CLAIMS"] = chunk["TOTAL_CLAIMS"].fillna(0).astype("int64")
        chunk = chunk[chunk["HCPCS_CODE"].notna() & (chunk["TOTAL_CLAIMS"] > 0)]

        grp = chunk.groupby("HCPCS_CODE", as_index=False).agg(
            total_paid=("TOTAL_PAID", "sum"),
            total_claims=("TOTAL_CLAIMS", "sum"),
        )
        for _, row in grp.iterrows():
            code = row["HCPCS_CODE"]
            code_totals[code]["paid"] += float(row["total_paid"])
            code_totals[code]["claims"] += int(row["total_claims"])

        providers_seen.update(chunk["BILLING_PROVIDER_NPI_NUM"].dropna().unique().tolist())
        total_rows += len(chunk)
        if total_rows % 10_000_000 == 0:
            print(f"   Processed {total_rows:,} rows...")

    national_avg = {}
    for code, totals in code_totals.items():
        claims = max(totals["claims"], 1)
        national_avg[code] = totals["paid"] / claims

    print(f"   ✅ National baselines for {len(national_avg):,} HCPCS codes")

    # Pass 2: Provider×code combos against national baseline.
    # To keep memory bounded, we only accumulate candidates above a soft ratio threshold.
    provider_code_totals = defaultdict(lambda: {"paid": 0.0, "claims": 0, "rows": 0})

    tracked_codes = {code for rule in BUNDLE_RULES for code in rule["codes"]}
    bundle_counts = {
        rule["bundle_name"]: {
            "codes": rule["codes"],
            "description": rule["description"],
            "cooccurrences": 0,
            "provider_set": set(),
        }
        for rule in BUNDLE_RULES
    }

    print("\n2) Computing provider×code ratios and unbundling signals...")
    total_rows = 0
    for chunk in pd.read_csv(
        csv_path,
        chunksize=chunk_size,
        dtype={
            "BILLING_PROVIDER_NPI_NUM": str,
            "HCPCS_CODE": str,
            "CLAIM_FROM_MONTH": str,
            "TOTAL_CLAIMS": "Int64",
            "TOTAL_PAID": float,
        },
        usecols=[
            "BILLING_PROVIDER_NPI_NUM",
            "HCPCS_CODE",
            "CLAIM_FROM_MONTH",
            "TOTAL_CLAIMS",
            "TOTAL_PAID",
        ],
    ):
        chunk["TOTAL_PAID"] = chunk["TOTAL_PAID"].fillna(0.0)
        chunk["TOTAL_CLAIMS"] = chunk["TOTAL_CLAIMS"].fillna(0).astype("int64")
        chunk = chunk[
            chunk["HCPCS_CODE"].notna()
            & chunk["BILLING_PROVIDER_NPI_NUM"].notna()
            & (chunk["TOTAL_CLAIMS"] > 0)
        ]
        if chunk.empty:
            continue

        chunk["national_avg_paid_per_claim"] = chunk["HCPCS_CODE"].map(national_avg).fillna(0.0)
        chunk = chunk[chunk["national_avg_paid_per_claim"] > 0]
        if chunk.empty:
            continue

        chunk["provider_avg_paid_per_claim"] = chunk["TOTAL_PAID"] / chunk["TOTAL_CLAIMS"]
        chunk["ratio_to_national_avg"] = (
            chunk["provider_avg_paid_per_claim"] / chunk["national_avg_paid_per_claim"]
        )

        candidates = chunk[chunk["ratio_to_national_avg"] >= candidate_ratio_threshold]
        if not candidates.empty:
            grp = candidates.groupby(["BILLING_PROVIDER_NPI_NUM", "HCPCS_CODE"], as_index=False).agg(
                total_paid=("TOTAL_PAID", "sum"),
                total_claims=("TOTAL_CLAIMS", "sum"),
                rows=("HCPCS_CODE", "count"),
            )
            for _, row in grp.iterrows():
                key = (row["BILLING_PROVIDER_NPI_NUM"], row["HCPCS_CODE"])
                provider_code_totals[key]["paid"] += float(row["total_paid"])
                provider_code_totals[key]["claims"] += int(row["total_claims"])
                provider_code_totals[key]["rows"] += int(row["rows"])

        # Unbundling heuristics at provider-month level for tracked code pairs.
        sub = chunk[chunk["HCPCS_CODE"].isin(tracked_codes)]
        if not sub.empty:
            pm_codes = sub.groupby(["BILLING_PROVIDER_NPI_NUM", "CLAIM_FROM_MONTH"])["HCPCS_CODE"].agg(
                lambda s: set(s.dropna().tolist())
            )
            for (provider_npi, _month), code_set in pm_codes.items():
                for rule in BUNDLE_RULES:
                    pair = set(rule["codes"])
                    if pair.issubset(code_set):
                        bundle = bundle_counts[rule["bundle_name"]]
                        bundle["cooccurrences"] += 1
                        bundle["provider_set"].add(provider_npi)

        total_rows += len(chunk)
        if total_rows % 10_000_000 == 0:
            print(f"   Processed {total_rows:,} rows...")

    anomalies = []
    for (provider_npi, hcpcs_code), totals in provider_code_totals.items():
        claims = totals["claims"]
        if claims < min_claims:
            continue
        provider_avg = totals["paid"] / max(claims, 1)
        nat_avg = national_avg.get(hcpcs_code, 0.0)
        if nat_avg <= 0:
            continue
        ratio = provider_avg / nat_avg
        if ratio < anomaly_ratio_threshold:
            continue
        anomalies.append(
            {
                "provider_npi": provider_npi,
                "hcpcs_code": hcpcs_code,
                "total_paid": round(totals["paid"], 2),
                "total_claims": int(claims),
                "provider_avg_paid_per_claim": round(provider_avg, 2),
                "national_avg_paid_per_claim": round(nat_avg, 2),
                "ratio_to_national_avg": round(ratio, 2),
                "row_count_considered": int(totals["rows"]),
                "flag": flag_from_ratio(ratio),
            }
        )

    anomalies.sort(
        key=lambda x: (x["ratio_to_national_avg"], x["total_paid"], x["total_claims"]),
        reverse=True,
    )
    if max_anomalies > 0:
        anomalies = anomalies[:max_anomalies]

    national_code_stats = []
    for code, totals in code_totals.items():
        claims = max(int(totals["claims"]), 1)
        national_code_stats.append(
            {
                "hcpcs_code": code,
                "total_paid": round(float(totals["paid"]), 2),
                "total_claims": int(totals["claims"]),
                "national_avg_paid_per_claim": round(float(totals["paid"]) / claims, 2),
            }
        )
    national_code_stats.sort(key=lambda x: x["total_paid"], reverse=True)
    national_code_stats = national_code_stats[:1000]

    unbundling_signals = []
    for bundle_name, data in bundle_counts.items():
        providers_flagged = len(data["provider_set"])
        if providers_flagged == 0:
            continue
        unbundling_signals.append(
            {
                "bundle_name": bundle_name,
                "codes": data["codes"],
                "description": data["description"],
                "providers_flagged": providers_flagged,
                "cooccurrences": data["cooccurrences"],
                "code_pair": " + ".join(data["codes"]),
            }
        )
    unbundling_signals.sort(
        key=lambda x: (x["providers_flagged"], x["cooccurrences"]), reverse=True
    )

    output = {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "csv_path": csv_path,
            "total_rows_processed": int(total_rows),
            "total_providers_scanned": len(providers_seen),
            "total_hcpcs_codes": len(national_avg),
            "candidate_ratio_threshold": candidate_ratio_threshold,
            "upcoding_ratio_threshold": anomaly_ratio_threshold,
            "min_claims_threshold": min_claims,
            "max_anomalies": max_anomalies,
            "method_notes": [
                "National baselines computed as total_paid / total_claims by HCPCS.",
                "Provider-code accumulation uses candidate prefilter for memory safety on 227M rows.",
                "Unbundling is heuristic only due monthly aggregated data (not claim-line level).",
            ],
        },
        "anomalies": anomalies,
        "unbundling_signals": unbundling_signals,
        "national_code_stats": national_code_stats,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Saved: {output_path}")
    print(f"   Anomalies: {len(anomalies):,}")
    print(f"   Unbundling signals: {len(unbundling_signals):,}")


def main():
    args = parse_args()
    analyze_codes(
        csv_path=args.csv,
        output_path=args.output,
        chunk_size=args.chunk_size,
        candidate_ratio_threshold=args.candidate_ratio_threshold,
        anomaly_ratio_threshold=args.anomaly_ratio_threshold,
        min_claims=args.min_claims,
        max_anomalies=args.max_anomalies,
    )


if __name__ == "__main__":
    main()
