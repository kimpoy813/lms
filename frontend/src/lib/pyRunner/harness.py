# Runs one student's Python program inside the browser's Python (Pyodide) the way the server's
# checker runs it: syntax check first, then the program as `python3 main.py`, once per input, each
# time in an empty folder with a fresh `__main__`.
#
# This file is loaded once into a private namespace of the interpreter (see worker.js), which
# calls, for every input:
#
#     begin(index)          prepares the run and hands back the compiled program and its globals
#     exec(program, scope)  called from JavaScript, so that no frame of this file is underneath the
#                           program: its traceback and its recursion depth are those of a real run
#     finish(index, raised) does what the interpreter does when a program ends, and tidies up
#
# Standard input and output are not redirected here. They are the real file descriptors 0, 1 and
# 2, which worker.js connects to the test's input and to its own collectors.
#
# What the browser cannot reproduce faithfully is not attempted: `check` and `finish` name a
# reason, and the program is then run on the server as before.
import sys

_BOOT_MODULES = frozenset(sys.modules)  # before this file imports anything of its own

import ast  # noqa: E402
import atexit  # noqa: E402
import builtins  # noqa: E402
import gc  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import linecache  # noqa: E402
import os  # noqa: E402
import py_compile  # noqa: E402
import shutil  # noqa: E402
import types  # noqa: E402
import warnings  # noqa: E402

BUILD = "/judge/build"
SCRIPT = BUILD + "/main.py"
RECURSION_LIMIT = 1000

# Modules that behave in the browser as they do on the server, for what a course program does
# with them. Anything else is left to the server: threads, processes, sockets, the file system,
# add-on packages.
ALLOWED_MODULES = frozenset(
    """
    __future__ abc argparse array ast atexit base64 binascii bisect builtins calendar cmath
    collections contextlib copy csv dataclasses datetime decimal difflib enum fractions functools
    getopt graphlib hashlib heapq html io itertools json keyword math numbers operator os pickle
    pprint queue random re reprlib secrets shlex statistics string struct sys textwrap time timeit
    traceback types typing unicodedata uuid warnings weakref zlib
    """.split()
)

# The browser's Python is a 32-bit build without processes, and its files are not the server's
# (its error numbers are not either). A program that asks about the machine or works with files
# is run on the server. So is one that replaces sys.excepthook: Pyodide calls that hook itself
# when an exception leaves the program, and it would run twice. For `os` only what is listed may
# be used; for `sys` and `io` everything but what is listed.
OS_ALLOWED = frozenset("path sep linesep pathsep curdir pardir extsep altsep devnull name fspath urandom".split())
DENIED = {
    "sys": frozenset(
        """
        maxsize setrecursionlimit getsizeof getrefcount getallocatedblocks byteorder float_info
        int_info hash_info thread_info platform version version_info implementation executable
        flags abiflags modules path prefix base_prefix exec_prefix getwindowsversion argv
        excepthook displayhook unraisablehook settrace setprofile last_exc last_type last_value
        last_traceback
        """.split()
    ),
    "io": frozenset("open open_code FileIO".split()),
}
DENIED_BUILTINS = {
    "open": "it opens a file",
    "hash": "it uses hash()",
    "__import__": "it uses __import__()",
    "breakpoint": "it uses breakpoint()",
    "help": "it uses help()",
}

# Failures that can be the browser's and not the program's: a number too large for a 32-bit
# build, memory, the system underneath, a module the browser does not have. The server decides.
PLATFORM_ERRORS = (OverflowError, MemoryError, OSError, SystemError, ImportError)


class ServerOnly(BaseException):
    """Raised where the program asks for something only the server runs faithfully."""


_guard = {"on": False, "hit": None}
_real_import = builtins.__import__


def _top(name):
    return str(name).split(".", 1)[0]


