VSS.init({
    explicitNotifyLoaded: true,
    usePlatformStyles: true
});

VSS.ready(function() {
    const webContext = VSS.getWebContext();
    const projectName = webContext.project.name;
    const orgUrl = webContext.account.uri;

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

    // Initialiser le projet
    projectSelect.innerHTML = `<option value="${projectName}">${projectName}</option>`;
    loadReleases(projectName);

    // Charger les releases
    function loadReleases(project) {
    VSS.getAccessToken().then(function(token) {
        
        // Log pour debug
        console.log('orgUrl:', orgUrl);
        console.log('project:', project);
        console.log('token:', token.value ? 'OK' : 'VIDE');
        
        const url = orgUrl + project + '/_apis/release/releases?api-version=7.0&$top=20';
        console.log('URL appelée:', url);
        
        fetch(url, {
            headers: {
                'Authorization': 'Bearer ' + token.value,
                'Content-Type': 'application/json'
            }
        })
        .then(function(response) {
            console.log('Status:', response.status);
            // Vérifier si la réponse est bien du JSON
            const contentType = response.headers.get('content-type');
            console.log('Content-Type:', contentType);
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error('Réponse non-JSON reçue : ' + response.status);
            }
            return response.json();
        })
        .then(function(data) {
            const releases = data.value || [];
            console.log('Releases trouvées:', releases.length);
            
            releaseSelect.innerHTML = '<option value="">Sélectionnez une release</option>';
            
            if (releases.length === 0) {
                releaseSelect.innerHTML = '<option value="">Aucune release trouvée</option>';
                return;
            }
            
            releases.forEach(function(release) {
                const option = document.createElement('option');
                option.value = release.id;
                option.textContent = release.name;
                releaseSelect.appendChild(option);
            });
            releaseSelect.disabled = false;
        })
        .catch(function(err) {
            console.error('Erreur releases:', err);
            releaseSelect.innerHTML = '<option value="">Erreur: ' + err.message + '</option>';
        });
    });
}
    // Charger les tickets
    function loadTickets(releaseId, project) {
        showLoading(true);
        VSS.getAccessToken().then(function(token) {
            fetch(
                orgUrl + project + '/_apis/release/releases/' + releaseId + '/workitems?api-version=7.0',
                { headers: { 'Authorization': 'Bearer ' + token.value } }
            )
            .then(function(response) { return response.json(); })
            .then(function(data) {
                const workItemRefs = data.value || [];
                const promises = workItemRefs.map(function(ref) {
                    return fetch(
                        orgUrl + project + '/_apis/wit/workitems/' + ref.id + '?api-version=7.0',
                        { headers: { 'Authorization': 'Bearer ' + token.value } }
                    )
                    .then(function(r) { return r.json(); })
                    .then(function(detail) {
                        return {
                            id: ref.id,
                            title: detail.fields['System.Title'],
                            type: detail.fields['System.WorkItemType'],
                            state: detail.fields['System.State']
                        };
                    });
                });

                Promise.all(promises).then(function(items) {
                    currentWorkItems = items;
                    displayTickets(items);
                    ticketsCard.style.display = 'block';
                    showLoading(false);
                });
            })
            .catch(function(err) {
                console.error('Erreur tickets:', err);
                showLoading(false);
            });
        });
    }

    // Afficher les tickets
    function displayTickets(workItems) {
        const list = document.getElementById('ticketsList');
        list.innerHTML = '';

        if (workItems.length === 0) {
            list.innerHTML = '<p style="color:#888;padding:10px;">Aucun ticket trouvé.</p>';
            return;
        }

        workItems.forEach(function(wi) {
            const div = document.createElement('div');
            div.className = 'ticket-item';
            div.innerHTML =
                '<span class="ticket-type ' + getTypeClass(wi.type) + '">' + wi.type + '</span>' +
                '<span class="ticket-id">#' + wi.id + '</span>' +
                '<span class="ticket-title">' + wi.title + '</span>';
            list.appendChild(div);
        });
    }

    // Générer les Release Notes
    function generateReleaseNotes() {
        showLoading(true);
        const releaseName = releaseSelect.options[releaseSelect.selectedIndex].text;
        const prompt = buildPrompt(currentWorkItems, releaseName);

        callOpenAI(prompt)
        .then(function(content) {
            document.getElementById('releaseName').textContent = releaseName;
            document.getElementById('releaseNotesContent').innerHTML = marked.parse(content);
            releaseNotesCard.style.display = 'block';
            showLoading(false);
        })
        .catch(function(err) {
            console.error('Erreur OpenAI:', err);
            showLoading(false);
            alert('Erreur génération. Vérifiez la clé API.');
        });
    }

    // Prompt
    function buildPrompt(workItems, releaseName) {
        const list = workItems.map(function(wi) {
            return '- [' + wi.type + '] #' + wi.id + ' : ' + wi.title;
        }).join('\n');

        return 'Tu es un expert en communication technique orientée client.\n' +
               'Réponds uniquement en français.\n\n' +
               'Voici les tickets fermés dans la release "' + releaseName + '" :\n' +
               list + '\n\n' +
               'Génère une Release Note professionnelle avec :\n' +
               '1. Un résumé global en 2-3 phrases orienté client\n' +
               '2. Tickets catégorisés : 🆕 Nouvelles Fonctionnalités, 🐛 Bugs, ⚙️ Améliorations\n' +
               '3. Pour chaque ticket : #ID et description courte\n' +
               'Format : Markdown';
    }

    // OpenAI
    function callOpenAI(prompt) {
        const apiKey = 'VOTRE_CLE_API_ICI';
        return fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Tu es expert en Release Notes professionnelles.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 1000,
                temperature: 0.3
            })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) { return data.choices[0].message.content; });
    }

    // Marquer Done
    function markAsDone() {
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

    // Events
    releaseSelect.addEventListener('change', function() {
        loadTicketsBtn.disabled = !this.value;
    });

    loadTicketsBtn.addEventListener('click', function() {
        if (releaseSelect.value) {
            loadTickets(releaseSelect.value, projectName);
        }
    });

    generateBtn.addEventListener('click', generateReleaseNotes);
    markDoneBtn.addEventListener('click', markAsDone);
    exportBtn.addEventListener('click', function() {
        alert('Release Note prête à envoyer au client !');
    });

    VSS.notifyLoadSucceeded();
});