/**
 * ragService.js — Smart Release Notes Generator
 * Two-Stage RAG Hybride orienté Azure DevOps
 *
 * Stage 1 — Retrieval  : similarité cosinus → Top 20 candidats
 * Stage 2 — Reranking  : score hybride (Business + Vector + Quality) → Top 3
 *
 * FinalScore = 0.6 × BusinessScore + 0.3 × VectorScore + 0.1 × QualityScore
 *
 * BusinessScore = 0.4 × EpicScore(Jaccard)
 *               + 0.4 × FeatureScore(Jaccard)
 *               + 0.2 × AreaPathScore(profondeur commune)
 *
 * QualityScore  = 0.4 × DescriptionCoverage
 *               + 0.3 × WorkItemCoverage
 *               + 0.3 × ReleaseNoteCompleteness
 */

const axios = require('axios');

const EMBEDDING_MODEL      = 'text-embedding-3-small';
const PUBLISHER_ID         = 'ReleaseManagerTools';
const EXTENSION_ID         = 'smart-release-notes';
const MAX_EMBEDDING_INPUT  = 8000;
const STAGE1_TOP_K         = 20;   // Recall — candidats récupérés par cosinus
const STAGE2_TOP_K         = 3;    // Precision — exemples finaux envoyés au LLM
const COSINE_MIN_THRESHOLD = 0.40; // Seuil Stage 1 — filtrer les candidats hors domaine


// ═══════════════════════════════════════════════════════════════
// MÉTRIQUES DE SIMILARITÉ
// ═══════════════════════════════════════════════════════════════

/**
 * Similarité cosinus entre deux vecteurs d'embedding.
 * Invariante à la magnitude — compare uniquement l'orientation sémantique.
 *
 * cos(θ) = (A · B) / (||A|| × ||B||)
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Score entre 0 (aucun rapport) et 1 (identique)
 */
function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot   += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Coefficient de Jaccard entre deux ensembles.
 * Mesure le recouvrement entre deux sets de valeurs.
 *
 * J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Exemples :
 *   A={Auth}      B={Auth}            → 1/1 = 1.00
 *   A={Auth,Sec}  B={Auth,Reporting}  → 1/3 = 0.33
 *   A={Auth}      B={Reporting}       → 0/2 = 0.00
 *   A={}          B={}                → 1 (cas dégénéré : aucune info = neutre)
 *
 * @param {Set} setA
 * @param {Set} setB
 * @returns {number} Score entre 0 et 1
 */
function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 0.5; // Neutre si aucune info
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union        = new Set([...setA, ...setB]);
    if (union.size === 0) return 0;
    return intersection.size / union.size;
}

/**
 * Score de similarité des Area Paths Azure DevOps.
 * Mesure la profondeur du chemin commun dans la hiérarchie.
 *
 * Exemples :
 *   "Security\Auth"     vs "Security\Auth"     → 2/2 = 1.00
 *   "Security\Auth"     vs "Security\Identity" → 1/2 = 0.50
 *   "Security\Auth"     vs "Reporting\Export"  → 0/2 = 0.00
 *
 * Si plusieurs Area Paths existent, retourne le meilleur score.
 *
 * @param {string[]} pathsA - Area Paths de la release courante
 * @param {string[]} pathsB - Area Paths de la release candidate
 * @returns {number} Score entre 0 et 1
 */
function areaPathScore(pathsA, pathsB) {
    if (!pathsA || !pathsB || pathsA.length === 0 || pathsB.length === 0) return 0;

    let maxScore = 0;

    for (const pathA of pathsA) {
        for (const pathB of pathsB) {
            const partsA = pathA.split('\\');
            const partsB = pathB.split('\\');
            let common   = 0;

            for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
                if (partsA[i].toLowerCase() === partsB[i].toLowerCase()) common++;
                else break;
            }

            const score = common / Math.max(partsA.length, partsB.length);
            if (score > maxScore) maxScore = score;
        }
    }

    return maxScore;
}


// ═══════════════════════════════════════════════════════════════
// SCORES COMPOSITES
// ═══════════════════════════════════════════════════════════════