def _denied(module, name):
    return name not in OS_ALLOWED if module == "os" else name in DENIED[module]


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    # Only what the program itself imports is looked at; the standard library may import what it
    # needs. The program's code runs as __main__ or, through exec(), without a module name. An
    # import the interpreter makes for its own purposes while the program runs (to parse a date,
    # to print a traceback) arrives with a list as `fromlist`; an import statement never does.
    if _guard["on"] and not isinstance(fromlist, list):
        importer = globals.get("__name__") if isinstance(globals, dict) else None
        if importer is None or importer == "__main__":
            if level or _top(name) not in ALLOWED_MODULES:
                _guard["hit"] = _guard["hit"] or f"it imports {name!r}"
                raise ServerOnly(name)
    return _real_import(name, globals, locals, fromlist, level)


builtins.__import__ = _guarded_import


def _reason_for_server(tree):
    """Why this program is better run on the server, or None."""
    aliases = {}  # name in the program → "sys", "os" or "io"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _top(alias.name) not in ALLOWED_MODULES:
                    return f"it imports {alias.name!r}"
                if alias.name in ("sys", "os", "io"):
                    aliases[alias.asname or alias.name] = alias.name
                elif alias.asname is None and _top(alias.name) == "os":
                    aliases["os"] = "os"  # `import os.path` binds os
        elif isinstance(node, ast.ImportFrom):
            if node.level or _top(node.module or "") not in ALLOWED_MODULES:
                return f"it imports {('.' * node.level) + (node.module or '')!r}"
            if node.module in ("sys", "os", "io"):
                for alias in node.names:
                    if alias.name == "*" or _denied(node.module, alias.name):
                        return f"it uses {node.module}.{alias.name}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases:
            module = aliases[node.value.id]
            if _denied(module, node.attr):
                return f"it uses {module}.{node.attr}"
        elif isinstance(node, ast.Name) and node.id in DENIED_BUILTINS:
            return DENIED_BUILTINS[node.id]
    return None


def _write_source(source):
    # Node.js on the server writes a lone surrogate as U+FFFD; so does this.
    data = source.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")
    shutil.rmtree("/judge", ignore_errors=True)
    os.makedirs(BUILD)
    with open(SCRIPT, "wb") as file:
        file.write(data)
    linecache.clearcache()  # the lines of the program before this one


def check(source):
    """Syntax check, as `python3 -m py_compile main.py` in the program's folder does it."""
    _write_source(source)
    os.chdir(BUILD)
    quiet = io.StringIO()
    real_stderr, sys.stderr = sys.stderr, quiet  # warnings of the compiler are not part of the answer
    try:
        py_compile.compile("main.py", doraise=True)
    except py_compile.PyCompileError as error:
        return json.dumps({"compileError": error.msg, "serverOnly": None})
    finally:
        sys.stderr = real_stderr
        os.chdir("/")
    with open(SCRIPT, "rb") as file:
        tree = ast.parse(file.read(), "main.py")
    return json.dumps({"compileError": None, "serverOnly": _reason_for_server(tree)})


def _standard_stream(fd, name, mode, errors, line_buffering):
    raw = io.FileIO(fd, mode, closefd=False)
    raw.name = name
    buffered = io.BufferedReader(raw) if mode == "r" else io.BufferedWriter(raw)
    stream = io.TextIOWrapper(buffered, encoding="utf-8", errors=errors, newline="\n", line_buffering=line_buffering)
    stream.mode = mode
    return stream


def _exit_status(error):
    """What the interpreter does with SystemExit when it reaches the top."""
    value = error.code
    if value is None:
        return 0
    if isinstance(value, int):
        return (int(value) if -(2**63) <= value < 2**63 else -1) & 0xFF
    try:
        sys.stderr.write(f"{value}\n")
    except Exception:
        pass
    return 1


def _depth(traceback):
    depth = 0
    while traceback is not None:
        depth += 1
        traceback = traceback.tb_next
    return depth


_known = None
_main_before = None

# Modules with a state of their own that programs change (the seed, the precision): the next run
# gets a new copy, as a new process would.
_STATEFUL = ("random", "decimal", "_pydecimal", "fractions", "statistics", "secrets")


def _remember():
    global _known
    if _known is None:
        _known = {
            "builtins": dict(vars(builtins)),
            "environ": dict(os.environ),
            "path": list(sys.path),
            "filters": list(warnings.filters),
            "showwarning": warnings.showwarning,
            "formatwarning": warnings.formatwarning,
        }


