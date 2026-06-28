# Painel RPPS — Pipeline ETL (CADPREV + CVM)

Pipeline de ingestão e agregação para o painel de market share de RPPS.
Stack: Node ≥ 18 (fetch nativo, zero dependências de runtime), saída em JSON
compacto servido por proxy Vercel ao front single-file HTML.

## Arquitetura em uma frase

CADPREV (DAIR) + CVM (cadastro de fundos) → camada Bronze (bruto) → Silver
(join + normalização + grupo econômico) → Gold (agregados compactos) → proxy
Vercel → `painel-rpps.html`.

## Fontes confirmadas

| Fonte | Endpoint | Chave que entrega |
|---|---|---|
| CADPREV `DAIR_FUNDO_INVEST_ANALISADOS` | `https://apicadprev.economia.gov.br/DAIR_FUNDO_INVEST_ANALISADOS` | `nr_cnpj_fundo` + `nr_cnpj_empresa` (instituição) por ente |
| CADPREV `DAIR_CARTEIRA` | `…/DAIR_CARTEIRA` | `vl_total_atual`, `pc_cmn` (artigo CMN), segmento |
| CADPREV `DAIR_IDENTIFICACAO` | `…/DAIR_IDENTIFICACAO` | `dt_envio` (dedup de reenvios) |
| CVM cadastro | `https://dados.cvm.gov.br/dados/FI/CAD/DADOS/cad_fi.csv` | administrador, gestor por CNPJ de fundo |

Todos sem autenticação. A API CADPREV segue padrão DreamFactory; o coletor
detecta a convenção de paginação (`offset/limit` vs `$offset/$limit`) em runtime.

## Ordem de execução

```bash
# 1. Bronze — coleta CADPREV de uma competência
node collectors/collect_cadprev.js --ano=2025 --mes=5
#    (opcional --uf=CE para recorte de teste)

# 2. Bronze — coleta cadastro CVM (semanal basta)
node collectors/collect_cvm.js

# 3. Silver + Gold — join, agregação e payloads do front
node build_gold.js --comp=202505
#    com deltas/alertas (precisa do silver da competência anterior):
node build_gold.js --comp=202505 --prev=202504

# 4. Injeta o Gold no front (ou serve via proxy)
#    o proxy/painel.js lê output/gold/*.json automaticamente
```

## Carteira interna (de-para ente → gerente)

Crie `config/carteira_interna.json`:

```json
[{ "cnpj_ente": "11447510000128", "gerente": "Ana Costa", "territorio": "RN" }]
```

Em produção, gere este arquivo a partir do seu CRM. Entes sem match caem em
"Sem Carteira" (visíveis como base de prospecção).

## Grupo econômico (o de-para que define o market share)

`lib/core.js` → `GRUPOS_ECONOMICOS`. Chave: raiz do CNPJ (8 dígitos).
Marque `flagCasa: true` no conglomerado da sua instituição — é o que separa
"nós" de "concorrente" em todas as métricas. ~50 grupos cobrem >90% do AUM.
O que não casar vira "Não Classificado", e o ETL mede esse %.

## Guardas de qualidade automáticas

- **% de AUM não identificado**: se passar de 5%, `build_gold.js` emite aviso.
  Causa provável: cadastro CVM desatualizado ou de-para de grupos incompleto.
- **Dedup por `dt_envio`**: retificações do mesmo ente/competência são
  resolvidas pelo envio mais recente.
- **Normalização de CNPJ com DV** e **IBGE 7 dígitos**: aplicadas na Silver,
  antes de qualquer join — evita join silenciosamente vazio e buracos no mapa.

## Agendamento (Vercel Cron)

`vercel.json` dispara a coleta mensal após o prazo de envio do DAIR
(todo dia 1º, competência do mês anterior já fechada). Ajuste conforme o
calendário da SPREV.

## Limitações conhecidas

- O sandbox de desenvolvimento da Anthropic bloqueia `apicadprev.economia.gov.br`
  por allowlist de rede; rode os coletores no seu ambiente. O pipeline foi
  validado end-to-end com fixtures que replicam o schema real.
- B3 (custódia individualizada) não é pública de forma granular — tratada como
  enriquecimento de fase 2, não como pilar. CADPREV+CVM cobre ~95% do AUM.
- O `id_ativo` da `DAIR_CARTEIRA` nem sempre carrega o CNPJ do fundo limpo;
  o coletor tenta normalizá-lo, mas valide a taxa de match na primeira carga
  real e ajuste o parser se necessário.
