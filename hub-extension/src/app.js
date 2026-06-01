/**
 * app.js — Smart Release Notes Generator (Hub Extension)
 *
 * Édition par section (crayon ✏️ sur Résumé, Fonctionnalités, Bugs, Améliorations)
 * Feedback implicite : éditer → editCount++, régénérer → regenerationCount++,
 *                      Marquer Done → feedbackScore
 *
 * Correctif __etag : updateDocument renvoie un nouveau jeton de version ;
 * on l'applique localement pour éviter les conflits sur les updates suivants.
 */

import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds } from 'azure-devops-extension-api';

SDK.init({ loaded: false });

SDK.ready().then(async () => {

    const $ = id => document.getElementById(id);

    let allNotes     = [];
    let currentNote  = null;
    let previousView = 'home';
    let projectName  = '';
    let dataManager  = null;
    let noteToSend   = null;
    let editingIdx   = null;   // index de la section en cours d'édition

    const views = {
        home   : $('viewHome'),
        active : $('viewActive'),
        done   : $('viewDone'),
        detail : $('viewDetail')
    };

    function showLoading(show) {
        const ov = $('loadingOverlay');
        if (ov) ov.classList.toggle('hidden', !show);
    }

    // ── Sauvegarde avec gestion du jeton de version (__etag) ─────
    async function persist(note) {
        const updated = await dataManager.updateDocument(`release-notes-${projectName}`, note);
        // Appliquer le nouveau jeton localement pour les updates suivants
        if (updated && updated.__etag !== undefined) {
            note.__etag = updated.__etag;
        }
        return updated;
    }

    // ─── Démarrage protégé ───────────────────────────────────────
    try {
        const accessToken    = await SDK.getAccessToken();
        const extDataService = await SDK.getService(CommonServiceIds.ExtensionDataService);
        dataManager = await extDataService.getExtensionDataManager(
            SDK.getExtensionContext().id, accessToken
        );
        projectName = SDK.getWebContext().project.name;
        if ($('projectName')) $('projectName').textContent = projectName;

        bindEvents();
        await loadNotes();
        showView('home');
    } catch (err) {
        console.error('❌ Erreur démarrage Hub:', err);
        showLoading(false);
        const app = $('app');
        if (app) {
            const e = document.createElement('div');
            e.style.cssText = 'padding:24px;color:#a4262c;background:#fce8e8;border-radius:8px;margin-top:16px;';
            e.textContent = 'Erreur de chargement : ' + (err.message || err);
            app.appendChild(e);
        }
    } finally {
        SDK.notifyLoadSucceeded();
    }

    // ═════════════════════════════════════════════════════════════

    async function loadNotes() {
        showLoading(true);
        try {
            const docs = await dataManager.getDocuments(`release-notes-${projectName}`);
            allNotes = docs || [];
            allNotes.sort((a, b) => new Date(b.dateGeneration) - new Date(a.dateGeneration));
        } catch (err) {
            console.error('Erreur chargement notes:', err);
            allNotes = [];
        }
        renderCounts();
        renderLastGen();
        showLoading(false);
    }

    function countByType(note) {
        const items = note.workItems || [];
        return {
            bugs    : items.filter(w => w.type === 'Bug').length,
            features: items.filter(w => w.type === 'Feature' || w.type === 'User Story').length,
            tasks   : items.filter(w => w.type === 'Task').length
        };
    }

    function formatDate(iso) {
        return iso ? new Date(iso).toLocaleDateString('fr-FR') : '';
    }

    function renderCounts() {
        const active = allNotes.filter(n => n.statut === 'Active');
        const done   = allNotes.filter(n => n.statut === 'Done');
        if ($('homeActiveCount')) $('homeActiveCount').textContent = active.length;
        if ($('homeDoneCount'))   $('homeDoneCount').textContent   = done.length;
        if ($('activeListCount')) $('activeListCount').textContent = active.length;
        if ($('doneListCount'))   $('doneListCount').textContent   = done.length;
    }

    function renderLastGen() {
        if (!$('lastGenText')) return;
        if (allNotes.length === 0) {
            $('lastGenText').textContent = 'Aucune génération récente';
            return;
        }
        const last = allNotes[0];
        const time = new Date(last.dateGeneration)
            .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        $('lastGenText').textContent =
            `Dernière génération automatique : ${last.releaseName} — ${formatDate(last.dateGeneration)} à ${time}`;
    }

    function renderRow(note, actionLabel, actionClass, onAction) {
        const c = countByType(note);
        const statusClass = note.statut === 'Active' ? 'badge--active' : 'badge--done';
        const row = document.createElement('div');
        row.className = 'release-row';
        row.innerHTML = `
            <div class="release-info">
                <div class="release-name-line">
                    <span class="release-name">${note.releaseName}</span>
                    <span class="badge ${statusClass}">${note.statut}</span>
                </div>
                <div class="release-date">${formatDate(note.dateGeneration)} · ${note.project || projectName}</div>
                <div class="release-badges">
                    <span class="tag tag--bug">${c.bugs} bugs</span>
                    <span class="tag tag--feat">${c.features} features</span>
                    <span class="tag tag--task">${c.tasks} tasks</span>
                </div>
            </div>
            <button class="btn ${actionClass}">${actionLabel}</button>`;
        row.querySelector('button').addEventListener('click', () => onAction(note));
        return row;
    }

    function renderActiveList() {
        const c = $('activeList');
        c.innerHTML = '';
        const active = allNotes.filter(n => n.statut === 'Active');
        if (!active.length) {
            c.innerHTML = '<p style="padding:24px;color:#888;">Aucune release en attente de validation.</p>';
            return;
        }
        active.forEach(n => c.appendChild(renderRow(n, 'Valider', 'btn-outline', x => openDetail(x, 'active'))));
    }

    function renderDoneList() {
        const c = $('doneList');
        c.innerHTML = '';
        const done = allNotes.filter(n => n.statut === 'Done');
        if (!done.length) {
            c.innerHTML = '<p style="padding:24px;color:#888;">Aucune release publiée.</p>';
            return;
        }
        done.forEach(n => c.appendChild(renderRow(n, '📤 Envoyer au client', 'btn-blue', x => openConfirm(x))));
    }

    // ═══════════ DÉTAIL & ÉDITION PAR SECTION ════════════════════

    /**
     * Découpe le Markdown en : header (h1 + table métadonnées) + sections (## ...).
     * Une section est éditable si elle ne contient PAS de tableau (la section
     * métadonnées contient le tableau Version/Date/... et reste non-éditable).
     */
    function parseMarkdown(md) {
        md = md || '';
        const firstH2 = md.indexOf('\n## ');
        let header = md;
        let rest = '';
        if (firstH2 >= 0) {
            header = md.slice(0, firstH2).trim();
            rest   = md.slice(firstH2 + 1);
        }
        const blocks = rest.split(/\n(?=## )/).filter(b => b.trim());
        const sections = blocks.map(block => {
            const m = block.match(/^## (.+?)\n([\s\S]*)$/);
            if (m) return { title: m[1].trim(), body: m[2].trim() };
            const t = block.replace(/^## /, '').trim();
            return { title: t, body: '' };
        });
        return { header, sections };
    }

    function isEditable(section) {
        // La section métadonnées contient un tableau Markdown
        return !/\|.*\|/.test(section.body);
    }

    function reassemble(header, sections) {
        let md = header.trim() + '\n\n';
        md += sections.map(s => `## ${s.title}\n${s.body}`).join('\n\n');
        return md;
    }

    let parsed = { header: '', sections: [] };

    function openDetail(note, fromView) {
        currentNote  = note;
        previousView = fromView;
        editingIdx   = null;

        $('detailTitle').textContent = note.releaseName;
        const sb = $('detailStatus');
        sb.textContent = note.statut;
        sb.className = 'badge ' + (note.statut === 'Active' ? 'badge--active' : 'badge--done');

        parsed = parseMarkdown(note.contenuMarkdown);
        renderSections();

        $('doneSuccess').classList.add('hidden');
        $('regenBar').classList.add('hidden');

        const isActive = note.statut === 'Active';
        $('markDoneBtn').disabled = !isActive;
        $('regenBtn').disabled    = !isActive;

        showView('detail');
    }

    function renderSections() {
        const container = $('detailSections');
        container.innerHTML = '';
        const isActive = currentNote.statut === 'Active';

        // Header (h1 + métadonnées) — non éditable
        const headerDiv = document.createElement('div');
        headerDiv.className = 'markdown-body';
        headerDiv.innerHTML = window.marked ? window.marked.parse(parsed.header) : parsed.header;
        container.appendChild(headerDiv);

        // Sections
        parsed.sections.forEach((section, idx) => {
            const editable = isEditable(section);

            if (!editable) {
                const div = document.createElement('div');
                div.className = 'markdown-body';
                div.innerHTML = window.marked
                    ? window.marked.parse('## ' + section.title + '\n' + section.body)
                    : section.body;
                container.appendChild(div);
                return;
            }

            const sec = document.createElement('div');
            sec.className = 'detail-section';

            if (editingIdx === idx) {
                // Mode édition de cette section
                sec.innerHTML = `
                    <div class="section-header">
                        <span class="section-title">${section.title}</span>
                    </div>
                    <textarea class="section-textarea">${section.body.replace(/</g, '&lt;')}</textarea>
                    <div class="section-edit-actions">
                        <button class="btn btn-outline section-cancel">Annuler</button>
                        <button class="btn btn-blue section-save">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                            Enregistrer
                        </button>
                    </div>`;
                sec.querySelector('.section-cancel').addEventListener('click', () => {
                    editingIdx = null; renderSections();
                });
                sec.querySelector('.section-save').addEventListener('click', () => {
                    const val = sec.querySelector('.section-textarea').value;
                    saveSection(idx, val);
                });
            } else {
                // Mode lecture avec crayon
                sec.innerHTML = `
                    <div class="section-header">
                        <span class="section-title">${section.title}</span>
                        <button class="pencil-btn" title="Modifier cette section" ${isActive ? '' : 'disabled'}>
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                        </button>
                    </div>
                    <div class="section-body markdown-body">${window.marked ? window.marked.parse(section.body) : section.body}</div>`;
                const pencil = sec.querySelector('.pencil-btn');
                if (pencil && isActive) {
                    pencil.addEventListener('click', () => { editingIdx = idx; renderSections(); });
                }
            }
            container.appendChild(sec);
        });
    }

    // SAVE section : feedback négatif modéré (édition)
    async function saveSection(idx, newBody) {
        parsed.sections[idx].body = newBody.trim();
        currentNote.contenuMarkdown = reassemble(parsed.header, parsed.sections);
        currentNote.editCount = (currentNote.editCount || 0) + 1;
        try {
            await persist(currentNote);
            console.log(`📝 Feedback édition section "${parsed.sections[idx].title}" — total: ${currentNote.editCount}`);
        } catch (err) {
            console.error('Erreur sauvegarde section:', err);
        }
        editingIdx = null;
        renderSections();
    }

    // REGENERATE : feedback négatif fort
    async function regenerate() {
        currentNote.regenerationCount = (currentNote.regenerationCount || 0) + 1;
        try {
            await persist(currentNote);
            console.log(`📉 Feedback régénération — total: ${currentNote.regenerationCount}`);
        } catch (err) {
            console.error('Erreur tracking régénération:', err);
        }
        $('regenBar').classList.remove('hidden');
        // NOTE : brancher ici la régénération réelle via pipeline/API
        setTimeout(() => $('regenBar').classList.add('hidden'), 3000);
    }

    // MARK DONE : calcul feedbackScore (avec correctif __etag via persist)
    async function markDone() {
        const edits  = currentNote.editCount || 0;
        const regens = currentNote.regenerationCount || 0;
        currentNote.feedbackScore = 1 / (1 + edits * 0.3 + regens * 0.6);
        currentNote.statut        = 'Done';
        currentNote.doneCount      = (currentNote.doneCount || 0) + 1;
        currentNote.feedbackDate  = new Date().toISOString();

        try {
            await persist(currentNote);
            console.log(`✅ Done — FeedbackScore: ${currentNote.feedbackScore.toFixed(3)} (${edits} édits, ${regens} régén)`);
        } catch (err) {
            console.error('Erreur Marquer Done:', err);
            // Rollback local en cas d'échec
            currentNote.statut = 'Active';
            return;
        }

        const sb = $('detailStatus');
        sb.textContent = 'Done';
        sb.className = 'badge badge--done';
        $('markDoneBtn').disabled = true;
        $('regenBtn').disabled    = true;

        $('doneSuccessText').textContent =
            `${currentNote.releaseName} marquée comme Done — prête à envoyer au client.`;
        $('doneSuccess').classList.remove('hidden');
        renderSections();  // retire les crayons (note devient non-éditable)
        renderCounts();
    }

    // ═══════════ ENVOI CLIENT (saisie email manuelle) ════════════
    function openConfirm(note) {
        noteToSend = note;
        $('confirmName').textContent = note.releaseName;
        $('clientEmail').value = '';
        $('emailError').classList.add('hidden');
        $('confirmModal').classList.remove('hidden');
        $('clientEmail').focus();
    }
    function closeConfirm() {
        $('confirmModal').classList.add('hidden');
        noteToSend = null;
    }
    function confirmSend() {
        const email = $('clientEmail').value.trim();
        const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        if (!valid) {
            $('emailError').classList.remove('hidden');
            return;
        }
        const name = noteToSend.releaseName;
        closeConfirm();
        // NOTE : brancher ici l'envoi email réel (phase 2) vers `email`
        $('sendSuccessText').textContent = `${name} envoyée à ${email} avec succès.`;
        $('sendSuccess').classList.remove('hidden');
        setTimeout(() => $('sendSuccess').classList.add('hidden'), 4000);
    }

    // ═══════════ NAVIGATION ══════════════════════════════════════
    function showView(name) {
        Object.values(views).forEach(v => v && v.classList.add('hidden'));
        if (views[name]) views[name].classList.remove('hidden');
        if (name === 'active') renderActiveList();
        if (name === 'done')   renderDoneList();
    }
    function goBackFromDetail() {
        showView(previousView === 'done' ? 'done' : 'active');
        loadNotes();
    }

    function bindEvents() {
        $('cardActive').addEventListener('click', () => showView('active'));
        $('cardDone').addEventListener('click',   () => showView('done'));
        document.querySelectorAll('[data-nav]').forEach(btn => {
            btn.addEventListener('click', () => {
                const nav = btn.dataset.nav;
                if (nav === 'back') goBackFromDetail();
                else showView(nav);
            });
        });
        $('regenBtn').addEventListener('click', regenerate);
        $('markDoneBtn').addEventListener('click', markDone);
        $('confirmCancel').addEventListener('click', closeConfirm);
        $('confirmSend').addEventListener('click', confirmSend);
    }

});