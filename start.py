#!/usr/bin/env python3
"""Primeira subida do Motor Cripto.

Ordem de propósito:
  1. segredos, banco, carteira HD (a que recebe os pagamentos)
  2. cria a carteira de POL usada para patrocinar gas
  3. só no final mostra o endereço da carteira de POL, para o pedágio inicial

O destino dos sweeps é cadastrado por cliente no admin (`/admin/`), nunca
no `.env`.

O pedágio é um envio comum de POL na rede Polygon. Não é uma cobrança Ramp.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"
KEYSTORE = ROOT / "data" / "keystore.json"

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
PRIVATE_KEY_RE = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")
XPUB_RE = re.compile(r"xpub[1-9A-HJ-NP-Za-km-z]+")
POLL_SECONDS = 20
WAIT_LIMIT_SECONDS = 15 * 60
# 0,5 POL: o mesmo tanto que um patrocínio manda. Abaixo disso a primeira
# varredura ainda não tem reserva.
MIN_POL_WEI = 500_000_000_000_000_000


def say(text: str = "") -> None:
    print(text, flush=True)


def run(
    cmd: list[str],
    *,
    capture: bool = False,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    shown: list[str] = []
    hide_next = False
    for part in cmd:
        if hide_next:
            shown.append("***")
            hide_next = False
            continue
        shown.append(part)
        if part == "--passphrase":
            hide_next = True
    say("$ " + " ".join(shown))
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        capture_output=capture,
        check=check,
        env=merged,
    )


def need(binary: str) -> None:
    if shutil.which(binary) is None:
        sys.exit(f"Não achei '{binary}' no PATH. Instale e rode de novo.")


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
    replaced = False
    out: list[str] = []
    for line in lines:
        if line.startswith(prefix) or line.startswith(f"{key} ="):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        if out and out[-1] != "":
            out.append("")
        out.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")
    os.chmod(ENV_PATH, 0o600)


def ensure_env_file() -> None:
    if ENV_PATH.exists():
        return
    if not ENV_EXAMPLE.exists():
        sys.exit("Não achei .env.example.")
    ENV_PATH.write_text(ENV_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
    os.chmod(ENV_PATH, 0o600)
    say("Criei .env a partir do exemplo.")


def openssl_rand(encoding: str) -> str:
    result = run(["openssl", "rand", encoding, "32"], capture=True)
    return result.stdout.strip()


def fill_secrets() -> None:
    current = read_env()
    example_token = "troque-este-token-por-um-valor-aleatorio-longo"
    if len(current.get("DATA_ENCRYPTION_KEY", "")) < 8:
        write_env_key("DATA_ENCRYPTION_KEY", openssl_rand("-base64"))
        say("DATA_ENCRYPTION_KEY gerada (cifra segredos e token da pagina).")
    token = current.get("ADMIN_TOKEN", "")
    if len(token) < 32 or token == example_token:
        write_env_key("ADMIN_TOKEN", secrets.token_hex(32))
        say("ADMIN_TOKEN gerado (senha da API). Está no .env; não vai para a tela de novo.")
    if len(current.get("SIGNER_PASSPHRASE", "")) < 16:
        write_env_key("SIGNER_PASSPHRASE", secrets.token_hex(24))
        say("SIGNER_PASSPHRASE gerada e gravada no .env (abre o keystore no worker).")


def node_eval(source: str, *, key: str | None = None) -> str:
    env = {"MOTOR_START_KEY": key} if key else None
    result = run(
        ["node", "--input-type=module", "-e", source],
        capture=True,
        env=env,
    )
    return result.stdout.strip()


def create_gas_wallet() -> str:
    """Cria a carteira de POL se ainda não existir. Não imprime o endereço."""
    current = read_env()
    key = current.get("GAS_SPONSOR_PRIVATE_KEY", "")
    if key:
        address = node_eval(
            "import { Wallet } from 'ethers';"
            "const w = new Wallet(process.env.MOTOR_START_KEY);"
            "console.log(w.address);",
            key=key,
        )
        configured = current.get("GAS_SPONSOR_ADDRESS", "")
        if configured and configured.lower() != address.lower():
            sys.exit(
                "GAS_SPONSOR_ADDRESS não corresponde à GAS_SPONSOR_PRIVATE_KEY. "
                "Corrija o .env antes de continuar."
            )
        write_env_key("GAS_SPONSOR_ADDRESS", address)
        return address

    created = node_eval(
        "import { Wallet } from 'ethers';"
        "const w = Wallet.createRandom();"
        "console.log(w.address);"
        "console.log(w.privateKey);"
    )
    address, private_key = created.splitlines()
    write_env_key("GAS_SPONSOR_PRIVATE_KEY", private_key)
    write_env_key("GAS_SPONSOR_ADDRESS", address)
    say("Carteira de POL criada. A chave ficou só no .env.")
    return address


def init_hd_wallet() -> None:
    if KEYSTORE.exists() and read_env().get("HD_XPUB"):
        say(f"Keystore já existe em {KEYSTORE}. A carteira HD não foi recriada.")
        return
    if KEYSTORE.exists() and not read_env().get("HD_XPUB"):
        sys.exit(
            "Existe data/keystore.json, mas HD_XPUB está vazio. "
            "Cole o xpub dessa carteira no .env ou apague o keystore se ela foi um teste."
        )

    passphrase = read_env()["SIGNER_PASSPHRASE"]
    say("\nCriando a carteira HD (endereços que recebem USDC). A seed aparece uma vez.")
    result = run(
        [
            "npm",
            "run",
            "wallet:init",
            "--",
            "--passphrase",
            passphrase,
            "--show-seed",
        ],
        capture=True,
    )
    text = result.stdout
    match = XPUB_RE.search(text)
    if not match:
        say(text)
        sys.exit("Não consegui ler o HD_XPUB na saída do wallet:init.")
    write_env_key("HD_XPUB", match.group(0))
    say(text)
    say("Anote a seed em papel, fora deste computador. Sem ela, o USDC recebido se perde.")
    confirm = input("Digite ANOTADA quando a seed estiver guardada offline: ").strip()
    if confirm != "ANOTADA":
        sys.exit("Parado. A seed não foi confirmada. O keystore já está em data/keystore.json.")


def explain_admin_setup() -> None:
    say("\nCarteiras de destino dos sweeps ficam por cliente, no admin.")
    say("Depois de subir, abra /admin/, crie o cliente e cadastre a carteira")
    say("allowlisted dele. Nenhuma carteira fria global vai para o .env.")


def pol_balance(address: str) -> int | None:
    rpc = read_env().get("RPC_URL_POLYGON", "").strip()
    if not rpc:
        say("RPC_URL_POLYGON vazio. Não dá para ver se o POL chegou.")
        return None
    try:
        raw = node_eval(
            "import { JsonRpcProvider } from 'ethers';"
            "const provider = new JsonRpcProvider(process.env.MOTOR_START_KEY);"
            f"const balance = await provider.getBalance({address!r});"
            "console.log(balance.toString());",
            key=rpc,
        )
        return int(raw.splitlines()[-1])
    except (subprocess.CalledProcessError, ValueError) as err:
        say(f"Falha ao consultar o saldo de POL: {err}")
        return None


def wait_for_pol(address: str) -> None:
    say("\n============================================")
    say("  RECARGA DE POL")
    say("============================================")
    say("O caminho mais fácil: na corretora, compre POL e saque para o")
    say("endereço abaixo, escolhendo a rede Polygon. Se você já tem POL")
    say("numa carteira, envie para esse mesmo endereço, também na Polygon.")
    say("Não use a rede Ethereum: o endereço é igual e o dinheiro não chega.")
    say("")
    say(address)
    say("")
    say("Um POL basta, com folga. O script aguarda até 15 minutos.")
    say("Se o POL chegar antes, a subida continua na hora.\n")

    deadline = time.monotonic() + WAIT_LIMIT_SECONDS
    while True:
        balance = pol_balance(address)
        if balance is not None and balance >= MIN_POL_WEI:
            whole = balance // 10**18
            frac = (balance % 10**18) // 10**14
            say(f"POL recebido: cerca de {whole}.{frac:04d} POL.")
            return
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            say("Os 15 minutos acabaram e o POL ainda não apareceu.")
            say("A API e o worker sobem mesmo assim. O selo da tela Gerar cobrança")
            say("avisa se a carteira de gas seguir sem saldo. O endereço continua o mesmo.")
            return
        if balance is None:
            say(f"Não consegui consultar o saldo. Nova tentativa em {POLL_SECONDS}s ({remaining // 60} min restantes).")
        else:
            say(f"Ainda sem POL suficiente. Nova consulta em {POLL_SECONDS}s ({remaining // 60} min restantes).")
        time.sleep(min(POLL_SECONDS, remaining))


def start_services() -> None:
    say("\nSubindo a API e o worker. Deixe este terminal aberto.")
    say("Ctrl+C encerra os dois.")
    api = subprocess.Popen(["npm", "run", "dev"], cwd=ROOT)
    worker = subprocess.Popen(["npm", "run", "worker"], cwd=ROOT)
    say("\nPronto. Abra http://localhost:4578")
    say("O ADMIN_TOKEN está no arquivo .env, na raiz do projeto.")
    try:
        while True:
            if api.poll() is not None:
                worker.terminate()
                sys.exit(api.returncode or 1)
            if worker.poll() is not None:
                api.terminate()
                sys.exit(worker.returncode or 1)
            time.sleep(1)
    except KeyboardInterrupt:
        say("\nEncerrando API e worker.")
        api.terminate()
        worker.terminate()
        sys.exit(130)


def main() -> None:
    os.chdir(ROOT)
    say("Motor Cripto — primeira subida\n")
    for binary in ("node", "npm", "openssl", "docker"):
        need(binary)

    ensure_env_file()
    fill_secrets()

    run(["docker", "compose", "up", "-d", "db"])
    run(["npm", "install"])

    init_hd_wallet()
    gas_address = create_gas_wallet()
    explain_admin_setup()

    say("\nCriando tabelas e os perfis de USDC/USDT.")
    run(["npm", "run", "migrate"])
    run(["npm", "run", "seed"])

    wait_for_pol(gas_address)
    start_services()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as err:
        tail = (err.stderr or err.stdout or "").strip()
        if tail:
            say(tail)
        sys.exit(err.returncode)
    except KeyboardInterrupt:
        say("\nEspera interrompida. O que já foi gravado no .env continua valendo.")
        sys.exit(130)
