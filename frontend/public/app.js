/* ═════════════════════════════════════════════════════════════
   Medicaid Fraud Detection Dashboard — Frontend App
   ═════════════════════════════════════════════════════════════ */

const API = window.location.hostname.includes('vercel.app')
    ? 'https://api-production-1b3c.up.railway.app'
    : '';
let chatHistory = [];
let dataPage = 1;
let dataPageSize = 50;
let dataFilter = '';
let codesPage = 1;
let codesPageSize = 50;
let codesFilter = '';

// ── Utilities ──────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function $$(sel) { return document.querySelectorAll(sel); }
function fmt(n) { return n != null ? Number(n).toLocaleString() : '—'; }
function fmtMoney(n) { return n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—'; }
function fmtPct(n) { return n != null ? Number(n).toFixed(1) + '%' : '—'; }
function riskFromProvider(p) {
    const explicit = String(p?.risk_level || '').toLowerCase();
    if (explicit) return explicit;
    const z = Number(p?.z_score);
    if (!Number.isNaN(z)) {
        if (z > 10) return 'critical';
        if (z > 5) return 'high';
        if (z > 3) return 'medium';
        if (z > 1) return 'elevated';
    }
    const paid = Number(p?.total_paid || 0);
    if (paid > 500000000) return 'critical';
    if (paid > 100000000) return 'high';
    if (paid > 50000000) return 'medium';
    return 'low';
}

// ── Navigation ─────────────────────────────────────────────
$$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        $$('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        const section = $('tab-' + tab);
        if (section) section.classList.add('active');

        // Lazy load tabs
        if (tab === 'data' && !window._dataLoaded) loadDataExplorer();
        if (tab === 'codes' && !window._codesLoaded) loadCodesTab();
        if (tab === 'report' && !window._reportLoaded) loadReport();
        if (tab === 'geography' && !window._geoLoaded) loadGeography();
        if (tab === 'nj' && !window._njLoaded) loadNJDeepDive();
        if (tab === 'community' && !window._communityLoaded) loadCommunityHub();
    });
});

// ── Health Check & Init ────────────────────────────────────
async function init() {
    try {
        const res = await fetch(API + '/api/health');
        const data = await res.json();
        const pill = $('api-status');
        pill.classList.add('connected');
        pill.innerHTML = `<span class="status-dot"></span><span>Online</span>`;
        $('data-status').innerHTML = `<span>📊</span><span>${fmt(data.providers_loaded)} providers</span>`;

        // Load dashboard
        loadDashboard();
    } catch (e) {
        $('api-status').innerHTML = `<span class="status-dot"></span><span>Offline</span>`;
    }
}

// ── Dashboard ──────────────────────────────────────────────
async function loadDashboard() {
    try {
        const res = await fetch(API + '/api/stats');
        const data = await res.json();
        const o = data.overview;

        // KPIs
        $('kpi-claims').textContent = fmt(o.total_rows);
        $('kpi-providers').textContent = fmt(o.total_providers);
        const rd = data.risk_distribution;
        $('kpi-highrisk').textContent = fmt((rd.critical || 0) + (rd.high || 0));
        $('kpi-selfref').textContent = o.self_referral_pct != null ? fmtPct(o.self_referral_pct) : '—';

        // Risk Distribution Chart
        renderRiskChart(rd);

        // Payment Distribution Chart
        renderPaymentChart(data.payment_distribution);

        // Top Providers Table
        renderTopProvidersTable(data.top_providers);

        // Benford Chart
        if (data.benford) renderBenfordChart(data.benford);

        // HCPCS Chart
        if (data.top_hcpcs_codes) renderHCPCSChart(data.top_hcpcs_codes);
    } catch (e) {
        console.error('Dashboard load error:', e);
    }
}

function renderRiskChart(dist) {
    const max = Math.max(...Object.values(dist), 1);
    const colors = { critical: 'critical', high: 'high', medium: 'medium', elevated: 'elevated', low: 'low' };
    let html = '<div class="bar-chart">';
    for (const [key, val] of Object.entries(dist)) {
        const pct = (val / max * 100).toFixed(1);
        html += `<div class="bar-row">
            <span class="bar-label">${key.toUpperCase()}</span>
            <div class="bar-track"><div class="bar-fill ${colors[key]}" style="width:${pct}%">${fmt(val)}</div></div>
        </div>`;
    }
    html += '</div>';
    $('risk-chart').innerHTML = html;
    // Animate bars in
    setTimeout(() => $$('.bar-fill').forEach(b => b.style.width = b.style.width), 50);
}

function renderPaymentChart(buckets) {
    const max = Math.max(...Object.values(buckets), 1);
    const colors = ['low', 'low', 'default', 'default', 'medium', 'high', 'critical'];
    let html = '<div class="bar-chart">';
    let i = 0;
    for (const [key, val] of Object.entries(buckets)) {
        const pct = (val / max * 100).toFixed(1);
        html += `<div class="bar-row">
            <span class="bar-label">${key}</span>
            <div class="bar-track"><div class="bar-fill ${colors[i]}" style="width:${pct}%">${fmt(val)}</div></div>
        </div>`;
        i++;
    }
    html += '</div>';
    $('payment-chart').innerHTML = html;
}

function renderTopProvidersTable(providers) {
    let html = `<table>
        <thead><tr>
            <th>NPI</th><th>Total Paid</th><th>Claims</th><th>Procedures</th><th>Months</th><th>Avg/Claim</th><th>Risk</th>
        </tr></thead><tbody>`;
    for (const p of providers) {
        const risk = riskFromProvider(p);
        html += `<tr>
            <td class="clickable" onclick="viewProvider('${p.npi}')">${p.npi}</td>
            <td class="money">${fmtMoney(p.total_paid)}</td>
            <td>${fmt(p.total_claims)}</td>
            <td>${fmt(p.procedures)}</td>
            <td>${fmt(p.months)}</td>
            <td>${fmtMoney(p.avg_per_claim)}</td>
            <td><span class="risk-badge ${risk}">${risk.toUpperCase()}</span></td>
        </tr>`;
    }
    html += '</tbody></table>';
    $('top-providers-table').innerHTML = html;
}

function renderBenfordChart(benford) {
    const expected = [30.1, 17.6, 12.5, 9.7, 7.9, 6.7, 5.8, 5.1, 4.6];
    const actual = benford.actual_distribution || benford.observed_distribution || [];
    const maxVal = Math.max(...expected, ...(actual.map ? actual.map(Number) : []));

    let html = '<div class="benford-bars">';
    for (let i = 0; i < 9; i++) {
        const exp = expected[i];
        const act = actual[i] ? (actual[i] * 100 || actual[i]) : 0;
        html += `<div class="benford-col">
            <div class="benford-bar expected" style="height:${(exp / maxVal * 100)}%" title="Expected: ${exp}%"></div>
            <div class="benford-bar actual" style="height:${(act / maxVal * 100)}%" title="Actual: ${typeof act === 'number' ? act.toFixed(1) : '?'}%"></div>
            <span class="benford-digit">${i + 1}</span>
        </div>`;
    }
    html += '</div>';
    $('benford-chart').innerHTML = html;

    const chiSq = benford.chi_squared_statistic || 0;
    const isSus = chiSq > 15.51 || benford.suspicious;
    $('benford-verdict').className = 'benford-verdict ' + (isSus ? 'suspicious' : 'normal');
    $('benford-verdict').innerHTML = isSus
        ? `⚠️ <strong>Suspicious</strong> — Chi² = ${chiSq.toFixed(2)}, p-value = ${benford.p_value?.toFixed(4) || 'N/A'}. Distribution deviates significantly from Benford's Law.`
        : `✅ <strong>Normal</strong> — Chi² = ${chiSq.toFixed(2)}. Distribution follows Benford's Law.`;
}

function renderHCPCSChart(codes) {
    const max = codes.reduce((m, c) => Math.max(m, c.count), 1);
    let html = '<div class="bar-chart">';
    for (const c of codes) {
        const pct = (c.count / max * 100).toFixed(1);
        html += `<div class="bar-row">
            <span class="bar-label">${c.code}</span>
            <div class="bar-track"><div class="bar-fill default" style="width:${pct}%">${fmt(c.count)}</div></div>
        </div>`;
    }
    html += '</div>';
    $('hcpcs-chart').innerHTML = html;
}

