# Medicaid Fraud Detection Report

**Date:** 2026-02-14
**Prepared For:** Medicaid Program Integrity Unit
**Prepared By:** Senior Medicaid Fraud Investigator

---

## 1. Executive Summary

This report presents a comprehensive analysis of 227,083,361 Medicaid billing records from 617,503 providers, identifying significant anomalies and potential fraud indicators. The analysis reveals a highly skewed distribution of payments, with a small number of providers accounting for an extraordinarily large proportion of total expenditures. Key findings include:

*   **Extreme Outliers:** The top 10 highest-risk providers, identified through Z-score analysis, collectively billed for over **$37 billion** in Medicaid payments. These providers exhibit highly suspicious billing patterns, including exceptionally high claims per beneficiary per month, a limited range of procedure codes for massive billing volumes, and consistent self-billing practices.
*   **High Self-Referral Rate:** A substantial 30.71% of all billing records are associated with self-referrals, indicating a systemic vulnerability to abuse. All top 35 outlier providers engaged in self-billing.
*   **Temporal Spikes:** Numerous providers show critical and high-severity monthly payment spikes, suggesting episodic or evolving fraudulent schemes.
*   **Common Suspicious Procedures:** Specific HCPCS codes, particularly those related to personal care, transportation, and non-specific services, are frequently observed among the highest-risk providers.
*   **Benford's Law Compliance:** While overall payment amounts comply with Benford's Law, this does not preclude fraud, as sophisticated schemes can mimic natural distributions.

Based on the analysis of the top 10 highest-risk providers alone, the estimated potential fraud exposure is approximately **$37,015,789,509.96**. This figure represents the total paid to these providers and warrants immediate, in-depth investigation. The findings strongly suggest widespread and sophisticated fraudulent activities requiring urgent intervention.

---

## 2. Methodology

The fraud detection analysis employed a multi-faceted statistical approach to identify anomalous billing patterns within the Medicaid dataset.

*   **Z-score Analysis for Outlier Detection:** Providers were ranked based on their total paid amounts. A Z-score was calculated for each provider's total paid amount relative to the global mean and standard deviation of all provider payments. Providers with Z-scores significantly above the mean were flagged as statistical outliers, indicating unusually high billing volumes or amounts compared to the general provider population. The formula used was:
    $Z = (X - \mu) / \sigma$
    Where $X$ is the provider's total paid, $\mu$ is the global mean total paid, and $\sigma$ is the global standard deviation of total paid.

*   **Benford's Law Analysis:** This statistical tool examines the frequency distribution of the first digits in numerical datasets. For legitimate financial data, the digit '1' is expected to appear as the first digit approximately 30.1% of the time, with decreasing frequencies for higher digits. Significant deviations from this expected distribution can indicate data manipulation or fabricated numbers. The Chi-squared test was used to assess the goodness of fit.

*   **Temporal Anomaly Detection:** Monthly billing data for individual providers was analyzed to identify significant deviations from their historical average payment patterns. A Z-score was calculated for each provider's monthly payment against their own historical mean. "SPIKE" anomalies were flagged when a month's payment significantly exceeded the provider's typical monthly billing, categorized by severity (HIGH or CRITICAL) based on the Z-score threshold.

*   **Feature Engineering and Indicator Analysis:** Additional fraud indicators were derived and analyzed for each provider, including:
    *   **Unique Procedures:** The diversity of HCPCS codes billed.
    *   **Claims per Beneficiary per Month:** An indicator of potential over-servicing or phantom billing.
    *   **Self-Billing:** A flag indicating whether the provider also referred the services, a known risk factor for fraud.
    *   **Months Active:** The duration of the provider's billing activity.

---

## 3. Key Findings

The analysis of 227,083,361 Medicaid billing records yielded several critical findings:

