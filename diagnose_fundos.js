'use strict';
/**
 * diagnose_fundos.js — Inspeciona DAIR_FUNDO_INVEST_ANALISADOS e descobre
 * como ela casa com DAIR_CARTEIRA, para resolver gestor por CNPJ (não por nome).
 *
 * Pergunta central: existe uma chave comum (id_ativo? no_fundo? cnpj?) entre
 * as duas tabelas, para o mesmo ente?
 *
 * Uso: node diagnose_fundos.js --uf=CE --ano=2025 --mes=5
 */
const BASE = process.env.CADPREV_BASE || 'https://apicadprev.trabalho.gov.br';
function parseArgs(v){const o={};for(const a of v.slice(2)){const m=a.match(/^--([^=]+)=(.*)$/);if(m)o[m[1]]=m[2];}return o;}
function extract(b){return Array.isArray(b)?b:(b&&(b.resource||b.data||b.items))||null;}
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();}
async function get(url,ms=40000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json'}});clearTimeout(t);return{status:r.status,arr:extract(await r.json())};}catch(e){clearTimeout(t);return{status:'ERR',motivo:/abort/i.test(e.message)?'TIMEOUT':(e.cause?.code||e.message)};}}

async function main(){
  const a=parseArgs(process.argv);const uf=(a.uf||'CE').toUpperCase(),ano=a.ano||2025,mes=Number(a.mes||5);
  const T='DAIR_FUNDO_INVEST_ANALISADOS';
  console.log(`Inspecionando ${T} · ${uf}/${ano} mês ${mes}\n`);

  // tenta os mesmos filtros da carteira
  let r=null;
  for(const f of [`sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${mes}`,`sg_uf=${uf}&dt_ano=${ano}`,`sg_uf=${uf}`]){
    const rr=await get(`${BASE}/${T}?${f}&limit=50000`);
    console.log(`filtro "${f}" → HTTP ${rr.status}, ${rr.arr?rr.arr.length+' linhas':rr.motivo||'sem array'}`);
    if(rr.arr&&rr.arr.length&&!r){r=rr.arr;}
  }
  if(!r){console.log('\n✗ não retornou dados. A tabela pode ter outro nome de filtro.');return;}

  console.log(`\nCampos de ${T}:`);
  console.log('  '+Object.keys(r[0]).join(', '));
  console.log('\nExemplo de 1 registro:');
  console.log('  '+JSON.stringify(r[0]).slice(0,700));

  // procura campos de CNPJ/instituição
  const campos=Object.keys(r[0]);
  console.log('\nCampos de CNPJ/instituição/fundo:');
  campos.filter(c=>/cnpj|empresa|fundo|ativo|gestor|administrador/i.test(c)).forEach(c=>{
    const ex=r.find(x=>x[c]&&x[c]!=='');
    console.log(`  ${c} = ${ex?JSON.stringify(String(ex[c]).slice(0,55)):'(vazio)'}`);
  });

  // agora compara com a CARTEIRA: pega a carteira do mesmo ente e vê se casa
  console.log('\n── Testando JOIN com DAIR_CARTEIRA ──');
  const cart=(await get(`${BASE}/DAIR_CARTEIRA?sg_uf=${uf}&dt_ano=${ano}&dt_mes_bimestre=${mes}&limit=50000`)).arr||[];
  const ente0=cart[0]?.nr_cnpj_entidade;
  if(ente0){
    const cartEnte=cart.filter(x=>x.nr_cnpj_entidade===ente0);
    const fundEnte=r.filter(x=>x.nr_cnpj_entidade===ente0);
    console.log(`Ente ${ente0}: ${cartEnte.length} linhas na carteira, ${fundEnte.length} na ${T}`);
    // tenta casar por id_ativo e por nome de fundo
    if(fundEnte.length){
      const fCampos=Object.keys(fundEnte[0]);
      const idC=fCampos.find(c=>/id_ativo/i.test(c)), nfC=fCampos.find(c=>/no_fundo|nome.*fundo/i.test(c));
      console.log(`  chave id_ativo na fundos: ${idC||'NÃO TEM'} | nome fundo: ${nfC||'NÃO TEM'}`);
      // match por id_ativo
      if(idC){
        const setCartId=new Set(cartEnte.map(x=>x.id_ativo));
        const casados=fundEnte.filter(x=>setCartId.has(x[idC])).length;
        console.log(`  match por id_ativo: ${casados}/${fundEnte.length}`);
      }
      // match por nome normalizado
      if(nfC){
        const setCartNome=new Set(cartEnte.map(x=>norm(x.no_fundo)));
        const casados=fundEnte.filter(x=>setCartNome.has(norm(x[nfC]))).length;
        console.log(`  match por nome do fundo (normalizado): ${casados}/${fundEnte.length}`);
      }
      console.log('\n  Exemplo de registro da fundos p/ esse ente:');
      console.log('  '+JSON.stringify(fundEnte[0]).slice(0,600));
    }
  }
  console.log('\nCole esta saída que eu monto o join correto carteira↔fundos↔gestor.');
}
main().catch(e=>{console.error('ERRO:',e.message);process.exit(1);});
