const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createReadStream } = require('fs');
require('dotenv').config();

// ── Production: Decode service account from env var ──
// Railway/Vercel can't include key files, so we base64-encode
// the service account JSON and set it as GOOGLE_SERVICE_ACCOUNT_BASE64
if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 && !fs.existsSync(path.join(__dirname, 'service-account.json'))) {
    const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
    fs.writeFileSync(path.join(__dirname, 'service-account.json'), decoded);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'service-account.json');
    console.log('🔑 Decoded service account from GOOGLE_SERVICE_ACCOUNT_BASE64');
} else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(path.join(__dirname, 'service-account.json'))) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'service-account.json');
}

const { GoogleGenAI } = require('@google/genai');
const { RAGEngine } = require('./rag_engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend', 'public')));

// ── Google GenAI Setup ──
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const VERTEX_API_KEY = process.env.VERTEX_API_KEY;
const DOCAI_ENDPOINT = process.env.GOOGLE_PREDICTION_ENDPOINT ||
    'https://us-documentai.googleapis.com/v1/projects/691016932195/locations/us/processors/f9f3ab408f414eea:process';

const ai = new GoogleGenAI({ apiKey: API_KEY });

// ── RAG Engine (Document AI + Embeddings + Vector Search) ──
const rag = new RAGEngine(ai);

// ── Data Loading ──
let providerStats = [];
let statisticalAnalysis = null;
let fraudReport = null;
let enrichedData = null;
let codeAnomalies = null;
let njDeepDive = null;
let debarmentData = null;
let culpritDossiers = null;
let fullProsecutionReport = null;
let providerIndex = new Map();
let riskTierProviders = {
    critical: [],
    high: [],
    medium: [],
    elevated: [],
};
let riskTierMeta = {
    loaded_from_files: false,
    counts: { critical: 0, high: 0, medium: 0, elevated: 0, low: 0, total_flagged_z_gt_1: 0 },
};

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function inferRiskLevel(zScore) {
    const z = toNumber(zScore);
    if (z > 10) return 'CRITICAL';
    if (z > 5) return 'HIGH';
    if (z > 3) return 'MEDIUM';
    if (z > 1) return 'ELEVATED';
    return 'LOW';
}

function computeZScoreFromPaid(totalPaid, stats) {
    const mean = toNumber(stats?.global_statistics?.mean_total_paid, 0);
    const std = toNumber(stats?.global_statistics?.std_total_paid, 1);
    if (std <= 0) return 0;
    return (toNumber(totalPaid, 0) - mean) / std;
}

function normalizeProvider(raw, stats = statisticalAnalysis) {
    if (!raw) return null;
    const npi = String(raw.npi || raw.billing_provider_npi || '').trim();
    if (!npi) return null;

    const totalPaid = toNumber(raw.total_paid);
    const totalClaims = toNumber(raw.total_claims);
    const baseZ = raw.z_score != null ? toNumber(raw.z_score, null) : null;
    const z = baseZ == null ? computeZScoreFromPaid(totalPaid, stats) : baseZ;
    const riskLevel = (raw.risk_level || inferRiskLevel(z)).toUpperCase();
    const hcpcsCodes =
        raw.hcpcs_codes_list ||
        raw.procedures ||
        raw.hcpcs_codes ||
        [];

    return {
        ...raw,
        npi,
        billing_provider_npi: npi,
        total_paid: totalPaid,
        total_claims: totalClaims,
        unique_hcpcs_codes: toNumber(
            raw.unique_hcpcs_codes != null ? raw.unique_hcpcs_codes : raw.unique_procedures,
            Array.isArray(hcpcsCodes) ? hcpcsCodes.length : 0
        ),
        hcpcs_codes_list: Array.isArray(hcpcsCodes) ? hcpcsCodes : [],
        months_active: toNumber(raw.months_active),
        avg_payment_per_claim: toNumber(raw.avg_payment_per_claim),
        avg_beneficiaries_per_month: toNumber(raw.avg_beneficiaries_per_month, null),
        payment_coefficient_of_variation: toNumber(raw.payment_coefficient_of_variation, null),
        claims_per_beneficiary_per_month: toNumber(raw.claims_per_beneficiary_per_month, null),
        z_score: Math.round(z * 100) / 100,
        risk_level: riskLevel,
    };
}

function loadRiskTierFile(tierKey, filename) {
    const tierPath = path.join(__dirname, 'fraud_analysis', filename);
    if (!fs.existsSync(tierPath)) return [];

    try {
        const payload = JSON.parse(fs.readFileSync(tierPath, 'utf-8'));
        const rows = Array.isArray(payload.providers) ? payload.providers : [];
        return rows
            .map((p) => normalizeProvider(p))
            .filter(Boolean)
            .map((p) => ({ ...p, risk_level: p.risk_level === 'LOW' ? tierKey.toUpperCase() : p.risk_level }));
    } catch (err) {
        console.warn(`⚠️ Failed to load ${filename}: ${err.message}`);
        return [];
    }
}

function rebuildProviderIndex() {
    providerIndex = new Map(providerStats.map((p) => [p.npi, p]));
}

function recomputeRiskTierMetaFromProviderStats() {
    const counts = { critical: 0, high: 0, medium: 0, elevated: 0, low: 0, total_flagged_z_gt_1: 0 };
    for (const p of providerStats) {
        const level = inferRiskLevel(p.z_score).toLowerCase();
        if (counts[level] != null) counts[level]++;
    }
    counts.total_flagged_z_gt_1 = counts.critical + counts.high + counts.medium + counts.elevated;
    riskTierMeta = {
        loaded_from_files: false,
        counts,
    };
}