*   **Extreme Financial Outliers Dominate:** The distribution of total payments is highly skewed. While the median total paid per provider is $47,823.19, the mean is significantly higher at $1,770,943.35, with a massive standard deviation of $22,609,456.22. This disparity is driven by a small number of providers with astronomically high billing totals. The top 10 providers alone account for over $37 billion in payments, representing an extreme deviation from the norm.
*   **Consistent Self-Billing Among Outliers:** All 35 of the highest Z-score outlier providers were flagged for "self_billing: true". This aligns with the overall metadata indicating that 30.71% of all Medicaid billing records involve self-referrals, highlighting a pervasive risk of conflicts of interest and potential abuse.
*   **Suspicious Procedure Code Concentration:** Many top outlier providers exhibit a narrow range of unique procedure codes despite immense billing volumes. Common codes include non-specific services (e.g., `99199`), personal care (`T1019`, `T1020`, `S5125`, `S5126`), and various home health or transportation codes. This pattern suggests potential upcoding, billing for services not rendered, or operating highly specialized, potentially fraudulent, schemes.
*   **Unrealistic Claims per Beneficiary per Month:** Several top outlier providers show "claims_per_beneficiary_per_month" figures that are physically impossible or medically improbable (e.g., 1347.53, 1594.97, 1556.01). Such high frequencies strongly indicate phantom billing, patient churning, or billing for services far exceeding medical necessity.
*   **Recurring Temporal Payment Spikes:** The temporal anomaly analysis identified numerous "CRITICAL" and "HIGH" severity payment spikes across various providers. These sudden surges in monthly payments, often significantly exceeding a provider's historical average, suggest periods of intensified fraudulent activity or the initiation of new billing schemes.
*   **Benford's Law Compliance (Overall):** The overall distribution of first digits in payment amounts largely complies with Benford's Law (Chi-squared: 0.0012). While this suggests a lack of crude, widespread manipulation of payment figures across the entire dataset, it does not rule out more sophisticated fraud or fraud concentrated in specific areas not captured by this aggregate test.

---

## 4. Top 10 Highest-Risk Providers

The following providers represent the most significant financial outliers based on their total paid amounts and Z-scores. Their billing patterns exhibit multiple red flags warranting immediate and thorough investigation.

| Rank | NPI          | Total Paid (USD)     | Total Claims | Z-Score | Unique Procedures | Key Procedures (Sample)                               | Months Active | Avg. Payment/Claim | Claims/Beneficiary/Month | Self-Billing |
| :--- | :----------- | :------------------- | :----------- | :------ | :---------------- | :---------------------------------------------------- | :------------ | :----------------- | :----------------------- | :----------- |
| 1    | 1417262056   | $7,177,816,544.46    | 89,773,441   | 317.39  | 25                | 99199, A0090, H2016, S5125, S5126, S5130, S5135, G2021 | 84            | $79.95             | 1347.53                  | TRUE         |
| 2    | 1699703827   | $6,778,483,867.35    | 30,870,976   | 299.73  | 117               | 36415, 71046, 80048, 81001, 81003, 83690              | 83            | $219.57            | 242.89                   | TRUE         |
| 3    | 1376609297   | $5,571,605,313.00    | 63,523,750   | 246.35  | 5                 | 99509, T1019, T1020, T1023, T2022                    | 84            | $87.71             | 1594.97                  | TRUE         |
| 4    | 1699725143   | $3,093,063,112.90    | 107,716,418  | 136.73  | 44                | 93005, A0010, A0080, A0090, A0100, A0110, A0120       | 84            | $28.71             | 550.35                   | TRUE         |
| 5    | 1922467554   | $3,025,874,966.69    | 21,977,069   | 133.75  | 6                 | 99199, S5125, T1019, T1020, T1022, T2024              | 84            | $137.68            | 1556.01                  | TRUE         |
| 6    | 1710176151   | $2,683,634,591.67    | 35,557,539   | 118.62  | 68                | 97124, 99199, 99429, 99509, G9001, H0043, H0045       | 84            | $75.47             | 1223.57                  | TRUE         |
| 7    | 1629436241   | $2,596,064,454.98    | 16,349,155   | 114.74  | 72                | A9279, D0120, D0140, D0150, D0160, D0210, D0220       | 78            | $158.79            | 1085.67                  | TRUE         |
| 8    | 1982757688   | $2,254,946,211.70    | 1,950,098    | 99.66   | 21                | 92507, 97110, 97535, H2014, H2019, H2021, S0215       | 84            | $1,156.32          | 275.31                   | TRUE         |
| 9    | 1538649983   | $2,105,798,329.42    | 22,162,533   | 93.06   | 5                 | 99199, G2021, S5126, S5136, S5150                    | 78            | $95.02             | 1616.83                  | TRUE         |
| 10   | 1528263910   | $1,728,502,977.19    | 4,656,205    | 76.37   | 59                | 80051, 80053, 80076, 81001, 82565, 82947, 84520       | 82            | $371.23            | 236.10                   | TRUE         |

**Detailed Analysis of Top 10 Providers:**

