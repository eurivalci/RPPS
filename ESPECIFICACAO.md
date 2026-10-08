# RPPS Intelligence — Especificação Técnica Completa

**Plataforma de BI para análise de market share de carteiras de RPPS**
Fonte: CADPREV (DAIR) + enriquecimento por gestora · Stack: Node.js + HTML single-file + Vercel

---

## 1. Visão geral

Sistema de inteligência de mercado que consome os dados abertos do CADPREV para
analisar o *share* de bancos e gestoras no universo dos Regimes Próprios de
Previdência Social (RPPS) brasileiros, cruzando com a carteira comercial de
gerentes. O fluxo é um ELT em camadas (Bronze → Silver → Gold) que termina num
painel HTML de arquivo único, sem dependência de servidor de aplicação.

**Instituição "casa" configurada:** Itaú Unibanco.

### Objetivos de negócio atendidos

- Market share por gestora/banco no universo RPPS (nacional e por UF).
- *Share of Wallet* por ente: quanto de cada RPPS está na casa vs. concorrentes.
- Cobertura por gerente comercial: penetração da carteira no território.
- Enquadramento por artigo da Resolução CMN 4.963/2021 (espaço de crescimento).
- Alertas de movimentação (dinheiro novo no concorrente, resgate da casa).

---

## 2. Fontes de dados e descobertas da API

> Esta seção documenta o comportamento **real** da API do CADPREV, apurado
> empiricamente. A documentação oficial é escassa; estes achados são o núcleo
> de conhecimento do projeto.

### 2.1 Endpoint

| Item | Valor |
|---|---|
| Host de produção | `https://apicadprev.trabalho.gov.br` |
| Host antigo (descontinuado) | `https://apicadprev.economia.gov.br` |
| Autenticação | Nenhuma |
| Formato | JSON |

O domínio migrou de `economia` para `trabalho` na reorganização ministerial.
Os coletores tentam os dois hosts e fixam o que responder.

### 2.2 Tabelas consumidas

**`DAIR_CARTEIRA`** — fato de saldo (a carteira propriamente dita).

Campos relevantes: `nr_cnpj_entidade`, `sg_uf`, `no_ente`, `dt_ano`,
`dt_mes_bimestre`, `no_segmento`, `no_tipo_ativo`, `pc_cmn`, `id_ativo`,
`no_fundo`, `vl_total_atual`, `vl_atual_ativo`, `vl_patrimonio`.

**`DAIR_FUNDO_INVEST_ANALISADOS`** — dicionário fundo → gestora.

Campos relevantes: `nr_cnpj_entidade`, `sg_uf`, `dt_mes`, `dt_ano`,
`nr_cnpj_empresa`, `no_empresa`, `nr_cnpj_fundo`, `no_fundo`.

**`DAIR_IDENTIFICACAO`** — metadados de envio (`dt_envio`) para deduplicação.

### 2.3 Regras de acesso apuradas (críticas)

1. **Filtro obrigatório.** A `DAIR_CARTEIRA` recusa varredura total: pedir a
   tabela sem filtro dá **timeout**. É obrigatório filtrar por `sg_uf`.
2. **Sintaxe de filtro:** parâmetros diretos na query — `sg_uf`, `dt_ano`,
   `dt_mes_bimestre`. Nomes alternativos (`uf=`, `filter=` estilo DreamFactory)
   retornam **HTTP 420**.
3. **`sg_uf` é case-sensitive e maiúsculo.** `sg_uf=ce` retorna 0 linhas;
   `sg_uf=CE` funciona.
4. **`dt_mes_bimestre` é MÊS (1–12), não bimestre.** Apesar do nome. Maio = 5.
   (Erro sutil: usar `ceil(mes/2)` coletaria a competência errada.)
5. **Paginação:** `limit` é respeitado e `offset` funciona. `limit` alto
   (ex.: 50000) traz a UF+competência inteira numa requisição. Parâmetros
   `$limit`, `top`, `page_size`, `skip`, `page` → **HTTP 420**.
6. **HTTP 420 = rate limit / requisição inválida.** Tratado com backoff
   exponencial nos coletores.
7. **`DAIR_FUNDO_INVEST_ANALISADOS` usa `dt_mes`** (mensal), não
   `dt_mes_bimestre`. Filtrar essa tabela por `dt_mes_bimestre` dá 420.

### 2.4 Semântica dos campos de valor (apurada nos dados reais)

