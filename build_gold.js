'use strict';
/**
 * build_gold.js — Camadas Silver + Gold do ETL.
 *
 * Lê o Bronze (cadprev/<comp> + cvm/dim_fundo) e produz os PAYLOADS COMPACTOS
 * que o painel single-file HTML consome. O front nunca vê o DAIR cru — só
 * agregados já fatiados, com poucos KB cada.
 *
 * Decisão de arquitetura central:
 *   O DAIR nacional cru (5k+ entes × várias linhas) é grande demais para
 *   localStorage/navegador. Então a agregação acontece AQUI, server-side/batch,
 *   e o proxy Vercel serve apenas o resultado. O grão atômico
 *   [competência × ente × fundo] é preservado em parquet/json no servidor para
 *   drill-down sob demanda (Tela 3), mas as Telas 1 e 2 recebem agregados prontos.
 *
 * Join (ordem importa para correção):
 *   1. fato (DAIR_CARTEIRA: valores) — grão ente×ativo
 *   2. LEFT JOIN DAIR_FUNDO_INVEST_ANALISADOS por (ente, fundo) -> CNPJ instituição
 *   3. LEFT JOIN cvm.dim_fundo por CNPJ_fundo -> administrador/gestor (enriquece)
 *   4. resolve grupo econômico (raiz do CNPJ admin/gestor/instituição)
 *
 * LEFT (não INNER) em todos: AUM sem match vira bucket "Não Identificado",
 * cujo % é monitorado como métrica de qualidade. INNER faria AUM sumir e
 * inflar o market share dos grandes.
 *
 * Uso:
 *   node build_gold.js --comp=202505
 *   node build_gold.js --comp=202505 --prev=202504   (habilita deltas/alertas)
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeCnpj, normalizeIbge, parseBrNumber, regiaoFromUf,
  resolveGrupo, resolveGrupoPorNome,
} = require('./lib/core');

// normaliza nome de fundo para chave de join textual (maiúsculas, sem acento/pontuação)
function normalizaNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// gera rótulo legível de uma gestora não mapeada a conglomerado.
// Ex: "BB GESTAO DE RECURSOS - DISTRIBUIDORA DE TITULOS..." -> "BB Gestao De Recursos"
function rotuloGestora(noEmpresa) {
  let s = String(noEmpresa || '').split(/ - |\/|,/)[0].trim();
  s = s.replace(/\b(S\.?A\.?|LTDA|DTVM|DISTRIBUIDORA.*|GESTORA DE RECURSOS|ADMINISTRADORA.*|ASSET MANAGEMENT|GESTAO DE RECURSOS LTDA)\b/gi, '').trim();
  if (!s) s = String(noEmpresa || '').slice(0, 40);
  // title case simples
  return s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()).trim() || 'Não Classificado';
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const ROOT = __dirname;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadBronze(comp) {
  const cadDir = path.join(ROOT, 'output', 'bronze', 'cadprev', comp);
  const cvmDir = path.join(ROOT, 'output', 'bronze', 'cvm');
  return {
    fundos: readJson(path.join(cadDir, 'fundos.json')),
    carteira: readJson(path.join(cadDir, 'carteira.json')),
    identificacao: readJson(path.join(cadDir, 'identificacao.json')),
    dimFundo: fs.existsSync(path.join(cvmDir, 'dim_fundo.json'))
      ? readJson(path.join(cvmDir, 'dim_fundo.json'))
      : [],
  };
}

// Carteira interna [CNPJ ente -> gerente]. Em produção vem do seu CRM;
// aqui lê um JSON opcional, com fallback vazio.
function loadCarteiraInterna() {
  const p = path.join(ROOT, 'config', 'carteira_interna.json');
  if (!fs.existsSync(p)) return new Map();
  const rows = readJson(p);
  const m = new Map();
  for (const r of rows) {
    const cnpj = normalizeCnpj(r.cnpj_ente);
    if (cnpj) m.set(cnpj, { gerente: r.gerente, territorio: r.territorio });
  }
  return m;
}

/**
 * Silver: constrói o fato atômico com todas as chaves resolvidas.
 */
