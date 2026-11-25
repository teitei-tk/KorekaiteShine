"""コンテナが読む依存宣言を新規ディレクトリに取り出す。"""

import argparse
from contextlib import ExitStack
import errno
import os
import shutil
import stat
import subprocess
from pathlib import Path


def dependency_input(path):
    parts = path.parts
    if len(parts) == 1:
        return path.name in {
            "package.json", ".pnpmfile.cjs", "pnpm-workspace.yaml", "pnpm-lock.yaml"
        }
    if len(parts) == 2:
        return parts[0] == "patches" and path.suffix == ".patch"
    return (
        len(parts) == 3
        and parts[0] in {"apps", "packages", "tools"}
        and path.name == "package.json"
    )


def source_input(path):
    excluded = {".git", ".codex", ".local", ".ci", ".aws", ".ssh", "node_modules"}
    if excluded.intersection(path.parts):
        return False
    if any(part.startswith((".env", ".dev.vars")) for part in path.parts):
        return False
    if path.name in {".npmrc", ".netrc", ".git-credentials"}:
        return False
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
        return False
    return (
        path.parts[0] in {"apps", "packages", "tools", "docs", "patches", ".github"}
        or len(path.parts) == 1
    )


def prepare(mode, repo, destination):
    files = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=repo,
    )
    destination.mkdir(mode=0o700)
    for name in sorted(set(files.split(b"\0")) - {b""}):
        path = Path(os.fsdecode(name))
        if not (dependency_input(path) if mode == "deps" else source_input(path)):
            continue
        # コピー中の改名でも入力外へ移動しないよう、各要素を親のfdから開く。
        with ExitStack() as opened:
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory = os.open(repo, directory_flags)
            opened.callback(os.close, directory)
            try:
                for component in path.parts[:-1]:
                    directory = os.open(component, directory_flags, dir_fd=directory)
                    opened.callback(os.close, directory)
                fd = os.open(
                    path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=directory,
                )
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT):
                    continue
                raise
            with os.fdopen(fd, "rb") as source:
                mode_bits = os.fstat(fd).st_mode
                if stat.S_ISREG(mode_bits):
                    output = destination / path
                    output.parent.mkdir(exist_ok=True, parents=True)
                    with output.open("xb") as target:
                        shutil.copyfileobj(source, target)
                        os.fchmod(target.fileno(), 0o755 if mode_bits & 0o111 else 0o644)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["deps", "source"])
    parser.add_argument("repository", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    prepare(args.mode, args.repository.resolve(), args.destination)
