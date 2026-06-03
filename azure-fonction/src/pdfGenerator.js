/**
 * pdfGenerator.js — PDF professionnel, aligné sur le design du Hub
 *
 * - Tableau de métadonnées HORIZONTAL (champs en colonnes, valeurs dessous)
 * - Hiérarchie de titres claire et tailles raisonnables
 * - Couleurs alignées sur le Hub (bleu Azure DevOps)
 */

const { marked } = require('marked');

const pdfMake  = require('pdfmake/build/pdfmake');
const pdfFonts = require('pdfmake/build/vfs_fonts');
pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts.vfs;

// Palette alignée sur le Hub (Azure DevOps)
const C = {
    blue   : '#0078d4',
    feat   : '#1a4d8f',
    text   : '#242424',
    gray   : '#616161',
    border : '#e1e1e1',
    metaBg : '#e8f0fb'
};

const PAGE_WIDTH = 515;

function parseInline(text) {
    if (!text) return '';
    const clean = String(text);
    const parts = [];
    const regex = /\*\*(.+?)\*\*/g;
    let last = 0, m;
    while ((m = regex.exec(clean)) !== null) {
        if (m.index > last) parts.push({ text: clean.slice(last, m.index) });
        parts.push({ text: m[1], bold: true });
        last = regex.lastIndex;
    }
    if (last < clean.length) parts.push({ text: clean.slice(last) });
    return parts.length ? parts : clean;
}

// Tableau de métadonnées HORIZONTAL (header = champs, 1 ligne de valeurs)
function buildMetadataTable(token) {
    const header = (token.header || []).map(c => ({ text: c.text, style: 'metaField' }));
    const values = ((token.rows && token.rows[0]) || []).map(c => ({ text: c.text, style: 'metaValue' }));
    return {
        table : {
            widths: header.map(() => '*'),
            body  : [header, values]
        },
        layout: {
            fillColor : (rowIndex) => (rowIndex === 0 ? C.metaBg : null),
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => C.border,
            vLineColor: () => C.border,
            paddingTop   : () => 6,
            paddingBottom: () => 6,
            paddingLeft  : () => 10,
            paddingRight : () => 10
        },
        margin: [0, 4, 0, 18]
    };
}

function buildBody(markdown) {
    const tokens   = marked.lexer(markdown || '');
    const hasTable = tokens.some(t => t.type === 'table');
    const content  = [];
    let beforeFirstTable = hasTable;

    for (const token of tokens) {
        if (token.type === 'table' && beforeFirstTable) {
            content.push(buildMetadataTable(token));
            beforeFirstTable = false;
            continue;
        }
        if (beforeFirstTable) continue;

        switch (token.type) {
            case 'heading':
                if (token.depth === 1) break;
                if (token.depth === 2) {
                    content.push({ text: token.text, style: 'sectionHeader', margin: [0, 16, 0, 3] });
                    content.push({
                        canvas: [{ type: 'line', x1: 0, y1: 0, x2: PAGE_WIDTH, y2: 0, lineWidth: 1, lineColor: C.blue }],
                        margin: [0, 0, 0, 8]
                    });
                } else {
                    content.push({ text: token.text, style: 'subHeader', margin: [0, 10, 0, 4] });
                }
                break;

            case 'table':
                content.push({
                    table : {
                        headerRows: 1,
                        widths    : token.header.map(() => '*'),
                        body      : [
                            token.header.map(c => ({ text: c.text, style: 'tableHeader' })),
                            ...token.rows.map(r => r.map(c => ({ text: parseInline(c.text), style: 'body' })))
                        ]
                    },
                    layout: {
                        fillColor: (i) => (i === 0 ? C.blue : null),
                        hLineWidth: () => 0.5, vLineWidth: () => 0.5,
                        hLineColor: () => C.border, vLineColor: () => C.border
                    },
                    margin: [0, 4, 0, 12]
                });
                break;

            case 'list':
                content.push({
                    ul     : (token.items || []).map(it => ({ text: parseInline(it.text) })),
                    margin : [0, 2, 0, 10],
                    style  : 'body'
                });
                break;

            case 'paragraph':
                content.push({ text: parseInline(token.text), style: 'body', margin: [0, 0, 0, 8] });
                break;
        }
    }
    return content;
}

async function generatePdf({ releaseName, project, markdown }) {
    const projectName = project || 'Release Notes';

    const titleBlock = [
        { text: ('Release Notes — ' + (releaseName || '')).trim(), style: 'mainTitle', margin: [0, 0, 0, 12] }
    ];

    const docDefinition = {
        pageSize    : 'A4',
        pageMargins : [40, 64, 40, 50],

        header: {
            margin : [40, 22, 40, 0],
            columns: [
                { text: projectName, style: 'runHeaderLeft' },
                { text: 'Release Notes', style: 'runHeaderRight', alignment: 'right' }
            ]
        },

        footer: (currentPage, pageCount) => ({
            margin : [40, 12, 40, 0],
            columns: [
                { text: 'Généré le ' + new Date().toLocaleDateString('fr-FR'), style: 'footer' },
                { text: 'Page ' + currentPage + ' / ' + pageCount, style: 'footer', alignment: 'right' }
            ]
        }),

        content: [...titleBlock, ...buildBody(markdown)],

        styles: {
            mainTitle      : { fontSize: 19, bold: true, color: C.blue },
            sectionHeader  : { fontSize: 13, bold: true, color: C.blue },
            subHeader      : { fontSize: 11, bold: true, color: C.feat },
            body           : { fontSize: 10, color: C.text, lineHeight: 1.35 },
            metaField      : { fontSize: 9.5, bold: true, color: C.text },
            metaValue      : { fontSize: 9.5, color: C.text },
            tableHeader    : { fontSize: 9.5, bold: true, color: '#FFFFFF', margin: [2, 3, 2, 3] },
            runHeaderLeft  : { fontSize: 8.5, bold: true, color: C.blue },
            runHeaderRight : { fontSize: 8.5, color: C.gray },
            footer         : { fontSize: 8, color: C.gray }
        },

        defaultStyle: { fontSize: 10, lineHeight: 1.35 }
    };

    return new Promise((resolve, reject) => {
        try {
            pdfMake.createPdf(docDefinition).getBuffer(buffer => resolve(Buffer.from(buffer)));
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generatePdf };