| Campo | Significado | Uso |
|---|---|---|
| `vl_total_atual` | Valor da posição no ativo | **Somar** (é o AUM) |
| `vl_atual_ativo` | Valor unitário da cota | Não somar |
| `vl_patrimonio` | Patrimônio total do RPPS (repetido por linha) | Não somar (denominador) |

Formato numérico: ponto decimal, sem separador de milhar (ex.: `"6806444.50"`).
O parser tolera também o formato BR (`"6.806.444,50"`).

### 2.5 Chave de join carteira ↔ gestora

A `DAIR_CARTEIRA` **não traz** o CNPJ do fundo (`id_ativo` é código interno,
ex.: `"0268/268-1"`). O vínculo com a gestora vem da
`DAIR_FUNDO_INVEST_ANALISADOS` por:

```
DAIR_CARTEIRA.nr_cnpj_entidade + normaliza(DAIR_CARTEIRA.no_fundo)
    ↔
DAIR_FUNDO_INVEST_ANALISADOS.nr_cnpj_entidade + normaliza(no_fundo)
```

Taxa de match observada no Ceará: **~94%** (34/36 por ente). `normaliza()` =
maiúsculas, sem acento, sem pontuação, espaços colapsados.

---

## 3. Arquitetura do pipeline (ELT em camadas)

```
┌─────────── BRONZE (bruto, por competência) ───────────┐
│ collect_cadprev.js  → DAIR_CARTEIRA (mês)              │
│                       DAIR_FUNDO_INVEST_ANALISADOS     │
│                       DAIR_IDENTIFICACAO (ano/dicion.) │
│ collect_cvm.js      → cad_fi.csv (cadastro CVM, opc.)  │
└───────────────────────────────────────────────────────┘
                          ↓
┌─────────── SILVER (limpo, conformado) ────────────────┐
│ build_gold.js :: buildSilver()                        │
│  - normaliza CNPJ (14 díg + DV) e IBGE (7 díg)        │
│  - join carteira ↔ fundos por ente+nome              │
│  - resolve gestora (no_empresa) → grupo econômico     │
│  - dedup por dt_envio                                  │
│  - grão atômico: [competência × ente × fundo]         │
└───────────────────────────────────────────────────────┘
                          ↓
┌─────────── GOLD (agregados p/ o front) ───────────────┐
│ build_gold.js :: buildGold()                          │
│  - painel_AAAAMM.json  (payload compacto do dashboard)│
│  - alertas_AAAAMM.json (deltas entre competências)    │
│  - silver_AAAAMM.json  (grão atômico p/ drill/deltas) │
└───────────────────────────────────────────────────────┘
                          ↓
              proxy/painel.js (Vercel) ou fetch local
                          ↓
                  painel-rpps.html (BI)
```

### Estratégia de coleta (resolve timeout + 420)

- **Particionamento por UF:** 27 requisições pequenas em vez de 1 varredura
  nacional. Pool de concorrência (default 4 UFs simultâneas).
- **`limit` alto** (`HARD_LIMIT`, default 50000) traz a UF inteira numa página;
  offset como reserva.
- **Backoff exponencial** no 420/429/5xx.
- **`Promise.allSettled`** — erro numa UF não derruba as demais; reporta ao fim.
- **CARTEIRA** filtra por mês (fato); **FUNDOS/IDENTIFICACAO** guardam o ano
  todo (dicionário de enriquecimento — vínculo fundo→gestora é estável).

---

## 4. Modelo de dados (Star Schema)

Grão do fato: `[competência × ente × fundo]`. Star plano (VertiPaq-friendly);
única concessão a snowflake é a resolução de grupo econômico, mantida como
regra de negócio auditável e separada.

### Fato — `fato_aplicacao` (silver)

| Campo | Origem | Descrição |
|---|---|---|
| `cnpj_ente` | CADPREV | CNPJ do ente (14 díg, normalizado) |
| `uf`, `regiao` | CADPREV | localização |
| `nome_fundo` | CADPREV | `no_fundo` |
| `administrador` | join fundos | gestora real (`no_empresa`) |
| `grupo` | resolvido | conglomerado econômico |
| `flag_casa` | resolvido | pertence à instituição casa (Itaú) |
| `artigo_cmn` | CADPREV | `pc_cmn` (enquadramento) |
| `segmento`, `tipo_ativo` | CADPREV | classificação |
| `valor` | CADPREV | `vl_total_atual` |
| `gerente`, `territorio` | carteira interna | atribuição comercial |

### Dimensões

