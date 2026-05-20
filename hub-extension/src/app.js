import * as SDK from 'azure-devops-extension-sdk';
import { getClient } from 'azure-devops-extension-api';
import { WikiRestClient } from 'azure-devops-extension-api/Wiki';

SDK.init({ loaded: false });

SDK.ready().then(async () => {

    const loadingOverlay = document.getElementById('loadingOverlay');
    const releaseNotesCard = document.getElementById('releaseNotesCard');
    const markDoneBtn = document.getElementById('markDoneBtn');
    const exportBtn = document.getElementById('exportBtn');

    function showLoading(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    async function loadReleaseNotes() {
        showLoading(true);
        try {
            const context = SDK.getWebContext();
            const projectName = context.project.name;
            const wikiId = `${projectName}.wiki`;
            const wikiClient = getClient(WikiRestClient);

            // getPagesBatch pour lister les sous-pages de /Releases
            const batchResult = await wikiClient.getPagesBatch(
                { top: 100 },
                projectName,
                wikiId
            );

            // Filtrer les pages sous /Releases/
            const releasePages = (batchResult || []).filter(p =>
                p.path && p.path.startsWith('/Releases/') &&
                p.path.split('/').length === 3
            );

            console.log('Release pages trouvées:', releasePages.length);
            showLoading(false);
            displayNotesList(releasePages, projectName, wikiId);
        } catch(err) {
            console.error('Erreur chargement:', err);
            showLoading(false);
            document.getElementById('notesList').innerHTML =
                '<p style="color:red;">Erreur: ' + err.message + '</p>';
        }
    }

    function displayNotesList(pages, projectName, wikiId) {
        const container = document.getElementById('notesList');
        container.innerHTML = '';

        if (!pages || pages.length === 0) {
            container.innerHTML = '<p style="color:#888;padding:20px;">Aucune Release Note générée pour le moment.</p>';
            return;
        }

        pages.sort((a, b) => b.path.localeCompare(a.path));

        pages.forEach(page => {
            const releaseName = page.path.replace('/Releases/', '');
            const div = document.createElement('div');
            div.className = 'note-card';
            div.innerHTML =
                '<div class="note-header">' +
                    '<span class="note-title">' + releaseName + '</span>' +
                    '<span class="badge badge-active">🟡 Active</span>' +
                '</div>' +
                '<button class="btn-primary view-btn" data-path="' + page.path + '" data-project="' + projectName + '" data-wiki="' + wikiId + '">Voir & Valider</button>';
            container.appendChild(div);
        });

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () =>
                viewNote(btn.dataset.path, btn.dataset.project, btn.dataset.wiki)
            );
        });
    }

    async function viewNote(path, projectName, wikiId) {
        showLoading(true);
        try {
            const wikiClient = getClient(WikiRestClient);

            // getPageText retourne le contenu Markdown directement
            const content = await wikiClient.getPageText(
                projectName,
                wikiId,
                path,
                undefined,
                undefined,
                true
            );

            showLoading(false);
            displayNoteDetail(path, content);
        } catch(err) {
            console.error('Erreur lecture page:', err);
            showLoading(false);
        }
    }

    function displayNoteDetail(path, content) {
        document.getElementById('listCard').style.display = 'none';
        releaseNotesCard.style.display = 'block';

        const releaseName = path.replace('/Releases/', '');
        document.getElementById('releaseName').textContent = releaseName;
        document.getElementById('releaseNotesContent').innerHTML =
            window.marked ? window.marked.parse(content) : content;

        markDoneBtn.disabled = false;
        exportBtn.disabled = true;
    }

    window.backToList = function() {
        releaseNotesCard.style.display = 'none';
        document.getElementById('listCard').style.display = 'block';
        loadReleaseNotes();
    };

    await loadReleaseNotes();
    SDK.notifyLoadSucceeded();
});