function buildSilver(bronze, carteiraInterna) {
  const { fundos, carteira, dimFundo } = bronze;

  // índice fundo CVM por CNPJ
  const cvmByCnpj = new Map(dimFundo.map((f) => [f.cnpj_fundo, f]));

  // índices da DAIR_FUNDO_INVEST_ANALISADOS para enriquecer a carteira.
  // Join confirmado: ente + no_fundo normalizado (94% de match no CE).
  // O id_ativo NÃO casa; o CNPJ do fundo não existe na carteira.
  const instByEnteFundo = new Map(); // chave precisa: ente|nome
  const instByFundoGlobal = new Map(); // fallback: nome global (vínculo fundo→gestora é estável)
  for (const r of fundos) {
    const ente = normalizeCnpj(r.nr_cnpj_entidade);
    const nomeNorm = normalizaNome(r.no_fundo);
    if (!nomeNorm) continue;
    const reg = {
      cnpj_empresa: normalizeCnpj(r.nr_cnpj_empresa),
      no_empresa: r.no_empresa || '',
      cnpj_fundo: normalizeCnpj(r.nr_cnpj_fundo),
    };
    if (ente) instByEnteFundo.set(`${ente}|${nomeNorm}`, reg);
    if (!instByFundoGlobal.has(nomeNorm)) instByFundoGlobal.set(nomeNorm, reg);
  }

  const fato = [];
  let semIdent = 0;
  let totalAum = 0;

  for (const c of carteira) {
    const ente = normalizeCnpj(c.nr_cnpj_entidade);
    if (!ente) continue;
    const uf = String(c.sg_uf || '').toUpperCase();
    // vl_total_atual é o valor da posição (confirmado nos dados reais).
    // vl_atual_ativo é valor unitário da cota — NÃO usar. vl_patrimonio é o
    // patrimônio total do RPPS, repetido por linha — NÃO somar.
    const valor = parseBrNumber(c.vl_total_atual);
    if (valor <= 0) continue;
    totalAum += valor;

    // A CARTEIRA não traz CNPJ do fundo (id_ativo é código interno).
    // Resolvemos o grupo pelo nome textual (no_fundo); refinamos com a
    // instituição credenciada (DAIR_FUNDO_INVEST_ANALISADOS) quando casar.
    const nomeFundo = c.no_fundo || '';
    const nomeNorm = normalizaNome(nomeFundo);
    // 1) join com FUNDO_INVEST_ANALISADOS: ente+nome (preciso) ou nome global
    const inst = instByEnteFundo.get(`${ente}|${nomeNorm}`)
      || instByFundoGlobal.get(nomeNorm)
      || null;

    // 2) resolve o grupo/gestora:
    //    a gestora real vem de no_empresa (ex "BB GESTAO DE RECURSOS - DTVM").
    //    Normalizamos ao conglomerado por nome; se não mapear, usamos a própria
    //    gestora como rótulo (melhor que "Não Identificado"); se nem isso, nome do fundo.
    let grupo;
    if (inst && inst.no_empresa) {
      const g = resolveGrupoPorNome(inst.no_empresa);
      grupo = g.grupo !== 'Não Identificado'
        ? g
        : { grupo: rotuloGestora(inst.no_empresa), flagCasa: false };
    } else {
      grupo = resolveGrupoPorNome(nomeFundo);
    }

    const administrador = (inst && inst.no_empresa) || nomeFundo;
    const cnpjGestora = inst && inst.cnpj_empresa;

    const ger = carteiraInterna.get(ente) || { gerente: 'Sem Carteira', territorio: uf };
    if (grupo.grupo === 'Não Identificado') semIdent++;

    fato.push({
      cnpj_ente: ente,
      uf,
      regiao: regiaoFromUf(uf),
      ibge: normalizeIbge(c.cd_ibge || c.co_ibge),
      nome_ente: c.no_ente || '',
      nome_fundo: nomeFundo,
      administrador,
      cnpj_gestora: cnpjGestora || '',
      grupo: grupo.grupo,
      flag_casa: grupo.flagCasa,
      artigo_cmn: c.pc_cmn || '',
      segmento: c.no_segmento || '',
      tipo_ativo: c.no_tipo_ativo || '',
      valor,
      gerente: ger.gerente,
      territorio: ger.territorio,
    });
  }

  return {
    fato,
    qa: {
      linhas_fato: fato.length,
      aum_total: totalAum,
      nao_identificados: semIdent,
      pct_nao_identificado: fato.length
        ? (semIdent / fato.length * 100).toFixed(1) + '%'
        : 'n/a',
    },
  };
}

