# RUNBOOK — Instituto Dr. Igor

> Esqueleto. Será preenchido nas Fases 4-6 com procedimentos operacionais.

## Sumário planejado

1. Diagnóstico rápido (health check, logs n8n, eventos Supabase).
2. Pausar Igor em runtime (`settings.ai_enabled_global = false`).
3. Pausar workflow específico (`settings.workflows_enabled.IGOR_XX = false`).
4. Trocar credencial sem reimportar workflows.
5. Reprocessar mensagem perdida.
6. Conta sob ataque / opt-out em massa.
7. Restaurar backup de workflows.
8. Recarregar fixtures.

## Estado atual

Fase 0 concluída — apenas auditoria e plano. Procedimentos operacionais ainda não são aplicáveis.
