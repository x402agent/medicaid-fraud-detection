# Medicaid Fraud Detection — Complete Migration Guide

> **Purpose**: This document is an LLM-ready handoff for Codex or any AI agent to pick up exactly where we left off and continue finding all fraud within the 227M-row Medicaid provider spending dataset.
>
> **Last updated**: 2026-02-14T22:56:00-05:00
> **Branch**: `newnew` (only branch)
> **Repo**: `https://github.com/mawdbot/medicaid-fraud-detection.git`

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [The Raw Data (CSV)](#3-the-raw-data-csv)
4. [Environment Variables](#4-environment-variables)
5. [Backend Server (server.js)](#5-backend-server-serverjs)
6. [All API Endpoints](#6-all-api-endpoints)
7. [Statistical Analysis Pipeline (detect_fraud.py)](#7-statistical-analysis-pipeline-detect_fraudpy)
8. [Provider Enrichment Pipeline (enrich_providers.js)](#8-provider-enrichment-pipeline-enrich_providersjs)
9. [RAG Engine (rag_engine.js)](#9-rag-engine-rag_enginejs)
10. [Report Generator (generate_report.js)](#10-report-generator-generate_reportjs)
11. [Data Schemas — Every JSON Structure](#11-data-schemas--every-json-structure)
12. [Frontend Architecture](#12-frontend-architecture)
13. [Deployment](#13-deployment)
14. [What Has Been Done](#14-what-has-been-done)
15. [What Has NOT Been Done — Remaining Fraud to Find](#15-what-has-not-been-done--remaining-fraud-to-find)
16. [Next Steps — Exact Tasks for Codex](#16-next-steps--exact-tasks-for-codex)
17. [Known Bugs & Gotchas](#17-known-bugs--gotchas)
18. [Quick Start](#18-quick-start)

---

## 1. Project Overview

This is a full-stack Medicaid fraud detection system that analyzes **227,083,361 billing records** from **617,503 healthcare providers** sourced from CMS (Centers for Medicare & Medicaid Services). The data spans 2020-2024.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Data** | 11 GB CSV → Parquet shards → JSON analysis files |
| **Backend** | Node.js 20 + Express 5 |
| **AI** | Google Gemini 2.5 Flash (`@google/genai` v1.41) |
| **Document AI** | Google Cloud Document AI with Layout Parser |
| **RAG** | Custom vector store + Gemini embeddings (`text-embedding-004`) |
| **Search Grounding** | Gemini with `googleSearch` tool enabled |
| **Frontend** | Vanilla HTML/CSS/JS (no build step) |
| **Analytics** | Python 3 (pandas, numpy, scipy) for statistical pipeline |
| **Deployment** | Railway (backend), Vercel (frontend static) |

### What the system does today

1. **Statistical anomaly detection** on the full 227M-row CSV (Z-scores, Benford's Law, temporal analysis)
2. **Provider enrichment** via NPI Registry API (name, address, city, state, zip, taxonomy)
3. **Google Search grounding** for real-world fraud intelligence (OIG exclusions, DOJ actions, news)
4. **RAG pipeline** using Document AI Layout Parser + embeddings + vector search
5. **AI chat** with the fraud data via Gemini
6. **7-tab dashboard** with visualizations: Dashboard, AI Chat, Providers, Document AI, Data, Report, Geography

---

## 2. Repository Structure

```
/Users/8bit/fraud/
├── .env                            # All API keys (see §4)
├── .gitignore                      # Ignores CSV, vector store, etc.
├── package.json                    # Node deps: express, @google/genai, cors, dotenv, parquet-wasm
├── nixpacks.toml                   # Railway deploy config (Node 20)
│
├── medicaid-provider-spending.csv  # ⚠️ THE SOURCE DATA — 11 GB, 227M rows (NOT in git)
├── medicaid_sample.pdf             # 500-row PDF sample for Document AI
│
├── server.js                       # Express backend — 736 lines, 30+ API routes
├── rag_engine.js                   # RAG: Document AI + embeddings + vector search — 580 lines
├── enrich_providers.js             # NPI lookup + Google Search grounding — 285 lines
├── generate_report.js              # Gemini fraud report generation — 88 lines
│
├── detect_fraud.py                 # MAIN analysis pipeline — 1058 lines, 5 phases
├── prepare_hf_dataset.py           # CSV → Parquet + instruction tuning JSONL — 673 lines
├── prepare_docai.py                # CSV → PDF → Document AI request.json — 201 lines
│
├── fraud_analysis/                 # ✅ All analysis outputs
│   ├── statistical_analysis.json   # 92 KB — Z-scores, Benford, temporal anomalies
│   ├── enriched_providers.json     # 954 KB — 200 providers with NPI data + grounding
│   ├── gemini_fraud_report.md      # 29 KB — Gemini-generated investigation report
│   ├── suspicious_providers.pdf    # 8 KB — PDF of outlier providers
│   ├── docai_request.json          # 10 KB — Document AI API payload
│   ├── vector_store.json           # 3.6 MB — Embedded chunks for RAG (gitignored)
│   ├── docai_results/              # Document AI extraction results (gitignored)
│   └── provider_reports/           # Per-provider analysis reports (gitignored)
│
├── hf_dataset/                     # Hugging Face dataset (output of prepare_hf_dataset.py)
│   ├── README.md                   # Dataset card (386 lines)
│   ├── data/                       # 228 Parquet shards (gitignored)
│   └── instruction_tuning/         # train.jsonl + eval.jsonl (gitignored)
│
├── frontend/
│   ├── vercel.json                 # Vercel config — static deploy from public/
│   ├── .env.local                  # Vercel env (auto-generated)
│   └── public/
│       ├── index.html              # 596 lines — 7 tabs
│       ├── app.js                  # 971 lines — all frontend logic
│       └── style.css               # 2218 lines — dark theme with glassmorphism
│
├── service-account.json            # GCP service account (gitignored in practice)
├── request.json                    # Document AI request payload (gitignored)
└── monthly-spending*.json/png      # Misc data files (gitignored)
```

---

## 3. The Raw Data (CSV)

### File: `medicaid-provider-spending.csv`

| Property | Value |
|----------|-------|
| **Size** | 11,086,231,433 bytes (11 GB) |
| **Rows** | 227,083,361 |
| **Unique billing providers** | 617,503 |
| **Time span** | 2020-01 to 2024-12 (60 months) |

### CSV Schema (header row)

```csv
BILLING_PROVIDER_NPI_NUM,SERVICING_PROVIDER_NPI_NUM,HCPCS_CODE,CLAIM_FROM_MONTH,TOTAL_UNIQUE_BENEFICIARIES,TOTAL_CLAIMS,TOTAL_PAID
```

| Column | Type | Description |
|--------|------|-------------|
| `BILLING_PROVIDER_NPI_NUM` | string (10 digits) | Who submitted the bill |
| `SERVICING_PROVIDER_NPI_NUM` | string (10 digits) | Who performed the service |
| `HCPCS_CODE` | string | Procedure code (e.g., T1019, 99199, H2016) |
| `CLAIM_FROM_MONTH` | string (YYYY-MM) | Month of the claim |
| `TOTAL_UNIQUE_BENEFICIARIES` | int | Number of unique patients |
| `TOTAL_CLAIMS` | int | Number of claims filed |
| `TOTAL_PAID` | float | Dollar amount paid by Medicaid |

### Example rows

```csv
1376609297,1376609297,T1019,2024-07,39765,1205701,118887675.31
1376609297,1376609297,T1019,2024-08,39677,1152534,115561066.11
1417262056,1417262056,T1019,2024-07,26814,1014591,69685289.27
```

### Key observations

- **Self-referral rate**: 30.71% of all rows have `BILLING_PROVIDER_NPI_NUM == SERVICING_PROVIDER_NPI_NUM`
- The top provider (NPI 1417262056, PUBLIC PARTNERSHIPS LLC) has **$7.17 billion** in total payments
- HCPCS codes T1019, T1020 dominate the highest-paying providers — these are personal care / home health aide codes
- Only the **top 5,000 providers** (by total_paid) are currently loaded into the dashboard's `provider_statistics.json`

---

## 4. Environment Variables

### File: `.env` (root)

```env
# Google AI (primary key for all Gemini calls)
GOOGLE_API_KEY=YOUR_GOOGLE_API_KEY_HERE
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# Google Cloud Project
GOOGLE_PROJECT_ID=YOUR_PROJECT_ID
GOOGLE_PROJECT_NUMBER=YOUR_PROJECT_NUMBER

# Document AI
GOOGLE_DATA_ID=YOUR_DATA_ID
GOOGLE_PREDICTION_ENDPOINT=https://us-documentai.googleapis.com/v1/projects/YOUR_PROJECT_NUMBER/locations/us/processors/YOUR_PROCESSOR_ID:process
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
DOCAI_PROCESSOR_LOCATION=us
DOCAI_PROCESSOR_ID=YOUR_PROCESSOR_ID
DOCAI_CUSTOM_EXTRACTOR_ID=YOUR_EXTRACTOR_ID

# Vertex AI
VERTEX_API_KEY=YOUR_VERTEX_API_KEY
VERTEX_ACCOUNT=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com
GOOGLE_VERTEX_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com

# OAuth2 (for Document AI client library)
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET

# External
TAVILY_API_KEY=YOUR_TAVILY_KEY
FIRECRAWL_API_KEY=YOUR_FIRECRAWL_KEY
GOOGLE_MAP_ID=YOUR_MAP_ID
```

### How keys are used

- `GOOGLE_API_KEY` / `GEMINI_API_KEY` → Gemini 2.5 Flash (chat, analysis, search grounding, embeddings)
- `VERTEX_API_KEY` → Vertex AI enhanced analysis (fallback)
- `GOOGLE_APPLICATION_CREDENTIALS` → Document AI client library (OAuth2 via service account)
- `GOOGLE_PREDICTION_ENDPOINT` → Document AI processor endpoint
- The server reads credentials as: `const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;`

---

## 5. Backend Server (server.js)

**736 lines.** Express 5 backend that:

1. Loads analysis data from JSON/Markdown files at startup
2. Initializes the RAG engine with Document AI + embeddings
3. Serves the static frontend from `frontend/public/`
4. Provides 20+ API endpoints for dashboard, chat, analysis, RAG, and geographic data

### Data loaded at startup

```javascript
function loadData() {
    // 1. Provider statistics (top 5000 by total_paid)
    providerStats = JSON.parse(fs.readFileSync('fraud_analysis/statistical_analysis.json'));
    // Actually loads outlier_providers from statistical_analysis.json

    // 2. Statistical analysis (Z-scores, Benford, temporal)
    statisticalAnalysis = JSON.parse(fs.readFileSync('fraud_analysis/statistical_analysis.json'));

    // 3. Fraud report (Markdown)
    fraudReport = fs.readFileSync('fraud_analysis/gemini_fraud_report.md', 'utf-8');

    // 4. Enriched providers (NPI + geography + grounding)
    enrichedData = JSON.parse(fs.readFileSync('fraud_analysis/enriched_providers.json'));
}
```

### Note on providerStats

The `providerStats` variable holds the `outlier_providers` array from `statistical_analysis.json`. This is currently limited to **100 providers** (the top outliers by Z-score). The full `statistical_analysis.json` has metadata about all 617,503 providers but the individual records are only the top outliers.

---

## 6. All API Endpoints

### Core

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check — providers loaded, API keys configured, RAG status |
| `GET` | `/api/stats` | Dashboard KPIs — risk distribution, payment buckets, top providers, Benford's, HCPCS codes |
| `GET` | `/api/providers/search?q=&sort=&order=&limit=&offset=` | Search/paginate providers |
| `GET` | `/api/providers/:npi` | Single provider detail with global comparison |
| `POST` | `/api/chat` | AI chat with fraud data context (Gemini 2.5 Flash) |
| `POST` | `/api/analyze/:npi` | Deep fraud analysis for a specific NPI |
| `GET` | `/api/data?q=&page=&pageSize=&sort=&order=` | Paginated data explorer |
| `GET` | `/api/report` | Generated fraud report (Markdown) |
| `POST` | `/api/reload` | Reload all data files |

### Document AI / RAG

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/docai/process` | Process uploaded PDF with Gemini (base64 content) |
| `POST` | `/api/gemini/analyze-sample` | Analyze existing medicaid_sample.pdf |
| `GET` | `/api/rag/status` | RAG engine status (chunks indexed, documents, model) |
| `POST` | `/api/rag/query` | RAG query — vector search + Gemini augmented generation |
| `GET` | `/api/rag/chunks?page=&pageSize=` | Browse indexed chunks |
| `POST` | `/api/rag/process` | Index a new PDF (base64 upload) |
| `POST` | `/api/rag/reindex` | Force rebuild RAG index from statistical data |

### Geographic Fraud Analysis

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/geo/overview` | KPI summary — enriched count, states, hotspots, sources |
| `GET` | `/api/geo/states` | State-level fraud ranking (total_paid, providers) |
| `GET` | `/api/geo/hotspots` | Zip code + city fraud hotspot clusters |
| `GET` | `/api/geo/providers?state=&zip=&city=&risk=&limit=&offset=` | Enriched provider data with filters |
| `GET` | `/api/geo/investigation` | Google Search grounded investigation report |
| `POST` | `/api/geo/grounded-search` | Live grounded search with Google Search |

---

## 7. Statistical Analysis Pipeline (detect_fraud.py)

**1058 lines. Python 3.** The main analysis pipeline that processes the full 227M-row CSV.

### 5 Phases

| Phase | Function | Description |
|-------|----------|-------------|
| **1** | `compute_fraud_indicators()` | Reads CSV in 1M-row chunks via pandas. Computes per-provider stats: total_paid, total_claims, unique HCPCS codes, months_active, avg_payment_per_claim, Z-scores, Benford's Law analysis, temporal anomalies. Saves to `statistical_analysis.json`. |
| **2** | `create_provider_pdf()` + `process_with_document_ai()` | Creates PDF of top outlier providers, sends to Document AI for structured extraction. |
| **3** | `analyze_with_gemini()` | Uses Gemini to analyze statistical results + Document AI results together. Generates `gemini_fraud_report.md`. |
| **4** | `analyze_with_vertex()` | Optional Vertex AI enhanced analysis (fallback). |
| **5** | `generate_final_report()` | Compiles everything into a comprehensive final report. |

### CLI Arguments

```bash
python detect_fraud.py [--skip-stats] [--skip-docai] [--skip-vertex] [--providers-limit 50]
```

### Key Statistics Computed

- **Z-score**: Standard deviations from mean for each provider's total_paid
- **Benford's Law**: Chi-squared test on leading digit distribution of payments
- **Self-referral detection**: Flags where billing NPI == servicing NPI
- **Temporal anomalies**: Month-over-month spikes/drops per provider (type: SPIKE/DROP, severity: CRITICAL/HIGH/MEDIUM)
- **Claims per beneficiary per month**: Impossibly high ratios indicate phantom billing

### Risk Classification

| Risk Level | Z-Score Range |
|------------|---------------|
| CRITICAL | > 10 |
| HIGH | 5–10 |
| MEDIUM | 3–5 |
| LOW | < 3 |

### What `statistical_analysis.json` contains

```json
{
    "metadata": {
        "total_rows": 227083361,
        "total_providers": 617503,
        "analysis_date": "2026-02-14T15:35:23.574947",
        "self_referral_rows": 69731487,
        "self_referral_pct": 30.71
    },
    "global_statistics": {
        "mean_total_paid": 1770943.35,
        "median_total_paid": 47823.19,
        "std_total_paid": 22609456.22
    },
    "outlier_providers": [ /* 100 providers, see schema below */ ],
    "benford_analysis": { /* digit distribution + chi-squared */ },
    "temporal_anomalies": [ /* 200 anomaly records */ ],
    "high_risk_count": ...,
    "medium_risk_count": ...
}
```

---

## 8. Provider Enrichment Pipeline (enrich_providers.js)

**285 lines. Node.js.** Enriches the top providers from statistical analysis.

### What it does

1. **NPI Registry Lookup** — Calls `https://npiregistry.cms.hhs.gov/api/?number={NPI}&version=2.1` for each provider. Gets: name, address, city, state, zip, phone, taxonomy code, taxonomy description, enumeration date, sole proprietor status.
2. **Google Search Grounding** — Takes top 10 providers, calls Gemini with `googleSearch` tool to search for real fraud cases, OIG exclusions, DOJ actions, state enforcement, and news.
3. **Geographic Clustering** — Aggregates by state, zip, and city to find hotspot clusters.

### Run command

```bash
node enrich_providers.js
```

### Current state

- **200 providers** enriched (the top 200 by total_paid from statistical analysis)
- **200/200 resolved** via NPI Registry (0 not found)
- **49 sources** from Google Search grounding
- **78 search queries** executed
- **21,647 chars** in the grounded investigation report

### What `enriched_providers.json` contains

```json
{
    "metadata": {
        "generated_at": "2026-02-15T03:14:23.812Z",
        "total_enriched": 200,
        "resolved": 200,
        "not_found": 0
    },
    "providers": [ /* 200 enriched provider objects, schema below */ ],
    "geographic_analysis": {
        "stateRanking": [ /* states ranked by total_paid */ ],
        "zipHotspots": [ /* zip codes with 2+ providers */ ],
        "cityHotspots": [ /* cities with 2+ providers */ ]
    },
    "grounded_investigation": {
        "report": "...", /* 21K chars Markdown */
        "search_queries": [ /* 78 queries */ ],
        "sources": [ /* 49 web sources with URLs */ ]
    }
}
```

---

## 9. RAG Engine (rag_engine.js)

**580 lines. Node.js.** Custom RAG pipeline inspired by Google's BigQuery RAG notebook.

### Architecture

```
PDF Upload → Document AI Layout Parser → Text Chunks → Gemini Embeddings → Vector Store → Query
                                                                              ↓
                                                           Gemini Augmented Generation ← Context
```

### Key classes

- **`VectorStore`** — In-memory vector store with cosine similarity search, disk persistence to `fraud_analysis/vector_store.json`
- **`RAGEngine`** — Orchestrates Document AI processing, embedding generation, and RAG queries. Uses `text-embedding-004` model and `gemini-2.5-flash` for generation.

### How it initializes

1. Tries to load saved vector store from disk
2. If empty, processes `medicaid_sample.pdf` through Document AI
3. Falls back to indexing statistical analysis data as chunks
4. Each chunk gets an embedding via `text-embedding-004`

---

## 10. Report Generator (generate_report.js)

**88 lines. Node.js.** Simple script that feeds statistical analysis into Gemini to produce a comprehensive fraud report.

```bash
node generate_report.js
# Output: fraud_analysis/gemini_fraud_report.md
```

The report covers: Executive Summary, Methodology, Key Findings, Top 10 Highest-Risk Providers, HCPCS Code Analysis, Benford's Law, Temporal Anomalies, Self-Referral Analysis, Recommended Actions.

---

## 11. Data Schemas — Every JSON Structure

### 11a. Outlier Provider (in `statistical_analysis.json`)

```json
{
    "npi": "1417262056",
    "total_paid": 7177816544.46,
    "total_claims": "89773441",
    "z_score": 317.39,
    "unique_procedures": 25,
    "procedures": ["99199", "A0090", "A0160", "G2021", "H2016", "H2021", "S5125", "S5126", "S5130", "S5135"],
    "months_active": 84,
    "avg_payment_per_claim": 79.95,
    "claims_per_beneficiary_per_month": 1347.53,
    "self_billing": true
}
```

### 11b. Temporal Anomaly (in `statistical_analysis.json`)

```json
{
    "provider_npi": "1003000969",
    "month": "2019-01",
    "payment": 128025.84,
    "z_score": 7.11,
    "provider_mean": 3817.29,
    "anomaly_type": "SPIKE",
    "severity": "CRITICAL"
}
```

### 11c. Enriched Provider (in `enriched_providers.json`)

```json
{
    "npi": "1417262056",
    "provider_name": "PUBLIC PARTNERSHIPS LLC",
    "provider_type": "Organization",
    "address_line1": "17 PLAZA DR",
    "address_line2": "",
    "city": "LATHAM",
    "state": "NY",
    "zip": "12110",
    "full_zip": "121102157",
    "phone": "833-203-9084",
    "taxonomy_code": "251B00000X",
    "taxonomy_desc": "Case Management",
    "taxonomy_primary": false,
    "enumeration_date": "2010-08-06",
    "last_updated": "2026-01-23",
    "status": "A",
    "sole_proprietor": "",
    "total_paid": 7177816544.46,
    "total_claims": 89773441,
    "z_score": 317.39,
    "unique_procedures": 25,
    "months_active": 84,
    "avg_payment_per_claim": 79.95,
    "hcpcs_codes": ["99199", "A0090", "A0160", "G2021", "..."],
    "risk_level": "CRITICAL"
}
```

### 11d. State Ranking (in `enriched_providers.json` → `geographic_analysis`)

```json
{
    "state": "NY",
    "count": 65,
    "total_paid": 51775413441.02,
    "providers": ["1417262056", "1922467554", "..."]
}
```

### 11e. Zip Hotspot (in `enriched_providers.json` → `geographic_analysis`)

```json
{
    "zip": "02118",
    "count": 11,
    "total_paid": 7736277148.26,
    "state": "MA",
    "city": "BOSTON",
    "providers": ["1750504064", "1518096411", "..."]
}
```

### 11f. City Hotspot (in `enriched_providers.json` → `geographic_analysis`)

```json
{
    "city": "BROOKLYN, NY",
    "count": 26,
    "total_paid": 17633650118.16,
    "providers": ["1396051694", "1780816991", "..."]
}
```

---

## 12. Frontend Architecture

### File: `frontend/public/index.html` (596 lines)

**7 tabs**, each lazy-loaded:

| Tab | ID | Description |
|-----|----|-------------|
| Dashboard | `tab-dashboard` | KPI cards, risk/payment bar charts, top providers table, Benford's Law chart, HCPCS code chart |
| AI Chat | `tab-chat` | Gemini-powered chat with fraud data context |
| Providers | `tab-providers` | Card grid of providers, search, sort, detail modal with AI analysis |
| Document AI | `tab-docai` | PDF upload + Document AI processing, RAG pipeline visualization, chunk browser, grounded query |
| Data | `tab-data` | Paginated data browser table (sortable, searchable) |
| Report | `tab-report` | Full Gemini fraud report rendered as HTML |
| Geography | `tab-geography` | KPIs, state bar chart, zip hotspot cards, filterable provider table, grounded investigation, live search |

### File: `frontend/public/app.js` (971 lines)

Key functions:

| Function | Purpose |
|----------|---------|
| `init()` | Health check, load dashboard |
| `loadDashboard()` | Fetch `/api/stats`, render charts |
| `loadProviders()` | Provider card grid with search/sort |
| `viewProvider(npi)` | Modal with provider detail + AI analysis |
| `loadDataExplorer()` | Lazy-loaded data table |
| `loadReport()` | Lazy-loaded fraud report |
| `loadGeography()` | Lazy-loaded geography tab (KPIs, states, hotspots, providers, investigation) |
| `geoGroundedSearch(query)` | Live Google Search grounding |
| `fmt(n)` | Number formatting (`.toLocaleString()`) |
| `fmtMoney(n)` | Currency formatting (`$X,XXX`) |
| `fmtPct(n)` | Percentage formatting |
| `fmtCompact(n)` | Compact formatting (1.2B, 5.4M, 300K) |
| `formatMarkdown(text)` | Markdown → HTML (headers, bold, italic, lists, code) |

### API URL selection

```javascript
const API = window.location.hostname.includes('vercel.app')
    ? 'https://medicaid-fraud-detection-production.up.railway.app'
    : '';
```

### File: `frontend/public/style.css` (2218 lines)

Dark theme with CSS custom properties:
- `--bg-primary`, `--surface-1`, `--surface-2`, `--accent-red`, `--accent-green`, `--accent-blue`
- Glassmorphism cards with `backdrop-filter: blur()`
- Ambient background with animated orbs
- JetBrains Mono for code/numbers, Inter for body text

---

## 13. Deployment

### Backend (Railway)

- **URL**: `https://medicaid-fraud-detection-production.up.railway.app`
- **Config**: `nixpacks.toml` — Node 20, `npm ci`, `npm start`
- **Branch**: `newnew` (auto-deploys on push)
- **Environment variables**: Set in Railway dashboard (same as `.env`)
- **Note**: The CSV is NOT deployed to Railway. It uses pre-computed JSON analysis files that ARE in git.

### Frontend (Vercel)

- **URL**: `https://frontend-rho-six-56.vercel.app`
- **Config**: `frontend/vercel.json` — static deploy, `outputDirectory: "public"`, no build step
- **Deployed from**: `/Users/8bit/fraud/frontend` via `npx vercel --prod`

---

## 14. What Has Been Done

### ✅ Statistical Analysis (Phase 1)
- Full 227M-row CSV processed with pandas in 1M-row chunks
- Z-score outlier detection: **100 outlier providers** identified (Z > 3)
- **200 temporal anomalies** flagged (monthly billing spikes/drops)
- Benford's Law analysis computed on payment amounts
- Self-referral detection: 30.71% self-referral rate identified
- Results saved to `fraud_analysis/statistical_analysis.json`

### ✅ Document AI Processing (Phase 2)
- medicaid_sample.pdf (500 rows) processed through Document AI Layout Parser
- Chunks embedded and indexed in vector store

### ✅ Gemini Analysis (Phase 3)
- Comprehensive fraud report generated: `fraud_analysis/gemini_fraud_report.md`
- Covers top 35 outlier providers with specific NPI numbers and dollar amounts

### ✅ NPI Registry Enrichment
- **200 providers** resolved via NPI Registry API
- Full address, taxonomy, and organizational data captured
- All 200 resolved (0 failures)

### ✅ Google Search Grounding
- Top 10 providers searched for real-world fraud intelligence
- 49 unique sources, 78 search queries executed
- Investigation report generated with per-provider findings

### ✅ Geographic Analysis
- **32 states** with providers ranked by fraud exposure
- **19 zip code hotspots** (2+ providers in same zip)
- City-level clustering (Brooklyn, NY = 26 providers, $17.6B)

### ✅ Dashboard
- All 7 tabs functional with live data
- Real-time AI chat with fraud context
- Provider detail modal with AI analysis
- RAG-powered document Q&A

---

## 15. What Has NOT Been Done — Remaining Fraud to Find

### 🔴 CRITICAL GAP: Only analyzed 100 out of 617,503 providers

The current `statistical_analysis.json` only contains **100 outlier providers**. The `enriched_providers.json` only has **200 providers**. That means:

- **617,303 providers have NOT been individually analyzed**
- Many medium-risk providers (Z-score 3–10) are completely untouched
- Geographic analysis only covers the top 200 — there could be fraud hotspots in any of the remaining providers

### 🔴 HCPCS Code-Level Analysis Not Done

The CSV has **~8,000+ unique HCPCS codes**. We haven't:
- Computed per-code average payment amounts nationally
- Identified providers billing far above the per-code average (upcoding detection)
- Analyzed code combinations that indicate unbundling
- Flagged rare/unusual codes being billed disproportionately

### 🔴 Network/Ring Analysis Not Done

- No analysis of **networks of providers** billing to the same beneficiaries
- No detection of **billing rings** (groups of providers with unusually interconnected billing)
- No analysis of `BILLING_PROVIDER_NPI` vs `SERVICING_PROVIDER_NPI` relationship graphs

### 🔴 Temporal Deep Dive Not Done

- Only 200 temporal anomalies captured (out of potentially thousands)
- No month-over-month trending for ALL providers
- No detection of "ramp-up" patterns (new providers scaling billing rapidly)
- No seasonal fraud pattern analysis

### 🔴 Beneficiary Volume Analysis Not Done

- `TOTAL_UNIQUE_BENEFICIARIES` per claim month is in the CSV but underutilized
- No detection of impossibly high patient volumes per provider per month
- No cross-referencing of beneficiary counts vs procedure types

### 🔴 Per-Row Fraud Scoring

The existing analysis operates at the **provider level** (aggregated). We have NOT:
- Scored individual CSV rows for fraud risk
- Flagged specific monthly billing entries as suspicious
- Created a row-level fraud probability model

---

## 16. Next Steps — Exact Tasks for Codex

### Task 1: Scale Provider Analysis to ALL 617K Providers

**Priority: CRITICAL**

The `detect_fraud.py` script's `compute_fraud_indicators()` function already processes the full CSV but only saves the top 100 outliers. Modify it to:

1. Save ALL providers with Z-score > 1 (not just > 3) to a separate file
2. Create tiered output files:
   - `all_providers_critical.json` — Z > 10 (currently ~367 providers)
   - `all_providers_high.json` — Z 5–10 (currently ~696 providers)
   - `all_providers_medium.json` — Z 3–5 (currently ~1,062 providers)
   - `all_providers_elevated.json` — Z 1–3 (unknown count)
3. Update `server.js` to load ALL risk-tiered providers
4. Update the dashboard to show the full risk pyramid

### Task 2: HCPCS Code Anomaly Detection

**Priority: HIGH**

Create `analyze_codes.py`:

1. Compute national average `total_paid / total_claims` for each HCPCS code
2. For each provider × code combination, compute ratio to national average
3. Flag providers billing > 3x the national average for any code (upcoding indicator)
4. Detect code combinations that should be bundled but are billed separately (unbundling)
5. Save results to `fraud_analysis/code_anomalies.json`
6. Add API endpoint `GET /api/codes/anomalies`
7. Add "Codes" tab to frontend

### Task 3: Enrich ALL Critical + High Risk Providers

**Priority: HIGH**

Currently only 200 providers are enriched. Scale `enrich_providers.js`:

1. Enrich all CRITICAL (Z > 10) + HIGH (Z > 5) providers via NPI Registry
2. Run Google Search grounding in batches for the top 50 most suspicious
3. Update `enriched_providers.json` with expanded dataset
4. Update geographic analysis with full coverage

### Task 4: Provider Network Analysis

**Priority: HIGH**

Create `analyze_networks.py`:

1. Build a graph of BILLING_NPI → SERVICING_NPI relationships from the CSV
2. Identify closed billing loops (A bills for B, B bills for A)
3. Detect hub-and-spoke patterns (one billing entity, many servicing entities)
4. Flag providers that only bill for themselves (100% self-referral)
5. Save to `fraud_analysis/network_analysis.json`
6. Add visualization to frontend

### Task 5: Row-Level Fraud Scoring

**Priority: MEDIUM**

Create `score_rows.py`:

1. For each row in the CSV, compute a fraud probability score (0–100)
2. Factors: provider Z-score, self-referral, HCPCS code rarity, payment amount vs code average, monthly volume
3. Output a new CSV or Parquet with the fraud score appended
4. Flag rows with score > 80 as "HIGH RISK"
5. Create summary statistics by state, code, month

### Task 6: Beneficiary Volume Analysis

**Priority: MEDIUM**

Create `analyze_beneficiaries.py`:

1. Compute beneficiaries per provider per month
2. Flag impossibly high volumes (e.g., > 1000 unique patients per month for a solo practitioner)
3. Cross-reference with taxonomy — a single physician billing for 40,000 patients is a red flag
4. Detect "patient farming" patterns

### Task 7: Temporal Pattern Mining

**Priority: MEDIUM**

Enhance the temporal analysis in `detect_fraud.py`:

1. Compute month-over-month growth rate for ALL providers
2. Detect "ramp-up" patterns: new providers billing small amounts that rapidly increase
3. Detect "burst" patterns: dormant providers that suddenly have massive billing months
4. Seasonal analysis: are certain fraud patterns more common in Q4?
5. Detect providers that appeared after 2022 and are already in the top 1000

---

## 17. Known Bugs & Gotchas

### Active Issues

1. **`fmtCompact` defined locally** — The function `fmtCompact()` is defined at line 807 of `app.js` as a standalone function. It works fine now, but if the geography code is refactored, make sure this function remains accessible.

2. **`providerStats` only contains outlier_providers** — `server.js` loads `statistical_analysis.json` and uses the `outlier_providers` array (100 items) as the main provider list. This means the dashboard's "5,000 providers" count in the header is actually showing the outlier count, not 5,000. The `prepare_hf_dataset.py` generates a separate `provider_statistics.json` with the top 5,000 but it's in the `hf_dataset/` directory.

3. **CSV is NOT in git** — The 11 GB CSV (`medicaid-provider-spending.csv`) is gitignored. It must exist locally at `/Users/8bit/fraud/medicaid-provider-spending.csv` for any Python analysis scripts to run. All Node.js scripts work from the pre-computed JSON files.

4. **Document AI authentication** — The Document AI client library requires OAuth2 via `service-account.json`. The API key alone is NOT sufficient for Document AI calls (per Google's docs). The RAG engine handles this with a fallback to statistical data indexing.

5. **Railway deployment** — Railway does NOT have the CSV file. It only has the JSON analysis files, the server, and the frontend. Any new analysis must be run locally and the results committed to git.

6. **CSS lint warnings** — There are 3 CSS lint warnings about `-webkit-background-clip` needing a standard `background-clip` property (lines 171–173 of `style.css`). These are non-breaking.

### Environment-Specific

- **Python scripts** require: `pandas`, `numpy`, `scipy`, `reportlab`, `google-genai`
- **Node scripts** require: `npm install` (already done in `package.json`)
- Python is NOT a dependency for the running server — only for offline analysis
- The server runs on `process.env.PORT || 3000`

---

## 18. Quick Start

### Run the server locally

```bash
cd /Users/8bit/fraud
npm start
# → http://localhost:3000
```

### Run the fraud detection pipeline (requires CSV)

```bash
cd /Users/8bit/fraud
python detect_fraud.py --skip-docai --skip-vertex
```

### Enrich providers with NPI data + Google Search

```bash
cd /Users/8bit/fraud
node enrich_providers.js
```

### Generate a fresh fraud report

```bash
cd /Users/8bit/fraud
node generate_report.js
```

### Deploy

```bash
# Backend → Railway (auto-deploys from git push)
cd /Users/8bit/fraud
git add -A && git commit -m "..." && git push origin newnew

# Frontend → Vercel
cd /Users/8bit/fraud/frontend
npx vercel --prod
```

---

## Summary for Codex

**You have a 227M-row CSV with 617K healthcare providers. We've only deeply analyzed 200 of them. Your job is to find ALL the fraud — not just the top statistical outliers, but upcoding, unbundling, phantom billing, kickback networks, temporal bursts, and geographic rings. The data, APIs, and dashboard infrastructure are all in place. Scale the analysis.**
