'use strict';
/**
 * collect_cadprev.js — Coletor da camada Bronze para o CADPREV.
 *
 * Tabelas ingeridas (endpoints confirmados no catálogo ODA da UFMG):
 *   - DAIR_FUNDO_INVEST_ANALISADOS : CNPJ do fundo + CNPJ/nome da instituição
 *       credenciada, vinculados ao ente. É a chave de ouro: já entrega
 *       fundo -> instituição sem depender 100% da CVM.
 *   - DAIR_CARTEIRA               : valores aplicados (vl_total_atual),
 *       enquadramento CMN (pc_cmn), segmento. É o fato de saldo.
 *   - DAIR_IDENTIFICACAO          : data de envio/posição, usada para
 *       deduplicar reenvios da mesma competência (pega o mais recente).
 *
 * Saída: JSON bruto particionado por competência em output/bronze/cadprev/.
 *
 * Uso:
 *   node collectors/collect_cadprev.js --ano=2025 --mes=5
 *   node collectors/collect_cadprev.js --ano=2025 --mes=5 --uf=CE   (recorte p/ teste)
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeCnpj, normalizeIbge, parseBrNumber, paginate,
} = require('../lib/core');

// Domínio atual confirmado no Conecta gov.br: apicadprev.trabalho.gov.br.
// Mantemos o antigo como fallback. resolveBase() fixa o primeiro que responder.
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
      if (res.ok || res.status === 200 || res.status === 301 || res.status === 302) { BASE = b; return b; }
    } catch (_) { /* tenta o próximo */ }
  }
  throw new Error(
    'Nenhum host CADPREV respondeu (apicadprev.trabalho.gov.br / .economia.gov.br). '
    + 'Rode `node diagnose.js` para identificar se é domínio, DNS ou firewall corporativo.',
  );
}

const TABELAS = {
  fundos: 'DAIR_FUNDO_INVEST_ANALISADOS',
  carteira: 'DAIR_CARTEIRA',
  identificacao: 'DAIR_IDENTIFICACAO',
};

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Monta o filtro de competência. A doc pública não fixa a sintaxe de filtro,
 * então passamos ano/mes como query simples; se a API ignorar, o coletor ainda
 * funciona baixando tudo e filtrando em memória (ver filterByCompetencia).
 */
function competenciaQuery(ano, mes) {
  return `dt_ano=${ano}&dt_mes=${mes}&`;
}

function filterByCompetencia(rows, ano, mes, opts = {}) {
  const mesN = Number(mes);
  const bimestre = Math.ceil(mesN / 2); // mês 5 -> bimestre 3
  // A semântica de dt_mes_bimestre na DAIR_CARTEIRA é ambígua: pode ser o MÊS
  // (1-12) ou o número do BIMESTRE (1-6). Em vez de adivinhar (e arriscar
  // casar o bimestre errado), deixamos explícito. Default: tenta os dois e
  // marca como ambíguo no diagnóstico. Defina opts.bimestreEhMes=true/false
  // assim que confirmar na primeira carga real.
  const modo = opts.bimestreEhMes; // true=mês, false=bimestre, undefined=ambos
  return rows.filter((r) => {
    const a = Number(r.dt_ano);
    if (a !== Number(ano)) return false;
    if (r.dt_mes != null && r.dt_mes !== '') {
      return Number(r.dt_mes) === mesN; // tabelas mensais: sem ambiguidade
    }
    if (r.dt_mes_bimestre != null && r.dt_mes_bimestre !== '') {
      const m = Number(r.dt_mes_bimestre);
      if (modo === true) return m === mesN;        // confirmado: é mês
      if (modo === false) return m === bimestre;   // confirmado: é bimestre
      return m === mesN || m === bimestre;         // ambíguo: aceita os dois
    }
    return true; // sem campo de mês: filtra só por ano
  });
}

