#!/usr/bin/env node
/**
 * New Jersey Deep Fraud Investigation
 * ═══════════════════════════════════════════════════════════════
 * 
 * Phase 1: Stream full 227M-row CSV → aggregate ALL provider stats
 * Phase 2: Identify NJ providers via NPI Registry batch lookup
 * Phase 3: Re-stream CSV for detailed NJ data (per-month, per-code)
 * Phase 4: Deep forensic analysis of each NJ provider
 * Phase 5: Google Search grounding investigation per provider
 * Phase 6: Gemini AI comprehensive NJ fraud report
 * Phase 7: Save results → fraud_analysis/nj_deep_dive.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY });

const CSV_PATH = path.join(__dirname, 'medicaid-provider-spending.csv');
const OUTPUT_PATH = path.join(__dirname, 'fraud_analysis', 'nj_deep_dive.json');
const ENRICHED_PATH = path.join(__dirname, 'fraud_analysis', 'enriched_providers.json');
const STATS_PATH = path.join(__dirname, 'fraud_analysis', 'statistical_analysis.json');

// ── Helpers ──────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtMoney(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Stream CSV → Aggregate ALL Provider Stats
// ═══════════════════════════════════════════════════════════════

async function streamCSVProviderStats() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 1: Streaming 227M rows → Provider Aggregation');
    console.log('═══════════════════════════════════════════════════\n');

    const providerMap = new Map(); // npi → stats
    let rowCount = 0;
    let selfRefCount = 0;
    const startTime = Date.now();

    const rl = readline.createInterface({
        input: fs.createReadStream(CSV_PATH, { highWaterMark: 64 * 1024 }),
        crlfDelay: Infinity,
    });

    let headerSkipped = false;

    for await (const line of rl) {
        if (!headerSkipped) { headerSkipped = true; continue; }
        rowCount++;

        const parts = line.split(',');
        if (parts.length < 7) continue;

        const billingNpi = parts[0];
        const servicingNpi = parts[1];
        const hcpcsCode = parts[2];
        const claimMonth = parts[3];
        const beneficiaries = parseInt(parts[4]) || 0;
        const claims = parseInt(parts[5]) || 0;
        const paid = parseFloat(parts[6]) || 0;

        const isSelfRef = billingNpi === servicingNpi;
        if (isSelfRef) selfRefCount++;

        let p = providerMap.get(billingNpi);
        if (!p) {
            p = {
                npi: billingNpi,
                total_paid: 0,
                total_claims: 0,
                total_beneficiaries: 0,
                row_count: 0,
                self_ref_rows: 0,
                months: new Set(),
                codes: new Set(),
                servicing_npis: new Set(),
            };
            providerMap.set(billingNpi, p);
        }

        p.total_paid += paid;
        p.total_claims += claims;
        p.total_beneficiaries += beneficiaries;
        p.row_count++;
        if (isSelfRef) p.self_ref_rows++;
        p.months.add(claimMonth);
        p.codes.add(hcpcsCode);
        p.servicing_npis.add(servicingNpi);

        if (rowCount % 10_000_000 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const pct = ((rowCount / 227_083_361) * 100).toFixed(1);
            console.log(`   ${pct}% — ${(rowCount / 1e6).toFixed(0)}M rows | ${providerMap.size.toLocaleString()} providers | ${elapsed}s`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n   ✅ Processed ${rowCount.toLocaleString()} rows in ${elapsed}s`);
    console.log(`   📊 ${providerMap.size.toLocaleString()} unique billing providers`);
    console.log(`   🔄 Self-referral: ${((selfRefCount / rowCount) * 100).toFixed(1)}%`);

    // Convert sets to counts for JSON compatibility
    const providers = [];
    for (const p of providerMap.values()) {
        providers.push({
            npi: p.npi,
            total_paid: p.total_paid,
            total_claims: p.total_claims,
            total_beneficiaries: p.total_beneficiaries,
            row_count: p.row_count,
            self_ref_rows: p.self_ref_rows,
            self_ref_pct: p.row_count > 0 ? (p.self_ref_rows / p.row_count * 100) : 0,
            months_active: p.months.size,
            unique_codes: p.codes.size,
            unique_servicing_npis: p.servicing_npis.size,
            codes: [...p.codes],
            avg_payment_per_claim: p.total_claims > 0 ? p.total_paid / p.total_claims : 0,
        });
    }

    // Compute Z-scores on total_paid
    const payments = providers.map(p => p.total_paid);
    const mean = payments.reduce((a, b) => a + b, 0) / payments.length;
    const std = Math.sqrt(payments.reduce((a, b) => a + (b - mean) ** 2, 0) / payments.length);

    for (const p of providers) {
        p.z_score = std > 0 ? (p.total_paid - mean) / std : 0;
    }

    // Sort by total_paid descending
    providers.sort((a, b) => b.total_paid - a.total_paid);

    return { providers, metadata: { rowCount, selfRefCount, providerCount: providers.length, mean, std } };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Identify NJ Providers via NPI Registry
// ═══════════════════════════════════════════════════════════════

async function lookupNPI(npi) {
    try {
        const url = `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.result_count > 0) {
            const r = data.results[0];
            const addr = r.addresses?.[0] || {};
            const tax = r.taxonomies?.[0] || {};
            const basic = r.basic || {};

            let name = '';
            if (r.enumeration_type === 'NPI-2') {
                name = basic.organization_name || '';
            } else {
                name = [basic.first_name, basic.last_name].filter(Boolean).join(' ');
            }

            return {
                npi,
                provider_name: name,
                provider_type: r.enumeration_type === 'NPI-2' ? 'Organization' : 'Individual',
                address: addr.address_1 || '',
                city: addr.city || '',
                state: addr.state || '',
                zip: (addr.postal_code || '').substring(0, 5),
                full_zip: addr.postal_code || '',
                phone: addr.telephone_number || '',
                taxonomy_code: tax.code || '',
                taxonomy_desc: tax.desc || '',
                enumeration_date: basic.enumeration_date || '',
                status: basic.status || '',
                found: true,
            };
        }
        return { npi, found: false };
    } catch (err) {
        return { npi, found: false, error: err.message };
    }
}

async function discoverNJProviders(allProviders, knownNJ) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 2: NPI Registry Lookup → Discover NJ Providers');
    console.log('═══════════════════════════════════════════════════\n');

    const knownNPIs = new Set(knownNJ.map(p => p.npi));
    const njProviders = [...knownNJ]; // start with known
    const njNPIs = new Set(knownNPIs);

    // Look up the top 500 providers by total_paid that aren't already known
    const toLookup = allProviders
        .filter(p => !knownNPIs.has(p.npi))
        .slice(0, 500);

    console.log(`   🔍 Looking up ${toLookup.length} provider NPIs via NPI Registry...`);
    console.log(`   (Already know ${knownNJ.length} NJ providers)\n`);

    let checked = 0;
    let found = 0;

    for (const provider of toLookup) {
        const result = await lookupNPI(provider.npi);
        checked++;

        if (result.found && result.state === 'NJ') {
            found++;
            njNPIs.add(provider.npi);
            njProviders.push({
                ...provider,
                ...result,
            });
            console.log(`   ✅ NJ #${njProviders.length}: ${result.provider_name} (${result.city} ${result.zip}) — ${fmtMoney(provider.total_paid)}`);
        }

        if (checked % 50 === 0) {
            console.log(`   ... checked ${checked}/${toLookup.length} (${found} new NJ found)`);
        }

        await sleep(80); // Rate limit NPI Registry
    }

    console.log(`\n   📍 Total NJ providers discovered: ${njProviders.length}`);
    console.log(`   🆕 New NJ from NPI lookup: ${found}`);

    return { njProviders, njNPIs };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: Re-stream CSV for Detailed NJ Data
// ═══════════════════════════════════════════════════════════════

async function extractNJDetailedData(njNPIs) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 3: Re-streaming CSV → NJ Detailed Monthly Data');
    console.log('═══════════════════════════════════════════════════\n');

    const njData = new Map(); // npi → { monthly: {}, codes: {}, rows: [] }
    let rowCount = 0;
    let njRows = 0;
    const startTime = Date.now();

    const rl = readline.createInterface({
        input: fs.createReadStream(CSV_PATH, { highWaterMark: 64 * 1024 }),
        crlfDelay: Infinity,
    });

    let headerSkipped = false;

    for await (const line of rl) {
        if (!headerSkipped) { headerSkipped = true; continue; }
        rowCount++;

        const parts = line.split(',');
        if (parts.length < 7) continue;

        const billingNpi = parts[0];
        if (!njNPIs.has(billingNpi)) continue;

        njRows++;
        const servicingNpi = parts[1];
        const hcpcsCode = parts[2];
        const claimMonth = parts[3];
        const beneficiaries = parseInt(parts[4]) || 0;
        const claims = parseInt(parts[5]) || 0;
        const paid = parseFloat(parts[6]) || 0;

        let d = njData.get(billingNpi);
        if (!d) {
            d = {
                monthly: {},        // month → {paid, claims, benes}
                codes: {},          // code → {paid, claims, benes, months}
                servicing: {},      // servicing_npi → {paid, claims}
                payments: [],       // individual payment amounts for Benford's
            };
            njData.set(billingNpi, d);
        }

        // Monthly timeline
        if (!d.monthly[claimMonth]) d.monthly[claimMonth] = { paid: 0, claims: 0, benes: 0 };
        d.monthly[claimMonth].paid += paid;
        d.monthly[claimMonth].claims += claims;
        d.monthly[claimMonth].benes += beneficiaries;

        // Per-code breakdown
        if (!d.codes[hcpcsCode]) d.codes[hcpcsCode] = { paid: 0, claims: 0, benes: 0, months: new Set() };
        d.codes[hcpcsCode].paid += paid;
        d.codes[hcpcsCode].claims += claims;
        d.codes[hcpcsCode].benes += beneficiaries;
        d.codes[hcpcsCode].months.add(claimMonth);

        // Servicing NPI network
        if (!d.servicing[servicingNpi]) d.servicing[servicingNpi] = { paid: 0, claims: 0 };
        d.servicing[servicingNpi].paid += paid;
        d.servicing[servicingNpi].claims += claims;

        // Track individual payments for Benford analysis
        if (paid > 0 && d.payments.length < 5000) {
            d.payments.push(paid);
        }

        if (rowCount % 10_000_000 === 0) {
            console.log(`   ${(rowCount / 1e6).toFixed(0)}M rows scanned | ${njRows.toLocaleString()} NJ rows captured`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n   ✅ Extracted ${njRows.toLocaleString()} NJ rows in ${elapsed}s`);
    console.log(`   📊 Detailed data for ${njData.size} NJ providers`);

    return njData;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4: Deep Forensic Analysis
// ═══════════════════════════════════════════════════════════════

function analyzeNJProviders(njProviders, njDetailedData, globalStats) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 4: Deep Forensic Analysis');
    console.log('═══════════════════════════════════════════════════\n');

    const analyzed = [];

    for (const provider of njProviders) {
        const detail = njDetailedData.get(provider.npi) || {};
        const monthly = detail.monthly || {};
        const codes = detail.codes || {};
        const servicing = detail.servicing || {};
        const payments = detail.payments || [];

        // ── Temporal Analysis ──
        const monthlyEntries = Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b));
        const monthlyPayments = monthlyEntries.map(([, d]) => d.paid);
        const avgMonthly = monthlyPayments.length > 0 ? monthlyPayments.reduce((a, b) => a + b, 0) / monthlyPayments.length : 0;
        const stdMonthly = Math.sqrt(monthlyPayments.reduce((a, b) => a + (b - avgMonthly) ** 2, 0) / Math.max(monthlyPayments.length, 1));

        const temporalAnomalies = monthlyEntries
            .filter(([, d]) => stdMonthly > 0 && Math.abs(d.paid - avgMonthly) / stdMonthly > 2)
            .map(([month, d]) => ({
                month,
                paid: d.paid,
                z_score: (d.paid - avgMonthly) / stdMonthly,
                type: d.paid > avgMonthly ? 'SPIKE' : 'DROP',
            }));

        // Trend analysis: is billing increasing over time?
        let trend = 'STABLE';
        if (monthlyPayments.length >= 6) {
            const firstHalf = monthlyPayments.slice(0, Math.floor(monthlyPayments.length / 2));
            const secondHalf = monthlyPayments.slice(Math.floor(monthlyPayments.length / 2));
            const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
            const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
            if (avgSecond > avgFirst * 1.5) trend = 'INCREASING';
            else if (avgSecond < avgFirst * 0.5) trend = 'DECREASING';
        }

        // ── Code Analysis ──
        const codeEntries = Object.entries(codes)
            .map(([code, d]) => ({
                code,
                paid: d.paid,
                claims: d.claims,
                benes: d.benes,
                months_used: d.months?.size || 0,
                avg_per_claim: d.claims > 0 ? d.paid / d.claims : 0,
                pct_of_total: provider.total_paid > 0 ? (d.paid / provider.total_paid * 100) : 0,
            }))
            .sort((a, b) => b.paid - a.paid);

        // Code concentration: does one code dominate?
        const topCodePct = codeEntries[0]?.pct_of_total || 0;
        const codeConcentration = topCodePct > 80 ? 'EXTREME' : topCodePct > 50 ? 'HIGH' : topCodePct > 30 ? 'MODERATE' : 'LOW';

        // ── Self-referral Analysis ──
        const selfRefPaid = servicing[provider.npi]?.paid || 0;
        const selfRefPct = provider.total_paid > 0 ? (selfRefPaid / provider.total_paid * 100) : 0;

        // ── Servicing Network ──
        const servicingEntries = Object.entries(servicing)
            .map(([npi, d]) => ({ npi, paid: d.paid, claims: d.claims }))
            .sort((a, b) => b.paid - a.paid);

        const networkSize = servicingEntries.length;
        const isHubAndSpoke = networkSize > 5 && selfRefPct < 50;

        // ── Benford's Law ──
        const expectedBenford = [0, 30.1, 17.6, 12.5, 9.7, 7.9, 6.7, 5.8, 5.1, 4.6];
        const digitCounts = new Array(10).fill(0);
        for (const p of payments) {
            const leadingDigit = parseInt(String(Math.abs(p))[0]);
            if (leadingDigit >= 1 && leadingDigit <= 9) digitCounts[leadingDigit]++;
        }
        const totalDigits = digitCounts.reduce((a, b) => a + b, 0);
        const benfordDeviation = totalDigits > 50 ? digitCounts.slice(1).reduce((sum, count, i) => {
            const observed = (count / totalDigits) * 100;
            return sum + Math.abs(observed - expectedBenford[i + 1]);
        }, 0) : null;

        // ── Beneficiary Volume Analysis ──
        const monthlyBenes = monthlyEntries.map(([, d]) => d.benes);
        const maxBenes = Math.max(...monthlyBenes, 0);
        const avgBenes = monthlyBenes.length > 0 ? monthlyBenes.reduce((a, b) => a + b, 0) / monthlyBenes.length : 0;
        const impossibleVolume = provider.provider_type === 'Individual' && maxBenes > 500;

        // ── Risk Scoring ──
        let riskScore = 0;
        const redFlags = [];

        if (provider.z_score > 10) { riskScore += 30; redFlags.push(`Extreme Z-score: ${provider.z_score.toFixed(1)}`); }
        else if (provider.z_score > 5) { riskScore += 20; redFlags.push(`High Z-score: ${provider.z_score.toFixed(1)}`); }
        else if (provider.z_score > 3) { riskScore += 10; redFlags.push(`Elevated Z-score: ${provider.z_score.toFixed(1)}`); }

        if (selfRefPct > 95) { riskScore += 15; redFlags.push(`100% self-referral (${selfRefPct.toFixed(1)}%)`); }
        else if (selfRefPct > 80) { riskScore += 10; redFlags.push(`High self-referral: ${selfRefPct.toFixed(1)}%`); }

        if (codeConcentration === 'EXTREME') { riskScore += 15; redFlags.push(`Single code dominates ${topCodePct.toFixed(0)}% of billing`); }
        else if (codeConcentration === 'HIGH') { riskScore += 8; redFlags.push(`Top code = ${topCodePct.toFixed(0)}% of billing`); }

        if (temporalAnomalies.length > 3) { riskScore += 10; redFlags.push(`${temporalAnomalies.length} temporal anomalies`); }
        if (trend === 'INCREASING') { riskScore += 5; redFlags.push('Billing trend is increasing'); }
        if (impossibleVolume) { riskScore += 15; redFlags.push(`Impossibly high patient volume: ${maxBenes.toLocaleString()} in one month`); }
        if (benfordDeviation && benfordDeviation > 15) { riskScore += 10; redFlags.push(`Benford deviation: ${benfordDeviation.toFixed(1)}`); }
        if (networkSize === 1 && selfRefPct > 99) { riskScore += 5; redFlags.push('Completely isolated billing (no servicing network)'); }
        if (isHubAndSpoke) { riskScore += 8; redFlags.push(`Hub-and-spoke pattern (${networkSize} servicing NPIs)`); }

        const riskLevel = riskScore >= 50 ? 'CRITICAL' : riskScore >= 30 ? 'HIGH' : riskScore >= 15 ? 'MEDIUM' : 'LOW';

        analyzed.push({
            npi: provider.npi,
            provider_name: provider.provider_name || '—',
            provider_type: provider.provider_type || '—',
            city: provider.city || '—',
            state: 'NJ',
            zip: provider.zip || '—',
            phone: provider.phone || '',
            taxonomy_desc: provider.taxonomy_desc || '—',
            enumeration_date: provider.enumeration_date || '',

            // Financial
            total_paid: provider.total_paid,
            total_claims: provider.total_claims,
            avg_payment_per_claim: provider.avg_payment_per_claim || 0,
            z_score: provider.z_score || 0,

            // Activity
            months_active: provider.months_active || 0,
            unique_codes: provider.unique_codes || 0,
            row_count: provider.row_count || 0,

            // Risk Assessment
            risk_score: riskScore,
            risk_level: riskLevel,
            red_flags: redFlags,

            // Self-referral
            self_ref_pct: Math.round(selfRefPct * 10) / 10,
            self_ref_paid: selfRefPaid,

            // Code analysis
            top_codes: codeEntries.slice(0, 10),
            code_concentration: codeConcentration,

            // Temporal
            trend,
            temporal_anomalies: temporalAnomalies.slice(0, 10),
            monthly_timeline: monthlyEntries.map(([month, d]) => ({
                month, paid: d.paid, claims: d.claims, benes: d.benes,
            })),

            // Network
            network_size: networkSize,
            top_servicing: servicingEntries.slice(0, 5),
            is_hub_and_spoke: isHubAndSpoke,

            // Benford
            benford_deviation: benfordDeviation,

            // Beneficiary
            max_monthly_beneficiaries: maxBenes,
            avg_monthly_beneficiaries: Math.round(avgBenes),
        });
    }

    // Sort by risk score descending
    analyzed.sort((a, b) => b.risk_score - a.risk_score || b.total_paid - a.total_paid);

    console.log(`   ✅ Analyzed ${analyzed.length} NJ providers\n`);
    console.log('   Risk Distribution:');
    console.log(`     🔴 CRITICAL: ${analyzed.filter(p => p.risk_level === 'CRITICAL').length}`);
    console.log(`     🟠 HIGH:     ${analyzed.filter(p => p.risk_level === 'HIGH').length}`);
    console.log(`     🟡 MEDIUM:   ${analyzed.filter(p => p.risk_level === 'MEDIUM').length}`);
    console.log(`     🟢 LOW:      ${analyzed.filter(p => p.risk_level === 'LOW').length}`);

    console.log('\n   Top 10 Worst NJ Providers:');
    for (const p of analyzed.slice(0, 10)) {
        console.log(`     #${analyzed.indexOf(p) + 1} [${p.risk_level}] ${p.provider_name} (${p.city}) — ${fmtMoney(p.total_paid)} | Score: ${p.risk_score} | Flags: ${p.red_flags.length}`);
    }

    return analyzed;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 5: Google Search Grounding Investigation
// ═══════════════════════════════════════════════════════════════

async function investigateWithGrounding(njAnalyzed) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 5: Google Search Grounding Investigation');
    console.log('═══════════════════════════════════════════════════\n');

    // Investigate top providers (CRITICAL + HIGH risk)
    const toInvestigate = njAnalyzed.filter(p => p.risk_level === 'CRITICAL' || p.risk_level === 'HIGH');
    console.log(`   🔍 Investigating ${toInvestigate.length} high-risk NJ providers with Google Search...\n`);

    const investigations = [];
    const allSources = [];

    for (const provider of toInvestigate) {
        console.log(`   📋 Investigating: ${provider.provider_name} (NPI ${provider.npi})...`);

        const prompt = `Investigate this New Jersey Medicaid provider for potential fraud:

PROVIDER: ${provider.provider_name}
NPI: ${provider.npi}
LOCATION: ${provider.city}, NJ ${provider.zip}
SPECIALTY: ${provider.taxonomy_desc}
TOTAL PAID: $${provider.total_paid.toLocaleString()}
RISK SCORE: ${provider.risk_score}/100 (${provider.risk_level})
RED FLAGS: ${provider.red_flags.join('; ')}
TOP CODES: ${provider.top_codes.slice(0, 3).map(c => `${c.code}: $${c.paid.toLocaleString()}`).join(', ')}
SELF-REFERRAL: ${provider.self_ref_pct}%

Search for:
1. Is this provider on the OIG exclusion list?
2. Any DOJ or state AG enforcement actions?
3. Any news articles about fraud, billing irregularities, or investigations?
4. Any Medicare/Medicaid sanctions or penalties?
5. Any whistleblower lawsuits (qui tam)?
6. What is their public reputation?
7. Any NJ-specific Medicaid fraud enforcement related to this entity?

Be specific with dates, amounts, and case numbers if found.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.2,
                    maxOutputTokens: 4000,
                },
            });

            const grounding = response.candidates?.[0]?.groundingMetadata || {};
            const sources = (grounding.groundingChunks || [])
                .filter(c => c.web?.uri)
                .map(c => ({ title: c.web.title || '', url: c.web.uri }));

            allSources.push(...sources);

            investigations.push({
                npi: provider.npi,
                provider_name: provider.provider_name,
                report: response.text || '',
                sources,
                search_queries: grounding.webSearchQueries || [],
            });

            console.log(`      ✅ Found ${sources.length} sources, ${(response.text || '').length} chars`);
        } catch (err) {
            console.log(`      ❌ Error: ${err.message}`);
            investigations.push({
                npi: provider.npi,
                provider_name: provider.provider_name,
                report: `Error: ${err.message}`,
                sources: [],
                search_queries: [],
            });
        }

        await sleep(1500); // Rate limit
    }

    console.log(`\n   ✅ Completed ${investigations.length} provider investigations`);
    console.log(`   📰 Total sources found: ${allSources.length}`);

    return { investigations, allSources };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 6: Gemini AI Comprehensive NJ Report
// ═══════════════════════════════════════════════════════════════

async function generateNJReport(njAnalyzed, investigations) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 6: Generating Comprehensive NJ Fraud Report');
    console.log('═══════════════════════════════════════════════════\n');

    const top20 = njAnalyzed.slice(0, 20);
    const investigationSummaries = investigations.map(inv => {
        const report = inv.report.substring(0, 800);
        return `### ${inv.provider_name} (NPI ${inv.npi})\n${report}\nSources: ${inv.sources.length}`;
    }).join('\n\n');

    const prompt = `You are a senior fraud investigator for the State of New Jersey Medicaid Fraud Control Unit.

Write an extremely detailed, prosecutable-quality fraud investigation report for New Jersey Medicaid fraud.

## DATA:

### NJ Medicaid Overview
- Total NJ providers analyzed: ${njAnalyzed.length}
- Total NJ Medicaid paid: $${njAnalyzed.reduce((a, p) => a + p.total_paid, 0).toLocaleString()}
- CRITICAL risk providers: ${njAnalyzed.filter(p => p.risk_level === 'CRITICAL').length}
- HIGH risk providers: ${njAnalyzed.filter(p => p.risk_level === 'HIGH').length}

### Top 20 Most Suspicious NJ Providers
${top20.map((p, i) => `${i + 1}. **${p.provider_name}** (NPI: ${p.npi})
   - City: ${p.city}, NJ ${p.zip}
   - Specialty: ${p.taxonomy_desc}
   - Total Paid: $${p.total_paid.toLocaleString()}
   - Risk Score: ${p.risk_score}/100 (${p.risk_level})
   - Red Flags: ${p.red_flags.join('; ')}
   - Self-Referral: ${p.self_ref_pct}%
   - Top Codes: ${p.top_codes.slice(0, 3).map(c => c.code + ': $' + c.paid.toLocaleString()).join(', ')}
   - Temporal: ${p.temporal_anomalies.length} anomalies, trend: ${p.trend}
   - Network: ${p.network_size} servicing NPIs`).join('\n')}

### Google Search Investigation Results
${investigationSummaries}

## REPORT REQUIREMENTS:

Write a comprehensive NJ Medicaid Fraud Investigation Report with these sections:
1. **Executive Summary** — Total fraud exposure estimate for NJ
2. **CRITICAL Threat Assessment** — The worst offenders with specific evidence
3. **HCPCS Code Fraud Patterns** — Which procedure codes are being exploited in NJ
4. **Geographic Hotspots** — Which NJ cities/zips are fraud concentrated in
5. **Network Analysis** — Self-referral schemes and billing networks
6. **Temporal Patterns** — When fraud spikes and billing irregularities occur
7. **Individual Provider Deep Dives** — Top 10 most suspicious with detailed evidence
8. **Real-World Intelligence** — What Google Search found about these providers
9. **Recommended Enforcement Actions** — Specific subpoenas, audits, referrals
10. **Estimated Financial Impact** — Dollar amount of suspected fraudulent billing

Be extremely specific with NPI numbers, dollar amounts, HCPCS codes, and dates. This should read like a real state-level Medicaid fraud enforcement document.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                temperature: 0.3,
                maxOutputTokens: 16000,
            },
        });

        const report = response.text || '';
        console.log(`   ✅ Report generated: ${report.length} chars, ${report.split('\n').length} lines`);

        // Save the report separately as Markdown
        const reportPath = path.join(__dirname, 'fraud_analysis', 'nj_fraud_report.md');
        fs.writeFileSync(reportPath, report, 'utf-8');
        console.log(`   📄 Saved: ${reportPath}`);

        return report;
    } catch (err) {
        console.error(`   ❌ Report generation error: ${err.message}`);
        return 'Report generation failed: ' + err.message;
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║       NEW JERSEY MEDICAID FRAUD DEEP INVESTIGATION      ║');
    console.log('║       Finding the Absolute Worst of the Worst           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    // Load known NJ providers from enriched data
    let knownNJ = [];
    if (fs.existsSync(ENRICHED_PATH)) {
        const enriched = JSON.parse(fs.readFileSync(ENRICHED_PATH, 'utf-8'));
        knownNJ = (enriched.providers || []).filter(p => p.state === 'NJ');
        console.log(`\n📋 Loaded ${knownNJ.length} known NJ providers from enriched data`);
    }

    // Phase 1: Stream CSV → all provider stats
    const { providers: allProviders, metadata: csvMetadata } = await streamCSVProviderStats();

    // Merge known NJ data with CSV stats
    const knownNJWithStats = knownNJ.map(p => {
        const csvStat = allProviders.find(a => a.npi === p.npi);
        return { ...p, ...(csvStat || {}) };
    });

    // Phase 2: Discover more NJ providers
    const { njProviders } = await discoverNJProviders(allProviders, knownNJWithStats);

    if (njProviders.length === 0) {
        console.log('\n❌ No NJ providers found. Exiting.');
        return;
    }

    // Phase 3: Re-stream CSV for detailed NJ data
    const njNPIs = new Set(njProviders.map(p => p.npi));
    const njDetailedData = await extractNJDetailedData(njNPIs);

    // Phase 4: Deep analysis
    const njAnalyzed = analyzeNJProviders(njProviders, njDetailedData, csvMetadata);

    // Phase 5: Google Search grounding
    const { investigations, allSources } = await investigateWithGrounding(njAnalyzed);

    // Phase 6: Generate comprehensive report
    const report = await generateNJReport(njAnalyzed, investigations);

    // Phase 7: Save everything
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 7: Saving Results');
    console.log('═══════════════════════════════════════════════════\n');

    const output = {
        metadata: {
            generated_at: new Date().toISOString(),
            csv_rows_processed: csvMetadata.rowCount,
            total_providers_in_csv: csvMetadata.providerCount,
            nj_providers_found: njAnalyzed.length,
            nj_total_paid: njAnalyzed.reduce((a, p) => a + p.total_paid, 0),
            nj_critical_count: njAnalyzed.filter(p => p.risk_level === 'CRITICAL').length,
            nj_high_count: njAnalyzed.filter(p => p.risk_level === 'HIGH').length,
            nj_medium_count: njAnalyzed.filter(p => p.risk_level === 'MEDIUM').length,
            nj_low_count: njAnalyzed.filter(p => p.risk_level === 'LOW').length,
            investigation_sources: allSources.length,
        },
        providers: njAnalyzed,
        investigations,
        report,
        all_sources: [...new Map(allSources.map(s => [s.url, s])).values()], // dedupe
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
    const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ Saved: ${OUTPUT_PATH} (${sizeMB} MB)`);

    // Summary
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║              NJ DEEP DIVE — COMPLETE                     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n   📊 NJ Providers Analyzed: ${njAnalyzed.length}`);
    console.log(`   💰 Total NJ Medicaid Paid: ${fmtMoney(njAnalyzed.reduce((a, p) => a + p.total_paid, 0))}`);
    console.log(`   🔴 CRITICAL Risk: ${njAnalyzed.filter(p => p.risk_level === 'CRITICAL').length}`);
    console.log(`   🟠 HIGH Risk: ${njAnalyzed.filter(p => p.risk_level === 'HIGH').length}`);
    console.log(`   🔍 Google Sources: ${allSources.length}`);
    console.log(`   📄 Report: fraud_analysis/nj_fraud_report.md`);
    console.log(`   💾 Full Data: fraud_analysis/nj_deep_dive.json`);
    console.log(`\n   Top 5 Worst NJ Providers:`);
    for (const p of njAnalyzed.slice(0, 5)) {
        console.log(`     🔴 ${p.provider_name} — ${fmtMoney(p.total_paid)} — ${p.red_flags.length} red flags`);
    }
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
});
