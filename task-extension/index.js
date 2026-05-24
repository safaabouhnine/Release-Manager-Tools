const tl = require('azure-pipelines-task-lib/task');
const axios = require('axios');

async function run() {
    try {
        // 1. Récupération des inputs
        const openAiApiKey = tl.getInput('openAiApiKey', true);

        // 2. Variables Azure DevOps automatiques
        const orgUrl = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
        const project = process.env.SYSTEM_TEAMPROJECT;
        const releaseId = process.env.RELEASE_RELEASEID;
        const accessToken = process.env.SYSTEM_ACCESSTOKEN;
        const releaseName = process.env.RELEASE_RELEASENAME || 'Release';
        const releaseDate = new Date().toLocaleDateString('fr-FR');
        const environment = process.env.RELEASE_ENVIRONMENTNAME || 'Production';

        // Logs de diagnostic
        console.log('=== DIAGNOSTIC ===');
        console.log('orgUrl:', orgUrl);
        console.log('project:', project);
        console.log('releaseId:', releaseId);
        console.log('accessToken:', accessToken ? 'PRESENT' : 'VIDE');
        const vsrmUrl = orgUrl ? orgUrl.replace('dev.azure.com', 'vsrm.dev.azure.com') : '';
        console.log('vsrmUrl:', vsrmUrl);
        console.log('==================');

        console.log(`Génération des Release Notes pour : ${releaseName}`);

        // 3. Récupération des work items
        const workItems = await getWorkItems(orgUrl, vsrmUrl, project, releaseId, accessToken);
        console.log(`${workItems.length} tickets récupérés`);

        // 4. Formatage des tickets
        const formattedTickets = formatWorkItems(workItems);
        console.log('Tickets filtrés - nombre:', workItems.filter(i => 
            ['Closed', 'Resolved'].includes(i.state)).length
        );

        // 5. Génération via OpenAI
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
                outputLanguage
            );
            console.log('✅ OpenAI succès - longueur réponse:', releaseNotes.length);
        } catch(err) {
            console.log('❌ Erreur OpenAI:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        // 6. Sauvegarde Extension Data
        console.log('Sauvegarde Extension Data en cours...');
        try {
            await saveToExtensionData(
                orgUrl, project, releaseId,
                releaseName, releaseDate, environment,
                workItems, releaseNotes, accessToken
            );
            console.log('✅ Extension Data sauvegarde succès');
        } catch(err) {
            console.log('❌ Erreur Extension Data:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        console.log('✅ Release Notes générées et sauvegardées avec succès');
        tl.setResult(tl.TaskResult.Succeeded, 'Release Notes générées avec succès');

    } catch (err) {
        console.error('❌ Erreur générale:', err.message);
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

// Récupération des work items
async function getWorkItems(orgUrl, vsrmUrl, project, releaseId, accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const url = `${vsrmUrl}${project}/_apis/release/releases/${releaseId}/workitems?api-version=7.0`;
    console.log('URL Release:', url);

    const response = await axios.get(url, { headers });
    const workItemRefs = response.data.value || [];
    console.log('Work item refs trouvés:', workItemRefs.length);

    const workItemDetails = await Promise.all(
        workItemRefs.map(async (ref) => {
            const detailUrl = `${orgUrl}${project}/_apis/wit/workitems/${ref.id}?$expand=relations&api-version=7.0`;
            const detail = await axios.get(detailUrl, { headers });
            const fields = detail.data.fields;

            const relations = (detail.data.relations || [])
                .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward' ||
                             r.rel === 'System.LinkTypes.Related')
                .map(r => {
                    const idMatch = r.url.match(/\/(\d+)$/);
                    return idMatch ? { id: idMatch[1], type: r.rel } : null;
                })
                .filter(Boolean);

            return {
                id: ref.id,
                title: fields['System.Title'],
                type: fields['System.WorkItemType'],
                state: fields['System.State'],
                description: fields['System.Description'] || '',
                relations: relations
            };
        })
    );

    return workItemDetails;
}

// Formatage des tickets pour le prompt
function formatWorkItems(workItems) {
    const filtered = workItems.filter(item =>
        ['Closed'].includes(item.state) &&
        !item.title.toLowerCase().match(/test|debug|temp/)
    );

    if (filtered.length === 0) {
        return 'No closed tickets found for this release.';
    }

    // Récupérer tous les IDs de la release courante
    const currentReleaseIds = new Set(filtered.map(item => String(item.id)));

    return filtered.map(item => {
        const cleanDescription = item.description
            ? item.description
                .replace(/<[^>]*>/g, '')
                .replace(/!\[.*?\]\(.*?\)/g, '')
                .trim()
            : 'no description available';

        // Analyser les relations
        let relationInfo = 'none';
        if (item.relations && item.relations.length > 0) {
            const relationDetails = item.relations.map(r => {
                const relatedId = String(r.id);
                const isInCurrentRelease = currentReleaseIds.has(relatedId);
                return `#${relatedId} (${isInCurrentRelease ? 'IN_CURRENT_RELEASE' : 'FROM_PREVIOUS_RELEASE'})`;
            }).join(', ');
            relationInfo = relationDetails;
        }

        return `[TICKET #${item.id}]
Type        : ${item.type}
Title       : ${item.title}
Description : ${cleanDescription}
State       : ${item.state}
Related to  : ${relationInfo}`;
    }).join('\n\n');
}

// Génération via OpenAI
async function generateReleaseNotes(tickets, releaseName, releaseDate, project, environment, apiKey, outputLanguage) {

    const langInstruction = outputLanguage === 'fr'
        ? 'You MUST respond ONLY in French. No exceptions.'
        : 'You MUST respond ONLY in English. No exceptions.';
    const systemPrompt = `You are an expert in client-oriented technical communication.
You work for a software development team using Azure DevOps.
Your role is to transform lists of technical tickets into professional,
clear, and understandable release notes for a release manager
representing a client enterprise.

STRICT RULES:

[Language]
${langInstruction}

[Format]
- Generate your response ONLY in Markdown format.
- Generate NOTHING other than the requested release note.
- CRITICAL: If a ticket category has NO tickets, DO NOT display the section header at all. 
  Do NOT write "(Aucun bug corrigé)" or any similar placeholder. Simply omit the entire section.
- For each ticket, generate a bold client-oriented title followed by
  1 to 3 bullet points describing the concrete impact for the user or business.

[Content]
- Reformulate each ticket in business language — never use technical jargon.
- Never copy the raw ticket title — always reformulate.
- If a ticket title is too vague, indicate: "Internal improvement #ID".
- The global summary must describe business value, not technical details. 2-3 sentences max.
- Include only tickets with state Closed.
- Ignore tickets that appear to be internal test entries.

[Linked Tickets Rules]
- Each ticket has a "Related to" field showing linked tickets with their origin:
  * IN_CURRENT_RELEASE = the linked ticket exists in THIS release
  * FROM_PREVIOUS_RELEASE = the linked ticket was delivered in a PREVIOUS release

- RULE 1: If ticket A is related to ticket B and BOTH are IN_CURRENT_RELEASE:
  Present ticket A first (explain what it does and why it was created).
  Then present ticket B in relation to ticket A — explain that ticket B was created
  to handle, fix, complete, or extend ticket A based on its type:
    * If ticket B is a Bug → it was a bug discovered during the work on ticket A
    * If ticket B is a Task → it was a technical task required to complete ticket A
    * If ticket B is a Feature or User Story → it is a complement or extension of ticket A
  Always use client-oriented language describing the business impact.

- RULE 2: If ticket B is IN_CURRENT_RELEASE and its related ticket A is FROM_PREVIOUS_RELEASE:
  Present ONLY ticket B as a standalone ticket.
  Do NOT mention the previous release ticket.

- CRITICAL: If a category has no tickets, DO NOT display the section header at all.

[Template]
Use EXACTLY this structure:

# ${project} | Release Notes ${releaseName}

## ${project}
### Release Notes — ${releaseName}

| **Version**         | **${releaseName}** |
| **Date de release** | ${releaseDate}     |
| **Environnement**   | ${environment}     |
| **Application**     | ${project}         |

---

## Résumé de la version
[2-3 sentences describing the business value]

## Nouvelles Fonctionnalités
**[Client-oriented feature title] (#ID)**
- [bullet point]

## Bugs Corrigés
**[Client-oriented bug title] (#ID)**
- [bullet point]

## Améliorations
**[Client-oriented improvement title] (#ID)**
- [bullet point]`;

    const userPrompt = `Generate a professional release note for the release "${releaseName}" 
delivered on ${releaseDate} for the project "${project}".
Environment: ${environment}.

Here are the tickets included in this release:

${tickets}`;

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 2000,
            temperature: 0.3
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data.choices[0].message.content;
}

async function saveToExtensionData(orgUrl, project, releaseId, releaseName, releaseDate, environment, workItems, content, accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const publisherId = 'ReleaseManagerTools';
    const extensionId = 'smart-release-notes';
    const collectionName = `release-notes-${project}`;
    const documentId = `releaseNote_${releaseId}`;

    const data = {
        __etag: -1,
        id: documentId,
        releaseName: releaseName,
        releaseId: releaseId,
        project: project,
        releaseDate: releaseDate,
        environment: environment,
        dateGeneration: new Date().toISOString(),
        statut: 'Active',
        contenuMarkdown: content,
        workItems: workItems.map(wi => ({
            id: wi.id,
            title: wi.title,
            type: wi.type,
            state: wi.state
        }))
    };

    const extmgmtUrl = orgUrl.replace('dev.azure.com', 'extmgmt.dev.azure.com');
    const url = `${extmgmtUrl}_apis/ExtensionManagement/InstalledExtensions/${publisherId}/${extensionId}/Data/Scopes/Default/Current/Collections/${collectionName}/Documents/${documentId}?api-version=7.1-preview.1`;
    console.log('Extension Data URL:', url);

    try {
        await axios.put(url, data, { headers });
        console.log('✅ Extension Data sauvegardé');
    } catch(e) {
        console.log('❌ Erreur Extension Data:', e.response?.status, JSON.stringify(e.response?.data));
        throw e;
    }
}

run();