// ---------------------------------------------------------------------------
// Gold: pré-agregações compactas para o front
// ---------------------------------------------------------------------------

function groupSum(rows, keyFn, valFn = (r) => r.valor) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) || 0) + valFn(r));
  }
  return m;
}

function buildGold(silver, comp) {
  const { fato } = silver;
  const aumTotal = fato.reduce((s, r) => s + r.valor, 0) || 1;

  // Tela 1 — Macro Share
  const porGrupo = [...groupSum(fato, (r) => r.grupo)]
    .map(([grupo, aum]) => ({ grupo, aum, share: +(aum / aumTotal * 100).toFixed(2) }))
    .sort((a, b) => b.aum - a.aum);

  const porUf = [...groupSum(fato, (r) => r.uf)]
    .map(([uf, aum]) => ({ uf, regiao: regiaoFromUf(uf), aum }))
    .sort((a, b) => b.aum - a.aum);

  // share por grupo dentro de cada UF (para o mapa drill-down)
  const porUfGrupo = [...groupSum(fato, (r) => `${r.uf}|${r.grupo}`)]
    .map(([k, aum]) => { const [uf, grupo] = k.split('|'); return { uf, grupo, aum }; });

  // Tela 2 — por Gerente
  const entesPorGerente = new Map();
  for (const r of fato) {
    if (!entesPorGerente.has(r.gerente)) entesPorGerente.set(r.gerente, new Set());
    entesPorGerente.get(r.gerente).add(r.cnpj_ente);
  }
  const aumCasaPorGerente = groupSum(
    fato.filter((r) => r.flag_casa), (r) => r.gerente,
  );
  const aumTotalPorGerente = groupSum(fato, (r) => r.gerente);
  const porGerente = [...entesPorGerente.keys()].map((g) => {
    const casa = aumCasaPorGerente.get(g) || 0;
    const tot = aumTotalPorGerente.get(g) || 0;
    return {
      gerente: g,
      entes: entesPorGerente.get(g).size,
      aum_casa: casa,
      aum_total_territorio: tot,
      share_of_wallet: tot ? +(casa / tot * 100).toFixed(2) : 0,
    };
  }).sort((a, b) => b.aum_total_territorio - a.aum_total_territorio);

  // Tela 3 — Raio-X por ente. Agora com DETALHE completo embutido para
  // drill-down sem ida ao servidor: composição por grupo e por artigo CMN.
  const entesMap = new Map();
  for (const r of fato) {
    if (!entesMap.has(r.cnpj_ente)) {
      entesMap.set(r.cnpj_ente, {
        cnpj_ente: r.cnpj_ente, nome_ente: r.nome_ente, uf: r.uf, regiao: r.regiao,
        gerente: r.gerente, aum: 0,
        por_grupo: new Map(), por_artigo: new Map(), por_segmento: new Map(),
        posicoes: [],
      });
    }
    const e = entesMap.get(r.cnpj_ente);
    e.aum += r.valor;
    e.por_grupo.set(r.grupo, (e.por_grupo.get(r.grupo) || 0) + r.valor);
    if (r.artigo_cmn) e.por_artigo.set(r.artigo_cmn, (e.por_artigo.get(r.artigo_cmn) || 0) + r.valor);
    if (r.segmento) e.por_segmento.set(r.segmento, (e.por_segmento.get(r.segmento) || 0) + r.valor);
    if (r.valor > 0) e.posicoes.push({ fundo: r.nome_fundo, grupo: r.grupo, gestora: r.administrador, artigo: r.artigo_cmn, segmento: r.segmento, valor: r.valor });
  }
  const mapToArr = (m) => [...m].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  const entesDetalhe = [...entesMap.values()].map((e) => ({
    cnpj_ente: e.cnpj_ente, nome_ente: e.nome_ente, uf: e.uf, regiao: e.regiao,
    gerente: e.gerente, aum: e.aum,
    por_grupo: mapToArr(e.por_grupo),
    por_artigo: mapToArr(e.por_artigo),
    por_segmento: mapToArr(e.por_segmento),
    posicoes: e.posicoes.sort((a, b) => b.valor - a.valor).slice(0, 50),
  })).sort((a, b) => b.aum - a.aum);

  // índice leve (para listas e tabelas)
  const entes = entesDetalhe.map((e) => ({
    cnpj_ente: e.cnpj_ente, nome_ente: e.nome_ente, uf: e.uf, regiao: e.regiao,
    gerente: e.gerente, aum: e.aum, n_grupos: e.por_grupo.length,
  }));

  // Drill-down: para cada GRUPO, a lista de entes que investem nele (clicar no Pareto)
  const entesPorGrupo = {};
  for (const r of fato) {
    (entesPorGrupo[r.grupo] = entesPorGrupo[r.grupo] || {});
    entesPorGrupo[r.grupo][r.cnpj_ente] = (entesPorGrupo[r.grupo][r.cnpj_ente] || 0) + r.valor;
  }
  const grupoParaEntes = {};
  for (const [grupo, mapa] of Object.entries(entesPorGrupo)) {
    grupoParaEntes[grupo] = Object.entries(mapa)
      .map(([cnpj, aum]) => {
        const e = entesMap.get(cnpj);
        return { cnpj_ente: cnpj, nome_ente: e?.nome_ente || '', uf: e?.uf || '', aum };
      })
      .sort((a, b) => b.aum - a.aum);
  }

  // Distribuição por enquadramento (artigo CMN) e por segmento — indicadores macro
  const porArtigo = [...groupSum(fato, (r) => r.artigo_cmn || 'Sem classificação')]
    .map(([artigo, aum]) => ({ artigo, aum, share: +(aum / aumTotal * 100).toFixed(2) }))
    .sort((a, b) => b.aum - a.aum);
  const porSegmento = [...groupSum(fato, (r) => r.segmento || 'Sem segmento')]
    .map(([segmento, aum]) => ({ segmento, aum, share: +(aum / aumTotal * 100).toFixed(2) }))
    .sort((a, b) => b.aum - a.aum);

  // KPIs extras de BI
  const aumCasa = fato.filter((r) => r.flag_casa).reduce((s, r) => s + r.valor, 0);
  const naoIdent = fato.filter((r) => r.grupo === 'Não Identificado').reduce((s, r) => s + r.valor, 0);
  const hhi = porGrupo.reduce((s, g) => s + (g.share ** 2), 0); // concentração de mercado

  return {
    competencia: comp,
    gerado_em: new Date().toISOString(),
    kpis: {
      aum_total: aumTotal,
      n_entes: entes.length,
      n_grupos: porGrupo.length,
      ticket_medio: entes.length ? aumTotal / entes.length : 0,
      aum_casa: aumCasa,
      share_casa: +(aumCasa / aumTotal * 100).toFixed(2),
      pct_nao_identificado: +(naoIdent / aumTotal * 100).toFixed(2),
      hhi: Math.round(hhi),
    },
    tela1_macro: { por_grupo: porGrupo, por_uf: porUf, por_uf_grupo: porUfGrupo },
    tela2_gerentes: porGerente,
    tela3_entes_index: entes,
    entes_detalhe: entesDetalhe,
    grupo_para_entes: grupoParaEntes,
    por_artigo: porArtigo,
    por_segmento: porSegmento,
  };
}

