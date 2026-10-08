'use strict';
/**
 * collect_cadprev.js — Coletor Bronze do CADPREV (estratégia particionada).
 *
 * POR QUE PARTICIONAR: a DAIR_CARTEIRA é a carteira de todos os RPPS do Brasil.
 * Pedir a tabela inteira de uma vez retorna timeout (resposta gigante) ou
 * HTTP 420 (rate limit). A solução é a mesma usada no PNCP: quebrar a carga
 * em fatias pequenas (uma por UF), com pageSize pequeno, backoff no 420 e
 * concorrência limitada. 27 chamadas pequenas em vez de 1 impossível.
 *
 * Tabelas:
 *   - DAIR_CARTEIRA               : fato de saldo (vl_total_atual, pc_cmn)
 *   - DAIR_FUNDO_INVEST_ANALISADOS: fundo -> instituição credenciada
 *   - DAIR_IDENTIFICACAO          : dt_envio (dedup de reenvios)
 *
 * Uso:
 *   node collectors/collect_cadprev.js --ano=2025 --mes=5            (Brasil)
 *   node collectors/collect_cadprev.js --ano=2025 --mes=5 --uf=CE    (1 estado, rápido)
 *   node collectors/collect_cadprev.js --ano=2025 --mes=5 --uf=CE,RN,SP
 *
 * Variáveis de ambiente:
 *   CADPREV_BASE   força o domínio (senão tenta trabalho.gov.br e economia.gov.br)
 *   PAGE_SIZE      linhas por página (default 100)
 *   CONCURRENCY    UFs em paralelo (default 4)
 *   BIMESTRE_MODE  'mes' | 'bimestre' | 'ambos' (default ambos)
 */

const fs = require('fs');
const path = require('path');
const { normalizeCnpj } = require('../lib/core');

// --- domínio com fallback ---
const BASES = process.env.CADPREV_BASE
  ? [process.env.CADPREV_BASE]
  : ['https://apicadprev.trabalho.gov.br', 'https://apicadprev.economia.gov.br'];
let BASE = BASES[0];

async function resolveBase() {
  for (const b of BASES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(`${b}/api-docs/`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status < 500) { BASE = b; return b; }
    } catch (_) { /* próximo */ }
  }
  throw new Error('Nenhum host CADPREV respondeu. Rode `node diagnose.js`.');
}

const TABELAS = {
  carteira: 'DAIR_CARTEIRA',
  fundos: 'DAIR_FUNDO_INVEST_ANALISADOS',
  identificacao: 'DAIR_IDENTIFICACAO',
};

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 100;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET resiliente: trata 420/429 (rate limit) com backoff exponencial e
 * timeout por tentativa. Retorna { status, rows } onde rows é o array extraído.
 */
async function getRows(url, { timeoutMs = 15000, tentativas = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tentativas; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(t);
      if (res.status === 420 || res.status === 429 || res.status >= 500) {
        await sleep(Math.min(1000 * 2 ** i, 6000)); // backoff curto
        continue;
      }
      if (!res.ok) return { status: res.status, rows: [] };
      const body = await res.json();
      const rows = Array.isArray(body) ? body
        : (body && (body.resource || body.data)) || [];
      return { status: res.status, rows: Array.isArray(rows) ? rows : [] };
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      await sleep(Math.min(1000 * 2 ** i, 6000));
    }
  }
  throw lastErr || new Error(`falha em ${url}`);
}

/**
 * Coleta uma tabela para UMA UF, paginando com pageSize pequeno.
 * O filtro vai na query (sg_uf + competência), o que mantém a resposta enxuta.
 */
async function coletarUF(tabela, ano, mes, uf) {
  const all = [];
  // dt_mes_bimestre é MÊS (1-12), confirmado nos dados reais — usar direto.
  // CARTEIRA aceita sg_uf+dt_ano+dt_mes_bimestre. Para as demais tabelas,
  // filtramos por sg_uf+dt_ano (conservador) e refinamos o mês em memória,
  // evitando 420 caso elas não exponham o mesmo campo.
  const filtro = tabela === 'DAIR_CARTEIRA'
    ? `sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${Number(mes)}`
    : `sg_uf=${uf}&dt_ano=${ano}`;
  const HARD = Number(process.env.HARD_LIMIT) || 50000;
  for (let page = 0; page < 200; page++) {
    const offset = page * HARD;
    const url = `${BASE}/${tabela}?${filtro}&limit=${HARD}`
      + (offset ? `&offset=${offset}` : '');
    const { rows } = await getRows(url);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < HARD) break; // veio tudo
  }
  return all;
}

