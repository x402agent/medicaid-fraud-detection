/**
 * RAG Engine — Document AI Layout Parser + Embeddings + Vector Search + Gemini
 * =============================================================================
 * Uses the official @google-cloud/documentai client library with OAuth2
 * service account authentication (not API keys).
 * 
 * Pipeline:
 *   1. Parse PDF → Document AI Layout Parser (with built-in chunking)
 *   2. Generate embeddings → gemini-embedding-001 via @google/genai
 *   3. Vector search → cosine similarity on in-memory embeddings
 *   4. Augmented generation → Gemini 2.5 Flash with retrieved context
 * 
 * Authentication:
 *   - Uses GOOGLE_APPLICATION_CREDENTIALS env var (service account key)
 *   - Falls back to Application Default Credentials (gcloud auth)
 *   - Document AI API requires OAuth2, not API keys
 * 
 * Document AI Setup:
 *   - Location-based endpoint: {location}-documentai.googleapis.com
 *   - Processor configured via DOCAI_PROCESSOR_ID / DOCAI_PROCESSOR_LOCATION
 *   - Supports Layout Parser with chunking config
 */

const fs = require('fs');
const path = require('path');

// ── Vector Store ──────────────────────────────────────────────
class VectorStore {
    constructor() {
        this.documents = [];  // { id, content, embedding, metadata }
        this.storePath = path.join(__dirname, 'fraud_analysis', 'vector_store.json');
    }

    /** Add a document chunk with its embedding */
    add(id, content, embedding, metadata = {}) {
        this.documents.push({ id, content, embedding, metadata });
    }