function loadData() {
    providerStats = [];
    statisticalAnalysis = null;
    fraudReport = null;
    enrichedData = null;
    codeAnomalies = null;
    njDeepDive = null;
    debarmentData = null;
    culpritDossiers = null;
    fullProsecutionReport = null;
    riskTierProviders = { critical: [], high: [], medium: [], elevated: [] };
    riskTierMeta = {
        loaded_from_files: false,
        counts: { critical: 0, high: 0, medium: 0, elevated: 0, low: 0, total_flagged_z_gt_1: 0 },
    };

    // Load fraud analysis if available
    const fraudStatsPath = path.join(__dirname, 'fraud_analysis', 'statistical_analysis.json');
    if (fs.existsSync(fraudStatsPath)) {
        statisticalAnalysis = JSON.parse(fs.readFileSync(fraudStatsPath, 'utf-8'));
        console.log(`✅ Loaded statistical analysis`);
    }

    // Load provider statistics (top providers) and normalize schema
    const statsPath = path.join(__dirname, 'hf_dataset', 'provider_statistics.json');
    if (fs.existsSync(statsPath)) {
        const rawProviders = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        providerStats = rawProviders.map((p) => normalizeProvider(p)).filter(Boolean);
        console.log(`✅ Loaded ${providerStats.length} provider statistics`);
    } else if (Array.isArray(statisticalAnalysis?.outlier_providers)) {
        providerStats = statisticalAnalysis.outlier_providers
            .map((p) => normalizeProvider(p))
            .filter(Boolean);
        console.log(`✅ Loaded ${providerStats.length} providers from outlier fallback`);
    }

    // Load full risk-tier files generated by detect_fraud.py
    const critical = loadRiskTierFile('critical', 'all_providers_critical.json');
    const high = loadRiskTierFile('high', 'all_providers_high.json');
    const medium = loadRiskTierFile('medium', 'all_providers_medium.json');
    const elevated = loadRiskTierFile('elevated', 'all_providers_elevated.json');
    const tiersLoaded = critical.length || high.length || medium.length || elevated.length;

    if (tiersLoaded) {
        riskTierProviders = { critical, high, medium, elevated };
        riskTierMeta = {
            loaded_from_files: true,
            counts: {
                critical: critical.length,
                high: high.length,
                medium: medium.length,
                elevated: elevated.length,
                low: Math.max(
                    toNumber(statisticalAnalysis?.metadata?.total_providers, providerStats.length) -
                    (critical.length + high.length + medium.length + elevated.length),
                    0
                ),
                total_flagged_z_gt_1: critical.length + high.length + medium.length + elevated.length,
            },
        };

        // Merge tier providers into the searchable provider index.
        const merged = new Map(providerStats.map((p) => [p.npi, p]));
        for (const tier of Object.values(riskTierProviders)) {
            for (const p of tier) {
                const existing = merged.get(p.npi);
                merged.set(p.npi, existing ? { ...existing, ...p } : p);
            }
        }
        providerStats = [...merged.values()];
        console.log(`✅ Loaded risk-tier providers: critical=${critical.length}, high=${high.length}, medium=${medium.length}, elevated=${elevated.length}`);
    } else {
        recomputeRiskTierMetaFromProviderStats();
        console.log('⚠️ Risk-tier files not found; using provider-level fallback distribution');
    }

    providerStats.sort((a, b) => (b.total_paid || 0) - (a.total_paid || 0));
    rebuildProviderIndex();

    // Load Gemini fraud report if available
    const reportPath = path.join(__dirname, 'fraud_analysis', 'gemini_fraud_report.md');
    if (fs.existsSync(reportPath)) {
        fraudReport = fs.readFileSync(reportPath, 'utf-8');
        console.log(`✅ Loaded Gemini fraud report`);
    }

    // Load enriched provider data (NPI registry + geographic + grounding)
    const enrichedPath = path.join(__dirname, 'fraud_analysis', 'enriched_providers.json');
    if (fs.existsSync(enrichedPath)) {
        enrichedData = JSON.parse(fs.readFileSync(enrichedPath, 'utf-8'));
        console.log(`✅ Loaded ${enrichedData.providers?.length || 0} enriched providers (geo + grounding)`);
    }

    // Load code anomaly analysis (if generated)
    const codePath = path.join(__dirname, 'fraud_analysis', 'code_anomalies.json');
    if (fs.existsSync(codePath)) {
        codeAnomalies = JSON.parse(fs.readFileSync(codePath, 'utf-8'));
        console.log(`✅ Loaded code anomalies (${codeAnomalies?.anomalies?.length || 0})`);
    }

    // Load NJ Deep Dive
    const njPath = path.join(__dirname, 'fraud_analysis', 'nj_deep_dive.json');
    if (fs.existsSync(njPath)) {
        njDeepDive = JSON.parse(fs.readFileSync(njPath, 'utf-8'));
        console.log(`✅ Loaded NJ Deep Dive (${njDeepDive.providers?.length || 0} providers, ${njDeepDive.investigations?.length || 0} investigated)`);
    }

    // Load Debarment Cross-Match
    const debPath = path.join(__dirname, 'fraud_analysis', 'debarment_cross_match.json');
    if (fs.existsSync(debPath)) {
        debarmentData = JSON.parse(fs.readFileSync(debPath, 'utf-8'));
        console.log(`✅ Loaded Debarment Cross-Match (${debarmentData.metadata?.total_debarred || 0} debarred, ${debarmentData.metadata?.post_exclusion_providers || 0} post-exclusion offenders)`);
    }

    // Load Culprit Dossiers
    const dossierPath = path.join(__dirname, 'fraud_analysis', 'nj_culprit_dossiers.json');
    if (fs.existsSync(dossierPath)) {
        culpritDossiers = JSON.parse(fs.readFileSync(dossierPath, 'utf-8'));
        console.log(`✅ Loaded Culprit Dossiers (${culpritDossiers.dossiers?.length || 0} suspects, ${culpritDossiers.all_sources?.length || 0} sources)`);
    }

    // Load Full Prosecution Report
    const fullReportPath = path.join(__dirname, 'fraud_analysis', 'nj_fraud_report_full.md');
    if (fs.existsSync(fullReportPath)) {
        fullProsecutionReport = fs.readFileSync(fullReportPath, 'utf-8');
        console.log(`✅ Loaded Full Prosecution Report (${fullProsecutionReport.length} chars)`);
    }
}

loadData();

// ── Chat Context Builder ──
function buildChatContext() {
    const top20 = providerStats.slice(0, 20);
    const stats = statisticalAnalysis || {};

    return `You are a Medicaid Fraud Detection AI Analyst. You have access to a dataset of 227 million+ Medicaid provider spending records covering 617,500+ unique healthcare providers.

DATASET OVERVIEW:
- Total claims: ${stats?.metadata?.total_rows?.toLocaleString() || '227,083,361'}
- Unique providers: ${stats?.metadata?.total_providers?.toLocaleString() || '617,503'}
- Self-referral rate: ${stats?.metadata?.self_referral_pct || 'calculating'}%
- Mean provider payment: $${stats?.global_statistics?.mean_total_paid?.toLocaleString() || 'calculating'}
- Median provider payment: $${stats?.global_statistics?.median_total_paid?.toLocaleString() || 'calculating'}

TOP 20 HIGHEST-PAYING PROVIDERS (potential fraud suspects):
${JSON.stringify(top20.map(p => ({
        npi: p.npi,
        total_paid: p.total_paid,
        claims: p.total_claims,
        procedures: p.unique_hcpcs_codes,
        codes: p.hcpcs_codes_list?.slice(0, 5),
        months: p.months_active,
        avg_per_claim: p.avg_payment_per_claim,
        avg_benes_month: p.avg_beneficiaries_per_month,
        payment_cv: p.payment_coefficient_of_variation,
        z_score: p.z_score,
        risk_level: p.risk_level,
    })), null, 2)}

BENFORD'S LAW ANALYSIS:
${JSON.stringify(stats?.benford_analysis || {}, null, 2)}

TEMPORAL ANOMALIES (sample):
${JSON.stringify(stats?.temporal_anomalies?.slice(0, 10) || [], null, 2)}

When answering questions:
- Reference specific NPI numbers, dollar amounts, and statistics
- Explain fraud indicators in plain language
- Suggest specific next steps for investigation
- Flag HCPCS codes associated with known fraud patterns (T1019, T1015, etc.)
- Be direct and actionable in your responses
- If asked about a specific provider, look them up in the data`;
}

// ── API Routes ──

// Health check
app.get('/api/health', (req, res) => {
    const ragStatus = rag.getStatus();
    res.json({
        status: 'ok',
        providers_loaded: providerStats.length,
        fraud_analysis_available: !!statisticalAnalysis,
        fraud_report_available: !!fraudReport,
        risk_tier_files_loaded: riskTierMeta.loaded_from_files,
        risk_tier_counts: riskTierMeta.counts,
        code_anomalies_loaded: !!codeAnomalies,
        api_key_configured: !!API_KEY,
        vertex_configured: !!VERTEX_API_KEY,
        rag_engine: ragStatus,
    });
});

