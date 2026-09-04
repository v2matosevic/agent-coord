"""Opt-in native Codex dispatcher smoke, with two sessions and a localhost backend.

Requires an installed Codex CLI and already trusted installed coordination hooks.
Usage: python scripts/native-codex-smoke.py --profile <existing-approved-profile>
Never writes/copies trust, never bypasses it, and never calls a remote model.
Evidence stays in a unique OS temporary directory, outside the public checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--profile', required=True)
parser.add_argument('--codex', help='Path to the native Codex executable')
opts = parser.parse_args()
root = Path(__file__).resolve().parent.parent
home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))
cfg = tomllib.loads((home / 'config.toml').read_text(encoding='utf8'))
profile_file = home / (opts.profile + '.config.toml')
pcfg = tomllib.loads(profile_file.read_text(encoding='utf8'))
model = pcfg.get('model', cfg.get('model'))
assert model, 'Existing profile must select a model for native tool metadata'
exe = opts.codex or shutil.which('codex')
if os.name == 'nt' and (not exe or Path(exe).suffix.lower() != '.exe'):
    candidates = list((Path(os.environ['APPDATA']) / 'npm/node_modules/@openai/codex').rglob('codex.exe'))
    assert candidates, 'Pass --codex with the native executable path'
    exe = str(candidates[0])
assert exe, 'Codex CLI unavailable'
work = Path(tempfile.mkdtemp(prefix='coord-native-smoke-'))
repo = work / 'repo'
repo.mkdir()
env = dict(os.environ, AGENT_COORD_HOME=str(work / 'coord'), CODEX_THREAD_ID='',
           CLAUDE_CODE_SESSION_ID='', CLAUDECODE='', CLAUDE_PID='',
           AGENT_COORD_NOTIFY='0', AGENT_COORD_DIGEST='0')
hidden = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args], env=env, **hidden).decode().strip()
git('init', '-q')
git('config', 'user.name', 'Coord smoke')
git('config', 'user.email', 'coord-smoke@example.invalid')
(repo / 'coord-smoke.txt').write_bytes(b'original\n')
(repo / 'own.txt').write_bytes(b'own\n')
# Global git guards remain enabled; their records go only to this temporary store.
git('add', '--', 'coord-smoke.txt', 'own.txt')
git('commit', '-qm', 'Native smoke baseline')
identity_uri = (root / 'lib/identity.mjs').as_uri()
(repo / 'identity.mjs').write_text(
    f'import {{agentIdFromEnv}} from {json.dumps(identity_uri)}; '
    'console.log(JSON.stringify({agentId:agentIdFromEnv(),sessionId:process.env.CODEX_THREAD_ID}));', encoding='utf8')
checks, identities, requests, errors, shell_identities = {}, {}, {'a': 0, 'b': 0}, [], {}
ready = {n: threading.Event() for n in ['claimed', 'blocked', 'sent', 'received', 'released', 'patched']}
def wait(name):
    assert ready[name].wait(45), 'Timed out waiting for ' + name
def record(name, value=True):
    assert value, name
    checks[name] = True
def tool(name, arguments):
    return {'type': 'custom_tool_call', 'name': 'exec', 'namespace': 'functions',
            'input': 'text(await tools.' + name + '(' + json.dumps(arguments) + '));'}
def mcp(name, arguments=None):
    return tool('mcp__agent_coord__' + name, arguments or {})
def shell(cmd):
    return tool('exec_command', {'cmd': cmd, 'workdir': str(repo), 'max_output_tokens': 1000})
def patch():
    return tool('apply_patch', '*** Begin Patch\n*** Update File: ' + (repo / 'coord-smoke.txt').as_posix() + '\n@@\n-original\n+patched\n*** End Patch')
def last_output(req):
    rows = [x for x in req.get('input', []) if x.get('type') in ['function_call_output', 'custom_tool_call_output']]
    assert rows, 'No native tool result received'
    out = rows[-1].get('output')
    if isinstance(out, list): out = '\n'.join(x.get('text', '') for x in out)
    return out if isinstance(out, str) else json.dumps(out)
def object_from_output(out):
    # MCP content is wrapped once; shell output has a human-readable exit prefix.
    decoder = json.JSONDecoder()
    for i, ch in enumerate(out):
        if ch != '{': continue
        try:
            value, _ = decoder.raw_decode(out[i:])
            if isinstance(value, dict) and 'agentId' in value: return value
            if isinstance(value, dict) and 'content' in value:
                return object_from_output('\n'.join(x.get('text', '') for x in value['content']))
            if isinstance(value, dict) and isinstance(value.get('output'), str):
                return object_from_output(value['output'])
        except (ValueError, AssertionError): pass
    raise AssertionError('Missing identity in native output: ' + out[:800])
def plan(side, step, req):
    if step == 0:
        return shell('node identity.mjs')
    if step == 1:
        shell_identities[side] = object_from_output(last_output(req))
        return mcp('whoami')
    if step == 2:
        me = object_from_output(last_output(req))
        record(side + '_native_mcp', me.get('coordinationMode') == 'native-hooks' and me.get('identityBasis') == 'hook')
        identities[side] = me
        record(side + '_shell_matches_mcp', all(me[k] == shell_identities[side][k] for k in ['agentId', 'sessionId']))
        if side == 'a': return mcp('claim_files', {'paths': ['coord-smoke.txt', 'own.txt']})
        record('distinct_sessions', identities['a']['agentId'] != identities['b']['agentId'] and identities['a']['sessionId'] != identities['b']['sessionId'])
        return patch()
    if side == 'a':
        if step == 3:
            record('a_claims_granted', last_output(req).count('true') >= 2)
            ready['claimed'].set()
            return shell('Add-Content own.txt updated; git add -- own.txt; git commit -m "Own claimed document" -- own.txt' if os.name == 'nt'
                         else 'echo updated >> own.txt; git add -- own.txt; git commit -m "Own claimed document" -- own.txt')
        if step == 4:
            record('own_commit_allowed', 'Exit code: 0' in last_output(req) or 'exit_code":0' in last_output(req).replace(' ', ''))
            wait('blocked')
            return mcp('post_message', {'to': identities['b']['agentId'], 'body': 'native-smoke-directed-marker'})
        if step == 5:
            delivered = json.dumps([x for x in req.get('input', []) if x.get('role') == 'developer'])
            record('holder_receives_wait_notice', identities['b']['agentId'] + ' is waiting for' in delivered)
            ready['sent'].set()
            wait('received')
            return mcp('release_files', {'paths': ['coord-smoke.txt']})
        if step == 6:
            record('explicit_release', 'coord-smoke.txt' in last_output(req))
            ready['released'].set()
            wait('patched')
            return None
    else:
        if step == 3:
            output = last_output(req)
            record('patch_block_names_holder', identities['a']['agentId'] in output and 'held' in output)
            record('blocked_bytes_unchanged', (repo / 'coord-smoke.txt').read_bytes() == b'original\n')
            ready['blocked'].set()
            wait('sent')
            return shell('Write-Output native-smoke-mail-trigger' if os.name == 'nt' else 'echo native-smoke-mail-trigger')
        if step == 4:
            # Only developer context counts, never the sender's tool arguments.
            delivered = json.dumps([x for x in req.get('input', []) if x.get('role') == 'developer'])
            record('directed_mail_after_local_tool', 'native-smoke-directed-marker' in delivered)
            ready['received'].set()
            wait('released')
            return mcp('claim_files', {'paths': ['coord-smoke.txt']})
        if step == 5:
            record('waiter_reclaims', 'true' in last_output(req))
            return shell('Get-Content coord-smoke.txt' if os.name == 'nt' else 'cat coord-smoke.txt')
        if step == 6:
            record('waiter_rereads', 'original' in last_output(req))
            return patch()
        if step == 7:
            record('patch_after_release', (repo / 'coord-smoke.txt').read_bytes() == b'patched\n')
            ready['patched'].set()
            return None
    raise AssertionError(f'Unexpected step {side}/{step}: ' + last_output(req)[:800])

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        data = b'{"models": []}'
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        side = self.path.strip('/').split('/')[0]
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        step = requests[side]; requests[side] += 1
        (work / f'{side}-request-{step}.json').write_text(json.dumps(req), encoding='utf8')
        try: item = plan(side, step, req)
        except Exception as e:
            errors.append(f'{side}/{step}: {e}'); item = None
            for event in ready.values(): event.set()
        output = []
        events = []
        if item:
            item.update(id=f'{side}-{step}', call_id=f'{side}-{step}', status='completed')
            output.append(item)
            events.append({'type': 'response.output_item.done', 'output_index': 0, 'item': item})
        events.append({'type': 'response.completed', 'response': {'id': f'{side}-response-{step}', 'status': 'completed',
                       'output': output, 'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}}})
        data = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
def trust_state():
    return [tomllib.loads(p.read_text(encoding='utf8')).get('hooks') for p in [home / 'config.toml', profile_file]] + [hashlib.sha256((home / 'hooks.json').read_bytes()).hexdigest()]
before = trust_state()
def run(side):
    overrides = {f'mcp_servers.{name}.enabled': False for name in {**cfg.get('mcp_servers', {}), **pcfg.get('mcp_servers', {})}}
    overrides.update({'model_provider': 'coord_smoke', 'model': model, 'features.code_mode': False, 'features.plugins': False,
        'model_providers.coord_smoke.name': 'Offline native smoke', 'model_providers.coord_smoke.base_url': f'http://127.0.0.1:{server.server_port}/{side}/v1',
        'model_providers.coord_smoke.wire_api': 'responses', 'model_providers.coord_smoke.requires_openai_auth': False,
        'mcp_servers.agent-coord.enabled': True, 'mcp_servers.agent-coord.startup_timeout_sec': 60,
        'mcp_servers.agent-coord.command': shutil.which('node'),
        'mcp_servers.agent-coord.args': [str(root / 'mcp/server.mjs'), '--tool', 'codex'],
        'mcp_servers.agent-coord.env.AGENT_COORD_HOME': str(work / 'coord'),
        'mcp_servers.agent-coord.env.AGENT_COORD_NOTIFY': '0',
        'mcp_servers.agent-coord.env.AGENT_COORD_DIGEST': '0'})
    args = [str(exe), 'exec', '--profile', opts.profile, '--ephemeral', '--json', '-C', str(repo)]
    for key, value in overrides.items(): args += ['-c', key + '=' + json.dumps(value)]
    with (work / f'{side}-events.jsonl').open('w', encoding='utf8') as stdout, (work / f'{side}-stderr.txt').open('w', encoding='utf8') as stderr:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True, encoding='utf8', env=env, **hidden)
        try:
            prompt = 'Reserve manuscript and commit ownership evidence.' if side == 'a' else 'Validate collision refusal and receive directed notification.'
            proc.communicate(prompt, timeout=110)
            record(side + '_native_exit_zero', proc.returncode == 0)
        except Exception as e:
            errors.append(str(e)); proc.terminate(); proc.wait(timeout=10)

try:
    a = threading.Thread(target=run, args=('a',)); a.start()
    wait('claimed')
    b = threading.Thread(target=run, args=('b',)); b.start()
    a.join(115); b.join(115)
    record('hook_definitions_and_trust_unchanged', trust_state() == before)
    with sqlite3.connect(work / 'coord/state.db') as db:
        waits = db.execute('SELECT attempts,editing_attempts,reservation_attempts,outcome,started_at,ended_at FROM file_waits').fetchall()
        record('native_wait_episode_recorded', len(waits) == 1 and waits[0][:4] == (1, 0, 1, 'released') and waits[0][5] >= waits[0][4])
        record('session_end_releases_claims', db.execute('SELECT COUNT(*) FROM file_leases').fetchone()[0] == 0)
        record('session_end_marks_both_dead', all(db.execute('SELECT status FROM agents WHERE agent_id=?', (me['agentId'],)).fetchone() == ('dead',) for me in identities.values()))
except Exception as e:
    errors.append(str(e))
finally:
    server.shutdown()
    summary = {'profile': opts.profile, 'checks': checks, 'errors': errors, 'identities': identities,
               'evidence': str(work), 'limitations': ['Deterministic localhost model responses; actual installed CLI dispatches every tool and hook.', 'MCP reconnect not exercised by this driver.']}
    (work / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf8')
    print(json.dumps(summary, indent=2))
raise SystemExit(1 if errors or not checks.get('patch_after_release') else 0)
