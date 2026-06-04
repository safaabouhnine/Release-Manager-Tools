/**
 * pdfGenerator.js — Génération PDF professionnelle des release notes
 *
 * Au lieu de convertir brutalement le Markdown (rendu basique), on parse
 * la structure et on applique un design soigné : en-tête, titre centré,
 * tableau de métadonnées stylé, titres de section soulignés, sous-titres
 * en couleur, puces propres.
 *
 * Pipeline : Markdown → tokens (marked.lexer) → définition pdfmake stylée → PDF
 */

const { marked } = require('marked');

const pdfMake  = require('pdfmake/build/pdfmake');
const pdfFonts = require('pdfmake/build/vfs_fonts');
pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts.vfs;

// Palette de couleurs (design professionnel bleu)
const C = {
    blue   : '#0078d4',
    feat   : '#1a4d8f',
    text   : '#242424',
    gray   : '#616161',
    border : '#e1e1e1',
    metaBg : '#e8f0fb'
};

const PAGE_WIDTH = 515; // A4 (595) - marges (40 + 40)

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

function buildMetadataTable(token) {
    const pairs = [];
    if (token.header && token.header.length >= 2) {
        pairs.push([token.header[0].text, token.header[1].text]);
    }
    for (const row of token.rows || []) {
        if (row.length >= 2) pairs.push([row[0].text, row[1].text]);
    }

    const body = pairs.map(([k, v]) => ([
        { text: String(k).replace(/\*\*/g, ''), style: 'metaKey' },
        { text: String(v).replace(/\*\*/g, ''), style: 'metaVal' }
    ]));

    return {
        table  : { widths: ['35%', '65%'], body },
        layout : {
            fillColor : (rowIndex) => (rowIndex % 2 === 0 ? C.rowAlt : null),
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => C.border,
            vLineColor: () => C.border,
            paddingTop   : () => 6,
            paddingBottom: () => 6,
            paddingLeft  : () => 8,
            paddingRight : () => 8
        },
        margin : [0, 6, 0, 18]
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
                    content.push({ text: token.text, style: 'sectionHeader', margin: [0, 18, 0, 4] });
                    content.push({
                        canvas: [{ type: 'line', x1: 0, y1: 0, x2: PAGE_WIDTH, y2: 0, lineWidth: 1.2, lineColor: C.accent }],
                        margin: [0, 0, 0, 10]
                    });
                } else {
                    content.push({ text: token.text, style: 'subHeader', margin: [0, 10, 0, 5] });
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
                        fillColor: (i) => (i === 0 ? C.dark : (i % 2 === 0 ? C.rowAlt : null)),
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
        { text: projectName, style: 'mainTitle', alignment: 'center', margin: [0, 10, 0, 2] },
        { text: ('Release Notes — ' + (releaseName || '')).trim(), style: 'subTitle', alignment: 'center', margin: [0, 0, 0, 20] }
    ];

    const docDefinition = {
        pageSize    : 'A4',
        pageMargins : [40, 70, 40, 55],

        header: {
            margin : [40, 25, 40, 0],
            columns: [
                { text: projectName, style: 'runHeaderLeft' },
                { text: 'Release Notes', style: 'runHeaderRight', alignment: 'right' }
            ]
        },

        footer: (currentPage, pageCount) => ({
            margin : [40, 15, 40, 0],
            columns: [
                { text: 'Généré le ' + new Date().toLocaleDateString('fr-FR'), style: 'footer' },
                { text: 'Page ' + currentPage + ' / ' + pageCount, style: 'footer', alignment: 'right' }
            ]
        }),

        content: [...titleBlock, ...buildBody(markdown)],

        styles: {
            mainTitle      : { fontSize: 26, bold: true, color: C.dark },
            subTitle       : { fontSize: 13, color: C.gray },
            sectionHeader  : { fontSize: 15, bold: true, color: C.dark },
            subHeader      : { fontSize: 12, bold: true, color: C.accent },
            body           : { fontSize: 10.5, color: C.body, lineHeight: 1.3 },
            metaKey        : { fontSize: 10, bold: true, color: C.dark },
            metaVal        : { fontSize: 10, color: C.body },
            tableHeader    : { fontSize: 10, bold: true, color: '#FFFFFF', margin: [2, 4, 2, 4] },
            runHeaderLeft  : { fontSize: 9, bold: true, color: C.accent },
            runHeaderRight : { fontSize: 9, color: C.gray },
            footer         : { fontSize: 8, color: C.gray }
        },

        defaultStyle: { fontSize: 10.5, lineHeight: 1.3 }
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