// ---------------------------------------------------------------------------
// Deltas entre competências -> alertas
// ---------------------------------------------------------------------------

function buildAlertas(silverAtual, compAtual, compPrev) {
  const prevDir = path.join(ROOT, 'output', 'gold', `silver_${compPrev}.json`);
  if (!fs.existsSync(prevDir)) return { aviso: `silver de ${compPrev} ausente; rode build_gold para ${compPrev} primeiro`, alertas: [] };
  const prev = readJson(prevDir).fato;

  const aumPrev = groupSum(prev, (r) => `${r.cnpj_ente}|${r.grupo}`);
  const aumNow = groupSum(silverAtual.fato, (r) => `${r.cnpj_ente}|${r.grupo}`);

  const alertas = [];
  // mapa por ente|grupo (não só ente): um ente tem vários grupos, cada um com sua flag
  const metaByKey = new Map(
    silverAtual.fato.map((r) => [`${r.cnpj_ente}|${r.grupo}`, { gerente: r.gerente, casa: r.flag_casa }]),
  );
  const gerByEnte = new Map(silverAtual.fato.map((r) => [r.cnpj_ente, r.gerente]));
  // flag casa por grupo (estável entre competências) p/ resolver resgates totais
  const casaByGrupo = new Map();
  for (const r of [...silverAtual.fato, ...prev]) {
    if (!casaByGrupo.has(r.grupo)) casaByGrupo.set(r.grupo, r.flag_casa);
  }

  const keys = new Set([...aumPrev.keys(), ...aumNow.keys()]);
  for (const k of keys) {
    const [ente, grupo] = k.split('|');
    const delta = (aumNow.get(k) || 0) - (aumPrev.get(k) || 0);
    if (Math.abs(delta) < 100000) continue; // limiar de ruído: R$ 100k
    const meta = metaByKey.get(k) || {};
    const gerente = meta.gerente || gerByEnte.get(ente) || 'Sem Carteira';
    const isCasa = meta.casa !== undefined ? meta.casa : casaByGrupo.get(grupo);
    if (delta > 0 && !isCasa) {
      alertas.push({ tipo: 'dinheiro_novo_concorrente', ente, grupo, valor: delta,
        gerente, insight: `Ente ${ente} aplicou R$ ${fmt(delta)} em ${grupo} (concorrente). Oportunidade.` });
    } else if (delta < 0 && isCasa) {
      alertas.push({ tipo: 'resgate_casa', ente, grupo, valor: delta,
        gerente, insight: `Ente ${ente} resgatou R$ ${fmt(-delta)} da casa (${grupo}). Risco de churn — contato prioritário.` });
    }
  }
  // rankeia por valor financeiro, não por data
  alertas.sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
  return { gerado_em: new Date().toISOString(), total: alertas.length, alertas };
}

