# ENVIRONMENT — Instituto Dr. Igor

> Esqueleto. Vai detalhar cada variável de ambiente com tipo, exemplos, escopo, e fase em que se torna obrigatória.

## Convenção

- `IGOR_*` — flags internas do projeto.
- `CHATWOOT_*` — credenciais e IDs do Chatwoot.
- `EVOLUTION_*` — credenciais e instância da Evolution API.
- `N8N_*` — credenciais e URLs do n8n.
- `SUPABASE_*` — credenciais e identificadores do Supabase Cloud.
- `REDIS_*` — Redis externo (mantenha vazio enquanto usar Redis embarcado no n8n).
- `OPENAI_API_KEY`, `GEMINI_API_KEY` — providers LLM.
- `LANGCHAIN_*` — tracing/evals opcional.
- `CAMPAIGN_*`, `AFTER_HOURS_*`, `PROMO_*`, `REGULAR_PRICE` — parâmetros de regra.
- `TEST_WHATSAPP_NUMBER` — destino de testes.

## Estado atual (Fase 0)

| Categoria | Status |
|---|---|
| Igor flags | SET (todas) |
| Horários e campanha | SET |
| n8n | SET (4/4) |
| Chatwoot creds | SET (3/3); IDs de inbox/team/agent vazios (preenchem na Fase 3) |
| Evolution | SET (3/3) |
| Supabase | SET (5/5); pooler conhecido como instável |
| Redis | EMPTY (intencional — Redis está embarcado no n8n) |
| OpenAI/Gemini | SET |
| LangSmith | flags SET, `LANGCHAIN_API_KEY` EMPTY (tracing efetivamente off) |
| Test number | SET |

Veja `reports/env-validation.md` para a tabela exata.