def _forget():
    """Leave nothing of this run for the next one: it would have started in a new process."""
    if _main_before is not None:
        sys.modules["__main__"] = _main_before
    for name in set(sys.modules) - _BOOT_MODULES:
        del sys.modules[name]
    for name in _STATEFUL:
        sys.modules.pop(name, None)
    for name in set(vars(builtins)) - set(_known["builtins"]):
        delattr(builtins, name)
    for name, value in _known["builtins"].items():
        if getattr(builtins, name, None) is not value:
            setattr(builtins, name, value)
    os.environ.clear()
    os.environ.update(_known["environ"])
    sys.path[:] = _known["path"]
    warnings.filters[:] = _known["filters"]
    warnings.showwarning = _known["showwarning"]
    warnings.formatwarning = _known["formatwarning"]
    getattr(warnings, "_filters_mutated", lambda: None)()
    sys.setrecursionlimit(RECURSION_LIMIT)
    sys.excepthook = sys.__excepthook__
    sys.displayhook = sys.__displayhook__
    sys.settrace(None)
    sys.setprofile(None)
    for name in ("last_exc", "last_type", "last_value", "last_traceback"):
        if hasattr(sys, name):
            delattr(sys, name)
    atexit._clear()
    os.chdir("/")
    gc.collect()


def begin(index):
    """Everything up to the first statement of the program. Returns (program, globals) for exec()."""
    global _main_before
    _remember()
    folder = f"/judge/t{index}"
    os.makedirs(folder, exist_ok=True)
    os.chdir(folder)
    os.environ["HOME"] = folder
    sys.argv = [SCRIPT]
    sys.path[0] = BUILD
    sys.setrecursionlimit(RECURSION_LIMIT)
    sys.excepthook = sys.__excepthook__
    sys.stdin = sys.__stdin__ = _standard_stream(0, "<stdin>", "r", "strict", False)
    sys.stdout = sys.__stdout__ = _standard_stream(1, "<stdout>", "w", "strict", False)
    sys.stderr = sys.__stderr__ = _standard_stream(2, "<stderr>", "w", "backslashreplace", True)

    _main_before = sys.modules.get("__main__")
    main = types.ModuleType("__main__")
    vars(main).update(__file__=SCRIPT, __builtins__=builtins, __cached__=None, __spec__=None, __loader__=None, __package__=None)
    sys.modules["__main__"] = main
    with io.open_code(SCRIPT) as file:
        program = compile(file.read(), SCRIPT, "exec", dont_inherit=True)
    _guard["on"], _guard["hit"] = True, None
    return program, vars(main)


def finish(index, raised):
    """The end of the program: `raised` says whether exec() ended with an exception (sys.last_exc)."""
    status = 0
    uncaught = None
    doubt = False
    error = getattr(sys, "last_exc", None) if raised else None
    if isinstance(error, SystemExit):
        status = _exit_status(error)
    elif isinstance(error, ServerOnly):
        status = 1
    elif error is not None:
        uncaught = type(error).__name__
        # Recursion that ended before Python's own limit ended at the browser's.
        shallow = isinstance(error, RecursionError) and _depth(error.__traceback__) < RECURSION_LIMIT - 20
        doubt = shallow or isinstance(error, PLATFORM_ERRORS)
        status = 130 if isinstance(error, KeyboardInterrupt) else 1
        try:
            sys.excepthook(type(error), error, error.__traceback__)
        except SystemExit as inner:
            status = _exit_status(inner)
        except BaseException:
            pass
    error = None
    try:
        atexit._run_exitfuncs()
    except BaseException:
        pass
    _guard["on"] = False
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except BaseException:
            status = status or 120
    hit = _guard["hit"]
    try:
        _forget()
        shutil.rmtree(f"/judge/t{index}", ignore_errors=True)
    except BaseException:
        hit = hit or "the run could not be cleaned up"
    return json.dumps({"exitCode": status, "exception": uncaught, "doubt": doubt, "serverOnly": hit})