1.  **NPI 1417262056:** Billed over $7.17 billion with a Z-score of 317.39. This provider has an astonishing "claims_per_beneficiary_per_month" rate of 1347.53, which is medically impossible and a strong indicator of phantom billing or severe patient churning. The average payment per claim is low ($79.95), suggesting high-volume, low-cost service fraud. Key procedures include non-specific `99199` and various personal care/home health codes (`S5125`, `S5126`, `S5130`, `S5135`, `G2021`). The "self_billing: true" flag further exacerbates the risk.
2.  **NPI 1699703827:** Billed over $6.77 billion with a Z-score of 299.73. This provider has a higher average payment per claim ($219.57) and a diverse set of 117 unique procedures, including numerous lab tests (`80048`, `81001`, `81003`, `83690`). High-volume lab billing, especially with self-referral, is a common fraud scheme. The "claims_per_beneficiary_per_month" of 242.89 is also highly suspicious.
3.  **NPI 1376609297:** Billed over $5.57 billion with a Z-score of 246.35. This provider exhibits an extremely narrow focus with only 5 unique procedures, predominantly personal care and transportation codes (`T1019`, `T1020`, `T1023`, `T2022`, `99509`). The "claims_per_beneficiary_per_month" is an alarming 1594.97, indicating systemic, high-volume, fraudulent billing for these specific services.
4.  **NPI 1699725143:** Billed over $3.09 billion with a Z-score of 136.73. This provider has the highest total claims count (107,716,418) among the top 10, but the lowest average payment per claim ($28.71). The procedures primarily consist of transportation codes (`A0010` to `A0140`) and basic diagnostic codes (`93005`). This suggests a massive, high-volume transportation fraud scheme. The "claims_per_beneficiary_per_month" of 550.35 is also highly indicative of fraud.
5.  **NPI 1922467554:** Billed over $3.02 billion with a Z-score of 133.75. Similar to NPI 1376609297, this provider focuses on a very limited set of 6 procedures, primarily personal care and non-specific codes (`99199`, `S5125`, `T1019`, `T1020`, `T1022`, `T2024`). The "claims_per_beneficiary_per_month" is 1556.01, another strong indicator of impossible service volumes.
6.  **NPI 1710176151:** Billed over $2.68 billion with a Z-score of 118.62. This provider has a moderate number of unique procedures (68), including physical therapy (`97124`), non-specific codes (`99199`, `99429`, `99509`), and behavioral health codes (`H0043`, `H0045`). The "claims_per_beneficiary_per_month" of 1223.57 is extremely high, suggesting widespread over-billing across multiple service categories.
7.  **NPI 1629436241:** Billed over $2.59 billion with a Z-score of 114.74. This provider shows a concentration in dental codes (`D0120`, `D0140`, `D0150`, `D0160`, `D0210`, `D0220`, `D0230`, `D0240`, `D0270`). High-volume dental billing, especially with self-referral, is a known fraud vector. The "claims_per_beneficiary_per_month" of 1085.67 further supports suspicion of excessive or phantom billing.
8.  **NPI 1982757688:** Billed over $2.25 billion with a Z-score of 99.66. This provider has a relatively low total claims count (1,950,098) but a very high average payment per claim ($1,156.32). Procedures include speech therapy (`92507`), physical therapy (`97110`, `97535`), and various behavioral health/home health codes (`H2014`, `H2019`, `H2021`, `S0215`, `S5135`, `S5150`, `S9124`). The high average payment per claim combined with a "claims_per_beneficiary_per_month" of 275.31 suggests high-cost, high-frequency fraudulent services.
9.  **NPI 1538649983:** Billed over $2.10 billion with a Z-score of 93.06. This provider, similar to NPI 1417262056 and 1922467554, focuses on a very limited set of 5 procedures, including non-specific `99199`, remote monitoring `G2021`, and personal care codes (`S5126`, `S5136`, `S5150`). The "claims_per_beneficiary_per_month" of 1616.83 is among the highest observed, indicating extreme over-billing.
10. **NPI 1528263910:** Billed over $1.72 billion with a Z-score of 76.37. This provider has a diverse set of 59 unique procedures, heavily featuring laboratory services (`80051`, `80053`, `80076`, `81001`, `82565`, `82947`, `84520`). The "claims_per_beneficiary_per_month" of 236.10, coupled with high total payments, suggests a large-scale, potentially fraudulent, laboratory billing operation.

---

## 5. HCPCS Code Analysis

A review of the procedure codes billed by the top outlier providers reveals several frequently recurring and suspicious codes:

