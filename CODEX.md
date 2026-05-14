# CODEX.md — Instituto Dr. Igor

Este projeto segue as regras de `AGENTS.md`. Para qualquer agente de engenharia (Claude Code, Codex, Cursor, etc.) que opere neste repositório:

1. Leia `AGENTS.md` antes de qualquer ação.
2. Use os documentos de lógica funcional como fonte de verdade:
   - `docs/logica-fluxo-igor-receptivo-fora-expediente.md`
   - `docs/logica-fluxo-igor-agente-ativo-promocao.md`
3. Use `docs/referencias/workflows-asx/` apenas como referência técnica de stack — **nunca** copie regras comerciais ASX para o Igor.
4. Não exponha segredos, não execute mutações em produção sem as flags explícitas habilitadas, não altere workflows ASX (não existem nesta instância — mas se aparecerem, registre como anomalia).
5. Consulte `docs/IMPLEMENTATION_PLAN.md` e `reports/api-discovery.md` para o estado atual da implementação antes de propor novas mudanças.
