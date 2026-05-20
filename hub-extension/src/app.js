import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds } from 'azure-devops-extension-api';

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
            const accessToken = await SDK.getAccessToken();
            const extDataService = await SDK.getService(CommonServiceIds.ExtensionDataService);
            const dataManager = await extDataService.getExtensionDataManager(
                SDK.getExtensionContext().id,
                accessToken
            );

            const docs = await dataManager.getDocuments('release-notes');
            console.log('Release Notes trouvées:', docs.length);
            showLoading(false);
            displayNotesList(docs);
        } catch(err) {
            console.error('Erreur chargement:', err);
            showLoading(false);
            document.getElementById('notesList').innerHTML =
                '<p style="color:red;">Erreur: ' + err.message + '</p>';
        }
    }

    function displayNotesList(notes) {
        const container = document.getElementById('notesList');
        container.innerHTML = '';

        if (!notes || notes.length === 0) {
            container.innerHTML = '<p style="color:#888;padding:20px;">Aucune Release Note générée pour le moment.</p>';
            return;
        }

        notes.sort((a, b) => new Date(b.dateGeneration) - new Date(a.dateGeneration));

        notes.forEach(note => {
            const div = document.createElement('div');
            div.className = 'note-card';
            div.innerHTML =
                '<div class="note-header">' +
                    '<span class="note-title">' + note.releaseName + '</span>' +
                    '<span class="note-project">' + note.project + '</span>' +
                    '<span class="badge ' + (note.statut === 'Active' ? 'badge-active' : 'badge-done') + '">' +
                        (note.statut === 'Active' ? '🟡 Active' : '✅ Done') +
                    '</span>' +
                    '<span class="note-date">' + new Date(note.dateGeneration).toLocaleDateString('fr-FR') + '</span>' +
                '</div>' +
                '<div class="note-tickets">Tickets : ' + (note.workItems ? note.workItems.length : 0) + '</div>' +
                '<button class="btn-primary view-btn" data-id="' + note.id + '">Voir & Valider</button>';
            container.appendChild(div);
        });

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => viewNote(btn.dataset.id, notes));
        });
    }

    async function viewNote(noteId, notes) {
        const note = notes.find(n => n.id === noteId);
        if (!note) return;
        displayNoteDetail(note);
    }

    function displayNoteDetail(note) {
        document.getElementById('listCard').style.display = 'none';
        releaseNotesCard.style.display = 'block';

        document.getElementById('releaseName').textContent = note.releaseName;

        const badge = document.getElementById('statusBadge');
        badge.textContent = note.statut === 'Active' ? '🟡 Active' : '✅ Done';
        badge.className = 'badge ' + (note.statut === 'Active' ? 'badge-active' : 'badge-done');

        document.getElementById('releaseNotesContent').innerHTML =
            window.marked ? window.marked.parse(note.contenuMarkdown || '') : note.contenuMarkdown;

        if (note.statut === 'Active') {
            markDoneBtn.disabled = false;
            markDoneBtn.onclick = () => markAsDone(note);
            exportBtn.disabled = true;
        } else {
            markDoneBtn.disabled = true;
            exportBtn.disabled = false;
        }
    }

    async function markAsDone(note) {
        try {
            const accessToken = await SDK.getAccessToken();
            const extDataService = await SDK.getService(CommonServiceIds.ExtensionDataService);
            const dataManager = await extDataService.getExtensionDataManager(
                SDK.getExtensionContext().id,
                accessToken
            );

            note.statut = 'Done';
            await dataManager.updateDocument('release-notes', note);

            const badge = document.getElementById('statusBadge');
            badge.textContent = '✅ Done';
            badge.className = 'badge badge-done';
            markDoneBtn.disabled = true;
            exportBtn.disabled = false;
            console.log('✅ Statut mis à jour : Done');
        } catch(err) {
            console.error('Erreur mise à jour:', err);
        }
    }

    window.backToList = function() {
        releaseNotesCard.style.display = 'none';
        document.getElementById('listCard').style.display = 'block';
        loadReleaseNotes();
    };

    await loadReleaseNotes();
    SDK.notifyLoadSucceeded();
});