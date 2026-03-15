#!/usr/bin/env node
/**
 * NJ FRAUD HUNTER — Deep Culprit Investigation & Reporting Guide
 * ═══════════════════════════════════════════════════════════════
 * 
 * Phase 1: Load all existing analysis (deep dive + debarment cross-match)
 * Phase 2: NPI Registry deep lookup for every suspect (owner, address, affiliations)
 * Phase 3: Gemini + Google Search grounding — individual deep investigations
 * Phase 4: Business entity research (NJ business registry, ownership chains)
 * Phase 5: Generate prosecution-ready culprit dossiers
 * Phase 6: Generate comprehensive reporting guide with exact contacts/forms
 * Phase 7: Save everything → fraud_analysis/nj_culprit_dossiers.json + .md
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY });

const OUTPUT_DIR = path.join(__dirname, 'fraud_analysis');
const DEEP_DIVE_PATH = path.join(OUTPUT_DIR, 'nj_deep_dive.json');
const DEBARMENT_PATH = path.join(OUTPUT_DIR, 'debarment_cross_match.json');
const DOSSIER_PATH = path.join(OUTPUT_DIR, 'nj_culprit_dossiers.json');
const REPORT_PATH = path.join(OUTPUT_DIR, 'nj_fraud_report_full.md');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtMoney(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Load All Existing Analysis
// ═══════════════════════════════════════════════════════════════

function loadExistingData() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 1: Loading All Existing NJ Fraud Data');
    console.log('═══════════════════════════════════════════════════\n');

    let deepDive = null;
    let debarment = null;

    if (fs.existsSync(DEEP_DIVE_PATH)) {
        deepDive = JSON.parse(fs.readFileSync(DEEP_DIVE_PATH, 'utf-8'));
        console.log(`   ✅ NJ Deep Dive: ${deepDive.providers?.length || 0} providers, ${deepDive.investigations?.length || 0} investigated`);
    } else {
        console.log('   ⚠️  No deep dive data found. Run nj_deep_dive.js first.');
    }

    if (fs.existsSync(DEBARMENT_PATH)) {
        debarment = JSON.parse(fs.readFileSync(DEBARMENT_PATH, 'utf-8'));
        console.log(`   ✅ Debarment Cross-Match: ${debarment.metadata?.total_debarred || 0} debarred, ${debarment.post_exclusion_offenders?.length || 0} post-exclusion`);
    } else {
        console.log('   ⚠️  No debarment data found. Run parse_debarment.js first.');
    }

    return { deepDive, debarment };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: NPI Registry Deep Lookup
// ═══════════════════════════════════════════════════════════════

async function deepNPILookup(npi) {
    try {
        const url = `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.result_count > 0) {
            const r = data.results[0];
            const basic = r.basic || {};
            const addresses = r.addresses || [];
            const taxonomies = r.taxonomies || [];
            const identifiers = r.identifiers || [];
            const otherNames = r.other_names || [];
            const endpoints = r.endpoints || [];

            let name = '';
            let entityType = '';
            if (r.enumeration_type === 'NPI-2') {
                name = basic.organization_name || '';
                entityType = 'Organization';
            } else {
                name = [basic.name_prefix, basic.first_name, basic.middle_name, basic.last_name, basic.name_suffix]
                    .filter(Boolean).join(' ');
                entityType = 'Individual';
            }

            return {
                npi,
                name,
                entity_type: entityType,
                enumeration_type: r.enumeration_type,
                authorized_official: basic.authorized_official_first_name
                    ? `${basic.authorized_official_first_name} ${basic.authorized_official_last_name}`
                    : null,
                authorized_official_title: basic.authorized_official_title_or_position || null,
                authorized_official_phone: basic.authorized_official_telephone_number || null,
                gender: basic.gender || null,
                sole_proprietor: basic.sole_proprietor || null,
                organization_subpart: basic.organization_subpart || null,
                parent_organization: basic.parent_organization_legal_business_name || null,
                addresses: addresses.map(a => ({
                    type: a.address_purpose,
                    line1: a.address_1,
                    line2: a.address_2 || '',
                    city: a.city,
                    state: a.state,
                    zip: (a.postal_code || '').substring(0, 5),
                    full_zip: a.postal_code,
                    phone: a.telephone_number || '',
                    fax: a.fax_number || '',
                })),
                taxonomies: taxonomies.map(t => ({
                    code: t.code,
                    desc: t.desc,
                    primary: t.primary,
                    state: t.state,
                    license: t.license,
                })),
                other_identifiers: identifiers.map(id => ({
                    identifier: id.identifier,
                    type: id.desc,
                    state: id.state,
                    issuer: id.issuer,
                })),
                other_names: otherNames.map(n => ({
                    type: n.type,
                    name: n.organization_name || `${n.first_name || ''} ${n.last_name || ''}`.trim(),
                })),
                enumeration_date: basic.enumeration_date,
                last_updated: basic.last_updated,
                deactivation_date: basic.deactivation_date || null,
                deactivation_reason: basic.deactivation_reason_code || null,
                reactivation_date: basic.reactivation_date || null,
                status: basic.status || 'A',
                found: true,
            };
        }
        return { npi, found: false };
    } catch (err) {
        return { npi, found: false, error: err.message };
    }
}

async function batchNPILookup(suspects) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 2: Deep NPI Registry Lookup for All Suspects');
    console.log('═══════════════════════════════════════════════════\n');

    const results = new Map();
    let count = 0;

    for (const suspect of suspects) {
        count++;
        const npi = suspect.npi;
        if (!npi || results.has(npi)) continue;

        console.log(`   [${count}/${suspects.length}] Looking up NPI ${npi} — ${suspect.name || 'Unknown'}...`);
        const result = await deepNPILookup(npi);
        results.set(npi, result);

        if (result.found) {
            const addr = result.addresses[0];
            console.log(`      ✅ ${result.name} | ${addr?.city}, ${addr?.state} ${addr?.zip}`);
            if (result.authorized_official) {
                console.log(`      👤 Authorized Official: ${result.authorized_official} (${result.authorized_official_title || 'title N/A'})`);
            }
            if (result.parent_organization) {
                console.log(`      🏢 Parent: ${result.parent_organization}`);
            }
            if (result.other_names.length > 0) {
                console.log(`      📛 Also known as: ${result.other_names.map(n => n.name).join(', ')}`);
            }
            if (result.deactivation_date) {
                console.log(`      ⚠️  DEACTIVATED: ${result.deactivation_date} (Reason: ${result.deactivation_reason})`);
            }
        } else {
            console.log(`      ❌ Not found in NPI Registry`);
        }

        await sleep(100);
    }

    console.log(`\n   ✅ Completed ${results.size} NPI lookups`);
    return results;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: Gemini + Google Search Deep Investigation
// ═══════════════════════════════════════════════════════════════

async function deepInvestigate(suspect, npiData) {
    const npi = npiData?.found ? npiData : null;
    const addresses = npi?.addresses?.map(a => `${a.line1}, ${a.city} ${a.state} ${a.zip}`).join('; ') || 'Unknown';
    const taxonomies = npi?.taxonomies?.map(t => t.desc).join(', ') || 'Unknown';
    const otherNames = npi?.other_names?.map(n => n.name).join(', ') || 'None';
    const parentOrg = npi?.parent_organization || 'None';
    const authOfficial = npi?.authorized_official || 'Unknown';

    const prompt = `You are a senior forensic fraud investigator working for the New Jersey Attorney General's Medicaid Fraud Control Unit (MFCU). Conduct an exhaustive investigation into this suspect.

═══ SUSPECT PROFILE ═══
Name: ${suspect.name}
NPI: ${suspect.npi}
Entity Type: ${npi?.entity_type || suspect.entity_type || 'Unknown'}
Addresses: ${addresses}
Specialties: ${taxonomies}
Other Names/DBAs: ${otherNames}
Parent Organization: ${parentOrg}
Authorized Official: ${authOfficial}
NPI Status: ${npi?.status || 'Unknown'} ${npi?.deactivation_date ? `(DEACTIVATED ${npi.deactivation_date})` : ''}

═══ FRAUD INDICATORS ═══
Total Medicaid Paid: $${(suspect.total_paid || 0).toLocaleString()}
${suspect.post_exclusion_paid ? `POST-EXCLUSION PAYMENTS: $${suspect.post_exclusion_paid.toLocaleString()} (PAID AFTER BEING EXCLUDED FROM MEDICAID)` : ''}
${suspect.post_exclusion_claims ? `Post-Exclusion Claims: ${suspect.post_exclusion_claims}` : ''}
${suspect.exclusion_date ? `Exclusion Date: ${suspect.exclusion_date}` : ''}
${suspect.action_type ? `Action Type: ${suspect.action_type}` : ''}
${suspect.reason ? `Reason: ${suspect.reason}` : ''}
Risk Score: ${suspect.risk_score || 'N/A'}
Red Flags: ${(suspect.red_flags || suspect.flags || []).join('; ') || 'N/A'}
${suspect.top_codes ? `Top Billing Codes: ${suspect.top_codes.slice(0, 5).map(c => typeof c === 'object' ? `${c.code}: $${c.paid?.toLocaleString()}` : c).join(', ')}` : ''}

═══ INVESTIGATION ORDERS ═══
Search exhaustively for ALL of the following:

1. **CRIMINAL HISTORY**: Any criminal charges, indictments, arrests, convictions related to healthcare fraud, Medicare/Medicaid fraud, kickbacks, false claims, or any other crimes
2. **CIVIL ENFORCEMENT**: DOJ civil False Claims Act cases, qui tam whistleblower lawsuits, state AG enforcement actions, settlement agreements
3. **EXCLUSION STATUS**: OIG LEIE exclusion list status, GSA SAM.gov debarment, NJ state-level debarment/disqualification
4. **BUSINESS RECORDS**: NJ Division of Revenue business registration, corporate officers, registered agents, ownership structure, affiliated entities, DBA names
5. **LICENSING**: Medical license status, disciplinary actions by NJ Board of Medical Examiners or other licensing boards, DEA registration status
6. **MEDIA & NEWS**: News articles, press releases, investigative reports about this provider or their business
7. **COURT RECORDS**: Any civil or criminal court cases (federal or NJ state)
8. **NETWORK ANALYSIS**: Known associates, business partners, related entities that may be part of a billing scheme
9. **REAL ESTATE**: Business location details — is it a legitimate medical facility or a questionable storefront?
10. **SPECIFIC NJ CONTEXT**: Any connection to known NJ Medicaid fraud rings, personal care attendant schemes, home health fraud, prescription drug mills

For EACH finding, provide:
- Source URL
- Date of action/finding
- Specific details (case numbers, dollar amounts, charges)
- Current status

Be thorough and specific. Include EVERYTHING you find.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.1,
                maxOutputTokens: 8192,
            },
        });

        const grounding = response.candidates?.[0]?.groundingMetadata || {};
        const sources = (grounding.groundingChunks || [])
            .filter(c => c.web?.uri)
            .map(c => ({ title: c.web.title || '', url: c.web.uri }));

        return {
            report: response.text || '',
            sources,
            search_queries: grounding.webSearchQueries || [],
        };
    } catch (err) {
        console.error(`      ❌ Investigation error: ${err.message}`);
        return { report: `Error: ${err.message}`, sources: [], search_queries: [] };
    }
}

async function investigateAllSuspects(suspects, npiResults) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 3: Deep Google Search Investigation per Suspect');
    console.log('═══════════════════════════════════════════════════\n');

    console.log(`   🔍 Investigating ${suspects.length} suspects with exhaustive Google Search...\n`);

    const investigations = [];

    for (let i = 0; i < suspects.length; i++) {
        const suspect = suspects[i];
        const npiData = npiResults.get(suspect.npi);

        console.log(`   [${i + 1}/${suspects.length}] 🔎 ${suspect.name} (NPI ${suspect.npi})...`);

        const result = await deepInvestigate(suspect, npiData);

        investigations.push({
            npi: suspect.npi,
            name: suspect.name,
            investigation: result.report,
            sources: result.sources,
            search_queries: result.search_queries,
        });

        console.log(`      ✅ ${result.sources.length} sources, ${result.report.length} chars`);

        // Rate limit
        await sleep(2000);
    }

    console.log(`\n   ✅ Completed ${investigations.length} deep investigations`);
    return investigations;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4: Business Entity Research
// ═══════════════════════════════════════════════════════════════

async function researchBusinessEntities(suspects, npiResults) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 4: Business Entity & Ownership Research');
    console.log('═══════════════════════════════════════════════════\n');

    // Build a summary of all suspects for batch research
    const suspectList = suspects.map(s => {
        const npi = npiResults.get(s.npi);
        return `- ${s.name} (NPI: ${s.npi}) — ${npi?.entity_type || 'Unknown'} — ${npi?.addresses?.[0]?.city || 'Unknown'}, NJ — Total Paid: $${(s.total_paid || 0).toLocaleString()}${s.post_exclusion_paid ? ` — POST-EXCLUSION: $${s.post_exclusion_paid.toLocaleString()}` : ''}${npi?.parent_organization ? ` — Parent: ${npi.parent_organization}` : ''}${npi?.authorized_official ? ` — Auth Official: ${npi.authorized_official}` : ''}`;
    }).join('\n');

    const prompt = `You are a forensic business intelligence analyst working for the NJ Attorney General's Medicaid Fraud Unit.

Research these NJ Medicaid fraud suspects and find their business connections, ownership structures, and affiliated entities:

${suspectList}

For EACH suspect, search for and provide:
1. **NJ Division of Revenue** business registration (entity name, filing number, formation date, status, registered agent)
2. **Corporate officers and owners** — Who actually controls this business? Names, titles, ownership percentages
3. **Affiliated entities** — Other businesses at the same address, with the same owners, or with the same authorized official
4. **DBA names** — Any "doing business as" names
5. **Business type** — LLC, Corp, sole proprietorship, non-profit, etc.
6. **Physical location** — Is this a real medical facility, a residential address, a strip mall, a PO box?
7. **Connections between suspects** — Do any of these suspects share addresses, owners, billing networks?

Be specific with business registration numbers, filing dates, and officer names. Search for NJ business records, Secretary of State filings, and any corporate registry information.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.1,
                maxOutputTokens: 8192,
            },
        });

        const grounding = response.candidates?.[0]?.groundingMetadata || {};
        const sources = (grounding.groundingChunks || [])
            .filter(c => c.web?.uri)
            .map(c => ({ title: c.web.title || '', url: c.web.uri }));

        console.log(`   ✅ Business research complete: ${sources.length} sources, ${response.text?.length || 0} chars`);

        return {
            report: response.text || '',
            sources,
        };
    } catch (err) {
        console.error(`   ❌ Business research error: ${err.message}`);
        return { report: `Error: ${err.message}`, sources: [] };
    }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 5: Generate Prosecution-Ready Culprit Dossiers
// ═══════════════════════════════════════════════════════════════

async function generateDossiers(suspects, npiResults, investigations, businessResearch) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 5: Generating Prosecution-Ready Dossiers');
    console.log('═══════════════════════════════════════════════════\n');

    const dossiers = [];

    for (const suspect of suspects) {
        const npi = npiResults.get(suspect.npi);
        const inv = investigations.find(i => i.npi === suspect.npi);

        const dossier = {
            // Identity
            npi: suspect.npi,
            name: suspect.name,
            entity_type: npi?.entity_type || suspect.entity_type || 'Unknown',

            // Addresses
            addresses: npi?.addresses || [],

            // Ownership
            authorized_official: npi?.authorized_official || null,
            authorized_official_title: npi?.authorized_official_title || null,
            authorized_official_phone: npi?.authorized_official_phone || null,
            parent_organization: npi?.parent_organization || null,
            other_names: npi?.other_names || [],

            // Medical Licensing
            taxonomies: npi?.taxonomies || [],
            other_identifiers: npi?.other_identifiers || [],

            // NPI Status
            npi_status: npi?.status || null,
            enumeration_date: npi?.enumeration_date || null,
            deactivation_date: npi?.deactivation_date || null,
            deactivation_reason: npi?.deactivation_reason || null,

            // Financial exposure
            total_medicaid_paid: suspect.total_paid || 0,
            post_exclusion_paid: suspect.post_exclusion_paid || 0,
            post_exclusion_claims: suspect.post_exclusion_claims || 0,
            exclusion_date: suspect.exclusion_date || null,
            action_type: suspect.action_type || null,
            reason: suspect.reason || null,

            // Risk assessment
            risk_score: suspect.risk_score || 0,
            risk_level: suspect.risk_level || 'UNKNOWN',
            red_flags: suspect.red_flags || suspect.flags || [],
            severity: suspect.severity || 'UNKNOWN',

            // Billing patterns
            top_codes: suspect.top_codes || [],
            self_ref_pct: suspect.self_ref_pct || 0,
            trend: suspect.trend || null,
            temporal_anomalies: suspect.temporal_anomalies || [],

            // Investigation findings
            investigation_report: inv?.investigation || '',
            investigation_sources: inv?.sources || [],
            investigation_queries: inv?.search_queries || [],

            // Computed severity
            fraud_category: categorize(suspect),
        };

        dossiers.push(dossier);
    }

    console.log(`   ✅ Generated ${dossiers.length} culprit dossiers`);
    return dossiers;
}

function categorize(suspect) {
    const categories = [];
    if (suspect.post_exclusion_paid > 0) categories.push('POST-EXCLUSION BILLING (Federal crime)');
    if (suspect.post_exclusion_paid > 100000) categories.push('MAJOR POST-EXCLUSION ($100K+)');
    if ((suspect.risk_level === 'CRITICAL' || suspect.risk_score >= 50) && suspect.total_paid > 100000000) categories.push('MEGA-BILLER ($100M+)');
    if (suspect.self_ref_pct > 95) categories.push('SELF-REFERRAL SCHEME');
    if ((suspect.red_flags || suspect.flags || []).some(f => /benford/i.test(f))) categories.push('STATISTICAL ANOMALY');
    if ((suspect.red_flags || suspect.flags || []).some(f => /impossible|volume/i.test(f))) categories.push('IMPOSSIBLE VOLUME');
    if ((suspect.red_flags || suspect.flags || []).some(f => /hub.*spoke/i.test(f))) categories.push('HUB-AND-SPOKE NETWORK');
    if (categories.length === 0) categories.push('SUSPICIOUS BILLING PATTERN');
    return categories;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 6: Comprehensive Reporting Guide
// ═══════════════════════════════════════════════════════════════

async function generateReportingGuide(dossiers, businessResearch) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 6: Generating Prosecution & Reporting Guide');
    console.log('═══════════════════════════════════════════════════\n');

    // Build dossier summaries for the AI
    const dossierSummaries = dossiers.map((d, i) => {
        return `
### SUSPECT ${i + 1}: ${d.name}
- NPI: ${d.npi}
- Entity Type: ${d.entity_type}
- Addresses: ${d.addresses.map(a => `${a.line1}, ${a.city}, ${a.state} ${a.zip} (${a.type})`).join('; ')}
- Phone: ${d.addresses[0]?.phone || 'N/A'}
- Authorized Official: ${d.authorized_official || 'N/A'} (${d.authorized_official_title || 'N/A'})
- Parent Organization: ${d.parent_organization || 'N/A'}
- Specialties: ${d.taxonomies.map(t => t.desc).join(', ') || 'N/A'}
- Total Medicaid Paid: $${d.total_medicaid_paid.toLocaleString()}
${d.post_exclusion_paid ? `- 🚨 POST-EXCLUSION PAYMENTS: $${d.post_exclusion_paid.toLocaleString()} (${d.post_exclusion_claims} claims after ${d.exclusion_date} exclusion)` : ''}
- Risk: ${d.risk_level} (Score: ${d.risk_score}) | Categories: ${d.fraud_category.join(', ')}
- Red Flags: ${d.red_flags.join('; ')}
- NPI Status: ${d.npi_status || 'Unknown'} ${d.deactivation_date ? `(DEACTIVATED: ${d.deactivation_date})` : ''}
- Investigation Summary: ${(d.investigation_report || '').substring(0, 500)}...
- Sources Found: ${d.investigation_sources.length}`;
    }).join('\n');

    const prompt = `You are the Chief Investigator of the New Jersey Medicaid Fraud Control Unit. Write an extraordinary, prosecutable-quality comprehensive fraud investigation report and reporting guide.

═══ SUSPECTS ═══
${dossierSummaries}

═══ BUSINESS INTELLIGENCE ═══
${(businessResearch?.report || '').substring(0, 4000)}

═══ REPORT REQUIREMENTS ═══

Write a full, official-quality Medicaid Fraud Investigation Report with these EXACT sections:

## 1. EXECUTIVE SUMMARY
- Total fraud exposure for NJ
- Number of suspects by category
- Most egregious offenders
- Estimated recoverable amounts

## 2. POST-EXCLUSION FRAUD (FEDERAL CRIMES)
For EACH post-exclusion offender:
- Full name, NPI, business address
- Date of exclusion and reason  
- Total paid AFTER exclusion (this is the federal crime amount)
- Number of claims after exclusion
- Why this constitutes a violation of 42 U.S.C. § 1320a-7b (Criminal penalties for acts involving Federal health care programs)
- Specific charges that could be filed

## 3. HIGH-RISK PROVIDER ANALYSIS
For each CRITICAL/HIGH risk provider:
- Full profile (name, NPI, address, specialty, owner)
- Total Medicaid payments received
- Specific fraud indicators found
- Red flags and statistical anomalies
- What the Google Search investigation revealed

## 4. BUSINESS ENTITY & OWNERSHIP ANALYSIS
- Corporate structures and ownership chains
- Connections between suspects
- Affiliated entities and DBAs

## 5. BILLING PATTERN ANALYSIS
- HCPCS codes being exploited
- Self-referral schemes
- Temporal billing anomalies
- Hub-and-spoke billing networks

## 6. HOW TO REPORT EACH SUSPECT

### Federal Reporting:
For each suspect, provide EXACT instructions:
a) **OIG Hotline** — 1-800-HHS-TIPS (1-800-447-8477) — tips.oig.hhs.gov
   - What to include in the tip
   - Reference numbers to cite
b) **FBI Healthcare Fraud** — tips.fbi.gov — Newark Field Office: (973) 792-3000
c) **DOJ Civil Division** — False Claims Act / qui tam
d) **CMS** — If provider is still billing, emergency suspension request

### NJ State Reporting:
For each suspect:
a) **NJ Attorney General MFCU** — (609) 292-8740 — medicaidfraud@njoag.gov
   - What evidence to submit
b) **NJ Division of Medical Assistance & Health Services** — Provider enrollment/exclusion
c) **NJ Board of Medical Examiners** — If applicable for licensed providers
d) **NJ Division of Consumer Affairs**

### Qui Tam (Whistleblower) Information:
- How to file a False Claims Act lawsuit
- Whistleblower protections under 31 U.S.C. § 3730
- Potential whistleblower recovery (15-30% of recovered funds)

## 7. EVIDENCE PRESERVATION GUIDE
- What data files to reference
- How to present the statistical evidence
- Chain of custody recommendations

## 8. ESTIMATED FINANCIAL IMPACT
- Total suspected fraudulent billing
- Potential recoveries under False Claims Act (treble damages + $11K-$23K per false claim)
- Post-exclusion amounts (automatic federal crime)

## 9. RECOMMENDED IMMEDIATE ACTIONS
Priority-ranked list of enforcement actions

Be extremely specific with names, NPIs, addresses, dollar amounts, dates, statutes, and phone numbers. This document should be ready to hand to a prosecutor or submit to the OIG.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                temperature: 0.2,
                maxOutputTokens: 32000,
                thinkingConfig: { thinkingBudget: 8192 },
            },
        });

        const report = response.text || '';
        console.log(`   ✅ Report generated: ${report.length} chars, ${report.split('\n').length} lines`);
        return report;
    } catch (err) {
        console.error(`   ❌ Report generation error: ${err.message}`);
        // Fallback to Flash
        try {
            console.log('   🔄 Retrying with Flash...');
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    temperature: 0.2,
                    maxOutputTokens: 16000,
                },
            });
            return response.text || 'Report generation failed.';
        } catch (err2) {
            return `Report generation failed: ${err2.message}`;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║     NJ FRAUD HUNTER — Culprit Investigation & Reporting  ║');
    console.log('║     Finding Names • Businesses • How to Report Them All  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    // Phase 1: Load existing data
    const { deepDive, debarment } = loadExistingData();

    if (!deepDive && !debarment) {
        console.log('\n❌ No data to investigate. Run nj_deep_dive.js and parse_debarment.js first.');
        return;
    }

    // Build the suspect list — combine post-exclusion offenders + high-risk providers
    const suspects = [];
    const seenNPIs = new Set();

    // Priority 1: Post-exclusion offenders (these are federal crimes)
    if (debarment?.post_exclusion_offenders) {
        for (const offender of debarment.post_exclusion_offenders) {
            if (seenNPIs.has(offender.npi)) continue;
            seenNPIs.add(offender.npi);
            suspects.push({
                npi: offender.npi,
                name: offender.provider_name,
                total_paid: offender.total_paid || 0,
                post_exclusion_paid: offender.post_exclusion_paid || 0,
                post_exclusion_claims: offender.post_exclusion_claims || 0,
                exclusion_date: offender.exclusion_date,
                action_type: offender.action_type,
                reason: offender.reason,
                flags: offender.flags || [],
                severity: offender.severity,
                top_codes: offender.top_codes || [],
                billing_spikes: offender.billing_spikes || [],
                category: 'POST-EXCLUSION',
            });
        }
        console.log(`\n   🚨 ${suspects.length} POST-EXCLUSION offenders (federal crime suspects)`);
    }

    // Priority 2: All cross-match results with claims
    if (debarment?.cross_match_results) {
        for (const result of debarment.cross_match_results) {
            if (seenNPIs.has(result.npi)) continue;
            seenNPIs.add(result.npi);
            suspects.push({
                npi: result.npi,
                name: result.provider_name,
                total_paid: result.total_paid || 0,
                post_exclusion_paid: result.post_exclusion_paid || 0,
                post_exclusion_claims: result.post_exclusion_claims || 0,
                exclusion_date: result.exclusion_date,
                action_type: result.action_type,
                reason: result.reason,
                flags: result.flags || [],
                severity: result.severity,
                top_codes: result.top_codes || [],
                category: 'DEBARMENT-MATCH',
            });
        }
        console.log(`   🔍 ${suspects.length} total debarment cross-match suspects`);
    }

    // Priority 3: CRITICAL and HIGH risk from deep dive
    if (deepDive?.providers) {
        const highRisk = deepDive.providers.filter(p =>
            (p.risk_level === 'CRITICAL' || p.risk_level === 'HIGH') && !seenNPIs.has(p.npi)
        );
        for (const p of highRisk) {
            seenNPIs.add(p.npi);
            suspects.push({
                npi: p.npi,
                name: p.provider_name,
                total_paid: p.total_paid || 0,
                risk_score: p.risk_score,
                risk_level: p.risk_level,
                red_flags: p.red_flags || [],
                top_codes: p.top_codes || [],
                self_ref_pct: p.self_ref_pct || 0,
                trend: p.trend,
                temporal_anomalies: p.temporal_anomalies || [],
                entity_type: p.provider_type,
                category: 'HIGH-RISK',
            });
        }
        console.log(`   🔴 ${suspects.length} total suspects (added ${highRisk.length} CRITICAL/HIGH from deep dive)`);
    }

    console.log(`\n   📋 TOTAL SUSPECTS TO INVESTIGATE: ${suspects.length}`);

    // Phase 2: Deep NPI Registry lookup
    const npiResults = await batchNPILookup(suspects);

    // Phase 3: Deep Google Search investigation
    const investigations = await investigateAllSuspects(suspects, npiResults);

    // Phase 4: Business entity research
    const businessResearch = await researchBusinessEntities(suspects, npiResults);

    // Phase 5: Generate dossiers
    const dossiers = await generateDossiers(suspects, npiResults, investigations, businessResearch);

    // Phase 6: Generate comprehensive reporting guide
    const fullReport = await generateReportingGuide(dossiers, businessResearch);

    // Phase 7: Save everything
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  PHASE 7: Saving All Results');
    console.log('═══════════════════════════════════════════════════\n');

    const output = {
        metadata: {
            generated_at: new Date().toISOString(),
            total_suspects: suspects.length,
            post_exclusion_offenders: suspects.filter(s => s.category === 'POST-EXCLUSION').length,
            debarment_matches: suspects.filter(s => s.category === 'DEBARMENT-MATCH').length,
            high_risk: suspects.filter(s => s.category === 'HIGH-RISK').length,
            total_sources: investigations.reduce((a, i) => a + (i.sources?.length || 0), 0) + (businessResearch.sources?.length || 0),
            total_fraud_exposure: suspects.reduce((a, s) => a + (s.total_paid || 0), 0),
            total_post_exclusion: suspects.reduce((a, s) => a + (s.post_exclusion_paid || 0), 0),
        },
        dossiers,
        business_research: businessResearch,
        reporting_guide: fullReport,
        all_sources: [
            ...investigations.flatMap(i => i.sources || []),
            ...(businessResearch.sources || []),
        ].filter((s, i, arr) => arr.findIndex(x => x.url === s.url) === i),
    };

    fs.writeFileSync(DOSSIER_PATH, JSON.stringify(output, null, 2), 'utf-8');
    const sizeMB = (fs.statSync(DOSSIER_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ Saved dossiers: ${DOSSIER_PATH} (${sizeMB} MB)`);

    // Save the full report as Markdown
    fs.writeFileSync(REPORT_PATH, fullReport, 'utf-8');
    console.log(`   ✅ Saved report: ${REPORT_PATH}`);

    // CSV of culprits
    const csvPath = path.join(OUTPUT_DIR, 'nj_fraud_culprits.csv');
    let csv = 'NPI,Name,Entity_Type,City,State,ZIP,Phone,Authorized_Official,Total_Paid,Post_Exclusion_Paid,Post_Exclusion_Claims,Exclusion_Date,Action_Type,Risk_Level,Risk_Score,Fraud_Categories,Red_Flags\n';
    for (const d of dossiers) {
        const addr = d.addresses[0] || {};
        csv += [
            d.npi,
            `"${(d.name || '').replace(/"/g, '""')}"`,
            d.entity_type,
            `"${addr.city || ''}"`,
            addr.state || 'NJ',
            addr.zip || '',
            addr.phone || '',
            `"${(d.authorized_official || '').replace(/"/g, '""')}"`,
            d.total_medicaid_paid.toFixed(2),
            (d.post_exclusion_paid || 0).toFixed(2),
            d.post_exclusion_claims || 0,
            d.exclusion_date || '',
            d.action_type || '',
            d.risk_level,
            d.risk_score,
            `"${d.fraud_category.join('; ')}"`,
            `"${d.red_flags.join('; ').replace(/"/g, '""')}"`,
        ].join(',') + '\n';
    }
    fs.writeFileSync(csvPath, csv, 'utf-8');
    console.log(`   ✅ Saved CSV: ${csvPath}`);

    // Final summary
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║          NJ FRAUD HUNTER — INVESTIGATION COMPLETE        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n   📋 Total Suspects Investigated: ${dossiers.length}`);
    console.log(`   🚨 Post-Exclusion Federal Crimes: ${dossiers.filter(d => d.post_exclusion_paid > 0).length}`);
    console.log(`   💰 Total Fraud Exposure: ${fmtMoney(output.metadata.total_fraud_exposure)}`);
    console.log(`   🔴 Post-Exclusion Payments: ${fmtMoney(output.metadata.total_post_exclusion)}`);
    console.log(`   📰 Total Research Sources: ${output.metadata.total_sources}`);
    console.log(`\n   📂 Output Files:`);
    console.log(`      ${DOSSIER_PATH}`);
    console.log(`      ${REPORT_PATH}`);
    console.log(`      ${csvPath}`);

    console.log('\n   🚨 POST-EXCLUSION OFFENDERS (Federal Crimes):');
    for (const d of dossiers.filter(d => d.post_exclusion_paid > 0)) {
        console.log(`      🔴 ${d.name} (NPI ${d.npi})`);
        console.log(`         Excluded: ${d.exclusion_date} | Post-excl: ${fmtMoney(d.post_exclusion_paid)} | ${d.post_exclusion_claims} claims`);
        console.log(`         Address: ${d.addresses[0]?.line1 || 'Unknown'}, ${d.addresses[0]?.city || 'Unknown'} NJ ${d.addresses[0]?.zip || ''}`);
        if (d.authorized_official) console.log(`         Official: ${d.authorized_official}`);
    }

    console.log('\n   📞 KEY REPORTING CONTACTS:');
    console.log('      OIG Hotline: 1-800-HHS-TIPS (1-800-447-8477)');
    console.log('      OIG Online: tips.oig.hhs.gov');
    console.log('      FBI Newark: (973) 792-3000');
    console.log('      NJ AG MFCU: (609) 292-8740');
    console.log('      NJ AG Email: medicaidfraud@njoag.gov');
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
});
