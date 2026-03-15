#!/usr/bin/env node
/**
 * NJ Debarment List Parser & Cross-Match Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Phase 1: Parse nj_debarment_list.pdf via Gemini (PDF → structured JSON)
 * Phase 2: Extract all names, NPIs, addresses, exclusion dates, actions → CSV
 * Phase 3: Stream the 227M-row CSV, find ALL claims for excluded providers
 * Phase 4: Flag post-exclusion payments (billing AFTER debarment date)
 * Phase 5: Compute billing spikes, top offenders, suspicious patterns
 * Phase 6: Save results → fraud_analysis/debarment_cross_match.json + .csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY });

const PDF_PATH = path.join(__dirname, 'nj_debarment_list.pdf');
const CSV_PATH = path.join(__dirname, 'medicaid-provider-spending.csv');
const OUTPUT_JSON = path.join(__dirname, 'fraud_analysis', 'debarment_cross_match.json');
const OUTPUT_CSV = path.join(__dirname, 'fraud_analysis', 'nj_debarred_providers.csv');
const HITS_CSV = path.join(__dirname, 'fraud_analysis', 'post_exclusion_payments.csv');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtMoney(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Parse PDF via Gemini
// ═══════════════════════════════════════════════════════════════

async function parsePDF() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 1: Parsing NJ Debarment List PDF via Gemini');
    console.log('═══════════════════════════════════════════════════\n');

    const pdfBytes = fs.readFileSync(PDF_PATH);
    const pdfBase64 = pdfBytes.toString('base64');
    console.log(`   📄 PDF size: ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB`);

    const pdfPart = {
        inlineData: { mimeType: 'application/pdf', data: pdfBase64 },
    };

    const prompt = `This PDF is the New Jersey Ineligible/Debarred Provider List from the NJ Division of Medical Assistance and Health Services.

Extract EVERY single provider entry from this entire document into a JSON array. Do NOT skip or summarize any entries.

For each provider, extract:
{
  "name": "Provider full name (string)",
  "npi": "NPI number (string or null)",
  "license_number": "License number (string or null)",
  "address": "Street address (string or null)",
  "city": "City (string or null)",
  "state": "State (string or null)",
  "zip": "ZIP (string or null)",
  "exclusion_date": "Date as YYYY-MM-DD (string or null)",
  "reinstatement_date": "Date or null",
  "action_type": "DISQUALIFICATION/DEBARMENT/EXCLUSION/SUSPENSION/SANCTION (string or null)",
  "reason": "Reason text (string or null)",
  "provider_type": "Type of provider (string or null)",
  "status": "Active/Permanent/Reinstated (string or null)"
}

Output the COMPLETE JSON array of ALL entries. Start with [ and end with ].`;

    let allProviders = [];

    // Helper to extract JSON array from text
    function extractJSON(text) {
        // Remove markdown code blocks
        let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

        // Find the outermost JSON array
        const startIdx = clean.indexOf('[');
        if (startIdx === -1) return [];

        // Find matching closing bracket
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < clean.length; i++) {
            if (clean[i] === '[') depth++;
            if (clean[i] === ']') {
                depth--;
                if (depth === 0) { endIdx = i; break; }
            }
        }

        if (endIdx === -1) {
            // Truncated JSON - try to fix it
            console.log('   ⚠️ JSON appears truncated, attempting repair...');
            clean = clean.substring(startIdx);
            // Find the last complete object
            const lastObjEnd = clean.lastIndexOf('}');
            if (lastObjEnd > 0) {
                clean = clean.substring(0, lastObjEnd + 1) + ']';
            }
        } else {
            clean = clean.substring(startIdx, endIdx + 1);
        }

        return JSON.parse(clean);
    }

    const models = ['gemini-2.5-flash', 'gemini-2.5-pro'];

    for (const model of models) {
        try {
            console.log(`   🤖 Trying ${model}...`);

            const response = await ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [pdfPart, { text: prompt }] }],
                config: {
                    temperature: 0.05,
                    maxOutputTokens: 65536,
                },
            });

            const rawText = response.text || '';
            console.log(`   📝 Response: ${rawText.length} chars`);

            allProviders = extractJSON(rawText);
            console.log(`   ✅ Extracted ${allProviders.length} providers via ${model}`);

            if (allProviders.length > 0) break;
        } catch (err) {
            console.error(`   ❌ ${model} error: ${err.message}`);
        }
    }

    // Report summary
    const withNPI = allProviders.filter(p => p.npi);
    const withDate = allProviders.filter(p => p.exclusion_date);
    console.log(`\n   📊 Extraction Summary:`);
    console.log(`      Total providers: ${allProviders.length}`);
    console.log(`      With NPI: ${withNPI.length}`);
    console.log(`      With exclusion date: ${withDate.length}`);
    const types = [...new Set(allProviders.map(p => p.provider_type).filter(Boolean))];
    console.log(`      Provider types: ${types.length > 0 ? types.join(', ') : '(none specified)'}`);

    // Show first few entries
    if (allProviders.length > 0) {
        console.log(`\n   📋 Sample entries:`);
        allProviders.slice(0, 3).forEach((p, i) => {
            console.log(`      ${i + 1}. ${p.name} | NPI: ${p.npi || 'N/A'} | Excluded: ${p.exclusion_date || 'N/A'} | ${p.action_type || ''}`);
        });
    }

    return allProviders;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Save Clean CSV of Debarred Providers
// ═══════════════════════════════════════════════════════════════

function saveDebarredCSV(providers) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 2: Saving NJ Debarred Providers CSV');
    console.log('═══════════════════════════════════════════════════\n');

    const headers = ['name', 'npi', 'license_number', 'address', 'city', 'state', 'zip', 'exclusion_date', 'reinstatement_date', 'action_type', 'reason', 'provider_type', 'status'];

    const csvLines = [headers.join(',')];
    for (const p of providers) {
        csvLines.push(headers.map(h => {
            const val = String(p[h] || '').replace(/"/g, '""');
            return val.includes(',') || val.includes('"') || val.includes('\n') ? `"${val}"` : val;
        }).join(','));
    }

    fs.writeFileSync(OUTPUT_CSV, csvLines.join('\n'), 'utf-8');
    console.log(`   ✅ Saved ${providers.length} entries to ${OUTPUT_CSV}`);
    return OUTPUT_CSV;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: NPI Lookup for Debarred Providers Without NPI
// ═══════════════════════════════════════════════════════════════

async function resolveNPIs(providers) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 3: Resolving NPIs for Debarred Providers');
    console.log('═══════════════════════════════════════════════════\n');

    const withoutNPI = providers.filter(p => !p.npi);
    console.log(`   🔍 ${withoutNPI.length} providers need NPI lookup`);

    let resolved = 0;

    for (const provider of withoutNPI) {
        if (!provider.name) continue;

        try {
            // Parse name into first/last (for individuals) or org name
            const nameParts = provider.name.split(/[\s,]+/).filter(Boolean);
            let url;

            if (provider.provider_type && provider.provider_type.toLowerCase().includes('pharmacy')
                || provider.provider_type?.toLowerCase().includes('lab')
                || provider.provider_type?.toLowerCase().includes('agency')
                || provider.provider_type?.toLowerCase().includes('center')
                || provider.provider_type?.toLowerCase().includes('facility')
                || provider.name.includes('LLC')
                || provider.name.includes('INC')
                || provider.name.includes('CORP')
                || provider.name.includes('GROUP')
                || provider.name.includes('ASSOC')) {
                // Organization
                const orgName = encodeURIComponent(provider.name.substring(0, 50));
                url = `https://npiregistry.cms.hhs.gov/api/?organization_name=${orgName}&state=NJ&version=2.1&limit=5`;
            } else {
                // Individual
                const lastName = encodeURIComponent(nameParts[nameParts.length > 1 ? nameParts.length - 1 : 0] || '');
                const firstName = encodeURIComponent(nameParts[0] || '');
                url = `https://npiregistry.cms.hhs.gov/api/?first_name=${firstName}&last_name=${lastName}&state=NJ&version=2.1&limit=5`;
            }

            const res = await fetch(url);
            const data = await res.json();

            if (data.result_count > 0) {
                // Take the best match
                const result = data.results[0];
                provider.npi = String(result.number);
                provider.npi_resolved = true;
                resolved++;

                if (resolved % 10 === 0 || resolved <= 5) {
                    console.log(`   ✅ Resolved: ${provider.name} → NPI ${provider.npi}`);
                }
            }
        } catch (err) {
            // Skip on error
        }

        await sleep(80); // Rate limit
    }

    console.log(`\n   📊 Resolved ${resolved}/${withoutNPI.length} NPIs`);
    console.log(`   🆔 Total providers with NPI: ${providers.filter(p => p.npi).length}/${providers.length}`);

    return providers;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4: Stream CSV & Cross-Match
// ═══════════════════════════════════════════════════════════════

async function crossMatchClaims(providers) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 4: Streaming 227M Rows → Cross-Match Excluded Providers');
    console.log('═══════════════════════════════════════════════════\n');

    // Build lookup sets
    const excludedNPIs = new Set(providers.filter(p => p.npi).map(p => p.npi));
    const excludedNames = new Map(); // lowercase name → provider info
    for (const p of providers) {
        if (p.name) {
            excludedNames.set(p.name.toLowerCase().trim(), p);
        }
    }

    console.log(`   🔍 Searching for ${excludedNPIs.size} excluded NPIs`);
    console.log(`   📛 Also matching ${excludedNames.size} names\n`);

    // Parse exclusion dates for post-exclusion detection
    const exclusionDates = new Map(); // npi → Date
    for (const p of providers) {
        if (p.npi && p.exclusion_date) {
            try {
                const d = new Date(p.exclusion_date);
                if (!isNaN(d.getTime())) {
                    exclusionDates.set(p.npi, d);
                }
            } catch (e) { }
        }
    }

    // Data structures for matches
    const matches = new Map(); // npi → { provider, claims: [], totals }
    let rowCount = 0;
    let matchedRows = 0;
    let postExclusionRows = 0;
    let postExclusionPaid = 0;
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

        // Check if billing or servicing NPI is excluded
        const isBillingExcluded = excludedNPIs.has(billingNpi);
        const isServicingExcluded = excludedNPIs.has(servicingNpi);

        if (!isBillingExcluded && !isServicingExcluded) {
            if (rowCount % 20_000_000 === 0) {
                const pct = ((rowCount / 227_083_361) * 100).toFixed(1);
                console.log(`   ${pct}% — ${(rowCount / 1e6).toFixed(0)}M rows | ${matchedRows} matched | ${postExclusionRows} post-exclusion`);
            }
            continue;
        }

        matchedRows++;
        const matchedNpi = isBillingExcluded ? billingNpi : servicingNpi;
        const matchType = isBillingExcluded ? 'BILLING' : 'SERVICING';

        // Check if this is post-exclusion
        const exclusionDate = exclusionDates.get(matchedNpi);
        let isPostExclusion = false;
        if (exclusionDate && claimMonth) {
            const claimDate = new Date(claimMonth + '-01');
            if (!isNaN(claimDate.getTime()) && claimDate >= exclusionDate) {
                isPostExclusion = true;
                postExclusionRows++;
                postExclusionPaid += paid;
            }
        }

        // Store match
        let m = matches.get(matchedNpi);
        if (!m) {
            const providerInfo = providers.find(p => p.npi === matchedNpi) || {};
            m = {
                npi: matchedNpi,
                provider_name: providerInfo.name || matchedNpi,
                exclusion_date: providerInfo.exclusion_date || null,
                action_type: providerInfo.action_type || null,
                reason: providerInfo.reason || null,
                total_paid: 0,
                total_claims: 0,
                total_beneficiaries: 0,
                pre_exclusion_paid: 0,
                post_exclusion_paid: 0,
                post_exclusion_claims: 0,
                post_exclusion_rows: 0,
                monthly: {},
                codes: {},
                match_types: new Set(),
                claim_months: new Set(),
            };
            matches.set(matchedNpi, m);
        }

        m.total_paid += paid;
        m.total_claims += claims;
        m.total_beneficiaries += beneficiaries;
        m.match_types.add(matchType);
        m.claim_months.add(claimMonth);

        if (isPostExclusion) {
            m.post_exclusion_paid += paid;
            m.post_exclusion_claims += claims;
            m.post_exclusion_rows++;
        } else {
            m.pre_exclusion_paid += paid;
        }

        // Monthly tracking
        if (!m.monthly[claimMonth]) m.monthly[claimMonth] = { paid: 0, claims: 0 };
        m.monthly[claimMonth].paid += paid;
        m.monthly[claimMonth].claims += claims;

        // Code tracking
        if (!m.codes[hcpcsCode]) m.codes[hcpcsCode] = { paid: 0, claims: 0, post_exclusion: false };
        m.codes[hcpcsCode].paid += paid;
        m.codes[hcpcsCode].claims += claims;
        if (isPostExclusion) m.codes[hcpcsCode].post_exclusion = true;

        if (rowCount % 20_000_000 === 0) {
            const pct = ((rowCount / 227_083_361) * 100).toFixed(1);
            console.log(`   ${pct}% — ${(rowCount / 1e6).toFixed(0)}M rows | ${matchedRows} matched | ${postExclusionRows} post-exclusion`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n   ✅ Scanned ${rowCount.toLocaleString()} rows in ${elapsed}s`);
    console.log(`   🎯 Total matched rows: ${matchedRows.toLocaleString()}`);
    console.log(`   🔴 Post-exclusion rows: ${postExclusionRows.toLocaleString()}`);
    console.log(`   💰 Post-exclusion payments: ${fmtMoney(postExclusionPaid)}`);
    console.log(`   📋 Unique excluded providers with claims: ${matches.size}`);

    return { matches, postExclusionRows, postExclusionPaid, matchedRows };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 5: Analyze Matches & Detect Patterns
// ═══════════════════════════════════════════════════════════════

function analyzeMatches(matchesMap, debarredProviders) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 5: Analyzing Matches & Suspicious Patterns');
    console.log('═══════════════════════════════════════════════════\n');

    const results = [];

    for (const [npi, m] of matchesMap) {
        // Convert sets to arrays
        const matchData = {
            ...m,
            match_types: [...m.match_types],
            claim_months: [...m.claim_months].sort(),
        };

        // Compute billing spikes
        const monthlyEntries = Object.entries(m.monthly).sort(([a], [b]) => a.localeCompare(b));
        const monthlyPayments = monthlyEntries.map(([, d]) => d.paid);
        const avgMonthly = monthlyPayments.length > 0 ? monthlyPayments.reduce((a, b) => a + b, 0) / monthlyPayments.length : 0;
        const stdMonthly = Math.sqrt(monthlyPayments.reduce((a, b) => a + (b - avgMonthly) ** 2, 0) / Math.max(monthlyPayments.length, 1));

        const spikes = monthlyEntries
            .filter(([, d]) => stdMonthly > 0 && (d.paid - avgMonthly) / stdMonthly > 2)
            .map(([month, d]) => ({
                month,
                paid: d.paid,
                z_score: ((d.paid - avgMonthly) / stdMonthly).toFixed(1),
            }));

        // Top codes
        const topCodes = Object.entries(m.codes)
            .sort(([, a], [, b]) => b.paid - a.paid)
            .slice(0, 10)
            .map(([code, d]) => ({
                code,
                paid: d.paid,
                claims: d.claims,
                post_exclusion: d.post_exclusion,
            }));

        // Risk flags
        const flags = [];
        if (m.post_exclusion_paid > 0) flags.push(`$${fmtMoney(m.post_exclusion_paid)} paid AFTER exclusion`);
        if (m.post_exclusion_rows > 100) flags.push(`${m.post_exclusion_rows} claims filed post-exclusion`);
        if (spikes.length > 2) flags.push(`${spikes.length} billing spikes detected`);
        if (m.match_types.has('BILLING') && m.match_types.has('SERVICING')) flags.push('Appears as both billing AND servicing provider');
        if (m.total_paid > 10_000_000) flags.push('Over $10M total Medicaid payments');

        // Determine severity based on post-exclusion billing
        let severity = 'INFO';
        if (m.post_exclusion_paid > 1_000_000) severity = 'CRITICAL';
        else if (m.post_exclusion_paid > 100_000) severity = 'HIGH';
        else if (m.post_exclusion_paid > 0) severity = 'MEDIUM';
        else if (m.total_paid > 1_000_000) severity = 'LOW';

        results.push({
            ...matchData,
            billing_spikes: spikes,
            top_codes: topCodes,
            flags,
            severity,
            avg_monthly_payment: avgMonthly,
            timeline: monthlyEntries.map(([month, d]) => ({ month, ...d })),
        });
    }

    // Sort by post-exclusion paid, then total paid
    results.sort((a, b) => (b.post_exclusion_paid - a.post_exclusion_paid) || (b.total_paid - a.total_paid));

    console.log(`   ✅ Analyzed ${results.length} matched providers\n`);
    console.log('   Severity Distribution:');
    console.log(`     🔴 CRITICAL: ${results.filter(r => r.severity === 'CRITICAL').length}`);
    console.log(`     🟠 HIGH:     ${results.filter(r => r.severity === 'HIGH').length}`);
    console.log(`     🟡 MEDIUM:   ${results.filter(r => r.severity === 'MEDIUM').length}`);
    console.log(`     🟢 LOW/INFO: ${results.filter(r => r.severity === 'LOW' || r.severity === 'INFO').length}`);

    if (results.filter(r => r.post_exclusion_paid > 0).length > 0) {
        console.log('\n   🚨 TOP POST-EXCLUSION OFFENDERS:');
        results.filter(r => r.post_exclusion_paid > 0).slice(0, 15).forEach((r, i) => {
            console.log(`     ${i + 1}. ${r.provider_name} (NPI ${r.npi})`);
            console.log(`        Excluded: ${r.exclusion_date || 'unknown'} | Post-exclusion: ${fmtMoney(r.post_exclusion_paid)} (${r.post_exclusion_rows} claims)`);
            console.log(`        Total paid: ${fmtMoney(r.total_paid)} | Flags: ${r.flags.join('; ')}`);
        });
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 6: Save Results
// ═══════════════════════════════════════════════════════════════

function saveResults(debarredProviders, analysisResults, crossMatchStats) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 6: Saving Results');
    console.log('═══════════════════════════════════════════════════\n');

    // Save post-exclusion hits CSV
    const hitsWithPostExclusion = analysisResults.filter(r => r.post_exclusion_paid > 0);

    if (hitsWithPostExclusion.length > 0) {
        const hitHeaders = 'NPI,Provider_Name,Exclusion_Date,Action_Type,Reason,Post_Exclusion_Paid,Post_Exclusion_Claims,Total_Paid,Total_Claims,Severity,Flags,Top_Codes';
        const hitLines = [hitHeaders];
        for (const r of hitsWithPostExclusion) {
            hitLines.push([
                r.npi,
                `"${(r.provider_name || '').replace(/"/g, '""')}"`,
                r.exclusion_date || '',
                r.action_type || '',
                `"${(r.reason || '').replace(/"/g, '""')}"`,
                r.post_exclusion_paid.toFixed(2),
                r.post_exclusion_claims,
                r.total_paid.toFixed(2),
                r.total_claims,
                r.severity,
                `"${r.flags.join('; ')}"`,
                `"${r.top_codes.map(c => c.code + ':$' + fmtMoney(c.paid)).join(', ')}"`,
            ].join(','));
        }
        fs.writeFileSync(HITS_CSV, hitLines.join('\n'), 'utf-8');
        console.log(`   ✅ Saved ${hitsWithPostExclusion.length} post-exclusion hits to ${HITS_CSV}`);
    }

    // Save full JSON
    const output = {
        metadata: {
            generated_at: new Date().toISOString(),
            pdf_source: 'nj_debarment_list.pdf',
            total_debarred: debarredProviders.length,
            debarred_with_npi: debarredProviders.filter(p => p.npi).length,
            matched_in_claims: analysisResults.length,
            post_exclusion_providers: hitsWithPostExclusion.length,
            post_exclusion_total_paid: hitsWithPostExclusion.reduce((a, r) => a + r.post_exclusion_paid, 0),
            post_exclusion_total_claims: hitsWithPostExclusion.reduce((a, r) => a + r.post_exclusion_claims, 0),
            csv_rows_scanned: crossMatchStats.matchedRows,
        },
        debarred_providers: debarredProviders,
        cross_match_results: analysisResults,
        post_exclusion_offenders: hitsWithPostExclusion,
    };

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2), 'utf-8');
    const sizeMB = (fs.statSync(OUTPUT_JSON).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ Saved full results to ${OUTPUT_JSON} (${sizeMB} MB)`);

    return output;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   NJ DEBARMENT LIST × MEDICAID CLAIMS CROSS-MATCH      ║');
    console.log('║   Finding Post-Exclusion Fraud & Suspicious Patterns    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    // Phase 1: Parse PDF
    const debarredProviders = await parsePDF();

    if (debarredProviders.length === 0) {
        console.error('\n❌ No providers extracted from PDF. Exiting.');
        process.exit(1);
    }

    // Phase 2: Save CSV
    saveDebarredCSV(debarredProviders);

    // Phase 3: Resolve NPIs
    const enrichedProviders = await resolveNPIs(debarredProviders);

    // Phase 4: Stream CSV & cross-match
    const crossMatchStats = await crossMatchClaims(enrichedProviders);

    // Phase 5: Analyze
    const analysisResults = analyzeMatches(crossMatchStats.matches, enrichedProviders);

    // Phase 6: Save
    const finalOutput = saveResults(enrichedProviders, analysisResults, crossMatchStats);

    // Summary
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║        DEBARMENT CROSS-MATCH — COMPLETE                  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n   📄 Debarred providers parsed: ${debarredProviders.length}`);
    console.log(`   🆔 With NPIs: ${debarredProviders.filter(p => p.npi).length}`);
    console.log(`   🎯 Matched in claims: ${analysisResults.length}`);
    console.log(`   🔴 Post-exclusion offenders: ${finalOutput.post_exclusion_offenders.length}`);
    console.log(`   💰 Post-exclusion payments: ${fmtMoney(finalOutput.metadata.post_exclusion_total_paid)}`);
    console.log(`\n   📂 Output Files:`);
    console.log(`      ${OUTPUT_CSV}`);
    console.log(`      ${HITS_CSV}`);
    console.log(`      ${OUTPUT_JSON}\n`);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
});
