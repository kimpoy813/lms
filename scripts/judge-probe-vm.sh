#!/bin/bash
# TEMPORARY (exploration). Runs as root inside a Vercel Sandbox and reports whether the pieces the
# real runner will rely on behave there: an unprivileged user, cgroup limits, compilers, timings.
say() { echo "ISO $*"; }
now() { date +%s%N; }
ms() { echo $(( ($(now) - $1) / 1000000 )); }
U=judgeuser
id $U >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $U 2>&1 | head -2
say "user: $(id $U 2>&1) | tools: $(for x in setpriv prlimit timeout pkill useradd unshare; do command -v $x >/dev/null && printf '%s ' $x; done) | util-linux: $(setpriv --version 2>&1 | head -1)"
W=/judge-probe; rm -rf $W; mkdir -p $W/build $W/secret $W/scratch; chmod 711 $W; chmod 700 $W/secret
echo "hidden-input-42" > $W/secret/input.txt; chmod 600 $W/secret/input.txt
echo 21 > $W/in.txt; chmod 644 $W/in.txt
chown $U:$U $W/build $W/scratch
CGROOT=/sys/fs/cgroup
say "cgroup: fs=$(stat -fc %T $CGROOT 2>&1) controllers=[$(cat $CGROOT/cgroup.controllers 2>&1)] subtree=[$(cat $CGROOT/cgroup.subtree_control 2>&1)] init=$(cat /proc/1/comm 2>&1) own-cgroup=$(cat /proc/self/cgroup 2>&1 | tr '\n' ' ')"
CG=$CGROOT/judge-probe
mkdir -p $CG 2>/tmp/cg.err || say "mkdir cgroup: $(cat /tmp/cg.err)"
echo "+memory +pids" > $CGROOT/cgroup.subtree_control 2>/tmp/cg.err || say "root subtree_control: $(cat /tmp/cg.err)"
echo "+memory +pids" > $CG/cgroup.subtree_control 2>/tmp/cg.err || say "judge subtree_control: $(cat /tmp/cg.err)"
say "judge cgroup: controllers=[$(cat $CG/cgroup.controllers 2>&1)] subtree=[$(cat $CG/cgroup.subtree_control 2>&1)] memory.peak=$( [ -e $CG/memory.peak ] && echo yes || echo no)"

# run <label> <mem-MB> <pids> <seconds> <stdin> <cwd> -- cmd...
run() {
  local label=$1 mem=$(( $2 * 1024 * 1024 )) pids=$3 secs=$4 input=$5 dir=$6; shift 7
  local leaf=$CG/$label; mkdir -p $leaf 2>/dev/null
  local cgok=yes
  echo $mem > $leaf/memory.max 2>/dev/null || cgok=no
  echo 0 > $leaf/memory.swap.max 2>/dev/null
  echo $pids > $leaf/pids.max 2>/dev/null || cgok=no
  local s=$(now)
  ( cd $dir && timeout -s KILL $secs sh -c 'if [ -n "$1" ]; then echo $$ > "$1/cgroup.procs" || exit 97; fi; shift; exec setpriv --reuid='$U' --regid='$U' --clear-groups --no-new-privs prlimit --fsize=16777216 --core=0 --nofile=256 -- "$@"' sh "$( [ $cgok = yes ] && echo $leaf )" "$@" < $input > /tmp/out.$label 2> /tmp/err.$label ) 2>/dev/null
  local code=$?
  local t=$(ms $s)
  pkill -KILL -u $U 2>/dev/null
  local peak=$(cat $leaf/memory.peak 2>/dev/null); local oom=$(grep -s '^oom_kill ' $leaf/memory.events | awk '{print $2}'); local hits=$(grep -s '^max ' $leaf/pids.events | awk '{print $2}')
  say "$label: exit=$code ${t}ms cg=$cgok peak=$(( ${peak:-0} / 1024 ))KB oom_kill=${oom:-?} pids_hits=${hits:-?} out=$(head -c ${OUTMAX:-100} /tmp/out.$label | tr '\n' '|') err=$(tail -c 220 /tmp/err.$label | tr '\n' '|')"
  rmdir $leaf 2>/dev/null
}

cd $W/build
printf 'import sys\nprint(int(sys.stdin.readline()) * 2)\n' > main.py
printf "const n = Number(require('fs').readFileSync(0, 'utf8'));\nconsole.log(n * 2);\n" > main.js
printf '#include <stdio.h>\nint main(void){int n; if(scanf("%%d",&n)!=1) return 1; printf("%%d\\n", n*2); return 0;}\n' > main.c
printf '#include <bits/stdc++.h>\nusing namespace std;\nint main(){int n; cin >> n; vector<int> v(n, 2); cout << accumulate(v.begin(), v.end(), 0) << "\\n";}\n' > main.cpp
printf 'import java.util.Scanner;\npublic class Main { public static void main(String[] a){ Scanner s = new Scanner(System.in); System.out.println(s.nextInt()*2); } }\n' > Main.java
printf 'int main(void){ return undeclared; }\n' > bad.c
printf '#include "/judge-probe/secret/input.txt"\nint main(void){return 0;}\n' > leak.c
printf 'while True: pass\n' > loop.py
printf 'x = bytearray(400 * 1024 * 1024)\nfor i in range(0, len(x), 4096): x[i] = 1\nprint(len(x))\n' > mem.py
cat > bomb.py <<'P'
import os, time
n = 0
try:
    while True:
        if os.fork() == 0:
            time.sleep(3); os._exit(0)
        n += 1
