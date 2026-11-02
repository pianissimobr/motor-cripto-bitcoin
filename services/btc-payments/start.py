#!/usr/bin/env python3
"""Instalador do serviço btc-payments.

Pergunta quais motores habilitar (Lightning, on-chain e PIX), grava os flags
no `.env` e valida as variáveis obrigatórias de cada motor.

Uso interativo:
    cd services/btc-payments
    python3 start.py

Uso não interativo:
    python3 start.py --engines lightning,onchain,pix
    python3 start.py --engines pix --up

Os motores desligados ficam com as variáveis vazias; o `config.ts` não exige
os campos de um motor quando `*_ENABLED=false`.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"

ENGINES = {
    "lightning": "Lightning (wallet LNbits de cada lojista)",
    "onchain": "On-chain Bitcoin (xpub de cada lojista + Esplora)",
    "pix": "PIX (Lunium)",
}


def say(text: str = "") -> None:
    print(text, flush=True)


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_PATH.exists():
        return values
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_env_key(key: str, value: str) -> None:
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    prefix = f"{key}="
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith(prefix):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and out[-1] != "":
            out.append("")
        out.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")
    ENV_PATH.chmod(0o600)


def ensure_env_file() -> None:
    if ENV_PATH.exists():
        return
    if not ENV_EXAMPLE.exists():
        sys.exit("Não achei .env.example.")
    ENV_PATH.write_text(ENV_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
    ENV_PATH.chmod(0o600)
    say("Criei .env a partir do .env.example.")


def ask_engines() -> list[str]:
    say("\nMotores disponíveis:")
    for index, (key, label) in enumerate(ENGINES.items(), start=1):
        say(f"  [{index}] {label}")
    raw = input("Quais habilitar? (ex: 1,2 ou lightning,onchain): ").strip()
    return parse_engines(raw)


def parse_engines(raw: str) -> list[str]:
    selected: list[str] = []
    for token in raw.replace(";", ",").split(","):
        token = token.strip().lower()
        if not token:
            continue
        if token.isdigit():
            keys = list(ENGINES)
            index = int(token) - 1
            if index < 0 or index >= len(keys):
                sys.exit(f"Motor inválido: {token}")
            token = keys[index]
        if token not in ENGINES:
            sys.exit(f"Motor inválido: {token}")
        if token not in selected:
            selected.append(token)
    if not selected:
        sys.exit("Escolha pelo menos um motor.")
    return selected


def require_values(engine: str, env: dict[str, str], keys: list[str]) -> list[str]:
    missing = [key for key in keys if not env.get(key, "").strip()]
    return [f"{engine}: {key}" for key in missing]


def validate(engines: list[str], env: dict[str, str]) -> None:
    missing: list[str] = []
    if "lightning" in engines:
        missing += require_values(
            "lightning",
            env,
            ["LNBITS_WEBHOOK_TOKEN"],
        )
    if "onchain" in engines:
        missing += require_values("onchain", env, ["ESPLORA_URL"])

    if "pix" in engines:
        missing += require_values(
            "pix",
            env,
            ["LUNIUM_API_KEY", "LUNIUM_WEBHOOK_SECRET"],
        )
        # O USDC do PIX vai direto para a carteira usdc_settlement de cada
        # lojista (cadastrada no portal); nao ha carteira da plataforma.
    if missing:
        say("\nFaltam variáveis para os motores escolhidos:")
        for item in missing:
            say(f"  - {item}")
        say(f"\nEdite {ENV_PATH} e rode de novo.")
        sys.exit(1)


def maybe_up() -> None:
    for binary in ("docker", "npm"):
        if shutil.which(binary) is None:
            say(f"Não achei '{binary}'. Pulei a subida do stack.")
            return
    say("\nSubindo Postgres, LNbits e bitcoind (docker compose up -d)...")
    subprocess.run(["docker", "compose", "up", "-d"], cwd=ROOT, check=True)
    say("Instalando dependências e aplicando migrations...")
    subprocess.run(["npm", "install"], cwd=ROOT, check=True)
    subprocess.run(["npm", "run", "migrate"], cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Instalação do btc-payments")
    parser.add_argument(
        "--engines",
        help="lista separada por vírgula: lightning,onchain,pix",
    )
    parser.add_argument(
        "--up",
        action="store_true",
        help="roda docker compose up -d, npm install e npm run migrate",
    )
    args = parser.parse_args()

    ensure_env_file()
    engines = parse_engines(args.engines) if args.engines else ask_engines()

    write_env_key("LIGHTNING_ENABLED", "true" if "lightning" in engines else "false")
    write_env_key("ONCHAIN_ENABLED", "true" if "onchain" in engines else "false")
    write_env_key("PIX_ENABLED", "true" if "pix" in engines else "false")

    env = read_env()
    validate(engines, env)

    say("\nMotores habilitados: " + ", ".join(engines))
    say(f"Flags gravados em {ENV_PATH}.")
    say("Cada lojista cadastra as próprias carteiras no portal: wallet LNbits")
    say("(Lightning), xpub (on-chain) e endereço USDC na Base (PIX). O dinheiro")
    say("vai direto para elas; o motor não guarda nem converte nada.")

    if args.up:
        maybe_up()

    say("\nPróximos passos:")
    say("  npm run dev      # API na 4580")
    say("  npm run worker   # em outro terminal")
    say("  http://localhost:4580/portal")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
