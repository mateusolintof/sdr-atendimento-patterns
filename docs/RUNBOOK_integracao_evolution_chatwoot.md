# Runbook — Integração Evolution API ↔ Chatwoot (execução manual)

> 🖼️ **Versão visual (recomendada para o time):** guia interativo passo a passo com telas anotadas — [`docs/runbooks/evolution-chatwoot/runbook.html`](runbooks/evolution-chatwoot/runbook.html) · Artifact: https://claude.ai/code/artifact/8bd4a517-83c0-478f-acba-3041bf56eb54
>
> Este documento `.md` é o **fallback textual**; a versão visual é a fonte de verdade para o passo a passo.

> **Objetivo:** ligar uma instância da Evolution API a uma account do Chatwoot para que **toda mensagem de WhatsApp caia automaticamente na inbox do Chatwoot** (contatos + conversas armazenados) e o atendente possa **responder pelo Chatwoot**. Isso entrega o painel omnichannel base, **sem nenhuma automação** (n8n vem depois).
>
> **Modo de execução:** 100% manual, por um humano, pelas telas (UI) do Chatwoot e do Evolution Manager. Sem IA, sem script.
>
> **Versões alvo:** Evolution API `2.3.7` · Chatwoot `4.13.0`
>
> **Tempo estimado:** ~15 min por cliente · **Perfil necessário:** superadmin do Chatwoot + acesso ao Evolution Manager.

---

## 0. Visão geral — o mapeamento por cliente

Para cada cliente a relação é sempre **1 : 1 : 1**:

```
1 instância Evolution   ↔   1 account Chatwoot   ↔   1 inbox (tipo API)
```

Dois fatos que simplificam o trabalho:

1. **A inbox nasce sozinha.** Com o campo `Auto Create` ligado, a **própria Evolution cria a inbox do tipo API** dentro da account do Chatwoot e já configura o webhook de retorno (o que faz a resposta do atendente sair no WhatsApp). Você **não** cria a inbox à mão.
2. **Isto é independente do n8n.** O n8n é um segundo webhook, configurado à parte. Este runbook não o toca.

O que você prepara à mão: a **account** do cliente e um **usuário admin** nela.

---

## Parte A — Preparar o Chatwoot

### A1. Criar a account do cliente
1. Entre no Chatwoot como **superadmin**.
2. **Super Admin Console** → **Accounts** → **New Account**.
3. Dê o nome do cliente (ex.: `Instituto Dr. Igor`) e salve.

### A2. Garantir um usuário Administrator na account
1. Entre na account recém-criada.
2. **Settings → Agents** → confirme que existe (ou adicione) um usuário com papel **Administrator**.
3. A integração vai agir "em nome" desse usuário — por isso ele precisa ser admin (a Evolution cria inbox, contatos e conversas).

### A3. Anotar os 2 valores que a Evolution vai pedir

| Valor | Onde pegar | Exemplo |
|---|---|---|
| **Account ID** | É o número `N` na URL quando você está dentro da account: `.../app/accounts/`**`N`**`/...` | `2` |
| **Access Token** | Avatar (canto inferior esquerdo) → **Profile Settings** → role até **Access Token** → copie o valor | `xxxxxxxxxxxxxxxx` |

> ⚠️ Use o **Access Token do perfil de um usuário Administrator**. **Não** use token de inbox nem de "Agent Bot" — eles não têm permissão para criar a inbox.

> 🔒 Trate o Access Token como senha. Anote em local seguro (ex.: `.claude/CREDENCIAIS.md`, que é gitignored). Nunca cole em chat, commit ou print.

---

## Parte B — Preparar a instância na Evolution

### B1. Criar/localizar a instância
1. Abra o **Evolution Manager**.
2. Crie uma instância nova para o cliente (ou localize a existente). Anote o **nome da instância** (ex.: `instituto-igor`).

