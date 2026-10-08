'use strict';
/**
 * diagnose_valores.js — Trava o campo de VALOR da aplicação.
 * No DAIR a maioria das linhas é zero (enquadramentos sem aplicação).
 * Precisamos do campo que carrega o valor REAL aplicado, para o market share.
 *
 * Uso: node diagnose_valores.js --uf=CE --ano=2025 --mes=5
 */
const BASE = process.env.CADPREV_BASE || 'https://apicadprev.trabalho.gov.br';
function parseArgs(v){const o={};for(const a of v.slice(2)){const m=a.match(/^--([^=]+)=(.*)$/);if(m)o[m[1]]=m[2];}return o;}
function extract(b){return Array.isArray(b)?b:(b&&(b.resource||b.data||b.items))||null;}
function num(s){if(s==null||s==='')return 0;const n=Number(String(s).replace(/\./g,(m,i,str)=>str.indexOf(',')>-1?'':'.').replace(',','.'));return Number.isFinite(n)?n:0;}
function fmt(n){return n.toLocaleString('pt-BR',{maximumFractionDigits:0});}
async function get(url,ms=40000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});clearTimeout(t);return extract(await r.json());}catch(e){clearTimeout(t);throw e;}}

async function main(){
  const a=parseArgs(process.argv);const uf=(a.uf||'CE').toUpperCase(),ano=a.ano||2025,mes=Number(a.mes||5);
  console.log(`DAIR_CARTEIRA · ${uf}/${ano} mês ${mes}\n`);
  const rows=await get(`${BASE}/DAIR_CARTEIRA?sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${mes}&limit=50000`);
  if(!rows||!rows.length){console.log('sem dados');return;}
  console.log(`${rows.length} linhas na competência\n`);

  const campos=['vl_total_atual','vl_atual_ativo','vl_patrimonio'];
  console.log('Campo               | nº linhas >0 | soma            | distinct por ente');
  console.log('-'.repeat(78));
  for(const c of campos){
    const naoZero=rows.filter(r=>num(r[c])>0);
    const soma=rows.reduce((s,r)=>s+num(r[c]),0);
    // distinct por ente: se vl_patrimonio é constante por ente, é patrimônio total (não somar)
    const porEnte=new Map();
    rows.forEach(r=>{const e=r.nr_cnpj_entidade;if(!porEnte.has(e))porEnte.set(e,new Set());porEnte.get(e).add(r[c]);});
    const mediaDistinct=([...porEnte.values()].reduce((s,v)=>s+v.size,0)/porEnte.size).toFixed(1);
    console.log(`${c.padEnd(19)} | ${String(naoZero.length).padStart(11)} | ${fmt(soma).padStart(15)} | ${mediaDistinct} valores/ente`);
  }

  const entes=new Set(rows.map(r=>r.nr_cnpj_entidade));
  console.log(`\n${entes.size} entes (RPPS) na competência`);
  console.log('\nInterpretação:');
  console.log('• O campo de VALOR DA APLICAÇÃO tem muitas linhas >0 e varia muito por ente.');
  console.log('• vl_patrimonio provavelmente é CONSTANTE por ente (~1 valor/ente) = patrimônio total, NÃO somar.');

  console.log('\n3 linhas com vl_total_atual > 0:');
  rows.filter(r=>num(r.vl_total_atual)>0).slice(0,3).forEach(r=>{
    console.log(`  ${r.no_ente?.slice(0,28).padEnd(28)} | ${r.no_fundo?.slice(0,30).padEnd(30)} | total=${r.vl_total_atual} | ativo=${r.vl_atual_ativo} | patrim=${r.vl_patrimonio}`);
  });
  console.log('\nCole esta saída que eu fixo o campo de valor no build_gold.');
}
main().catch(e=>{console.error('ERRO:',e.message);process.exit(1);});
