#!/usr/bin/env node
/**
 * jekyllConvert.js
 *
 * Trasforma i file HTML "before" (pagina standalone con header/main/footer)
 * nel formato Jekyll con front matter, mantenendo solo:
 *   - i <p>...</p> presenti tra <main> e <a id="top"></a>
 *   - tutti i tag <section ...>...</section> (in ordine, con tutto il loro contenuto)
 *   - i <p>...</p> presenti tra l'ultima </section> e </main>
 *   - il <div class="hierarchy">...</div> (preso dal footer), spostato in cima
 *     con un <br> subito dopo
 *
 * Approccio: estrazione per offset di stringa sui marker strutturali, NON
 * tramite parsing/serializzazione DOM (cheerio/jsdom normalizzerebbero
 * l'HTML, es. aggiungendo <tbody> alle tabelle). In questo modo il markup
 * originale di ogni blocco viene preservato byte per byte.
 *
 * Uso:
 *   node jekyllConvert.js input1.html [input2.html ...]
 *   node jekyllConvert.js --outdir=./out input1.html input2.html
 *
 * Per ogni file di input viene creato un file <nome>.converted.html
 * (nella stessa cartella dell'input, oppure dentro --outdir se specificato).
 */

const fs = require('fs');
const path = require('path');

const FRONT_MATTER = `---
layout: chiaviDicotomicheRussule
title: "Chiavi Russule"
css:
  - chiaviDicotomiche
  - floatingNav
---`;

function findTag(regex, str, fromIndex = 0) {
  regex.lastIndex = fromIndex;
  const m = regex.exec(str);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, match: m };
}

function extractParagraphs(html, startIndex, endIndex) {
  const slice = html.slice(startIndex, endIndex);
  const results = [];
  const pRegex = /<p[\s>][\s\S]*?<\/p>/gi;
  let m;
  while ((m = pRegex.exec(slice)) !== null) {
    results.push(m[0].trim());
  }
  return results;
}

function extractSections(html, startIndex, endIndex) {
  const slice = html.slice(startIndex, endIndex);
  const tagRegex = /<section\b[^>]*>|<\/section\s*>/gi;
  const sections = [];
  let depth = 0;
  let blockStart = -1;
  let m;
  while ((m = tagRegex.exec(slice)) !== null) {
    const isClose = m[0].startsWith('</');
    if (!isClose) {
      if (depth === 0) blockStart = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && blockStart !== -1) {
        const blockEnd = m.index + m[0].length;
        sections.push(slice.slice(blockStart, blockEnd).trim());
        blockStart = -1;
      }
    }
  }
  return sections;
}

function convertFile(inputPath) {
  const html = fs.readFileSync(inputPath, 'utf8');

  // --- <main> ... </main> ---
  const mainOpen = findTag(/<main\b[^>]*>/i, html);
  if (!mainOpen) throw new Error(`Nessun <main> trovato in ${inputPath}`);
  const mainCloseMatch = /<\/main\s*>/i.exec(html.slice(mainOpen.end));
  if (!mainCloseMatch) throw new Error(`Nessun </main> trovato in ${inputPath}`);
  const mainEnd = mainOpen.end + mainCloseMatch.index;

  // --- <a id="top">...</a> dentro <main> ---
  const topMatch = /<a\s+id=["']top["']\s*>\s*<\/a>/i.exec(html.slice(mainOpen.end, mainEnd));
  if (!topMatch) throw new Error(`Nessun <a id="top"></a> trovato in ${inputPath}`);
  const topStart = mainOpen.end + topMatch.index;

  // 1. <p> tra <main> e <a id="top">
  const introParagraphs = extractParagraphs(html, mainOpen.end, topStart);

  // 2. tutte le <section> tra <a id="top"> e </main>
  const sections = extractSections(html, topStart, mainEnd);
  if (sections.length === 0) {
    throw new Error(`Nessuna <section> trovata in ${inputPath}`);
  }

  // 3. <p> tra l'ultima </section> e </main>
  const lastSectionCloseRegex = /<\/section\s*>/gi;
  let lastSectionEnd = -1;
  let m;
  lastSectionCloseRegex.lastIndex = topStart;
  while ((m = lastSectionCloseRegex.exec(html)) !== null && m.index < mainEnd) {
    lastSectionEnd = m.index + m[0].length;
  }
  if (lastSectionEnd === -1) {
    throw new Error(`Impossibile individuare la fine dell'ultima sezione in ${inputPath}`);
  }
  const outroParagraphs = extractParagraphs(html, lastSectionEnd, mainEnd);

  // 4. <div class="hierarchy">...</div>
  const hierarchyOpen = findTag(/<div\s+class=["']hierarchy["']\s*>/i, html);
  if (!hierarchyOpen) throw new Error(`Nessun <div class="hierarchy"> trovato in ${inputPath}`);
  const divTagRegex = /<div\b[^>]*>|<\/div\s*>/gi;
  divTagRegex.lastIndex = hierarchyOpen.end;
  let depth = 1;
  let hierarchyEnd = -1;
  while ((m = divTagRegex.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) {
        hierarchyEnd = m.index + m[0].length;
        break;
      }
    } else {
      depth++;
    }
  }
  if (hierarchyEnd === -1) throw new Error(`</div> di chiusura per hierarchy non trovato in ${inputPath}`);
  let hierarchyHtml = html.slice(hierarchyOpen.start, hierarchyEnd).trim();
  // normalizzo eventuali righe vuote multiple lasciate dall'originale (es. subito
  // dopo l'apertura del div, comune quando il blocco veniva indentato nel footer)
  hierarchyHtml = hierarchyHtml.replace(/\n[ \t]*\n+/g, '\n');

  // --- Composizione output ---
  const parts = [FRONT_MATTER, ''];

  parts.push(hierarchyHtml);
  parts.push('<br>');
  parts.push('');

  if (introParagraphs.length) {
    parts.push(introParagraphs.join('\n\n'));
    parts.push('');
  }

  parts.push(sections.join('\n\n'));

  if (outroParagraphs.length) {
    parts.push('');
    parts.push(outroParagraphs.join('\n\n'));
  }

  parts.push('');

  return parts.join('\n');
}

function main_cli() {
  const args = process.argv.slice(2);
  let outdir = null;
  const files = [];

  for (const arg of args) {
    if (arg.startsWith('--outdir=')) {
      outdir = arg.slice('--outdir='.length);
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error('Uso: node jekyllConvert.js [--outdir=DIR] file1.html [file2.html ...]');
    process.exit(1);
  }

  if (outdir) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  for (const file of files) {
    try {
      const result = convertFile(file);
      const base = path.basename(file, path.extname(file));
      const dir = outdir || path.dirname(file);
      let outPath;
      if (outdir)
        outPath = path.join(outdir, `${base}.html`);
      else
        outPath = path.join(dir, `${base}.converted.html`);
      fs.writeFileSync(outPath, result, 'utf8');
      console.log(`OK: ${file} -> ${outPath}`);
    } catch (err) {
      console.error(`ERRORE su ${file}: ${err.message}`);
    }
  }
}

if (require.main === module) {
  main_cli();
}

module.exports = { convertFile };