### B2. Conectar o WhatsApp
1. Na instância, gere o **QR Code**.
2. No celular do cliente: **WhatsApp → Aparelhos conectados → Conectar um aparelho** → escaneie.
3. Confirme que o status da instância ficou **`open`/conectado**.

> Só avance para a Parte C com a instância **conectada**. Sem conexão, a integração não recebe mensagens.

---

## Parte C — Configurar a integração Chatwoot na Evolution

1. No Evolution Manager, abra a instância do cliente → seção **Integrations → Chatwoot** (ou "Chatwoot" no menu da instância).
2. Preencha os campos abaixo. A coluna **"O que preencher"** já traz os valores recomendados para o cenário omnichannel.

| Campo | O que preencher | Por quê |
|---|---|---|
| **Enabled** | `ligado` | Ativa a integração. |
| **Account ID** | o `N` da account (ex.: `2`) | Diz em qual account do Chatwoot as conversas caem. |
| **Token** | o Access Token do admin (Parte A3) | Autentica a Evolution na API do Chatwoot. |
| **URL** | `https://SEU-CHATWOOT` **sem `/` no final** | URL base do Chatwoot. Barra no final quebra a integração. |
| **Name Inbox** | nome único e estável (ex.: `instituto-igor`) | Nome da inbox que será criada. |
| **Auto Create** | `ligado` | **Cria a inbox API + webhook de retorno + contato-bot automaticamente.** É o que dispensa criar a inbox à mão. |
| **Sign Msg** | `desligado` (sugestão) | Se ligado, anexa a assinatura do atendente ("— Fulano") nas mensagens. Deixe desligado para WhatsApp limpo. |
| **Sign Delimiter** | `\n` | Só usado se Sign Msg estiver ligado. |
| **Reopen Conversation** | `ligado` | Mensagem nova reabre a **mesma** conversa em vez de criar outra → mantém o histórico junto. |
| **Conversation Pending** | `desligado` | Desligado = conversa entra como **open**. Ligue só se quiser que tudo chegue como "pending" para triagem. |
| **Merge Brazil Contacts** | `ligado` | **Essencial no Brasil.** Resolve o 9º dígito (mescla `+55DDD9XXXX` e `+55DDDXXXX` no mesmo contato). Sem isso, contatos duplicam. |
| **Import Contacts** | `ligado` (opcional) | Importa a agenda do WhatsApp para o Chatwoot ao conectar. |
| **Import Messages** | `ligado` (opcional) | Importa histórico recente ao conectar. |
| **Days Limit Import Messages** | `7` (sugestão) | Limita a importação aos últimos N dias. Valor alto é pesado e polui a inbox. |
| **Organization** | `Bot` | Nome do **contato-bot** que a Evolution cria no Chatwoot (usado para enviar comandos pela inbox). |
| **Logo** | (opcional) URL de imagem | Foto de perfil do contato-bot. |

3. **Salvar.**

> Ao salvar com **Auto Create ligado**, a Evolution cria a inbox no Chatwoot em segundos. Você **não** precisa ir ao Chatwoot criar canal nenhum.

---

## Parte D — Verificação (não pule)

Marque cada item:

- [ ] **Inbox criada:** Chatwoot → **Settings → Inboxes** → aparece a inbox com o `Name Inbox` escolhido, do tipo **API**.
- [ ] **Contato-bot:** existe um contato chamado `Bot` (ou o valor de *Organization*) na account.
- [ ] **Recebimento:** envie uma mensagem de um WhatsApp de teste para o número do cliente → em poucos segundos surge uma **conversa nova** na inbox.
- [ ] **Envio:** responda **pelo Chatwoot** → a resposta chega no WhatsApp do remetente. *(valida o webhook de retorno)*
- [ ] **Sem duplicidade:** o contato de teste aparece **uma única vez** (valida o *Merge Brazil Contacts*).

Se os 5 passarem, o omnichannel base está funcionando.

---

