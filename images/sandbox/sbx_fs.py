"""sbx_fs — pi-gateway sandbox 파일 도우미 (sandboxd가 docker exec로 `sbx-fs`를 호출한다).

`/usr/local/bin/sbx-fs`는 이 모듈을 불러오는 얇은 실행 파일이다. 모듈은 이미지 빌드 때
미리 컴파일되므로(read-only rootfs라 실행 중에는 pyc를 쓸 수 없다) 시작이 빠르다.

인자는 셸 해석 없이 그대로 전달된다. 상대 경로는 /workspace 기준이다.

  sbx-fs read  <path> <maxBytes>        stdout: JSON 헤더 한 줄 + 원본 바이트
  sbx-fs write <path> <mkdirs:0|1>      stdin: 원본 바이트       stdout: JSON 한 줄
  sbx-fs stat  <path>                   stdout: JSON 한 줄 (lstat)
  sbx-fs list  <path>                   stdout: JSON 한 줄 (이름순)
  sbx-fs mkdir <path> <recursive:0|1>   stdout: JSON 한 줄
  sbx-fs glob  <cwd> <limit> <pattern> [ignore...]   stdout: JSON 한 줄 (fd, 절대 경로)

실패하면 {"ok": false, "code": <SandboxErrorCode>, "message": ...} 한 줄을 쓰고 0으로 끝낸다.
"""

import errno
import json
import os
import stat
import sys

WORKSPACE = "/workspace"
# 도우미는 workspace의 파일에 영향을 받지 않게 절대 경로와 고정된 환경으로 실행한다
# (HOME·XDG_CONFIG_HOME을 비워 사용자 전역 ignore 파일과 git 설정도 읽지 않는다)
FD = "/usr/bin/fdfind"
HELPER_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent", "XDG_CONFIG_HOME": "/nonexistent", "LANG": "C.UTF-8"}

ERRNO_CODES = {
    errno.ENOENT: "not_found",
    errno.EISDIR: "is_directory",
    errno.ENOTDIR: "not_directory",
    errno.EACCES: "permission_denied",
    errno.EPERM: "permission_denied",
    errno.EROFS: "permission_denied",
    errno.ETXTBSY: "permission_denied",
    errno.EFBIG: "too_large",
    errno.ENOSPC: "too_large",
    errno.EDQUOT: "too_large",
    errno.ELOOP: "invalid_request",
    errno.ENAMETOOLONG: "invalid_request",
    errno.EEXIST: "invalid_request",
    errno.ENOTEMPTY: "invalid_request",
}


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def resolve(path):
    if not path:
        raise Fail("invalid_request", "empty path")
    return path if os.path.isabs(path) else os.path.join(WORKSPACE, path)


