'use strict';
/**
 * diagnose.js — Sonda RÁPIDA da API CADPREV. Nunca trava: timeout curto,
 * sem backoff, 1 tentativa por URL. Descobre empiricamente:
 *   1. se a tabela responde a um pedido mínimo (limit=1)
 *   2. qual parâmetro de LIMITE a API entende (limit, $limit, top, page_size)
 *   3. quais campos de FILTRO ela aceita (sg_uf, dt_ano, ...)
 *   4. os NOMES REAIS dos campos (sg_uf vs SG_UF vs uf)
 *
 * Uso:
 *   node diagnose.js                       (sondagem geral)
 *   node diagnose.js --uf=CE --ano=2025 --mes=5
 */

const BASES = process.env.CADPREV_BASE
  ? [process.env.CADPREV_BASE]
  : ['https://apicadprev.trabalho.gov.br', 'https://apicadprev.economia.gov.br'];

function parseArgs(argv) {
  const o = {};
  for (const a of argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) o[m[1]] = m[2]; }
  return o;
}

function extract(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.resource)) return body.resource;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.items)) return body.items;
  return null;
}

/** GET rápido: timeout curto, SEM retry. Reporta status/erro sem travar. */
async function probe(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    const ms = Date.now() - t0;
    let body = null; try { body = await res.json(); } catch (_) {}
    const arr = extract(body);
    return { ok: true, status: res.status, ms, arr, raw: body };
  } catch (err) {
    clearTimeout(t);
    const ms = Date.now() - t0;
    const motivo = /abort/i.test(err.message) ? `TIMEOUT (${timeoutMs}ms)` : (err.cause?.code || err.message);
    return { ok: false, motivo, ms };
  }
}

function linha(label, r) {
  if (!r.ok) { console.log(`  ✗ ${label.padEnd(40)} → ${r.motivo} [${r.ms}ms]`); return false; }
  const arr = r.arr;
  const info = Array.isArray(arr) ? `${arr.length} linhas` : `sem array (keys: ${r.raw ? Object.keys(r.raw).slice(0,4).join(',') : 'vazio'})`;
  const flag = Array.isArray(arr) && arr.length ? '✓' : '·';
  console.log(`  ${flag} ${label.padEnd(40)} → HTTP ${r.status}, ${info} [${r.ms}ms]`);
  return Array.isArray(arr) && arr.length > 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const uf = (args.uf || 'CE').toUpperCase();
  const ano = args.ano || 2025;
  const mes = args.mes || 5;
  const bim = Math.ceil(Number(mes) / 2);

  // 1) achar host vivo
  let base = null;
  for (const b of BASES) {
    const r = await probe(`${b}/api-docs/`, 8000);
    console.log(`host ${b} → ${r.ok ? 'HTTP ' + r.status : r.motivo} [${r.ms}ms]`);
    if (r.ok && r.status < 500) { base = b; break; }
  }
  if (!base) { console.log('\n✗ nenhum host respondeu. Verifique rede/proxy.'); process.exit(2); }
  console.log(`\n✓ host: ${base}\n`);

  const T = 'DAIR_CARTEIRA';
  console.log(`══ Passo 1: ${T} responde a pedido mínimo? (timeout curto) ══`);
  // testa parâmetros de LIMITE, do mais comum ao menos
  const limitParams = [
    ['limit=1', `${base}/${T}?limit=1`],
    ['$limit=1', `${base}/${T}?$limit=1`],
    ['top=1', `${base}/${T}?top=1`],
    ['page_size=1', `${base}/${T}?page_size=1`],
    ['_limit=1', `${base}/${T}?_limit=1`],
    ['(sem limite)', `${base}/${T}`],
  ];
  let amostra = null; let limitOk = null;
  for (const [nome, url] of limitParams) {
    const r = await probe(url, 8000);
    const teve = linha(`limite: ${nome}`, r);
    if (teve && !amostra) { amostra = r.arr; limitOk = nome; }
  }

  if (!amostra) {
    console.log(`\n⚠ Nenhum pedido mínimo retornou linhas. A ${T} pode exigir filtro obrigatório.`);
    console.log('  Indo para o Passo 2 (testar com filtros) mesmo assim...\n');
  } else {
    console.log(`\n✓ parâmetro de limite que funciona: ${limitOk}`);
    console.log(`  CAMPOS REAIS do registro (use estes nomes no coletor):`);
    console.log('  ' + Object.keys(amostra[0]).join(', '));
    console.log('  Exemplo de 1 registro:');
    console.log('  ' + JSON.stringify(amostra[0]).slice(0, 600));
  }

  console.log(`\n══ Passo 2: quais FILTROS a ${T} aceita? ══`);
  const lp = (limitOk && limitOk !== '(sem limite)') ? limitOk.replace('=1', '=20') : 'limit=20';
  const filtros = [
    [`sg_uf=${uf}`, `${base}/${T}?sg_uf=${uf}&${lp}`],
    [`uf=${uf}`, `${base}/${T}?uf=${uf}&${lp}`],
    [`sg_uf minúsculo`, `${base}/${T}?sg_uf=${uf.toLowerCase()}&${lp}`],
    [`dt_ano=${ano}`, `${base}/${T}?dt_ano=${ano}&${lp}`],
    [`dt_ano+dt_mes_bimestre=${bim}`, `${base}/${T}?dt_ano=${ano}&dt_mes_bimestre=${bim}&${lp}`],
    [`filter= (DreamFactory)`, `${base}/${T}?filter=${encodeURIComponent('sg_uf=' + uf)}&${lp}`],
  ];
  const aceitos = [];
  for (const [nome, url] of filtros) {
    const r = await probe(url, 10000);
    const teve = linha(`filtro: ${nome}`, r);
    // um filtro "funciona de verdade" se reduz o conjunto (não devolve o mesmo que sem filtro)
    if (teve) aceitos.push({ nome, n: r.arr.length, sample: r.arr[0] });
  }

  console.log('\n── Diagnóstico ──');
  if (amostra) {
    const campos = Object.keys(amostra[0]);
    const temUf = campos.find((c) => /uf/i.test(c));
    const temAno = campos.find((c) => /ano/i.test(c));
    const temMes = campos.find((c) => /mes|bimestre/i.test(c));
    console.log(`• Campo de UF no registro: ${temUf || 'NÃO ENCONTRADO'}`);
    console.log(`• Campo de ano: ${temAno || '?'} | de mês/bimestre: ${temMes || '?'}`);
  }
  if (aceitos.length) {
    console.log(`• Filtros que retornaram dados: ${aceitos.map((a) => a.nome + ' (' + a.n + ')').join(' | ')}`);
  } else {
    console.log('• ⚠ Nenhum filtro retornou dados — a sintaxe é outra. Cole TODA a saída acima.');
  }
  console.log(`\nCole esta saída inteira aqui que eu fixo a URL exata no coletor.`);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
