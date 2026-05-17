VSS.init({
    explicitNotifyLoaded: true,
    usePlatformStyles: true,
    usePlatformScripts: true
});

VSS.ready(function () {
    console.log('APP VERSION: 1.0.16 - auth via IAuthTokenManager');

    const webContext  = VSS.getWebContext();
    const projectName = webContext.project.name;
    const orgUrl      = webContext.account.uri;

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
    projectSelect.innerHTML = '<option value="' + projectName + '">' + projectName + '</option>';

    // Auth fiable via VSS/Authentication/Services
    // VSS.getAccessToken() retourne vide selon le contexte du hub.
    function getAuthHeader() {
        return new Promise(function (resolve, reject) {
            VSS.require(["VSS/Authentication/Services"], function (AuthServices) {
                var mgr = AuthServices.authTokenManager;
                mgr.getAuthToken().then(function (token) {
                    console.log('Token via AuthServices :', token ? 'OK' : 'VIDE');
                    var header = mgr.getAuthorizationHeader(token);
                    console.log('Header :', header ? header.substring(0, 30) + '...' : 'VIDE');
                    resolve(header);
                }, reject);
            });
        });
    }

    async function apiFetch(url) {
        const authHeader = await getAuthHeader();
        console.log('URL :', url);
        const response = await fetch(url, {
            headers: {
                'Authorization': authHeader,
                'Content-Type':  'application/json',
                'Accept':        'application/json'
            }
        });
        console.log('Status :', response.status, '| CT :', response.headers.get('Content-Type'));
        if (!response.ok) {
            const body = await response.text();
            console.error('Erreur body :', body.substring(0, 300));
            throw new Error('HTTP ' + response.status);
        }
        const ct = response.headers.get('Content-Type') || '';
        if (!ct.includes('application/json')) {
            const body = await response.text();
            console.error('Non-JSON :', body.substring(0, 300));
            throw new Error('Reponse non-JSON (' + response.status + ') CT: ' + ct);
        }
        return response.json();
    }

    async function loadReleases(project) {
        releaseSelect.disabled = true;
        releaseSelect.innerHTML = '<option value="">Chargement...</option>';
        try {
            const orgName = orgUrl.replace('https://dev.azure.com/', '').replace(/\/$/, '');
            const url = 'https://vsrm.dev.azure.com/' + orgName + '/' + encodeURIComponent(project) + '/_apis/release/releases?api-version=7.0&$top=20';
            const data = await apiFetch(url);
            const releases = data.value || [];
            console.log('Releases :', releases.length);
            releaseSelect.innerHTML = releases.length
                ? '<option value="">— Selectionnez une release —</option>'
                : '<option value="">Aucune release trouvee</option>';
            releases.forEach(function (r) {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.textContent = r.name;
                releaseSelect.appendChild(opt);
            });
            releaseSelect.disabled = releases.length === 0;
        } catch (err) {
            console.error('Erreur loadReleases :', err);
            releaseSelect.innerHTML = '<option value="">Erreur : ' + err.message + '</option>';
        }
    }

    async function loadTickets(releaseId, project) {
        showLoading(true);
        try {
            const orgName  = orgUrl.replace('https://dev.azure.com/', '').replace(/\/$/, '');
            const vsrmBase = 'https://vsrm.dev.azure.com/' + orgName + '/';
            const devBase  = orgUrl.endsWith('/') ? orgUrl : orgUrl + '/';
            const wiData   = await apiFetch(vsrmBase + encodeURIComponent(project) + '/_apis/release/releases/' + releaseId + '/workitems?api-version=7.0');
            const refs     = wiData.value || [];
            console.log('Work item refs :', refs.length);
            if (refs.length === 0) {
                currentWorkItems = [];
                displayTickets([]);
                ticketsCard.style.display = 'block';
                return;
            }
            const details = await Promise.all(refs.map(function (ref) {
                return apiFetch(devBase + encodeURIComponent(project) + '/_apis/wit/workitems/' + ref.id + '?api-version=7.0')
                    .then(function (d) {
                        return { id: ref.id, title: d.fields['System.Title'], type: d.fields['System.WorkItemType'], state: d.fields['System.State'] };
                    });
            }));
            currentWorkItems = details;
            displayTickets(details);
            ticketsCard.style.display = 'block';
        } catch (err) {
            console.error('Erreur loadTickets :', err);
            alert('Erreur tickets : ' + err.message);
        } finally {
            showLoading(false);
        }
    }

    function displayTickets(items) {
        const list = document.getElementById('ticketsList');
        list.innerHTML = '';
        if (items.length === 0) {
            list.innerHTML = '<p style="color:#888;padding:10px;">Aucun ticket trouve.</p>';
            generateBtn.disabled = true;
            return;
        }
        items.forEach(function (wi) {
            const div = document.createElement('div');
            div.className = 'ticket-item';
            div.innerHTML = '<span class="ticket-type ' + getTypeClass(wi.type) + '">' + wi.type + '</span><span class="ticket-id">#' + wi.id + '</span><span class="ticket-title">' + wi.title + '</span>';
            list.appendChild(div);
        });
        generateBtn.disabled = false;
    }

    async function generateReleaseNotes() {
        showLoading(true);
        const releaseName = releaseSelect.options[releaseSelect.selectedIndex].text;
        try {
            const content = await callOpenAI(buildPrompt(currentWorkItems, releaseName));
            document.getElementById('releaseName').textContent = releaseName;
            document.getElementById('releaseNotesContent').innerHTML = marked.parse(content);
            releaseNotesCard.style.display = 'block';
        } catch (err) {
            console.error('Erreur OpenAI :', err);
            alert('Erreur generation : ' + err.message);
        } finally {
            showLoading(false);
        }
    }

    function buildPrompt(items, releaseName) {
        const list = items.map(function(wi) { return '- [' + wi.type + '] #' + wi.id + ' : ' + wi.title; }).join('\n');
        return 'Tu es un expert en communication technique orientee client. Reponds uniquement en francais.\n\nVoici les tickets fermes dans la release "' + releaseName + '" :\n' + list + '\n\nGenere une Release Note professionnelle avec :\n1. Un resume global en 2-3 phrases oriente client\n2. Tickets categorises : Nouvelles Fonctionnalites, Bugs, Ameliorations\n3. Pour chaque ticket : #ID et description courte\nFormat : Markdown';
    }

    async function callOpenAI(prompt) {
        const apiKey = 'VOTRE_CLE_OPENAI_ICI';
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Tu es expert en Release Notes.' }, { role: 'user', content: prompt }], max_tokens: 1000, temperature: 0.3 })
        });
        if (!response.ok) throw new Error('OpenAI HTTP ' + response.status);
        const data = await response.json();
        return data.choices[0].message.content;
    }

    function markAsDone() {
        const badge = document.getElementById('statusBadge');
        badge.textContent = 'Done';
        badge.className = 'badge badge-done';
        markDoneBtn.disabled = true;
        exportBtn.disabled = false;
    }

    function getTypeClass(type) {
        return { 'Bug': 'type-bug', 'Feature': 'type-feature', 'User Story': 'type-userstory', 'Task': 'type-task' }[type] || 'type-task';
    }

    function showLoading(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    releaseSelect.addEventListener('change', function () { loadTicketsBtn.disabled = !this.value; });
    loadTicketsBtn.addEventListener('click', function () { if (releaseSelect.value) loadTickets(releaseSelect.value, projectName); });
    generateBtn.addEventListener('click', generateReleaseNotes);
    markDoneBtn.addEventListener('click', markAsDone);
    exportBtn.addEventListener('click', function () { alert('Release Note prete !'); });

    loadReleases(projectName);
    VSS.notifyLoadSucceeded();
});