# Instituto Dr. Igor — Automação de Atendimento

Sistema de automação receptiva fora de expediente + campanha promocional ativa para o Instituto Dr. Igor, executando sobre **n8n self-hosted + Chatwoot self-hosted + Evolution API + Supabase Cloud + Redis (embarcado no n8n)**.

## Por onde começar

1. **`docs/ARCHITECTURE.md`** — fonte de verdade arquitetural (topologia, IDs, fluxos node-by-node, dívida atual).
2. **`AGENTS.md`** — regras de implementação, segurança, nomes canônicos dos workflows.
3. **`docs/logica-fluxo-igor-receptivo-fora-expediente.md`** — fluxo 1, lógica funcional completa.
4. **`docs/logica-fluxo-igor-agente-ativo-promocao.md`** — fluxo 2, lógica funcional completa.
5. **`docs/IMPLEMENTATION_PLAN.md`** — contratos de cada workflow IGOR_*.
6. **`docs/VALIDATION_REPORT.md`** — estado atual + IDs n8n + pendências.
7. **`docs/RUNBOOK.md`** — procedimentos operacionais.
8. **`docs/referencias/workflows-asx/`** — referência técnica de stack (não copiar regras comerciais).

## Estrutura

```
docs/                lógica funcional, plano, runbook, arquitetura, referências
docs/workflows/      audit doc por workflow IGOR_*
n8n/workflows/       JSONs canônicos + SDK source dos workflows IGOR_*
supabase/migrations/ SQL idempotente (aplicado manualmente no Supabase Studio)
scripts/             utilitários: discover, import workflow, mask secrets, kommo CSV import
lista-leads/         CSVs do Kommo (input do scripts/import-kommo-csv.py — gitignored)
.claude/             config local da sessão Claude Code (gitignored)
                     └── CREDENCIAIS.md  ← credenciais que o agente consulta
```

## Credenciais e segurança

- **Credenciais reais** vivem em `.claude/CREDENCIAIS.md` (gitignored) — o agente lê quando precisa chamar APIs.
- **Containers Portainer** (n8n, Chatwoot, Evolution) têm suas próprias env vars internas — não são alimentadas pelo repositório.
- **n8n credentials** (API keys, tokens) são criadas via UI do n8n com nomes canônicos (`igor_chatwoot_api`, `igor_evolution_api`, `igor_openai`, `igor_supabase_postgres`, `igor_redis_embedded`). Workflows referenciam por nome.
- **Workflows IGOR_*** nascem inativos. Ativação depende de gates `settings.dry_run_send` e `settings.allow_real_whatsapp_send` no Supabase.
- Detalhes completos em `AGENTS.md` e `docs/ARCHITECTURE.md §5-§6`.