// ── Chat ───────────────────────────────────────────────────
$('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const msg = input.value.trim();
    if (!msg) return;

    appendMessage('user', msg);
    input.value = '';
    $('chat-send').disabled = true;
    $('suggested-prompts').style.display = 'none';

    // Typing indicator
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message assistant';
    typingDiv.innerHTML = `<div class="message-avatar">🔍</div><div class="message-content"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
    $('chat-messages').appendChild(typingDiv);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;

    try {
        const res = await fetch(API + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: chatHistory }),
        });
        const data = await res.json();
        typingDiv.remove();

        if (data.error) {
            appendMessage('assistant', '❌ Error: ' + data.error);
        } else {
            appendMessage('assistant', data.response);
            chatHistory.push({ role: 'user', content: msg });
            chatHistory.push({ role: 'assistant', content: data.response });
        }
    } catch (err) {
        typingDiv.remove();
        appendMessage('assistant', '❌ Failed to reach server: ' + err.message);
    }

    $('chat-send').disabled = false;
});

// Suggested prompts
$$('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        $('chat-input').value = chip.dataset.prompt;
        $('chat-form').dispatchEvent(new Event('submit'));
    });
});

function appendMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'message ' + role;
    const avatar = role === 'user' ? '👤' : '🔍';
    const formatted = formatMarkdown(content);
    div.innerHTML = `<div class="message-avatar">${avatar}</div><div class="message-content">${formatted}</div>`;
    $('chat-messages').appendChild(div);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function formatMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        .replace(/^\- (.*$)/gm, '<li>$1</li>')
        .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^/, '<p>')
        .replace(/$/, '</p>');
}

// ── Providers Tab ──────────────────────────────────────────
let providerOffset = 0;
const providerLimit = 24;

async function loadProviders(append = false) {
    const q = $('provider-search').value;
    const sort = $('sort-select').value;

    if (!append) providerOffset = 0;

    try {
        const res = await fetch(`${API}/api/providers/search?q=${encodeURIComponent(q)}&sort=${sort}&limit=${providerLimit}&offset=${providerOffset}`);
        const data = await res.json();

        const grid = $('providers-grid');
        if (!append) grid.innerHTML = '';

        for (const p of data.results) {
            const risk = riskFromProvider(p);
            const card = document.createElement('div');
            card.className = 'provider-card';
            card.onclick = () => viewProvider(p.npi || p.billing_provider_npi);
            card.innerHTML = `
                <div class="risk-indicator"><span class="risk-badge ${risk}">${risk.toUpperCase()}</span></div>
                <div class="npi">NPI: ${p.npi || p.billing_provider_npi}</div>
                <div class="stats">
                    <div class="stat">Total Paid<br><span class="stat-val">${fmtMoney(p.total_paid)}</span></div>
                    <div class="stat">Claims<br><span class="stat-val">${fmt(p.total_claims)}</span></div>
                    <div class="stat">Procedures<br><span class="stat-val">${fmt(p.unique_hcpcs_codes)}</span></div>
                    <div class="stat">Avg/Claim<br><span class="stat-val">${fmtMoney(p.avg_payment_per_claim)}</span></div>
                </div>`;
            grid.appendChild(card);
        }

        $('load-more-btn').style.display = (providerOffset + providerLimit < data.total) ? 'inline-block' : 'none';
    } catch (e) {
        console.error('Provider load error:', e);
    }
}

$('provider-search').addEventListener('input', debounce(() => loadProviders(), 300));
$('sort-select').addEventListener('change', () => loadProviders());
$('load-more-btn').addEventListener('click', () => {
    providerOffset += providerLimit;
    loadProviders(true);
});

async function viewProvider(npi) {
    const modal = $('provider-modal');
    const content = $('modal-content');
    modal.classList.add('active');
    content.innerHTML = '<div class="report-loading"><div class="spinner"></div><p>Loading provider...</p></div>';

    try {
        const res = await fetch(`${API}/api/providers/${npi}`);
        const p = await res.json();

        content.innerHTML = `
            <h2 style="margin-bottom:4px;">NPI: ${p.npi || p.billing_provider_npi}</h2>
            <div style="margin-bottom:16px;">
                <span class="risk-badge ${riskFromProvider(p)}" style="font-size:0.8rem;padding:4px 12px;">
                    ${p.risk_level || 'LOW'} RISK — Z-Score: ${p.z_score}
                </span>
            </div>
            <div class="stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
                <div class="stat">Total Paid<br><span class="stat-val" style="color:var(--green);">${fmtMoney(p.total_paid)}</span></div>
                <div class="stat">Total Claims<br><span class="stat-val">${fmt(p.total_claims)}</span></div>
                <div class="stat">Procedures<br><span class="stat-val">${fmt(p.unique_hcpcs_codes)}</span></div>
                <div class="stat">Months Active<br><span class="stat-val">${fmt(p.months_active)}</span></div>
                <div class="stat">Avg/Claim<br><span class="stat-val">${fmtMoney(p.avg_payment_per_claim)}</span></div>
                <div class="stat">Avg Beneficiaries/Mo<br><span class="stat-val">${fmt(p.avg_beneficiaries_per_month)}</span></div>
                <div class="stat">Payment CV<br><span class="stat-val">${p.payment_coefficient_of_variation?.toFixed(2) || '—'}</span></div>
                <div class="stat">x̄ Ratio<br><span class="stat-val">${p.ratio_to_mean}x mean</span></div>
                <div class="stat">Global Mean<br><span class="stat-val">${fmtMoney(p.global_mean)}</span></div>
            </div>
            <h3 style="margin-bottom:8px;">HCPCS Codes</h3>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:20px;">
                ${(p.hcpcs_codes_list || []).map(c => `<span style="padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;font-size:0.72rem;font-family:var(--mono);">${c}</span>`).join('')}
            </div>
            <button class="btn-primary" id="analyze-provider-btn" style="width:100%;">🔍 Run AI Fraud Analysis</button>
            <div id="ai-analysis" style="margin-top:16px;"></div>`;

        $('analyze-provider-btn').addEventListener('click', async () => {
            const btn = $('analyze-provider-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-sm"></span> Analyzing with Gemini...';
            try {
                const r = await fetch(`${API}/api/analyze/${npi}`, { method: 'POST' });
                const result = await r.json();
                $('ai-analysis').innerHTML = `<div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;font-size:0.82rem;line-height:1.8;">${formatMarkdown(result.analysis || result.error)}</div>`;
            } catch (err) {
                $('ai-analysis').innerHTML = `<p style="color:var(--red);">Error: ${err.message}</p>`;
            }
            btn.innerHTML = '🔍 Re-analyze';
            btn.disabled = false;
        });
    } catch (e) {
        content.innerHTML = `<p style="color:var(--red);">Error loading provider: ${e.message}</p>`;
    }
}

$('modal-close').addEventListener('click', () => $('provider-modal').classList.remove('active'));
$('provider-modal').addEventListener('click', (e) => {
    if (e.target === $('provider-modal')) $('provider-modal').classList.remove('active');
});

// ── Document AI + RAG Tab ──────────────────────────────────
let selectedFile = null;
let selectedMode = 'analyze';
let chunkPage = 1;

// Load RAG status when tab is opened (or on init)
async function loadRAGStatus() {
    try {
        const res = await fetch(API + '/api/rag/status');
        const status = await res.json();
        $('rag-chunks-count').textContent = status.indexed_chunks || 0;
        $('rag-docs-count').textContent = (status.documents || []).length;
        $('rag-embed-model').textContent = (status.embedding_model || '—').replace('text-embedding-', 'text-emb-');
        $('rag-gen-model').textContent = (status.generation_model || '—').replace('gemini-', '');

        // Light up pipeline steps if ready
        if (status.ready) {
            document.querySelectorAll('.pipeline-step').forEach(s => s.classList.add('active'));
        }
    } catch (e) {
        console.error('RAG status error:', e);
    }
}

// Auto-load status on init
setTimeout(loadRAGStatus, 1000);

// ── RAG Query ──────────────────────────────────────────────
$('rag-query-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = $('rag-question').value.trim();
    if (!question) return;

    const btn = $('rag-query-btn');
    const spinner = $('rag-query-spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';

    // Animate pipeline steps
    animatePipeline();

    try {
        const res = await fetch(API + '/api/rag/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, topK: 8 }),
        });
        const data = await res.json();

        $('rag-answer-panel').style.display = 'block';

        if (data.error) {
            $('rag-answer-body').innerHTML = `<p style="color:var(--red);">❌ ${data.error}</p>`;
            $('rag-answer-meta').textContent = '';
            $('rag-chunks-list').innerHTML = '';
        } else {
            $('rag-answer-body').innerHTML = formatMarkdown(data.answer || '');
            $('rag-answer-meta').textContent = `${data.model} · ${data.chunksSearched} chunks searched · ${data.timestamp}`;

            // Render retrieved chunks
            let chunksHtml = '';
            for (const chunk of (data.chunks || [])) {
                chunksHtml += `
                    <div class="rag-chunk-card">
                        <div class="rag-chunk-header">
                            <span class="rag-chunk-id">${chunk.id}</span>
                            <span class="rag-chunk-score">Score: ${chunk.score.toFixed(3)}</span>
                        </div>
                        <div class="rag-chunk-source">${chunk.metadata?.source || 'unknown'} · ${chunk.metadata?.type || ''}</div>
                        <div class="rag-chunk-content">${escapeHtml(chunk.content)}</div>
                    </div>`;
            }
            $('rag-chunks-list').innerHTML = chunksHtml;
        }

        // Update status counts
        loadRAGStatus();
    } catch (err) {
        $('rag-answer-panel').style.display = 'block';
        $('rag-answer-body').innerHTML = `<p style="color:var(--red);">❌ ${err.message}</p>`;
    }

    btn.disabled = false;
    spinner.style.display = 'none';
});

// RAG suggested queries
$$('.rag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        $('rag-question').value = chip.dataset.q;
        $('rag-query-form').dispatchEvent(new Event('submit'));
    });
});

// Pipeline animation
function animatePipeline() {
    const steps = ['pipe-parse', 'pipe-chunk', 'pipe-embed', 'pipe-search', 'pipe-generate'];
    steps.forEach(s => document.getElementById(s).classList.remove('active'));
    steps.forEach((s, i) => {
        setTimeout(() => document.getElementById(s).classList.add('active'), i * 400);
    });
}

// Escape HTML helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Document Processing Buttons ────────────────────────────
$('analyze-sample-btn').addEventListener('click', async () => {
    selectedFile = null;
    $('upload-zone').style.display = 'none';
    $('mode-selector').style.display = 'block';
    $('docai-results').style.display = 'none';
    $('chunk-browser').style.display = 'none';
    $('analyze-sample-btn').classList.add('primary');
    $('upload-pdf-btn').classList.remove('primary');
});

$('upload-pdf-btn').addEventListener('click', () => {
    $('upload-zone').style.display = 'block';
    $('mode-selector').style.display = 'block';
    $('docai-results').style.display = 'none';
    $('chunk-browser').style.display = 'none';
    $('upload-pdf-btn').classList.add('primary');
    $('analyze-sample-btn').classList.remove('primary');
});

