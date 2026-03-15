# 🔴 Medicaid Fraud Detection Platform

**AI-powered investigation dashboard for detecting Medicaid fraud, waste & abuse**

Built with **Gemini AI**, **Google Document AI**, **Google Search Grounding**, and real-time OSINT investigation — targeting **$11.3 billion** in fraudulent billing across **5,000+ healthcare providers**.

[![Live Dashboard](https://img.shields.io/badge/Dashboard-Live-brightgreen?style=for-the-badge)](https://frontend-rho-six-56.vercel.app)
[![API](https://img.shields.io/badge/API-Railway-blueviolet?style=for-the-badge)](https://medicaid-fraud-detection-production.up.railway.app/api/health)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Gemini](https://img.shields.io/badge/Gemini_2.5-Flash-4285F4?style=for-the-badge&logo=google)](https://ai.google.dev)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Vercel)                         │
│  index.html + app.js + style.css                            │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │  Dashboard   │ │ NJ Deep Dive │ │ Culprit Dossiers  │    │
│  │  Overview    │ │   Analysis   │ │  & Prosecution    │    │
│  └─────────────┘ └──────────────┘ └───────────────────┘    │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │  AI Chat     │ │ Provider     │ │  Risk Tier        │    │
│  │  (Gemini)    │ │ Data Browser │ │  Explorer         │    │
│  └─────────────┘ └──────────────┘ └───────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │ REST API
┌────────────────────────────┴────────────────────────────────┐
│                   BACKEND (Railway)                          │
│  server.js — Express.js + Node.js 20                        │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │  RAG Engine  │ │ Gemini AI    │ │  Document AI      │    │
│  │  Vector DB   │ │ Chat & Gen   │ │  Layout Parser    │    │
│  └─────────────┘ └──────────────┘ └───────────────────┘    │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │  Statistical │ │ Provider     │ │  Dossier &        │    │
│  │  Analysis    │ │ Enrichment   │ │  Report APIs      │    │
│  └─────────────┘ └──────────────┘ └───────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                             │
  ┌──────────────────────────┴──────────────────────────────┐
  │               DATA PIPELINE (Offline)                    │
  │  detect_fraud.py        — Statistical anomaly detection  │
  │  enrich_providers.js    — NPI + Google Search grounding  │
  │  parse_debarment.js     — NJ debarment PDF cross-match   │
  │  nj_deep_dive.js        — 6-phase NJ forensic analysis   │
  │  nj_fraud_hunter.js     — 7-phase culprit investigation  │
  │  prepare_hf_dataset.py  — Hugging Face dataset builder   │
  └─────────────────────────────────────────────────────────┘
```

---

## 📊 Key Findings

| Metric | Value |
|--------|-------|
| **Total Providers Analyzed** | 5,000 (from 227M+ claim rows) |
| **NJ Suspects Investigated** | 51 |
| **Post-Exclusion Federal Crimes** | 6 offenders |
| **Total Fraud Exposure** | **$11,338,611,587** |
| **Post-Exclusion Payments** | **$626,620** |
| **OSINT Intelligence Sources** | 598 |
| **Debarred Providers Cross-Matched** | 359 |

### 🚨 Most Egregious Offenders

| Suspect | NPI | Fraud Exposure | Category |
|---------|-----|---------------|----------|
| Care Finders Total Care LLC | 1104253558 | $708.6M | Critical Risk — Z-Score 36.1 |
| Allies, Inc. | 1104176676 | $362.4M | Critical Risk — Z-Score 16.0 |
| Bethany Basnett | 1487718938 | $267K post-exclusion | **Federal Crime** — Billing after debarment |
| Alexander Babayants | 1194779371 | $206K post-exclusion | **Federal Crime** — 9,774 claims after exclusion |
| Annamalai Ashokan | 1497857270 | $146K post-exclusion | **Federal Crime** — Billing since 2004 exclusion |

---

## 🚀 Live URLs

| Service | URL | Platform |
|---------|-----|----------|
| **Frontend Dashboard** | [frontend-rho-six-56.vercel.app](https://frontend-rho-six-56.vercel.app) | Vercel |
| **Backend API** | [medicaid-fraud-detection-production.up.railway.app](https://medicaid-fraud-detection-production.up.railway.app) | Railway |
| **Health Check** | [/api/health](https://medicaid-fraud-detection-production.up.railway.app/api/health) | Railway |

---

## ✨ Features

### 🎯 Interactive Dashboard
- **Global Overview** — KPI cards, payment distribution charts, Benford's Law analysis
- **Risk Tier Explorer** — Browse providers by risk level (Critical → Low) with z-score thresholds
- **Provider Data Browser** — Paginated, searchable table of all 5,000 providers
- **Geographic Analysis** — Geo-enriched provider data with city/state/zip from NPI Registry

### 🤖 AI-Powered Chat
- **RAG-powered Q&A** — Ask questions about the fraud data in natural language
- **Document AI + Vector Search** — PDF documents are parsed with Google Document AI Layout Parser, embedded, and searchable
- **Gemini 2.5 Flash** — Generates fraud analysis reports and answers investigative questions
- **Context-aware responses** — Chat includes full statistical context, risk tiers, and NJ deep dive data

### 🔍 NJ Deep Dive Investigation
- **32 high-risk NJ providers** forensically analyzed
- **NPI Registry lookups** — Real identity, address, specialties, and license status
- **Google Search Grounding** — OSINT investigation for each provider using Gemini + live web search
- **Gemini forensic analysis** — Deep AI analysis of billing patterns, peer comparisons, and red flags
- **6-phase investigation pipeline** — CSV streaming → NPI lookup → detailed extraction → forensic analysis → OSINT → AI report

### 🎯 Culprit Dossiers
- **51 prosecution-ready suspect dossiers** with full evidence packages
- **NPI deep lookups** — Phone, fax, address, authorized officials, parent organizations, DBAs, license dates
- **Google Search OSINT** — 598 intelligence sources from automated deep investigations
- **Business entity research** — Corporate structures, ownership chains, connections between suspects
- **Interactive suspect table** — Expandable rows with full dossier details, filterable by risk category
- **Risk categorization** — Post-Exclusion (Federal Crime), Debarment Match, Critical Risk, High Risk, Suspicious Pattern

### ⚖️ Prosecution Report
- **Attorney General-quality prosecution brief** — Addressed to the NJ AG with case file numbers
- **Specific charges & statutes** — 18 U.S.C. § 1347 (Healthcare Fraud), 31 U.S.C. § 3729 (False Claims Act)
- **Reporting contacts** — OIG Hotline, FBI Newark, NJ AG MFCU, NJ DMAHS, Whistleblower (Qui Tam) information
- **Financial impact analysis** — $33B+ in potential False Claims Act treble damages
- **Evidence preservation guidance** — How to secure and present evidence for federal prosecution

### 📋 Debarment Cross-Match Engine
- **359 debarred providers** parsed from the NJ AG's official debarment PDF using Gemini vision
- **Cross-matched against 227M+ Medicaid claims** to find post-exclusion billing
- **6 active federal crimes detected** — Providers billing Medicaid after being excluded from all federal programs
- **NPI resolution** — Fuzzy matching for providers listed without NPI numbers
- **Payment timeline analysis** — Exact dates, amounts, and claim counts for post-exclusion activity

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | Node.js 20+ / Express.js 5.x |
| **AI Model** | Google Gemini 2.5 Flash (`@google/genai`) |
| **Document AI** | Google Cloud Document AI Layout Parser (`@google-cloud/documentai`) |
| **Search** | Google Search Grounding (via Gemini tool) |
| **Vector Search** | Custom in-memory vector store with cosine similarity |
| **Embeddings** | Gemini `text-embedding-004` |
| **Statistical Analysis** | Python 3.x (Pandas, NumPy, SciPy) |
| **Frontend** | Vanilla HTML/CSS/JS (no framework) |
| **Deployment** | Railway (API) + Vercel (Frontend) |
| **Data Format** | JSON, CSV, Markdown, Parquet |

---

## 📂 Project Structure

```
fraud/
├── server.js                    # Express API server (1,336 lines)
├── rag_engine.js                # RAG: Document AI + Embeddings + Vector Search (580 lines)
├── detect_fraud.py              # 5-phase statistical fraud detection pipeline (1,164 lines)
├── enrich_providers.js          # NPI Registry + Google Search enrichment (285 lines)
├── parse_debarment.js           # NJ debarment PDF parser & cross-match engine (618 lines)
├── nj_deep_dive.js              # 6-phase NJ forensic investigation (785 lines)
├── nj_fraud_hunter.js           # 7-phase culprit dossier & prosecution generator (819 lines)
├── analyze_codes.py             # HCPCS procedure code analysis
├── prepare_hf_dataset.py        # Hugging Face dataset builder (673 lines)
├── prepare_docai.py             # Document AI preparation
├── generate_report.js           # Report generation utility
├── package.json                 # Node.js dependencies
├── nixpacks.toml                # Railway build configuration
├── .env                         # Environment variables (not committed)
├── service-account.json         # Google Cloud credentials (not committed)
│
├── frontend/
│   ├── vercel.json              # Vercel deployment config
│   └── public/
│       ├── index.html           # Dashboard UI (48KB)
│       ├── app.js               # Frontend logic (74KB, 1,521 lines)
│       └── style.css            # Styles & design system (45KB)
│
├── fraud_analysis/              # Generated analysis outputs
│   ├── statistical_analysis.json    # Z-scores, Benford's Law, temporal anomalies
│   ├── enriched_providers.json      # 200 providers with NPI + geo + grounding data
│   ├── nj_deep_dive.json           # 32 NJ providers — forensic analysis
│   ├── debarment_cross_match.json  # 359 debarred + 6 post-exclusion offenders
│   ├── nj_culprit_dossiers.json    # 51 suspect dossiers (1.2MB)
│   ├── gemini_fraud_report.md      # Initial Gemini fraud report
│   ├── nj_fraud_report.md          # NJ deep dive report (430KB)
│   ├── nj_fraud_report_full.md     # AG-quality prosecution brief
│   ├── nj_debarred_providers.csv   # Parsed debarment list
│   ├── nj_fraud_culprits.csv       # Culprit summary CSV
│   └── post_exclusion_payments.csv # Post-exclusion billing evidence
│
└── hf_dataset/                  # Hugging Face LLM training dataset
    └── (Parquet shards + instruction-tuning JSONL)
```

---

## 🔧 Installation & Setup

### Prerequisites

- Node.js 20+
- Python 3.10+ (for data pipeline scripts)
- Google Cloud API key (Gemini)
- Google Cloud service account (Document AI — optional)

### 1. Clone & Install

```bash
git clone <repo-url>
cd fraud
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your keys:
```

```env
GOOGLE_API_KEY=your-gemini-api-key
GEMINI_API_KEY=your-gemini-api-key
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_PROJECT_NUMBER=your-project-number
```

### 3. Run the Server

```bash
npm start
# → http://localhost:3000
```

---

## 📈 Data Pipeline

The analysis pipeline runs in sequential phases. Each script can be run independently once its prerequisites exist.

### Phase 1: Statistical Anomaly Detection

```bash
python detect_fraud.py
```

Processes 227M+ claim rows from `medicaid-provider-spending.csv`:
- Per-provider aggregation (total paid, claims, unique codes, beneficiaries)
- Z-score computation against peer group means
- Benford's Law analysis on leading digits
- Temporal anomaly detection (billing spikes/drops)
- Gemini AI fraud pattern analysis
- Document AI structured extraction
- Risk scoring per provider

**Output:** `fraud_analysis/statistical_analysis.json`

### Phase 2: Provider Enrichment

```bash
node enrich_providers.js
```

Enriches top 200 providers with real-world identity:
- NPI Registry API lookup (name, address, specialties)
- Google Search Grounding for public fraud information
- Geographic clustering analysis

**Output:** `fraud_analysis/enriched_providers.json`

### Phase 3: NJ Debarment Cross-Match

```bash
node parse_debarment.js
```

Parses the NJ Attorney General's debarment PDF and cross-references with Medicaid billing:
- Gemini vision extracts 359 debarred providers from the PDF
- NPI resolution for entries without NPI numbers
- Streams 227M+ claims to find post-exclusion billing
- Identifies providers billing Medicaid after federal debarment (federal crimes)

**Output:** `fraud_analysis/debarment_cross_match.json`, `fraud_analysis/post_exclusion_payments.csv`

### Phase 4: NJ Deep Dive

```bash
node nj_deep_dive.js
```

6-phase forensic investigation of NJ-specific providers:
1. Stream CSV → aggregate all provider stats
2. NPI Registry lookup → identify NJ providers
3. Re-stream CSV → extract detailed NJ billing data
4. Deep forensic analysis with Gemini (peer comparisons, z-scores, code analysis)
5. Google Search Grounding investigation per provider
6. Comprehensive NJ fraud report generation

**Output:** `fraud_analysis/nj_deep_dive.json`, `fraud_analysis/nj_fraud_report.md`

### Phase 5: Fraud Hunter (Culprit Dossiers)

```bash
node nj_fraud_hunter.js
```

7-phase prosecution-ready investigation:
1. Load all existing analysis data
2. NPI Registry deep lookup (phone, fax, officials, parent orgs, licenses)
3. Gemini + Google Search deep OSINT investigation per suspect
4. Business entity & corporate structure research
5. Generate prosecution-ready dossiers
6. Comprehensive reporting guide with federal/state contacts
7. AI-generated AG-quality prosecution brief

**Output:** `fraud_analysis/nj_culprit_dossiers.json`, `fraud_analysis/nj_fraud_report_full.md`, `fraud_analysis/nj_fraud_culprits.csv`

### Phase 6: LLM Training Dataset (Optional)

```bash
python prepare_hf_dataset.py
```

Creates a Hugging Face-compatible dataset:
- Parquet shards for efficient loading
- Instruction-tuning JSONL for fraud detection LLMs
- Risk assessment, anomaly explanation, and comparative analysis prompts

**Output:** `hf_dataset/`

---

## 🔌 API Reference

### Health & Stats

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System health check (providers loaded, RAG status, API configuration) |
| `GET /api/stats` | Dashboard overview (totals, distributions, top providers, Benford's Law) |

### Provider Data

| Endpoint | Description |
|----------|-------------|
| `GET /api/providers` | Paginated provider listing with search & filtering |
| `GET /api/providers/tiers` | Risk tier summary (Critical, High, Medium, Elevated, Low counts) |
| `GET /api/providers/tiers/:tier` | Browse providers by risk tier with pagination |
| `GET /api/providers/:npi` | Individual provider detail by NPI |
| `GET /api/providers/:npi/report` | AI-generated fraud investigation report for a single provider |

### AI Chat & RAG

| Endpoint | Description |
|----------|-------------|
| `POST /api/chat` | Gemini-powered chat with RAG context (body: `{ message }`) |
| `POST /api/rag/upload` | Upload PDF for Document AI processing & indexing |
| `GET /api/rag/status` | RAG engine status (chunks indexed, ready state) |
| `GET /api/rag/chunks` | Browse indexed document chunks |

### Fraud Analysis

| Endpoint | Description |
|----------|-------------|
| `GET /api/fraud-report` | Full Gemini-generated fraud analysis report |
| `GET /api/code-anomalies` | HCPCS procedure code anomaly analysis |
| `GET /api/enriched` | Enriched provider data (NPI + geo + grounding) |

### NJ Deep Dive

| Endpoint | Description |
|----------|-------------|
| `GET /api/nj/overview` | NJ investigation summary (provider counts, risk breakdown) |
| `GET /api/nj/providers` | All investigated NJ providers with analysis results |
| `GET /api/nj/provider/:npi` | Detailed NJ provider investigation |
| `GET /api/nj/report` | Full NJ deep dive report (Markdown) |
| `GET /api/nj/debarment` | Debarment cross-match results (359 debarred, 6 post-exclusion) |

### Culprit Dossiers

| Endpoint | Description |
|----------|-------------|
| `GET /api/nj/dossiers/overview` | Dossier metadata (total suspects, sources, exposure) |
| `GET /api/nj/dossiers/list` | All 51 suspect dossiers (summary view) |
| `GET /api/nj/dossiers/suspect/:npi` | Full dossier for a specific suspect |
| `GET /api/nj/dossiers/report` | Full prosecution report (Markdown) |
| `GET /api/nj/dossiers/reporting-guide` | Reporting contacts & evidence guidance |

---

## 🚢 Deployment

### Railway (Backend)

The backend deploys to Railway via `nixpacks.toml`:

```bash
# Link to existing project (or create new)
railway link

# Set environment variables
railway variables set GOOGLE_API_KEY=your-key
railway variables set GOOGLE_SERVICE_ACCOUNT_BASE64=$(base64 -i service-account.json)

# Deploy
railway up --detach
```

### Vercel (Frontend)

The frontend deploys as a static site from `frontend/`:

```bash
cd frontend
vercel --prod --yes
```

The frontend auto-detects the backend URL:
```javascript
const API = window.location.hostname.includes('vercel.app')
    ? 'https://medicaid-fraud-detection-production.up.railway.app'
    : '';
```

---

## 📋 Reporting Guide

If you identify fraud through this platform, here are the reporting contacts:

### 🏛️ Federal Reporting
- **OIG Hotline:** 1-800-HHS-TIPS
- **OIG Online:** [tips.oig.hhs.gov](https://tips.oig.hhs.gov)
- **FBI Newark:** (973) 792-3000
- **FBI Tips:** [tips.fbi.gov](https://tips.fbi.gov)

### 🗽 NJ State Reporting
- **NJ AG MFCU:** (609) 292-8740
- **Email:** medicaidfraud@njoag.gov
- **NJ DMAHS:** Provider Enrollment Division
- **Medical Examiners:** License Board

### 💰 Whistleblower (Qui Tam)
- **False Claims Act** 31 U.S.C. § 3729
- **Recovery:** 15–30% of recovered funds
- **Protection:** Anti-retaliation law
- **Penalties:** Treble damages + per-claim penalties

---

## 📜 Legal Disclaimer

This platform is a data analysis and investigation tool. All findings are based on statistical analysis of publicly available CMS Medicaid payment data and public record searches. No conclusions presented here constitute legal findings. All suspects are presumed innocent until proven guilty through proper legal proceedings. The data should be verified by qualified investigators before any enforcement action is taken.

---

## 📄 License

ISC

---

*Built with Gemini AI · Document AI · Google Search · Node.js*