- **dim_ente:** CNPJ, IBGE (7 díg), UF, região, faixa de patrimônio.
- **dim_fundo:** nome, gestora, CNPJ do fundo, grupo.
- **dim_gerente:** gerente, território (via upload da carteira).
- **dim_tempo:** competência AAAAMM.
- **dim_grupo_economico:** de-para `CNPJ/nome → grupo`, com `flag_casa`.

### Métricas (semântica)

```
Market_Share_Grupo   = AUM_grupo / AUM_total          (respeita filtros)
Share_of_Wallet_Ente = AUM_casa_no_ente / AUM_total_ente
Penetracao_Gerente   = nº entes com AUM casa / nº entes no território
Espaco_CMN           = limite_artigo − alocacao_atual_artigo
HHI                  = Σ (share_grupo)²               (concentração)
```

---

## 5. Resolução de grupo econômico

Ordem de resolução por linha da carteira:

1. **Join com `DAIR_FUNDO_INVEST_ANALISADOS`** (ente+nome ou nome global) →
   `no_empresa` (gestora real).
2. **`resolveGrupoPorNome(no_empresa)`** → mapeia ao conglomerado por
   palavra-chave (22 grupos cadastrados: Itaú, BB, Caixa, Bradesco, Santander,
   Banco do Nordeste, Safra, BTG, XP, Banrisul, BRB, Sicredi, Sicoob, Daycoval,
   Vinci, Western, BNP, JGP, SPX, Kinea, Icatu, Credit Suisse).
3. Se a gestora não mapear a conglomerado → usa o **rótulo limpo** da gestora
   (melhor que "Não Identificado").
4. Sem match em nada → **"Não Identificado"** (medido como métrica de qualidade).

**Configuração da casa:** `flagCasa: true` no grupo Itaú, em `GRUPOS_POR_NOME`
e `GRUPOS_ECONOMICOS` (`lib/core.js`).

**Métrica de qualidade:** se AUM "Não Identificado" > 5%, o `build_gold` emite
aviso. Para reduzir, adicionar gestoras regionais em `GRUPOS_POR_NOME`.

---

## 6. Dashboard (painel-rpps.html)

Arquivo único, dark UI, sem servidor. Detecta dados reais automaticamente
(`output/gold/painel_AAAAMM.json`); na ausência, cai em modo demonstração com
aviso visível. Filtros globais: Região, UF, Gerente (recalculam tudo).

### Telas

1. **Visão Geral** — 6 KPIs (AUM, RPPS, gestoras, ticket médio, HHI,
   % não identificado), Pareto de market share, donut de composição,
   concentração por UF, top 10 RPPS. Tudo clicável (drill-down).
2. **Gestoras** — ranking com market share e nº de RPPS. Clique →
   lista de RPPS que investem naquela gestora → clique → raio-x do ente.
3. **Entes (RPPS)** — lista completa com busca; clique abre o **raio-x**:
   composição por gestora, enquadramento CMN, e tabela de posições.
4. **Enquadramento** — alocação por artigo CMN 4.963/2021 e por segmento.
5. **Gerentes** — Share of Wallet por gerente (AUM casa ÷ território).
6. **Dados** — relação plana completa + **exportação CSV** (respeita filtros;
   `;` + BOM UTF-8 para Excel BR).

### Drill-down

Clique em gestora (Pareto/ranking) → entes daquela gestora → raio-x do ente.
Clique em UF → filtra. Clique em ente → raio-x. Breadcrumb para voltar.

---

## 7. Carteira dos gerentes (upload)

- **Formato:** Excel (.xlsx), lido no navegador via SheetJS (CDN).
- **Mapeamento de colunas na subida:** modal lê os cabeçalhos; o usuário associa
  raiz/CNPJ do ente, gerente e território (heurística sugere por nome).
- **Chave de cruzamento:** **raiz do CNPJ do ente (8 primeiros dígitos)**.
- **Escopo:** vale em todo o painel; recalcula gerentes e Share of Wallet;
  destaca "minha carteira" (marcador verde nas listas e coluna no CSV).
- **Detecção de colisão:** avisa se duas raízes iguais tiverem gerentes
  divergentes.
- **Privacidade:** o cruzamento ocorre só na sessão do navegador; o arquivo não
  é persistido no pipeline.

---

## 8. Proxy e deploy (Vercel)

`proxy/painel.js` — serverless function que serve os payloads Gold:

- `GET /api/painel?comp=AAAAMM` → payload do painel
- `GET /api/painel?comp=AAAAMM&tipo=alertas` → alertas
- `GET /api/painel?comp=AAAAMM&ente=CNPJ` → raio-x de um ente (drill sob demanda)