/**
 * BusinessScore — pertinence métier Azure DevOps.
 *
 * Compare les métadonnées extraites des work items des deux releases :
 * - Epics  : initiatives métier de haut niveau
 * - Features : fonctionnalités parentes des tickets
 * - Area Paths : modules applicatifs Azure DevOps
 *
 * BusinessScore = 0.4 × EpicScore(Jaccard)
 *               + 0.4 × FeatureScore(Jaccard)
 *               + 0.2 × AreaPathScore(profondeur)
 *
 * @param {Object} currentMeta   - Métadonnées de la release courante
 * @param {Object} candidateMeta - Métadonnées de la release candidate (stockées)
 * @returns {number} Score entre 0 et 1
 */
function computeBusinessScore(currentMeta, candidateMeta) {
    const epicScore    = jaccardSimilarity(
        new Set((currentMeta.epics    || []).map(e => e.toLowerCase())),
        new Set((candidateMeta.epics  || []).map(e => e.toLowerCase()))
    );
    const featureScore = jaccardSimilarity(
        new Set((currentMeta.features   || []).map(f => f.toLowerCase())),
        new Set((candidateMeta.features || []).map(f => f.toLowerCase()))
    );
    const areaScore    = areaPathScore(
        currentMeta.areaPaths   || [],
        candidateMeta.areaPaths || []
    );

    const score = (epicScore * 0.4) + (featureScore * 0.4) + (areaScore * 0.2);

    console.log(`  BusinessScore → Epic:${epicScore.toFixed(2)} Feature:${featureScore.toFixed(2)} Area:${areaScore.toFixed(2)} = ${score.toFixed(3)}`);
    return score;
}

/**
 * QualityScore — qualité documentaire de la release note candidate.
 *
 * Garantit que seules les release notes bien documentées servent de référence.
 *
 * QualityScore = 0.4 × DescriptionCoverage
 *              + 0.3 × WorkItemCoverage
 *              + 0.3 × ReleaseNoteCompleteness
 *
 * DescriptionCoverage   = workItems avec description / total workItems
 * WorkItemCoverage      = min(total workItems / 10, 1) — normalisé sur 10
 * ReleaseNoteCompleteness = sections présentes / sections attendues
 *
 * @param {Object} doc - Document release note depuis Extension Data Service
 * @returns {number} Score entre 0 et 1
 */
function computeQualityScore(doc) {
    const workItems = doc.workItems || [];
    const total     = workItems.length;

    if (total === 0) return 0;

    // DescriptionCoverage
    const withDesc       = workItems.filter(wi =>
        wi.description && wi.description.trim().length > 10
    ).length;
    const descCoverage   = withDesc / total;

    // WorkItemCoverage — normalisé : 10 tickets = couverture maximale
    const workItemCoverage = Math.min(total / 10, 1);

    // ReleaseNoteCompleteness — sections attendues dans le Markdown
    const content          = doc.contenuMarkdown || '';
    const expectedSections = ['Résumé', 'Fonctionnalit', 'Bug', 'Amélioration'];
    const presentSections  = expectedSections.filter(s =>
        content.toLowerCase().includes(s.toLowerCase())
    ).length;
    const completeness     = presentSections / expectedSections.length;

    const score = (descCoverage * 0.4) + (workItemCoverage * 0.3) + (completeness * 0.3);

    console.log(`  QualityScore  → Desc:${descCoverage.toFixed(2)} Items:${workItemCoverage.toFixed(2)} Complete:${completeness.toFixed(2)} = ${score.toFixed(3)}`);
    return score;
}
function computeFeedbackScore(doc) {
    // Score déjà calculé par le Hub → on l'utilise directement
    if (typeof doc.feedbackScore === 'number') {
        return doc.feedbackScore;
    }
 
    // Rétrocompatibilité : recalcul pour les anciens documents
    const edits  = doc.editCount || 0;
    const regens = doc.regenerationCount || 0;
    const score  = 1 / (1 + edits * 0.3 + regens * 0.6);
 
    console.log(`  FeedbackScore → édits:${edits} régén:${regens} = ${score.toFixed(3)}`);
    return score;
}
/**
 * FinalScore — score hybride de reranking (Stage 2).
 *
 * FinalScore = 0.6 × BusinessScore + 0.3 × VectorScore + 0.1 × QualityScore
 *
 * Justification des poids :
 * - 0.6 BusinessScore : le contexte métier ADO est le prédicteur le plus fort
 * - 0.3 VectorScore   : la sémantique reste un signal fiable mais secondaire
 * - 0.1 QualityScore  : tiebreaker entre exemples de pertinence égale
 */