## Parte E — Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| Recebe mas **não envia** pelo Chatwoot | `URL` com `/` no final **ou** token sem permissão de admin **ou** webhook de retorno ausente | Remova a barra final; use token de admin; confirme *Auto Create* ligado ao salvar. |
| **Nada** chega na inbox | Instância não conectada, `Account ID` errado, ou `Enabled` desligado | Reconecte o WhatsApp (Parte B); confira o `N` da account; ligue *Enabled*. |
| **Contatos duplicados** (com/sem o 9) | *Merge Brazil Contacts* desligado | Ligue e salve novamente. |
| Inbox **não** foi criada | *Auto Create* desligado, ou token/URL inválidos | Ligue *Auto Create*, revise token e URL, salve de novo. |
| Muitas conversas antigas poluindo a inbox | *Days Limit Import Messages* alto demais | Reduza para 7 (ou desligue *Import Messages*). |

---

## Apêndice 1 — Checklist rápido (para colar em cada onboarding)

```
CLIENTE: ______________________

[ ] Chatwoot: account criada
[ ] Chatwoot: usuário admin confirmado
[ ] Anotado Account ID (N): _____
[ ] Anotado Access Token (admin): __________ (guardar em local seguro)
[ ] Evolution: instância criada — nome: __________
[ ] Evolution: WhatsApp conectado (status open)
[ ] Evolution: integração Chatwoot preenchida e salva (Auto Create ligado)
[ ] Verificação D: inbox criada
[ ] Verificação D: recebe mensagem
[ ] Verificação D: envia mensagem
[ ] Verificação D: sem contato duplicado
```

---

## Apêndice 2 — Fallback via API (se algum campo faltar na UI do Manager)

Algumas versões do Evolution Manager não expõem todos os campos. Se faltar algum, dá para setar tudo de uma vez por uma chamada única (ainda manual — colar no terminal ou num cliente REST):

```
POST  https://SUA-EVOLUTION/chatwoot/set/{instance}
Header  apikey: <EVOLUTION_API_KEY>
Header  Content-Type: application/json
```

Corpo:

```json
{
  "enabled": true,
  "accountId": "2",
  "token": "<ACCESS_TOKEN_ADMIN_CHATWOOT>",
  "url": "https://SEU-CHATWOOT",
  "nameInbox": "instituto-igor",
  "autoCreate": true,
  "signMsg": false,
  "signDelimiter": "\n",
  "reopenConversation": true,
  "conversationPending": false,
  "mergeBrazilContacts": true,
  "importContacts": true,
  "importMessages": true,
  "daysLimitImportMessages": 7,
  "organization": "Bot",
  "logo": ""
}
```

Conferir o que está setado (não altera nada):

```
GET  https://SUA-EVOLUTION/chatwoot/find/{instance}
Header  apikey: <EVOLUTION_API_KEY>
```

---

## Apêndice 3 — Criar a inbox API manualmente (só se NÃO usar Auto Create)

Normalmente desnecessário. Use apenas se, por algum motivo, você quiser controlar a inbox à mão:

1. Chatwoot → **Settings → Inboxes → Add Inbox**.
2. Escolha a opção **API** (não WhatsApp, não Website).
3. **Channel Name**: o mesmo valor de `Name Inbox`.
4. **Webhook URL / Callback URL**: cole a URL de webhook da Evolution para essa instância (é o endereço para onde o Chatwoot envia as mensagens de saída). *Com Auto Create, a Evolution preenche isso sozinha — por isso a rota automática é mais simples.*
5. Adicione os agentes à inbox.

---

## Notas de contexto (ambiente da agência)

- **Um webhook Evolution ativo por vez, por instância.** Quando futuramente ligar o n8n por cima, evite ter dois destinos de webhook disputando a mesma instância (lição do incident 2026-05-18). A integração Chatwoot (`/chatwoot/set`) e o webhook do n8n (`/webhook/set`) são configurações **separadas** — este runbook mexe só na primeira.
- Este procedimento entrega **apenas o omnichannel base**. Automação (labels, macros, automation rules do Chatwoot, ou fluxos n8n) é etapa posterior, construída por cima desta fundação.