    /** Cosine similarity between two vectors */
    static cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length || a.length === 0) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dotProduct / denom;
    }

    /** Search for top-k most similar chunks */
    search(queryEmbedding, topK = 10) {
        const scored = this.documents.map(doc => ({
            ...doc,
            score: VectorStore.cosineSimilarity(queryEmbedding, doc.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /** Persist to disk */
    save() {
        const data = this.documents.map(d => ({
            id: d.id,
            content: d.content,
            metadata: d.metadata,
            embedding: d.embedding,
        }));
        fs.writeFileSync(this.storePath, JSON.stringify(data));
        console.log(`   💾 Vector store saved: ${this.documents.length} chunks`);
    }

    /** Load from disk */
    load() {
        if (fs.existsSync(this.storePath)) {
            const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
            this.documents = data;
            console.log(`   📦 Vector store loaded: ${this.documents.length} chunks`);
            return true;
        }
        return false;
    }

    /** Clear all documents */
    clear() {
        this.documents = [];
    }

    get size() { return this.documents.length; }
}

// ── RAG Engine ────────────────────────────────────────────────
class RAGEngine {
    constructor(genaiClient) {
        this.ai = genaiClient;
        this.store = new VectorStore();
        this.embeddingModel = 'gemini-embedding-001';
        this.generationModel = 'gemini-2.5-flash';

        // Document AI configuration — extracted from environment
        this.projectId = process.env.GOOGLE_PROJECT_ID || 'mawdbot';
        this.projectNumber = process.env.GOOGLE_PROJECT_NUMBER || '691016932195';
        this.processorId = process.env.DOCAI_PROCESSOR_ID || process.env.GOOGLE_DATA_ID || 'f9f3ab408f414eea';
        this.processorLocation = process.env.DOCAI_PROCESSOR_LOCATION || 'us';

        // Document AI client (lazy-initialized)
        this._docaiClient = null;
        this._docaiInitError = null;
    }

    /**
     * Initialize the Document AI client using the official client library.
     * Uses OAuth2 via service account key or Application Default Credentials.
     * 
     * Per the Document AI docs:
     * - The endpoint must match the processor location: {location}-documentai.googleapis.com
     * - API keys are NOT supported — OAuth2 access tokens or service account credentials required
     * - The client library handles authentication automatically via GOOGLE_APPLICATION_CREDENTIALS
     */
    async _initDocAIClient() {
        if (this._docaiClient) return this._docaiClient;
        if (this._docaiInitError) return null;

        try {
            const { DocumentProcessorServiceClient } = require('@google-cloud/documentai');

            // The endpoint MUST match the processor's location (us or eu)
            // See: https://cloud.google.com/document-ai/docs/setup#location
            const apiEndpoint = `${this.processorLocation}-documentai.googleapis.com`;

            const clientOptions = {
                apiEndpoint,
            };

            // If a service account key file is specified, use it
            // Otherwise falls back to Application Default Credentials
            if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                const keyPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
                if (fs.existsSync(keyPath)) {
                    clientOptions.keyFilename = keyPath;
                    console.log(`   🔑 Using service account: ${keyPath}`);
                }
            }

            this._docaiClient = new DocumentProcessorServiceClient(clientOptions);
            console.log(`   ✅ Document AI client initialized (endpoint: ${apiEndpoint})`);
            return this._docaiClient;
        } catch (err) {
            this._docaiInitError = err.message;
            console.error(`   ❌ Document AI client init failed: ${err.message}`);
            return null;
        }
    }

    /** Initialize — try loading saved store, else process sample PDF */
    async init() {
        console.log('\n🔗 RAG Engine initializing...');
        if (this.store.load()) {
            console.log('   ✅ RAG Engine ready (loaded from cache)');
            return;
        }

        // Try to auto-process the sample PDF with Document AI
        const samplePath = path.join(__dirname, 'medicaid_sample.pdf');
        if (fs.existsSync(samplePath)) {
            console.log('   📄 Processing medicaid_sample.pdf with Document AI...');
            try {
                await this.processAndIndex(samplePath, 'medicaid_sample.pdf');
                console.log('   ✅ RAG Engine ready (sample PDF indexed via Document AI)');
                // Also index statistical data for comprehensive RAG
                await this.indexStatisticalData();
                return;
            } catch (err) {
                console.log(`   ⚠️ Document AI processing failed: ${err.message}`);
                console.log('   📝 Falling back to stat-based chunking...');
            }
        } else {
            console.log('   📝 No sample PDF found, indexing statistical data...');
        }

        await this.indexStatisticalData();
    }

    /**
     * Process a PDF with Document AI Layout Parser and index chunks.
     * Uses the official @google-cloud/documentai client library.
     * 
     * This mirrors the BigQuery notebook's flow:
     *   ML.PROCESS_DOCUMENT(MODEL layout_parser, TABLE object_table,
     *     PROCESS_OPTIONS => '{"layout_config": {"chunking_config": {"chunk_size": 250}}}')
     * 
     * Authentication: OAuth2 via service account (GOOGLE_APPLICATION_CREDENTIALS)
     * Endpoint: {location}-documentai.googleapis.com (location-based per the docs)
     */
    async processAndIndex(pdfPath, sourceName = 'uploaded.pdf') {
        const client = await this._initDocAIClient();
        if (!client) {
            throw new Error('Document AI client not available. Check GOOGLE_APPLICATION_CREDENTIALS.');
        }

        // Step 1: Read the PDF
        const pdfBytes = fs.readFileSync(pdfPath);

        // Step 2: Build the full processor resource name
        // Format: projects/{project}/locations/{location}/processors/{processor}
        const processorName = `projects/${this.projectNumber}/locations/${this.processorLocation}/processors/${this.processorId}`;
        console.log(`   📡 Processor: ${processorName}`);

        // Step 3: Build the processing request with Layout Parser chunking config
        // This is the Node.js client library equivalent of the REST API call:
        //   POST https://{location}-documentai.googleapis.com/v1/projects/{project}/locations/{location}/processors/{processor}:process
        const request = {
            name: processorName,
            rawDocument: {
                content: pdfBytes,
                mimeType: 'application/pdf',
            },
            // Skip human review (required for automated pipelines)
            skipHumanReview: true,
            // Process options with Layout Parser chunking config
            // Mirrors the BigQuery notebook's layout_config.chunking_config
            processOptions: {
                layoutConfig: {
                    chunkingConfig: {
                        chunkSize: 250,
                        includeAncestorHeadings: true,
                    }
                }
            },
        };

        // Step 4: Call Document AI (synchronous online processing)
        console.log('   ⏳ Calling Document AI Layout Parser...');
        const [result] = await client.processDocument(request);

        // Step 5: Parse chunks from the response
        const chunks = this._parseDocAIChunks(result, sourceName);
        console.log(`   📊 Document AI returned ${chunks.length} chunks`);

        if (chunks.length === 0) {
            // Fallback: extract text and chunk manually
            const fullText = result.document?.text || '';
            if (fullText) {
                const manualChunks = this._manualChunk(fullText, 500, sourceName);
                console.log(`   📝 Manual chunking: ${manualChunks.length} chunks from extracted text`);
                chunks.push(...manualChunks);
            }
        }

        // Step 6: Generate embeddings for all chunks
        // Mirrors: ML.GENERATE_EMBEDDING(MODEL embedding_model, TABLE demo_result_parsed)
        console.log(`   🧮 Generating embeddings for ${chunks.length} chunks...`);
        await this._embedChunks(chunks);

        // Save the vector store
        this.store.save();
        return chunks;
    }

    /**
     * Process a base64-encoded PDF (for uploaded files from the frontend)
     */
    async processBase64PDF(base64Content, sourceName = 'uploaded.pdf') {
        const tempPath = path.join(__dirname, 'fraud_analysis', `_temp_${Date.now()}.pdf`);
        fs.writeFileSync(tempPath, Buffer.from(base64Content, 'base64'));
        try {
            const chunks = await this.processAndIndex(tempPath, sourceName);
            return chunks;
        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    }

    /**
     * Index the statistical analysis data as chunks (fallback when Document AI is unavailable)
     */
    async indexStatisticalData() {
        const statsPath = path.join(__dirname, 'fraud_analysis', 'statistical_analysis.json');
        const reportPath = path.join(__dirname, 'fraud_analysis', 'gemini_fraud_report.md');

        const chunks = [];

        // Chunk the statistical analysis
        if (fs.existsSync(statsPath)) {
            const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));

            // Metadata chunk
            chunks.push({
                id: 'stats-metadata',
                content: `Medicaid Fraud Analysis Metadata: ${JSON.stringify(stats.metadata, null, 2)}\n\nGlobal Statistics: ${JSON.stringify(stats.global_statistics, null, 2)}`,
                metadata: { source: 'statistical_analysis.json', type: 'metadata' },
            });

            // Outlier provider chunks (group by 5)
            const providers = stats.outlier_providers || [];
            for (let i = 0; i < providers.length; i += 5) {
                const batch = providers.slice(i, i + 5);
                chunks.push({
                    id: `stats-providers-${i}`,
                    content: `Outlier Providers (${i + 1}-${Math.min(i + 5, providers.length)}):\n${JSON.stringify(batch, null, 2)}`,
                    metadata: { source: 'statistical_analysis.json', type: 'outlier_providers', range: `${i + 1}-${Math.min(i + 5, providers.length)}` },
                });
            }

            // Benford's Law chunk
            if (stats.benford_analysis) {
                chunks.push({
                    id: 'stats-benford',
                    content: `Benford's Law Analysis:\n${JSON.stringify(stats.benford_analysis, null, 2)}`,
                    metadata: { source: 'statistical_analysis.json', type: 'benford_analysis' },
                });
            }

            // Temporal anomalies chunks
            const anomalies = stats.temporal_anomalies || [];
            for (let i = 0; i < anomalies.length; i += 10) {
                const batch = anomalies.slice(i, i + 10);
                chunks.push({
                    id: `stats-temporal-${i}`,
                    content: `Temporal Anomalies (${i + 1}-${Math.min(i + 10, anomalies.length)}):\n${JSON.stringify(batch, null, 2)}`,
                    metadata: { source: 'statistical_analysis.json', type: 'temporal_anomalies' },
                });
            }
        }

        // Chunk the fraud report
        if (fs.existsSync(reportPath)) {
            const report = fs.readFileSync(reportPath, 'utf-8');
            const sections = report.split(/\n## /);
            for (let i = 0; i < sections.length; i++) {
                const section = (i === 0 ? sections[i] : '## ' + sections[i]).trim();
                if (section.length > 50) {
                    chunks.push({
                        id: `report-section-${i}`,
                        content: section.substring(0, 2000),
                        metadata: { source: 'gemini_fraud_report.md', type: 'report_section', section: i },
                    });
                }
            }
        }

        if (chunks.length > 0) {
            console.log(`   📊 Created ${chunks.length} chunks from statistical data`);
            await this._embedChunks(chunks);
            this.store.save();
        }
    }

    /**
     * RAG Query — Vector search + Gemini augmented generation
     * Mirrors the BigQuery notebook's final query:
     *   VECTOR_SEARCH → ML.GENERATE_TEXT
     */
    async query(question, topK = 8) {
        if (this.store.size === 0) {
            return { answer: 'No documents have been indexed yet. Please process a PDF first.', chunks: [] };
        }

        // Step 1: Embed the question
        const queryEmbedding = await this._getEmbedding(question);

        // Step 2: Vector search — find most relevant chunks
        const results = this.store.search(queryEmbedding, topK);

        // Step 3: Build context from retrieved chunks
        const context = results
            .map((r, i) => `[Chunk ${i + 1} | Score: ${r.score.toFixed(3)} | Source: ${r.metadata.source || 'unknown'}]\n${r.content}`)
            .join('\n\n---\n\n');

        // Step 4: Generate answer with Gemini (augmented with context)
        const prompt = `You are a Medicaid fraud investigation expert analyzing documents using a RAG (Retrieval-Augmented Generation) pipeline.

Based on the following retrieved document chunks, answer the user's question accurately and concisely. 
Reference specific data points, NPI numbers, dollar amounts, and statistics from the chunks.
If the chunks don't contain enough information to fully answer, say so.

## Retrieved Context (${results.length} chunks from vector search):

${context}

## User Question:
${question}

## Instructions:
- Be specific and cite data from the chunks
- Include relevant NPI numbers, dollar amounts, and statistics
- Flag any fraud indicators or anomalies you observe
- Structure your response with clear sections`;

        const response = await this.ai.models.generateContent({
            model: this.generationModel,
            contents: [{ text: prompt }],
            config: {
                temperature: 0.3,
                maxOutputTokens: 4000,
            },
        });

        return {
            answer: response.text,
            chunks: results.map(r => ({
                id: r.id,
                content: r.content.substring(0, 500),
                score: r.score,
                metadata: r.metadata,
            })),
            model: this.generationModel,
            embeddingModel: this.embeddingModel,
            chunksSearched: this.store.size,
            timestamp: new Date().toISOString(),
        };
    }

    // ── Private Methods ──────────────────────────────────────

    /**
     * Parse Document AI Layout Parser response into chunks.
     * Handles the chunkedDocument format from Layout Parser with chunking config.
     * 
     * Mirrors the BigQuery SQL:
     *   JSON_EXTRACT_SCALAR(json, '$.chunkId') AS id,
     *   JSON_EXTRACT_SCALAR(json, '$.content') AS content,
     *   JSON_EXTRACT_SCALAR(json, '$.pageSpan.pageStart') AS page_span_start,
     *   JSON_EXTRACT_SCALAR(json, '$.pageSpan.pageEnd') AS page_span_end
     */
    _parseDocAIChunks(result, sourceName) {
        const chunks = [];
        const doc = result.document || result;

        // Try chunkedDocument format (Layout Parser with chunking config)
        const chunkedDoc = doc.chunkedDocument || result.chunkedDocument;
        if (chunkedDoc?.chunks) {
            for (const chunk of chunkedDoc.chunks) {
                chunks.push({
                    id: chunk.chunkId || `chunk-${chunks.length}`,
                    content: chunk.content || '',
                    metadata: {
                        source: sourceName,
                        type: 'docai_chunk',
                        pageStart: chunk.pageSpan?.pageStart,
                        pageEnd: chunk.pageSpan?.pageEnd,
                        pageFooter: chunk.pageFooters?.[0]?.text,
                        chunkId: chunk.chunkId,
                    },
                });
            }
            return chunks;
        }

        // Fallback: Try extracting entities
        if (doc.entities?.length > 0) {
            for (const entity of doc.entities) {
                const text = entity.textAnchor?.content || entity.mentionText || '';
                if (text.trim().length > 20) {
                    chunks.push({
                        id: `entity-${chunks.length}`,
                        content: text.trim(),
                        metadata: {
                            source: sourceName,
                            type: entity.type || 'entity',
                            confidence: entity.confidence,
                            normalizedValue: entity.normalizedValue?.text,
                        },
                    });
                }
            }
            if (chunks.length > 0) return chunks;
        }

        // Final fallback: Extract from pages/text
        if (doc.text) {
            return this._manualChunk(doc.text, 500, sourceName);
        }

        return chunks;
    }

    /** Manual text chunking with overlap */
    _manualChunk(text, chunkSize = 500, sourceName = 'document') {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const chunks = [];
        let current = '';
        let chunkIdx = 0;

        for (const sentence of sentences) {
            if ((current + ' ' + sentence).length > chunkSize && current.length > 0) {
                chunks.push({
                    id: `manual-${chunkIdx}`,
                    content: current.trim(),
                    metadata: { source: sourceName, type: 'manual_chunk', index: chunkIdx },
                });
                chunkIdx++;
                current = sentence;
            } else {
                current += (current ? ' ' : '') + sentence;
            }
        }
        if (current.trim()) {
            chunks.push({
                id: `manual-${chunkIdx}`,
                content: current.trim(),
                metadata: { source: sourceName, type: 'manual_chunk', index: chunkIdx },
            });
        }
        return chunks;
    }

    /** Generate embeddings for an array of chunks and add to vector store */
    async _embedChunks(chunks) {
        const batchSize = 5;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const embeddings = await Promise.all(
                batch.map(chunk => this._getEmbedding(chunk.content))
            );
            for (let j = 0; j < batch.length; j++) {
                this.store.add(batch[j].id, batch[j].content, embeddings[j], batch[j].metadata);
            }
            if (i + batchSize < chunks.length) {
                await new Promise(r => setTimeout(r, 200));
            }
            const processed = Math.min(i + batchSize, chunks.length);
            process.stdout.write(`\r   🧮 Embedded ${processed}/${chunks.length} chunks`);
        }
        console.log('');
    }

    /** Get embedding for a single text */
    async _getEmbedding(text) {
        try {
            const result = await this.ai.models.embedContent({
                model: this.embeddingModel,
                contents: text.substring(0, 8000),
            });
            return result.embedding?.values || result.embeddings?.[0]?.values || [];
        } catch (err) {
            console.error(`   ⚠️ Embedding error: ${err.message}`);
            return new Array(768).fill(0);
        }
    }

    /** Get status */
    getStatus() {
        return {
            indexed_chunks: this.store.size,
            embedding_model: this.embeddingModel,
            generation_model: this.generationModel,
            documents: [...new Set(this.store.documents.map(d => d.metadata?.source))],
            ready: this.store.size > 0,
            docai_available: !!this._docaiClient && !this._docaiInitError,
            docai_error: this._docaiInitError,
            processor: {
                id: this.processorId,
                location: this.processorLocation,
                endpoint: `${this.processorLocation}-documentai.googleapis.com`,
                project: this.projectId,
            },
        };
    }

    /** Get all chunks (for browsing) */
    getChunks(page = 1, pageSize = 20) {
        const start = (page - 1) * pageSize;
        const chunks = this.store.documents.slice(start, start + pageSize);
        return {
            chunks: chunks.map(c => ({
                id: c.id,
                content: c.content.substring(0, 800),
                metadata: c.metadata,
            })),
            total: this.store.size,
            page,
            totalPages: Math.ceil(this.store.size / pageSize),
        };
    }
}

module.exports = { RAGEngine, VectorStore };
