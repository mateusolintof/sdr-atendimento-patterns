# api-discovery — Instituto Dr. Igor (Fase 0)

Gerado em 2026-05-14. Descoberta **read-only**. Nenhuma mutação foi executada. Tokens mascarados (`tok_***`, `key_***`, `jwt_***`). Telefones mascarados no meio (`+55XX***NN`).

---

## 1. Sumário executivo

| Serviço | Status | Comentário |
|---|---|---|
| **n8n** (https://n8n.almaconvert.com.br) | UP | Token funciona. Instância vazia: 0 workflows, 0 tags, 0 executions. Endpoint `/variables` retorna 403 — feature requer licença paga. |
| **Chatwoot** (https://chat.almaconvert.com.br) | UP | Account `Instituto Dr. Igor` (id=2), versão 4.12.1. Token de administrator funciona. Conta praticamente vazia: 1 agent (administrador), 0 inboxes, 0 teams, 0 labels, 0 custom_attributes, 0 automation_rules, 0 webhooks, 0 canned_responses. |
| **Evolution API** (https://evo.almaconvert.com.br) | UP | Apikey global funciona. 2 instâncias: `dr.igor` (produção, 13.743 msgs) e `convert-teste` (testes, 71 msgs). A do `.env` é `convert-teste`. Webhook = `null` (não configurado). Chatwoot binding = `enabled: false`. |
| **Supabase** (https://xivglsefkzxshqoqjfjp.supabase.co) | UP via DNS externo | DNS local **não resolve** o host (resolver IPv6 link-local). Funcionou com `--resolve` apontando para Cloudflare. PostgREST responde 200 e expõe OpenAPI: **0 tabelas no schema `public`**, apenas a RPC `rls_auto_enable`. |

Conclusão: ambiente novo, limpo, sem dependências externas detectadas — pronto para construir o Igor do zero. Não há fluxo ASX vivo nessas instâncias.

---

## 2. Endpoints testados

| Serviço | Endpoint | Método | Status | Latência (ms) | Notas |
|---|---|---|---|---|---|
| n8n | `/api/v1/workflows` | GET | 200 | 2943 | `{"data":[],"nextCursor":null}` |
| n8n | `/api/v1/tags` | GET | 200 | 495 | `{"data":[],"nextCursor":null}` |
| n8n | `/api/v1/credentials/schema/httpHeaderAuth` | GET | 200 | 500 | smoke ok |
| n8n | `/api/v1/variables` | GET | 403 | 530 | "license does not allow for feat:variables" |
| n8n | `/api/v1/executions?limit=10` | GET | 200 | 550 | vazio |
| chatwoot | `/api/v1/accounts/2` | GET | 200 | 664 | features completas habilitadas |
| chatwoot | `/api/v1/accounts/2/inboxes` | GET | 200 | 504 | `{"payload":[]}` |
| chatwoot | `/api/v1/accounts/2/teams` | GET | 200 | 495 | `[]` |
| chatwoot | `/api/v1/accounts/2/agents` | GET | 200 | 489 | 1 agent (administrator) |
| chatwoot | `/api/v1/accounts/2/labels` | GET | 200 | 496 | `{"payload":[]}` |
| chatwoot | `/api/v1/accounts/2/custom_attribute_definitions` | GET | 200 | 495 | `[]` |
| chatwoot | `/api/v1/accounts/2/automation_rules` | GET | 200 | 527 | `{"payload":[]}` |
| chatwoot | `/api/v1/accounts/2/webhooks` | GET | 200 | 512 | `{"payload":{"webhooks":[]}}` |
| chatwoot | `/api/v1/accounts/2/canned_responses` | GET | 200 | 508 | `[]` |
| evolution | `/instance/fetchInstances` | GET | 200 | 848 | 2 instâncias |
| evolution | `/instance/connectionState/convert-teste` | GET | 200 | 474 | `state: open` |
| evolution | `/webhook/find/convert-teste` | GET | 200 | 475 | `null` (sem webhook) |
| evolution | `/chatwoot/find/convert-teste` | GET | 200 | 471 | `enabled: false` |
| evolution | `/settings/find/convert-teste` | GET | 200 | 484 | `groupsIgnore: true`, demais defaults |
| supabase | `/rest/v1/` | GET | 200 | – | via `curl --resolve` (DNS local falha) |

Dumps mascarados em `scripts/reports/raw/*.json`.

---

## 3. Inventário n8n

- **URL**: `https://n8n.almaconvert.com.br`
- **Auth**: header `X-N8N-API-KEY` aceito (token JWT `jwt_***`)
- **Workflows**: 0
- **Tags**: 0
- **Executions** (últimas 10): 0
- **Variables (global)**: bloqueado por licença (feature Pro). Mitigation: usar `settings` no Supabase + envs do container Portainer para qualquer flag de runtime.

Implicações:
- Não há colisão de nomes com workflows existentes. Podemos importar `IGOR_01..IGOR_13` diretamente.
- Sem `variables` no n8n, **toda configuração de runtime do Igor deve viver em Supabase (`settings`) ou em env vars do container**, jamais hardcoded nos workflows.
- A latência de `/workflows` foi 2,9 s no primeiro hit — provavelmente cold-start. Demais chamadas ~500 ms.

---

## 4. Inventário Chatwoot

- **URL**: `https://chat.almaconvert.com.br`
- **Account**: id=2, name="Instituto Dr. Igor", locale=`pt_BR`, versão Chatwoot 4.12.1, `support_email` configurado (mascarado).
- **Features habilitadas** (relevantes): `agent_bots`, `automations`, `custom_attributes`, `labels`, `campaigns`, `crm`, `auto_resolve_conversations`, `inbox_management`, `team_management`, `assignment_v2`. **Todas as features que o Igor precisa estão ON.**
- **Agentes**: 1 — Mateus Olinto Alves Ferreira (id=1, role=`administrator`, provider=email).
- **Inboxes**: 0 — **bloqueante para Fase 3**: criar 1 inbox API/WhatsApp ligada à Evolution.
- **Teams**: 0 — criar `Time Humano Igor` (ou nome a definir) na Fase 3.
- **Labels**: 0 — Igor precisa criar ~25 labels (origem, automação, receptivo, campanha, segurança). Detalhes no `IMPLEMENTATION_PLAN.md`.
- **Custom attribute definitions**: 0 — Igor precisa criar ~10 attrs de conversa + ~5 attrs de contato. Detalhes no `IMPLEMENTATION_PLAN.md`.
- **Automation rules**: 0 — sem conflito com automações nativas do Chatwoot.
- **Webhooks**: 0 — **vai ser criado na Fase 3/4** apontando para `IGOR_06_Chatwoot_Message_Logger` (evento `message_created`).
- **Canned responses**: 0 — opcional.

---

## 5. Inventário Evolution

- **URL**: `https://evo.almaconvert.com.br`
- **Auth**: header `apikey` (key global) aceito.
- **Instâncias detectadas**:
  - **`dr.igor`** — `connectionStatus: open`, owner Dra Ana Cláudia, telefone WA mascarado `+55XX***62`, integration `WHATSAPP-BAILEYS`. Volume: 13.743 mensagens, 300 contatos, 713 chats. **Esta é a instância de produção da clínica.** Chatwoot binding: `null` (não vinculado). Webhook: não verificado nesta rodada.
  - **`convert-teste`** — `connectionStatus: open`, owner Alma Convert, telefone WA mascarado `+55XX***20`, integration `WHATSAPP-BAILEYS`. Volume: 71 mensagens, 1 contato, 4 chats. **Esta é a instância de testes** (a do `.env` `EVOLUTION_INSTANCE_NAME=convert-teste`).
- **Webhook em `convert-teste`**: `null` (não há webhook configurado).
- **Chatwoot binding em `convert-teste`**: `enabled: false`, url vazia.
- **Settings em `convert-teste`**: `rejectCall=false`, `groupsIgnore=true`, `alwaysOnline=false`, `readMessages=false`, `readStatus=false`, `syncFullHistory=true`. **Defaults ok para testes**; `groupsIgnore=true` evita interagir com grupos por engano.

⚠️ **Atenção crítica para a Fase 5**: existem **DUAS instâncias** abertas (`dr.igor` produção e `convert-teste` testes). O Igor deve operar **exclusivamente em `convert-teste`** até autorização explícita. O `.env` já está apontado para `convert-teste`, mas qualquer ação que use `apikey` global precisa filtrar pelo `instance` correto. Em hipótese alguma o Igor deve mexer em `dr.igor` durante staging.

---

## 6. Inventário Supabase

- **URL**: `https://xivglsefkzxshqoqjfjp.supabase.co`
- **Project ID**: `xivglsefkzxshqoqjfjp`
- **Auth**: header `apikey` + `Authorization: Bearer` com `SUPABASE_SERVICE_ROLE_KEY` (jwt_***) aceitos — HTTP 200 com OpenAPI.
- **Schema `public`**:
  - Tabelas: **0**
  - RPCs: **1** — `rls_auto_enable` (helper para ligar RLS em massa)
- **Schema `auth`/`storage`/etc**: não inspecionados (PostgREST só expõe `db_schemas` configurado; por padrão é `public`).
- **DNS**: o resolver local (IPv6 link-local `fe80::1%14`) **não resolve** o domínio. Google DNS (8.8.8.8) e Cloudflare (1.1.1.1) resolvem para `172.64.149.246` / `104.18.38.10` (Cloudflare CDN). Funcionou via `curl --resolve`.
- **Pooler (`SUPABASE_DB_CONNECTION_STRING`)**: não testado nesta rodada — o usuário já informou que **nunca funciona** para este projeto. Inspeção da string (sem expor) sugere senha com `@` no meio, o que pode quebrar parsing URI; a Fase 2 vai usar SQL Editor manual conforme decidido.

Limitações: introspecção via PostgREST só lista tabelas no schema exposto. Para auditoria plena de `auth.*`, `storage.*`, extensões, RLS, índices, será necessário SQL Editor (Supabase Studio) — caminho já alinhado.

---

## 7. Cross-checks

| Verificação | Resultado |
|---|---|
| Evolution `convert-teste` está bound a algum Chatwoot inbox? | **NÃO** (`Chatwoot: null` no fetchInstances; `enabled: false` em `/chatwoot/find`). Precisa ser feito na Fase 3. |
| Webhook atual do `convert-teste` aponta para algum lugar? | **NÃO** (`null`). Caminho livre para apontar para `IGOR_01_Inbound_AfterHours` quando Fase 4 começar. |
| Há workflows no n8n com nome conflitante com `IGOR_*`? | **NÃO** (0 workflows). |
| Há labels no Chatwoot conflitando com nomes que o Igor vai criar? | **NÃO** (0 labels). |
| Há custom_attribute_definitions com keys conflitantes? | **NÃO** (0). |
| Há tabelas no Supabase `public` conflitando com `contacts`, `conversations`, `leads`, `messages`, `events`, etc.? | **NÃO** (0 tabelas). |
| Existe a RPC `rls_auto_enable` previamente? | **SIM** — vai ser útil quando aplicarmos migration `005_rls_policies.sql`. |
| `EVOLUTION_INSTANCE_NAME` do `.env` existe na API? | **SIM** (`convert-teste` listada em `/fetchInstances`). |
| `CHATWOOT_ACCOUNT_ID=2` corresponde à conta certa? | **SIM** (account name = "Instituto Dr. Igor"). |

---

## 8. Limitações encontradas

1. **DNS local não resolve o domínio Supabase**: usar Cloudflare/Google DNS no resolver da máquina ou rodar scripts/discover via container com DNS configurado. Não afeta produção (n8n na VPS terá DNS correto), mas afeta scripts locais.
2. **n8n sem feature `variables`**: licença atual não permite. Aceitável — Igor vai usar `settings` no Supabase.
3. **PostgREST não introspecciona schemas além de `public`**: para ver `auth`/`storage`/`extensions`, é necessário SQL Editor. Aceitável para Fase 0.
4. **Supabase Management API (PAT) não disponível**: introspecção completa de RLS/policies/triggers via API não é possível. Aceitável — Fase 2 vai entregar SQL para SQL Editor.
5. **Token Chatwoot é de administrador**: tem todas as permissões. Cuidar para não usar o mesmo token em scripts não-controlados.

---

## 9. Recomendações P0 antes de qualquer mutação

1. **Confirmar com o usuário**: instância `convert-teste` é mesmo a única que o Igor pode tocar em staging; instância `dr.igor` (produção, 13k+ msgs) deve ficar intocada até autorização explícita.
2. **Não vincular `convert-teste` ao Chatwoot ainda**: a Fase 3 (Chatwoot) deve primeiro criar o inbox no Chatwoot, depois bind via `POST /chatwoot/set/{instance}`. Ordem inversa pode criar inbox órfã.
3. **Não criar webhook na Evolution ainda**: webhook só depois que `IGOR_01_Inbound_AfterHours` existir no n8n e estiver ATIVO (e validado em dry-run).
4. **Rotacionar segredos expostos no terminal**: durante a auditoria, alguns valores do `.env` apareceram no stdout local (não foram gravados em nenhum arquivo nem commitados). **Recomenda-se rotacionar**: `N8N_API_KEY`, `CHATWOOT_API_TOKEN`, `EVOLUTION_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, senha do Postgres no `SUPABASE_DB_CONNECTION_STRING`. Ver §11.
5. **`reports/raw/*.json` está no `.gitignore`** — não vai ser commitado, mas existe localmente. Se quiser apagar após revisão: `rm -rf scripts/reports/raw/`.

---

## 10. Baseline (snapshot para diff pós-mutação)

| Recurso | Quantidade em 2026-05-14 |
|---|---|
| n8n workflows | 0 |
| n8n tags | 0 |
| n8n executions (últimas 10) | 0 |
| Chatwoot inboxes | 0 |
| Chatwoot teams | 0 |
| Chatwoot agents | 1 (administrador apenas) |
| Chatwoot labels | 0 |
| Chatwoot custom_attribute_definitions | 0 |
| Chatwoot automation_rules | 0 |
| Chatwoot webhooks | 0 |
| Chatwoot canned_responses | 0 |
| Evolution instâncias | 2 (`dr.igor` produção, `convert-teste` testes) |
| Evolution webhooks em `convert-teste` | 0 |
| Supabase tabelas em `public` | 0 |
| Supabase RPCs em `public` | 1 (`rls_auto_enable`) |

---

## 11. Incidente de segurança (transparência)

Durante o diagnóstico de um erro no parser do `.env`, um comando `awk` para inspecionar a estrutura de linhas acabou ecoando os valores das variáveis no stdout do terminal. **Nada foi gravado em arquivo nem commitado**, mas os valores apareceram na conversa de execução. Mitigações tomadas:

- `scripts/discover.sh` agora usa parser próprio (não `source`) e nunca ecoa valores.
- `scripts/mask-secrets.sh` aplicado em todos os `raw/*.json` e headers antes de gravar.
- `.gitignore` cobre `scripts/reports/raw/` para impedir commit acidental.
- `reports/api-discovery.md` e `reports/env-validation.md` foram revisados e contêm apenas valores mascarados.

**Recomendação ao operador**: girar (rotate) os tokens listados em §9.4 e atualizar o `.env`. As chaves giradas devem ser refletidas nas credentials que o n8n vai usar no Igor — não há nenhuma credential criada ainda, então o impacto operacional da rotação é zero.
