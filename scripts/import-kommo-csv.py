#!/usr/bin/env python3
"""
import-kommo-csv.py — Importa CSVs do Kommo para Supabase (contacts/leads/campaign_contacts).

Uso:
  python3 scripts/import-kommo-csv.py [--apply]

Sem --apply: modo dry-run, só imprime preview do que seria inserido.
Com --apply: escreve no Supabase via PostgREST (requer migrations 001-006 já aplicadas).

Lê todos os arquivos `lista-leads/*.csv` e dedup por `ID` do Kommo.
Pula:
  - telefone inválido (não vira 55+DDD+9 dígitos)
  - etapa Kommo == AGENDADO (regra fechada em 2026-05-14)
  - duplicata por ID Kommo entre CSVs (fica com a primeira ocorrência)
  - duplicata por phone (se outro lead já tem mesmo número, prefere o primeiro)

Não imprime tokens. Suporta DNS local quebrado via fallback --resolve.
"""

import argparse
import csv
import json
import os
import re
import socket
import ssl
import sys
import urllib.request
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
CSV_DIR = ROOT / "lista-leads"
CAMPAIGN_ID = "00000000-0000-0000-0000-000000000001"  # 006_campaign_seed_2026-05.sql
SOURCE = "kommo_2026-05-14"


def load_env(path: Path) -> dict:
    """Parser seguro do .env — ignora linhas malformadas."""
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m:
            v = m.group(2).strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            env[m.group(1)] = v
    return env


PHONE_RE = re.compile(r"\D+")


def normalize_phone(raw: str) -> Optional[str]:
    """Normaliza telefone BR para `55DDDNNNNNNNNN` ou retorna None se inválido.

    Aceita formatos:
      '+5562998765432, '+556298765432, 62998765432, 5562998765432, 6298765432, etc.
    """
    if not raw:
        return None
    digits = PHONE_RE.sub("", raw)
    if not digits:
        return None
    # Remove código país 55 inicial duplicado / sem
    if digits.startswith("55"):
        digits = digits[2:]
    # Agora deve ter: DDD (2) + 8 ou 9 dígitos
    if len(digits) == 10:  # DDD + 8 dígitos (fixo) — adicionar 9 no celular se for móvel
        ddd, num = digits[:2], digits[2:]
        # heurística: WhatsApp BR usa 9 antes do número móvel
        if num[0] in "6789":
            digits = ddd + "9" + num
    if len(digits) != 11:
        return None
    ddd = digits[:2]
    if not (11 <= int(ddd) <= 99):
        return None
    return "55" + digits


def build_kommo_data(row: dict) -> dict:
    """Empacota campos ricos do Kommo em dict para coluna jsonb."""
    keep = [
        "Funil de vendas", "Etapa do lead", "Tags",
        "Motivo não agendamento", "Motivo de perda",
        "Capacidade financeira/Investimento", "Urgência",
        "Disponibilidade", "Busca medicação", "Tentativas anteriores",
        "Perguntou método", "Canal preferido", "Especialidade",
        "Resposta IA", "Ultima mensagem", "Primeiro Contato",
        "Próxima consulta", "Endereço da clínica",
    ]
    out = {}
    for k in keep:
        v = (row.get(k) or "").strip()
        if v:
            out[k] = v
    # UTMs separados
    utm = {}
    for k in ["utm_source", "utm_medium", "utm_campaign", "utm_content",
              "utm_term", "utm_referrer", "referrer", "gclid", "fbclid"]:
        v = (row.get(k) or "").strip()
        if v:
            utm[k] = v
    if utm:
        out["attribution"] = utm
    return out


def build_personalized_context(row: dict) -> str:
    """Texto curto para futura análise. Não usado pelo IGOR_11 na campanha atual."""
    parts = []
    nome = (row.get("Nome completo") or "").strip()
    cidade = (row.get("Cidade") or "").strip()
    obj = (row.get("Objetivo principal") or "").strip()
    motivo = (row.get("Motivo não agendamento") or "").strip()
    cap = (row.get("Capacidade financeira/Investimento") or "").strip()
    urg = (row.get("Urgência") or "").strip()
    ult = (row.get("Ultima mensagem") or "").strip()

    if cidade:
        parts.append(f"Cidade: {cidade}.")
    if obj:
        parts.append(f"Objetivo: {obj}.")
    if motivo:
        parts.append(f"Motivo anterior de não agendar: {motivo}.")
    if cap:
        parts.append(f"Capacidade: {cap}.")
    if urg:
        parts.append(f"Urgência: {urg}.")
    if ult:
        parts.append(f"Última conversa: {ult}.")
    return " ".join(parts)