Recursos: cache-control, CORS por allowlist, validação de input contra path
traversal. `vercel.json` agenda a ingestão via cron (mensal para CADPREV,
semanal para CVM).

---

## 9. Estrutura de arquivos

```
CadPrev/
├── lib/core.js                    # CNPJ/IBGE, HTTP resiliente, grupos econômicos
├── collectors/
│   ├── collect_cadprev.js         # coleta particionada por UF (Bronze)
│   └── collect_cvm.js             # cadastro CVM (opcional)
├── build_gold.js                  # Silver + Gold + alertas
├── proxy/painel.js                # serverless Vercel
├── painel-rpps.html               # dashboard BI (single-file)
├── config/carteira_interna.json   # de-para ente→gerente (opcional/legado)
├── vercel.json                    # cron de ingestão
├── diagnose*.js                   # sondas de diagnóstico da API
└── output/
    ├── bronze/cadprev/AAAAMM/     # dados brutos por competência
    └── gold/                      # painel_*.json, alertas_*.json, silver_*.json
```

---

## 10. Runbook

```bash
# 1. Coleta de uma UF (validação rápida)
node collectors/collect_cadprev.js --ano=2025 --mes=5 --uf=CE

# 2. Coleta nacional (27 UFs, alguns minutos)
node collectors/collect_cadprev.js --ano=2025 --mes=5

# 3. (opcional) cadastro CVM
node collectors/collect_cvm.js

# 4. Silver + Gold
node build_gold.js --comp=202505

# 5. Com alertas (requer competência anterior)
node build_gold.js --comp=202504
node build_gold.js --comp=202505 --prev=202504

# 6. Servir o painel (NÃO usar file://; o fetch do JSON exige http)
npx serve .        # ou: python3 -m http.server
```

### Variáveis de ambiente

| Variável | Default | Efeito |
|---|---|---|
| `CADPREV_BASE` | auto | força o domínio da API |
| `PAGE_SIZE` / `HARD_LIMIT` | 100 / 50000 | tamanho de página |
| `CONCURRENCY` | 4 | UFs em paralelo |
| `GOLD_DIR` | `output/gold` | origem dos payloads no proxy |
| `ALLOWED_ORIGINS` | — | CORS do proxy |

### Diagnóstico

Se a coleta falhar ou vier vazia, as sondas isolam a causa:

- `diagnose.js` — conectividade, host, sintaxe de filtro.
- `diagnose_pagina.js` — teto de resposta, limit, offset.
- `diagnose_campos.js` — semântica de dt_mes_bimestre e nomes de campos.
- `diagnose_valores.js` — qual campo de valor somar.
- `diagnose_fundos.js` — estrutura e chave de join da tabela de fundos.

---

## 11. Padrões de engenharia adotados

- **Zero dependências de runtime** nos coletores (fetch nativo, Node ≥ 18).
- **`node --check`** em todo arquivo antes de entrega; testes unitários de
  parsing, join, dedup e das views do dashboard.
- **Normalização na Silver, antes de qualquer join** (CNPJ com DV, IBGE 7 díg)
  — evita join silenciosamente vazio.
- **LEFT join, nunca INNER** — AUM sem match vira "Não Identificado" medido,
  em vez de sumir e inflar o share dos grandes.
- **Guardas de qualidade** com aviso automático (% não identificado > 5%).
- **Sem fallback para dado sintético** — falha visível, não silenciosa.

---

## 12. Estado atual e próximos passos

**Validado:** coleta nacional funcional; join carteira→gestora ~94%; painel com
drill-down, enquadramento, aba Dados/CSV; upload de carteira por raiz; flag casa
= Itaú com Share of Wallet operante.

**Pendências conhecidas:**

- **Não Identificado nacional ~13% (R$ 35,1 bi).** Redutível adicionando
  gestoras regionais em `GRUPOS_POR_NOME`. Próximo passo sugerido: relatório dos
  maiores fundos não identificados para priorizar o mapeamento manual.
- **Refinamento via CVM** por `nr_cnpj_fundo` (agora disponível na tabela de
  fundos) como segunda camada de resolução, se necessário.
- **Persistência opcional** da carteira dos gerentes (hoje só em sessão).
- **Alertas** dependem de coletar 2 competências consecutivas.

---

*Documento gerado a partir do estado real do código. Instituição casa: Itaú
Unibanco. Fonte de dados: CADPREV / Ministério da Previdência Social.*