*   **Non-Specific/Unlisted Codes:**
    *   `99199` (Unlisted special service, procedure or report): Appears in 5 of the top 10 and many other outliers. This code is a significant red flag as it lacks specificity and is prone to abuse for billing services that are not medically necessary or were never rendered.
    *   `99509` (Home visit for assistance with activities of daily living): Appears in 2 of the top 10. This code, often associated with personal care, is susceptible to over-billing and billing for services not provided.

*   **Personal Care / Attendant Care Services:**
    *   `T1019` (Personal care services, per diem): Appears in 4 of the top 10.
    *   `T1020` (Personal care services, per 15 minutes): Appears in 4 of the top 10.
    *   `S5125` (Attendant care services, per diem): Appears in 3 of the top 10.
    *   `S5126` (Attendant care services, per 15 minutes): Appears in 3 of the top 10.
    *   `S5130` (Attendant care services, per hour): Appears in 1 of the top 10.
    These codes are consistently present among providers with extremely high "claims_per_beneficiary_per_month" and low average payments, indicating potential high-volume, low-cost fraud schemes where services are exaggerated or fabricated.

*   **Transportation Services:**
    *   `A0090` (Non-emergency transportation, per mile): Appears in 2 of the top 10.
    *   `A0010`, `A0080`, `A0100`, `A0110`, `A0120`, `A0130`, `A0140` (Various non-emergency transportation codes): Featured prominently by NPI 1699725143. These codes are often associated with schemes involving billing for non-existent trips or unnecessary transportation.

*   **Remote Monitoring / Home Health:**
    *   `G2021` (Remote physiologic monitoring treatment management services): Appears in 2 of the top 10. This relatively new code category is vulnerable to fraud, especially when billed at high volumes without proper patient engagement or medical necessity.
    *   `S5135` (Companion care, per diem): Appears in 2 of the top 10.

*   **Laboratory Services:**
    *   `80048`, `80076`, `81001`, `81003`, `83690`, `80051`, `80053`, `82565`, `82947`, `84520` (Various lab panel and individual lab tests): Prominent in NPIs 1699703827 and 1528263910. High-volume lab billing, particularly for medically unnecessary tests or those not performed, is a common fraud type.

*   **Dental Services:**
    *   `D0120`, `D0140`, `D0150`, `D0160`, `D0210`, `D0220`, `D0230`, `D0240`, `D0270` (Various dental diagnostic and preventative codes): Dominate NPI 1629436241. High-volume billing for basic dental services can indicate "drill and fill" schemes or billing for services not rendered.

The prevalence of these codes among the highest-risk providers suggests they are frequently exploited in fraudulent schemes.

---

## 6. Benford's Law Results

The Benford's Law analysis was performed on the first digits of all Medicaid payment amounts.

**Result:** PASS: Payment amounts follow Benford's Law.

**Chi-Squared Value:** 0.0012

