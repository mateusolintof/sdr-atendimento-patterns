# ENVIRONMENT — Instituto Dr. Igor

O `.env` na raiz deste repositório é um **bloco de notas de credenciais** para o agente consultar quando precisa chamar APIs (n8n, Chatwoot, Evolution, Supabase). **Não é carregado por nenhuma aplicação.** Os serviços rodam em containers no Portainer e têm suas próprias variáveis de ambiente.

Onde as creds realmente vivem em produção:
- **n8n**: env vars do container Portainer + credentials nomeadas dentro do n8n.
- **Chatwoot / Evolution**: env vars do container Portainer.
- **Supabase**: dashboard do projeto.

O `.env` deste repo só serve para o agente saber os endpoints e tokens quando vai inspecionar/configurar esses serviços. Não há `.env.example` porque não há ninguém clonando o repo para "configurar uma aplicação" — é um repo de artefatos (workflows, migrations, scripts) versionados localmente.

## Categorias de credencial no `.env`

| Prefixo | Para que serve quando o agente lê |
|---|---|
| `N8N_*` | Importar/exportar workflows, listar credentials/tags via API n8n |
| `CHATWOOT_*` | Criar labels, custom attributes, ler inboxes/teams/agents |
| `EVOLUTION_*` | Configurar webhook, bind ao Chatwoot, status de instância |
| `SUPABASE_*` | (Limitado) introspecção via PostgREST; migrations são manuais no SQL Editor |
| `REDIS_*` | Vazio — Redis é embarcado no n8n |
| `OPENAI_*`, `GEMINI_*` | Para criar credentials no n8n quando o agente importar workflows |
| `LANGCHAIN_*` | Opcional, tracing futuro |
| `IGOR_*`, `ALLOW_*` | Flags de proteção que vão para `settings` no Supabase ou env do container n8n |
| `AFTER_HOURS_*`, `CAMPAIGN_*`, `PROMO_*`, `REGULAR_PRICE` | Valores de regra que vão para `settings` no Supabase |
| `TEST_WHATSAPP_NUMBER` | Destino dos testes |
