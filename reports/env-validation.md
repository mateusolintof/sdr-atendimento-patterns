# env-validation

Gerado por `scripts/validate-env.sh` — nenhum valor é exibido.

## Status por variável

| Variável | Status | Categoria |
|---|---|---|
| `IGOR_ENV` | SET | igor-flags |
| `IGOR_DRY_RUN` | SET | igor-flags |
| `ALLOW_REAL_WHATSAPP_SEND` | SET | igor-flags |
| `ALLOW_PRODUCTION_MUTATIONS` | SET | igor-flags |
| `TIMEZONE` | SET | horarios |
| `AFTER_HOURS_START` | SET | horarios |
| `AFTER_HOURS_END` | SET | horarios |
| `CAMPAIGN_SEND_WINDOW_START` | SET | campanha-params |
| `CAMPAIGN_SEND_WINDOW_END` | SET | campanha-params |
| `CAMPAIGN_DAILY_LIMIT` | SET | campanha-params |
| `CAMPAIGN_PER_MINUTE_LIMIT` | SET | campanha-params |
| `PROMO_PRICE` | SET | campanha-params |
| `REGULAR_PRICE` | SET | campanha-params |
| `PROMO_VALID_UNTIL` | SET | campanha-params |
| `N8N_BASE_URL` | SET | n8n |
| `N8N_API_KEY` | SET | n8n |
| `N8N_ENCRYPTION_KEY` | SET | n8n |
| `N8N_WEBHOOK_URL` | SET | n8n |
| `CHATWOOT_BASE_URL` | SET | chatwoot-creds |
| `CHATWOOT_ACCOUNT_ID` | SET | chatwoot-creds |
| `CHATWOOT_API_TOKEN` | SET | chatwoot-creds |
| `CHATWOOT_INBOX_ID` | EMPTY | chatwoot-ids-fase3 |
| `CHATWOOT_HUMAN_TEAM_ID` | EMPTY | chatwoot-ids-fase3 |
| `CHATWOOT_HUMAN_ASSIGNEE_ID` | EMPTY | chatwoot-ids-fase3 |
| `CHATWOOT_HUMAN_AGENT_NAME` | EMPTY | chatwoot-ids-fase3 |
| `EVOLUTION_BASE_URL` | SET | evolution |
| `EVOLUTION_API_KEY` | SET | evolution |
| `EVOLUTION_INSTANCE_NAME` | SET | evolution |
| `SUPABASE_URL` | SET | supabase |
| `SUPABASE_HOST` | SET | supabase |
| `SUPABASE_PROJECT_ID` | SET | supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | SET | supabase |
| `SUPABASE_DB_CONNECTION_STRING` | SET | supabase |
| `REDIS_HOST` | EMPTY | redis-embarcado |
| `REDIS_PORT` | EMPTY | redis-embarcado |
| `REDIS_PASSWORD` | EMPTY | redis-embarcado |
| `OPENAI_API_KEY` | SET | llm |
| `GEMINI_API_KEY` | SET | llm |
| `LANGCHAIN_TRACING_V2` | SET | langsmith |
| `LANGCHAIN_CALLBACKS_BACKGROUND` | SET | langsmith |
| `LANGCHAIN_ENDPOINT` | SET | langsmith |
| `LANGCHAIN_PROJECT` | SET | langsmith |
| `LANGCHAIN_API_KEY` | EMPTY | langsmith |
| `TEST_WHATSAPP_NUMBER` | SET | teste |

## Resumo

- Total: **44**
- SET: **36**
- EMPTY: **8**
- MISSING: **0**

## Vazios esperados (não-bloqueantes nesta fase)

- `CHATWOOT_INBOX_ID`, `CHATWOOT_HUMAN_TEAM_ID`, `CHATWOOT_HUMAN_ASSIGNEE_ID`, `CHATWOOT_HUMAN_AGENT_NAME` — preencher após Fase 3 (Chatwoot).
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — Redis está embarcado no n8n (Portainer); usa credential interna.
- `LANGCHAIN_API_KEY` — LangSmith opcional; tracing efetivamente off.

## Keys no .env que não estão no canônico (possíveis extras)


