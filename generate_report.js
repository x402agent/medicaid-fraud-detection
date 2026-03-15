#!/usr/bin/env node
// Generate a comprehensive fraud report using Gemini AI
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function main() {
    const { GoogleGenAI } = await import('@google/genai');

    const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!API_KEY) { console.error('❌ No API key'); process.exit(1); }

    const ai = new GoogleGenAI({ apiKey: API_KEY });

    // Load the statistical analysis
    const stats = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'fraud_analysis', 'statistical_analysis.json'), 'utf-8'
    ));

    console.log('📊 Loaded statistical analysis');
    console.log(`   Outlier providers: ${stats.outlier_providers?.length}`);
    console.log(`   Temporal anomalies: ${stats.temporal_anomalies?.length}`);

    // Build the prompt with all the data
    const prompt = `You are a senior Medicaid fraud investigator writing a comprehensive fraud detection report. 
    
Based on the following statistical analysis of 227,083,361 Medicaid billing records across 617,503 providers, write a detailed, professional fraud detection report in Markdown format.

## DATA PROVIDED:

### Metadata
${JSON.stringify(stats.metadata, null, 2)}

### Global Statistics  
${JSON.stringify(stats.global_statistics, null, 2)}

### Top 35 Outlier Providers (by Z-score)
${JSON.stringify(stats.outlier_providers?.slice(0, 35), null, 2)}

### Benford's Law Analysis
${JSON.stringify(stats.benford_analysis, null, 2)}

### Temporal Anomalies (sample of first 50)
${JSON.stringify(stats.temporal_anomalies?.slice(0, 50), null, 2)}

## REPORT REQUIREMENTS:

Write the report with these sections:
1. **Executive Summary** - High-level findings, total fraud exposure estimate
2. **Methodology** - Statistical methods used (Z-score analysis, Benford's Law, temporal analysis)
3. **Key Findings** - Major patterns discovered
4. **Top 10 Highest-Risk Providers** - Detailed analysis of each with specific dollar amounts, NPI numbers, procedure codes, and fraud indicators
5. **HCPCS Code Analysis** - Which procedure codes appear most in suspicious billing (T1019, T1020, 99199, etc.)
6. **Benford's Law Results** - Interpretation of the digit distribution analysis
7. **Temporal Anomaly Patterns** - Seasonal or sudden billing spikes
8. **Self-Referral Analysis** - Impact of the 30.71% self-referral rate
9. **Recommended Actions** - Specific next steps for investigators
10. **Risk Scoring Methodology** - How providers were scored and categorized

Be extremely specific with NPI numbers, dollar amounts, and HCPCS codes. This should read like a real government fraud investigation report. Use tables where appropriate.`;

    console.log('\n🤖 Generating fraud report with Gemini 2.5 Flash...');

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            temperature: 0.3,
            maxOutputTokens: 16000,
        }
    });

    const report = response.text;

    // Save the report
    const reportPath = path.join(__dirname, 'fraud_analysis', 'gemini_fraud_report.md');
    fs.writeFileSync(reportPath, report, 'utf-8');

    console.log(`\n✅ Fraud report generated: ${reportPath}`);
    console.log(`   Length: ${report.length} characters`);
    console.log(`   Lines: ${report.split('\n').length}`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