except OSError as e:
    print("fork failed after", n, e.strerror)
P
cat > snoop.py <<'P'
import os, subprocess, socket
for p in ["/judge-probe/secret/input.txt", "/judge-probe/secret", "/etc/shadow", "/root", "/judge-probe/in.txt"]:
    try:
        open(p).read() if os.path.isfile(p) else os.listdir(p); print("READ", p)
    except Exception as e: print("denied", p)
for cmd in (["sudo", "-n", "id", "-u"], ["su", "-c", "id -u", "root"]):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL); print(cmd[0], r.returncode, (r.stdout + r.stderr).strip()[:70].replace("\n", " "))
    except Exception as e: print(cmd[0], "failed", type(e).__name__)
print("uid", os.getuid(), "groups", os.getgroups())
try:
    open("/judge-probe/build/planted.txt", "w").write("x"); print("WROTE build dir")
except Exception as e: print("build read-only")
try:
    os.kill(1, 9); print("KILLED pid 1")
except Exception as e: print("kill pid1 denied")
print("others' processes visible:", len([p for p in os.listdir("/proc") if p.isdigit()]))
try:
    socket.create_connection(("1.1.1.1", 443), timeout=4).close(); print("NETWORK reachable")
except Exception as e: print("network:", type(e).__name__)
P
printf 'while True: print("x" * 1000)\n' > flood.py
chown -R $U:$U $W/build

say "versions: $(gcc --version 2>&1 | head -1) | $(g++ --version 2>&1 | head -1) | $(javac -version 2>&1 | head -1) | $(java -version 2>&1 | head -1) | $(python3 --version 2>&1) | node $(node --version 2>&1) at $(command -v node) | python3 at $(command -v python3)"
run cc 1024 256 30 /dev/null $W/build -- gcc -O2 -pipe -o main_c main.c
run cxx 1024 256 30 /dev/null $W/build -- g++ -O2 -pipe -std=c++17 -o main_cpp main.cpp
run javac 1024 256 30 /dev/null $W/build -- javac -encoding UTF-8 Main.java
run badc 1024 256 30 /dev/null $W/build -- gcc -O2 -o bad bad.c
run leakc 1024 256 30 /dev/null $W/build -- gcc -O2 -o leak leak.c
chown -R root:root $W/build; chmod -R a+rX,go-w $W/build
say "build dir: $(ls $W/build | tr '\n' ' ')"
run py 128 64 5 $W/in.txt $W/scratch -- python3 $W/build/main.py
run js 192 64 5 $W/in.txt $W/scratch -- node --max-old-space-size=128 $W/build/main.js
run c 128 64 5 $W/in.txt $W/scratch -- $W/build/main_c
run cpp 128 64 5 $W/in.txt $W/scratch -- $W/build/main_cpp
run java-default 256 128 10 $W/in.txt $W/scratch -- java -cp $W/build Main
run java-tuned 224 128 10 $W/in.txt $W/scratch -- java -XX:+UseSerialGC -Xss64m -Xmx128m -XX:TieredStopAtLevel=1 -cp $W/build Main
run java-128 128 128 10 $W/in.txt $W/scratch -- java -XX:+UseSerialGC -Xmx64m -cp $W/build Main
run loop 128 64 2 $W/in.txt $W/scratch -- python3 $W/build/loop.py
run mem 128 64 10 $W/in.txt $W/scratch -- python3 $W/build/mem.py
run bomb 128 32 10 $W/in.txt $W/scratch -- python3 $W/build/bomb.py
OUTMAX=700 run snoop 128 64 15 $W/in.txt $W/scratch -- python3 $W/build/snoop.py
s=$(now); n=$(timeout -s KILL 3 setpriv --reuid=$U --regid=$U --clear-groups --no-new-privs python3 $W/build/flood.py 2>/dev/null | head -c 70000 | wc -c); say "flood: $n bytes kept, pipe closed after $(ms $s)ms"; pkill -KILL -u $U 2>/dev/null
say "leftover processes of $U: $(pgrep -u $U | wc -l) | scratch: $(ls -A $W/scratch | wc -l) files | disk free: $(df -h / | awk 'NR==2{print $4}')"
rmdir $CG 2>/dev/null; rm -rf $W /tmp/out.* /tmp/err.*
