'use strict';
/**
 * diagnose_credenciamento.js — Investiga a validade de credenciamento.
 *
 * Regra regulatória (Portaria MTP 1.467/2022): o credenciamento de uma
 * instituição por um RPPS vale até 24 meses a contar da DATA DA ANÁLISE.
 * A DAIR_FUNDO_INVEST_ANALISADOS traz dt_analise por ente+fundo+instituição.
 *
 * Esta sonda verifica:
 *   1. dt_analise está preenchido? qual a distribuição temporal?
 *   2. quantos registros estariam VENCIDOS (dt_analise + 24m < hoje)?
 *   3. há outros campos de validade/situação na tabela?
 *   4. cruzando com a CARTEIRA: há ente com MOVIMENTO em fundo de
 *      instituição com credenciamento vencido?
 *
 * Uso: node diagnose_credenciamento.js --uf=CE --ano=2025 --mes=5
 */
const BASE = process.env.CADPREV_BASE || 'https://apicadprev.trabalho.gov.br';
function parseArgs(v){const o={};for(const a of v.slice(2)){const m=a.match(/^--([^=]+)=(.*)$/);if(m)o[m[1]]=m[2];}return o;}
function extract(b){return Array.isArray(b)?b:(b&&(b.resource||b.data||b.items))||null;}
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();}
function num(s){if(s==null||s==='')return 0;const n=Number(String(s).replace(/\./g,(m,i,str)=>str.indexOf(',')>-1?'':'.').replace(',','.'));return Number.isFinite(n)?n:0;}
async function get(url,ms=45000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});clearTimeout(t);return extract(await r.json());}catch(e){clearTimeout(t);throw e;}}

function parseData(s){
  if(!s)return null;
  // formatos: "2024-04-01 03:00:00.000" ou "01/03/2024"
  let m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  m=String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if(m)return new Date(+m[3],+m[2]-1,+m[1]);
  const d=new Date(s);return isNaN(d)?null:d;
}
function addMeses(d,n){const x=new Date(d);x.setMonth(x.getMonth()+n);return x;}

async function main(){
  const a=parseArgs(process.argv);const uf=(a.uf||'CE').toUpperCase(),ano=a.ano||2025,mes=Number(a.mes||5);
  const hoje=new Date();
  console.log(`Análise de credenciamento · ${uf}/${ano} mês ${mes} · hoje=${hoje.toISOString().slice(0,10)}\n`);

  const F=`DAIR_FUNDO_INVEST_ANALISADOS`;
  const fundos=await get(`${BASE}/${F}?sg_uf=${uf}&dt_ano=${ano}&limit=50000`);
  if(!fundos||!fundos.length){console.log('sem dados da tabela de fundos');return;}
  console.log(`${fundos.length} linhas em ${F}\n`);

  // 1) campos de data/validade/situação
  const campos=Object.keys(fundos[0]);
  console.log('Campos de data/situação/validade:');
  campos.filter(c=>/data|dt_|valid|situa|status|analise|credenc|venc/i.test(c)).forEach(c=>{
    const ex=fundos.find(x=>x[c]&&x[c]!=='');
    console.log(`  ${c} = ${ex?JSON.stringify(String(ex[c]).slice(0,40)):'(vazio)'}`);
  });

  // 2) distribuição de dt_analise + preenchimento
  const comAnalise=fundos.filter(x=>parseData(x.dt_analise));
  console.log(`\ndt_analise preenchido: ${comAnalise.length}/${fundos.length} (${(comAnalise.length/fundos.length*100).toFixed(0)}%)`);
  const anos={};
  comAnalise.forEach(x=>{const d=parseData(x.dt_analise);anos[d.getFullYear()]=(anos[d.getFullYear()]||0)+1;});
  console.log('Distribuição por ano da análise:', JSON.stringify(anos));

  // 3) vencidos (dt_analise + 24 meses < hoje)
  let vencidos=0,vigentes=0,proxVencer=0;
  comAnalise.forEach(x=>{
    const venc=addMeses(parseData(x.dt_analise),24);
    if(venc<hoje)vencidos++;
    else{vigentes++;if(venc<addMeses(hoje,3))proxVencer++;}
  });
  console.log(`\nSituação (regra 24 meses):`);
  console.log(`  VENCIDOS: ${vencidos} | vigentes: ${vigentes} | vencendo em 90d: ${proxVencer}`);

  // 4) CRUZAMENTO com carteira: movimento em fundo de instituição vencida
  console.log(`\n── Cruzando com DAIR_CARTEIRA (movimento × credenciamento) ──`);
  const cart=await get(`${BASE}/DAIR_CARTEIRA?sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${mes}&limit=50000`);
  // índice credenciamento por ente+nome do fundo -> dt_analise mais recente
  const credMap=new Map();
  for(const f of fundos){
    const k=`${String(f.nr_cnpj_entidade).replace(/\D/g,'')}|${norm(f.no_fundo)}`;
    const d=parseData(f.dt_analise);if(!d)continue;
    const prev=credMap.get(k);
    if(!prev||d>prev.dt)credMap.set(k,{dt:d,venc:addMeses(d,24),empresa:f.no_empresa,cnpjEmp:f.nr_cnpj_empresa});
  }
  let achados=[],semCred=0;
  for(const c of (cart||[])){
    const v=num(c.vl_total_atual);if(v<=0)continue;
    const k=`${String(c.nr_cnpj_entidade).replace(/\D/g,'')}|${norm(c.no_fundo)}`;
    const cred=credMap.get(k);
    if(!cred){semCred++;continue;}
    if(cred.venc<hoje){
      achados.push({ente:c.no_ente,fundo:(c.no_fundo||'').slice(0,40),empresa:cred.empresa,venc:cred.venc.toISOString().slice(0,10),valor:v});
    }
  }
  achados.sort((x,y)=>y.valor-x.valor);
  console.log(`\nATENÇÃO — posições com MOVIMENTO e credenciamento VENCIDO: ${achados.length}`);
  console.log(`(posições sem credenciamento encontrado na tabela: ${semCred})`);
  const totalRisco=achados.reduce((s,x)=>s+x.valor,0);
  console.log(`Valor total em risco de conformidade: R$ ${Math.round(totalRisco).toLocaleString('pt-BR')}\n`);
  console.log('Top 10 achados:');
  achados.slice(0,10).forEach(x=>console.log(`  ${x.ente?.slice(0,22).padEnd(22)} | ${x.empresa?.slice(0,26).padEnd(26)} | venceu ${x.venc} | R$ ${Math.round(x.valor).toLocaleString('pt-BR')}`));

  console.log('\nCole esta saída que eu monto o módulo de credenciamento no painel.');
}
main().catch(e=>{console.error('ERRO:',e.message);process.exit(1);});
