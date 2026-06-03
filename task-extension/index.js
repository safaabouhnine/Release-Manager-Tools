const tl = require('azure-pipelines-task-lib/task');
const axios = require('axios');
const {
    getRAGContext,
    generateAndAttachEmbedding,
    extractRAGMetadata
} = require('./ragService');

async function run() {
    try {
        const openAiApiKey = tl.getInput('openAiApiKey', true);

        const orgUrl      = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
        const project     = process.env.SYSTEM_TEAMPROJECT;
        const releaseId   = process.env.RELEASE_RELEASEID;
        const accessToken = process.env.SYSTEM_ACCESSTOKEN;
        const releaseName = process.env.RELEASE_RELEASENAME || 'Release';
        const releaseDate = new Date().toLocaleDateString('fr-FR');
        const environment = process.env.RELEASE_ENVIRONMENTNAME || 'Production';

        console.log('=== DIAGNOSTIC ===');
        console.log('orgUrl:', orgUrl);
        console.log('project:', project);
        console.log('releaseId:', releaseId);
        console.log('accessToken:', accessToken ? 'PRESENT' : 'VIDE');
        const vsrmUrl = orgUrl ? orgUrl.replace('dev.azure.com', 'vsrm.dev.azure.com') : '';
        console.log('vsrmUrl:', vsrmUrl);
        console.log('==================');

        console.log(`Génération des Release Notes pour : ${releaseName}`);

        // 1. Récupération des work items (avec areaPath — nouveau champ)
        const workItems = await getWorkItems(orgUrl, vsrmUrl, project, releaseId, accessToken);
        console.log(`${workItems.length} tickets récupérés`);

        // 2. Formatage des tickets pour le prompt
        const formattedTickets = formatWorkItems(workItems);
        console.log('Tickets filtrés:', workItems.filter(i =>
            ['Closed', 'Resolved'].includes(i.state)).length
        );

        // 3. Extraction des métadonnées RAG depuis les work items
        const currentMeta = extractRAGMetadata(workItems);

        // 4. Pipeline Two-Stage RAG
        const ragExamples = await getRAGContext(
            orgUrl,
            project,
            accessToken,
            openAiApiKey,
            formattedTickets,
            currentMeta
        );

        if (ragExamples && ragExamples.length > 0) {
            console.log(`✅ RAG actif : ${ragExamples.length} exemple(s) injecté(s)`);
        } else {
            console.log('ℹ️  RAG : génération sans contexte');
        }

        // 5. Génération via OpenAI (avec contexte RAG)
        console.log('Appel OpenAI en cours...');
        let releaseNotes;
        try {
            const outputLanguage = tl.getInput('outputLanguage', false) || 'fr';
            releaseNotes = await generateReleaseNotes(
                formattedTickets,
                releaseName,
                releaseDate,
                project,
                environment,
                openAiApiKey,
                outputLanguage,
                ragExamples
            );
            console.log('✅ OpenAI succès - longueur:', releaseNotes.length);
        } catch (err) {
            console.log('❌ Erreur OpenAI:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        // 6. Sauvegarde avec embedding + métadonnées RAG
        console.log('Sauvegarde Extension Data...');
        try {
            await saveToExtensionData(
                orgUrl, project, releaseId,
                releaseName, releaseDate, environment,
                workItems, releaseNotes, accessToken,
                openAiApiKey, formattedTickets, currentMeta
            );
            console.log('✅ Sauvegarde succès');
        } catch (err) {
            console.log('❌ Erreur Extension Data:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        console.log('✅ Release Notes générées et sauvegardées');
        tl.setResult(tl.TaskResult.Succeeded, 'Release Notes générées avec succès');

    } catch (err) {
        console.error('❌ Erreur générale:', err.message);
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

// ── Récupération des work items ───────────────────────────────────────────
async function getWorkItems(orgUrl, vsrmUrl, project, releaseId, accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const url = `${vsrmUrl}${project}/_apis/release/releases/${releaseId}/workitems?api-version=7.0`;
    console.log('URL Release:', url);

    const response = await axios.get(url, { headers });
    const workItemRefs = response.data.value || [];
    console.log('Work item refs:', workItemRefs.length);

    const workItemDetails = await Promise.all(
        workItemRefs.map(async (ref) => {
            const detailUrl = `${orgUrl}${project}/_apis/wit/workitems/${ref.id}?$expand=relations&api-version=7.0`;
            const detail    = await axios.get(detailUrl, { headers });
            const fields    = detail.data.fields;

            const relations = (detail.data.relations || [])
                .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward' ||
                             r.rel === 'System.LinkTypes.Related')
                .map(r => {
                    const idMatch = r.url.match(/\/(\d+)$/);
                    return idMatch ? { id: idMatch[1], type: r.rel } : null;
                })
                .filter(Boolean);

            return {
                id         : ref.id,
                title      : fields['System.Title'],
                type       : fields['System.WorkItemType'],
                state      : fields['System.State'],
                description: fields['System.Description'] || '',
                areaPath   : fields['System.AreaPath'] || '',
                relations
            };
        })
    );

    return workItemDetails;
}

// ── Formatage des tickets (inchangé) ─────────────────────────────────────
function formatWorkItems(workItems) {
    const filtered = workItems.filter(item =>
        ['Closed'].includes(item.state) &&
        !item.title.toLowerCase().match(/test|debug|temp/)
    );

    if (filtered.length === 0) return 'No closed tickets found for this release.';

    const currentReleaseIds = new Set(filtered.map(item => String(item.id)));

    return filtered.map(item => {
        const cleanDescription = item.description
            ? item.description.replace(/<[^>]*>/g, '').replace(/!\[.*?\]\(.*?\)/g, '').trim()
            : 'no description available';

        let relationInfo = 'none';
        if (item.relations && item.relations.length > 0) {
            relationInfo = item.relations.map(r => {
                const relatedId = String(r.id);
                const isIn = currentReleaseIds.has(relatedId);
                return `#${relatedId} (${isIn ? 'IN_CURRENT_RELEASE' : 'FROM_PREVIOUS_RELEASE'})`;
            }).join(', ');
        }

        return `[TICKET #${item.id}]
Type        : ${item.type}
Title       : ${item.title}
Description : ${cleanDescription}
State       : ${item.state}
Area Path   : ${item.areaPath}
Related to  : ${relationInfo}`;
    }).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// NOUVEAU : le CODE construit le header (titre + tableau de métadonnées).
// Toujours bien formé, aucune répétition. GPT ne génère QUE le corps.
// ═══════════════════════════════════════════════════════════════════════════
function buildReleaseNoteHeader(releaseName, releaseDate, project, environment) {
    return [
        `# Release Notes — ${releaseName}`,
        '',
        '| Projet | Version | Date de release | Environnement |',
        '|---|---|---|---|',
        `| ${project} | ${releaseName} | ${releaseDate} | ${environment} |`,
        ''
    ].join('\n');
}
 

// ── Génération via OpenAI (CORRIGÉ : corps uniquement + RAG) ──────────────
async function generateReleaseNotes(
    tickets, releaseName, releaseDate, project,
    environment, apiKey, outputLanguage, ragExamples = null
) {
    const langInstruction = outputLanguage === 'fr'
        ? 'You MUST respond ONLY in French. No exceptions.'
        : 'You MUST respond ONLY in English. No exceptions.';

    // Bloc RAG (few-shot examples)
    let ragBlock = '';
    if (ragExamples && ragExamples.length > 0) {
        ragBlock = `

[STYLE REFERENCE — VALIDATED EXAMPLES]
The following release notes were validated by the release manager.
Use them as style, tone, and structure references ONLY.
Do NOT copy content — adapt the format to the new tickets.

${ragExamples.map((ex, i) => `--- Reference ${i + 1}: ${ex.releaseName} (score: ${ex.finalScore.toFixed(3)}) ---
${ex.content.slice(0, 1000)}
--- End of reference ${i + 1} ---`).join('\n\n')}

Generate the new release note body following the same communication style.`;
    }

    const systemPrompt = `You are an expert in client-oriented technical communication.
You work for a software development team using Azure DevOps.
Your role is to transform lists of technical tickets into professional,
clear, and understandable release notes for a release manager
representing a client enterprise.

STRICT RULES:

[Language]
${langInstruction}

[Format]
- Generate ONLY the BODY of the release note in Markdown.
- DO NOT generate a main title (#) nor a metadata table: they are added automatically by the system.
- Start DIRECTLY with "## Résumé de la version".
- CRITICAL: If a ticket category has NO tickets, DO NOT display that section header at all.
- For each ticket, use a sub-heading of the form "### Clear client-oriented title (#ID)"
  followed by 1 to 3 bullet points describing the concrete impact for the user or business.

[Content]
- Reformulate each ticket in business language — never use technical jargon.
- Never copy the raw ticket title — always reformulate.
- The global summary must describe business value. 2-3 sentences max.
- Include only tickets with state Closed.

[Linked Tickets Rules]
- Each ticket has a "Related to" field:
  * IN_CURRENT_RELEASE = linked ticket is in THIS release
  * FROM_PREVIOUS_RELEASE = linked ticket was in a PREVIOUS release
- If both tickets are IN_CURRENT_RELEASE, present them together (A then B).
- If FROM_PREVIOUS_RELEASE, present the current ticket standalone.

[Body template — SECTIONS ONLY, no title, no table]
## Résumé de la version
[2-3 sentences]

## Nouvelles Fonctionnalités
### [title] (#ID)
- [bullet]

## Bugs Corrigés
### [title] (#ID)
- [bullet]

## Améliorations
### [title] (#ID)
- [bullet]
${ragBlock}`;

    const userPrompt = `Generate the BODY of a professional release note for "${releaseName}"
delivered on ${releaseDate} for "${project}". Environment: ${environment}.
Start directly with "## Résumé de la version". Do not add a title or a table.

Tickets:
${tickets}`;

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   }
            ],
            max_tokens : 2000,
            temperature: 0.3
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    let body = response.data.choices[0].message.content.trim();

    // Sécurité : si GPT ajoute malgré tout un titre (#) ou des lignes de tableau, on les retire
    body = body
        .replace(/^#\s+.*$/gm, '')       // titres de niveau 1 éventuels (## et ### préservés)
        .replace(/^\|.*\|\s*$/gm, '')    // lignes de tableau éventuelles
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    // Assemblage final : header (code) + corps (GPT)
    const header = buildReleaseNoteHeader(releaseName, releaseDate, project, environment);
    return header + '\n' + body;
}

// ── Sauvegarde Extension Data (inchangé) ──────────────────────────────────
async function saveToExtensionData(
    orgUrl, project, releaseId, releaseName, releaseDate,
    environment, workItems, content, accessToken,
    openAiApiKey, formattedTickets, currentMeta
) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const publisherId    = 'ReleaseManagerTools';
    const extensionId    = 'smart-release-notes';
    const collectionName = `release-notes-${project}`;
    const documentId     = `releaseNote_${releaseId}`;

    let data = {
        __etag          : -1,
        id              : documentId,
        releaseName,
        releaseId,
        project,
        releaseDate,
        environment,
        dateGeneration  : new Date().toISOString(),
        statut          : 'Active',
        contenuMarkdown : content,
        embedding       : [],
        ragMetadata     : currentMeta,
        workItems       : workItems.map(wi => ({
            id         : wi.id,
            title      : wi.title,
            type       : wi.type,
            state      : wi.state,
            description: wi.description,
            areaPath   : wi.areaPath
        }))
    };

    data = await generateAndAttachEmbedding(data, formattedTickets, openAiApiKey);

    const extmgmtUrl = orgUrl.replace('dev.azure.com', 'extmgmt.dev.azure.com');
    const url = `${extmgmtUrl}_apis/ExtensionManagement/InstalledExtensions/${publisherId}/${extensionId}/Data/Scopes/Default/Current/Collections/${collectionName}/Documents/${documentId}?api-version=7.1-preview.1`;

    await axios.put(url, data, { headers });
    console.log('✅ Document sauvegardé avec embedding + ragMetadata');
}

run();