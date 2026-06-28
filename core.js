'use strict';
/**
 * core.js — utilitários compartilhados do ETL CADPREV/CVM.
 * Sem dependências externas (usa fetch nativo do Node >= 18).
 *
 * Princípios de design:
 *  - Toda chave de cruzamento (CNPJ) passa por normalizeCnpj ANTES de qualquer join.
 *    Divergência de formatação entre CADPREV e CVM é a causa nº1 de join silenciosamente
 *    vazio. Aqui ela é eliminada na fonte.
 *  - O cliente HTTP é resiliente a duas convenções de paginação (DreamFactory $offset/$limit
 *    e offset/limit cru), porque a doc pública do CADPREV não fixa qual está ativa.
 *  - Nada de fallback para dado sintético. Se a fonte falhar, o erro sobe — visível.
 */

// ---------------------------------------------------------------------------
// CNPJ
// ---------------------------------------------------------------------------

/**
 * Normaliza CNPJ para 14 dígitos (string), removendo máscara e aplicando
 * left-pad de zeros. Retorna null se não houver 14 dígitos extraíveis.
 */
function normalizeCnpj(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 14) return null;
  return digits.padStart(14, '0');
}

/** Valida os dígitos verificadores de um CNPJ já normalizado (14 dígitos). */
function isValidCnpj(cnpj14) {
  if (!/^\d{14}$/.test(cnpj14)) return false;
  if (/^(\d)\1{13}$/.test(cnpj14)) return false; // rejeita sequências repetidas
  const calc = (base, pesos) => {
    const soma = base
      .split('')
      .reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = calc(cnpj14.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = calc(cnpj14.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv1 === Number(cnpj14[12]) && dv2 === Number(cnpj14[13]);
}

// ---------------------------------------------------------------------------
// IBGE
// ---------------------------------------------------------------------------

/**
 * Padroniza código IBGE para 7 dígitos (com DV). O CADPREV ora traz 6, ora 7.
 * O Power BI e shapefiles de município usam 7 — padronizar evita "buracos" no mapa.
 * Se vier com 6 dígitos, calcula e anexa o DV.
 */
function normalizeIbge(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 7) return digits;
  if (digits.length === 6) return digits + String(ibgeCheckDigit(digits));
  return null;
}

/** DV do código IBGE de município (algoritmo oficial do IBGE). */
function ibgeCheckDigit(code6) {
  const pesos = [1, 2, 1, 2, 1, 2];
  let soma = 0;
  for (let i = 0; i < 6; i++) {
    let p = Number(code6[i]) * pesos[i];
    if (p >= 10) p = Math.floor(p / 10) + (p % 10); // soma dos dígitos
    soma += p;
  }
  const dv = (10 - (soma % 10)) % 10;
  return dv;
}

// ---------------------------------------------------------------------------
// Parsing numérico tolerante (campos vêm como VARCHAR com vírgula decimal)
// ---------------------------------------------------------------------------

/**
 * Converte valores monetários string em Number. O CADPREV declara vários
 * campos de valor como VARCHAR(8000) com vírgula decimal brasileira.
 * Trata "1.234.567,89", "1234567.89" e "" (vazio -> 0).
 */
function parseBrNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim();
  if (s === '') return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // formato BR: ponto de milhar, vírgula decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Região a partir da UF
// ---------------------------------------------------------------------------

const UF_REGIAO = {
  AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste',
  PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul',
};

function regiaoFromUf(uf) {
  return UF_REGIAO[String(uf || '').toUpperCase()] || 'Desconhecida';
}

// ---------------------------------------------------------------------------
// Cliente HTTP resiliente
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET com retry exponencial e timeout. Lança após esgotar tentativas.
 */
async function httpGetJson(url, { retries = 4, timeoutMs = 30000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', ...headers },
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} (retryable)`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (fatal) em ${url}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const fatal = /fatal/.test(err.message);
      if (fatal || attempt === retries) break;
      const backoff = Math.min(1000 * 2 ** attempt, 15000);
      await sleep(backoff);
    }
  }
  throw new Error(`Falha ao buscar ${url}: ${lastErr && lastErr.message}`);
}

/**
 * Pagina um endpoint que pode usar offset/limit OU $offset/$limit.
 * Detecta a convenção testando a primeira página; depois fixa a que funcionou.
 * `extract` recebe o corpo da resposta e devolve o array de registros
 * (algumas APIs encapsulam em { resource: [...] }).
 */
async function paginate(baseUrl, {
  pageSize = 1000,
  maxPages = 10000,
  extraQuery = '',
  extract = (body) => (Array.isArray(body) ? body : body.resource || body.data || []),
  httpOpts = {},
} = {}) {
  const conventions = [
    (off, lim) => `${baseUrl}?${q(extraQuery)}offset=${off}&limit=${lim}`,
    (off, lim) => `${baseUrl}?${q(extraQuery)}$offset=${off}&$limit=${lim}`,
  ];
  let conv = null;
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    let rows;
    if (conv === null) {
      // descoberta: tenta as duas convenções na primeira página
      let detected = null;
      for (const c of conventions) {
        try {
          const body = await httpGetJson(c(offset, pageSize), httpOpts);
          const r = extract(body);
          if (Array.isArray(r)) { detected = c; rows = r; break; }
        } catch (_) { /* tenta a próxima convenção */ }
      }
      if (!detected) {
        throw new Error(`Nenhuma convenção de paginação respondeu em ${baseUrl}`);
      }
      conv = detected;
    } else {
      const body = await httpGetJson(conv(offset, pageSize), httpOpts);
      rows = extract(body);
    }
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < pageSize) break; // última página
  }
  return all;
}

function q(extra) {
  if (!extra) return '';
  return extra.endsWith('&') ? extra : extra + '&';
}

// ---------------------------------------------------------------------------
// De-para de grupo econômico (conglomerado).
// Cobre os maiores detentores de AUM de RPPS. Expanda conforme necessário —
// ~50 grupos cobrem >90% do mercado. Mantido aqui como fonte única e auditável.
// Chave: prefixo de 8 dígitos do CNPJ (raiz). Valor: nome do grupo + flag casa.
// ---------------------------------------------------------------------------

const GRUPOS_ECONOMICOS = {
  // raiz CNPJ (8 díg) : { grupo, flagCasa }
  '00000000': { grupo: 'Banco do Brasil', flagCasa: false },
  '60746948': { grupo: 'Bradesco', flagCasa: false },
  '60872504': { grupo: 'Itaú Unibanco', flagCasa: false },
  '00360305': { grupo: 'Caixa Econômica Federal', flagCasa: true },
  '90400888': { grupo: 'Santander', flagCasa: false },
  // ... preencher com a raiz dos administradores/gestores reais.
  // O ETL marca como "Não Classificado" o que não casar — e mede esse %.
};

/**
 * Resolve grupo econômico a partir do CNPJ do administrador ou gestor.
 * Usa a raiz (8 primeiros dígitos). Retorna objeto com grupo e flagCasa.
 */
function resolveGrupo(cnpj14) {
  if (!cnpj14) return { grupo: 'Não Identificado', flagCasa: false };
  const raiz = cnpj14.slice(0, 8);
  return GRUPOS_ECONOMICOS[raiz] || { grupo: 'Não Classificado', flagCasa: false };
}

module.exports = {
  normalizeCnpj,
  isValidCnpj,
  normalizeIbge,
  ibgeCheckDigit,
  parseBrNumber,
  regiaoFromUf,
  httpGetJson,
  paginate,
  resolveGrupo,
  GRUPOS_ECONOMICOS,
  UF_REGIAO,
};
