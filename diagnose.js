'use strict';
/**
 * diagnose.js — Sonda a API CADPREV crua para descobrir por que o volume
 * coletado é menor do que o esperado (ex.: "só apareceram 3 entes").
 *
 * Roda independente do pipeline. Mostra, por tabela:
 *   - quantos registros a 1ª página retornou
 *   - se a paginação por offset funciona (página 2 difere da 1)
 *   - quais competências (ano-mês) existem na amostra
 *   - quantos entes únicos há na amostra
 *
 * Uso:
 *   node diagnose.js
 *   node diagnose.js --ano=2025 --mes=5
 */

const BASE = process.env.CADPREV_BASE || 'https://apicadprev.economia.gov.br';

const TABELAS = ['DAIR_CARTEIRA', 'DAIR_FUNDO_INVEST_ANALISADOS', 'DAIR_IDENTIFICACAO'];

function parseArgs(argv) {
  const o = {};
  for (const a of argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) o[m[1]] = m[2]; }
  return o;
}

async function getJson(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status, body };
  } finally { clearTimeout(t); }
}

function extract(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.resource)) return body.resource;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

// tenta várias convenções de querystring de paginação/limite
function urls(tabela, offset, limit) {
  return [
    `${BASE}/${tabela}?offset=${offset}&limit=${limit}`,
    `${BASE}/${tabela}?$offset=${offset}&$limit=${limit}`,
    `${BASE}/${tabela}?_offset=${offset}&_limit=${limit}`,
    `${BASE}/${tabela}`, // sem parâmetro: ver o default da API
  ];
}

async function sonda(tabela) {
  console.log(`\n══════ ${tabela} ══════`);

  // 1) descobrir convenção que responde array
  let conv = null; let page1 = null;
  for (const u of urls(tabela, 0, 1000)) {
    const { status, body } = await getJson(u);
    const arr = extract(body);
    console.log(`  GET ${u.replace(BASE, '')} -> HTTP ${status}, array=${Array.isArray(arr)}${Array.isArray(arr) ? ` (${arr.length})` : ''}`);
    if (Array.isArray(arr) && !conv) { conv = u; page1 = arr; }
  }
  if (!conv) { console.log('  ✗ nenhuma convenção devolveu array. Verifique a URL base / disponibilidade.'); return; }

  // 2) testar se offset funciona (página 2 != página 1)
  const u2 = conv.replace('offset=0', 'offset=1000').replace('$offset=0', '$offset=1000');
  const { body: b2 } = await getJson(u2);
  const page2 = extract(b2) || [];
  const offsetFunciona = page2.length > 0 && JSON.stringify(page2[0]) !== JSON.stringify(page1[0]);
  console.log(`  paginação por offset: ${offsetFunciona ? '✓ funciona' : '✗ NÃO funciona (página 2 = página 1 ou vazia)'}`);
  if (!offsetFunciona) {
    console.log('    ⚠ Se offset não funciona, o coletor pega só os primeiros 1000 registros.');
    console.log('    ⚠ Veja na doc /api-docs qual o parâmetro correto (page, cursor, skip...).');
  }

  // 3) competências presentes na amostra
  const comps = [...new Set(page1.map((r) => `${r.dt_ano}-${r.dt_mes != null ? r.dt_mes : r.dt_mes_bimestre}`))].sort();
  console.log(`  competências na 1ª página (amostra): ${comps.slice(0, 12).join(', ')}${comps.length > 12 ? ' …' : ''}`);

  // 4) entes únicos na amostra
  const entes = new Set(page1.map((r) => r.nr_cnpj_entidade));
  console.log(`  entes únicos na amostra de ${page1.length} linhas: ${entes.size}`);
  console.log(`  campos disponíveis: ${Object.keys(page1[0] || {}).slice(0, 18).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Sondando API CADPREV em ${BASE}`);
  if (args.ano) console.log(`(competência alvo: ${args.ano}-${args.mes || '?'})`);
  for (const t of TABELAS) {
    try { await sonda(t); } catch (e) { console.log(`  ✗ erro em ${t}: ${e.message}`); }
  }
  console.log('\n── Conclusão rápida ──');
  console.log('• Se "entes únicos" for alto (centenas/milhares): a API está OK, o problema');
  console.log('  estava no filtro de competência (corrigido) ou no painel em modo DEMO.');
  console.log('• Se "paginação por offset" falhar: me avise o parâmetro correto da /api-docs');
  console.log('  e eu ajusto o coletor para percorrer o Brasil inteiro.');
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
