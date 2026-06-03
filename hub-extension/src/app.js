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
    const collection = `release-notes-${projectName}`;
    try {
        const updated = await dataManager.updateDocument(collection, note);
        if (updated && updated.__etag !== undefined) note.__etag = updated.__etag;
        return updated;
    } catch (err) {
        // Conflit de version (etag périmé) → resynchroniser et réessayer une fois
        const isConflict =
            err.status === 409 || err.status === 412 ||
            /etag|conflict|sequence|version/i.test(err.message || '');

        if (isConflict) {
            console.warn('⚠️ Conflit etag — resynchronisation et nouvelle tentative...');
            const fresh = await dataManager.getDocument(collection, note.id);
            note.__etag = fresh.__etag;                  // etag frais du serveur
            const updated = await dataManager.updateDocument(collection, note);
            if (updated && updated.__etag !== undefined) note.__etag = updated.__etag;
            return updated;
        }
        throw err;   // autre erreur → on la remonte
    }
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
        const rowClass = note.statut === 'Active'
            ? 'release-row release-row--active'
            : note.sentToClient
                ? 'release-row release-row--done-sent'
                : 'release-row release-row--done';
        row.className = rowClass;
        row.innerHTML = `
            <div class="release-info">
                <div class="release-name-line">
                    <span class="release-name">${note.releaseName}</span>
                    <span class="badge ${statusClass}">${note.statut}</span>
                </div>
                <div class="release-date">${formatDate(note.dateGeneration)}</div>
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
                // Mode lecture avec crayon (hidden on hover)
                sec.classList.add('detail-section-readable');
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
    const sectionTitle = parsed.sections[idx].title;
    parsed.sections[idx].body = newBody.trim();
    currentNote.contenuMarkdown = reassemble(parsed.header, parsed.sections);
    currentNote.editCount = (currentNote.editCount || 0) + 1;

    // Option B : tracking par section (alimente le dashboard analytics)
    currentNote.sectionEdits = currentNote.sectionEdits || {};
    currentNote.sectionEdits[sectionTitle] = (currentNote.sectionEdits[sectionTitle] || 0) + 1;

    try {
        await persist(currentNote);
        console.log(`📝 Feedback édition "${sectionTitle}" — section: ${currentNote.sectionEdits[sectionTitle]}× | total: ${currentNote.editCount}`);
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
        // Update button text with regeneration count
        const count = currentNote.regenerationCount || 0;
        $('regenBtn').innerHTML = `
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Régénérer via IA (${count})`;
        $('regenBar').classList.remove('hidden');
        // NOTE : brancher ici la régénération réelle via pipeline/API
        setTimeout(() => $('regenBar').classList.add('hidden'), 3000);
    }

    async function markDone() {
        const edits  = currentNote.editCount || 0;
        const regens = currentNote.regenerationCount || 0;
        currentNote.feedbackScore = 1 / (1 + edits * 0.3 + regens * 0.6);
        currentNote.statut        = 'Done';
        currentNote.doneCount     = (currentNote.doneCount || 0) + 1;
        currentNote.feedbackDate  = new Date().toISOString();

        const btn = $('markDoneBtn');
        const originalLabel = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = 'Validation…'; }

        try {
            await persist(currentNote);
            console.log(`✅ Done — FeedbackScore: ${currentNote.feedbackScore.toFixed(3)} (${edits} édits, ${regens} régén)`);
        } catch (err) {
            console.error('Erreur Marquer Done:', err);
            currentNote.statut = 'Active';                 // rollback
            if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
            return;
        }

        // Statut → Done
        const sb = $('detailStatus');
        if (sb) { sb.textContent = 'Done'; sb.className = 'badge badge--done'; }

        // Le bouton devient un état "validée" lisible
        if (btn) btn.innerHTML = '✓ Validée';
        if ($('regenBtn')) $('regenBtn').disabled = true;

        // Confirmation CLAIRE et PERSISTANTE (ne disparaît plus)
        if ($('doneSuccessText')) {
            $('doneSuccessText').textContent =
                `${currentNote.releaseName} a été validée et placée dans « Publiées ». ` +
                `Vous pouvez maintenant l'envoyer au client depuis la liste « Publiées ».`;
        }
        if ($('doneSuccess')) $('doneSuccess').classList.remove('hidden');

        renderSections();
        renderCounts();

        // ⬇️ PLUS de setTimeout : l'utilisateur lit la confirmation et revient
        //     à la liste quand il veut via « ← Retour ». Pas de fermeture brutale.
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
   console.log("Entrée confirmSend");
    //a remplacer la cle fonction 
   const AZURE_FUNCTION_URL =  'https://release-notes-app-ggdkgqacdwcyave4.francecentral-01.azurewebsites.net/api/sendReleaseNote';
   async function confirmSend() {
    const email = $('clientEmail').value.trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!valid) {
        $('emailError').classList.remove('hidden');
        return;
    }
 
    const sendBtn = $('confirmSend');
    const original = sendBtn.innerHTML;
    sendBtn.disabled = true;
    sendBtn.innerHTML = 'Envoi en cours...';
    console.log("AZURE_FUNCTION_URL =", AZURE_FUNCTION_URL);
    console.log("noteToSend =", noteToSend);
    console.log("projectName =", projectName); 
    try {

        console.log("Début envoi");
        const response = await fetch(AZURE_FUNCTION_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({
                releaseName : noteToSend.releaseName,
                project     : noteToSend.project || projectName,
                companyName : projectName,   
                markdown    : noteToSend.contenuMarkdown,
                clientEmail : email
            })
        });
 
        const result = await response.json();
 
        if (result.success) {
            closeConfirm();
            $('sendSuccessText').textContent = `${noteToSend.releaseName} envoyée à ${email} avec succès.`;
            $('sendSuccess').classList.remove('hidden');
            setTimeout(() => $('sendSuccess').classList.add('hidden'), 4000);
        } else {
            $('emailError').textContent = 'Erreur lors de l\'envoi : ' + (result.error || 'inconnue');
            $('emailError').classList.remove('hidden');
        }
 
    } catch (err) {
        console.error('Erreur appel Azure Function:', err);
        $('emailError').textContent = 'Impossible de contacter le service d\'envoi.';
        $('emailError').classList.remove('hidden');
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = original;
    }
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
    
    // ═══════════════════════════════════════════════════════════════
    // // DASHBOARD ANALYTIQUE — Smart Release Notes Generator
    // // À ajouter dans app.js. Exploite les données déjà stockées.
    // // ═══════════════════════════════════════════════════════════════

    // // Charge toutes les notes puis rend le dashboard.
    // async function loadDashboard() {
    //     const container = $('dashboardContent');
    //     if (container) container.innerHTML = '<div class="dash-empty">Chargement des analytics…</div>';
    //     try {
    //         // Adapte si besoin au nom exact de ta méthode de récupération de tous les docs
    //         const notes = await dataManager.getDocuments(`release-notes-${projectName}`);
    //         renderDashboard(Array.isArray(notes) ? notes : []);
    //     } catch (err) {
    //         console.error('Erreur dashboard:', err);
    //         if (container) container.innerHTML = '<div class="dash-empty">Impossible de charger les données.</div>';
    //     }
    // }

    // // Agrège les métriques à partir des notes.
    // function computeDashboard(notes) {
    //     const safe      = Array.isArray(notes) ? notes : [];
    //     const total     = safe.length;
    //     const active    = safe.filter(n => n.statut === 'Active').length;
    //     const done      = safe.filter(n => n.statut === 'Done').length;
    //     const doneNotes = safe.filter(n => n.statut === 'Done');

    //     const mean = (arr, f) => {
    //         const vals = arr.map(f).filter(v => typeof v === 'number' && !isNaN(v));
    //         return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    //     };

    //     const avgFeedback = mean(doneNotes, n => n.feedbackScore);
    //     const avgEdits    = mean(doneNotes, n => n.editCount);
    //     const avgRegens   = mean(doneNotes, n => n.regenerationCount);

    //     // Distribution de la qualité du 1er jet de l'IA (feedbackScore)
    //     const quality = { high: 0, mid: 0, low: 0 };
    //     doneNotes.forEach(n => {
    //         const s = n.feedbackScore;
    //         if (typeof s !== 'number') return;
    //         if (s >= 0.8)      quality.high++;
    //         else if (s >= 0.5) quality.mid++;
    //         else               quality.low++;
    //     });

    //     // Sections les plus réécrites (agrégation de sectionEdits)
    //     const sectionTotals = {};
    //     safe.forEach(n => {
    //         const se = n.sectionEdits || {};
    //         Object.keys(se).forEach(k => { sectionTotals[k] = (sectionTotals[k] || 0) + (se[k] || 0); });
    //     });

    //     return { total, active, done, doneNotes, avgFeedback, avgEdits, avgRegens, quality, sectionTotals };
    // }

    // // Rend le dashboard dans #dashboardContent.
    // function renderDashboard(notes) {
    //     const m = computeDashboard(notes);
    //     const container = $('dashboardContent');
    //     if (!container) return;

    //     // ── KPI cards ──
    //     const kpis = `
    //         <div class="dash-kpis">
    //             <div class="dash-kpi">
    //                 <div class="dash-kpi-value">${m.total}</div>
    //                 <div class="dash-kpi-label">Release Notes</div>
    //             </div>
    //             <div class="dash-kpi dash-kpi--active">
    //                 <div class="dash-kpi-value">${m.active}</div>
    //                 <div class="dash-kpi-label">En cours</div>
    //             </div>
    //             <div class="dash-kpi dash-kpi--done">
    //                 <div class="dash-kpi-value">${m.done}</div>
    //                 <div class="dash-kpi-label">Publiées</div>
    //             </div>
    //             <div class="dash-kpi dash-kpi--score">
    //                 <div class="dash-kpi-value">${m.avgFeedback ? m.avgFeedback.toFixed(2) : '—'}</div>
    //                 <div class="dash-kpi-label">Score feedback moyen</div>
    //                 <div class="dash-kpi-sub">qualité du 1er jet de l'IA</div>
    //             </div>
    //         </div>`;

    //     // ── Effort de correction ──
    //     const effort = `
    //         <div class="dash-panel">
    //             <h3 class="dash-panel-title">Effort de correction avant validation</h3>
    //             <div class="dash-stat-row">
    //                 <div class="dash-stat">
    //                     <div class="dash-stat-value">${m.avgRegens.toFixed(2)}</div>
    //                     <div class="dash-stat-label">Régénérations moyennes</div>
    //                 </div>
    //                 <div class="dash-stat">
    //                     <div class="dash-stat-value">${m.avgEdits.toFixed(2)}</div>
    //                     <div class="dash-stat-label">Éditions moyennes</div>
    //                 </div>
    //             </div>
    //             <p class="dash-note">Plus ces valeurs sont basses, plus l'IA produit un contenu validable du premier coup.</p>
    //         </div>`;

    //     // ── Distribution qualité (barres) ──
    //     const totQ = m.quality.high + m.quality.mid + m.quality.low || 1;
    //     const quality = `
    //         <div class="dash-panel">
    //             <h3 class="dash-panel-title">Qualité du 1er jet (notes validées)</h3>
    //             ${dashBar('Excellent (≥ 0.80)', m.quality.high, totQ, '#107c10')}
    //             ${dashBar('Moyen (0.50–0.79)', m.quality.mid, totQ, '#0078d4')}
    //             ${dashBar('À améliorer (< 0.50)', m.quality.low, totQ, '#a4262c')}
    //         </div>`;

    //     // ── Sections les plus réécrites ──
    //     const sectionEntries = Object.entries(m.sectionTotals).sort((a, b) => b[1] - a[1]);
    //     const maxSec = Math.max(1, ...sectionEntries.map(e => e[1]));
    //     const sections = `
    //         <div class="dash-panel">
    //             <h3 class="dash-panel-title">Sections les plus réécrites</h3>
    //             ${sectionEntries.length
    //                 ? sectionEntries.map(([name, c]) => dashBar(name, c, maxSec, '#1a4d8f')).join('')
    //                 : '<p class="dash-note">Aucune édition de section enregistrée pour le moment.</p>'}
    //             <p class="dash-note">La section la plus réécrite signale la partie du prompt à améliorer en priorité.</p>
    //         </div>`;

    //     // ── Détail par release ──
    //     const rows = m.doneNotes
    //         .slice()
    //         .sort((a, b) => new Date(a.dateGeneration || 0) - new Date(b.dateGeneration || 0))
    //         .map(n => `
    //             <tr>
    //                 <td>${n.releaseName || '—'}</td>
    //                 <td>${n.releaseDate || '—'}</td>
    //                 <td>${n.editCount || 0}</td>
    //                 <td>${n.regenerationCount || 0}</td>
    //                 <td>${typeof n.feedbackScore === 'number' ? n.feedbackScore.toFixed(2) : '—'}</td>
    //             </tr>`).join('');
    //     const table = `
    //         <div class="dash-panel">
    //             <h3 class="dash-panel-title">Détail par release validée</h3>
    //             <table class="dash-table">
    //                 <thead><tr><th>Release</th><th>Date</th><th>Éditions</th><th>Régén.</th><th>Feedback</th></tr></thead>
    //                 <tbody>${rows || '<tr><td colspan="5">Aucune release validée.</td></tr>'}</tbody>
    //             </table>
    //             <p class="dash-note">Une tendance décroissante des corrections au fil des releases valide l'efficacité de la boucle de feedback.</p>
    //         </div>`;

    //     container.innerHTML = kpis + effort + `<div class="dash-grid">${quality}${sections}</div>` + table;
    // }

    // // Petit helper : une barre horizontale
    // function dashBar(label, value, max, color) {
    //     const pct = max ? Math.round((value / max) * 100) : 0;
    //     return `
    //         <div class="dash-bar-row">
    //             <div class="dash-bar-label">${label}</div>
    //             <div class="dash-bar-track">
    //                 <div class="dash-bar-fill" style="width:${pct}%; background:${color};"></div>
    //             </div>
    //             <div class="dash-bar-value">${value}</div>
    //         </div>`;
    // }
});