def kind_of(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def flag(value):
    return value == "1"


def cmd_read(path, max_bytes):
    p = resolve(path)
    limit = int(max_bytes)
    st = os.stat(p)
    if stat.S_ISDIR(st.st_mode):
        raise Fail("is_directory", "%s is a directory" % p)
    if not stat.S_ISREG(st.st_mode):
        raise Fail("invalid_request", "%s is not a regular file" % p)
    with open(p, "rb") as f:
        data = f.read(limit + 1)
    truncated = len(data) > limit
    if truncated:
        data = data[:limit]
    emit({"ok": True, "size": st.st_size, "truncated": truncated})
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def cmd_write(path, mkdirs):
    p = resolve(path)
    data = sys.stdin.buffer.read()
    if flag(mkdirs):
        parent = os.path.dirname(p)
        if parent:
            os.makedirs(parent, exist_ok=True)
    if os.path.isdir(p):
        raise Fail("is_directory", "%s is a directory" % p)
    with open(p, "wb") as f:
        f.write(data)
    emit({"ok": True, "size": len(data)})


def cmd_stat(path):
    p = resolve(path)
    try:
        st = os.lstat(p)
    except (FileNotFoundError, NotADirectoryError):
        emit({"ok": True, "exists": False})
        return
    kind = kind_of(st.st_mode)
    if kind == "symlink":
        target_is_dir = os.path.isdir(p)
    else:
        target_is_dir = kind == "dir"
    emit(
        {
            "ok": True,
            "exists": True,
            "kind": kind,
            "size": st.st_size,
            "mtimeMs": st.st_mtime_ns // 1_000_000,
            "targetIsDir": target_is_dir,
        }
    )


def cmd_list(path):
    p = resolve(path)
    entries = []
    with os.scandir(p) as it:
        for entry in it:
            try:
                kind = kind_of(entry.stat(follow_symlinks=False).st_mode)
            except OSError:
                kind = "other"
            entries.append({"name": entry.name, "kind": kind})
    entries.sort(key=lambda e: e["name"])
    emit({"ok": True, "entries": entries})


def cmd_mkdir(path, recursive):
    p = resolve(path)
    if flag(recursive):
        os.makedirs(p, exist_ok=True)
    else:
        os.mkdir(p)
    emit({"ok": True})


def inside_git_repo(path):
    current = path
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def cmd_glob(cwd, limit, pattern, *ignore):
    import re
    import subprocess

    dir_ignore = re.compile(r"\*\*/([^*?/\[\]{}]+)/\*\*")
    base = resolve(cwd)
    max_results = int(limit)
    if not os.path.exists(base):
        raise Fail("not_found", "%s does not exist" % base)
    if not os.path.isdir(base):
        raise Fail("not_directory", "%s is not a directory" % base)
    # pi의 기본 find(fd) 호출과 같은 의미를 유지한다
    args = [FD, "--glob", "--color=never", "--hidden", "--absolute-path", "--exclude", ".git"]
    if not inside_git_repo(base):
        args.append("--no-require-git")
    for pat in ignore:
        m = dir_ignore.fullmatch(pat)
        args += ["--exclude", m.group(1) if m else pat]
    args += ["--max-results", str(max_results + 1)]
    effective = pattern
    if "/" in pattern:
        args.append("--full-path")
        if not pattern.startswith("/") and not pattern.startswith("**/") and pattern != "**":
            effective = "**/" + pattern
    args += ["--", effective, base]
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=55, env=HELPER_ENV)
    except subprocess.TimeoutExpired:
        raise Fail("timeout", "glob timed out")
    out = proc.stdout.decode("utf-8", "surrogateescape")
    paths = [line for line in out.split("\n") if line]
    if proc.returncode != 0 and not paths:
        message = proc.stderr.decode("utf-8", "replace").strip() or ("fd exited with %d" % proc.returncode)
        raise Fail("invalid_request", message)
    paths.sort()
    truncated = len(paths) > max_results
    emit({"ok": True, "paths": paths[:max_results], "truncated": truncated})


COMMANDS = {
    "read": (cmd_read, 2),
    "write": (cmd_write, 2),
    "stat": (cmd_stat, 1),
    "list": (cmd_list, 1),
    "mkdir": (cmd_mkdir, 2),
    "glob": (cmd_glob, None),
}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        raise Fail("invalid_request", "unknown command")
    fn, arity = COMMANDS[argv[1]]
    args = argv[2:]
    if arity is None:
        if len(args) < 3:
            raise Fail("invalid_request", "glob needs <cwd> <limit> <pattern>")
    elif len(args) != arity:
        raise Fail("invalid_request", "wrong number of arguments")
    fn(*args)


def main_entry():
    try:
        main(sys.argv)
    except Fail as e:
        emit({"ok": False, "code": e.code, "message": e.message})
    except OSError as e:
        code = ERRNO_CODES.get(e.errno, "internal")
        name = e.filename if e.filename is not None else ""
        emit({"ok": False, "code": code, "message": "%s: %s" % (e.strerror or "error", name)})
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "code": "internal", "message": "%s: %s" % (type(e).__name__, e)})