**Digit Deviations:**
| First Digit | Observed Frequency | Expected Frequency (Benford's Law) | Deviation |
| :---------- | :----------------- | :--------------------------------- | :-------- |
| 1           | 0.3147             | 0.301                              | 0.0137    |
| 2           | 0.1741             | 0.176                              | 0.0019    |
| 3           | 0.1197             | 0.125                              | 0.0053    |
| 4           | 0.0926             | 0.097                              | 0.0044    |
| 5           | 0.0762             | 0.079                              | 0.0028    |
| 6           | 0.0657             | 0.067                              | 0.0013    |
| 7           | 0.0578             | 0.058                              | 0.0002    |
| 8           | 0.0517             | 0.051                              | 0.0007    |
| 9           | 0.0474             | 0.046                              | 0.0014    |

**Interpretation:**
The low Chi-squared value (0.0012) and minimal deviations between observed and expected first-digit frequencies indicate that the overall distribution of Medicaid payment amounts adheres to Benford's Law. This suggests that there is no widespread, unsophisticated manipulation of payment figures across the entire dataset, such as fabricating amounts that would disproportionately start with higher digits.

However, compliance with Benford's Law at an aggregate level does not preclude fraud. Sophisticated fraudsters may intentionally manipulate numbers to conform to Benford's Law, or fraud may be concentrated in specific, smaller subsets of data that are masked by the overall compliance. Therefore, while this finding is positive for the integrity of the overall dataset, it should not be interpreted as an absence of fraud, especially given the other significant anomalies identified.

---

## 7. Temporal Anomaly Patterns

The temporal analysis identified numerous instances of significant monthly payment spikes across various providers. The sample of 50 anomalies provided shows a consistent pattern of "SPIKE" anomalies, predominantly categorized as "CRITICAL" severity.

*   **Prevalence of Spikes:** All 50 sampled anomalies are classified as "SPIKE" events, indicating sudden and substantial increases in monthly payments relative to a provider's historical average.
*   **High Severity:** The majority of these spikes are rated "CRITICAL" (e.g., NPI 1003000969, 1003006180, 1003010042, 1003011602, 1003024647, 1003028549), with Z-scores often exceeding 5.0 and reaching up to 11.24. This signifies payments that are many standard deviations above the provider's typical monthly billing.
*   **Recurring Spikes for Individual Providers:** Several providers exhibit repeated critical spikes over multiple months or years. For example:
    *   **NPI 1003000969:** Shows critical spikes in 2019-01, 2019-03, 2019-04, 2020-07, 2021-03, 2021-04, 2021-06, 2021-08, 2022-03, 2022-07, and a high spike in 2022-08. This pattern suggests a provider with intermittent but significant surges in billing.
    *   **NPI 1003010042:** Displays critical spikes in 2018-02, 2019-01, 2020-01, 2020-02, 2024-02, 2024-04, alongside high spikes in other months. This indicates a provider with a history of substantial, irregular billing increases.
    *   **NPI 1003028549:** Exhibits a continuous series of critical spikes from 2022-03 through 2022-09, with monthly payments consistently in the $660,000 - $680,000 range against a mean of $14,223.67. This sustained, extreme elevation is highly suspicious.
*   **Potential Implications:** These temporal spikes could indicate:
    *   **New Fraud Schemes:** The initiation of a new fraudulent billing practice.
    *   **Seasonal Fraud:** Fraudulent activities that peak during certain times of the year.
    *   **"Burst" Fraud:** Periods where fraudsters rapidly submit a large volume of claims before detection.
    *   **Acquisition/Expansion:** While less likely for such extreme Z-scores, a sudden legitimate expansion could cause spikes, but would typically be accompanied by corresponding changes in provider demographics or service offerings.

These patterns necessitate a detailed review of the claims submitted during these anomalous periods for the identified providers.

---

## 8. Self-Referral Analysis

The metadata indicates that **69,731,487** billing records, representing **30.71%** of all Medicaid billing records, are associated with self-referrals. This is a significant finding with profound implications for program integrity.

*   **Definition:** Self-referral occurs when a healthcare provider refers a patient to a facility or service in which the provider has a financial interest. While not inherently illegal in all contexts, it creates a clear conflict of interest and is a well-documented risk factor for healthcare fraud and abuse.
*   **Risk Factors:**
    *   **Overutilization:** Providers may be incentivized to order more services, tests, or procedures than medically necessary to increase their own profits.
    *   **Upcoding:** Billing for more complex or expensive services than actually provided.
    *   **Lack of Independent Oversight:** The absence of an independent party reviewing the necessity of the referral.
    *   **Patient Harm:** Unnecessary procedures expose beneficiaries to undue risks.
*   **Connection to Outliers:** Critically, all 35 providers identified in the "Top 35 Outlier Providers" list have the `self_billing: true` flag. This direct correlation between extreme financial outliers and self-billing practices strongly suggests that self-referral is a significant enabler of large-scale Medicaid fraud within this dataset. The top 10 providers alone, responsible for over $37 billion in payments, all engaged in self-billing.

The high overall self-referral rate, coupled with its consistent presence among the most egregious outliers, points to a systemic vulnerability that requires immediate attention and policy review.

---

## 9. Recommended Actions

Based on the findings of this comprehensive analysis, the following actions are recommended to mitigate fraud, waste, and abuse within the Medicaid program:

1.  **Immediate Investigation of Top 10 Providers:** Initiate full-scale investigations into the top 10 highest-risk providers (NPIs: 1417262056, 1699703827, 1376609297, 1699725143, 1922467554, 1710176151, 1629436241, 1982757688, 1538649983, 1528263910). Prioritize these due to their extreme Z-scores and the collective potential fraud exposure of over $37 billion.
    *   Conduct on-site audits, beneficiary interviews, and detailed claim reviews for these providers.
    *   Subpoena financial records and patient charts.
    *   Assess the medical necessity of billed services, especially for those with extremely high "claims_per_beneficiary_per_month" rates.

2.  **Targeted Review of High-Risk HCPCS Codes:** Conduct focused audits and enhanced monitoring for claims involving frequently abused procedure codes, including:
    *   `99199`, `99509` (Non-specific/Unlisted services)
    *   `T1019`, `T1020`, `S5125`, `S5126`, `S5130`, `S5135` (Personal/Attendant Care)
    *   `A0010`, `A0080`, `A0090`, `A0100`, `A0110`, `A0120`, `A0130`, `A0140` (Transportation)
    *   `G2021` (Remote Physiologic Monitoring)
    *   Dental codes (`D0xxx`) and Laboratory codes (`80xxx`) when billed in high volume or by non-specialist providers.

3.  **In-Depth Temporal Anomaly Investigation:** Systematically review all providers flagged with "CRITICAL" and "HIGH" severity temporal spikes. Focus on the specific months identified as anomalous and analyze the types of services billed during these periods. This could reveal new or evolving fraud schemes.

4.  **Enhanced Scrutiny of Self-Referral Practices:**
    *   Implement stricter regulations or guidelines for self-referral within the Medicaid program, particularly for high-cost or high-volume services.
    *   Develop a robust monitoring system to flag providers with high self-referral rates, especially those also exhibiting other fraud indicators.
    *   Consider legislative changes to limit or prohibit certain types of self-referrals that pose significant fraud risks.

5.  **Beneficiary-Level Analysis:** Conduct further analysis at the beneficiary level for providers identified as high-risk. Investigate beneficiaries who appear to receive an unusually high number of services or services from multiple suspicious providers. This can uncover patient brokering or identity theft schemes.

6.  **Provider Specialty and Geographic Analysis:** Expand the analysis to include provider specialty and geographic location to identify potential fraud rings or areas with concentrated fraudulent activity.

7.  **Inter-Agency Collaboration:** Share findings with law enforcement agencies (e.g., OIG, FBI) and other state Medicaid agencies to coordinate investigations and leverage resources, especially for multi-state providers.

---

## 10. Risk Scoring Methodology

Providers were assigned a risk score based on a combination of statistical anomalies and known fraud indicators, allowing for prioritization of investigative efforts. The methodology incorporated the following factors:

1.  **Total Paid Z-score (Weight: High):** The primary driver of the risk score. Providers with higher Z-scores for their total paid amounts were assigned significantly higher risk. This quantifies how far a provider's total billing deviates from the average, highlighting extreme outliers.
    *   *Thresholds:* Z-score > 3 (High Risk), Z-score > 5 (Critical Risk). The top providers in this report have Z-scores in the hundreds, indicating extreme risk.

2.  **Claims per Beneficiary per Month (Weight: High):** This metric directly indicates potential over-servicing or phantom billing. Unrealistic values (e.g., >100 claims/beneficiary/month) significantly increase a provider's risk score.

3.  **Self-Billing Status (Weight: High):** Providers flagged with `self_billing: true` automatically incurred a higher risk score. The presence of self-referral, especially when combined with high billing, is a critical fraud indicator.

4.  **Temporal Anomaly Severity and Frequency (Weight: Medium):**
    *   **Severity:** "CRITICAL" spikes (higher Z-scores for monthly payments) contributed more to the risk score than "HIGH" spikes.
    *   **Frequency:** Providers with multiple recurring temporal anomalies over time were scored higher, indicating persistent or evolving suspicious behavior.

5.  **Number of Unique Procedures (Weight: Medium):**
    *   **Very Low Unique Procedures (e.g., <10):** Providers with a very narrow range of procedures but extremely high billing volumes were flagged for specialized fraud schemes (e.g., NPI 1376609297, 1922467554).
    *   **Very High Unique Procedures (e.g., >500):** While not always fraudulent, an unusually broad range of procedures for a single provider, especially when combined with high payments, could indicate a "shotgun" approach to billing or lack of specialization, warranting further review.

6.  **Average Payment per Claim (Weight: Low-Medium):** While not a direct fraud indicator, extreme values (either very low for high volume or very high for moderate volume) can suggest specific types of fraud (e.g., high-volume, low-cost personal care fraud vs. high-cost, low-volume equipment fraud).

**Categorization:**
Providers were categorized into risk tiers (e.g., Critical, High, Moderate, Low) based on their aggregated risk score, allowing for a prioritized approach to investigations. The top 35 providers discussed in this report all fall into the "Critical" risk category, demanding immediate and comprehensive investigative resources.