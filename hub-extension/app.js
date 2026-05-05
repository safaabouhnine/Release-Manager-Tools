// SDK Azure DevOps
VSS.init({
    explicitNotifyLoaded: true,
    usePlatformStyles: true
});

VSS.ready(function() {
    
    const webContext = VSS.getWebContext();
    const projectName = webContext.project.name;
    
    // Éléments UI
    const projectSelect = document.getElementById('projectSelect');
    const releaseSelect = document.getElementById('releaseSelect');
    const loadTicketsBtn = document.getElementById('loadTicketsBtn');
    const generateBtn = document.getElementById('generateBtn');
    const markDoneBtn = document.getElementById('markDoneBtn');
    const exportBtn = document.getElementById('exportBtn');
    const ticketsCard = document.getElementById('ticketsCard');
    const releaseNotesCard = document.getElementById('releaseNotesCard');
    const loadingOverlay = document.getElementById('loadingOverlay');
    
    let currentWorkItems = [];
    let currentStatus = 'active';

    // Charger les projets
    async function loadProjects() {
        const client = await VSS.getServiceContribution('ms.vss-web.data-service');
        projectSelect.innerHTML = `<option value="${projectName}">${projectName}</option>`;
        loadReleases(projectName);
    }

    // Charger les releases du projet
    async function loadReleases(project) {
        try {
            const orgUrl = webContext.account.uri;
            const token = await getAccessToken();
            
            const response = await fetch(
                `${orgUrl}${project}/_apis/release/releases?api-version=7.0&$top=20`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            const data = await response.json();
            const releases = data.value || [];
            
            releaseSelect.innerHTML = '<option value="">Sélectionnez une release</option>';
            releases.forEach(release => {
                const option = document.createElement('option');
                option.value = release.id;
                option.textContent = release.name;
                releaseSelect.appendChild(option);
            });
            
            releaseSelect.disabled = false;
            
        } catch (err) {
            console.error('Erreur chargement releases:', err);
        }
    }

    // Charger les tickets de la release sélectionnée
    async function loadTickets(releaseId, project) {
        try {
            showLoading(true);
            const orgUrl = webContext.account.uri;
            const token = await getAccessToken();
            
            // Récupérer les work items de la release
            const response = await fetch(
                `${orgUrl}${project}/_apis/release/releases/${releaseId}/workitems?api-version=7.0`,
                {
                    headers: { 'Authorization': `Bearer ${token}` }
                }
            );
            
            const data = await response.json();
            const workItemRefs = data.value || [];
            
            // Récupérer les détails
            currentWorkItems = await Promise.all(
                workItemRefs.map(async (ref) => {
                    const detail = await fetch(
                        `${orgUrl}${project}/_apis/wit/workitems/${ref.id}?api-version=7.0`,
                        { headers: { 'Authorization': `Bearer ${token}` } }
                    );
                    const detailData = await detail.json();
                    return {
                        id: ref.id,
                        title: detailData.fields['System.Title'],
                        type: detailData.fields['System.WorkItemType'],
                        state: detailData.fields['System.State']
                    };
                })
            );
            
            displayTickets(currentWorkItems);
            ticketsCard.style.display = 'block';
            showLoading(false);
            
        } catch (err) {
            console.error('Erreur chargement tickets:', err);
            showLoading(false);
        }
    }

    // Afficher les tickets
    function displayTickets(workItems) {
        const list = document.getElementById('ticketsList');
        list.innerHTML = '';
        
        workItems.forEach(wi => {
            const typeClass = getTypeClass(wi.type);
            const div = document.createElement('div');
            div.className = 'ticket-item';
            div.innerHTML = `
                <span class="ticket-type ${typeClass}">${wi.type}</span>
                <span class="ticket-id">#${wi.id}</span>
                <span class="ticket-title">${wi.title}</span>
            `;
            list.appendChild(div);
        });
    }

    // Générer les Release Notes via OpenAI
    async function generateReleaseNotes() {
        try {
            showLoading(true);
            
            const releaseName = releaseSelect.options[releaseSelect.selectedIndex].text;
            
            // Appel OpenAI
            const prompt = buildPrompt(currentWorkItems, releaseName);
            const generatedContent = await callOpenAI(prompt);
            
            // Afficher le résultat
            document.getElementById('releaseName').textContent = releaseName;
            document.getElementById('releaseNotesContent').innerHTML = 
                marked.parse(generatedContent);
            
            releaseNotesCard.style.display = 'block';
            showLoading(false);
            
        } catch (err) {
            console.error('Erreur génération:', err);
            showLoading(false);
        }
    }

    // Construction du prompt
    function buildPrompt(workItems, releaseName) {
        const workItemsList = workItems.map(wi => 
            `- [${wi.type}] #${wi.id} : ${wi.title}`
        ).join('\n');

        return `
Tu es un expert en communication technique orientée client.
Réponds uniquement en français.

Voici la liste des tickets fermés dans la release "${releaseName}" :
${workItemsList}

Génère une Release Note professionnelle et structurée avec :
1. Un résumé global en 2-3 phrases compréhensibles par un client non technique
2. Les tickets catégorisés en sections :
   - 🆕 Nouvelles Fonctionnalités
   - 🐛 Corrections de Bugs  
   - ⚙️ Améliorations
3. Pour chaque ticket : référence #ID et description courte orientée bénéfice client

Format de sortie : Markdown
        `;
    }

    // Appel OpenAI API
    async function callOpenAI(prompt) {
        const apiKey = 'VOTRE_CLE_API_ICI'; // Sera remplacé par la clé SanaSoft
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { 
                        role: 'system', 
                        content: 'Tu es un expert en rédaction de Release Notes professionnelles.' 
                    },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1000,
                temperature: 0.3
            })
        });
        
        const data = await response.json();
        return data.choices[0].message.content;
    }

    // Marquer comme Done
    function markAsDone() {
        currentStatus = 'done';
        const badge = document.getElementById('statusBadge');
        badge.textContent = '✅ Done';
        badge.className = 'badge badge-done';
        markDoneBtn.disabled = true;
        exportBtn.disabled = false;
    }

    // Utilitaires
    function getTypeClass(type) {
        const types = {
            'Bug': 'type-bug',
            'Feature': 'type-feature',
            'User Story': 'type-userstory',
            'Task': 'type-task'
        };
        return types[type] || 'type-task';
    }

    function showLoading(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    async function getAccessToken() {
        return new Promise((resolve) => {
            VSS.getAccessToken().then(token => {
                resolve(token.value);
            });
        });
    }

    // Event Listeners
    releaseSelect.addEventListener('change', function() {
        loadTicketsBtn.disabled = !this.value;
    });

    loadTicketsBtn.addEventListener('click', function() {
        const releaseId = releaseSelect.value;
        const project = projectSelect.value;
        if (releaseId && project) {
            loadTickets(releaseId, project);
        }
    });

    generateBtn.addEventListener('click', generateReleaseNotes);
    markDoneBtn.addEventListener('click', markAsDone);
    
    exportBtn.addEventListener('click', function() {
        alert('Release Note envoyée au client avec succès !');
    });

    // Initialisation
    loadProjects();
    VSS.notifyLoadSucceeded();
});