// Re-index button
$('rag-reindex-btn').addEventListener('click', async () => {
    const btn = $('rag-reindex-btn');
    btn.querySelector('span:nth-child(2)').textContent = 'Re-indexing...';
    btn.style.opacity = '0.6';
    btn.style.pointerEvents = 'none';

    try {
        const res = await fetch(API + '/api/rag/reindex', { method: 'POST' });
        const data = await res.json();
        btn.querySelector('span:nth-child(2)').textContent = `✅ Re-indexed ${data.chunks} chunks`;
        loadRAGStatus();
    } catch (err) {
        btn.querySelector('span:nth-child(2)').textContent = `❌ ${err.message}`;
    }

    setTimeout(() => {
        btn.querySelector('span:nth-child(2)').textContent = 'Re-index Statistical Data';
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
    }, 3000);
});

// Browse chunks button
$('browse-chunks-btn').addEventListener('click', () => {
    chunkPage = 1;
    loadChunkBrowser();
    $('chunk-browser').style.display = 'block';
    $('docai-results').style.display = 'none';
    $('mode-selector').style.display = 'none';
    $('upload-zone').style.display = 'none';
});

// Chunk browser
async function loadChunkBrowser() {
    try {
        const res = await fetch(`${API}/api/rag/chunks?page=${chunkPage}&pageSize=10`);
        const data = await res.json();

        $('chunk-page-info').textContent = `Page ${data.page} of ${data.totalPages} (${data.total} total chunks)`;

        let html = '';
        for (const chunk of data.chunks) {
            html += `
                <div class="chunk-card">
                    <div class="chunk-card-header">
                        <span class="chunk-card-id">${chunk.id}</span>
                        <span class="chunk-card-source">${chunk.metadata?.source || ''}</span>
                        <span class="chunk-card-type">${chunk.metadata?.type || ''}</span>
                    </div>
                    <div class="chunk-card-content">${escapeHtml(chunk.content)}</div>
                </div>`;
        }
        $('chunk-list').innerHTML = html || '<p style="color:var(--text-muted);text-align:center;padding:20px;">No chunks indexed yet.</p>';

        $('chunk-prev').disabled = data.page <= 1;
        $('chunk-next').disabled = data.page >= data.totalPages;
    } catch (err) {
        $('chunk-list').innerHTML = `<p style="color:var(--red);text-align:center;padding:20px;">Error: ${err.message}</p>`;
    }
}

$('chunk-prev').addEventListener('click', () => { if (chunkPage > 1) { chunkPage--; loadChunkBrowser(); } });
$('chunk-next').addEventListener('click', () => { chunkPage++; loadChunkBrowser(); });

// File upload handling
$('dropzone').addEventListener('click', () => $('pdf-upload').click());
$('pdf-upload').addEventListener('change', (e) => {
    if (e.target.files[0]) {
        selectedFile = e.target.files[0];
        $('file-info').style.display = 'block';
        $('file-info').textContent = `📎 ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
    }
});
$('dropzone').addEventListener('dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag-over'));
$('dropzone').addEventListener('drop', (e) => {
    e.preventDefault();
    $('dropzone').classList.remove('drag-over');
    if (e.dataTransfer.files[0]) {
        selectedFile = e.dataTransfer.files[0];
        $('file-info').style.display = 'block';
        $('file-info').textContent = `📎 ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
    }
});

// Mode selection
$$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;
        $('custom-prompt-area').style.display = selectedMode === 'custom' ? 'block' : 'none';
    });
});