// Get dashboard stats
app.get('/api/stats', (req, res) => {
    const stats = statisticalAnalysis || {};
    const topProviders = providerStats.slice(0, 100);
    const totalProvidersUniverse = toNumber(stats?.metadata?.total_providers, providerStats.length);

    let riskDist = {
        critical: toNumber(riskTierMeta?.counts?.critical),
        high: toNumber(riskTierMeta?.counts?.high),
        medium: toNumber(riskTierMeta?.counts?.medium),
        elevated: toNumber(riskTierMeta?.counts?.elevated),
        low: toNumber(riskTierMeta?.counts?.low),
    };

    // Fallback if tier counts are unavailable or stale.
    const hasAnyCount = Object.values(riskDist).some((v) => v > 0);
    if (!hasAnyCount) {
        riskDist = { critical: 0, high: 0, medium: 0, elevated: 0, low: 0 };
        for (const p of providerStats) {
            const level = inferRiskLevel(p.z_score).toLowerCase();
            if (riskDist[level] != null) riskDist[level]++;
        }
    }

    if (!riskTierMeta.loaded_from_files) {
        riskDist.low = Math.max(totalProvidersUniverse - (riskDist.critical + riskDist.high + riskDist.medium + riskDist.elevated), 0);
    }

    // Payment distribution for charts
    const paymentBuckets = { '<1K': 0, '1K-10K': 0, '10K-100K': 0, '100K-1M': 0, '1M-10M': 0, '10M-100M': 0, '>100M': 0 };
    for (const p of providerStats) {
        const paid = p.total_paid || 0;
        if (paid < 1000) paymentBuckets['<1K']++;
        else if (paid < 10000) paymentBuckets['1K-10K']++;
        else if (paid < 100000) paymentBuckets['10K-100K']++;
        else if (paid < 1000000) paymentBuckets['100K-1M']++;
        else if (paid < 10000000) paymentBuckets['1M-10M']++;
        else if (paid < 100000000) paymentBuckets['10M-100M']++;
        else paymentBuckets['>100M']++;
    }

    // Top HCPCS codes
    const hcpcsCounts = {};
    for (const p of providerStats.slice(0, 1000)) {
        for (const code of (p.hcpcs_codes_list || [])) {
            hcpcsCounts[code] = (hcpcsCounts[code] || 0) + 1;
        }
    }
    const topCodes = Object.entries(hcpcsCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([code, count]) => ({ code, count }));

    res.json({
        overview: {
            total_rows: stats?.metadata?.total_rows || 227083361,
            total_providers: totalProvidersUniverse || providerStats.length,
            self_referral_pct: stats?.metadata?.self_referral_pct || null,
            mean_paid: stats?.global_statistics?.mean_total_paid || null,
            median_paid: stats?.global_statistics?.median_total_paid || null,
            std_paid: stats?.global_statistics?.std_total_paid || null,
        },
        risk_distribution: riskDist,
        risk_pyramid: {
            thresholds: {
                critical: 'z > 10',
                high: '5 < z <= 10',
                medium: '3 < z <= 5',
                elevated: '1 < z <= 3',
                low: 'z <= 1',
            },
            counts: riskDist,
            total_flagged_z_gt_1: riskDist.critical + riskDist.high + riskDist.medium + riskDist.elevated,
            loaded_from_files: riskTierMeta.loaded_from_files,
        },
        payment_distribution: paymentBuckets,
        top_hcpcs_codes: topCodes,
        benford: stats?.benford_analysis || null,
        temporal_anomalies_count: stats?.temporal_anomalies?.length || 0,
        top_providers: topProviders.slice(0, 25).map(p => ({
            npi: p.npi,
            total_paid: p.total_paid,
            total_claims: p.total_claims,
            procedures: p.unique_hcpcs_codes,
            months: p.months_active,
            avg_per_claim: p.avg_payment_per_claim,
            avg_benes: p.avg_beneficiaries_per_month,
            cv: p.payment_coefficient_of_variation,
            z_score: p.z_score,
            risk_level: p.risk_level,
        })),
    });
});

// Risk-tier summary and browsing
app.get('/api/providers/tiers', (req, res) => {
    const counts = {
        critical: toNumber(riskTierMeta?.counts?.critical),
        high: toNumber(riskTierMeta?.counts?.high),
        medium: toNumber(riskTierMeta?.counts?.medium),
        elevated: toNumber(riskTierMeta?.counts?.elevated),
        low: toNumber(riskTierMeta?.counts?.low),
        total_flagged_z_gt_1: toNumber(riskTierMeta?.counts?.total_flagged_z_gt_1),
    };
    if (!riskTierMeta.loaded_from_files) {
        const totalProvidersUniverse = toNumber(statisticalAnalysis?.metadata?.total_providers, providerStats.length);
        counts.low = Math.max(totalProvidersUniverse - (counts.critical + counts.high + counts.medium + counts.elevated), 0);
    }
    res.json({
        loaded_from_files: riskTierMeta.loaded_from_files,
        counts,
        thresholds: {
            critical: 'z > 10',
            high: '5 < z <= 10',
            medium: '3 < z <= 5',
            elevated: '1 < z <= 3',
            low: 'z <= 1',
        },
    });
});

app.get('/api/providers/tiers/:tier', (req, res) => {
    const tier = String(req.params.tier || '').toLowerCase();
    const { limit = 100, offset = 0 } = req.query;
    const validTiers = ['critical', 'high', 'medium', 'elevated', 'low'];
    if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: `Invalid tier: ${tier}. Use one of ${validTiers.join(', ')}` });
    }

    let providers = [];
    if (tier === 'low' && !riskTierMeta.loaded_from_files) {
        const estimatedLow = Math.max(
            toNumber(statisticalAnalysis?.metadata?.total_providers, providerStats.length) -
            (toNumber(riskTierMeta?.counts?.critical) +
                toNumber(riskTierMeta?.counts?.high) +
                toNumber(riskTierMeta?.counts?.medium) +
                toNumber(riskTierMeta?.counts?.elevated)),
            0
        );
        return res.json({
            tier,
            total: estimatedLow,
            limit: Number(limit),
            offset: Number(offset),
            providers: [],
            partial: true,
            message: 'Low-tier provider records require full tier files from detect_fraud.py. Returned count is estimated from metadata.',
        });
    }

    if (riskTierMeta.loaded_from_files && tier !== 'low') {
        providers = riskTierProviders[tier] || [];
    } else {
        providers = providerStats.filter((p) => inferRiskLevel(p.z_score).toLowerCase() === tier);
    }

    const total = providers.length;
    const rows = providers.slice(Number(offset), Number(offset) + Number(limit));
    res.json({
        tier,
        total,
        limit: Number(limit),
        offset: Number(offset),
        providers: rows,
    });
});

// Search providers
app.get('/api/providers/search', (req, res) => {
    const { q, sort = 'total_paid', order = 'desc', risk, limit = 50, offset = 0 } = req.query;
    let results = [...providerStats];

    if (q) {
        const query = q.toLowerCase();
        results = results.filter(p =>
            p.npi?.toLowerCase().includes(query) ||
            p.hcpcs_codes_list?.some(c => c.toLowerCase().includes(query))
        );
    }

    if (risk) {
        const target = String(risk).toUpperCase();
        results = results.filter((p) => p.risk_level === target);
    }

    // Sort
    results.sort((a, b) => {
        const aVal = a[sort];
        const bVal = b[sort];
        if (typeof aVal === 'string' && typeof bVal === 'string') {
            return order === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        }
        const aNum = toNumber(aVal);
        const bNum = toNumber(bVal);
        return order === 'desc' ? bNum - aNum : aNum - bNum;
    });

    const total = results.length;
    results = results.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ total, results });
});