function computeFinalScore(businessScore, vectorScore, qualityScore, feedbackScore) {
    return (businessScore * 0.50) 
        + (vectorScore * 0.25)
        + (qualityScore * 0.15) 
        + (feedbackScore * 0.10);
}


// ═══════════════════════════════════════════════════════════════
// EXTRACTION DES MÉTADONNÉES RAG
// ═══════════════════════════════════════════════════════════════

/**
 * Extrait les métadonnées pertinentes pour le BusinessScore
 * depuis la liste des work items d'une release.
 *
 * - Epics    : work items de type 'Epic'
 * - Features : work items de type 'Feature'
 * - AreaPaths: chemins uniques depuis System.AreaPath
 *
 * Note : si les Epics/Features ne sont pas directement dans la release
 * comme work items, ces ensembles seront vides. Dans ce cas, le
 * BusinessScore repose principalement sur l'AreaPathScore.
 *
 * @param {Array} workItems - Work items de la release courante
 * @returns {Object} { epics, features, areaPaths }
 */
function extractRAGMetadata(workItems) {
    const epics = [
        ...new Set(
            workItems
                .filter(wi => wi.type === 'Epic')
                .map(wi => wi.title)
        )
    ];

    const features = [
        ...new Set(
            workItems
                .filter(wi => wi.type === 'Feature')
                .map(wi => wi.title)
        )
    ];

    const areaPaths = [
        ...new Set(
            workItems
                .map(wi => wi.areaPath)
                .filter(Boolean)
        )
    ];

    console.log(`RAG Metadata → Epics:${epics.length} Features:${features.length} AreaPaths:${areaPaths.length}`);
    return { epics, features, areaPaths };
}


// ═══════════════════════════════════════════════════════════════
// EMBEDDING
// ═══════════════════════════════════════════════════════════════

/**
 * Génère un vecteur d'embedding via l'API OpenAI.
 * Modèle : text-embedding-3-small (1536 dimensions)
 *
 * @param {string} text   - Texte à vectoriser
 * @param {string} apiKey - Clé API OpenAI
 * @returns {number[]} Vecteur de 1536 dimensions
 */
async function generateEmbedding(text, apiKey) {
    const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBEDDING_INPUT);

    const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: EMBEDDING_MODEL, input: cleanText },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data.data[0].embedding;
}

/**
 * Génère l'embedding et l'attache au document avant sauvegarde.
 * Non-bloquant : une erreur ne fait pas échouer le pipeline.
 */
async function generateAndAttachEmbedding(document, ticketsText, apiKey) {
    try {
        console.log('🔢 RAG: Génération embedding...');
        document.embedding = await generateEmbedding(ticketsText, apiKey);
        console.log(`✅ RAG: Embedding généré (${document.embedding.length} dimensions)`);
    } catch (err) {
        console.log('⚠️  RAG embedding error (non-bloquant):', err.message);
    }
    return document;
}


// ═══════════════════════════════════════════════════════════════
// PIPELINE TWO-STAGE RAG
// ═══════════════════════════════════════════════════════════════

/**
 * Pipeline complet Two-Stage RAG.
 *
 * Stage 1 — Retrieval (cosinus) :
 *   Calcul rapide sur tous les documents Done.
 *   Filtre par seuil minimum (COSINE_MIN_THRESHOLD).
 *   Retourne Top 20 candidats.
 *
 * Stage 2 — Reranking (hybride) :
 *   Applique FinalScore = 0.6×Business + 0.3×Vector + 0.1×Quality
 *   sur les 20 candidats.
 *   Retourne Top 3 exemples pour le prompt LLM.
 *
 * @param {string} orgUrl            - URL organisation Azure DevOps
 * @param {string} project           - Nom du projet
 * @param {string} accessToken       - Token OAuth pipeline
 * @param {string} apiKey            - Clé API OpenAI
 * @param {string} currentTicketsText - Tickets de la release courante (formatés)
 * @param {Object} currentMeta       - Métadonnées RAG de la release courante
 * @returns {Array|null} Top 3 exemples ou null si base vide / aucun pertinent
 */