// Run analysis
$('run-analysis-btn').addEventListener('click', async () => {
    const btn = $('run-analysis-btn');
    const spinner = $('analysis-spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';

    try {
        let result;
        if (selectedFile) {
            // User uploaded PDF
            const base64 = await fileToBase64(selectedFile);
            const body = {
                content: base64,
                mode: selectedMode,
                prompt: selectedMode === 'custom' ? $('custom-prompt').value : undefined,
            };
            const res = await fetch(API + '/api/gemini/pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            result = await res.json();
        } else {
            // Analyze sample PDF
            const body = {
                mode: selectedMode,
                prompt: selectedMode === 'custom' ? $('custom-prompt').value : undefined,
            };
            const res = await fetch(API + '/api/gemini/analyze-sample', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            result = await res.json();
        }

        $('docai-results').style.display = 'block';
        $('chunk-browser').style.display = 'none';
        $('result-meta').textContent = `Model: ${result.model || 'gemini-2.5-flash'} · Mode: ${selectedMode} · ${result.timestamp || new Date().toISOString()}`;

        if (result.error) {
            $('result-body').innerHTML = `<p style="color:var(--red);">❌ ${result.error}</p>`;
        } else if (selectedMode === 'transcribe') {
            $('result-body').innerHTML = result.result;
        } else {
            $('result-body').innerHTML = formatMarkdown(result.result);
        }
    } catch (err) {
        $('docai-results').style.display = 'block';
        $('result-body').innerHTML = `<p style="color:var(--red);">❌ ${err.message}</p>`;
    }

    btn.disabled = false;
    spinner.style.display = 'none';
});

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ── Data Explorer ──────────────────────────────────────────
async function loadDataExplorer() {
    window._dataLoaded = true;
    try {
        const res = await fetch(`${API}/api/data?page=${dataPage}&pageSize=${dataPageSize}&q=${encodeURIComponent(dataFilter)}`);
        const data = await res.json();

        // Render table
        let html = `<table>
            <thead><tr>
                <th>NPI</th><th>Total Paid</th><th>Claims</th><th>Procedures</th><th>Months</th><th>Avg/Claim</th><th>Avg Benes/Mo</th><th>CV</th><th>Z</th><th>Risk</th><th>Top HCPCS</th>
            </tr></thead><tbody>`;
        for (const r of data.rows) {
            html += `<tr>
                <td class="clickable" onclick="viewProvider('${r.npi}')">${r.npi}</td>
                <td class="money">${fmtMoney(r.total_paid)}</td>
                <td>${fmt(r.total_claims)}</td>
                <td>${fmt(r.procedures)}</td>
                <td>${fmt(r.months)}</td>
                <td>${fmtMoney(r.avg_per_claim)}</td>
                <td>${fmt(r.avg_benes)}</td>
                <td>${r.cv != null ? r.cv.toFixed(2) : '—'}</td>
                <td>${r.z_score != null ? Number(r.z_score).toFixed(2) : '—'}</td>
                <td><span class="risk-badge ${(r.risk_level || 'LOW').toLowerCase()}">${(r.risk_level || 'LOW')}</span></td>
                <td style="font-size:0.68rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.top_codes}">${r.top_codes || '—'}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        $('data-table-container').innerHTML = html;

        // Pagination
        $('data-page-info').textContent = `Page ${data.page} of ${data.totalPages} (${fmt(data.total)} providers)`;
        $('data-prev').disabled = data.page <= 1;
        $('data-next').disabled = data.page >= data.totalPages;

        // Summary
        $('data-summary').innerHTML = `Showing ${data.rows.length} of ${fmt(data.total)} providers · Source: <a href="${data.source}" target="_blank" style="color:var(--cyan);">GCS Bucket</a> · Aggregated from 227M+ raw Medicaid claims`;
    } catch (e) {
        $('data-table-container').innerHTML = `<div class="report-loading"><p style="color:var(--red);">Failed to load data: ${e.message}</p></div>`;
    }
}

$('data-prev').addEventListener('click', () => { if (dataPage > 1) { dataPage--; loadDataExplorer(); } });
$('data-next').addEventListener('click', () => { dataPage++; loadDataExplorer(); });
$('data-pagesize').addEventListener('change', (e) => { dataPageSize = Number(e.target.value); dataPage = 1; loadDataExplorer(); });
$('data-filter').addEventListener('input', debounce(() => { dataFilter = $('data-filter').value; dataPage = 1; loadDataExplorer(); }, 400));

// ── Codes Tab ──────────────────────────────────────────────
async function loadCodesTab() {
    window._codesLoaded = true;
    loadCodeAnomalies();
}

async function loadCodeAnomalies() {
    try {
        const url = `${API}/api/codes/anomalies?page=${codesPage}&pageSize=${codesPageSize}&q=${encodeURIComponent(codesFilter)}&minRatio=3`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.metadata && (!data.anomalies || !data.anomalies.length)) {
            $('codes-table-container').innerHTML = `<div class="report-loading"><p>📭 ${data.message || 'No code anomalies available yet.'}</p></div>`;
            $('codes-summary').innerHTML = '';
            $('codes-unbundling').innerHTML = 'Run <code>python analyze_codes.py</code> to generate unbundling signals.';
            return;
        }

        let html = `<table>
            <thead><tr>
                <th>Provider NPI</th><th>HCPCS</th><th>Total Paid</th><th>Claims</th><th>Provider Avg/Claim</th><th>National Avg/Claim</th><th>Ratio</th><th>Flag</th>
            </tr></thead><tbody>`;
        for (const row of (data.anomalies || [])) {
            const ratio = Number(row.ratio_to_national_avg || 0);
            const flag = row.flag || (ratio >= 5 ? 'CRITICAL' : ratio >= 3 ? 'HIGH' : 'ELEVATED');
            html += `<tr>
                <td class="clickable" onclick="viewProvider('${row.provider_npi}')">${row.provider_npi}</td>
                <td><code>${row.hcpcs_code || '—'}</code></td>
                <td class="money">${fmtMoney(row.total_paid)}</td>
                <td>${fmt(row.total_claims)}</td>
                <td>${fmtMoney(row.provider_avg_paid_per_claim)}</td>
                <td>${fmtMoney(row.national_avg_paid_per_claim)}</td>
                <td>${ratio.toFixed(2)}x</td>
                <td><span class="risk-badge ${flag.toLowerCase()}">${flag}</span></td>
            </tr>`;
        }
        html += '</tbody></table>';
        $('codes-table-container').innerHTML = html;

        $('codes-page-info').textContent = `Page ${data.page} of ${data.totalPages} (${fmt(data.total)} anomalies)`;
        $('codes-prev').disabled = data.page <= 1;
        $('codes-next').disabled = data.page >= data.totalPages;

        const meta = data.metadata || {};
        $('codes-summary').innerHTML = `Generated: ${meta.generated_at || '—'} · Providers scanned: ${fmt(meta.total_providers_scanned)} · Unique HCPCS: ${fmt(meta.total_hcpcs_codes)} · Threshold: >${meta.upcoding_ratio_threshold || 3}x national avg`;

        const unbundling = (data.unbundling_signals || []).slice(0, 10);
        if (unbundling.length) {
            $('codes-unbundling').innerHTML = unbundling.map((u) => `
                <div style="padding:.55rem .65rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-bottom:.5rem">
                    <div><strong>${u.bundle_name || u.code_pair || 'Unknown Pair'}</strong> · ${fmt(u.providers_flagged)} providers</div>
                    <div style="font-size:.76rem;color:var(--text-muted);margin-top:.25rem">
                        Example pair: ${(u.codes || []).join(' + ') || u.code_pair || '—'} · Co-billing instances: ${fmt(u.cooccurrences || 0)}
                    </div>
                </div>
            `).join('');
        } else {
            $('codes-unbundling').innerHTML = 'No unbundling signals were detected in the current output.';
        }
    } catch (e) {
        $('codes-table-container').innerHTML = `<div class="report-loading"><p style="color:var(--red);">Failed to load code anomalies: ${e.message}</p></div>`;
    }
}

$('codes-prev').addEventListener('click', () => { if (codesPage > 1) { codesPage--; loadCodeAnomalies(); } });
$('codes-next').addEventListener('click', () => { codesPage++; loadCodeAnomalies(); });
$('codes-pagesize').addEventListener('change', (e) => { codesPageSize = Number(e.target.value); codesPage = 1; loadCodeAnomalies(); });
$('codes-filter').addEventListener('input', debounce(() => { codesFilter = $('codes-filter').value; codesPage = 1; loadCodeAnomalies(); }, 400));

// ── Report Tab ─────────────────────────────────────────────
async function loadReport() {
    window._reportLoaded = true;
    try {
        const res = await fetch(API + '/api/report');
        const data = await res.json();
        if (data.report) {
            $('report-container').innerHTML = formatMarkdown(data.report);
        } else {
            $('report-container').innerHTML = `<div class="report-loading"><p>📋 ${data.message || 'No report available yet.'}</p><p style="color:var(--text-muted);font-size:0.78rem;margin-top:8px;">The fraud detection pipeline is still running. The report will appear here once detect_fraud.py completes Phase 2 (Gemini analysis).</p></div>`;
        }
    } catch (e) {
        $('report-container').innerHTML = `<div class="report-loading"><p style="color:var(--red);">Failed to load report: ${e.message}</p></div>`;
    }
}

// ── Debounce ───────────────────────────────────────────────
function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Boot ───────────────────────────────────────────────────
init();
loadProviders();

// ═══════════════════════════════════════════════════════════════
// GEOGRAPHY TAB
// ═══════════════════════════════════════════════════════════════

let geoPage = 1;
const GEO_PAGE_SIZE = 25;
let geoAllProviders = [];

async function loadGeography() {
    window._geoLoaded = true;

    // Load overview KPIs
    try {
        const res = await fetch(API + '/api/geo/overview');
        const data = await res.json();
        if (data.error) {
            $('geo-kpi-grid').innerHTML = `<div class="kpi-card" style="grid-column:1/-1"><div class="kpi-value" style="color:var(--accent-red);font-size:1rem">${data.error}</div></div>`;
            return;
        }
        $('geo-providers').textContent = fmt(data.total_enriched);
        $('geo-states').textContent = data.states_covered;
        $('geo-hotspots').textContent = data.zip_hotspots;
        $('geo-sources').textContent = data.grounding_sources;
    } catch (e) {
        console.error('Geo overview error:', e);
    }

    // Load state bars, zip hotspots, providers, investigation in parallel
    Promise.all([
        loadGeoStates(),
        loadGeoHotspots(),
        loadGeoProviders(),
        loadGeoInvestigation(),
    ]);
}

async function loadGeoStates() {
    try {
        const res = await fetch(API + '/api/geo/states');
        const data = await res.json();
        const states = data.states || [];
        if (!states.length) return;

        const maxPaid = states[0].total_paid;
        const colors = ['', 'purple', 'blue', 'orange', 'green'];
        const container = $('geo-state-bars');

        container.innerHTML = states.slice(0, 15).map((s, i) => {
            const pct = Math.max(3, (s.total_paid / maxPaid) * 100);
            const colorClass = colors[i % colors.length];
            return `
                <div class="geo-bar-row">
                    <span class="geo-bar-label">${s.state}</span>
                    <div class="geo-bar-track">
                        <div class="geo-bar-fill ${colorClass}" style="width:${pct}%">
                            <span class="geo-bar-value">$${fmtCompact(s.total_paid)}</span>
                        </div>
                    </div>
                    <span class="geo-bar-count">${s.count} prov</span>
                </div>`;
        }).join('');

        // Populate state filter dropdown
        const select = $('geo-state-filter');
        states.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.state;
            opt.textContent = `${s.state} (${s.count})`;
            select.appendChild(opt);
        });

    } catch (e) {
        console.error('Geo states error:', e);
    }
}

function fmtCompact(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
}

async function loadGeoHotspots() {
    try {
        const res = await fetch(API + '/api/geo/hotspots');
        const data = await res.json();
        const zips = data.zips || [];
        if (!zips.length) return;

        $('geo-zip-grid').innerHTML = zips.slice(0, 12).map(z => `
            <div class="hotspot-card">
                <div class="hotspot-header">
                    <span class="hotspot-zip">${z.zip}</span>
                    <span class="hotspot-badge">${z.count} providers</span>
                </div>
                <div class="hotspot-location">${z.city || '?'}, ${z.state || '?'}</div>
                <div class="hotspot-stat">Total Paid: <strong>$${fmt(Math.round(z.total_paid))}</strong></div>
                <div class="hotspot-stat" style="margin-top:4px">NPIs: <strong>${z.providers?.join(', ') || '—'}</strong></div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Geo hotspots error:', e);
    }
}

async function loadGeoProviders(stateFilter, riskFilter) {
    try {
        let url = API + `/api/geo/providers?limit=${GEO_PAGE_SIZE}&offset=${(geoPage - 1) * GEO_PAGE_SIZE}`;
        if (stateFilter) url += `&state=${stateFilter}`;
        if (riskFilter) url += `&risk=${riskFilter}`;

        const res = await fetch(url);
        const data = await res.json();
        geoAllProviders = data.providers || [];

        const riskBadge = (level) => {
            const colors = { CRITICAL: 'var(--accent-red)', HIGH: '#f59e0b', MEDIUM: '#eab308', ELEVATED: '#60a5fa', LOW: 'var(--accent-green)' };
            return `<span style="background:${colors[level] || 'gray'}22;color:${colors[level] || 'gray'};padding:2px 8px;border-radius:99px;font-size:.72rem;font-weight:600">${level}</span>`;
        };

        const tbody = $('geo-provider-tbody');
        tbody.innerHTML = geoAllProviders.map(p => `
            <tr>
                <td><span class="npi-link" style="cursor:pointer;color:var(--accent-blue)" onclick="geoProviderDetail('${p.npi}')">${p.npi}</span></td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.provider_name || ''}">${p.provider_name || '—'}</td>
                <td>${p.city || '—'}</td>
                <td><strong>${p.state || '—'}</strong></td>
                <td style="font-family:'JetBrains Mono',monospace;font-size:.82rem">${p.zip || '—'}</td>
                <td style="text-align:right;font-weight:600">$${fmt(Math.round(p.total_paid || 0))}</td>
                <td style="font-size:.78rem;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.taxonomy_desc || ''}">${p.taxonomy_desc || '—'}</td>
                <td>${riskBadge(p.risk_level || 'LOW')}</td>
            </tr>
        `).join('');

        const totalPages = Math.ceil(data.total / GEO_PAGE_SIZE);
        $('geo-page-info').textContent = `Page ${geoPage} of ${totalPages} (${data.total} providers)`;
        $('geo-prev-btn').disabled = geoPage <= 1;
        $('geo-next-btn').disabled = geoPage >= totalPages;
    } catch (e) {
        console.error('Geo providers error:', e);
    }
}

function geoProviderPage(delta) {
    geoPage += delta;
    if (geoPage < 1) geoPage = 1;
    const state = $('geo-state-filter').value;
    const risk = $('geo-risk-filter').value;
    loadGeoProviders(state, risk);
}

function geoProviderDetail(npi) {
    // Switch to providers tab and search for this NPI
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(t => t.classList.remove('active'));
    $('nav-providers').classList.add('active');
    $('tab-providers').classList.add('active');
    $('provider-search').value = npi;
    $('provider-search').dispatchEvent(new Event('input'));
}

// Filter event listeners
if ($('geo-state-filter')) {
    $('geo-state-filter').addEventListener('change', () => {
        geoPage = 1;
        loadGeoProviders($('geo-state-filter').value, $('geo-risk-filter').value);
    });
}
if ($('geo-risk-filter')) {
    $('geo-risk-filter').addEventListener('change', () => {
        geoPage = 1;
        loadGeoProviders($('geo-state-filter').value, $('geo-risk-filter').value);
    });
}

async function loadGeoInvestigation() {
    try {
        const res = await fetch(API + '/api/geo/investigation');
        const data = await res.json();
        if (data.report) {
            $('geo-investigation').innerHTML = formatMarkdown(data.report);
        } else {
            $('geo-investigation').innerHTML = '<p style="color:var(--text-muted)">No grounded investigation report available.</p>';
        }
    } catch (e) {
        console.error('Geo investigation error:', e);
    }
}

async function geoGroundedSearch(presetQuery) {
    const query = presetQuery || $('geo-search-input').value;
    if (!query) return;

    $('geo-search-input').value = query;
    $('geo-search-result').innerHTML = '<div class="report-loading"><div class="spinner"></div><p>Searching with Google Grounding...</p></div>';

    try {
        const res = await fetch(API + '/api/geo/grounded-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await res.json();

        let html = '<div class="geo-search-answer">';
        html += '<h4>🔍 Grounded Answer</h4>';
        html += formatMarkdown(data.answer || 'No answer found.');

        // Show sources
        const allUrls = new Set();
        (data.sources || []).forEach(s => {
            (s.urls || []).forEach(u => allUrls.add(u));
        });

        if (allUrls.size > 0) {
            html += '<div class="geo-search-sources">';
            html += '<strong style="font-size:.82rem;color:var(--text-secondary)">Sources:</strong>';
            [...allUrls].forEach(url => {
                const displayUrl = url.length > 80 ? url.substring(0, 77) + '...' : url;
                html += `<a href="${url}" target="_blank" rel="noopener">🔗 ${displayUrl}</a>`;
            });
            html += '</div>';
        }

        if (data.searchQueries?.length) {
            html += '<div style="margin-top:.75rem;padding-top:.5rem;border-top:1px solid var(--border)">';
            html += '<span style="font-size:.75rem;color:var(--text-muted)">Search queries: </span>';
            data.searchQueries.forEach(q => {
                html += `<span style="display:inline-block;background:var(--surface-2);padding:2px 8px;border-radius:4px;font-size:.72rem;margin:2px 4px;color:var(--text-secondary)">${q}</span>`;
            });
            html += '</div>';
        }

        html += '</div>';
        $('geo-search-result').innerHTML = html;
    } catch (e) {
        $('geo-search-result').innerHTML = `<div class="geo-search-answer"><p style="color:var(--accent-red)">Search failed: ${e.message}</p></div>`;
    }
}

// ═══════════════════════════════════════════════════════════════
// NJ DEEP DIVE TAB
// ═══════════════════════════════════════════════════════════════

window._njDebarmentProviders = [];

async function loadNJDeepDive() {
    window._njLoaded = true;
    try {
        // Load NJ overview
        const njRes = await fetch(API + '/api/nj/overview');
        const nj = await njRes.json();
        if (!nj.error) {
            $('nj-kpi-providers').textContent = nj.total_providers || '-';
            $('nj-kpi-paid').textContent = fmtMoney(nj.total_paid);
            $('nj-kpi-critical').textContent = nj.critical_count || 0;
            $('nj-kpi-high').textContent = nj.high_count || 0;
            $('nj-kpi-investigated').textContent = nj.investigated || 0;
            $('nj-kpi-sources').textContent = nj.sources_found || 0;
        }
        loadNJProviders();
    } catch (e) {
        console.error('NJ overview error:', e);
    }

    // Load debarment data
    try {
        const debRes = await fetch(API + '/api/nj/debarment/overview');
        const deb = await debRes.json();
        if (!deb.error) {
            renderDebarmentSection(deb);
        }
        // Load full debarment list
        const listRes = await fetch(API + '/api/nj/debarment/providers?limit=500');
        const listData = await listRes.json();
        if (listData.providers) {
            window._njDebarmentProviders = listData.providers;
            renderDebarmentList(listData.providers);
        }
    } catch (e) {
        console.error('Debarment load error:', e);
    }

    // Load culprit dossiers
    try {
        const dosRes = await fetch(API + '/api/nj/dossiers/overview');
        const dos = await dosRes.json();
        if (!dos.error && dos.metadata) {
            $('dos-kpi-suspects').textContent = dos.metadata.total_suspects || 0;
            $('dos-kpi-federal').textContent = dos.metadata.post_exclusion_offenders || 0;
            $('dos-kpi-exposure').textContent = fmtMoney(dos.metadata.total_fraud_exposure || 0);
            $('dos-kpi-sources').textContent = dos.metadata.total_sources || 0;
        }
        // Load dossier list
        const listRes = await fetch(API + '/api/nj/dossiers/list');
        const listData = await listRes.json();
        if (listData.dossiers) {
            window._njDossiers = listData.dossiers;
            renderDossierTable(listData.dossiers);
        }
    } catch (e) {
        console.error('Dossier load error:', e);
    }
}

async function loadNJProviders() {
    const risk = $('nj-risk-filter')?.value || '';
    try {
        const res = await fetch(API + '/api/nj/providers?limit=50' + (risk ? '&risk=' + risk : ''));
        const data = await res.json();
        const providers = data.providers || [];
        const container = $('nj-providers-table');
        if (!providers.length) {
            container.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No NJ providers found. Run: node nj_deep_dive.js</p>';
            return;
        }
        let html = '<table class="data-table"><thead><tr><th>Provider</th><th>NPI</th><th>City</th><th>Total Paid</th><th>Risk</th><th>Score</th><th>Red Flags</th></tr></thead><tbody>';
        for (const p of providers) {
            const riskColor = p.risk_level === 'CRITICAL' ? '#ef4444' : p.risk_level === 'HIGH' ? '#f97316' : '#eab308';
            html += `<tr style="cursor:pointer" onclick="showNJProviderDetail('${p.npi}')">
                <td style="font-weight:600;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.provider_name || p.npi}</td>
                <td style="font-family:monospace;font-size:.8rem">${p.npi}</td>
                <td>${p.city || '-'}</td>
                <td style="font-weight:600">${fmtMoney(p.total_paid || 0)}</td>
                <td><span style="background:${riskColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:.75rem;font-weight:700">${p.risk_level}</span></td>
                <td>${p.risk_score || '-'}</td>
                <td>${(p.red_flags || []).length}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (e) {
        $('nj-providers-table').innerHTML = `<p style="color:var(--accent-red)">Error: ${e.message}</p>`;
    }
}

async function showNJProviderDetail(npi) {
    try {
        const res = await fetch(API + '/api/nj/provider/' + npi);
        const data = await res.json();
        const p = data.provider;
        const inv = data.investigation;
        let html = `<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:2rem" onclick="if(event.target===this)this.remove()">`;
        html += `<div style="background:var(--surface-1);border-radius:16px;max-width:800px;width:100%;max-height:80vh;overflow-y:auto;padding:2rem;border:1px solid var(--border)">`;
        html += `<h2 style="margin-bottom:1rem">${p.provider_name}</h2>`;
        html += `<p>NPI: <code>${p.npi}</code> | City: ${p.city || '-'} | ZIP: ${p.zip || '-'}</p>`;
        html += `<p>Total Paid: <strong>${fmtMoney(p.total_paid || 0)}</strong> | Risk: <span style="color:${p.risk_level === 'CRITICAL' ? '#ef4444' : '#f97316'}">${p.risk_level} (${p.risk_score})</span></p>`;
        if (p.red_flags?.length) {
            html += '<h3 style="margin-top:1rem;color:#ef4444">🚩 Red Flags</h3><ul>';
            p.red_flags.forEach(f => html += `<li>${f}</li>`);
            html += '</ul>';
        }
        if (inv) {
            html += '<h3 style="margin-top:1rem">🔍 Google Search Intelligence</h3>';
            html += `<div style="background:var(--surface-2);padding:1rem;border-radius:8px;margin-top:.5rem;white-space:pre-wrap;font-size:.85rem;max-height:300px;overflow-y:auto">${inv.summary || inv.analysis || 'No findings'}</div>`;
            if (inv.sources?.length) {
                html += '<h4 style="margin-top:1rem">Sources:</h4><ul style="font-size:.8rem">';
                inv.sources.slice(0, 10).forEach(s => {
                    html += `<li><a href="${s.url || s.uri || '#'}" target="_blank" style="color:var(--accent)">${s.title || s.url || 'Source'}</a></li>`;
                });
                html += '</ul>';
            }
        }
        html += '<div style="text-align:right;margin-top:1.5rem"><button class="btn btn-primary" onclick="this.closest(\x27div[style*=\"position:fixed\"]\x27).remove()">Close</button></div>';
        html += '</div></div>';
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (e) {
        console.error('Provider detail error:', e);
    }
}

function renderDebarmentSection(deb) {
    $('deb-kpi-debarred').textContent = deb.total_debarred;
    $('deb-kpi-matched').textContent = deb.matched_in_claims;
    $('deb-kpi-post-exclusion').textContent = deb.post_exclusion_providers;
    $('deb-kpi-paid').textContent = fmtMoney(deb.post_exclusion_total_paid || 0);
    if ($('deb-total-count')) $('deb-total-count').textContent = deb.total_debarred;

    // Offenders table
    const offenders = deb.top_offenders || [];
    if (offenders.length > 0) {
        let html = '<table class="data-table"><thead><tr><th>Provider</th><th>NPI</th><th>Excluded</th><th>Action</th><th>Post-Excl. Paid</th><th>Post-Excl. Claims</th><th>Total Paid</th><th>Severity</th></tr></thead><tbody>';
        for (const o of offenders) {
            const sevColor = o.severity === 'CRITICAL' ? '#ef4444' : o.severity === 'HIGH' ? '#f97316' : o.severity === 'MEDIUM' ? '#eab308' : '#22c55e';
            html += `<tr>
                <td style="font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${o.name}">${o.name}</td>
                <td style="font-family:monospace;font-size:.8rem">${o.npi}</td>
                <td>${o.exclusion_date || '-'}</td>
                <td style="font-size:.8rem">${o.action_type || '-'}</td>
                <td style="font-weight:700;color:#ef4444">${fmtMoney(o.post_exclusion_paid || 0)}</td>
                <td style="color:#ef4444">${o.post_exclusion_claims || 0}</td>
                <td>${fmtMoney(o.total_paid || 0)}</td>
                <td><span style="background:${sevColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:.75rem;font-weight:700">${o.severity}</span></td>
            </tr>`;
            // Expandable flags row
            if (o.flags?.length > 0) {
                html += `<tr><td colspan="8" style="padding:4px 16px 12px;border-top:none">`;
                o.flags.forEach(f => {
                    html += `<span style="display:inline-block;background:rgba(239,68,68,0.1);color:#ef4444;padding:3px 10px;border-radius:6px;font-size:.75rem;margin:2px 4px;border:1px solid rgba(239,68,68,0.2)">⚠️ ${f}</span>`;
                });
                html += '</td></tr>';
            }
        }
        html += '</tbody></table>';
        $('deb-offenders-table').innerHTML = html;
    } else {
        $('deb-offenders-table').innerHTML = '<p style="color:var(--text-muted);padding:1rem">No post-exclusion offenders found.</p>';
    }

    // Severity distribution
    const sevCounts = deb.severity_counts || {};
    const total = Object.values(sevCounts).reduce((a, b) => a + b, 0) || 1;
    const sevDist = $('deb-severity-dist');
    const sevConfig = [
        { key: 'CRITICAL', color: '#ef4444', label: 'CRITICAL' },
        { key: 'HIGH', color: '#f97316', label: 'HIGH' },
        { key: 'MEDIUM', color: '#eab308', label: 'MEDIUM' },
        { key: 'LOW', color: '#22c55e', label: 'LOW' },
        { key: 'INFO', color: '#6b7280', label: 'INFO' },
    ];
    let distHtml = '';
    for (const s of sevConfig) {
        const count = sevCounts[s.key] || 0;
        const pct = ((count / total) * 100).toFixed(0);
        distHtml += `<div style="flex:1;min-width:120px;background:var(--surface-2);border-radius:12px;padding:1rem;text-align:center;border-left:4px solid ${s.color}">
            <div style="font-size:1.5rem;font-weight:800;color:${s.color}">${count}</div>
            <div style="font-size:.75rem;color:var(--text-secondary);margin-top:.25rem">${s.label}</div>
            <div style="background:var(--surface-1);border-radius:4px;height:6px;margin-top:.5rem;overflow:hidden">
                <div style="background:${s.color};height:100%;width:${pct}%;border-radius:4px;transition:width 0.6s ease"></div>
            </div>
        </div>`;
    }
    sevDist.innerHTML = distHtml;
}

function renderDebarmentList(providers) {
    const list = $('deb-full-list');
    if (!providers.length) {
        list.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No debarment data loaded.</p>';
        return;
    }
    let html = '<table class="data-table" style="font-size:.82rem"><thead><tr><th>Name</th><th>NPI</th><th>Type</th><th>Excluded</th><th>Action</th><th>Status</th></tr></thead><tbody>';
    for (const p of providers) {
        const statusColor = p.status === 'Permanent' ? '#ef4444' : p.status === 'Active' ? '#f97316' : '#22c55e';
        html += `<tr>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.name}">${p.name}</td>
            <td style="font-family:monospace;font-size:.75rem">${p.npi || '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="font-size:.75rem">${p.provider_type || '-'}</td>
            <td>${p.exclusion_date || '-'}</td>
            <td style="font-size:.75rem">${p.action_type || '-'}</td>
            <td><span style="color:${statusColor};font-weight:600;font-size:.75rem">${p.status || '-'}</span></td>
        </tr>`;
    }
    html += '</tbody></table>';
    list.innerHTML = html;
}

function filterDebarmentList() {
    const query = ($('deb-search')?.value || '').toLowerCase();
    const filtered = window._njDebarmentProviders.filter(p => {
        const searchable = [p.name, p.npi, p.provider_type, p.action_type, p.city, p.reason].filter(Boolean).join(' ').toLowerCase();
        return searchable.includes(query);
    });
    renderDebarmentList(filtered);
}

async function njGroundedSearch(preset) {
    const query = preset || $('nj-search-input')?.value;
    if (!query) return;
    if (!preset) $('nj-search-input').value = query;
    $('nj-search-result').innerHTML = '<div style="padding:1rem;color:var(--text-muted)"><div class="loading-spinner" style="margin:0 auto"></div><p style="text-align:center;margin-top:.5rem">Searching with Google grounding...</p></div>';
    try {
        const res = await fetch(API + '/api/nj/grounded-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await res.json();
        let html = '<div style="background:var(--surface-2);border-radius:12px;padding:1.25rem;margin-top:.5rem;border:1px solid var(--border)">';
        html += `<div style="white-space:pre-wrap;line-height:1.6;font-size:.9rem">${(data.answer || 'No results').replace(/\n/g, '<br>')}</div>`;
        if (data.sources?.length) {
            html += '<div style="margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--border)">';
            html += '<span style="font-size:.8rem;font-weight:600;color:var(--text-secondary)">Sources:</span><br>';
            const urls = new Set();
            data.sources.forEach(s => s.urls?.forEach(u => urls.add(u)));
            [...urls].slice(0, 8).forEach(u => {
                try {
                    const domain = new URL(u).hostname.replace('www.', '');
                    html += `<a href="${u}" target="_blank" style="display:inline-block;background:var(--surface-1);padding:3px 10px;border-radius:6px;font-size:.75rem;margin:3px 4px;color:var(--accent);text-decoration:none;border:1px solid var(--border)">${domain}</a>`;
                } catch (e) { }
            });
            html += '</div>';
        }
        html += '</div>';
        $('nj-search-result').innerHTML = html;
    } catch (e) {
        $('nj-search-result').innerHTML = `<p style="color:var(--accent-red);padding:1rem">Search failed: ${e.message}</p>`;
    }
}

async function loadNJReport() {
    const btn = $('nj-report-btn');
    const container = $('nj-report-content');
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
        const res = await fetch(API + '/api/nj/report');
        const data = await res.json();
        if (data.report) {
            container.innerHTML = `<div style="background:var(--surface-2);border-radius:8px;padding:1.5rem;white-space:pre-wrap;font-family:'Inter',sans-serif;font-size:.85rem;line-height:1.7">${data.report.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
        } else {
            container.innerHTML = '<p style="color:var(--text-muted)">No report available. Run nj_deep_dive.js first.</p>';
        }
    } catch (e) {
        container.innerHTML = `<p style="color:var(--accent-red)">Error: ${e.message}</p>`;
    }
    btn.disabled = false;
    btn.textContent = 'Load Report';
}

// ═══ CULPRIT DOSSIER FUNCTIONS ═══

function renderDossierTable(dossiers, filter = 'all') {
    const container = $('dossier-table');
    if (!container) return;

    const filtered = filter === 'all' ? dossiers : dossiers.filter(d => {
        if (filter === 'POST-EXCLUSION') return d.post_exclusion_paid > 0;
        if (filter === 'DEBARMENT-MATCH') return d.severity && !d.risk_level;
        if (filter === 'HIGH-RISK') return d.risk_level === 'CRITICAL' || d.risk_level === 'HIGH';
        return true;
    });

    let html = `<table class="data-table" style="font-size:.8rem">
        <thead><tr>
            <th>SUSPECT</th>
            <th>NPI</th>
            <th>CITY</th>
            <th>OFFICIAL / OWNER</th>
            <th>TOTAL PAID</th>
            <th>POST-EXCL.</th>
            <th>CATEGORY</th>
            <th>SOURCES</th>
            <th></th>
        </tr></thead><tbody>`;

    for (const d of filtered) {
        const catBadges = (d.fraud_category || []).map(c => {
            if (c.includes('POST-EXCLUSION') && c.includes('$100K')) return `<span style="color:#fff;background:#dc2626;padding:2px 6px;border-radius:4px;font-size:.7rem;white-space:nowrap">🚨 ${c}</span>`;
            if (c.includes('POST-EXCLUSION')) return `<span style="color:#fff;background:#ef4444;padding:2px 6px;border-radius:4px;font-size:.7rem;white-space:nowrap">🚨 Post-Exclusion</span>`;
            if (c.includes('SELF-REFERRAL')) return `<span style="color:#fff;background:#f59e0b;padding:2px 6px;border-radius:4px;font-size:.7rem;white-space:nowrap">♻️ Self-Referral</span>`;
            if (c.includes('MEGA-BILLER')) return `<span style="color:#fff;background:#8b5cf6;padding:2px 6px;border-radius:4px;font-size:.7rem;white-space:nowrap">💰 Mega-Biller</span>`;
            return `<span style="color:#ccc;background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-size:.7rem;white-space:nowrap">${c}</span>`;
        }).join(' ');

        const postExcl = d.post_exclusion_paid > 0
            ? `<span style="color:#ef4444;font-weight:700">${fmtMoney(d.post_exclusion_paid)}</span>`
            : '<span style="color:var(--text-muted)">—</span>';

        html += `<tr style="cursor:pointer" onclick="toggleDossierDetail('${d.npi}')">
            <td style="font-weight:600;color:var(--text-primary)">${d.name}</td>
            <td style="font-family:monospace;font-size:.75rem">${d.npi}</td>
            <td>${d.city || '—'}</td>
            <td style="color:var(--text-secondary)">${d.authorized_official || '—'}</td>
            <td style="font-weight:600">${fmtMoney(d.total_medicaid_paid)}</td>
            <td>${postExcl}</td>
            <td>${catBadges}</td>
            <td style="text-align:center">${d.sources_count || 0}</td>
            <td>▼</td>
        </tr>
        <tr id="dossier-detail-${d.npi}" style="display:none">
            <td colspan="9" style="padding:0"><div id="dossier-detail-content-${d.npi}" style="padding:1rem;background:var(--surface-2);border-radius:6px;margin:4px"></div></td>
        </tr>`;
    }

    html += '</tbody></table>';
    html += `<p style="color:var(--text-muted);font-size:.75rem;margin-top:.5rem">Showing ${filtered.length} of ${dossiers.length} suspects. Click any row to expand investigation details.</p>`;
    container.innerHTML = html;
}

function filterDossiers(filter) {
    if (window._njDossiers) renderDossierTable(window._njDossiers, filter);
}

async function toggleDossierDetail(npi) {
    const row = $('dossier-detail-' + npi);
    const content = $('dossier-detail-content-' + npi);
    if (!row || !content) return;

    if (row.style.display !== 'none') {
        row.style.display = 'none';
        return;
    }

    row.style.display = '';

    if (content.dataset.loaded) return;
    content.innerHTML = '<p style="color:var(--text-muted)">Loading investigation details...</p>';

    try {
        const res = await fetch(API + '/api/nj/dossiers/suspect/' + npi);
        const d = await res.json();
        if (d.error) {
            content.innerHTML = `<p style="color:var(--accent-red)">${d.error}</p>`;
            return;
        }

        const addr = d.addresses?.[0] || {};
        const taxonomies = (d.taxonomies || []).map(t => t.desc).join(', ') || 'N/A';
        const otherNames = (d.other_names || []).map(n => n.name).filter(Boolean).join(', ') || 'None';
        const otherIds = (d.other_identifiers || []).map(id => `${id.type}: ${id.identifier}`).join(', ') || 'None';
        const flags = (d.red_flags || []).map(f => `<span style="display:inline-block;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:.75rem;margin:2px">${f}</span>`).join(' ');
        const categories = (d.fraud_category || []).join(' • ');

        let html = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
            <div>
                <h4 style="color:#f59e0b;margin-bottom:.5rem">📋 Identity & Registration</h4>
                <p style="font-size:.85rem;line-height:1.8;color:var(--text-secondary)">
                    <strong>Name:</strong> ${d.name}<br>
                    <strong>NPI:</strong> ${d.npi} | <strong>Type:</strong> ${d.entity_type}<br>
                    <strong>Address:</strong> ${addr.line1 || 'Unknown'}, ${addr.city || ''} ${addr.state || ''} ${addr.zip || ''}<br>
                    <strong>Phone:</strong> ${addr.phone || 'N/A'} | <strong>Fax:</strong> ${addr.fax || 'N/A'}<br>
                    <strong>Specialties:</strong> ${taxonomies}<br>
                    <strong>Other Names:</strong> ${otherNames}<br>
                    <strong>Other IDs:</strong> ${otherIds}<br>
                    ${d.parent_organization ? `<strong>Parent Org:</strong> ${d.parent_organization}<br>` : ''}
                    ${d.authorized_official ? `<strong>Auth Official:</strong> ${d.authorized_official} (${d.authorized_official_title || 'N/A'})<br>` : ''}
                    <strong>Enumeration:</strong> ${d.enumeration_date || 'N/A'} | <strong>Status:</strong> ${d.npi_status || 'Unknown'}
                    ${d.deactivation_date ? `<br><span style="color:#ef4444"><strong>⚠️ DEACTIVATED:</strong> ${d.deactivation_date}</span>` : ''}
                </p>
            </div>
            <div>
                <h4 style="color:#ef4444;margin-bottom:.5rem">💰 Financial Exposure</h4>
                <p style="font-size:.85rem;line-height:1.8;color:var(--text-secondary)">
                    <strong>Total Medicaid Paid:</strong> <span style="color:#f59e0b;font-weight:700">${fmtMoney(d.total_medicaid_paid)}</span><br>
                    ${d.post_exclusion_paid > 0 ? `<strong style="color:#ef4444">🚨 POST-EXCLUSION:</strong> <span style="color:#ef4444;font-weight:700">${fmtMoney(d.post_exclusion_paid)}</span> (${d.post_exclusion_claims} claims)<br>` : ''}
                    ${d.exclusion_date ? `<strong>Excluded:</strong> ${d.exclusion_date} | <strong>Action:</strong> ${d.action_type || 'N/A'}<br>` : ''}
                    <strong>Risk:</strong> ${d.risk_level || d.severity || 'N/A'} (Score: ${d.risk_score || 'N/A'})<br>
                    <strong>Categories:</strong> ${categories}
                </p>
                <div style="margin-top:.5rem">${flags}</div>
            </div>
        </div>`;

        if (d.investigation_report) {
            html += `
            <div style="margin-top:1rem">
                <h4 style="color:#10b981;margin-bottom:.5rem">🔍 OSINT Investigation Report</h4>
                <div style="background:rgba(16,185,129,0.05);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:1rem;max-height:400px;overflow-y:auto;white-space:pre-wrap;font-size:.8rem;line-height:1.7;color:var(--text-secondary)">${(d.investigation_report || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            </div>`;
        }

        if (d.investigation_sources?.length > 0) {
            html += `<div style="margin-top:.75rem"><h4 style="color:#8b5cf6;margin-bottom:.5rem">📰 Sources (${d.investigation_sources.length})</h4><div style="display:flex;flex-wrap:wrap;gap:.5rem">`;
            for (const s of d.investigation_sources.slice(0, 20)) {
                html += `<a href="${s.url}" target="_blank" style="display:inline-block;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.3);color:#c4b5fd;padding:2px 8px;border-radius:4px;font-size:.7rem;text-decoration:none;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.title || s.url}</a>`;
            }
            html += '</div></div>';
        }

        content.innerHTML = html;
        content.dataset.loaded = 'true';
    } catch (e) {
        content.innerHTML = `<p style="color:var(--accent-red)">Error: ${e.message}</p>`;
    }
}

async function loadProsecutionReport() {
    const btn = $('prosecution-report-btn');
    const container = $('prosecution-report-content');
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
        const res = await fetch(API + '/api/nj/dossiers/report');
        const data = await res.json();
        if (data.report) {
            // Simple markdown rendering
            let html = data.report
                .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/^### \*\*(.+?)\*\*$/gm, '<h3 style="color:#f59e0b;margin:1.5rem 0 .5rem">$1</h3>')
                .replace(/^#### \*\*(.+?)\*\*$/gm, '<h4 style="color:#ef4444;margin:1rem 0 .3rem">$1</h4>')
                .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-primary)">$1</strong>')
                .replace(/^---$/gm, '<hr style="border-color:rgba(255,255,255,0.1);margin:1.5rem 0">')
                .replace(/^\* /gm, '• ')
                .replace(/\n/g, '<br>');
            container.innerHTML = `<div style="background:var(--surface-2);border-radius:8px;padding:1.5rem;font-family:'Inter',sans-serif;font-size:.85rem;line-height:1.7">${html}</div>`;
        } else {
            container.innerHTML = '<p style="color:var(--text-muted)">No prosecution report available. Run: node nj_fraud_hunter.js</p>';
        }
    } catch (e) {
        container.innerHTML = `<p style="color:var(--accent-red)">Error: ${e.message}</p>`;
    }
    btn.disabled = false;
    btn.textContent = 'Load Full Report';
}

// ═══════════════════════════════════════════════════════════════
// COMMUNITY HUB — Public-facing fraud transparency features
// ═══════════════════════════════════════════════════════════════

let communityChatHistory = [];

async function loadCommunityHub() {
    window._communityLoaded = true;

    try {
        const res = await fetch(API + '/api/community/summary');
        const data = await res.json();

        // Update headline
        if (data.headline) {
            $('community-headline').textContent = data.headline;
        }

        // Render findings cards
        const grid = $('community-findings-grid');
        if (data.key_findings && data.key_findings.length) {
            grid.innerHTML = data.key_findings.map(f => `
                <div class="community-finding-card" data-severity="${f.severity}">
                    <div class="community-finding-icon">${f.icon}</div>
                    <div class="community-finding-title">${f.title}</div>
                    <div class="community-finding-detail">${f.detail}</div>
                </div>
            `).join('');
        }

        // Update pipeline steps if provided
        if (data.how_it_works) {
            const pipeline = $('community-pipeline');
            pipeline.innerHTML = data.how_it_works.map((step, i) => `
                ${i > 0 ? '<div class="pipeline-connector"></div>' : ''}
                <div class="pipeline-step">
                    <div class="pipeline-step-num">${step.step}</div>
                    <div class="pipeline-step-content">
                        <h4>${step.title}</h4>
                        <p>${step.desc}</p>
                    </div>
                </div>
            `).join('');
        }

    } catch (e) {
        console.error('Community hub load error:', e);
    }
}

// ── Search ──────────────────────────────────────────────────

async function communitySearch(overrideQuery) {
    const input = $('community-search-input');
    const btn = $('community-search-btn');
    const query = overrideQuery || input.value.trim();

    if (!query) return;

    btn.disabled = true;
    btn.textContent = 'Searching...';

    try {
        // Auto-detect query type
        let params = '';
        const isZip = /^\d{3,5}$/.test(query);
        const isState = /^[A-Za-z]{2}$/.test(query);

        if (isZip) {
            params = `zip=${query}`;
        } else if (isState) {
            params = `state=${query.toUpperCase()}`;
        } else if (query.length <= 20) {
            // Could be city name or general search
            params = `q=${encodeURIComponent(query)}`;
        } else {
            params = `q=${encodeURIComponent(query)}`;
        }

        const res = await fetch(API + '/api/community/search?' + params);
        const data = await res.json();

        renderCommunityResults(data, query);
    } catch (e) {
        console.error('Search error:', e);
        const results = $('community-search-results');
        results.style.display = 'block';
        $('community-results-header').innerHTML = `<h3 style="color:var(--red)">Search Error</h3><p>${e.message}</p>`;
        $('community-results-risk-bar').innerHTML = '';
        $('community-results-list').innerHTML = '';
    }

    btn.disabled = false;
    btn.textContent = 'Search';
}

function communityQuickSearch(state) {
    $('community-search-input').value = state;
    communitySearch(state);
}

function renderCommunityResults(data, query) {
    const results = $('community-search-results');
    results.style.display = 'block';

    const total = data.total || 0;
    const exposure = data.geo_summary?.total_exposure || 0;
    const risk = data.geo_summary?.risk_breakdown || {};

    // Header
    $('community-results-header').innerHTML = `
        <h3>${total === 0 ? 'No Results Found' : `${total} Flagged Provider${total !== 1 ? 's' : ''} Found`}</h3>
        <p>${total > 0 ? `Total suspicious billing: <strong style="color:var(--red)">$${(exposure / 1e6 >= 1000 ? (exposure / 1e9).toFixed(1) + 'B' : (exposure / 1e6).toFixed(1) + 'M')}</strong> — Search: "${query}"` : `We don't have flagged providers matching "${query}" in our current dataset. Try a different zip code, city, or state.`}</p>
    `;

    // Risk bar
    if (total > 0) {
        const riskTotal = (risk.critical || 0) + (risk.high || 0) + (risk.medium || 0) + (risk.low || 0);
        if (riskTotal > 0) {
            $('community-results-risk-bar').innerHTML = `
                <div class="risk-segment" style="width:${(risk.critical / riskTotal * 100)}%;background:#ef4444" title="Critical: ${risk.critical}"></div>
                <div class="risk-segment" style="width:${(risk.high / riskTotal * 100)}%;background:#f59e0b" title="High: ${risk.high}"></div>
                <div class="risk-segment" style="width:${(risk.medium / riskTotal * 100)}%;background:#6366f1" title="Medium: ${risk.medium}"></div>
                <div class="risk-segment" style="width:${(risk.low / riskTotal * 100)}%;background:#6b7280" title="Low: ${risk.low}"></div>
            `;
        }
    } else {
        $('community-results-risk-bar').innerHTML = '';
    }

    // Results list
    if (total === 0) {
        $('community-results-list').innerHTML = `
            <div class="community-no-results">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/></svg>
                <p>Try searching by state abbreviation (e.g., NJ, NY, CA) for broader results</p>
            </div>
        `;
        return;
    }

    $('community-results-list').innerHTML = (data.results || []).map(r => {
        const riskClass = r.risk_level ? r.risk_level.toLowerCase().replace(/[^a-z-]/g, '') : 'unknown';
        const displayRisk = r.fraud_category || r.risk_level || 'Unknown';
        const postExclusion = r.post_exclusion_paid ? `<span style="color:#ef4444;font-size:.75rem;margin-left:.5rem">⚠️ $${Number(r.post_exclusion_paid).toLocaleString()} post-exclusion</span>` : '';

        return `
            <div class="community-result-row">
                <div>
                    <div class="community-result-name">${r.name || 'Provider ' + r.npi}${postExclusion}</div>
                    <div class="community-result-location">📍 ${[r.city, r.state, r.zip].filter(Boolean).join(', ') || 'Location unknown'}</div>
                </div>
                <div class="community-result-amount">${fmtMoney(r.total_paid)}</div>
                <div class="community-result-risk ${riskClass}">${displayRisk}</div>
                <div class="community-result-npi">${r.npi}</div>
            </div>
        `;
    }).join('');

    // Scroll to results
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Enter key for search
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = $('community-search-input');
    if (searchInput) {
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') communitySearch();
        });
    }
    const chatInput = $('community-chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') communityChatSend();
        });
    }
});

// ── Geolocation ─────────────────────────────────────────────

async function communityGeolocate() {
    const btn = $('community-geo-btn');
    const input = $('community-search-input');

    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
    }

    btn.textContent = '📡 Locating...';
    btn.disabled = true;

    try {
        const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: false,
                timeout: 10000,
            });
        });

        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        // Use Google Maps Geocoding to get zip code from coords
        try {
            const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=postal_code&key=AIzaSyBSa36MUVb-Nmp0PvI6IA5_2AiyC1JVf0g`);
            const geoData = await geoRes.json();

            if (geoData.results && geoData.results.length > 0) {
                const components = geoData.results[0].address_components || [];
                const zipComp = components.find(c => c.types.includes('postal_code'));
                const stateComp = components.find(c => c.types.includes('administrative_area_level_1'));

                if (zipComp) {
                    input.value = zipComp.short_name;
                    communitySearch(zipComp.short_name);
                } else if (stateComp) {
                    input.value = stateComp.short_name;
                    communitySearch(stateComp.short_name);
                } else {
                    // Fallback — search by coordinates text
                    input.value = `${lat.toFixed(2)},${lng.toFixed(2)}`;
                    alert('Could not determine your zip code. Try entering it manually.');
                }
            } else {
                // Fallback - try without Google API using a free service
                try {
                    const fallbackRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`);
                    const fallbackData = await fallbackRes.json();
                    const state = fallbackData.address?.state;
                    const postcode = fallbackData.address?.postcode;
                    if (postcode) {
                        input.value = postcode;
                        communitySearch(postcode);
                    } else if (state) {
                        // Convert state name to abbreviation
                        const stateAbbrevs = { 'New Jersey': 'NJ', 'New York': 'NY', 'California': 'CA', 'Massachusetts': 'MA', 'Tennessee': 'TN', 'Pennsylvania': 'PA', 'Florida': 'FL', 'Texas': 'TX', 'Illinois': 'IL', 'Ohio': 'OH', 'Georgia': 'GA', 'Michigan': 'MI', 'North Carolina': 'NC', 'Virginia': 'VA', 'Maryland': 'MD', 'Connecticut': 'CT', 'Minnesota': 'MN', 'Wisconsin': 'WI', 'Indiana': 'IN', 'Missouri': 'MO', 'Colorado': 'CO', 'Arizona': 'AZ', 'Oregon': 'OR', 'Washington': 'WA', 'Louisiana': 'LA', 'Kentucky': 'KY', 'Alabama': 'AL', 'South Carolina': 'SC', 'Oklahoma': 'OK', 'Iowa': 'IA', 'Mississippi': 'MS', 'Arkansas': 'AR', 'Kansas': 'KS', 'Utah': 'UT', 'Nevada': 'NV' };
                        const abbrev = stateAbbrevs[state] || state;
                        input.value = abbrev;
                        communitySearch(abbrev);
                    }
                } catch (fallbackErr) {
                    alert('Could not determine your location. Please enter your zip code manually.');
                }
            }
        } catch (geoErr) {
            // Google Maps API failed, try OpenStreetMap
            try {
                const fallbackRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`);
                const fallbackData = await fallbackRes.json();
                const postcode = fallbackData.address?.postcode;
                if (postcode) {
                    input.value = postcode;
                    communitySearch(postcode);
                } else {
                    alert('Could not determine your zip code. Try entering it manually.');
                }
            } catch (e2) {
                alert('Location lookup failed. Please enter your zip code manually.');
            }
        }
    } catch (err) {
        if (err.code === 1) {
            alert('Location permission denied. Please enter your zip code manually.');
        } else {
            alert('Could not get your location. Please enter your zip code manually.');
        }
    }

    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg> Use My Location`;
    btn.disabled = false;
}

// ── Community Chat ──────────────────────────────────────────

function communityChatQuick(msg) {
    $('community-chat-input').value = msg;
    communityChatSend();
}

async function communityChatSend() {
    const input = $('community-chat-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    const messages = $('community-chat-messages');

    // Add user message
    messages.innerHTML += `
        <div class="community-chat-msg community-chat-user">
            <div class="community-chat-avatar">👤</div>
            <div class="community-chat-bubble"><p>${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p></div>
        </div>
    `;

    // Add typing indicator
    const typingId = 'typing-' + Date.now();
    messages.innerHTML += `
        <div class="community-chat-msg community-chat-ai" id="${typingId}">
            <div class="community-chat-avatar">🤖</div>
            <div class="community-chat-bubble">
                <div class="community-chat-typing">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>
    `;
    messages.scrollTop = messages.scrollHeight;

    // Add to history
    communityChatHistory.push({ role: 'user', content: message });

    try {
        const res = await fetch(API + '/api/community/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                history: communityChatHistory.slice(-8),
            }),
        });

        const data = await res.json();
        const response = data.response || data.error || 'Sorry, I couldn\'t process that request.';

        // Remove typing indicator
        const typing = document.getElementById(typingId);
        if (typing) typing.remove();

        // Format the response (simple markdown)
        const formatted = response
            .replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        // Add AI response
        messages.innerHTML += `
            <div class="community-chat-msg community-chat-ai">
                <div class="community-chat-avatar">🤖</div>
                <div class="community-chat-bubble"><p>${formatted}</p></div>
            </div>
        `;

        communityChatHistory.push({ role: 'assistant', content: response });

    } catch (e) {
        const typing = document.getElementById(typingId);
        if (typing) typing.remove();

        messages.innerHTML += `
            <div class="community-chat-msg community-chat-ai">
                <div class="community-chat-avatar">🤖</div>
                <div class="community-chat-bubble"><p style="color:var(--red)">Sorry, I'm having trouble connecting. Please try again in a moment.</p></div>
            </div>
        `;
    }

    messages.scrollTop = messages.scrollHeight;
}