// Get single provider detail
app.get('/api/providers/:npi', (req, res) => {
    const provider = providerIndex.get(req.params.npi);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const stats = statisticalAnalysis || {};
    const globalMean = toNumber(stats?.global_statistics?.mean_total_paid, 1);
    const z = provider.z_score != null ? provider.z_score : computeZScoreFromPaid(provider.total_paid, stats);

    res.json({
        ...provider,
        z_score: Math.round(toNumber(z) * 100) / 100,
        risk_level: provider.risk_level || inferRiskLevel(z),
        global_mean: globalMean,
        global_median: stats?.global_statistics?.median_total_paid,
        ratio_to_mean: globalMean > 0 ? Math.round((provider.total_paid / globalMean) * 10) / 10 : null,
    });
});

// Chat with the data
app.post('/api/chat', async (req, res) => {
    const { message, history = [] } = req.body;

    if (!message) return res.status(400).json({ error: 'Message required' });

    try {
        const systemContext = buildChatContext();

        // Build conversation history
        const contents = [];
        for (const msg of history.slice(-10)) {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemContext,
                temperature: 0.4,
                maxOutputTokens: 4000,
            }
        });

        res.json({
            response: response.text,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Quick fraud analysis for a specific provider
app.post('/api/analyze/:npi', async (req, res) => {
    const provider = providerIndex.get(req.params.npi);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Analyze this Medicaid provider for potential fraud. Be specific and actionable.

Provider Data:
${JSON.stringify(provider, null, 2)}

Provide:
1. Risk Level (CRITICAL/HIGH/MEDIUM/LOW)
2. Top 3 red flags
3. Likely fraud type
4. Recommended investigation steps
5. Estimated fraud probability (%)`,
            config: {
                systemInstruction: 'You are a Medicaid fraud investigator. Be direct, specific, and reference actual data points.',
                temperature: 0.2,
                maxOutputTokens: 2000,
            }
        });

        res.json({ analysis: response.text, provider: provider.npi });
    } catch (error) {
        console.error('Analysis error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Document AI processing (legacy endpoint)
app.post('/api/docai/process', async (req, res) => {
    const { content, mimeType = 'application/pdf' } = req.body;

    if (!content) return res.status(400).json({ error: 'base64 content required' });

    try {
        const docaiResponse = await fetch(`${DOCAI_ENDPOINT}?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                skipHumanReview: true,
                rawDocument: { mimeType, content }
            })
        });

        const result = await docaiResponse.json();
        res.json(result);
    } catch (error) {
        console.error('DocAI error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Gemini Native PDF Vision Processing
app.post('/api/gemini/pdf', async (req, res) => {
    const { content, mimeType = 'application/pdf', prompt, mode = 'analyze' } = req.body;

    if (!content) return res.status(400).json({ error: 'base64 PDF content required' });

    const modePrompts = {
        analyze: `You are a Medicaid fraud investigator. Analyze this document for potential fraud indicators.

Look for:
1. Unusual billing patterns or amounts
2. Suspicious provider information
3. HCPCS code anomalies
4. Self-referral patterns (billing NPI = servicing NPI)
5. Statistical outliers in payment amounts
6. Temporal irregularities

Provide a structured fraud analysis report with:
- Executive Summary
- Key Findings (with specific data points)
- Risk Level (CRITICAL/HIGH/MEDIUM/LOW)
- Red Flags Identified
- Recommended Investigation Steps`,

        extract: `Extract ALL structured data from this document into a JSON format. Include:
- Provider information (NPIs, names, addresses)
- Billing details (HCPCS codes, amounts, dates)
- Patient/beneficiary counts
- Any tables, charts, or financial figures

Return as valid JSON with clear field names.`,

        summarize: `Provide a comprehensive summary of this document including:
- Document type and purpose
- Key data points and statistics
- Important findings or conclusions
- Any anomalies or notable patterns`,

        transcribe: `Transcribe this document's content to well-formatted HTML, preserving:
- All text content
- Table structures
- Layout and formatting
- Headers and sections
- Any charts or diagrams described textually`,

        custom: prompt || 'Analyze this document.'
    };

    const selectedPrompt = modePrompts[mode] || modePrompts.custom;
    const finalPrompt = mode === 'custom' ? prompt : selectedPrompt;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: content
                    }
                },
                { text: finalPrompt }
            ],
            config: {
                temperature: 0.2,
                maxOutputTokens: 8000,
            }
        });

        res.json({
            result: response.text,
            mode,
            model: 'gemini-2.5-flash',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Gemini PDF error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Gemini PDF analysis of the existing medicaid_sample.pdf
app.post('/api/gemini/analyze-sample', async (req, res) => {
    const { prompt, mode = 'analyze' } = req.body;
    const samplePath = path.join(__dirname, 'medicaid_sample.pdf');

    if (!fs.existsSync(samplePath)) {
        return res.status(404).json({ error: 'medicaid_sample.pdf not found. Run prepare_docai.py first.' });
    }

    try {
        const pdfBytes = fs.readFileSync(samplePath);
        const base64Content = pdfBytes.toString('base64');

        const analysisPrompt = prompt || `You are a Medicaid fraud investigator analyzing a sample of 500 Medicaid provider spending records.

Analyze this PDF table for:
1. Providers with unusually high payment amounts
2. Suspicious billing patterns (same NPI billing and servicing)
3. HCPCS codes that appear disproportionately
4. Any statistical anomalies in the data

Provide:
- Top 5 most suspicious entries with specific data
- Overall fraud risk assessment
- Recommended next steps`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: base64Content
                    }
                },
                { text: analysisPrompt }
            ],
            config: {
                temperature: 0.2,
                maxOutputTokens: 8000,
            }
        });

        res.json({
            result: response.text,
            source: 'medicaid_sample.pdf',
            model: 'gemini-2.5-flash',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Sample analysis error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get fraud report
app.get('/api/report', (req, res) => {
    if (fraudReport) {
        res.json({ report: fraudReport });
    } else {
        res.json({ report: null, message: 'Fraud report not yet generated. Run detect_fraud.py first.' });
    }
});

// HCPCS code anomaly analysis
app.get('/api/codes/anomalies', (req, res) => {
    if (!codeAnomalies) {
        return res.json({
            metadata: null,
            anomalies: [],
            unbundling_signals: [],
            message: 'No code anomaly file found. Run: python analyze_codes.py',
        });
    }

    const { q, minRatio, minClaims, page = 1, pageSize = 50, sort = 'ratio_to_national_avg', order = 'desc' } = req.query;
    let rows = [...(codeAnomalies.anomalies || [])];

    if (q) {
        const query = String(q).toLowerCase();
        rows = rows.filter((r) =>
            String(r.provider_npi || '').toLowerCase().includes(query) ||
            String(r.hcpcs_code || '').toLowerCase().includes(query)
        );
    }

    if (minRatio != null) {
        const threshold = Number(minRatio);
        if (Number.isFinite(threshold)) {
            rows = rows.filter((r) => toNumber(r.ratio_to_national_avg) >= threshold);
        }
    }

    if (minClaims != null) {
        const threshold = Number(minClaims);
        if (Number.isFinite(threshold)) {
            rows = rows.filter((r) => toNumber(r.total_claims) >= threshold);
        }
    }

    rows.sort((a, b) => {
        const aVal = a[sort];
        const bVal = b[sort];
        if (typeof aVal === 'string' && typeof bVal === 'string') {
            return order === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        }
        const aNum = toNumber(aVal);
        const bNum = toNumber(bVal);
        return order === 'desc' ? bNum - aNum : aNum - bNum;
    });

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / Number(pageSize)));
    const start = (Number(page) - 1) * Number(pageSize);
    const anomalies = rows.slice(start, start + Number(pageSize));

    res.json({
        metadata: codeAnomalies.metadata || null,
        total,
        page: Number(page),
        totalPages,
        pageSize: Number(pageSize),
        anomalies,
        unbundling_signals: codeAnomalies.unbundling_signals || [],
        national_code_stats: codeAnomalies.national_code_stats || [],
    });
});

