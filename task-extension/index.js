const tl = require('azure-pipelines-task-lib/task');
const axios = require('axios');

async function run() {
    try {
        // 1. Récupération des inputs
        const openAiApiKey = tl.getInput('openAiApiKey', true);
        const outputLanguage = tl.getInput('outputLanguage', true);
        const wikiPagePath = tl.getInput('wikiPagePath', true);

        // 2. Variables Azure DevOps automatiques
        const orgUrl = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
        const project = process.env.SYSTEM_TEAMPROJECT;
        const releaseId = process.env.RELEASE_RELEASEID;
        const accessToken = process.env.SYSTEM_ACCESSTOKEN;
        const releaseName = process.env.RELEASE_RELEASENAME;

        console.log(`Génération des Release Notes pour : ${releaseName}`);

        // 3. Récupération des work items de la release
        const workItems = await getWorkItems(orgUrl, project, releaseId, accessToken);
        console.log(`${workItems.length} tickets récupérés`);

        // 4. Génération via OpenAI
        const releaseNotes = await generateReleaseNotes(
            workItems, 
            releaseName, 
            openAiApiKey, 
            outputLanguage
        );

        // 5. Sauvegarde dans le Wiki Azure DevOps
        await saveToWiki(orgUrl, project, wikiPagePath, releaseNotes, accessToken, releaseName);

        console.log('Release Notes générées et sauvegardées avec succès');
        tl.setResult(tl.TaskResult.Succeeded, 'Release Notes générées avec succès');

    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

// Récupération des work items depuis Azure DevOps API
async function getWorkItems(orgUrl, project, releaseId, accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    // Récupérer les work items liés à la release
    const url = `${orgUrl}${project}/_apis/release/releases/${releaseId}/workitems?api-version=7.0`;
    const response = await axios.get(url, { headers });
    
    const workItemRefs = response.data.value || [];
    
    // Récupérer les détails de chaque work item
    const workItemDetails = await Promise.all(
        workItemRefs.map(async (ref) => {
            const detailUrl = `${orgUrl}${project}/_apis/wit/workitems/${ref.id}?api-version=7.0`;
            const detail = await axios.get(detailUrl, { headers });
            return {
                id: ref.id,
                title: detail.data.fields['System.Title'],
                type: detail.data.fields['System.WorkItemType'],
                state: detail.data.fields['System.State']
            };
        })
    );

    return workItemDetails;
}

// Génération des Release Notes via OpenAI
async function generateReleaseNotes(workItems, releaseName, apiKey, language) {
    const langInstruction = language === 'fr' 
        ? 'Réponds uniquement en français.' 
        : 'Reply only in English.';

    const workItemsList = workItems.map(wi => 
        `- [${wi.type}] #${wi.id} : ${wi.title}`
    ).join('\n');

    const prompt = `
Tu es un expert en communication technique orientée client.
${langInstruction}

Voici la liste des tickets fermés dans la release "${releaseName}" :
${workItemsList}

Génère une Release Note professionnelle et structurée avec :
1. Un résumé global en 2-3 phrases compréhensibles par un client non technique
2. Les tickets catégorisés en sections : 
   - 🆕 Nouvelles Fonctionnalités (Features, User Stories)
   - 🐛 Corrections de Bugs (Bugs)
   - ⚙️ Améliorations (Tasks, autres)
3. Pour chaque ticket : référence #ID et une description courte orientée bénéfice client

Format de sortie : Markdown
Statut : Active
`;

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Tu es un expert en rédaction de Release Notes professionnelles.' },
                { role: 'user', content: prompt }
            ],
            max_tokens: 1000,
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

    // Ajouter métadonnées en haut du document
    const fullContent = `# Release Note — ${releaseName}
> **Statut** : 🟡 Active  
> **Générée le** : ${new Date().toLocaleDateString('fr-FR')}  
> **Générée par** : Smart Release Notes Generator

---

${content}`;

    // Vérifier si la page existe déjà
    const wikiUrl = `${orgUrl}${project}/_apis/wiki/wikis/${project}.wiki/pages?path=${encodeURIComponent(pagePath)}&api-version=7.0`;
    
    try {
        // Essayer de mettre à jour la page existante
        const existing = await axios.get(wikiUrl, { headers });
        const etag = existing.headers.etag;
        
        await axios.put(wikiUrl, 
            { content: fullContent },
            { headers: { ...headers, 'If-Match': etag } }
        );
    } catch (e) {
        // Créer la page si elle n'existe pas
        await axios.put(wikiUrl,
            { content: fullContent },
            { headers: { ...headers, 'If-Match': '*' } }
        );
    }
}

run();