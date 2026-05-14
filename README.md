# Instituto Dr. Igor — Automação de Atendimento

Sistema de automação receptiva fora de expediente + campanha promocional ativa para o Instituto Dr. Igor, executando sobre **n8n self-hosted + Chatwoot self-hosted + Evolution API + Supabase Cloud + Redis (embarcado no n8n)**.

## Por onde começar

1. **`AGENTS.md`** — regras de implementação, segurança, estrutura, nomes canônicos dos workflows, fases.
2. **`docs/logica-fluxo-igor-receptivo-fora-expediente.md`** — fluxo 1, lógica funcional completa.
3. **`docs/logica-fluxo-igor-agente-ativo-promocao.md`** — fluxo 2, lógica funcional completa.
4. **`docs/IMPLEMENTATION_PLAN.md`** — plano operacional (workflows, migrations, fixtures, testes, riscos).
5. **`reports/api-discovery.md`** — inventário read-only dos serviços antes de qualquer mutação.
6. **`docs/referencias/workflows-asx/`** — referência técnica de stack (não copiar regras comerciais).

## Estrutura

```
docs/         lógica funcional, plano, runbook, ambiente, referências
n8n/          workflows IGOR_* (importação), exports e backups locais
supabase/     migrations SQL (aplicadas manualmente no Supabase Studio)
chatwoot/     scripts auxiliares (labels, custom attributes)
evolution/    scripts auxiliares (webhook, integração Chatwoot)
fixtures/     payloads de teste (texto, áudio, imagem, documento, fromMe, campanha)
scripts/      validate-env, discover, import/export workflows, smoke tests
reports/      saídas de descoberta read-only e validações
archives/     históricos imutáveis
```

## Segurança

- `.env` real **nunca** vai para o Git (`.gitignore` já configurado).
- Workflows entram inativos; mutações reais exigem flags explícitas.
- Veja `AGENTS.md` para a lista completa de garantias.
