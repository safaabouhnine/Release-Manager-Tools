VSS.init({
    explicitNotifyLoaded: true,
    usePlatformStyles: true
});

VSS.ready(function () {
    const webContext = VSS.getWebContext();
    const projectName = webContext.project.name;
    // orgUrl est garanti de se terminer par '/' via le SDK
    const orgUrl = webContext.account.uri;

    // Éléments UI
    const projectSelect    = document.getElementById('projectSelect');
    const releaseSelect    = document.getElementById('releaseSelect');
    const loadTicketsBtn   = document.getElementById('loadTicketsBtn');
    const generateBtn      = document.getElementById('generateBtn');
    const markDoneBtn      = document.getElementById('markDoneBtn');
    const exportBtn        = document.getElementById('exportBtn');
    const ticketsCard      = document.getElementById('ticketsCard');
    const releaseNotesCard = document.getElementById('releaseNotesCard');
    const loadingOverlay   = document.getElementById('loadingOverlay');

    let currentWorkItems = [];

    // ─── Helper : récupère le token Bearer de façon fiable ────────────────────
    // VSS.getAccessToken() renvoie un objet { token: "..." }
    // On normalise ici pour ne plus jamais se tromper de champ.
    async function getBearerToken() {
        const tokenObj = await VSS.getAccessToken();
        // Selon la version du SDK l'objet peut exposer .token ou être la chaîne directement
        return tokenObj.token || tokenObj;
    }

    // ─── Helper : fetch avec auth ────────────────────────────────────────────
    async function apiFetch(url) {
        const token = await getBearerToken();
        console.log('token obtenu :', token ? token.substring(0, 20) + '...' : 'VIDE ⚠️');
        console.log('URL appelée :', url);

        const response = await fetch(url, {
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type':  'application/json',
                'Accept':        'application/json'
            }
        });

        console.log('Status :', response.status, '| Content-Type :', response.headers.get('Content-Type'));

        if (!response.ok) {
            const body = await response.text();
            console.error('Corps de la réponse :', body.substring(0, 300));
            if (response.status === 401 || response.status === 403) {
                throw new Error(`Accès refusé (${response.status}). Vérifiez les scopes vso.release / vso.work dans vss-extension.json.`);
            }
            throw new Error(`Erreur HTTP ${response.status}`);
        }

        // Si la réponse n'est pas du JSON (ex: redirect HTML → status 200 avec text/html)
        const ct = response.headers.get('Content-Type') || '';
        if (!ct.includes('application/json')) {
            const body = await response.text();
            throw new Error(`Réponse non-JSON reçue (${response.status}). Content-Type : ${ct}`);
        }

        return response.json();
    }

    // ─── Initialiser le projet ────────────────────────────────────────────────
    projectSelect.innerHTML = `<option value="${projectName}">${projectName}</option>`;
    loadReleases(projectName);

    // ─── Charger les releases ─────────────────────────────────────────────────
    async function loadReleases(project) {
        releaseSelect.disabled = true;
        releaseSelect.innerHTML = '<option value="">Chargement des releases...</option>';

        try {
            // L'API Release vit sur vsrm.dev.azure.com, PAS sur dev.azure.com
            // On construit l'URL VSRM à partir de l'orgUrl
            const orgName  = orgUrl.replace('https://dev.azure.com/', '').replace(/\/$/, '');
            const vsrmBase = `https://vsrm.dev.azure.com/${orgName}/`;
            const url      = `${vsrmBase}${encodeURIComponent(project)}/_apis/release/releases?api-version=7.0&$top=20`;

            const data     = await apiFetch(url);
            const releases = data.value || [];
            console.log('Releases trouvées :', releases.length);

            releaseSelect.innerHTML = releases.length
                ? '<option value="">Sélectionnez une release</option>'
                : '<option value="">Aucune release trouvée</option>';

            releases.forEach(function (release) {
                const opt      = document.createElement('option');
                opt.value      = release.id;
                opt.textContent = release.name;
                releaseSelect.appendChild(opt);
            });

            if (releases.length) releaseSelect.disabled = false;

        } catch (err) {
            console.error('Erreur loadReleases :', err);
            releaseSelect.innerHTML = `<option value="">Erreur : ${err.message}</option>`;
        }
    }

    // ─── Charger les tickets ──────────────────────────────────────────────────
    async function loadTickets(releaseId, project) {
        showLoading(true);
        try {
            const orgName  = orgUrl.replace('https://dev.azure.com/', '').replace(/\/$/, '');
            const vsrmBase = `https://vsrm.dev.azure.com/${orgName}/`;

            // 1. Récupérer les work items liés à la release
            const wiData = await apiFetch(
                `${vsrmBase}${encodeURIComponent(project)}/_apis/release/releases/${releaseId}/workitems?api-version=7.0`
            );
            const workItemRefs = wiData.value || [];
            console.log('Work items refs :', workItemRefs.length);

            if (workItemRefs.length === 0) {
                currentWorkItems = [];
                displayTickets([]);
                ticketsCard.style.display = 'block';
                showLoading(false);
                return;
            }

            // 2. Récupérer les détails de chaque work item (API WIT sur dev.azure.com)
            const cleanOrg = orgUrl.endsWith('/') ? orgUrl : orgUrl + '/';
            const details  = await Promise.all(
                workItemRefs.map(function (ref) {
                    return apiFetch(
                        `${cleanOrg}${encodeURIComponent(project)}/_apis/wit/workitems/${ref.id}?api-version=7.0`
                    ).then(function (detail) {
                        return {
                            id:    ref.id,
                            title: detail.fields['System.Title'],
                            type:  detail.fields['System.WorkItemType'],
                            state: detail.fields['System.State']
                        };
                    });
                })
            );

            currentWorkItems = details;
            displayTickets(details);
            ticketsCard.style.display = 'block';

        } catch (err) {
            console.error('Erreur loadTickets :', err);
            alert('Erreur chargement tickets : ' + err.message);
        } finally {
            showLoading(false);
        }
    }

    // ─── Afficher les tickets ─────────────────────────────────────────────────
    function displayTickets(workItems) {
        const list = document.getElementById('ticketsList');
        list.innerHTML = '';

        if (workItems.length === 0) {
            list.innerHTML = '<p style="color:#888;padding:10px;">Aucun ticket trouvé pour cette release.</p>';
            return;
        }

        workItems.forEach(function (wi) {
            const div       = document.createElement('div');
            div.className   = 'ticket-item';
            div.innerHTML   =
                '<span class="ticket-type ' + getTypeClass(wi.type) + '">' + wi.type + '</span>' +
                '<span class="ticket-id">#' + wi.id + '</span>' +
                '<span class="ticket-title">' + wi.title + '</span>';
            list.appendChild(div);
        });

        generateBtn.disabled = false;
    }

    // ─── Générer les Release Notes via OpenAI ────────────────────────────────
    async function generateReleaseNotes() {
        showLoading(true);
        const releaseName = releaseSelect.options[releaseSelect.selectedIndex].text;
        const prompt      = buildPrompt(currentWorkItems, releaseName);

        try {
            const content = await callOpenAI(prompt);
            document.getElementById('releaseName').textContent    = releaseName;
            document.getElementById('releaseNotesContent').innerHTML = marked.parse(content);
            releaseNotesCard.style.display = 'block';
        } catch (err) {
            console.error('Erreur OpenAI :', err);
            alert('Erreur génération. Vérifiez la clé API OpenAI.\n' + err.message);
        } finally {
            showLoading(false);
        }
    }

    // ─── Prompt ──────────────────────────────────────────────────────────────
    function buildPrompt(workItems, releaseName) {
        const list = workItems.map(function (wi) {
            return '- [' + wi.type + '] #' + wi.id + ' : ' + wi.title;
        }).join('\n');

        return [
            'Tu es un expert en communication technique orientée client.',
            'Réponds uniquement en français.\n',
            'Voici les tickets fermés dans la release "' + releaseName + '" :',
            list,
            '\nGénère une Release Note professionnelle avec :',
            '1. Un résumé global en 2-3 phrases orienté client',
            '2. Tickets catégorisés : 🆕 Nouvelles Fonctionnalités, 🐛 Bugs, ⚙️ Améliorations',
            '3. Pour chaque ticket : #ID et description courte',
            'Format : Markdown'
        ].join('\n');
    }

    // ─── Appel OpenAI ────────────────────────────────────────────────────────
    async function callOpenAI(prompt) {
        // ⚠️ Remplacez par votre vraie clé ou chargez-la depuis les settings de l'extension
        const apiKey = 'VOTRE_CLE_OPENAI_ICI';

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type':  'application/json'
            },
            body: JSON.stringify({
                model:       'gpt-4o-mini',
                messages:    [
                    { role: 'system', content: 'Tu es expert en Release Notes professionnelles.' },
                    { role: 'user',   content: prompt }
                ],
                max_tokens:  1000,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error('OpenAI HTTP ' + response.status);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    // ─── Marquer Done ────────────────────────────────────────────────────────
    function markAsDone() {
        const badge     = document.getElementById('statusBadge');
        badge.textContent = '✅ Done';
        badge.className = 'badge badge-done';
        markDoneBtn.disabled = true;
        exportBtn.disabled   = false;
    }

    // ─── Utilitaires ─────────────────────────────────────────────────────────
    function getTypeClass(type) {
        const types = {
            'Bug':        'type-bug',
            'Feature':    'type-feature',
            'User Story': 'type-userstory',
            'Task':       'type-task'
        };
        return types[type] || 'type-task';
    }

    function showLoading(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    // ─── Events ──────────────────────────────────────────────────────────────
    releaseSelect.addEventListener('change', function () {
        loadTicketsBtn.disabled = !this.value;
    });

    loadTicketsBtn.addEventListener('click', function () {
        if (releaseSelect.value) {
            loadTickets(releaseSelect.value, projectName);
        }
    });

    generateBtn.addEventListener('click', generateReleaseNotes);
    markDoneBtn.addEventListener('click', markAsDone);
    exportBtn.addEventListener('click', function () {
        alert('Release Note prête à envoyer au client !');
    });

    VSS.notifyLoadSucceeded();
});