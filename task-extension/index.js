const tl = require('azure-pipelines-task-lib/task');
const axios = require('axios');

async function run() {
    try {
        // 1. Récupération des inputs
        const openAiApiKey = tl.getInput('openAiApiKey', true);
        const wikiPagePath = tl.getInput('wikiPagePath', true);

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
            releaseNotes = await generateReleaseNotes(
                formattedTickets,
                releaseName,
                releaseDate,
                project,
                environment,
                openAiApiKey
            );
            console.log('✅ OpenAI succès - longueur réponse:', releaseNotes.length);
        } catch(err) {
            console.log('❌ Erreur OpenAI:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        // 6. Sauvegarde Wiki
        console.log('Sauvegarde Wiki en cours...');
        try {
            await saveToWiki(orgUrl, project, wikiPagePath, releaseNotes, accessToken, releaseName);
            console.log('✅ Wiki sauvegarde succès');
        } catch(err) {
            console.log('❌ Erreur Wiki:', err.response?.status, JSON.stringify(err.response?.data));
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
        ['Closed', 'Resolved'].includes(item.state) &&
        !item.title.toLowerCase().match(/test|debug|temp/)
    );

    if (filtered.length === 0) {
        return 'No closed or resolved tickets found for this release.';
    }

    return filtered.map(item => {
        const cleanDescription = item.description
            ? item.description
                .replace(/<[^>]*>/g, '')
                .replace(/!\[.*?\]\(.*?\)/g, '')
                .trim()
            : 'no description available';

        const relations = item.relations?.length > 0
            ? item.relations.map(r => `#${r.id} (${r.type})`).join(', ')
            : 'none';

        return `[TICKET #${item.id}]
Type        : ${item.type}
Title       : ${item.title}
Description : ${cleanDescription}
State       : ${item.state}
Related to  : ${relations}`;
    }).join('\n\n');
}

// Génération via OpenAI
async function generateReleaseNotes(tickets, releaseName, releaseDate, project, environment, apiKey) {

    const systemPrompt = `You are an expert in client-oriented technical communication.
You work for a software development team using Azure DevOps.
Your role is to transform lists of technical tickets into professional,
clear, and understandable release notes for a release manager
representing a client enterprise.

STRICT RULES:

[Language]
- Automatically detect the dominant language of the provided tickets.
- If only one language is detected, generate the release note in that language.
- If multiple languages are detected:
    * If one language represents 70% or more of the tickets, use that language.
    * Otherwise, if English is present, use English.
    * Otherwise, if French is present, use French.

[Format]
- Generate your response ONLY in Markdown format.
- Generate NOTHING other than the requested release note.
- If a ticket category is empty, do not display it.
- For each ticket, generate a bold client-oriented title followed by
  1 to 3 bullet points describing the concrete impact for the user or business.

[Content]
- Reformulate each ticket in business language — never use technical jargon.
- Never copy the raw ticket title — always reformulate.
- If a ticket title is too vague, indicate: "Internal improvement #ID".
- The global summary must describe business value, not technical details. 2-3 sentences max.
- Include only tickets with state Closed or Resolved.
- Ignore tickets that appear to be internal test entries.

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

// Sauvegarde dans le Wiki Azure DevOps
async function saveToWiki(orgUrl, project, pagePath, content, accessToken, releaseName) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const fullContent = `${content}

---
*Release Note générée automatiquement par Smart Release Notes Generator*  
*Statut : 🟡 Active — En attente de validation par le Release Manager*`;

    const baseUrl = `${orgUrl}${project}/_apis/wiki/wikis/${project}.wiki/pages`;

    // Étape 1 — Créer la page parent /Releases si elle n'existe pas
    const parentPath = '/Releases';
    const parentUrl = `${baseUrl}?path=${encodeURIComponent(parentPath)}&api-version=7.0`;
    
    try {
        await axios.get(parentUrl, { headers });
        console.log('✅ Dossier /Releases existe');
    } catch(e) {
        if (e.response?.status === 404) {
            console.log('Création dossier /Releases...');
            try {
                await axios.put(parentUrl,
                    { content: '# Releases\n\nRelease Notes générées automatiquement.' },
                    { headers: headers }
                );
                console.log('✅ Dossier /Releases créé');
            } catch(createErr) {
                console.log('❌ Erreur création /Releases:', createErr.response?.status, JSON.stringify(createErr.response?.data));
                throw createErr;
            }
        }
    }

    // Étape 2 — Créer ou mettre à jour la page Release Note
    const pageUrl = `${baseUrl}?path=${encodeURIComponent(pagePath)}&api-version=7.0`;
    console.log('Wiki page URL:', pageUrl);

    try {
        // Vérifier si la page existe
        const existing = await axios.get(pageUrl, { headers });
        const etag = existing.headers.etag;
        console.log('Page existante — mise à jour...');

        await axios.put(pageUrl,
            { content: fullContent },
            { headers: { ...headers, 'If-Match': etag } }
        );
        console.log('✅ Wiki page mise à jour');

    } catch (e) {
        if (e.response?.status === 404) {
            console.log('Page non trouvée — création...');
            try {
                await axios.put(pageUrl,
                    { content: fullContent },
                    { headers: headers }
                );
                console.log('✅ Wiki page créée');
            } catch (createErr) {
                console.log('❌ Erreur création page:', createErr.response?.status, JSON.stringify(createErr.response?.data));
                throw createErr;
            }
        } else {
            console.log('❌ Erreur Wiki:', e.response?.status, JSON.stringify(e.response?.data));
            throw e;
        }
    }
}
run();