class SupabaseClient:
    """PostgREST client com fallback de DNS via --resolve."""

    def __init__(self, base_url: str, service_role: str):
        self.base_url = base_url.rstrip("/")
        self.service_role = service_role
        self.host = re.sub(r"^https?://", "", self.base_url).split("/")[0]

        # Fallback: se DNS local não resolver, usa Cloudflare DNS (1.1.1.1)
        try:
            socket.gethostbyname(self.host)
            self._resolved_ip = None
        except socket.gaierror:
            self._resolved_ip = self._resolve_via_doh(self.host)
            if self._resolved_ip:
                print(f"  [dns] {self.host} → {self._resolved_ip} (via Cloudflare DoH)")
            else:
                print(f"  [dns] FALHA ao resolver {self.host}", file=sys.stderr)

    def _resolve_via_doh(self, hostname: str) -> Optional[str]:
        """Resolve via Cloudflare DoH JSON API."""
        try:
            url = f"https://1.1.1.1/dns-query?name={hostname}&type=A"
            req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            answers = data.get("Answer", [])
            for ans in answers:
                if ans.get("type") == 1:
                    return ans["data"]
        except Exception:
            pass
        return None

    def _request(self, method: str, path: str, body=None, prefer: Optional[str] = None):
        url = f"{self.base_url}{path}"
        headers = {
            "apikey": self.service_role,
            "Authorization": f"Bearer {self.service_role}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=headers)

        if self._resolved_ip:
            # Forçar conexão para o IP resolvido, mantendo SNI/host correto
            ctx = ssl.create_default_context()
            # Replace hostname in URL with IP for connection; HTTPSHandler precisa de host override
            # Workaround: monkeypatch socket.getaddrinfo
            orig = socket.getaddrinfo
            try:
                socket.getaddrinfo = lambda h, *a, **kw: orig(self._resolved_ip, *a, **kw) if h == self.host else orig(h, *a, **kw)
                return urllib.request.urlopen(req, timeout=20, context=ctx)
            finally:
                socket.getaddrinfo = orig
        return urllib.request.urlopen(req, timeout=20)

    def upsert(self, table: str, row: dict, on_conflict: str) -> dict:
        path = f"/rest/v1/{table}?on_conflict={on_conflict}"
        with self._request("POST", path, body=[row], prefer="resolution=merge-duplicates,return=representation") as r:
            return json.loads(r.read())[0]

    def insert(self, table: str, row: dict) -> dict:
        path = f"/rest/v1/{table}"
        with self._request("POST", path, body=[row], prefer="return=representation") as r:
            return json.loads(r.read())[0]


def process_row(row: dict, seen_kommo_ids: set, seen_phones: set):
    """Retorna (action, data, reason).

    action ∈ {'queue','skip','dup'}
    """
    kommo_id = (row.get("ID") or "").strip()
    if not kommo_id:
        return "skip", None, "sem ID Kommo"

    if kommo_id in seen_kommo_ids:
        return "dup", None, "ID Kommo duplicado"

    # Kommo desse projeto exportou os números em "Telefone comercial"
    # (e não "Celular"). Tenta as duas colunas em ordem.
    raw_phone = ""
    for col in ("Telefone comercial", "Celular", "Tel. direto com.",
                "Telefone residencial", "Outro telefone"):
        v = (row.get(col) or "").lstrip("'").strip()
        if v:
            raw_phone = v
            break
    phone = normalize_phone(raw_phone)
    if not phone:
        seen_kommo_ids.add(kommo_id)
        return "skip", None, f"telefone inválido (bruto: {raw_phone[:6]}...)"

    if phone in seen_phones:
        seen_kommo_ids.add(kommo_id)
        return "dup", None, f"phone {phone[:6]}*** duplicado"

    etapa = (row.get("Etapa do lead") or "").strip().upper()
    if etapa == "AGENDADO":
        seen_kommo_ids.add(kommo_id)
        seen_phones.add(phone)
        return "skip", None, "etapa AGENDADO"

    seen_kommo_ids.add(kommo_id)
    seen_phones.add(phone)

    data = {
        "kommo_id": kommo_id,
        "phone": phone,
        "name": (row.get("Nome completo") or "").strip() or None,
        "email": ((row.get("Email pessoal") or "").strip()
                  or (row.get("Email comercial") or "").strip()
                  or None),
        "city": (row.get("Cidade") or "").strip() or None,
        "objective": (row.get("Objetivo principal") or "").strip() or None,
        "kommo_data": build_kommo_data(row),
        "personalized_context": build_personalized_context(row),
    }
    return "queue", data, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="executa writes no Supabase (default é dry-run)")
    ap.add_argument("--csv-dir", default=str(CSV_DIR), help="diretório com CSVs do Kommo")
    args = ap.parse_args()

    dry = not args.apply
    env = load_env(ENV_FILE)
    csv_dir = Path(args.csv_dir)

    if not csv_dir.exists():
        print(f"ERRO: {csv_dir} não existe", file=sys.stderr)
        sys.exit(2)

    csv_files = sorted(csv_dir.glob("*.csv"))
    if not csv_files:
        print(f"ERRO: nenhum .csv em {csv_dir}", file=sys.stderr)
        sys.exit(2)

    print(f"Modo: {'DRY-RUN (sem writes)' if dry else 'APPLY (escreve no Supabase)'}")
    print(f"CSVs: {[f.name for f in csv_files]}\n")

    seen_kommo_ids, seen_phones = set(), set()
    queued, skipped, dups = [], [], []

    for csv_file in csv_files:
        with open(csv_file, newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                action, data, reason = process_row(row, seen_kommo_ids, seen_phones)
                if action == "queue":
                    queued.append(data)
                elif action == "skip":
                    skipped.append({"kommo_id": (row.get("ID") or "").strip(), "reason": reason})
                else:  # dup
                    dups.append({"kommo_id": (row.get("ID") or "").strip(), "reason": reason})

    print(f"=== Preview ===")
    print(f"  queued : {len(queued)}")
    print(f"  skipped: {len(skipped)}  (motivos: {dict((r, sum(1 for s in skipped if s['reason']==r)) for r in set(s['reason'] for s in skipped))})")
    print(f"  dups   : {len(dups)}")
    print()

    if queued:
        print("Primeiros 3 queued (PII mascarada):")
        for d in queued[:3]:
            masked_phone = d["phone"][:4] + "***" + d["phone"][-2:]
            masked_name = (d["name"][:3] + "***") if d["name"] else "(sem nome)"
            print(f"  kommo_id={d['kommo_id']} phone={masked_phone} name={masked_name} city={d['city']} objective={(d['objective'] or '')[:30]}")
        print()

    if dry:
        print("DRY-RUN concluído. Use --apply para escrever no Supabase.")
        return

    # --apply
    base = env.get("SUPABASE_URL", "").rstrip("/")
    if base.endswith("/rest/v1"):
        base = base[:-8]
    base = base.rstrip("/")
    service = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not service:
        print("ERRO: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY faltando no .env", file=sys.stderr)
        sys.exit(2)

    client = SupabaseClient(base, service)

    n_ok, n_err = 0, 0
    for d in queued:
        try:
            contact = client.upsert(
                "contacts",
                {"phone": d["phone"], "name": d["name"], "email": d["email"]},
                on_conflict="phone",
            )
            lead = client.upsert(
                "leads",
                {
                    "contact_id": contact["id"],
                    "source": SOURCE,
                    "external_id": d["kommo_id"],
                    "objective": d["objective"],
                    "city": d["city"],
                    "kommo_data": d["kommo_data"],
                },
                on_conflict="source,external_id",
            )
            client.insert(
                "campaign_contacts",
                {
                    "campaign_id": CAMPAIGN_ID,
                    "contact_id": contact["id"],
                    "lead_id": lead["id"],
                    "phone": d["phone"],
                    "status": "queued",
                    "eligibility_reason": "kommo_csv_import",
                    "personalized_context": d["personalized_context"],
                },
            )
            n_ok += 1
        except Exception as e:
            n_err += 1
            print(f"  [erro] kommo_id={d['kommo_id']}: {e}", file=sys.stderr)

    print(f"\n=== APPLY concluído ===")
    print(f"  ok    : {n_ok}")
    print(f"  erros : {n_err}")


if __name__ == "__main__":
    main()
