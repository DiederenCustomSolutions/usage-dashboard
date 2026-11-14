#!/usr/bin/env python3
"""Manage one visible measuring Chrome that is started by script (Kevin and Kevin LXDG-DCS).

usage-chrome-script.py <name> start|stop|restart|status|cdp

One script for every profile with "start": "script" in the profile list (profielen.json): the name,
the debug port and the profile folder come from there, nothing is hard-coded per user. Replaces the
two copies ~/bin/start-usage-chrome-kevin[-lxdg].sh (kept as thin shims). The flags always include
--password-store=basic: without it the login keyring stays locked after an automatic login and all
accounts lose their login (10-11-2026). Never leave it out.
"""
import fcntl, json, os, shlex, signal, subprocess, sys, time, urllib.request
from pathlib import Path

HOME = Path.home()
HERE = Path(__file__).resolve().parent
EXT = 'dclbninbceiifmbadajdoljbjcjfmloc'
REPO = str(HERE.parent)          # the extension is loaded from this clone (agent-api/..)


def load_profile(name):
    conf = Path(os.environ.get('USAGE_API_DIR') or HOME / '.config' / 'usage-api')
    for f in (Path(os.environ['USAGE_PROFIELEN']) if os.environ.get('USAGE_PROFIELEN') else conf / 'profielen.json', HERE / 'profielen.example.json'):
        if f.exists():
            for p in json.loads(f.read_text())['profielen']:
                if p['naam'] == name and p.get('start') == 'script':
                    return p
            raise RuntimeError('Geen script-profiel met die naam in ' + str(f))
    raise RuntimeError('profielen.json niet gevonden')


def title(p):
    return p.get('label') or p['naam']


def flags(profile_dir, port):
    return ['--ozone-platform=x11', '--password-store=basic', '--user-data-dir=' + profile_dir, '--no-first-run',
            '--no-default-browser-check', '--disable-features=DisableLoadExtensionCommandLineSwitch',
            '--load-extension=' + REPO, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + str(port),
            '--enable-unsafe-extension-debugging']


def processes():
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            if p.stat().st_uid != os.getuid():
                continue
            args = [s for s in (p / 'cmdline').read_bytes().decode().split('\0') if s]
            if len(args) == 1:
                args = shlex.split(args[0])
            if args and args[0] == '/opt/google/chrome/chrome' and not any(a.startswith('--type=') for a in args):
                env = dict(s.split('=', 1) for s in (p / 'environ').read_bytes().decode().split('\0') if '=' in s)
                yield int(p.name), args, env
        except (OSError, UnicodeError, ValueError):
            pass