// ── RAG Pipeline Endpoints (inspired by BigQuery RAG notebook) ──

// RAG Status
app.get('/api/rag/status', (req, res) => {
    res.json(rag.getStatus());
});

// RAG Query — Vector search + Gemini augmented generation
app.post('/api/rag/query', async (req, res) => {
    const { question, topK = 8 } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    try {
        const result = await rag.query(question, topK);
        res.json(result);
    } catch (error) {
        console.error('RAG query error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Browse indexed chunks
app.get('/api/rag/chunks', (req, res) => {
    const { page = 1, pageSize = 20 } = req.query;
    res.json(rag.getChunks(Number(page), Number(pageSize)));
});

// Process and index a new PDF
app.post('/api/rag/process', async (req, res) => {
    const { content, filename = 'uploaded.pdf' } = req.body;
    if (!content) return res.status(400).json({ error: 'base64 content required' });

    try {
        const chunks = await rag.processBase64PDF(content, filename);
        res.json({
            status: 'indexed',
            chunks_created: chunks.length,
            total_chunks: rag.store.size,
            documents: rag.getStatus().documents,
        });
    } catch (error) {
        console.error('RAG process error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Re-index from statistical data (force rebuild)
app.post('/api/rag/reindex', async (req, res) => {
    try {
        rag.store.documents = [];
        await rag.indexStatisticalData();
        res.json({
            status: 'reindexed',
            chunks: rag.store.size,
            documents: rag.getStatus().documents,
        });
    } catch (error) {
        console.error('Reindex error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Paginated data browser for Data Explorer
app.get('/api/data', (req, res) => {
    const { q, page = 1, pageSize = 50, sort = 'total_paid', order = 'desc' } = req.query;
    let data = [...providerStats];

    if (q) {
        const query = q.toLowerCase();
        data = data.filter(p =>
            p.npi?.toLowerCase().includes(query) ||
            p.hcpcs_codes_list?.some(c => c.toLowerCase().includes(query)) ||
            String(p.total_paid).includes(query) ||
            String(p.risk_level || '').toLowerCase().includes(query)
        );
    }

    data.sort((a, b) => {
        const aVal = a[sort];
        const bVal = b[sort];
        if (typeof aVal === 'string' && typeof bVal === 'string') {
            return order === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
        }
        const aNum = toNumber(aVal);
        const bNum = toNumber(bVal);
        return order === 'desc' ? bNum - aNum : aNum - bNum;
    });

    const total = data.length;
    const totalPages = Math.ceil(total / Number(pageSize));
    const start = (Number(page) - 1) * Number(pageSize);
    const rows = data.slice(start, start + Number(pageSize));

    res.json({
        total,
        page: Number(page),
        totalPages,
        pageSize: Number(pageSize),
        rows: rows.map(p => ({
            npi: p.npi,
            total_paid: p.total_paid,
            total_claims: p.total_claims,
            procedures: p.unique_hcpcs_codes,
            months: p.months_active,
            avg_per_claim: p.avg_payment_per_claim,
            avg_benes: p.avg_beneficiaries_per_month,
            cv: p.payment_coefficient_of_variation,
            top_codes: (p.hcpcs_codes_list || []).slice(0, 5).join(', '),
            z_score: p.z_score,
            risk_level: p.risk_level,
        })),
        source: 'https://storage.googleapis.com/frauds/medicaid-provider-spending.csv',
    });
});

// Reload data
app.post('/api/reload', (req, res) => {
    loadData();
    res.json({ status: 'reloaded', providers: providerStats.length });
});

// ═══════════════════════════════════════════════════════════════
// GEOGRAPHIC FRAUD ANALYSIS API
// ═══════════════════════════════════════════════════════════════

// Geographic overview
app.get('/api/geo/overview', (req, res) => {
    if (!enrichedData) return res.json({ error: 'Enriched data not yet generated. Run: node enrich_providers.js' });
    const geo = enrichedData.geographic_analysis || {};
    const providers = enrichedData.providers || [];
    const withLocation = providers.filter(p => p.state && !p.error);

    res.json({
        total_enriched: providers.length,
        with_location: withLocation.length,
        states_covered: geo.stateRanking?.length || 0,
        zip_hotspots: geo.zipHotspots?.length || 0,
        city_hotspots: geo.cityHotspots?.length || 0,
        grounding_queries: enrichedData.grounded_investigation?.search_queries?.length || 0,
        grounding_sources: enrichedData.grounded_investigation?.sources?.length || 0,
        generated_at: enrichedData.metadata?.generated_at,
    });
});

// State ranking (fraud by state)
app.get('/api/geo/states', (req, res) => {
    if (!enrichedData) return res.json({ states: [] });
    res.json({ states: enrichedData.geographic_analysis?.stateRanking || [] });
});

// Zip & city hotspots
app.get('/api/geo/hotspots', (req, res) => {
    if (!enrichedData) return res.json({ zips: [], cities: [] });
    const geo = enrichedData.geographic_analysis || {};
    res.json({
        zips: geo.zipHotspots || [],
        cities: geo.cityHotspots || [],
    });
});

// Enriched providers (with location data)
app.get('/api/geo/providers', (req, res) => {
    if (!enrichedData) return res.json({ providers: [] });
    const { state, zip, city, risk, limit = 100, offset = 0 } = req.query;
    let providers = enrichedData.providers || [];

    if (state) providers = providers.filter(p => p.state === state.toUpperCase());
    if (zip) providers = providers.filter(p => p.zip === zip);
    if (city) providers = providers.filter(p => p.city?.toLowerCase().includes(city.toLowerCase()));
    if (risk) providers = providers.filter(p => p.risk_level === risk.toUpperCase());

    const total = providers.length;
    providers = providers.slice(Number(offset), Number(offset) + Number(limit));

    res.json({ total, providers });
});

// Grounded investigation report
app.get('/api/geo/investigation', (req, res) => {
    if (!enrichedData) return res.json({ report: '', sources: [], queries: [] });
    const inv = enrichedData.grounded_investigation || {};
    res.json({
        report: inv.report || '',
        sources: inv.sources || [],
        queries: inv.search_queries || [],
    });
});

// Live grounded search (on-demand)
app.post('/api/geo/grounded-search', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    try {
        const providers = enrichedData?.providers?.slice(0, 10) || [];
        const context = providers.map(p =>
            `NPI ${p.npi}: ${p.provider_name}, ${p.city} ${p.state} ${p.zip}, $${(p.total_paid || 0).toLocaleString()}, Risk: ${p.risk_level}`
        ).join('\n');

        const prompt = `You are a Medicaid fraud investigator. The user has a question about these suspicious healthcare providers:\n\n${context}\n\nUser question: ${query}\n\nUse Google Search to find real-world information about these providers, including news articles, OIG exclusions, DOJ actions, and state enforcement actions. Provide specific, sourced answers.`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.3,
                maxOutputTokens: 8000,
            },
        });

        const grounding = response.candidates?.[0]?.groundingMetadata || {};

        res.json({
            answer: response.text || '',
            sources: (grounding.groundingSupports || []).map(s => ({
                text: s.segment?.text || '',
                urls: (s.groundingChunkIndices || []).map(i =>
                    grounding.groundingChunks?.[i]?.web?.uri || ''
                ).filter(Boolean),
            })),
            searchQueries: grounding.webSearchQueries || [],
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Grounded search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// NEW JERSEY DEEP DIVE API
// ═══════════════════════════════════════════════════════════════

app.get('/api/nj/overview', (req, res) => {
    if (!njDeepDive) return res.json({ error: 'NJ Deep Dive not yet generated. Run: node nj_deep_dive.js' });
    const meta = njDeepDive.metadata || {};
    const providers = njDeepDive.providers || [];
    const cities = {}; const zips = {};
    for (const p of providers) {
        if (p.city) cities[p.city] = (cities[p.city] || 0) + 1;
        if (p.zip) zips[p.zip] = (zips[p.zip] || 0) + 1;
    }
    res.json({
        total_providers: meta.nj_providers_found || providers.length,
        total_paid: meta.nj_total_paid || 0,
        critical_count: meta.nj_critical_count || 0,
        high_count: meta.nj_high_count || 0,
        medium_count: meta.nj_medium_count || 0,
        low_count: meta.nj_low_count || 0,
        investigated: njDeepDive.investigations?.length || 0,
        sources_found: njDeepDive.all_sources?.length || 0,
        generated_at: meta.generated_at,
        top_cities: Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([city, count]) => ({ city, count })),
        top_zips: Object.entries(zips).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([zip, count]) => ({ zip, count })),
    });
});

app.get('/api/nj/providers', (req, res) => {
    if (!njDeepDive) return res.json({ providers: [], total: 0 });
    let providers = njDeepDive.providers || [];
    const { city, zip, risk, sort = 'risk_score', order = 'desc', limit = 50, offset = 0 } = req.query;
    if (city) providers = providers.filter(p => p.city?.toLowerCase().includes(city.toLowerCase()));
    if (zip) providers = providers.filter(p => p.zip === zip);
    if (risk) providers = providers.filter(p => p.risk_level === risk.toUpperCase());
    providers = [...providers].sort((a, b) => order === 'desc' ? (b[sort] || 0) - (a[sort] || 0) : (a[sort] || 0) - (b[sort] || 0));
    const total = providers.length;
    providers = providers.slice(Number(offset), Number(offset) + Number(limit));
    res.json({ total, providers });
});

app.get('/api/nj/provider/:npi', (req, res) => {
    if (!njDeepDive) return res.status(404).json({ error: 'NJ data not loaded' });
    const provider = njDeepDive.providers?.find(p => p.npi === req.params.npi);
    if (!provider) return res.status(404).json({ error: 'NJ provider not found' });
    const investigation = njDeepDive.investigations?.find(i => i.npi === req.params.npi);
    res.json({ provider, investigation: investigation || null });
});

app.get('/api/nj/investigations', (req, res) => {
    if (!njDeepDive) return res.json({ investigations: [] });
    res.json({ investigations: njDeepDive.investigations || [] });
});

app.get('/api/nj/report', (req, res) => {
    if (!njDeepDive) return res.json({ report: null });
    res.json({ report: njDeepDive.report || '' });
});

app.post('/api/nj/grounded-search', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });
    try {
        const njProviders = njDeepDive?.providers?.slice(0, 15) || [];
        const context = njProviders.map(p =>
            `NPI ${p.npi}: ${p.provider_name}, ${p.city} NJ ${p.zip}, $${(p.total_paid || 0).toLocaleString()}, Risk: ${p.risk_level} (Score ${p.risk_score})`
        ).join('\n');
        const prompt = `You are a NJ Medicaid fraud investigator. These are suspicious NJ providers:\n${context}\n\nUser question: ${query}\nSearch for NJ-specific enforcement, AG actions, OIG exclusions, settlements. Provide sourced answers.`;
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', contents: prompt,
            config: { tools: [{ googleSearch: {} }], temperature: 0.3, maxOutputTokens: 8000 },
        });
        const grounding = response.candidates?.[0]?.groundingMetadata || {};
        res.json({
            answer: response.text || '',
            sources: (grounding.groundingSupports || []).map(s => ({
                text: s.segment?.text || '',
                urls: (s.groundingChunkIndices || []).map(i => grounding.groundingChunks?.[i]?.web?.uri || '').filter(Boolean),
            })),
            searchQueries: grounding.webSearchQueries || [],
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// DEBARMENT CROSS-MATCH API
// ═══════════════════════════════════════════════════════════════

app.get('/api/nj/debarment/overview', (req, res) => {
    if (!debarmentData) return res.json({ error: 'Debarment data not yet generated. Run: node parse_debarment.js' });
    const meta = debarmentData.metadata || {};
    const offenders = debarmentData.post_exclusion_offenders || [];
    const allResults = debarmentData.cross_match_results || [];
    res.json({
        total_debarred: meta.total_debarred || 0,
        debarred_with_npi: meta.debarred_with_npi || 0,
        matched_in_claims: meta.matched_in_claims || 0,
        post_exclusion_providers: meta.post_exclusion_providers || 0,
        post_exclusion_total_paid: meta.post_exclusion_total_paid || 0,
        post_exclusion_total_claims: meta.post_exclusion_total_claims || 0,
        severity_counts: {
            CRITICAL: allResults.filter(r => r.severity === 'CRITICAL').length,
            HIGH: allResults.filter(r => r.severity === 'HIGH').length,
            MEDIUM: allResults.filter(r => r.severity === 'MEDIUM').length,
            LOW: allResults.filter(r => r.severity === 'LOW').length,
            INFO: allResults.filter(r => r.severity === 'INFO').length,
        },
        top_offenders: offenders.slice(0, 20).map(o => ({
            npi: o.npi,
            name: o.provider_name,
            exclusion_date: o.exclusion_date,
            action_type: o.action_type,
            reason: o.reason,
            post_exclusion_paid: o.post_exclusion_paid,
            post_exclusion_claims: o.post_exclusion_claims,
            total_paid: o.total_paid,
            severity: o.severity,
            flags: o.flags,
            billing_spikes: o.billing_spikes,
            top_codes: o.top_codes?.slice(0, 5),
        })),
        generated_at: meta.generated_at,
    });
});

app.get('/api/nj/debarment/providers', (req, res) => {
    if (!debarmentData) return res.json({ providers: [] });
    const debarred = debarmentData.debarred_providers || [];
    const { limit = 100, offset = 0 } = req.query;
    res.json({
        total: debarred.length,
        providers: debarred.slice(Number(offset), Number(offset) + Number(limit)),
    });
});

app.get('/api/nj/debarment/cross-match', (req, res) => {
    if (!debarmentData) return res.json({ results: [] });
    let results = debarmentData.cross_match_results || [];
    const { severity, sort = 'post_exclusion_paid', limit = 50, offset = 0 } = req.query;
    if (severity) results = results.filter(r => r.severity === severity.toUpperCase());
    results = [...results].sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
    const total = results.length;
    results = results.slice(Number(offset), Number(offset) + Number(limit));
    res.json({ total, results });
});

app.get('/api/nj/debarment/provider/:npi', (req, res) => {
    if (!debarmentData) return res.status(404).json({ error: 'No debarment data' });
    const result = debarmentData.cross_match_results?.find(r => r.npi === req.params.npi);
    const debarred = debarmentData.debarred_providers?.find(p => p.npi === req.params.npi);
    if (!result && !debarred) return res.status(404).json({ error: 'Provider not found' });
    res.json({ cross_match: result || null, debarment_record: debarred || null });
});

// ── Culprit Dossier Endpoints ──
app.get('/api/nj/dossiers/overview', (req, res) => {
    if (!culpritDossiers) return res.json({ error: 'Culprit dossiers not generated. Run: node nj_fraud_hunter.js' });
    res.json({
        metadata: culpritDossiers.metadata,
        has_report: !!fullProsecutionReport,
        report_length: fullProsecutionReport?.length || 0,
    });
});

app.get('/api/nj/dossiers/list', (req, res) => {
    if (!culpritDossiers) return res.json({ error: 'No dossiers' });
    const dossiers = (culpritDossiers.dossiers || []).map(d => ({
        npi: d.npi,
        name: d.name,
        entity_type: d.entity_type,
        city: d.addresses?.[0]?.city || '',
        state: d.addresses?.[0]?.state || 'NJ',
        zip: d.addresses?.[0]?.zip || '',
        phone: d.addresses?.[0]?.phone || '',
        authorized_official: d.authorized_official,
        total_medicaid_paid: d.total_medicaid_paid,
        post_exclusion_paid: d.post_exclusion_paid,
        post_exclusion_claims: d.post_exclusion_claims,
        exclusion_date: d.exclusion_date,
        risk_level: d.risk_level,
        risk_score: d.risk_score,
        fraud_category: d.fraud_category,
        red_flags: d.red_flags,
        severity: d.severity,
        sources_count: d.investigation_sources?.length || 0,
    }));
    res.json({ dossiers });
});

app.get('/api/nj/dossiers/suspect/:npi', (req, res) => {
    if (!culpritDossiers) return res.json({ error: 'No dossiers' });
    const d = culpritDossiers.dossiers?.find(d => d.npi === req.params.npi);
    if (!d) return res.status(404).json({ error: 'Suspect not found' });
    res.json(d);
});

app.get('/api/nj/dossiers/report', (req, res) => {
    if (!fullProsecutionReport) return res.json({ error: 'Report not generated' });
    res.json({ report: fullProsecutionReport });
});

app.get('/api/nj/dossiers/reporting-guide', (req, res) => {
    if (!culpritDossiers) return res.json({ error: 'No dossiers' });
    res.json({
        reporting_guide: culpritDossiers.reporting_guide || '',
        all_sources: culpritDossiers.all_sources || [],
        metadata: culpritDossiers.metadata,
    });
});

// ═══════════════════════════════════════════════════════════════
// COMMUNITY HUB APIs — Public-friendly access to fraud data
// ═══════════════════════════════════════════════════════════════

// Community Summary — plain-language overview of all findings
app.get('/api/community/summary', (req, res) => {
    const totalProviders = providerStats.length;
    const totalPaid = providerStats.reduce((s, p) => s + (p.total_paid || 0), 0);
    const criticalCount = providerStats.filter(p => inferRiskLevel(p.z_score) === 'CRITICAL').length;
    const highCount = providerStats.filter(p => inferRiskLevel(p.z_score) === 'HIGH').length;

    const dossierMeta = culpritDossiers?.metadata || {};
    const debarmentMeta = debarmentData?.metadata || {};

    // States with most flagged providers
    const stateCounts = {};
    const allProviders = [...(enrichedData?.providers || []), ...(culpritDossiers?.dossiers || []).map(d => ({
        state: d.addresses?.[0]?.state,
        city: d.addresses?.[0]?.city,
        zip: d.addresses?.[0]?.zip,
    }))];
    for (const p of enrichedData?.providers || []) {
        if (p.state) stateCounts[p.state] = (stateCounts[p.state] || 0) + 1;
    }
    const topStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    res.json({
        headline: `Our AI analyzed ${totalProviders.toLocaleString()} healthcare providers billing over $${(totalPaid / 1e9).toFixed(1)} billion — and found alarming patterns of fraud.`,
        key_findings: [
            {
                icon: '🚨',
                title: 'Major Fraud Detected',
                detail: `${criticalCount + highCount} providers flagged with critical or high-risk billing anomalies`,
                severity: 'critical'
            },
            {
                icon: '⚖️',
                title: 'Federal Crimes Uncovered',
                detail: `${debarmentMeta.post_exclusion_providers || 6} healthcare providers were caught billing Medicaid AFTER being banned from federal programs`,
                severity: 'critical'
            },
            {
                icon: '🔍',
                title: 'Deep Investigations',
                detail: `${dossierMeta.total_suspects || 51} suspects investigated with ${dossierMeta.total_sources || 598} intelligence sources`,
                severity: 'high'
            },
            {
                icon: '💰',
                title: 'Your Tax Dollars at Risk',
                detail: `Over $${((dossierMeta.total_fraud_exposure || 11338611587) / 1e9).toFixed(1)} billion in suspicious Medicaid payments identified`,
                severity: 'critical'
            },
            {
                icon: '📋',
                title: 'Debarment Cross-Match',
                detail: `${debarmentMeta.total_debarred || 359} providers on the NJ debarment list were cross-checked against ${statisticalAnalysis?.metadata?.total_rows ? (statisticalAnalysis.metadata.total_rows / 1e6).toFixed(0) + 'M+' : '227M+'} billing records`,
                severity: 'medium'
            },
        ],
        stats: {
            total_providers: totalProviders,
            total_billing: totalPaid,
            critical_risk: criticalCount,
            high_risk: highCount,
            suspects: dossierMeta.total_suspects || 51,
            federal_crimes: debarmentMeta.post_exclusion_providers || 6,
            intelligence_sources: dossierMeta.total_sources || 598,
            fraud_exposure: dossierMeta.total_fraud_exposure || 11338611587,
            debarred_providers: debarmentMeta.total_debarred || 359,
        },
        top_states: topStates.map(([state, count]) => ({ state, count })),
        how_it_works: [
            { step: 1, title: 'Data Collection', desc: 'We analyzed 227 million+ Medicaid billing records from CMS public data' },
            { step: 2, title: 'Statistical Analysis', desc: 'Our AI calculated z-scores, ran Benford\'s Law analysis, and detected temporal anomalies' },
            { step: 3, title: 'Identity Verification', desc: 'Each flagged provider was verified through the NPI National Registry' },
            { step: 4, title: 'OSINT Investigation', desc: 'Google Search was used to find public records, lawsuits, and news about suspects' },
            { step: 5, title: 'Prosecution Report', desc: 'Findings compiled into an Attorney General-quality prosecution brief' },
        ]
    });
});

// Geo Search — find providers near a zip code, city, or state
app.get('/api/community/search', (req, res) => {
    const { zip, city, state, q } = req.query;
    const query = (q || '').toLowerCase().trim();

    let results = [];

    // Merge enriched providers + dossiers for searchable geo data
    const searchable = [];

    for (const p of enrichedData?.providers || []) {
        searchable.push({
            npi: p.npi,
            name: p.name || `Provider ${p.npi}`,
            city: p.city || '',
            state: p.state || '',
            zip: p.zip || '',
            total_paid: p.total_paid || 0,
            z_score: p.z_score || 0,
            risk_level: p.risk_level || inferRiskLevel(p.z_score),
            source: 'enriched',
        });
    }

    for (const d of culpritDossiers?.dossiers || []) {
        const addr = d.addresses?.[0] || {};
        searchable.push({
            npi: d.npi,
            name: d.name || `Suspect ${d.npi}`,
            city: addr.city || '',
            state: addr.state || '',
            zip: addr.zip || '',
            total_paid: d.total_medicaid_paid || 0,
            post_exclusion_paid: d.post_exclusion_paid || 0,
            z_score: d.risk_score || 0,
            risk_level: d.risk_level || d.fraud_category || 'UNKNOWN',
            fraud_category: d.fraud_category || '',
            source: 'dossier',
        });
    }

    if (zip) {
        const zipClean = zip.replace(/\D/g, '').substring(0, 5);
        results = searchable.filter(p => p.zip.startsWith(zipClean));
    } else if (city) {
        const cityClean = city.toLowerCase().trim();
        results = searchable.filter(p => p.city.toLowerCase().includes(cityClean));
    } else if (state) {
        const stateClean = state.toUpperCase().trim();
        results = searchable.filter(p => p.state === stateClean);
    } else if (query) {
        results = searchable.filter(p =>
            p.name.toLowerCase().includes(query) ||
            p.city.toLowerCase().includes(query) ||
            p.state.toLowerCase().includes(query) ||
            p.npi.includes(query) ||
            p.zip.startsWith(query)
        );
    } else {
        results = searchable;
    }

    results.sort((a, b) => (b.total_paid || 0) - (a.total_paid || 0));

    const total = results.length;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    res.json({
        total,
        limit,
        offset,
        query: { zip, city, state, q },
        results: results.slice(offset, offset + limit),
        // Geographic context
        geo_summary: {
            states: [...new Set(results.map(r => r.state).filter(Boolean))],
            cities: [...new Set(results.map(r => r.city).filter(Boolean))].slice(0, 20),
            total_exposure: results.reduce((s, r) => s + (r.total_paid || 0), 0),
            risk_breakdown: {
                critical: results.filter(r => String(r.risk_level).toUpperCase() === 'CRITICAL' || String(r.fraud_category).includes('POST-EXCLUSION')).length,
                high: results.filter(r => String(r.risk_level).toUpperCase() === 'HIGH').length,
                medium: results.filter(r => String(r.risk_level).toUpperCase() === 'MEDIUM').length,
                low: results.filter(r => !['CRITICAL', 'HIGH', 'MEDIUM'].includes(String(r.risk_level).toUpperCase())).length,
            },
        },
    });
});

// Community Chat — public-friendly Gemini chat with simplified context
app.post('/api/community/chat', async (req, res) => {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    try {
        const dossierMeta = culpritDossiers?.metadata || {};
        const debarmentMeta = debarmentData?.metadata || {};

        const systemPrompt = `You are a friendly, helpful AI assistant that explains Medicaid fraud findings to regular people.
You have access to a comprehensive fraud investigation that analyzed 227 million+ Medicaid billing records.

KEY FACTS:
- ${providerStats.length} healthcare providers analyzed
- ${dossierMeta.total_suspects || 51} suspects identified through deep investigation
- ${debarmentMeta.post_exclusion_providers || 6} providers caught billing AFTER being banned (federal crimes)
- $${((dossierMeta.total_fraud_exposure || 11338611587) / 1e9).toFixed(1)} billion in suspicious payments
- ${debarmentMeta.total_debarred || 359} providers on the NJ debarment list matched against billing data
- ${dossierMeta.total_sources || 598} intelligence sources gathered through automated investigation

TOP OFFENDERS:
${(culpritDossiers?.dossiers || []).slice(0, 10).map(d => {
            const addr = d.addresses?.[0] || {};
            return `- ${d.name} (NPI: ${d.npi}) — ${addr.city || '?'}, ${addr.state || '?'} — $${((d.total_medicaid_paid || 0) / 1e6).toFixed(1)}M billed${d.post_exclusion_paid ? `, $${d.post_exclusion_paid.toLocaleString()} AFTER exclusion` : ''} — Category: ${d.fraud_category || d.risk_level || 'Unknown'}`;
        }).join('\n')}

GEOGRAPHIC DATA:
${(enrichedData?.geographic_analysis?.stateRanking || []).slice(0, 8).map(s => `- ${s.state}: ${s.count} flagged providers, $${(s.total_paid / 1e9).toFixed(1)}B in billing`).join('\n')}

ZIP CODE HOTSPOTS:
${(enrichedData?.geographic_analysis?.zipHotspots || []).slice(0, 5).map(z => `- ${z.zip} (${z.city}, ${z.state}): ${z.count} flagged providers, $${(z.total_paid / 1e9).toFixed(1)}B`).join('\n')}

RULES:
1. Explain things in plain, simple language — no jargon. Think: explaining to a concerned citizen or journalist.
2. If someone asks about a specific area (zip code, city, state), reference the geographic data you have.
3. Always emphasize that these are FINDINGS based on data analysis — not legal convictions.
4. If asked how to report fraud, provide: OIG Hotline (1-800-HHS-TIPS), FBI Tips (tips.fbi.gov), NJ AG MFCU (609-292-8740).
5. Be empathetic — people are concerned about their tax dollars and community healthcare.
6. If you don't have specific data for an area, say so honestly and suggest the search feature.
7. Use formatting like bold, bullets, etc. to make responses scannable.`;

        const contents = [];
        for (const msg of history.slice(-8)) {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.6,
                maxOutputTokens: 3000,
            }
        });

        res.json({
            response: response.text,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Community chat error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Nearby risk lookup — get providers near coordinates (lat/lng)
app.get('/api/community/nearby', (req, res) => {
    const { lat, lng, radius = 50 } = req.query;

    // Since we have zip/city/state data but not exact coords for all providers,
    // we use state-level matching and return what we have
    const stateRanking = enrichedData?.geographic_analysis?.stateRanking || [];
    const zipHotspots = enrichedData?.geographic_analysis?.zipHotspots || [];

    res.json({
        message: 'Use the /api/community/search endpoint with zip, city, or state for geo filtering',
        available_states: stateRanking.map(s => ({
            state: s.state,
            flagged_providers: s.count,
            total_billing: s.total_paid,
        })),
        zip_hotspots: zipHotspots.slice(0, 20).map(z => ({
            zip: z.zip,
            city: z.city,
            state: z.state,
            flagged_providers: z.count,
            total_billing: z.total_paid,
        })),
    });
});

// SPA fallback
app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'public', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`\n🔴 Medicaid Fraud Detection Dashboard`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   API Key: ${API_KEY ? '✅' : '❌'}`);
    console.log(`   Providers: ${providerStats.length}`);
    console.log(`   Fraud Analysis: ${statisticalAnalysis ? '✅' : '⏳ pending'}`);

    // Initialize RAG engine in background
    try {
        await rag.init();
        console.log(`   RAG Engine: ✅ (${rag.store.size} chunks indexed)\n`);
    } catch (err) {
        console.log(`   RAG Engine: ⚠️ ${err.message}\n`);
    }
});
