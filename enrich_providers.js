#!/usr/bin/env node
/**
 * Provider Enrichment Pipeline
 * ═══════════════════════════════════════
 * 1. NPI Registry Lookup → name, address, city, state, zip
 * 2. Google Search Grounding → real-world fraud context
 * 3. Geographic clustering → hotspot detection
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY });

// ── NPI Registry API (free, no auth needed) ──
async function lookupNPI(npi) {
    const url = `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.result_count > 0) {
            const r = data.results[0];
            const addr = r.addresses?.[0] || {};
            const basic = r.basic || {};
            const taxonomies = r.taxonomies || [];

            return {
                npi,
                provider_name: r.enumeration_type === 'NPI-2'
                    ? basic.organization_name || 'Unknown Org'
                    : `${basic.first_name || ''} ${basic.last_name || ''}`.trim() || 'Unknown',
                provider_type: r.enumeration_type === 'NPI-2' ? 'Organization' : 'Individual',
                address_line1: addr.address_1 || '',
                address_line2: addr.address_2 || '',
                city: addr.city || '',
                state: addr.state || '',
                zip: (addr.postal_code || '').substring(0, 5),
                full_zip: addr.postal_code || '',
                phone: addr.telephone_number || '',
                taxonomy_code: taxonomies[0]?.code || '',
                taxonomy_desc: taxonomies[0]?.desc || '',
                taxonomy_primary: taxonomies[0]?.primary || false,
                enumeration_date: basic.enumeration_date || '',
                last_updated: basic.last_updated || '',
                status: basic.status || '',
                sole_proprietor: basic.sole_proprietor || '',
            };
        }
        return { npi, error: 'Not found in NPI registry' };
    } catch (err) {
        return { npi, error: err.message };
    }
}

// ── Google Search Grounding for fraud investigation ──
async function groundedFraudSearch(providers) {
    console.log('\n🔍 Phase 2: Google Search Grounding — investigating fraud...');

    const providerSummary = providers.slice(0, 25).map(p => ({
        npi: p.npi,
        name: p.provider_name,
        city: p.city,
        state: p.state,
        zip: p.zip,
        total_paid: p.total_paid,
        total_claims: p.total_claims,
        type: p.provider_type,
        specialty: p.taxonomy_desc,
    }));

    const prompt = `You are a Medicaid fraud investigator. Research these suspicious healthcare providers using Google Search to find:

1. **Known fraud cases** — Any OIG exclusions, DOJ settlements, state AG actions, or news articles about fraud
2. **Provider verification** — Whether these entities appear to be legitimate healthcare operations
3. **Geographic fraud hotspots** — Areas with concentrated suspicious billing
4. **HCPCS code fraud patterns** — Common billing codes associated with fraud schemes
5. **Industry context** — Current Medicaid fraud trends and enforcement actions

For each provider where you find real-world information, include the source URL.

IMPORTANT: Focus on finding the WORST, most egregious fraud cases. Look for:
- Providers with absurdly high billing (billions in claims)
- Ghost providers (billing from addresses that aren't medical facilities)
- Known exclusion list entries
- Criminal indictments or convictions

Providers to investigate:
${JSON.stringify(providerSummary, null, 2)}

Respond with a comprehensive investigation report in Markdown format. Include a section on geographic fraud hotspots by zip code and state.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.3,
                maxOutputTokens: 16000,
            },
        });

        const text = response.text || '';
        const grounding = response.candidates?.[0]?.groundingMetadata || {};

        console.log(`   ✅ Grounded investigation complete (${text.length} chars)`);
        if (grounding.searchEntryPoint) {
            console.log(`   🔗 Search queries used for grounding`);
        }

        return {
            report: text,
            groundingMetadata: grounding,
            searchQueries: grounding.webSearchQueries || [],
            sources: (grounding.groundingSupports || []).map(s => ({
                text: s.segment?.text || '',
                urls: (s.groundingChunkIndices || []).map(i =>
                    grounding.groundingChunks?.[i]?.web?.uri || ''
                ).filter(Boolean),
            })),
        };

    } catch (err) {
        console.error(`   ❌ Grounding error: ${err.message}`);
        return { report: '', error: err.message };
    }
}

// ── Geographic Clustering ──
function analyzeGeography(enrichedProviders) {
    console.log('\n📍 Phase 3: Geographic analysis...');

    const byState = {};
    const byZip = {};
    const byCity = {};

    for (const p of enrichedProviders) {
        if (!p.state || p.error) continue;

        // State aggregation
        if (!byState[p.state]) byState[p.state] = { count: 0, total_paid: 0, providers: [] };
        byState[p.state].count++;
        byState[p.state].total_paid += p.total_paid || 0;
        byState[p.state].providers.push(p.npi);

        // Zip aggregation
        if (p.zip) {
            if (!byZip[p.zip]) byZip[p.zip] = { count: 0, total_paid: 0, state: p.state, city: p.city, providers: [] };
            byZip[p.zip].count++;
            byZip[p.zip].total_paid += p.total_paid || 0;
            byZip[p.zip].providers.push(p.npi);
        }

        // City aggregation
        const cityKey = `${p.city}, ${p.state}`;
        if (!byCity[cityKey]) byCity[cityKey] = { count: 0, total_paid: 0, providers: [] };
        byCity[cityKey].count++;
        byCity[cityKey].total_paid += p.total_paid || 0;
        byCity[cityKey].providers.push(p.npi);
    }

    // Sort by total_paid descending
    const stateRanking = Object.entries(byState)
        .map(([state, d]) => ({ state, ...d }))
        .sort((a, b) => b.total_paid - a.total_paid);

    const zipHotspots = Object.entries(byZip)
        .map(([zip, d]) => ({ zip, ...d }))
        .filter(z => z.count >= 2)
        .sort((a, b) => b.total_paid - a.total_paid);

    const cityHotspots = Object.entries(byCity)
        .map(([city, d]) => ({ city, ...d }))
        .sort((a, b) => b.total_paid - a.total_paid)
        .slice(0, 50);

    console.log(`   📊 ${stateRanking.length} states, ${zipHotspots.length} zip hotspots, ${cityHotspots.length} city hotspots`);

    return { stateRanking, zipHotspots, cityHotspots };
}

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════
async function main() {
    const providersPath = path.join(__dirname, 'hf_dataset', 'provider_statistics.json');
    const providers = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
    const statsPath = path.join(__dirname, 'fraud_analysis', 'statistical_analysis.json');
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    const outliers = stats.outlier_providers || [];

    // Merge: top 100 outliers + top 200 by total_paid
    const topNPIs = new Set();
    for (const o of outliers) topNPIs.add(o.npi);
    for (const p of providers.slice(0, 200)) topNPIs.add(p.billing_provider_npi);
    const npiList = [...topNPIs];

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Provider Enrichment Pipeline`);
    console.log(`  ${npiList.length} unique NPIs to enrich`);
    console.log(`═══════════════════════════════════════\n`);

    // ── Phase 1: NPI Registry Lookups ──
    console.log('📋 Phase 1: NPI Registry lookups...');
    const enriched = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < npiList.length; i += BATCH_SIZE) {
        const batch = npiList.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(lookupNPI));

        for (const r of results) {
            // Merge with financial data
            const provData = providers.find(p => p.billing_provider_npi === r.npi);
            const outlierData = outliers.find(o => o.npi === r.npi);

            enriched.push({
                ...r,
                total_paid: provData?.total_paid || outlierData?.total_paid || 0,
                total_claims: provData?.total_claims || outlierData?.total_claims || 0,
                z_score: outlierData?.z_score || 0,
                unique_procedures: provData?.unique_hcpcs_codes || outlierData?.unique_procedures || 0,
                months_active: provData?.months_active || outlierData?.months_active || 0,
                avg_payment_per_claim: provData?.avg_payment_per_claim || outlierData?.avg_payment_per_claim || 0,
                hcpcs_codes: provData?.hcpcs_codes_list || outlierData?.procedures || [],
                risk_level: outlierData
                    ? (outlierData.z_score > 10 ? 'CRITICAL' : outlierData.z_score > 5 ? 'HIGH' : 'MEDIUM')
                    : 'LOW',
            });
        }

        const done = Math.min(i + BATCH_SIZE, npiList.length);
        process.stdout.write(`   ✅ ${done}/${npiList.length} lookups complete\r`);

        // Gentle rate limit for NPI API
        if (i + BATCH_SIZE < npiList.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
    console.log();

    const found = enriched.filter(e => !e.error).length;
    console.log(`   📊 ${found}/${enriched.length} NPIs resolved (${enriched.filter(e => e.error).length} not found)`);

    // ── Phase 2: Google Search Grounding ──
    const validProviders = enriched.filter(e => !e.error);
    const groundingResult = await groundedFraudSearch(validProviders);

    // ── Phase 3: Geographic Analysis ──
    const geo = analyzeGeography(validProviders);

    // ── Save Everything ──
    const output = {
        metadata: {
            generated_at: new Date().toISOString(),
            total_enriched: enriched.length,
            resolved: found,
            not_found: enriched.filter(e => e.error).length,
        },
        providers: enriched.sort((a, b) => (b.total_paid || 0) - (a.total_paid || 0)),
        geographic_analysis: geo,
        grounded_investigation: {
            report: groundingResult.report,
            search_queries: groundingResult.searchQueries || [],
            sources: groundingResult.sources || [],
        },
    };

    const outPath = path.join(__dirname, 'fraud_analysis', 'enriched_providers.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\n💾 Saved enriched data to ${outPath}`);
    console.log(`   📊 ${output.providers.length} providers with location data`);
    console.log(`   📍 ${geo.stateRanking.length} states analyzed`);
    console.log(`   🔥 ${geo.zipHotspots.length} zip code hotspots`);
    console.log(`   🔍 ${groundingResult.searchQueries?.length || 0} grounded search queries\n`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
