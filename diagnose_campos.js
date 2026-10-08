'use strict';
/**
 * diagnose_campos.js — Última sonda. Inspeciona os dados reais do CE/2025 para:
 *   1. desambiguar dt_mes_bimestre (bimestre 1-6 ou mês 1-12?)
 *   2. confirmar o nome do campo de VALOR (vl_total_atual?)
 *   3. confirmar o campo que liga ao fundo/instituição
 *
 * Uso: node diagnose_campos.js --uf=CE --ano=2025
 */
const BASE = process.env.CADPREV_BASE || 'https://apicadprev.trabalho.gov.br';
function parseArgs(v){const o={};for(const a of v.slice(2)){const m=a.match(/^--([^=]+)=(.*)$/);if(m)o[m[1]]=m[2];}return o;}
function extract(b){return Array.isArray(b)?b:(b&&(b.resource||b.data||b.items))||null;}
async function get(url,ms=40000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});clearTimeout(t);return extract(await r.json());}catch(e){clearTimeout(t);throw e;}}

async function main(){
  const a=parseArgs(process.argv); const uf=(a.uf||'CE').toUpperCase(), ano=a.ano||2025;
  console.log(`Inspecionando DAIR_CARTEIRA · ${uf}/${ano} (ano todo)\n`);
  const rows = await get(`${BASE}/DAIR_CARTEIRA?sg_uf=${uf}&dt_ano=${ano}&limit=50000`);
  if(!rows||!rows.length){console.log('sem dados');return;}
  console.log(`Total no ano: ${rows.length} linhas\n`);

  // 1) desambiguação temporal
  const campos = Object.keys(rows[0]);
  const campoMesBim = campos.find(c=>/mes.?bimestre/i.test(c)) || campos.find(c=>/bimestre/i.test(c));
  const campoMes = campos.find(c=>/^dt_mes$|(?<!bi)mes$/i.test(c)&&c!==campoMesBim);
  const dist = (campo)=>[...new Set(rows.map(r=>r[campo]))].filter(v=>v!=null&&v!=='').sort((x,y)=>x-y);
  if(campoMesBim){
    const vals = dist(campoMesBim);
    console.log(`1) campo "${campoMesBim}" tem valores: [${vals.join(', ')}]`);
    const max = Math.max(...vals.map(Number));
    console.log(`   → máximo = ${max}. ${max<=6 ? 'É BIMESTRE (1-6). Para mês M use ceil(M/2).' : 'Vai além de 6 → é MÊS (1-12). Use o mês direto.'}`);
  }
  if(campoMes && campoMes!==campoMesBim){
    console.log(`   (também existe "${campoMes}" com valores [${dist(campoMes).join(', ')}])`);
  }

  // 2) campos de valor candidatos
  console.log(`\n2) campos de VALOR (numéricos com cifras):`);
  const valCampos = campos.filter(c=>/^vl_|valor|^pc_/i.test(c));
  valCampos.forEach(c=>{
    const ex = rows.find(r=>r[c]&&r[c]!=='0'&&r[c]!=='');
    console.log(`   ${c} = ${ex?JSON.stringify(ex[c]):'(vazio)'}`);
  });

  // 3) campos de ligação (fundo/instituição/cnpj)
  console.log(`\n3) campos de LIGAÇÃO (cnpj/fundo/ente):`);
  campos.filter(c=>/cnpj|fundo|ativo|empresa|entidade|ibge|segmento|cmn/i.test(c)).forEach(c=>{
    const ex = rows.find(r=>r[c]&&r[c]!=='');
    console.log(`   ${c} = ${ex?JSON.stringify(String(ex[c]).slice(0,50)):'(vazio)'}`);
  });

  console.log(`\n4) TODOS os campos: ${campos.join(', ')}`);
  console.log(`\nCole esta saída que eu fixo a query e o build_gold definitivos.`);
}
main().catch(e=>{console.error('ERRO:',e.message);process.exit(1);});