/** Executa tarefas com concorrência limitada (pool). */
async function pool(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur).catch((e) => ({ _erro: e.message }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function filtraCompetencia(rows, ano, mes) {
  const mesN = Number(mes);
  return rows.filter((r) => {
    if (Number(r.dt_ano) !== Number(ano)) return false;
    // dt_mes_bimestre é MÊS (1-12), confirmado nos dados reais.
    const m = r.dt_mes != null && r.dt_mes !== '' ? r.dt_mes : r.dt_mes_bimestre;
    if (m != null && m !== '') return Number(m) === mesN;
    return true;
  });
}

function dedup(rows, keyFn) {
  const best = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const envio = Date.parse(r.dt_envio || r.dt_posicao || 0) || 0;
    const cur = best.get(k);
    if (!cur || envio > cur._envio) best.set(k, Object.assign({}, r, { _envio: envio }));
  }
  return [...best.values()];
}

async function main() {
  const args = parseArgs(process.argv);
  const { ano, mes } = args;
  if (!ano || !mes) {
    console.error('Uso: node collect_cadprev.js --ano=YYYY --mes=M [--uf=CE,SP]');
    process.exit(1);
  }
  const ufs = args.uf ? args.uf.split(',').map((s) => s.trim().toUpperCase()) : UFS;
  const comp = `${ano}${String(mes).padStart(2, '0')}`;
  const outDir = path.join(__dirname, '..', 'output', 'bronze', 'cadprev', comp);
  fs.mkdirSync(outDir, { recursive: true });

  await resolveBase();
  console.error(`[cadprev] base: ${BASE} | competência ${comp} | ${ufs.length} UF(s) | pageSize ${PAGE_SIZE} | concorrência ${CONCURRENCY}`);

  const resultado = {};
  for (const [nome, tabela] of Object.entries(TABELAS)) {
    process.stderr.write(`  ${tabela}: `);
    const porUf = await pool(ufs, async (uf) => {
      const rows = await coletarUF(tabela, ano, mes, uf);
      process.stderr.write(`${uf}(${rows.length}) `);
      return rows;
    }, CONCURRENCY);
    const erros = porUf.filter((r) => r && r._erro);
    const todas = porUf.filter((r) => Array.isArray(r)).flat();
    // A CARTEIRA é o fato da competência → filtra pelo mês exato.
    // FUNDOS e IDENTIFICACAO são dicionário de enriquecimento (vínculo
    // fundo→gestora é estável) → mantém o ano todo para maximizar a cobertura
    // do join. Isso é o que resolve o "Não Identificado".
    const filtrado = nome === 'carteira'
      ? filtraCompetencia(todas, ano, mes)
      : todas;
    console.error(`\n    → ${todas.length} brutas${nome === 'carteira' ? `, ${filtrado.length} na competência` : ' (ano todo, dicionário)'}${erros.length ? `, ${erros.length} UF(s) com erro` : ''}`);
    resultado[nome] = filtrado;
  }

  resultado.fundos = dedup(resultado.fundos,
    (r) => `${normalizeCnpj(r.nr_cnpj_entidade)}|${normalizeCnpj(r.nr_cnpj_fundo)}`);
  resultado.carteira = dedup(resultado.carteira,
    (r) => `${normalizeCnpj(r.nr_cnpj_entidade)}|${r.id_ativo || r.no_fundo}`);

  for (const [nome, rows] of Object.entries(resultado)) {
    fs.writeFileSync(path.join(outDir, `${nome}.json`), JSON.stringify(rows));
  }

  const entes = new Set(resultado.carteira.map((r) => normalizeCnpj(r.nr_cnpj_entidade)));
  const meta = {
    competencia: comp, coletado_em: new Date().toISOString(),
    ufs: ufs.length, page_size: PAGE_SIZE,
    contagem: Object.fromEntries(Object.entries(resultado).map(([k, v]) => [k, v.length])),
    entes_unicos: entes.size,
  };
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify(meta, null, 2));
  console.error(`[cadprev] OK -> ${outDir}`);
  console.error(`[cadprev] ${entes.size} entes únicos coletados`);
  if (entes.size === 0) {
    console.error('[cadprev] ⚠ ZERO entes. A sintaxe de filtro pode diferir. Rode `node diagnose.js --ano=' + ano + ' --mes=' + mes + ' --uf=' + ufs[0] + '` e cole a saída.');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[cadprev] ERRO:', err.message); process.exit(1); });
}

module.exports = { filtraCompetencia, dedup, coletarUF, pool };
