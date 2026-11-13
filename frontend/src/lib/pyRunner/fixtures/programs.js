// Python programs that are run both by the server's checker and by the browser's Python, to see
// that the two agree (runtime.test.js). What the server's checker says about each of them is in
// reference.json, written by scripts/python-reference.mjs with the real runner
// (backend/src/services/judge/vmRunner.mjs) and a CPython of the version the server has.
//
// `server` marks a program the browser hands to the server, with a word of the reason it gives.
// Programs in the group "platform" print things a 32-bit and a 64-bit Python may print differently
// (the order of a set, the last digit of a decimal number): where they do, the web app must notice
// and ask the server (judge.js, mayBeTheBrowser).
const programs = [];
const add = (group, name, code, inputs = [''], extra = {}) => programs.push({ group, name, code, inputs, ...extra });

add("programs", "double", String.raw`print(int(input()) * 2)
`, ["21\n", "4", "x\n", "", "  7  \n"]);
add("syntax", "syntax-paren", String.raw`print(
`);
add("syntax", "syntax-indent", String.raw`if True:
print(1)
`);
add("syntax", "syntax-tab", String.raw`def f():
	if True:
        return 1
`);
add("syntax", "syntax-colon", String.raw`for i in range(3)
    print(i)
`);
add("syntax", "syntax-string", String.raw`print("hello)
`);
add("syntax", "syntax-nullbyte", "print(1)\u0000\n");
add("syntax", "syntax-warning", String.raw`import re
print(len("\d"))
`);
add("programs", "prompt", String.raw`name = input("Name: ")
age = int(input("Age: "))
print(f"Hello, {name}! Next year you are {age + 1}.")
`, ["Ana\n20\n", "Ana\n"]);
add("exit", "exit-codes", String.raw`import sys
n = int(input())
print("before")
sys.exit(n)
`, ["0\n", "3\n", "256\n", "-1\n", "300\n"]);
add("exit", "exit-msg", String.raw`import sys
sys.exit("bye bye")
`);
add("exit", "exit-none", String.raw`import sys
print(1)
sys.exit()
`);
add("exit", "exit-obj", String.raw`import sys
sys.exit([1, 2])
`);
add("exit", "quit", String.raw`print(1)
quit()
print(2)
`);
add("exit", "exit-builtin", String.raw`print(1)
exit(4)
`);
add("exit", "raise-systemexit", String.raw`raise SystemExit(7)
`);
add("programs", "zero-div", String.raw`def f(x):
    return 1 / x
print(f(int(input())))
`, ["0\n", "4\n"]);
add("programs", "name-error", String.raw`print(undefined_name)
`);
add("programs", "type-error", String.raw`print("a" + 1)
`);
add("programs", "index-error", String.raw`xs = [1, 2, 3]
print(xs[int(input())])
`, ["5\n", "1\n"]);
add("programs", "key-error", String.raw`d = {"a": 1}
print(d[input()])
`, ["b\n", "a\n"]);
add("programs", "chained", String.raw`try:
    1 / 0
except ZeroDivisionError as e:
    raise ValueError("bad") from e
`);
add("programs", "context", String.raw`try:
    1 / 0
except ZeroDivisionError:
    int("x")
`);
add("programs", "custom-exc", String.raw`class Oops(Exception):
    pass
raise Oops("custom")
`);
add("programs", "exc-group", String.raw`raise ExceptionGroup("many", [ValueError(1), TypeError(2)])
`);
add("programs", "keyboard-interrupt", String.raw`raise KeyboardInterrupt
`);
add("programs", "assert", String.raw`x = int(input())
assert x > 0, "must be positive"
print(x)
`, ["-1\n", "2\n"]);
add("programs", "stdin-read", String.raw`import sys
data = sys.stdin.read().split()
print(sum(map(int, data)), len(data))
`, ["1 2 3\n4\n", ""]);
add("programs", "stdin-lines", String.raw`import sys
for line in sys.stdin:
    print(line.rstrip("\n")[::-1])
`, ["abc\ndef\nxyz", "one\r\ntwo\r\n"]);
add("programs", "stdin-readline", String.raw`import sys
input = sys.stdin.readline
n = int(input())
print([int(input()) for _ in range(n)])
`, ["3\n10\n20\n30\n"]);
add("programs", "open0", String.raw`print(sum(map(int, open(0).read().split())))
`, ["5 6\n", "7\n"], { server: "opens a file" });
add("programs", "stdin-buffer", String.raw`import sys
data = sys.stdin.buffer.read()
print(len(data), data[:5])
`, ["héllo\n"]);
add("programs", "eof", String.raw`while True:
    try:
        line = input()
    except EOFError:
        break
    print(line.upper())
`, ["a\nb\n", ""]);
add("programs", "unicode", String.raw`print("ñ ü 日本 🎉")
s = input()
print(s[::-1], len(s))
`, ["añb\n", "héllo wörld\n"]);
add("programs", "stderr-print", String.raw`import sys
print("out")
print("err", file=sys.stderr)
sys.stderr.write("more\n")
`);
add("programs", "no-newline", String.raw`import sys
sys.stdout.write("no newline")
`);
add("programs", "print-sep-end", String.raw`print(1, 2, 3, sep="-", end="!\n")
print("a", end="")
print("b")
`);
add("programs", "flush", String.raw`print("a", flush=True)
import sys
sys.stdout.flush()
print("b")
`);
add("programs", "formatting", String.raw`x = 3.14159
print(f"{x:.2f} {x:10.3f}|{x:<10.1f}|{1234567:,} {255:#x} {0.1 + 0.2} {1e100} {2**100}")
print("%5d|%-5s|%05.1f" % (42, "ab", 3.14159))
print(round(2.5), round(3.5), round(2.675, 2), 7 // 2, -7 // 2, 7 % -3, divmod(-7, 2))
`);
add("programs", "floats", String.raw`import math
print(math.sqrt(2), math.pi, math.e, math.floor(-2.5), math.ceil(2.1), math.gcd(12, 18), math.factorial(20))
print(0.1 * 3, 1 / 3, 2 ** 0.5, 10 ** -3, float("inf"), -float("inf"), float("nan"))
print(math.sin(1), math.cos(1), math.tan(1), math.log(10), math.log10(1000), math.exp(1), math.atan2(1, 1), math.hypot(3, 4))
print(math.pow(2, 0.5), math.log2(10), math.sinh(1), math.cosh(1), math.tanh(1), math.asin(0.5), math.acos(0.5), math.atan(0.5))
`);
add("programs", "bigint", String.raw`print(2 ** 200, 10 ** 30 // 7, pow(3, 200, 1000007), (123456789 ** 5) % 97, int("9" * 50) + 1)
print((-7) >> 1, 7 << 70, ~5, 5 ^ 3, bin(10), hex(255), oct(8), int("ff", 16))
`);
add("programs", "strings", String.raw`s = input()
print(s.upper(), s.lower(), s.title(), s.swapcase(), s.split(), s.replace("a", "@"), s.count("a"), s.find("z"), s[::-1], s.center(20, "*"))
print(sorted(s), "".join(reversed(s)), s.isalpha(), s.isdigit(), len(s), s.strip().capitalize())
`, ["Hello banana World\n", "abc123\n"]);
add("programs", "lists", String.raw`xs = list(map(int, input().split()))
print(sorted(xs), sorted(xs, reverse=True), max(xs), min(xs), sum(xs), xs[::-1], xs[1:3], len(xs))
xs.append(99); xs.insert(0, -1); xs.remove(99); print(xs, xs.pop(), xs.index(-1))
print([x * x for x in xs if x % 2 == 0], list(enumerate(xs))[:2], list(zip(xs, xs[1:]))[:2], any(x > 5 for x in xs), all(x > 0 for x in xs))
`, ["5 3 8 1 9 2\n"]);
add("programs", "dicts-sets", String.raw`words = input().split()
count = {}
for w in words:
    count[w] = count.get(w, 0) + 1
print(count, sorted(count.items(), key=lambda kv: (-kv[1], kv[0])))
print(sorted(set(words)), len(set(words)), {1, 2, 3} & {2, 3, 4}, {1, 2} | {3}, {1, 2, 3} - {2}, set([3, 1, 2]), {5, 1, 9, 3, 7, 100, 50})
`, ["the quick brown fox jumps over the lazy dog the end\n"]);
add("platform", "set-order-small-ints", String.raw`print({8, 1, 64, 17, 3, 1000, 256, 33}, set(range(20, 0, -3)), frozenset([9, 2, 5]))
for x in {31, 4, 15, 9, 26, 53, 58, 97}:
    print(x, end=" ")
print()
`);
add("programs", "classes", String.raw`class Animal:
    count = 0
    def __init__(self, name):
        self.name = name
        Animal.count += 1
    def speak(self):
        raise NotImplementedError
    def __repr__(self):
        return f"{type(self).__name__}({self.name!r})"
class Dog(Animal):
    def speak(self):
        return "Woof"
class Cat(Animal):
    def speak(self):
        return "Meow"
pets = [Dog("Rex"), Cat("Tom")]
for p in pets:
    print(p, p.speak())
print(Animal.count, isinstance(pets[0], Animal), Dog.__mro__[1].__name__)
Animal("x").speak()
`);
add("programs", "dataclass-enum", String.raw`from dataclasses import dataclass, field
from enum import Enum
class Color(Enum):
    RED = 1
    GREEN = 2
@dataclass(order=True)
class P:
    x: int
    y: int = 0
    tags: list = field(default_factory=list)
print(P(1, 2), sorted([P(2), P(1, 5), P(1, 3)]), Color.RED, Color(2), list(Color), Color.RED.name, Color.GREEN.value)
`);
add("programs", "recursion-ok", String.raw`def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
def depth(n):
    return 0 if n == 0 else 1 + depth(n - 1)
print(fib(20), depth(900))
`);
add("programs", "recursion-inf", String.raw`def f(n):
    return f(n + 1)
f(0)
`);
add("programs", "recursion-inf-print", String.raw`import sys
print(sys.getrecursionlimit())
def f(n):
    return 1 + f(n + 1)
try:
    f(0)
except RecursionError as e:
    print("caught", e)
`);
add("programs", "generators", String.raw`def gen(n):
    for i in range(n):
        yield i * i
g = gen(5)
print(next(g), list(g), sum(gen(10)))
import itertools
print(list(itertools.permutations("abc", 2))[:4], list(itertools.combinations(range(4), 2)), list(itertools.accumulate([1, 2, 3, 4])), list(itertools.product("ab", repeat=2)))
`);
add("programs", "stdlib-mix", String.raw`import collections, functools, heapq, bisect, string, operator, copy, textwrap, json
c = collections.Counter("mississippi")
print(c.most_common(3), collections.deque([1, 2, 3], maxlen=2), collections.OrderedDict(a=1), collections.defaultdict(int)["x"], collections.namedtuple("P", "x y")(1, 2))
print(functools.reduce(operator.mul, range(1, 6)), heapq.nsmallest(2, [5, 1, 4]), bisect.bisect([1, 3, 5], 4), string.ascii_lowercase[:5], copy.deepcopy([[1], [2]]))
print(json.dumps({"b": [1, 2.5, None, True], "a": "ñ"}, sort_keys=True), json.loads("[1, {\"x\": 2}]"), textwrap.fill("the quick brown fox jumps over the lazy dog", 20))
@functools.lru_cache(None)
def f(n):
    return n if n < 2 else f(n - 1) + f(n - 2)
print(f(80))
`);
add("programs", "decimal-fraction", String.raw`from decimal import Decimal, getcontext
from fractions import Fraction
import statistics
getcontext().prec = 30
print(Decimal(1) / Decimal(7), Decimal("0.1") + Decimal("0.2"), Fraction(3, 4) + Fraction(1, 6), Fraction(0.5), statistics.mean([1, 2, 3, 4]), statistics.median([3, 1, 2]), statistics.stdev([1, 2, 3, 4]), statistics.mode([1, 1, 2]))
`);
add("programs", "random-seeded", String.raw`import random
random.seed(42)
print(random.randint(1, 100), random.random(), random.choice("abcdef"), random.sample(range(100), 5), random.uniform(1, 2))
xs = list(range(10))
random.shuffle(xs)
print(xs, random.gauss(0, 1), random.randrange(0, 100, 5))
`);
add("programs", "datetime-fixed", String.raw`import datetime, calendar, time
d = datetime.date(2024, 2, 29)
print(d, d.strftime("%A %d %B %Y"), d + datetime.timedelta(days=366), d.weekday(), d.isoformat(), calendar.isleap(2024), calendar.monthrange(2024, 2))
t = datetime.datetime(2024, 1, 15, 13, 45, 30)
print(t, t.strftime("%Y-%m-%d %H:%M:%S %p %j"), (t - datetime.datetime(2023, 12, 25)).days, datetime.datetime.strptime("2024-03-01", "%Y-%m-%d").date())
print(time.strftime("%Y", time.gmtime(0)), datetime.timedelta(hours=25, minutes=61))
`);
add("programs", "re", String.raw`import re
s = input()
print(re.findall(r"\d+", s), re.sub(r"\s+", " ", s), bool(re.match(r"^[A-Z]", s)), re.split(r"[,;]", s), re.search(r"(\w+)@(\w+)\.com", s).groups())
`, ["Call 555 1234,  or mail ana@example.com; ok 42\n"]);
add("programs", "files", String.raw`with open("out.txt", "w") as f:
    f.write("line1\nline2\n")
with open("out.txt") as f:
    print(f.read().splitlines())
import os
print(os.listdir("."), os.path.exists("out.txt"), os.path.getsize("out.txt"), os.path.basename("/a/b/c.txt"), os.path.splitext("x.tar.gz"))
os.remove("out.txt")
print(os.listdir("."))
try:
    open("missing.txt")
except FileNotFoundError as e:
    print("no file:", e)
`, ["", ""], { server: "os.remove" });
add("programs", "atexit", String.raw`import atexit
atexit.register(lambda: print("bye"))
print("hi")
`);
add("programs", "globals-leak", String.raw`try:
    print(leak)
except NameError:
    print("clean")
import builtins
builtins.leak = 1
print(__name__, __file__.rsplit("/", 1)[-1], __doc__)
import random
random.marker = getattr(random, "marker", 0) + 1
print(random.marker)
`, ["", ""]);
add("programs", "main-guard", String.raw`def main():
    n = int(input())
    print("even" if n % 2 == 0 else "odd")
if __name__ == "__main__":
    main()
`, ["4\n", "7\n"]);
add("programs", "walrus-match", String.raw`data = input().split()
match data:
    case ["add", x, y]:
        print(int(x) + int(y))
    case ["neg", x]:
        print(-int(x))
    case _:
        print("?")
if (n := len(data)) > 2:
    print(n)
`, ["add 2 3\n", "neg 5\n", "what\n"]);
add("programs", "typing-annot", String.raw`from typing import List, Optional
def avg(xs: List[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None
print(avg([1, 2, 3]), avg([]))
`);
add("programs", "lambda-map-filter", String.raw`nums = list(map(int, input().split()))
print(list(map(lambda x: x ** 2, nums)), list(filter(lambda x: x % 2, nums)), sorted(nums, key=lambda x: (x % 3, -x)), max(nums, key=abs))
`, ["3 -8 5 12 -1\n"]);
add("programs", "matrix", String.raw`n = int(input())
m = [[int(x) for x in input().split()] for _ in range(n)]
t = [list(r) for r in zip(*m)]
for row in t:
    print(*row)
print(sum(m[i][i] for i in range(n)))
`, ["2\n1 2\n3 4\n", "3\n1 2 3\n4 5 6\n7 8 9\n"]);
add("programs", "try-finally", String.raw`def f():
    try:
        return int(input())
    except ValueError as e:
        print("bad:", e)
        return -1
    finally:
        print("done")
print(f())
`, ["12\n", "abc\n"]);
add("programs", "os-system", String.raw`import os
os.system("clear")
print("after")
`, [''], { server: "os.system" });
add("programs", "time-sleep", String.raw`import time
t = time.time()
time.sleep(0.2)
print(0.15 < time.time() - t < 2)
`);
add("programs", "excepthook", String.raw`import sys
def hook(t, v, tb):
    print("hooked:", t.__name__, v)
sys.excepthook = hook
1 / 0
`, [''], { server: "sys.excepthook" });
add("programs", "big-output", String.raw`for i in range(3000):
    print("line", i)
`);
add("programs", "warnings", String.raw`import warnings
warnings.warn("careful")
print("ok")
`);
add("programs", "str-surrogate", String.raw`print("caf\u00e9".encode("utf-8"), b"\xc3\xa9".decode(), "\N{GREEK SMALL LETTER ALPHA}", ord("€"), chr(8364), "é".encode("latin-1"))
`);
add("programs", "local-import-in-func", String.raw`def f():
    import math
    return math.floor(2.7)
print(f())
`);
add("programs", "pickle-main", String.raw`import pickle
class A:
    def __init__(self):
        self.x = 1
b = pickle.loads(pickle.dumps(A()))
print(type(b).__name__, b.x, type(b).__module__)
`);
add("programs", "int-str-limit", String.raw`try:
    print(len(str(10 ** 5000)))
except ValueError as e:
    print("ValueError", str(e)[:40])
`);
add("programs", "strptime-lazy", String.raw`import time, datetime
print(time.strptime("2024-05-06", "%Y-%m-%d")[:3], datetime.datetime.strptime("06/05/24", "%d/%m/%y").year)
`);
add("platform", "set-floats", String.raw`print({0.1, 0.2, 0.3, 1.5, 2.25, 100.75, 3.14159})
print(sorted({0.5, 0.25}))
`);
add("platform", "set-tuples", String.raw`print({(1, 2), (3, 4), (0, 0), (5, 6), (2, 1)})
for p in {(1, 1), (2, 2), (3, 3)}:
    print(p)
`);
add("platform", "set-bigints", String.raw`print({10**10, 10**12 + 7, 2**40, 5, 2**31, 2**31 - 1, 2**32 + 5})
`);
add("platform", "set-negints", String.raw`print({-1, -2, -5, 3, 0, -100})
`);
add("platform", "set-bools-none", String.raw`print({True, None, 2, 0.0})
`);
add("platform", "dict-order", String.raw`d = {}
for k in [(2, 3), 1.5, "b", 10**20, None]:
    d[k] = 1
print(d, list(d))
`);
add("platform", "hash-ints", String.raw`print(hash(5), hash(-1), hash(2**31), hash(2**61), hash(1.0), hash(0.5), hash((1, 2)))
`, [''], { server: "hash()" });
add("programs", "deep-c-recursion-200", String.raw`def size(node):
    return 1 + sum(size(c) for c in node)
node = []
for _ in range(200):
    node = [node]
print(size(node))
`);
add("programs", "recursion-900-frames", String.raw`def depth(n):
    return 0 if n == 0 else 1 + depth(n - 1)
print(depth(990))
`);
add("programs", "recursion-limit-edge", String.raw`def depth(n):
    try:
        return 1 + depth(n + 1)
    except RecursionError:
        return 0
print(depth(0))
`);
add("programs", "output-70k", String.raw`print("x" * 70000)
`);
add("programs", "stderr-20k", String.raw`import sys
sys.stderr.write("e" * 20000)
print("ok")
`);
add("platform", "float-repr", String.raw`import math
vals = [math.sin(x) for x in (0.5, 1e5, 1e10, 3.3)] + [math.cos(1e7), math.tan(1.5707), math.exp(10.5), math.log(1.0000001), 1.1 ** 100, 2.5 ** -3.3, math.sqrt(1e-320), math.cbrt(2.0), math.expm1(1e-5), math.log1p(1e-5), math.erf(0.3), math.gamma(5.5), math.lgamma(0.1), math.asinh(2), math.acosh(2), math.atanh(0.5), math.fmod(10, 3.3), math.remainder(10, 3.3)]
for v in vals:
    print(repr(v))
`);
add("platform", "cmath", String.raw`import cmath
print(cmath.sqrt(-1), cmath.exp(1j * cmath.pi), cmath.phase(1 + 1j), abs(3 + 4j), (2 + 3j) ** 2.5)
`);
add("platform", "sum-floats", String.raw`print(sum([0.1] * 10), sum(x / 7 for x in range(100)), 1e16 + 1, 0.1 + 0.7, round(0.1 + 0.7, 15), f"{2 / 3:.20f}")
import math
print(math.fsum([0.1] * 10), math.prod([1.1] * 10), math.dist((0, 0), (1, 1)), math.comb(50, 25), math.perm(20, 5), math.isqrt(10**30), math.sumprod([1.5, 2.5], [3, 4]))
`);
add("programs", "str-methods-unicode", String.raw`print("ǅ".lower(), "ß".upper(), "İ".lower().encode(), "ﬁ".casefold(), "straße".casefold(), "ÀÉÎ".swapcase(), sorted(["é", "e", "z", "É"]), "x".zfill(5), "१२३".isdigit(), int("١٢٣"))
import unicodedata
print(unicodedata.name("ñ"), unicodedata.normalize("NFD", "ñ").encode(), unicodedata.category("A"))
`);
add("programs", "int-digits", String.raw`import sys
try:
    x = int("1" * 5000)
    print("ok")
except ValueError as e:
    print(e)
`);
add("programs", "heavy-loop", String.raw`s = 0
for i in range(3_000_000):
    s += i % 7
print(s)
`);
add("programs", "sorting-big", String.raw`import random
random.seed(7)
xs = [random.randint(0, 10**9) for _ in range(200000)]
xs.sort()
print(xs[0], xs[-1], xs[100000])
`);

export default programs;
