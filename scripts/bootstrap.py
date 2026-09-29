#!/usr/bin/env python3

import argparse
import hashlib
import json
import logging
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

NODE_BASE_URL = "https://nodejs.org/dist"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
NODE_VERSION = (PROJECT_ROOT / ".node-version").read_text().strip()

logger = logging.getLogger(__name__)


def node_platform() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()

    os_name = {
        "darwin": "darwin",
        "linux": "linux",
        "windows": "win",
    }.get(system)

    arch = {
        "amd64": "x64",
        "x86_64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }.get(machine)

    if os_name is None or arch is None:
        raise ValueError(f"Unsupported platform: {system}-{machine}")

    return os_name, arch


def download(url: str, destination: Path) -> None:
    import urllib.request

    logger.info("Downloading %s", url)
    with urllib.request.urlopen(url) as response:
        with destination.open("wb") as output:
            shutil.copyfileobj(response, output)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def existing_node_version(node_binary: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            [str(node_binary), "--version"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    return result.stdout.strip().removeprefix("v")


def expected_sha256(filename: str) -> str:
    import urllib.request

    shasums_url = f"{NODE_BASE_URL}/v{NODE_VERSION}/SHASUMS256.txt"
    with urllib.request.urlopen(shasums_url) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if line.endswith(f"  {filename}"):
                return line.split()[0]
    raise ValueError(f"Could not find checksum for {filename}")


def archive_relative_parts(path: str, root_name: str) -> Optional[tuple[str, ...]]:
    parts = Path(path).parts
    if len(parts) <= 1 or parts[0] != root_name:
        return None

    relative_parts = parts[1:]
    if any(part in ("", ".", "..") for part in relative_parts):
        return None

    return relative_parts


def extract_archive(archive: Path, destination: Path, root_name: str) -> None:
    import tarfile
    import zipfile

    destination.mkdir(parents=True, exist_ok=True)

    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as zip_file:
            for zip_member in zip_file.infolist():
                relative_parts = archive_relative_parts(zip_member.filename, root_name)
                if relative_parts is None:
                    continue
                target = destination.joinpath(*relative_parts)
                if zip_member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zip_file.open(zip_member) as zip_source, target.open(
                    "wb"
                ) as output:
                    shutil.copyfileobj(zip_source, output)
    else:
        with tarfile.open(archive) as tar_file:
            for tar_member in tar_file.getmembers():
                relative_parts = archive_relative_parts(tar_member.name, root_name)
                if relative_parts is None:
                    continue
                target = destination.joinpath(*relative_parts)

                if tar_member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue

                target.parent.mkdir(parents=True, exist_ok=True)

                if tar_member.issym():
                    if Path(tar_member.linkname).is_absolute():
                        continue
                    target.symlink_to(tar_member.linkname)
                    continue

                if not tar_member.isfile():
                    continue

                tar_source = tar_file.extractfile(tar_member)
                if tar_source is None:
                    continue
                with tar_source, target.open("wb") as output:
                    shutil.copyfileobj(tar_source, output)
                target.chmod(tar_member.mode)


def node_directory() -> Path:
    os_name, arch = node_platform()
    return PROJECT_ROOT / f".node.{os_name}-{arch}"


def bootstrap(force: bool) -> Path:
    os_name, arch = node_platform()
    extension = "zip" if os_name == "win" else "tar.xz"
    root_name = f"node-v{NODE_VERSION}-{os_name}-{arch}"
    filename = f"{root_name}.{extension}"
    node_dir = node_directory()
    node_binary = node_dir / ("node.exe" if os_name == "win" else "bin/node")

    if node_binary.exists() and not force:
        installed_version = existing_node_version(node_binary)
        if installed_version == NODE_VERSION:
            logger.info("Node v%s already exists at %s", NODE_VERSION, node_dir)
            return node_dir
        if installed_version is None:
            logger.info("Existing Node at %s is invalid; replacing it", node_dir)
        else:
            logger.info(
                "Existing Node at %s is v%s; replacing it with v%s",
                node_dir,
                installed_version,
                NODE_VERSION,
            )

    url = f"{NODE_BASE_URL}/v{NODE_VERSION}/{filename}"

    with tempfile.TemporaryDirectory(prefix="bootstrap-node-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        archive = temp_dir / filename
        extracted = temp_dir / "node"

        download(url, archive)
        actual = sha256(archive)
        expected = expected_sha256(filename)
        if actual != expected:
            raise ValueError(
                f"Checksum mismatch for {filename}: expected {expected}, got {actual}"
            )

        extract_archive(archive, extracted, root_name)

        if node_dir.exists():
            shutil.rmtree(node_dir)
        shutil.move(str(extracted), node_dir)

    logger.info("Vendored Node v%s into %s", NODE_VERSION, node_dir)
    return node_dir


def powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def install_dependencies(node_dir: Path) -> None:
    os_name, _ = node_platform()
    path_dir = node_dir if os_name == "win" else node_dir / "bin"
    node_binary = path_dir / ("node.exe" if os_name == "win" else "node")
    npm_cli = node_dir / (
        "node_modules/npm/bin/npm-cli.js"
        if os_name == "win"
        else "lib/node_modules/npm/bin/npm-cli.js"
    )
    env = os.environ.copy()
    env["PATH"] = str(path_dir) + os.pathsep + env.get("PATH", "")
    logger.info("Installing development dependencies and Electron")
    subprocess.run(
        [
            str(node_binary),
            str(npm_cli),
            "install",
            "--include=dev",
            "--ignore-scripts=false",
        ],
        cwd=PROJECT_ROOT,
        env=env,
        check=True,
        # Stdout is shell code; npm and lifecycle output must stay on stderr.
        stdout=sys.stderr,
        stderr=sys.stderr,
    )


def environment_state(node_dir: Path) -> Optional[dict]:
    """Fingerprint setup inputs and installed entrypoints without starting tools."""
    os_name, _ = node_platform()
    modules = PROJECT_ROOT / "node_modules"
    electron = modules / "electron"
    try:
        inputs = {
            name: sha256(PROJECT_ROOT / name)
            for name in (
                ".node-version",
                "package.json",
                "package-lock.json",
                "scripts/bootstrap.py",
            )
        }
        npmrc = PROJECT_ROOT / ".npmrc"
        inputs[".npmrc"] = sha256(npmrc) if npmrc.exists() else None
        executable = (electron / "path.txt").read_text().strip()
        if not executable:
            return None
        installed = [
            node_dir / ("node.exe" if os_name == "win" else "bin/node"),
            node_dir
            / (
                "node_modules/npm/bin/npm-cli.js"
                if os_name == "win"
                else "lib/node_modules/npm/bin/npm-cli.js"
            ),
            modules / ".package-lock.json",
            electron / "path.txt",
            electron / "dist" / executable,
        ]
        files = {}
        for path in installed:
            stat = path.stat()
            files[str(path)] = [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
        return {"inputs": inputs, "installed": files}
    except (OSError, ValueError):
        return None


def prepare_environment(force: bool) -> Path:
    node_dir = node_directory()
    stamp = PROJECT_ROOT / "node_modules" / ".ade-bootstrap.json"
    if not force:
        try:
            cached = json.loads(stamp.read_text())
            if cached is not None and cached == environment_state(node_dir):
                return node_dir
        except (OSError, ValueError):
            pass

    # A failed or interrupted installation must never leave a valid cache.
    stamp.unlink(missing_ok=True)
    node_dir = bootstrap(force)
    install_dependencies(node_dir)
    # npm may update the lockfile, so capture the state only after it succeeds.
    state = environment_state(node_dir)
    if state is not None:
        stamp.write_text(json.dumps(state))
    return node_dir


def print_env(node_dir: Path) -> None:
    os_name, _ = node_platform()
    path_dir = node_dir if os_name == "win" else node_dir / "bin"

    if os_name == "win":
        path_dir_value = powershell_quote(str(path_dir.resolve()))
        print(f"$__ade_node_bin = {path_dir_value}")
        print(
            "$__ade_path_entries = @($env:Path -split ';' | "
            "Where-Object { $_ -and $_ -ne $__ade_node_bin })"
        )
        print("$env:Path = (@($__ade_node_bin) + $__ade_path_entries) -join ';'")
        print(
            "Remove-Variable __ade_node_bin,__ade_path_entries "
            "-ErrorAction SilentlyContinue"
        )
    else:
        path_dir_value = shlex.quote(str(path_dir.resolve()))
        print(
            f"PATH=$(printf %s \"$PATH\" | tr : '\\n' | "
            f"grep -Fvx -- {path_dir_value} | paste -sd : -)"
        )
        print(f"export PATH={path_dir_value}:$PATH")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Set up Node.js, development dependencies and Electron, then print shell "
            "commands to activate Node.js (PowerShell on Windows, POSIX on Linux/macOS)."
        ),
        epilog=(
            "PowerShell: python scripts/bootstrap.py | iex\n"
            'Linux/macOS: eval "$(python scripts/bootstrap.py)"'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="bypass cached setup, replace vendored Node and reinstall dependencies",
    )
    args = parser.parse_args()

    # Stdout is evaluated by the caller's shell; keep diagnostics on stderr.
    logging.basicConfig(format="%(message)s", level=logging.INFO)

    try:
        node_dir = prepare_environment(force=args.force)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        logger.error("Environment setup failed: %s", error)
        # Preserve failure when the caller evaluates stdout through a shell.
        print(
            "throw 'Environment setup failed.'" if os.name == "nt" else "false"
        )
        raise SystemExit(1) from error
    print_env(node_dir)


if __name__ == "__main__":
    main()
