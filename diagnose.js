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

// Domínio atual confirmado no Conecta gov.br: apicadprev.trabalho.gov.br
// (o antigo apicadprev.economia.gov.br foi descontinuado na reorganização
//  ministerial). Lista de candidatos tentados em ordem; o primeiro que
//  responder é fixado.
const BASES = (process.env.CADPREV_BASE
  ? [process.env.CADPREV_BASE]
  : [
    'https://apicadprev.trabalho.gov.br',
    'https://apicadprev.economia.gov.br',
  ]);

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

/** Traduz o erro cru de fetch numa causa acionável. */
function explicarErroRede(err) {
  const msg = (err && (err.cause && err.cause.code || err.cause && err.cause.message || err.message)) || String(err);
  const code = err && err.cause && err.cause.code;
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(msg)) {
    return 'DNS não resolveu o host. O domínio mudou ou sua rede bloqueia a resolução. Tente o outro domínio candidato.';
  }
  if (code === 'ECONNREFUSED') return 'Conexão recusada: host no ar mas porta fechada, ou proxy intervindo.';
  if (code === 'ETIMEDOUT' || /timeout|aborted/i.test(msg)) return 'Timeout: provável firewall/proxy corporativo bloqueando a saída.';
  if (/CERT|TLS|SSL|self-signed|altnames/i.test(msg)) return 'Erro de certificado TLS. Rede corporativa pode estar inspecionando SSL (MITM proxy).';
  if (/proxy/i.test(msg)) return 'Erro de proxy. Configure HTTPS_PROXY/HTTP_PROXY conforme sua rede.';
  return `Causa: ${msg}`;
}

/** Testa conectividade básica até o host antes de sondar tabelas. */
async function testarHost(base) {
  process.stdout.write(`  ${base} ... `);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${base}/api-docs/`, { signal: ctrl.signal });
    clearTimeout(t);
    console.log(`alcançável (HTTP ${res.status})`);
    return true;
  } catch (err) {
    console.log('FALHOU');
    console.log(`    → ${explicarErroRede(err)}`);
    return false;
  }
}

function extract(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.resource)) return body.resource;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

// tenta várias convenções de querystring de paginação/limite
function urls(base, tabela, offset, limit) {
  return [
    `${base}/${tabela}?offset=${offset}&limit=${limit}`,
    `${base}/${tabela}?$offset=${offset}&$limit=${limit}`,
    `${base}/${tabela}?_offset=${offset}&_limit=${limit}`,
    `${base}/${tabela}`, // sem parâmetro: ver o default da API
  ];
}

async function sonda(base, tabela) {
  console.log(`\n══════ ${tabela} ══════`);

  // 1) descobrir convenção que responde array
  let conv = null; let page1 = null;
  for (const u of urls(base, tabela, 0, 1000)) {
    let r;
    try { r = await getJson(u); } catch (err) {
      console.log(`  GET ${u.replace(base, '')} -> ERRO: ${explicarErroRede(err)}`);
      continue;
    }
    const arr = extract(r.body);
    console.log(`  GET ${u.replace(base, '')} -> HTTP ${r.status}, array=${Array.isArray(arr)}${Array.isArray(arr) ? ` (${arr.length})` : ''}`);
    if (Array.isArray(arr) && !conv) { conv = u; page1 = arr; }
  }
  if (!conv) { console.log('  ✗ nenhuma convenção devolveu array.'); return; }

  // 2) testar se offset funciona (página 2 != página 1)
  const u2 = conv.replace('offset=0', 'offset=1000').replace('$offset=0', '$offset=1000');
  let page2 = [];
  try { page2 = extract((await getJson(u2)).body) || []; } catch (_) { /* ignore */ }
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
  console.log(`  campos: ${Object.keys(page1[0] || {}).slice(0, 18).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('═══ Teste de conectividade (antes de sondar tabelas) ═══');
  let base = null;
  for (const b of BASES) {
    if (await testarHost(b)) { base = b; break; }
  }
  if (!base) {
    console.log('\n✗ Nenhum host CADPREV respondeu. Diagnóstico:');
    console.log('  1) Teste no terminal:  curl -I https://apicadprev.trabalho.gov.br/api-docs/');
    console.log('  2) Se curl também falhar com timeout → firewall/proxy da sua rede.');
    console.log('     Numa rede corporativa (banco), defina o proxy:');
    console.log('       export HTTPS_PROXY=http://usuario:senha@proxy.suaempresa:8080');
    console.log('       export HTTP_PROXY=$HTTPS_PROXY');
    console.log('     e rode de novo. Node 18+ respeita essas variáveis via undici.');
    console.log('  3) Se curl funcionar mas o Node não → atualize o Node (>=18) ou use o proxy acima.');
    console.log('  4) Alternativa sem firewall: baixe os CSV de dados abertos pelo navegador');
    console.log('     em dados.gov.br/dataset/api-cadprev e aponte o coletor para o arquivo local.');
    process.exit(2);
  }
  console.log(`\n✓ usando base: ${base}`);
  if (args.ano) console.log(`(competência alvo: ${args.ano}-${args.mes || '?'})`);

  for (const t of TABELAS) {
    try { await sonda(base, t); } catch (e) { console.log(`  ✗ erro em ${t}: ${explicarErroRede(e)}`); }
  }
  console.log('\n── Conclusão rápida ──');
  console.log('• "entes únicos" alto (centenas/milhares) → API OK; o problema era domínio/filtro/DEMO.');
  console.log('• "paginação por offset" falha → me diga e ajusto o parâmetro de paginação.');
  console.log(`• Fixe o domínio que funcionou:  export CADPREV_BASE=${base}`);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
