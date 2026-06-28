'use strict';
/**
 * collect_cvm.js — Coletor da camada Bronze para a CVM.
 *
 * Fonte confirmada: Portal de Dados Abertos da CVM (dados.cvm.gov.br).
 *   - Cadastro de fundos: cad_fi.csv
 *       URL: https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv
 *       Traz: CNPJ_FUNDO, DENOM_SOCIAL, ADMIN, CNPJ_ADMIN, GESTOR,
 *             SIT (situação), CLASSE, etc.
 *   - (Opcional fase 2) CDA — composição: cda_fi_AAAAMM.zip, para look-through.
 *
 * O cadastro é a peça que dá taxonomia (administrador/gestor) aos CNPJ de fundo
 * que o CADPREV informa. Atualização semanal é suficiente — cadastro muda devagar.
 *
 * Arquivos CVM são CSV separados por ';' em encoding latin1 (ISO-8859-1).
 * Parseamos sem dependência externa, tratando o encoding explicitamente.
 *
 * Uso: node collectors/collect_cvm.js
 */

const fs = require('fs');
const path = require('path');
const { normalizeCnpj } = require('../lib/core');

const CAD_FI_URL = process.env.CVM_CADFI_URL
  || 'https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv';

/**
 * Parser CSV mínimo para os arquivos da CVM: delimitador ';', sem aspas
 * complexas na maioria dos campos. Trata header e linhas vazias.
 * Para robustez contra campos com ';' entre aspas, há tratamento de aspas.
 */
function parseCsvSemicolon(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length === 1 && cells[0] === '') continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = cells[j] !== undefined ? cells[j] : '';
    }
    out.push(obj);
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ';' && !inQuotes) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

async function fetchLatin1(url, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // CVM publica em ISO-8859-1
    return new TextDecoder('latin1').decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normaliza o cadastro em registros enxutos de dim_fundo.
 * Os nomes de coluna do cad_fi podem variar ao longo do tempo; mapeamos
 * defensivamente por candidatos.
 */
function toDimFundo(rows) {
  const pick = (r, ...keys) => {
    for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k];
    return '';
  };
  const seen = new Map();
  for (const r of rows) {
    const cnpj = normalizeCnpj(pick(r, 'CNPJ_FUNDO', 'CNPJ_FUNDO_COTA', 'CNPJ'));
    if (!cnpj) continue;
    // mantém o registro mais "completo" por CNPJ (com gestor preenchido)
    const rec = {
      cnpj_fundo: cnpj,
      denominacao: pick(r, 'DENOM_SOCIAL', 'DENOM_COMERC'),
      cnpj_admin: normalizeCnpj(pick(r, 'CNPJ_ADMIN')),
      administrador: pick(r, 'ADMIN'),
      gestor: pick(r, 'GESTOR'),
      classe: pick(r, 'CLASSE'),
      situacao: pick(r, 'SIT'),
    };
    const prev = seen.get(cnpj);
    if (!prev || (!prev.gestor && rec.gestor)) seen.set(cnpj, rec);
  }
  return [...seen.values()];
}

async function main() {
  const outDir = path.join(__dirname, '..', 'output', 'bronze', 'cvm');
  fs.mkdirSync(outDir, { recursive: true });

  console.error('[cvm] baixando cadastro de fundos (cad_fi) ...');
  const csv = await fetchLatin1(CAD_FI_URL);
  const rows = parseCsvSemicolon(csv);
  console.error(`[cvm] ${rows.length} linhas brutas no cadastro`);

  const dim = toDimFundo(rows);
  console.error(`[cvm] ${dim.length} fundos únicos com CNPJ válido`);

  fs.writeFileSync(path.join(outDir, 'dim_fundo.json'), JSON.stringify(dim));
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify({
    baixado_em: new Date().toISOString(),
    linhas_brutas: rows.length,
    fundos_unicos: dim.length,
    fonte: CAD_FI_URL,
  }, null, 2));
  console.error(`[cvm] OK -> ${outDir}/dim_fundo.json`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[cvm] ERRO:', err.message);
    process.exit(1);
  });
}

module.exports = { parseCsvSemicolon, splitCsvLine, toDimFundo };
