#!/usr/bin/env python3
"""
Medicaid Provider Spending → LLM-Ready Hugging Face Dataset
============================================================
Transforms the raw CSV into:
1. Parquet shards for efficient loading
2. JSONL instruction-tuning format for fraud detection LLMs
3. Dataset card (README.md) for Hugging Face Hub

The dataset is structured for both:
- Supervised fine-tuning (SFT) with fraud analysis prompts
- Direct analysis with statistical features for anomaly detection
"""

import csv
import json
import os
import sys
import math
import statistics
from collections import defaultdict
from datetime import datetime

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

# ── Configuration ──────────────────────────────────────────────
CSV_PATH = "medicaid-provider-spending.csv"
OUTPUT_DIR = "hf_dataset"
PARQUET_DIR = os.path.join(OUTPUT_DIR, "data")
JSONL_DIR = os.path.join(OUTPUT_DIR, "instruction_tuning")

# Chunk size for processing the massive CSV
CHUNK_SIZE = 1_000_000  # 1M rows per chunk

# For the instruction-tuning subset, we create prompts for
# the top anomalous providers (by various metrics)
TOP_K_ANOMALIES = 5000


def ensure_dirs():
    """Create output directories."""
    os.makedirs(PARQUET_DIR, exist_ok=True)
    os.makedirs(JSONL_DIR, exist_ok=True)


