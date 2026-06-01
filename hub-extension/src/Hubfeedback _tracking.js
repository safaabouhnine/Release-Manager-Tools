// ═══════════════════════════════════════════════════════════════
// HUB EXTENSION — Implicit Feedback Tracking
// À intégrer dans le bloc SDK.ready() de ton fichier hub-extension/src
// ═══════════════════════════════════════════════════════════════

// Helper commun : sauvegarder un document mis à jour
async function saveNote(note) {
    const accessToken = await SDK.getAccessToken();
    const extDataService = await SDK.getService(CommonServiceIds.ExtensionDataService);
    const dataManager = await extDataService.getExtensionDataManager(
        SDK.getExtensionContext().id,
        accessToken
    );
    const context = SDK.getWebContext();
    const projectName = context.project.name;
    await dataManager.updateDocument(`release-notes-${projectName}`, note);
}

// ── SIGNAL NÉGATIF FORT : Régénération via IA ────────────────────
// Appelé quand le Release Manager clique sur "Régénérer via IA"
async function trackRegeneration(note) {
    try {
        note.regenerationCount = (note.regenerationCount || 0) + 1;
        await saveNote(note);
        console.log(`📉 Feedback négatif (régénération) — total: ${note.regenerationCount}`);
        // ... ici tu déclenches la logique de régénération existante ...
    } catch (err) {
        console.error('Erreur tracking régénération:', err);
    }
}

// ── SIGNAL NÉGATIF MODÉRÉ : Édition manuelle ─────────────────────
// Appelé quand le Release Manager enregistre une modification manuelle
async function trackEdit(note) {
    try {
        note.editCount = (note.editCount || 0) + 1;
        await saveNote(note);
        console.log(`📝 Feedback modéré (édition) — total: ${note.editCount}`);
    } catch (err) {
        console.error('Erreur tracking édition:', err);
    }
}

// ── VALIDATION + CALCUL DU FEEDBACKSCORE FINAL ───────────────────
// Remplace la fonction markAsDone() existante
async function markAsDone(note) {
    try {
        const edits  = note.editCount || 0;
        const regens = note.regenerationCount || 0;

        // Calcul du FeedbackScore implicite
        // 1.0 = parfait (aucune correction), décroît avec éditions/régénérations
        note.feedbackScore = 1 / (1 + edits * 0.3 + regens * 0.6);
        note.statut        = 'Done';
        note.doneCount      = (note.doneCount || 0) + 1;
        note.feedbackDate  = new Date().toISOString();

        await saveNote(note);

        console.log(`✅ Done — FeedbackScore: ${note.feedbackScore.toFixed(3)} (${edits} éditions, ${regens} régénérations)`);

        // Mise à jour UI
        const badge = document.getElementById('statusBadge');
        badge.textContent = '✅ Done';
        badge.className = 'badge badge-done';
        markDoneBtn.disabled = true;
        exportBtn.disabled = false;

    } catch (err) {
        console.error('Erreur mise à jour:', err);
    }
}