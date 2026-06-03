/**
 * emailService.js — Envoi de l'email au client via nodemailer (SMTP)
 *
 * Le nom d'expéditeur est DYNAMIQUE : transmis par le Hub (companyName)
 * à chaque appel, pour que chaque organisation voie automatiquement son
 * propre nom. Plus de SMTP_FROM_NAME fixe.
 */

const nodemailer = require('nodemailer');

function createTransporter() {
    return nodemailer.createTransport({
        host  : process.env.SMTP_HOST,
        port  : parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth  : {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

/**
 * Envoie la release note par email avec le PDF en pièce jointe.
 *
 * @param {Object} params
 * @param {string} params.to          - Email du client
 * @param {string} params.releaseName - Nom de la release
 * @param {string} params.project     - Nom du projet
 * @param {string} params.companyName - Nom de l'entreprise (dynamique, depuis le Hub)
 * @param {Buffer} params.pdfBuffer   - PDF à joindre
 */
async function sendReleaseNoteEmail({ to, releaseName, project, companyName, pdfBuffer }) {
    const transporter = createTransporter();

    // Nom d'expéditeur DYNAMIQUE par organisation
    const company  = companyName || project || 'Release Notes';
    const fromName = company + ' — Release Notes';

    const fileName = ('Release-Notes-' + project + '-' + releaseName + '.pdf').replace(/\s+/g, '_');

    const htmlBody = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; color: #242424; max-width: 600px;">
            <div style="background: #1F3A5F; padding: 20px 24px; border-radius: 8px 8px 0 0;">
                <h2 style="color: #ffffff; margin: 0;">Release Notes — ${releaseName}</h2>
            </div>
            <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
                <p>Bonjour,</p>
                <p>
                    Veuillez trouver ci-joint les notes de version de la release
                    <strong>${releaseName}</strong> du projet <strong>${project}</strong>.
                </p>
                <p>
                    Ce document récapitule les nouvelles fonctionnalités, corrections et
                    améliorations apportées par cette mise à jour.
                </p>
                <p style="margin-top: 24px; color: #616161; font-size: 13px;">
                    Cordialement,<br>
                    L'équipe ${company}
                </p>
            </div>
            <p style="color: #888888; font-size: 11px; margin-top: 16px;">
                Email généré automatiquement par Smart Release Notes Generator.
            </p>
        </div>
    `;

    const info = await transporter.sendMail({
        from   : '"' + fromName + '" <' + process.env.SMTP_USER + '>',
        to,
        subject: 'Release Notes — ' + company + ' ' + releaseName,
        html   : htmlBody,
        attachments: [
            { filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }
        ]
    });

    return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { sendReleaseNoteEmail };