async function getRAGContext(orgUrl, project, accessToken, apiKey, currentTicketsText, currentMeta) {
    try {
        console.log('\n═══ TWO-STAGE RAG PIPELINE ═══');

        // ── Récupération des documents ───────────────────────────────
        const extmgmtUrl     = orgUrl.replace('dev.azure.com', 'extmgmt.dev.azure.com');
        const collectionName = `release-notes-${project}`;
        const url = `${extmgmtUrl}_apis/ExtensionManagement/InstalledExtensions/${PUBLISHER_ID}/${EXTENSION_ID}/Data/Scopes/Default/Current/Collections/${collectionName}/Documents?api-version=7.1-preview.1`;

        let allDocs = [];
        try {
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            allDocs = response.data.value || [];
        } catch (e) {
            console.log('RAG: Collection vide — génération sans contexte');
            return null;
        }

        // Filtrer : uniquement les notes validées (Done) avec un embedding
        const doneDocs = allDocs.filter(doc =>
            doc.statut === 'Done' &&
            doc.embedding &&
            doc.embedding.length > 0 &&
            doc.contenuMarkdown
        );

        console.log(`RAG: ${doneDocs.length} release note(s) validée(s) disponibles`);

        if (doneDocs.length === 0) {
            console.log('RAG: Base vide — génération standard (premier run)');
            return null;
        }

        // ── STAGE 1 : Retrieval sémantique (cosinus) ─────────────────
        console.log(`\n[Stage 1] Retrieval cosinus → Top ${STAGE1_TOP_K} candidats`);

        const queryEmbedding = await generateEmbedding(currentTicketsText, apiKey);

        const stage1Candidates = doneDocs
            .map(doc => ({
                ...doc,
                vectorScore: cosineSimilarity(queryEmbedding, doc.embedding)
            }))
            .filter(doc => doc.vectorScore >= COSINE_MIN_THRESHOLD)
            .sort((a, b) => b.vectorScore - a.vectorScore)
            .slice(0, STAGE1_TOP_K);

        console.log(`Stage 1 → ${stage1Candidates.length} candidat(s) après filtre cosinus ≥ ${COSINE_MIN_THRESHOLD}`);

        if (stage1Candidates.length === 0) {
            console.log('RAG: Aucun candidat au-dessus du seuil — génération standard');
            return null;
        }

        // ── STAGE 2 : Reranking hybride ───────────────────────────────
        console.log(`\n[Stage 2] Reranking hybride → Top ${STAGE2_TOP_K} exemples`);

        const stage2Scored = stage1Candidates.map(doc => {
            console.log(`\n  → Scoring ${doc.releaseName}`);

            const businessScore = computeBusinessScore(
                currentMeta,
                doc.ragMetadata || { epics: [], features: [], areaPaths: [] }
            );
            const qualityScore  = computeQualityScore(doc);
            const feedbackScore = computeFeedbackScore(doc);
            const finalScore    = computeFinalScore(businessScore, doc.vectorScore, qualityScore, feedbackScore);

            console.log(`  FinalScore = 0.50×${businessScore.toFixed(3)} + 0.25×${doc.vectorScore.toFixed(3)} + 0.15×${qualityScore.toFixed(3)} + 0.10×${feedbackScore.toFixed(3)} = ${finalScore.toFixed(3)}`);

            return {
                releaseName   : doc.releaseName,
                content       : doc.contenuMarkdown,
                finalScore,
                businessScore,
                vectorScore   : doc.vectorScore,
                qualityScore,
                feedbackScore
            };
        }).sort((a, b) => b.finalScore - a.finalScore);

        const top3 = stage2Scored.slice(0, STAGE2_TOP_K);

        console.log(`\n✅ RAG: Top ${top3.length} exemple(s) retenus :`);
        top3.forEach((ex, i) =>
            console.log(`  ${i + 1}. ${ex.releaseName} — FinalScore: ${ex.finalScore.toFixed(3)}`)
        );
        console.log('═══════════════════════════════\n');

        return top3;

    } catch (err) {
        console.log('⚠️  RAG pipeline error (non-bloquant):', err.message);
        return null;
    }
}


// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
    getRAGContext,
    generateAndAttachEmbedding,
    extractRAGMetadata,
    // Exports des métriques pour les tests unitaires
    cosineSimilarity,
    jaccardSimilarity,
    areaPathScore,
    computeBusinessScore,
    computeQualityScore,
    computeFinalScore,
    computeFeedbackScore
};