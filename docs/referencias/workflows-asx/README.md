# Workflows ASX em Producao

Ultima sincronizacao documental: 2026-03-17
Fonte: n8n API em producao

Este diretorio armazena exports/documentacao dos workflows do ASX-Agente.
As alteracoes operacionais acontecem no n8n de producao. Este README descreve
o estado confirmado dos workflows vivos no momento da ultima auditoria.

## Workflows Ativos do Escopo ASX

| ID | Workflow | Tipo | UpdatedAt (UTC) |
|---|---|---|---|
| `QBZhzIYU7qBuE6p5` | 02-Tool-Label (callable) | Sub-workflow | `2026-03-02T18:01:50.453Z` |
| `fRc8nB8qUjJUrTHw` | 02A-Company-Enrich (callable) | Sub-workflow | `2026-03-11T17:28:09.829Z` |
| `gPxoxxAA88LVdZ7Y` | 02B-Score-Lead (callable) | Sub-workflow | `2025-12-15T13:39:10.407Z` |
| `N1b1o3ED1FXDHWBW` | 02C-Agent-Log (callable) | Sub-workflow | `2025-12-15T17:11:51.072Z` |
| `DEwqsmZDj8fIMjuq` | 02D-Find-Distributors (callable) | Sub-workflow | `2026-03-11T17:28:10.115Z` |
| `OvvMcnq571vIb9bK` | 03-Finalize-Handoff (callable) | Sub-workflow | `2026-03-12T15:50:37.835Z` |
| `MlscoOb4IqmMpgQr` | 04-Chatwoot-Message-Logger | Auxiliar | `2026-03-11T17:28:10.529Z` |
| `WBqj1UKzZORCANPo` | 05-Error-Logger | Auxiliar | `2026-03-11T14:38:33.357Z` |
| `7LvmLJIL7CdbWpbt` | 06-FB-Leads-Outbound-Webhook | Principal | `2026-03-12T12:43:23.876Z` |
| `hGsfyVT8TPWau6RH` | 07-FB-Leads-Inbound | Principal | `2026-03-12T12:58:54.201Z` |
| `Oj8SgieQ4HH7Czbk` | 08-Health-Check | Auxiliar | `2026-03-16T12:49:21.750Z` |

## Dependencias entre Workflows

### WF06 -> Sub-workflows

- `06-FB-Leads-Outbound-Webhook`
  - chama `02A-Company-Enrich (callable)`

### WF07 -> Sub-workflows

- `07-FB-Leads-Inbound`
  - Path 2:
    - `02-Tool-Label (callable)`
    - `02C-Agent-Log (callable)`
    - `02D-Find-Distributors (callable)`
  - Path 3:
    - `02B-Score-Lead (callable)`
    - `03-Finalize-Handoff (callable)`
    - `02-Tool-Label (callable)`
    - `02C-Agent-Log (callable)`

## Leitura Rapida por Workflow

### 02-Tool-Label (callable)

- busca contato por telefone no Chatwoot
- aplica labels no contato
- grava evento `label_added`

### 02A-Company-Enrich (callable)

- consulta cache local da tabela `companies`
- se necessario, chama API externa de CNPJ
- faz upsert no cache local

### 02B-Score-Lead (callable)

- calcula `qualified`, `score`, `class` e `priority`

### 02C-Agent-Log (callable)

- grava evento `agent_log`

### 02D-Find-Distributors (callable)

- consulta distribuidores ativos por UF e cidade

### 03-Finalize-Handoff (callable)

- escolhe vendedor
- persiste lead
- cria assignment
- atribui team no Chatwoot
- move inbox no banco do Chatwoot
- notifica vendedor
- grava `handoff_complete`

### 04-Chatwoot-Message-Logger

- espelha mensagens do Chatwoot para a tabela `messages`
- so registra o que pertence a leads qualificados

### 05-Error-Logger

- captura `infra_error` via `Error Trigger`

### 06-FB-Leads-Outbound-Webhook

- recebe leads do Meta
- valida telefone e CNPJ
- classifica `path 1 / 2 / 3`
- cria contato e conversa no Chatwoot
- envia primeira mensagem por WhatsApp

### 07-FB-Leads-Inbound

- recebe mensagem da Evolution
- ignora `fromMe`
- transcreve audio / analisa imagem
- agrupa mensagens em Redis por `msgId`
- roteia para agente Path 2 ou Path 3

### 08-Health-Check

- ping de Evolution e Chatwoot
- leitura de execucoes do `WF06` e `WF07`
- snapshots SQL de lead, mensagem, sinais e handoff

## Pontos de Atencao Confirmados em 2026-03-17

- o `WF06` atual nao contem sync explicito da primeira mensagem para o Chatwoot
- o `WF07` atual tem `unknown_routes_last_24h` e nao possui fallback explicito ligado no `Switch Lead Type`
- o `03-Finalize-Handoff` atual nao persiste `fb_lead_id` em `leads`
- o `WF08` acusa `sem_lead` por depender desse vinculo
- o `Save Recommendations` do `WF06` ainda usa SQL dinamico

## Fora do Escopo

Existem workflows inativos e workflows de teste no projeto do n8n.
Eles nao fazem parte do fluxo ASX documentado aqui e nao devem ser tratados
como fonte primaria do agente SDR.
