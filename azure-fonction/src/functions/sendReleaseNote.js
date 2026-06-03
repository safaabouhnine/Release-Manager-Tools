const { app }                  = require('@azure/functions');
const { generatePdf }          = require('../pdfGenerator');
const { sendReleaseNoteEmail } = require('../emailService');

app.http('sendReleaseNote', {
    methods   : ['POST'],
    authLevel : 'anonymous',
    handler   : async (request, context) => {
        try {
            const body = await request.json();
            const { releaseName, project, companyName, markdown, clientEmail } = body || {};

            if (!markdown || !clientEmail || !releaseName) {
                return { status: 400, jsonBody: { success: false, error: 'Champs requis manquants.' } };
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
                return { status: 400, jsonBody: { success: false, error: 'Email invalide.' } };
            }

            const pdfBuffer = await generatePdf({ releaseName, project, markdown });
            const result = await sendReleaseNoteEmail({ to: clientEmail, releaseName, project, companyName, pdfBuffer });

            return { status: 200, jsonBody: { success: true, messageId: result.messageId, sentTo: clientEmail } };
        } catch (err) {
            context.error('Erreur:', err);
            return { status: 500, jsonBody: { success: false, error: err.message } };
        }
    }
});