const fmt = (n) => Math.round(n).toLocaleString('pt-BR');

function main() {
  const args = parseArgs(process.argv);
  const comp = args.comp;
  if (!comp) { console.error('Uso: node build_gold.js --comp=YYYYMM [--prev=YYYYMM]'); process.exit(1); }

  const goldDir = path.join(ROOT, 'output', 'gold');
  fs.mkdirSync(goldDir, { recursive: true });

  const bronze = loadBronze(comp);
  const carteiraInterna = loadCarteiraInterna();
  const silver = buildSilver(bronze, carteiraInterna);

  // persiste o silver (grão atômico) para drill-down e para deltas futuros
  fs.writeFileSync(path.join(goldDir, `silver_${comp}.json`), JSON.stringify({ fato: silver.fato }));

  const gold = buildGold(silver, comp);
  fs.writeFileSync(path.join(goldDir, `painel_${comp}.json`), JSON.stringify(gold));

  let alertas = null;
  if (args.prev) {
    alertas = buildAlertas(silver, comp, args.prev);
    fs.writeFileSync(path.join(goldDir, `alertas_${comp}.json`), JSON.stringify(alertas));
  }

  console.error('[gold] QA:', JSON.stringify(silver.qa, null, 2));
  console.error('[gold] KPIs:', JSON.stringify(gold.kpis, null, 2));
  if (alertas) console.error(`[gold] ${alertas.total} alertas gerados`);
  // guarda de qualidade: se >5% não identificado, sinaliza
  const pct = parseFloat(silver.qa.pct_nao_identificado);
  if (Number.isFinite(pct) && pct > 5) {
    console.error(`[gold] ⚠ ATENÇÃO: ${silver.qa.pct_nao_identificado} de AUM não identificado (limite recomendado 5%). Revise o de-para de grupos e o cadastro CVM.`);
  }
  console.error(`[gold] OK -> ${goldDir}/painel_${comp}.json`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error('[gold] ERRO:', err.message); process.exit(1); }
}

module.exports = { buildSilver, buildGold, buildAlertas };