def display_env(profile_dir):
    env = os.environ.copy()
    keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION']
    for _, _, e in sorted(processes(), key=lambda p: profile_dir not in ' '.join(p[1])):
        if e.get('DISPLAY') == ':0':
            for k in keys:
                if k in e:
                    env[k] = e[k]
            if env.get('XAUTHORITY') and Path(env['XAUTHORITY']).exists():
                break
    run_dir = '/run/user/%d' % os.getuid()
    env.update(DISPLAY=':0', WAYLAND_DISPLAY='wayland-0', XDG_RUNTIME_DIR=run_dir, XDG_SESSION_TYPE='wayland')
    if not env.get('DBUS_SESSION_BUS_ADDRESS'):
        env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + run_dir + '/bus'
    if not env.get('XAUTHORITY') or not Path(env['XAUTHORITY']).exists():
        candidates = sorted(Path(run_dir).glob('.mutter-Xwaylandauth.*'), key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            raise RuntimeError('Geen actuele XAUTHORITY gevonden; meld eerst aan op het bureaublad.')
        env['XAUTHORITY'] = str(candidates[0])
    return env


NODE = '''
let input=''; for await (const c of process.stdin) input+=c;
const req=JSON.parse(input);
const v=await (await fetch('http://127.0.0.1:'+process.argv[1]+'/json/version')).json();
const ws=new WebSocket(v.webSocketDebuggerUrl);
const timer=setTimeout(()=>{console.error('DevTools timeout');process.exit(1)},15000);
ws.onopen=()=>ws.send(JSON.stringify({id:1,...req}));
ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id!==1)return;clearTimeout(timer);ws.close();if(r.error){console.error(JSON.stringify(r.error));process.exitCode=1}else console.log(JSON.stringify(r.result));};
ws.onerror=()=>{console.error('DevTools verbinding mislukt');process.exit(1)};
'''


class Chrome:
    def __init__(self, p):
        self.p = p
        self.name = title(p)
        self.port = p['debugpoort']
        self.dir = str(HOME / '.config' / ('chrome-usage-' + p['naam']))

    def mine(self):
        return [p for p in processes() if '--user-data-dir=' + self.dir in p[1]]

    def cdp(self, method, params=None):
        r = subprocess.run(['node', '--input-type=module', '-e', NODE, str(self.port)], input=json.dumps({'method': method, 'params': params or {}}),
                           text=True, capture_output=True, timeout=20)
        if r.returncode:
            raise RuntimeError(r.stderr.strip())
        return json.loads(r.stdout)

    def stop(self):
        for pid, _, _ in self.mine():
            # Hercontroleer het profiel onmiddellijk vóór signaleren.
            if pid in [p[0] for p in self.mine()]:
                os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not self.mine():
                print(self.name + ' Chrome gestopt.')
                return
            time.sleep(.2)
        raise RuntimeError(self.name + ' Chrome sluit nog af; geen geforceerde stop uitgevoerd.')

    def start(self):
        existing = self.mine()
        if existing:
            print(self.name + ' Chrome draait al; PID ' + str(existing[0][0]))
            return
        env = display_env(self.dir)
        # Zonder Extern bureaublad is het scherm 0 x 0. Chrome start dan gewoon, behalve met een onthouden
        # gemaximaliseerde vensterpositie: die eerst weghalen (zie ~/bin/chrome-usage-prestart.sh, 04-10-2026).
        subprocess.run([str(HOME / 'bin' / 'chrome-usage-prestart.sh'), self.dir], timeout=15)
        start_page = 'https://' + ('claude.ai/robots.txt' if (self.p.get('diensten') or ['chatgpt'])[0] == 'claude' else 'chatgpt.com/robots.txt')
        process = subprocess.Popen(['/opt/google/chrome/chrome', *flags(self.dir, self.port), start_page], env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            try:
                with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % self.port, timeout=1) as r:
                    json.load(r)
                break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError('Chrome is tijdens opstarten gestopt; controleer Extern bureaublad en schermgrootte.')
                time.sleep(.2)
        else:
            raise RuntimeError(self.name + ' Chrome debugpoort is niet beschikbaar.')
        # Alleen een endpoint gebruiken als het eigen profiel met de juiste poort draait.
        own = self.mine()
        if not own or '--remote-debugging-port=%d' % self.port not in own[0][1]:
            raise RuntimeError('Debugpoort hoort niet aantoonbaar bij ' + self.name + '.')
        loaded = self.cdp('Extensions.getExtensions').get('extensions', [])
        if any(e.get('id') == EXT for e in loaded):
            print('Extensie was al geladen na Chrome-start.')
        else:
            result = self.cdp('Extensions.loadUnpacked', {'path': REPO})
            if result.get('id') != EXT:
                raise RuntimeError('Onverwacht extensie-id: ' + str(result.get('id')))
            print('Extensie via DevTools geladen: ' + EXT)
        print(self.name + ' Chrome gestart; PID ' + str(own[0][0]))


def main():
    if len(sys.argv) < 2:
        raise RuntimeError('Gebruik: usage-chrome-script.py <naam> start | stop | restart | status')
    c = Chrome(load_profile(sys.argv[1]))
    action = sys.argv[2] if len(sys.argv) > 2 else 'start'
    lock = HOME / '.cache' / ('usage-chrome-' + c.p['naam'] + '.lock')
    lock.parent.mkdir(exist_ok=True)
    with lock.open('w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        if action == 'start':
            c.start()
        elif action == 'stop':
            c.stop()
        elif action == 'restart':
            env = display_env(c.dir)
            os.environ.update({k: env[k] for k in ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION'] if k in env})
            c.stop()
            c.start()
        elif action == 'status':
            print(c.name + ' Chrome PID: ' + ','.join(str(p[0]) for p in c.mine()) if c.mine() else c.name + ' Chrome staat uit.')
        elif action == 'cdp':
            request = json.load(sys.stdin)
            print(json.dumps(c.cdp(request['method'], request.get('params'))))
        else:
            raise RuntimeError('Gebruik: start | stop | restart | status')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('Fout: ' + str(e), file=sys.stderr)
        sys.exit(1)
