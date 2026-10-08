'use strict';
/**
 * diagnose_pagina.js — Responde a pergunta que falta: a API tem TETO de
 * resposta? Aceita limit alto? Tem offset? Sem isso não dá para garantir
 * que pegamos TODOS os registros de uma UF.
 *
 * Usa o filtro confirmado: sg_uf + dt_ano + dt_mes_bimestre.
 *
 * Uso: node diagnose_pagina.js --uf=CE --ano=2025 --mes=5
 */

const BASE = process.env.CADPREV_BASE || 'https://apicadprev.trabalho.gov.br';

function parseArgs(argv) {
  const o = {};
  for (const a of argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) o[m[1]] = m[2]; }
  return o;
}
function extract(b){ return Array.isArray(b)?b:(b&&(b.resource||b.data||b.items))||null; }

async function probe(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    let body = null; try { body = await res.json(); } catch (_) {}
    return { ok: true, status: res.status, ms: Date.now()-t0, arr: extract(body), raw: body };
  } catch (err) {
    clearTimeout(t);
    return { ok: false, ms: Date.now()-t0, motivo: /abort/i.test(err.message)?`TIMEOUT(${timeoutMs}ms)`:(err.cause?.code||err.message) };
  }
}

function sig(row){ return row ? JSON.stringify(row).slice(0,200) : 'null'; }

async function main() {
  const a = parseArgs(process.argv);
  const uf = (a.uf||'CE').toUpperCase(), ano = a.ano||2025, bim = Math.ceil(Number(a.mes||5)/2);
  const F = `sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${bim}`;
  console.log(`Filtro base: ${F}\n`);

  // 1) default sem limit
  let r = await probe(`${BASE}/DAIR_CARTEIRA?${F}`);
  const nDefault = r.arr ? r.arr.length : null;
  console.log(`1) sem limit            → HTTP ${r.status||r.motivo}, ${nDefault} linhas [${r.ms}ms]`);

  // 2) limit pequeno: a API respeita?
  r = await probe(`${BASE}/DAIR_CARTEIRA?${F}&limit=5`);
  console.log(`2) limit=5              → HTTP ${r.status||r.motivo}, ${r.arr?r.arr.length:'-'} linhas (se =5, limit é respeitado; se =${nDefault}, é ignorado)`);

  // 3) limit grande: quantos vêm?
  r = await probe(`${BASE}/DAIR_CARTEIRA?${F}&limit=5000`, 40000);
  const nGrande = r.arr ? r.arr.length : null;
  console.log(`3) limit=5000           → HTTP ${r.status||r.motivo}, ${nGrande} linhas [${r.ms}ms]`);

  // 4) offset funciona? compara 1ª linha de offset 0 vs offset 5
  const r0 = await probe(`${BASE}/DAIR_CARTEIRA?${F}&limit=5&offset=0`);
  const r5 = await probe(`${BASE}/DAIR_CARTEIRA?${F}&limit=5&offset=5`);
  const s0 = r0.arr&&r0.arr[0]?sig(r0.arr[0]):'-', s5 = r5.arr&&r5.arr[0]?sig(r5.arr[0]):'-';
  console.log(`4) offset: 1ª linha @0 vs @5 → ${s0===s5 ? 'IGUAIS (offset NÃO funciona)' : 'DIFERENTES (offset funciona!)'}`);

  // 5) começar/skip alternativos
  for (const p of ['start=5','skip=5','page=2','pagina=2']) {
    const rr = await probe(`${BASE}/DAIR_CARTEIRA?${F}&limit=5&${p}`, 12000);
    const ss = rr.arr&&rr.arr[0]?sig(rr.arr[0]):'-';
    console.log(`   ${p.padEnd(10)} → HTTP ${rr.status||rr.motivo}, 1ª linha ${ss===s0?'igual a @0':'DIFERENTE (funciona!)'}`);
  }

  console.log('\n── Veredito ──');
  if (nGrande && nDefault && nGrande > nDefault) {
    console.log(`✓ limit alto FUNCIONA: ${nGrande} linhas numa requisição. Estratégia: 1 request por UF+competência com limit alto.`);
  } else if (nDefault) {
    console.log(`⚠ Resposta parece limitada a ~${nDefault}. Se offset/skip funcionar (passo 4/5), pagino por ali.`);
    console.log(`  Se nada paginar, particiono mais fino (por município/IBGE dentro da UF).`);
  }
  console.log('\nCole esta saída que eu fixo a estratégia de coleta no coletor.');
}
main().catch((e)=>{ console.error('ERRO:', e.message); process.exit(1); });
