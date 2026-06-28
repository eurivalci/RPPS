'use strict';
/**
 * api/painel.js — Serverless Function (Vercel) que serve os payloads Gold
 * ao front single-file. O front NUNCA fala direto com a API do CADPREV nem
 * com a CVM: ele só consome este proxy, que entrega o JSON já agregado.
 *
 * Por que um proxy e não servir o JSON estático direto:
 *   1. Esconde a origem dos dados e qualquer credencial futura (ex.: brapi/B3)
 *      em variável de ambiente server-side — seu padrão de segurança.
 *   2. Permite cache-control e ETag para o navegador, mantendo o painel leve.
 *   3. Ponto único para autorização (token de cliente, rate-limit) quando o
 *      painel virar produto licenciado por gerente/cliente.
 *
 * Rotas (querystring):
 *   /api/painel?comp=202505              -> payload do painel
 *   /api/painel?comp=202505&tipo=alertas -> alertas da competência
 *   /api/painel?comp=202505&ente=NN...   -> raio-x detalhado de um ente (drill-down)
 *
 * Os arquivos Gold ficam em /output/gold (commitados ou em storage). Para
 * grandes volumes, troque readFileSync por fetch a um bucket (S3/R2/Blob).
 */

const fs = require('fs');
const path = require('path');

// Em produção na Vercel, os JSON do Gold são empacotados junto ou buscados de storage.
const GOLD_DIR = process.env.GOLD_DIR || path.join(process.cwd(), 'output', 'gold');

// Allowlist de origens do painel (ajuste aos seus domínios).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'https://painel-rpps.vercel.app').split(',');

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

function safeComp(c) {
  return /^\d{6}$/.test(String(c || '')) ? String(c) : null;
}
function safeEnte(e) {
  return /^\d{14}$/.test(String(e || '')) ? String(e) : null;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ erro: 'método não permitido' }); return; }

  const { comp: compRaw, tipo, ente: enteRaw } = req.query || {};
  const comp = safeComp(compRaw);
  if (!comp) { res.status(400).json({ erro: 'parâmetro comp inválido (esperado YYYYMM)' }); return; }

  try {
    // drill-down de um ente específico (Tela 3) — lê do silver e filtra
    if (enteRaw) {
      const ente = safeEnte(enteRaw);
      if (!ente) { res.status(400).json({ erro: 'cnpj do ente inválido' }); return; }
      const silver = readGold(`silver_${comp}.json`);
      const composicao = silver.fato
        .filter((r) => r.cnpj_ente === ente)
        .map((r) => ({ grupo: r.grupo, administrador: r.administrador,
          nome_fundo: r.nome_fundo, artigo_cmn: r.artigo_cmn, valor: r.valor, flag_casa: r.flag_casa }));
      cacheHeaders(res, 3600);
      res.status(200).json({ comp, ente, composicao });
      return;
    }

    const file = tipo === 'alertas' ? `alertas_${comp}.json` : `painel_${comp}.json`;
    const payload = readGold(file);
    cacheHeaders(res, tipo === 'alertas' ? 1800 : 3600);
    res.status(200).json(payload);
  } catch (err) {
    const code = /ENOENT/.test(err.message) ? 404 : 500;
    res.status(code).json({ erro: code === 404 ? 'competência não encontrada' : 'erro interno' });
  }
};

function readGold(file) {
  const p = path.join(GOLD_DIR, file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cacheHeaders(res, maxAge) {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge * 2}, stale-while-revalidate=86400`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}