def convert_csv_to_parquet():
    """
    Stream-convert the large CSV to partitioned Parquet files.
    This is memory-efficient and produces the base dataset.
    """
    print("\n📦 Phase 1: Converting CSV → Parquet (sharded)...")

    schema = pa.schema(
        [
            ("billing_provider_npi", pa.string()),
            ("servicing_provider_npi", pa.string()),
            ("hcpcs_code", pa.string()),
            ("claim_month", pa.string()),
            ("total_unique_beneficiaries", pa.int64()),
            ("total_claims", pa.int64()),
            ("total_paid", pa.float64()),
        ]
    )

    shard_idx = 0
    total_rows = 0

    for chunk in pd.read_csv(
        CSV_PATH,
        chunksize=CHUNK_SIZE,
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
        # Rename columns to lowercase
        chunk.columns = [
            "billing_provider_npi",
            "servicing_provider_npi",
            "hcpcs_code",
            "claim_month",
            "total_unique_beneficiaries",
            "total_claims",
            "total_paid",
        ]

        # Fill NaN NPIs with empty string
        chunk["servicing_provider_npi"] = chunk["servicing_provider_npi"].fillna("")

        # Convert to Arrow table and write Parquet shard
        table = pa.Table.from_pandas(chunk, schema=schema, preserve_index=False)
        shard_path = os.path.join(PARQUET_DIR, f"shard-{shard_idx:05d}.parquet")
        pq.write_table(table, shard_path, compression="snappy")

        total_rows += len(chunk)
        shard_idx += 1
        print(f"   ✓ Shard {shard_idx}: {total_rows:,} rows processed")

    print(f"   ✅ Total: {total_rows:,} rows → {shard_idx} Parquet shards")
    return total_rows, shard_idx


def compute_provider_stats():
    """
    Compute per-provider aggregate statistics using vectorized Pandas groupby.
    Much faster than iterrows for 227M+ rows.
    """
    print("\n📊 Phase 2: Computing provider-level statistics (vectorized)...")

    # We'll accumulate partial aggregates per chunk, then merge
    agg_paid = {}  # npi -> sum of total_paid
    agg_claims = {}  # npi -> sum of total_claims
    agg_benes = {}  # npi -> sum of beneficiaries
    agg_hcpcs = {}  # npi -> set of hcpcs codes
    agg_months = {}  # npi -> set of months
    agg_payment_list = {}  # npi -> list of per-row paid values (for std)
    agg_row_count = {}  # npi -> count of rows

    row_count = 0
    for chunk in pd.read_csv(
        CSV_PATH,
        chunksize=CHUNK_SIZE,
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
        chunk["TOTAL_PAID"] = chunk["TOTAL_PAID"].fillna(0.0)
        chunk["TOTAL_CLAIMS"] = chunk["TOTAL_CLAIMS"].fillna(0)
        chunk["TOTAL_UNIQUE_BENEFICIARIES"] = chunk[
            "TOTAL_UNIQUE_BENEFICIARIES"
        ].fillna(0)

        # Vectorized groupby aggregations
        grp = chunk.groupby("BILLING_PROVIDER_NPI_NUM")

        chunk_paid = grp["TOTAL_PAID"].sum()
        chunk_claims = grp["TOTAL_CLAIMS"].sum()
        chunk_benes = grp["TOTAL_UNIQUE_BENEFICIARIES"].sum()
        chunk_hcpcs = grp["HCPCS_CODE"].apply(set)
        chunk_months = grp["CLAIM_FROM_MONTH"].apply(set)
        chunk_rows = grp.size()

        # For payment std, we need individual values — collect per-provider means
        # Use Welford's online algorithm approach: collect sum, sum_sq, count
        chunk_paid_sum_sq = grp["TOTAL_PAID"].apply(lambda x: (x**2).sum())

        for npi in chunk_paid.index:
            # Sum aggregates
            agg_paid[npi] = agg_paid.get(npi, 0.0) + float(chunk_paid[npi])
            agg_claims[npi] = agg_claims.get(npi, 0) + int(chunk_claims[npi])
            agg_benes[npi] = agg_benes.get(npi, 0) + int(chunk_benes[npi])
            agg_row_count[npi] = agg_row_count.get(npi, 0) + int(chunk_rows[npi])

            # Set aggregates
            if npi not in agg_hcpcs:
                agg_hcpcs[npi] = set()
            agg_hcpcs[npi].update(chunk_hcpcs[npi])

            if npi not in agg_months:
                agg_months[npi] = set()
            agg_months[npi].update(chunk_months[npi])

            # For std computation: store sum and sum_sq
            if npi not in agg_payment_list:
                agg_payment_list[npi] = {"sum": 0.0, "sum_sq": 0.0, "n": 0}
            agg_payment_list[npi]["sum"] += float(chunk_paid[npi])
            agg_payment_list[npi]["sum_sq"] += float(chunk_paid_sum_sq[npi])
            agg_payment_list[npi]["n"] += int(chunk_rows[npi])

        row_count += len(chunk)
        print(
            f"   Processing... {row_count:,} rows analyzed ({len(agg_paid):,} providers found)"
        )

    # Build enriched provider list
    enriched_providers = []
    for npi in agg_paid:
        total_paid = agg_paid[npi]
        total_claims = agg_claims[npi]
        months_active = len(agg_months.get(npi, set()))

        avg_payment_per_claim = total_paid / total_claims if total_claims > 0 else 0
        avg_benes_per_month = agg_benes[npi] / months_active if months_active > 0 else 0

        # Compute std from sum, sum_sq, n (population std)
        pstats = agg_payment_list.get(npi, {"sum": 0, "sum_sq": 0, "n": 0})
        n = pstats["n"]
        if n > 1:
            mean_val = pstats["sum"] / n
            variance = (pstats["sum_sq"] / n) - (mean_val**2)
            payment_std = math.sqrt(max(variance, 0))  # guard against floating point
            payment_cv = payment_std / mean_val if mean_val > 0 else 0
        else:
            mean_val = pstats["sum"] if n == 1 else 0
            payment_std = 0
            payment_cv = 0

        hcpcs_set = agg_hcpcs.get(npi, set())

        enriched_providers.append(
            {
                "billing_provider_npi": npi,
                "total_paid": round(total_paid, 2),
                "total_claims": total_claims,
                "unique_hcpcs_codes": len(hcpcs_set),
                "hcpcs_codes_list": sorted(hcpcs_set),
                "months_active": months_active,
                "avg_payment_per_claim": round(avg_payment_per_claim, 2),
                "avg_beneficiaries_per_month": round(avg_benes_per_month, 2),
                "monthly_payment_std": round(payment_std, 2),
                "monthly_payment_mean": round(mean_val, 2),
                "payment_coefficient_of_variation": round(payment_cv, 4),
            }
        )

    # Sort by total paid descending for anomaly analysis
    enriched_providers.sort(key=lambda x: x["total_paid"], reverse=True)

    print(f"   ✅ Computed stats for {len(enriched_providers):,} unique providers")
    return enriched_providers


def generate_instruction_tuning_data(provider_stats: list):
    """
    Generate instruction-tuning JSONL files for fraud detection LLMs.
    Creates multiple prompt styles for diverse training.
    """
    print(f"\n🤖 Phase 3: Generating instruction-tuning data...")

    # Take top providers for detailed analysis prompts
    top_providers = provider_stats[:TOP_K_ANOMALIES]

    # Compute global statistics for context
    all_paid = [p["total_paid"] for p in provider_stats]
    global_mean_paid = statistics.mean(all_paid) if all_paid else 0
    global_median_paid = statistics.median(all_paid) if all_paid else 0
    global_std_paid = statistics.stdev(all_paid) if len(all_paid) > 1 else 0

    instruction_records = []

    for provider in top_providers:
        npi = provider["billing_provider_npi"]
        z_score = (
            (provider["total_paid"] - global_mean_paid) / global_std_paid
            if global_std_paid > 0
            else 0
        )

        # ── Prompt Style 1: Provider Fraud Risk Assessment ──
        instruction_records.append(
            {
                "instruction": (
                    "You are a Medicaid fraud detection analyst. Analyze the following "
                    "provider's billing data and assess the fraud risk level (LOW, MEDIUM, HIGH). "
                    "Explain your reasoning based on statistical anomalies."
                ),
                "input": json.dumps(
                    {
                        "provider_npi": npi,
                        "total_paid": provider["total_paid"],
                        "total_claims": provider["total_claims"],
                        "unique_procedures": provider["unique_hcpcs_codes"],
                        "procedures": provider["hcpcs_codes_list"][:10],  # Top 10
                        "months_active": provider["months_active"],
                        "avg_payment_per_claim": provider["avg_payment_per_claim"],
                        "avg_beneficiaries_per_month": provider[
                            "avg_beneficiaries_per_month"
                        ],
                        "payment_variability_cv": provider[
                            "payment_coefficient_of_variation"
                        ],
                        "z_score_vs_all_providers": round(z_score, 2),
                        "global_mean_total_paid": round(global_mean_paid, 2),
                        "global_median_total_paid": round(global_median_paid, 2),
                    },
                    indent=2,
                ),
                "output": _generate_risk_assessment(provider, z_score),
                "category": "fraud_risk_assessment",
            }
        )

        # ── Prompt Style 2: Anomaly Explanation ──
        instruction_records.append(
            {
                "instruction": (
                    "Explain why this Medicaid provider's billing pattern is unusual "
                    "compared to typical providers. Identify specific red flags."
                ),
                "input": (
                    f"Provider NPI: {npi}\n"
                    f"Total Medicaid payments received: ${provider['total_paid']:,.2f}\n"
                    f"Total claims filed: {provider['total_claims']:,}\n"
                    f"Average payment per claim: ${provider['avg_payment_per_claim']:,.2f}\n"
                    f"Number of different procedures billed: {provider['unique_hcpcs_codes']}\n"
                    f"Months of activity: {provider['months_active']}\n"
                    f"Average beneficiaries per month: {provider['avg_beneficiaries_per_month']:,.0f}\n"
                    f"Payment variability (CV): {provider['payment_coefficient_of_variation']:.4f}\n"
                    f"Z-score vs all providers: {z_score:.2f}"
                ),
                "output": _generate_anomaly_explanation(provider, z_score),
                "category": "anomaly_explanation",
            }
        )

        # ── Prompt Style 3: Comparative Analysis ──
        instruction_records.append(
            {
                "instruction": (
                    "Compare this provider's Medicaid billing statistics against the "
                    "national averages and determine if further investigation is warranted."
                ),
                "input": (
                    f"Provider {npi} Statistics:\n"
                    f"  - Total paid: ${provider['total_paid']:,.2f}\n"
                    f"  - Claims: {provider['total_claims']:,}\n"
                    f"  - Avg $/claim: ${provider['avg_payment_per_claim']:,.2f}\n"
                    f"\nNational Averages:\n"
                    f"  - Mean total paid per provider: ${global_mean_paid:,.2f}\n"
                    f"  - Median total paid per provider: ${global_median_paid:,.2f}\n"
                    f"  - Std deviation: ${global_std_paid:,.2f}"
                ),
                "output": _generate_comparative_analysis(
                    provider, global_mean_paid, global_median_paid, z_score
                ),
                "category": "comparative_analysis",
            }
        )

    # Write JSONL files
    # Full instruction tuning set
    jsonl_path = os.path.join(JSONL_DIR, "fraud_detection_instructions.jsonl")
    with open(jsonl_path, "w") as f:
        for record in instruction_records:
            f.write(json.dumps(record) + "\n")

    # Also write a train/eval split (90/10)
    split_idx = int(len(instruction_records) * 0.9)
    train_path = os.path.join(JSONL_DIR, "train.jsonl")
    eval_path = os.path.join(JSONL_DIR, "eval.jsonl")

    with open(train_path, "w") as f:
        for record in instruction_records[:split_idx]:
            f.write(json.dumps(record) + "\n")

    with open(eval_path, "w") as f:
        for record in instruction_records[split_idx:]:
            f.write(json.dumps(record) + "\n")

    print(f"   ✅ Generated {len(instruction_records):,} instruction-tuning examples")
    print(f"   📁 {jsonl_path}")
    print(f"   📁 {train_path} ({split_idx:,} examples)")
    print(f"   📁 {eval_path} ({len(instruction_records) - split_idx:,} examples)")

    # Save provider stats as standalone JSON
    stats_path = os.path.join(OUTPUT_DIR, "provider_statistics.json")
    with open(stats_path, "w") as f:
        json.dump(provider_stats[:TOP_K_ANOMALIES], f, indent=2)
    print(f"   📁 {stats_path}")

    return len(instruction_records)


def _generate_risk_assessment(provider: dict, z_score: float) -> str:
    """Generate a structured risk assessment response."""
    risk = "HIGH" if z_score > 3 else ("MEDIUM" if z_score > 1.5 else "LOW")
    flags = []

    if z_score > 3:
        flags.append(
            f"Extremely high total payments (z-score: {z_score:.2f}), far exceeding the national average"
        )
    if provider["payment_coefficient_of_variation"] > 0.5:
        flags.append(
            f"High payment variability (CV: {provider['payment_coefficient_of_variation']:.4f}) suggesting irregular billing patterns"
        )
    if provider["unique_hcpcs_codes"] <= 2 and provider["total_paid"] > 1_000_000:
        flags.append(
            f"Very narrow procedure focus ({provider['unique_hcpcs_codes']} codes) with high total volume — potential upcoding or unbundling"
        )
    if provider["avg_beneficiaries_per_month"] > 10_000:
        flags.append(
            f"Unusually high patient volume ({provider['avg_beneficiaries_per_month']:,.0f} avg beneficiaries/month)"
        )
    if provider["total_claims"] > 100_000 and provider["months_active"] < 12:
        flags.append(
            f"High claim volume ({provider['total_claims']:,}) in a short active period ({provider['months_active']} months)"
        )

    if not flags:
        flags.append(
            "No major statistical anomalies detected based on available metrics"
        )

    return (
        f"**FRAUD RISK LEVEL: {risk}**\n\n"
        f"**Provider NPI:** {provider['billing_provider_npi']}\n"
        f"**Total Medicaid Payments:** ${provider['total_paid']:,.2f}\n"
        f"**Z-Score:** {z_score:.2f}\n\n"
        f"**Red Flags Identified:**\n"
        + "\n".join(f"- {flag}" for flag in flags)
        + f"\n\n**Recommendation:** {'Immediate investigation recommended. This provider exhibits multiple statistical anomalies that warrant a detailed audit of claims, beneficiary records, and procedure documentation.' if risk == 'HIGH' else 'Continue routine monitoring.' if risk == 'LOW' else 'Flag for enhanced monitoring and periodic review of billing patterns.'}"
    )


def _generate_anomaly_explanation(provider: dict, z_score: float) -> str:
    """Generate a natural-language anomaly explanation."""
    explanations = []

    if z_score > 2:
        explanations.append(
            f"This provider's total Medicaid payments of ${provider['total_paid']:,.2f} "
            f"place them {z_score:.1f} standard deviations above the mean, indicating they are "
            f"a significant statistical outlier."
        )

    if provider["unique_hcpcs_codes"] == 1:
        explanations.append(
            f"The provider bills exclusively for a single procedure code "
            f"({provider['hcpcs_codes_list'][0]}), which is unusual and may indicate "
            f"specialization or potential billing manipulation."
        )

    if provider["avg_beneficiaries_per_month"] > 5000:
        explanations.append(
            f"With an average of {provider['avg_beneficiaries_per_month']:,.0f} unique "
            f"beneficiaries per month, this provider serves an exceptionally large patient "
            f"population that should be verified against capacity records."
        )

    if not explanations:
        explanations.append(
            "This provider's billing patterns fall within normal parameters based on "
            "the available statistical metrics. No significant anomalies detected."
        )

    return " ".join(explanations)


def _generate_comparative_analysis(
    provider: dict, global_mean: float, global_median: float, z_score: float
) -> str:
    """Generate a comparative analysis response."""
    ratio_to_mean = provider["total_paid"] / global_mean if global_mean > 0 else 0
    ratio_to_median = provider["total_paid"] / global_median if global_median > 0 else 0

    investigate = ratio_to_mean > 10 or z_score > 3

    return (
        f"**Comparative Analysis for Provider {provider['billing_provider_npi']}**\n\n"
        f"This provider's total payments of ${provider['total_paid']:,.2f} are "
        f"{ratio_to_mean:.1f}x the national mean and {ratio_to_median:.1f}x the national median.\n\n"
        f"With a z-score of {z_score:.2f}, this provider is "
        f"{'a significant outlier' if z_score > 3 else 'above average but within expected range' if z_score > 1 else 'within normal statistical bounds'}.\n\n"
        f"**Conclusion:** {'Further investigation IS warranted. The magnitude of deviation from national norms suggests potential billing irregularities that require audit.' if investigate else 'Further investigation is NOT warranted at this time based on comparative metrics alone. Continue standard monitoring.'}"
    )


def create_dataset_card(total_rows: int, num_shards: int, num_instructions: int):
    """Generate a Hugging Face dataset card (README.md)."""
    readme_content = f"""---
license: cc-by-4.0
task_categories:
  - text-classification
  - text-generation
  - question-answering
tags:
  - healthcare
  - fraud-detection
  - medicaid
  - medical-billing
  - anomaly-detection
  - instruction-tuning
size_categories:
  - 100M<n<1B
language:
  - en
pretty_name: Medicaid Provider Spending - Fraud Detection Dataset
---

# Medicaid Provider Spending — Fraud Detection Dataset

## Dataset Description

This dataset contains **{total_rows:,}** Medicaid provider spending records, transformed
into an LLM-ready format for healthcare fraud detection research and model fine-tuning.

### Source Data
- **Original**: CMS Medicaid Provider Spending Data
- **Format**: CSV → Parquet (sharded) + JSONL (instruction-tuning)
- **Processing Date**: {datetime.now().strftime('%Y-%m-%d')}

## Dataset Structure

### Parquet Data (`data/`)
The raw spending data in {num_shards} Parquet shards with the following schema:

| Column | Type | Description |
|--------|------|-------------|
| `billing_provider_npi` | string | National Provider Identifier of the billing entity |
| `servicing_provider_npi` | string | NPI of the servicing provider |
| `hcpcs_code` | string | Healthcare Common Procedure Coding System code |
| `claim_month` | string | Month of the claim (YYYY-MM format) |
| `total_unique_beneficiaries` | int64 | Number of unique Medicaid beneficiaries |
| `total_claims` | int64 | Total number of claims filed |
| `total_paid` | float64 | Total dollar amount paid by Medicaid |

### Instruction Tuning Data (`instruction_tuning/`)
**{num_instructions:,}** examples in JSONL format with three prompt styles:

1. **Fraud Risk Assessment** — Structured risk scoring (LOW/MEDIUM/HIGH) with red flags
2. **Anomaly Explanation** — Natural language explanations of unusual billing patterns
3. **Comparative Analysis** — Provider vs. national average comparisons

Each example follows the standard instruction-tuning format:
```json
{{
  "instruction": "System prompt describing the task",
  "input": "Provider data to analyze",
  "output": "Expected analysis response",
  "category": "prompt_style_category"
}}
```

### Pre-split Data
- `train.jsonl` — 90% training split
- `eval.jsonl` — 10% evaluation split

## Usage

### Loading with Hugging Face Datasets
```python
from datasets import load_dataset

# Load the Parquet data
dataset = load_dataset("parquet", data_files="data/*.parquet")

# Load instruction-tuning data
instructions = load_dataset("json", data_files="instruction_tuning/train.jsonl")
```

### Loading for Fine-Tuning
```python
from datasets import load_dataset

dataset = load_dataset("json", data_files={{
    "train": "instruction_tuning/train.jsonl",
    "eval": "instruction_tuning/eval.jsonl",
}})

# Format for chat-style fine-tuning
def format_prompt(example):
    return {{
        "text": f"### Instruction:\\n{{example['instruction']}}\\n\\n### Input:\\n{{example['input']}}\\n\\n### Response:\\n{{example['output']}}"
    }}

dataset = dataset.map(format_prompt)
```

## Intended Use

- **Fraud Detection Research**: Training and evaluating ML models for Medicaid fraud detection
- **LLM Fine-Tuning**: Instruction-tuning language models for healthcare billing analysis
- **Anomaly Detection**: Statistical analysis of provider billing patterns
- **Policy Research**: Understanding Medicaid spending distribution

## Limitations

- This dataset reflects aggregate billing data and does not contain individual patient records
- The instruction-tuning outputs are algorithmically generated assessments, not confirmed fraud determinations
- Provider NPI numbers are real identifiers from public CMS data

## Citation

```bibtex
@dataset{{medicaid_fraud_detection,
  title={{Medicaid Provider Spending - Fraud Detection Dataset}},
  year={{{datetime.now().year}}},
  source={{CMS Medicaid Provider Spending Data}},
}}
```
"""

    readme_path = os.path.join(OUTPUT_DIR, "README.md")
    with open(readme_path, "w") as f:
        f.write(readme_content)
    print(f"   📁 {readme_path}")


def main():
    print("=" * 70)
    print("  Medicaid Provider Spending → Hugging Face LLM Dataset Pipeline")
    print("=" * 70)

    ensure_dirs()

    # Phase 1: CSV → Parquet (skip if shards already exist)
    existing_shards = (
        [f for f in os.listdir(PARQUET_DIR) if f.endswith(".parquet")]
        if os.path.exists(PARQUET_DIR)
        else []
    )
    if existing_shards:
        num_shards = len(existing_shards)
        # Count total rows from existing shards
        total_rows = sum(
            pq.read_metadata(os.path.join(PARQUET_DIR, f)).num_rows
            for f in existing_shards
        )
        print(
            f"\n⏭️  Phase 1: Skipped — found {num_shards} existing Parquet shards ({total_rows:,} rows)"
        )
    else:
        total_rows, num_shards = convert_csv_to_parquet()

    # Phase 2: Compute provider stats
    provider_stats = compute_provider_stats()

    # Phase 3: Generate instruction-tuning data
    num_instructions = generate_instruction_tuning_data(provider_stats)

    # Phase 4: Create dataset card
    print("\n📝 Phase 4: Creating dataset card (README.md)...")
    create_dataset_card(total_rows, num_shards, num_instructions)

    # Summary
    print("\n" + "=" * 70)
    print("  ✅ PIPELINE COMPLETE!")
    print("=" * 70)
    print(
        f"""
  📊 Dataset Summary:
     • {total_rows:,} total rows → {num_shards} Parquet shards
     • {len(provider_stats):,} unique providers analyzed
     • {num_instructions:,} instruction-tuning examples generated
     • Train/Eval split: 90/10

  📁 Output Structure:
     hf_dataset/
     ├── README.md                           (Dataset card)
     ├── provider_statistics.json            (Top provider stats)
     ├── data/
     │   ├── shard-00000.parquet
     │   ├── shard-00001.parquet
     │   └── ...
     └── instruction_tuning/
         ├── fraud_detection_instructions.jsonl  (All examples)
         ├── train.jsonl                          (90% split)
         └── eval.jsonl                           (10% split)

  🚀 To upload to Hugging Face:
     huggingface-cli login
     huggingface-cli upload <your-username>/medicaid-fraud-detection hf_dataset/
"""
    )


if __name__ == "__main__":
    main()