async function coletarTabela(tabela, ano, mes) {
  const url = `${BASE}/${tabela}`;
  const rows = await paginate(url, {
    pageSize: 1000,
    extraQuery: competenciaQuery(ano, mes),
    httpOpts: { timeoutMs: 45000, retries: 4 },
  });
  const filtrado = filterByCompetencia(rows, ano, mes);
  // diagnóstico: se a API ignorou o filtro de competência na query, baixamos
  // tudo e filtramos em memória — mostramos os dois números para você ver
  // onde o volume some.
  console.error(
    `      [diag] ${tabela}: API retornou ${rows.length} linhas | `
    + `${filtrado.length} após filtro ${ano}-${mes} | `
    + `${new Set(filtrado.map((r) => r.nr_cnpj_entidade)).size} entes únicos`,
  );
  if (rows.length > 0 && filtrado.length === 0) {
    const amostraMeses = [...new Set(rows.slice(0, 200).map(
      (r) => `${r.dt_ano}-${r.dt_mes != null ? r.dt_mes : r.dt_mes_bimestre}`,
    ))].slice(0, 8);
    console.error(`      [diag] ⚠ filtro zerou! competências presentes na amostra: ${amostraMeses.join(', ')}`);
  }
  return filtrado;
}

/**
 * Deduplica registros mantendo o de maior dt_envio por chave natural.
 * Ente pode reenviar o DAIR da mesma competência (retificação).
 */
function dedupByEnvio(rows, keyFn) {
  const best = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const envio = Date.parse(r.dt_envio || r.dt_posicao || 0) || 0;
    const cur = best.get(k);
    if (!cur || envio > cur._envio) {
      best.set(k, Object.assign({}, r, { _envio: envio }));
    }
  }
  return [...best.values()];
}

async function main() {
  const args = parseArgs(process.argv);
  const ano = args.ano;
  const mes = args.mes;
  if (!ano || !mes) {
    console.error('Uso: node collect_cadprev.js --ano=YYYY --mes=M [--uf=XX]');
    process.exit(1);
  }
  const comp = `${ano}${String(mes).padStart(2, '0')}`;
  const outDir = path.join(__dirname, '..', 'output', 'bronze', 'cadprev', comp);
  fs.mkdirSync(outDir, { recursive: true });

  await resolveBase();
  console.error(`[cadprev] usando base: ${BASE}`);
  console.error(`[cadprev] coletando competência ${comp} ...`);
  const result = {};
  for (const [nome, tabela] of Object.entries(TABELAS)) {
    process.stderr.write(`  - ${tabela} ... `);
    let rows = await coletarTabela(tabela, ano, mes);
    if (args.uf) {
      rows = rows.filter((r) => String(r.sg_uf).toUpperCase() === args.uf.toUpperCase());
    }
    console.error(`${rows.length} registros`);
    result[nome] = rows;
  }

  // Dedup por competência
  result.fundos = dedupByEnvio(
    result.fundos,
    (r) => `${normalizeCnpj(r.nr_cnpj_entidade)}|${normalizeCnpj(r.nr_cnpj_fundo)}`,
  );
  result.carteira = dedupByEnvio(
    result.carteira,
    (r) => `${normalizeCnpj(r.nr_cnpj_entidade)}|${r.id_ativo || r.no_fundo}`,
  );

  for (const [nome, rows] of Object.entries(result)) {
    const f = path.join(outDir, `${nome}.json`);
    fs.writeFileSync(f, JSON.stringify(rows));
  }

  // sumário de qualidade — quantos CNPJ de fundo válidos chegaram
  const fundosComCnpj = result.fundos.filter(
    (r) => normalizeCnpj(r.nr_cnpj_fundo),
  ).length;
  const meta = {
    competencia: comp,
    coletado_em: new Date().toISOString(),
    contagem: Object.fromEntries(
      Object.entries(result).map(([k, v]) => [k, v.length]),
    ),
    fundos_com_cnpj_valido: fundosComCnpj,
    pct_fundos_identificados: result.fundos.length
      ? (fundosComCnpj / result.fundos.length * 100).toFixed(1) + '%'
      : 'n/a',
  };
  fs.writeFileSync(path.join(outDir, '_meta.json'), JSON.stringify(meta, null, 2));
  console.error(`[cadprev] OK -> ${outDir}`);
  console.error(JSON.stringify(meta, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[cadprev] ERRO:', err.message);
    process.exit(1);
  });
}

module.exports = { coletarTabela, dedupByEnvio, filterByCompetencia };
