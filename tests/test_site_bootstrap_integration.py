"""Execute the two uploaded files against a signed, loopback-only release server.

Only the root precheck and site-only executable discovery are replaced. Bash,
curl/TLS/Range, OpenSSL signatures, flock, artifact executables and file writes run.
The artifact CLI/Agent and registration API are controlled fixtures; this does not
exercise the platform enrollment protocol or an actual SSH handshake.
"""
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import select
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BootstrapIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".kq-bootstrap-integration-", dir=ROOT)
        self.root = Path(self.temporary.name)
        self.upload = self.root / "uploaded"
        self.upload.mkdir()
        self.bootstrap = self.upload / "bootstrap.sh"
        shutil.copyfile(ROOT / "examples/slurm-user-site/bootstrap.sh", self.bootstrap)
        self.local = self.root / "local"
        self.shared = self.root / "shared"
        self.tools = self.root / "tools"
        self.tools.mkdir()
        self.token = self.root / "token"
        self.token.write_text("fixture-registration-secret\n")
        self.log = self.root / "registrations"
        self.cli = (f"#!{sys.executable}\n" + '''import hashlib, json, os, shutil, subprocess
from urllib.parse import urlsplit
from pathlib import Path
import sys
args = sys.argv[1:]
if args[:2] == ['agent', 'register']:
    assert args[args.index('--token-file') + 1] == '-'
    token = sys.stdin.read().strip()
    assert token == 'fixture-registration-secret'
    if os.environ.get('KQ_TEST_REGISTRATION_HTTP') == '1':
        base = args[args.index('--url') + 1]
        target = urlsplit(base)
        options = ['--noproxy', '', '--proxy', os.environ['KQ_HTTP_PROXY_URL']] if os.environ['KQ_TRANSPORT_MODE'] == 'http-proxy' else ['--noproxy', '*', '--connect-to', target.hostname + ':' + str(target.port or 443) + ':127.0.0.1:' + str(json.loads(os.environ['KQ_FORWARD_MAP'])[target.scheme + '://' + target.netloc]['port'])]
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '10', '--cacert', os.environ['KQ_TLS_CA_FILE'], *options, '--header', 'Content-Type: application/json', '--data-binary', '@-', base + '/api/fixture-registration'], input=json.dumps({'token': token}).encode(), check=True, capture_output=True)
    with open(os.environ['KQ_TEST_REGISTRATION_LOG'], 'a') as output:
        output.write('registered\\n')
    if os.environ.get('KQ_TEST_REGISTER_FAIL') == '1':
        raise SystemExit(9)
    directory = Path(args[args.index('--output-dir') + 1])
    (directory / 'certs').mkdir(exist_ok=True)
    for name in ('client.crt', 'client.key', 'ca.crt'):
        shutil.copyfile(Path(os.environ['KQ_TEST_CERT_SOURCE']) / name, directory / 'certs' / name)
    if os.environ.get('KQ_TEST_REGISTER_PARTIAL') == '1':
        (directory / 'agent.env').write_text('')
        raise SystemExit(9)
    config = {'SERVER_HTTP_URL': args[args.index('--url') + 1], 'SERVER_GRPC_URL': args[args.index('--grpc-url') + 1], 'AGENT_ID': 'fixture-agent', 'AGENT_SITE_NAME': 'fixture-site', 'AGENT_MTLS_REQUIRED': 'true', 'AGENT_CERT_DIR': str(directory / 'certs'), 'AGENT_DB_PATH': str(directory / 'agent.db')}
    (directory / 'agent.env').write_text(''.join(name + '=' + json.dumps(value) + '\\n' for name, value in config.items()))
elif args[:2] == ['site', 'doctor']:
    assert '--cert-dir' in args
    assert (Path(args[args.index('--cert-dir') + 1]).parent / 'agent.env').is_file()
    print(json.dumps({'version': 1, 'checks': [], 'complete': True}))
else:
    raise SystemExit('unexpected fixture CLI operation')
''').encode()
        # This shim only bypasses the explicit ordinary-user check in a root test
        # container. Ownership checks still see the real UID; production is intact.
        self.executable("python3", f"#!{sys.executable}\nimport os, sys\nif sys.argv[1:] and sys.argv[1] == '-':\n real_uid = os.getuid\n calls = [0]\n def uid():\n  calls[0] += 1\n  return 1000 if calls[0] == 1 else real_uid()\n os.getuid = uid\n code = sys.stdin.read()\n sys.argv = sys.argv[1:]\n exec(compile(code, '<uploaded-bootstrap>', 'exec'), {{'__name__': '__main__'}})\nelse:\n os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n")
        shim = self.tools / "python3"
        shim.write_text(shim.read_text().replace(" code = sys.stdin.read()", """ if os.environ.get('KQ_TEST_FAIL_BEFORE_STAGED') == '1':
  def fault(frame, event, arg):
   if event == 'call' and frame.f_code.co_name == 'atomic' and str(frame.f_locals.get('path', '')).endswith('/staged'):
    raise OSError('fixture interruption before staged pointer')
  sys.setprofile(fault)
 code = sys.stdin.read()"""))
        self.executable("findmnt", "#!/bin/sh\nprintf 'ext4 rw\\n'\n")
        self.executable("sinfo", "#!/bin/sh\nprintf 'cn|up\\n'\n")
        for tool in ("sbatch", "squeue", "sacct", "scontrol", "scancel"):
            self.executable(tool, "#!/bin/sh\necho 'unexpected scheduler execution' >&2\nexit 88\n")
        self.openssl("genpkey", "-algorithm", "ED25519", "-out", "release.key")
        self.openssl("pkey", "-in", "release.key", "-pubout", "-out", "release.pub")
        self.openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "tls.key", "-out", "tls.crt", "-subj", "/CN=platform.invalid", "-addext", "subjectAltName=DNS:platform.invalid,DNS:localhost", "-days", "1")
        cert_source = self.root / "certificate-source"
        cert_source.mkdir()
        self.openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(cert_source / "client.key"), "-out", str(cert_source / "client.crt"), "-subj", "/CN=fixture-agent", "-days", "1")
        shutil.copyfile(cert_source / "client.crt", cert_source / "ca.crt")
        self.hosts = []
        self.server_names = []
        self.registration_requests = []
        self.proxies = []
        self.responses = {}
        self.requests = []
        self.interrupt = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                owner.hosts.append(self.headers.get("Host"))
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path != "/platform/api/fixture-registration" or body != {"token": "fixture-registration-secret"}:
                    self.send_error(403)
                    return
                owner.registration_requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def do_GET(self):
                owner.hosts.append(self.headers.get("Host"))
                owner.requests.append((self.path, self.headers.get("Range")))
                data = owner.responses.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                offset = int(self.headers["Range"].removeprefix("bytes=").removesuffix("-")) if self.headers.get("Range") else 0
                self.send_response(206 if offset else 200)
                self.send_header("Content-Length", str(len(data) - offset))
                self.send_header("Connection", "close")
                if offset:
                    self.send_header("Content-Range", f"bytes {offset}-{len(data) - 1}/{len(data)}")
                self.end_headers()
                if owner.interrupt == self.path:
                    owner.interrupt = None
                    self.wfile.write(data[:max(1, len(data) // 2)])
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.wfile.write(data[offset:])

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / "tls.crt", self.root / "tls.key")
        context.set_servername_callback(lambda _socket, name, _context: self.server_names.append(name))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.environment = {**os.environ, "HOME": str(self.root / "home"), "PATH": str(self.tools) + os.pathsep + os.environ["PATH"], "KQ_TEST_REGISTRATION_LOG": str(self.log), "KQ_TEST_CERT_SOURCE": str(cert_source)}
        self.write_environment()

    def tearDown(self):
        for proxy, thread, _state in self.proxies:
            proxy.shutdown()
            proxy.server_close()
            thread.join(timeout=2)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def start_proxy(self):
        owner = self
        state = {"connects": [], "reject": False}

        class ConnectHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_CONNECT(self):
                state["connects"].append(self.path)
                allowed = ("platform.invalid:443", f"localhost:{owner.server.server_port}")
                if state["reject"] or self.path not in allowed:
                    self.send_error(403)
                    return
                with socket.create_connection(("127.0.0.1", owner.server.server_port), timeout=5) as upstream:
                    self.send_response(200, "Connection Established")
                    self.end_headers()
                    sockets = (self.connection, upstream)
                    while True:
                        ready, _, _ = select.select(sockets, (), (), 5)
                        if not ready:
                            return
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.connection else self.connection).sendall(data)

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), ConnectHandler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        self.proxies.append((proxy, thread, state))
        return proxy, state

    def executable(self, name, content):
        target = self.tools / name
        target.write_text(content)
        target.chmod(0o700)

    def openssl(self, *args):
        subprocess.run(["openssl", *args], cwd=self.root, check=True, capture_output=True)

    def write_environment(self, **extra):
        values = {"SERVER_HTTP_URL": "https://platform.invalid/platform", "SERVER_GRPC_URL": "https://agent.invalid", "KQ_TRANSPORT_MODE": "ssh-forward", "KQ_GATEWAY_FORWARD": f"{self.server.server_port}:127.0.0.1:{self.server.server_port}", "KQ_REUSE_TUNNEL": "1", "KQ_TLS_CA_FILE": str(self.root / "tls.crt"), "KQ_LOCAL": str(self.local), "KQ_SHARED": str(self.shared), "KQ_RELEASE_PUBLIC_KEY_PEM": (self.root / "release.pub").read_text(), "KQ_REGISTRATION_TOKEN_FILE": str(self.token), **extra}
        self.env_file = self.upload / "site.env"
        self.env_file.write_text("".join(f"export {key}={shlex.quote(value)}\n" for key, value in values.items()))

    def publish(self, sequence, version="v1", extra=None, state_format="site-v1"):
        agent = (f"#!{sys.executable}\nimport json, os\nprint(json.dumps({{'version': {version!r}, 'agentId': os.environ['AGENT_ID'], 'database': os.environ['AGENT_DB_PATH'], 'transport': os.environ['KQ_TRANSPORT_MODE']}}))\n").encode()
        artifacts = {"agent": agent, "kq": self.cli, **(extra or {})}
        manifest = {"version": 1, "redistribution": "unrestricted", "architecture": platform.machine(), "minGlibc": "2.17", "cpuFlags": [], "sequence": sequence, "serverRevision": "a" * 40, "stateFormat": state_format, "files": [{"name": name, "role": "cli" if name == "kq" else "agent" if name == "agent" else "helper", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "executable": name in ("agent", "kq")} for name, data in artifacts.items()]}
        raw = json.dumps(manifest, sort_keys=True).encode()
        release_id = hashlib.sha256(raw).hexdigest()
        (self.root / "manifest").write_bytes(raw)
        self.openssl("pkeyutl", "-sign", "-inkey", "release.key", "-rawin", "-in", "manifest", "-out", "manifest.sig")
        base = f"/platform/api/site-releases/releases/{release_id}"
        self.responses.update({f"{base}/{name}": data for name, data in artifacts.items()})
        self.responses[base + "/manifest.sig"] = (self.root / "manifest.sig").read_bytes()
        self.responses["/platform/api/site-releases/stable/manifest.json"] = raw
        self.responses["/platform/api/agent-binaries"] = json.dumps({"revision": "a" * 40}).encode()
        return release_id, base

    def action(self, name, success=True, stdin=None):
        result = subprocess.run(["bash", str(self.bootstrap), str(self.env_file), name], env=self.environment, input=stdin, text=True, capture_output=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("fixture-registration-secret", result.stdout + result.stderr)
        return result

    def run_agent(self):
        result = subprocess.run(["bash", str(self.local / "run-agent.sh")], env=self.environment, check=True, capture_output=True, text=True, timeout=5)
        return json.loads(result.stdout)

    def test_forwarded_registration_request_preserves_http_url_and_tls_sni(self):
        self.environment["KQ_TEST_REGISTRATION_HTTP"] = "1"
        self.publish(1)
        self.action("install")
        self.assertEqual(self.registration_requests, ["/platform/api/fixture-registration"])
        self.assertEqual(set(self.hosts), {"platform.invalid"})
        self.assertEqual(set(self.server_names), {"platform.invalid"})
        self.assertEqual(self.run_agent()["transport"], "ssh-forward")

    def test_spack_incomplete_signed_release_fails_before_consuming_registration_token(self):
        self.publish(1)
        self.write_environment(KQ_ENABLE_SPACK="1")
        result = self.action("install", success=False)
        self.assertIn("runtime-sif", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertFalse((self.local / "registration" / "pending").exists())
        self.assertFalse((self.local / "current").exists())
        self.assertFalse((self.local / "staged").exists())
        self.assertTrue(self.token.exists())

    def test_connect_proxy_preserves_url_sni_and_transports_signed_install_registration_and_update(self):
        proxy, state = self.start_proxy()
        options = {"KQ_TRANSPORT_MODE": "http-proxy", "KQ_PROXY_FORWARD": f"{proxy.server_port}:127.0.0.1:{proxy.server_port}"}
        self.environment["KQ_TEST_REGISTRATION_HTTP"] = "1"
        # Ambient bypass/proxy variables must not bypass the explicit CONNECT path.
        self.environment.update({"NO_PROXY": "*", "HTTPS_PROXY": "http://127.0.0.1:1"})
        self.write_environment(**options)
        first, _ = self.publish(1)
        self.action("install")
        self.assertEqual(self.run_agent()["transport"], "http-proxy")
        self.assertEqual(self.registration_requests, ["/platform/api/fixture-registration"])
        self.assertTrue(state["connects"])
        self.assertEqual(set(state["connects"]), {"platform.invalid:443"})
        self.assertEqual(set(self.hosts), {"platform.invalid"})
        self.assertEqual(set(self.server_names), {"platform.invalid"})
        second, base = self.publish(2, "v2")
        self.responses[base + "/manifest.sig"] = b"wrong signature"
        self.action("stage", success=False)
        self.assertEqual((self.local / "current").resolve().name, first)
        self.publish(2, "v2")
        self.action("stage")
        self.assertEqual((self.local / "staged").read_text().strip(), second)
        self.write_environment(**options, KQ_MAINTENANCE_WINDOW="1")
        self.action("activate")
        self.assertEqual(self.run_agent()["version"], "v2")
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_failed_connect_proxy_cannot_fall_back_to_a_directly_reachable_tls_origin(self):
        proxy, state = self.start_proxy()
        self.write_environment(KQ_TRANSPORT_MODE="http-proxy", KQ_PROXY_FORWARD=f"{proxy.server_port}:127.0.0.1:{proxy.server_port}", SERVER_HTTP_URL=f"https://localhost:{self.server.server_port}/platform")
        self.publish(1)
        self.action("install")
        self.publish(2, "v2")
        state["reject"] = True
        self.requests.clear()
        self.server_names.clear()
        self.action("stage", success=False)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.server_names, [])
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(state["connects"][-1], f"localhost:{self.server.server_port}")

    def test_rollback_restores_saved_config_despite_a_broken_current_site_environment(self):
        self.publish(1)
        self.action("install")
        old = (self.local / "current").resolve()
        saved = (old / "agent.env").read_bytes()
        self.publish(2, "v2")
        self.action("stage")
        self.token.unlink()
        self.write_environment(KQ_MAINTENANCE_WINDOW="1", SERVER_HTTP_URL="https://broken.invalid/platform", KQ_ACCOUNT="broken-account")
        self.action("activate")
        self.assertIn("broken-account", (self.local / "current/agent.env").read_text())
        self.action("rollback")
        self.assertEqual((self.local / "current").resolve(), old)
        self.assertEqual((old / "agent.env").read_bytes(), saved)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_launcher_reloads_saved_modules_without_persisting_login_environment(self):
        init = self.root / "module-init.sh"
        init.write_text("module() { export LD_LIBRARY_PATH=/fixture/module-libs; export KQ_FIXTURE_MODULES=\"${KQ_FIXTURE_MODULES:-}$2;\"; }\n")
        agent = b"""#!/bin/bash
printf '{"libraries":"%s","modules":"%s"}\\n' "${LD_LIBRARY_PATH:-}" "${KQ_FIXTURE_MODULES:-}"
"""
        self.write_environment(KQ_MODULE_INIT=str(init), KQ_PYTHON_MODULE="python/fixture", KQ_APPTAINER_MODULE="apptainer/fixture")
        release, _ = self.publish(1, extra={"agent": agent})
        self.action("install")
        self.assertEqual(self.run_agent(), {"libraries": "/fixture/module-libs", "modules": "python/fixture;apptainer/fixture;"})
        config = self.local / "releases" / release / "agent.env"
        self.assertNotIn("LD_LIBRARY_PATH", config.read_text())
        self.assertNotIn("KQ_FIXTURE_MODULES", config.read_text())
        self.assertIn("export KQ_PYTHON_MODULE=python/fixture", config.read_text())
        # An old release without module fields ignores ambient site module choices.
        config.write_text("\n".join(line for line in config.read_text().splitlines() if not line.startswith(("export KQ_MODULE_INIT=", "export KQ_PYTHON_MODULE=", "export KQ_APPTAINER_MODULE="))) + "\n")
        self.environment["KQ_PYTHON_MODULE"] = "ambient/must-not-load"
        self.assertEqual(self.run_agent(), {"libraries": "", "modules": ""})
        with config.open("a") as output:
            output.write("export KQ_PYTHON_MODULE=missing/module\n")
        failed = subprocess.run(["bash", str(self.local / "run-agent.sh")], env=self.environment, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("require the module command", failed.stderr)

    def test_services_reports_inactive_agent_without_switching_identity_or_release(self):
        self.publish(1)
        self.action("install")
        before = (self.local / "current").resolve()
        self.environment["HOME"] = str(self.root / "home")
        calls = self.root / "systemctl-calls"
        self.environment["KQ_TEST_SYSTEMCTL_CALLS"] = str(calls)
        self.executable("systemctl", f"#!{sys.executable}\n" + """import json, os, sys
with open(os.environ['KQ_TEST_SYSTEMCTL_CALLS'], 'a') as output:
    output.write(json.dumps(sys.argv[1:]) + '\\n')
if 'is-active' in sys.argv and sys.argv[-1] == 'kq-agent.service':
    raise SystemExit(3)
""")
        result = self.action("services", success=False)
        self.assertEqual((self.local / "current").resolve(), before)
        self.assertEqual(self.log.read_text(), "registered\n")
        status = json.loads((self.local / "status.json").read_text())
        self.assertEqual(status["phase"], "failed")
        self.assertEqual(status["release"], before.name)
        recorded = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertIn(["--user", "is-active", "--quiet", "kq-agent.service"], recorded)
        self.assertNotIn("检查 loginctl", result.stdout)
        update_unit = self.root / "home/.config/systemd/user/kq-update.service"
        self.assertIn("SuccessExitStatus=75", update_unit.read_text())
        for name in ("kq-agent.service", "kq-tunnel.service", "kq-update.service", "kq-update.timer"):
            content = (update_unit.parent / name).read_text()
            self.assertEqual([line for line in content.splitlines() if line.startswith("ConditionHost=")], ["ConditionHost=" + socket.gethostname()])

    def test_check_is_local_without_platform_urls_and_rejects_down_queue_or_unsafe_state_mount(self):
        self.write_environment(SERVER_HTTP_URL="", SERVER_GRPC_URL="", KQ_GATEWAY_FORWARD="")
        result = self.action("check")
        self.assertIn("python-module: not-tested", result.stdout)
        self.assertEqual(self.requests, [])
        self.assertFalse(self.local.exists())
        self.assertFalse(self.shared.exists())
        for mount in ("nfs4 rw", "ext4 ro"):
            with self.subTest(mount=mount):
                self.executable("findmnt", "#!/bin/sh\nprintf '" + mount + "\\n'\n")
                self.action("check", success=False)
                self.assertFalse(self.local.exists())
        self.executable("findmnt", "#!/bin/sh\nprintf 'ext4 rw\\n'\n")
        self.executable("sinfo", "#!/bin/sh\nprintf 'cn|down\\n'\n")
        self.action("check", success=False)
        self.assertFalse(self.local.exists())
        self.assertEqual(self.requests, [])

    def test_check_reports_module_and_linger_conditions_without_installing_or_starting_services(self):
        module_init = self.root / "modules-init.sh"
        module_init.write_text('module() { [[ "$2" == fixture-python ]]; }\n')
        self.executable("systemctl", "#!/bin/sh\necho degraded\nexit 1\n")
        self.executable("loginctl", "#!/bin/sh\necho no\n")
        self.write_environment(KQ_MODULE_INIT=str(module_init), KQ_PYTHON_MODULE="fixture-python", KQ_APPTAINER_MODULE="missing-apptainer", KQ_ENABLE_SPACK="0")
        result = self.action("check")
        self.assertIn("python-module: passed", result.stdout)
        self.assertIn("apptainer-module: failed", result.stdout)
        self.assertIn("user-systemd: passed", result.stdout)
        self.assertIn("linger: failed", result.stdout)
        self.assertFalse(self.local.exists())
        self.assertFalse((self.root / "home/.config").exists())
        self.assertEqual(self.requests, [])
        self.write_environment(KQ_MODULE_INIT=str(module_init), KQ_PYTHON_MODULE="fixture-python", KQ_APPTAINER_MODULE="missing-apptainer", KQ_ENABLE_SPACK="1")
        self.action("check", success=False)
        self.assertFalse(self.local.exists())

    def test_two_uploads_install_reuse_stage_activate_and_rollback(self):
        first, _ = self.publish(1)
        self.assertEqual({path.name for path in self.upload.iterdir()}, {"bootstrap.sh", "site.env"})
        self.action("check")
        self.assertFalse(self.local.exists())
        self.action("install")
        self.assertEqual((self.local / "current").resolve().name, first)
        self.assertEqual(self.log.read_text(), "registered\n")
        self.assertEqual(self.run_agent(), {"version": "v1", "agentId": "fixture-agent", "database": str(self.local / "state/agent.db"), "transport": "ssh-forward"})
        self.assertTrue((self.shared / "helpers/modules-smoke.sh").is_file())
        self.token.unlink()
        self.action("install")
        self.assertEqual(self.log.read_text(), "registered\n")
        second, _ = self.publish(2, "v2")
        self.action("stage")
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual((self.local / "staged").read_text().strip(), second)
        self.action("activate", success=False)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        self.action("activate")
        self.assertEqual(self.run_agent()["version"], "v2")
        self.action("rollback")
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(self.log.read_text(), "registered\n")
        self.assertEqual(json.loads((self.local / "status.json").read_text())["phase"], "rolled-back")
        self.publish(1)
        self.action("stage", success=False)
        self.assertEqual(json.loads((self.local / "highest.json").read_text())["sequence"], 2)
        self.assertEqual(self.run_agent()["version"], "v1")

    def test_interrupted_stage_resumes_range_and_bad_signature_or_update_keeps_old_agent(self):
        first, _ = self.publish(1)
        self.action("install")
        second, base = self.publish(2, "v2")
        self.interrupt = base + "/agent"
        self.action("stage", success=False)
        partial = self.local / "releases" / second / "agent.part"
        self.assertTrue(partial.is_file())
        size = partial.stat().st_size
        self.assertGreater(size, 0)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.action("stage")
        self.assertIn((base + "/agent", f"bytes={size}-"), self.requests)
        self.assertFalse(partial.exists())
        third, base = self.publish(3, "v3")
        self.responses[base + "/manifest.sig"] = b"broken signature"
        self.action("stage", success=False)
        self.assertEqual((self.local / "staged").read_text().strip(), second)
        self.assertEqual((self.local / "current").resolve().name, first)
        third, base = self.publish(3, "v3")
        self.responses[base + "/agent"] = b"wrong bytes"
        self.action("stage", success=False)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(json.loads((self.local / "highest.json").read_text())["sequence"], 2)

    def test_uncertain_registration_is_not_automatically_repeated(self):
        self.publish(1)
        self.environment["KQ_TEST_REGISTER_FAIL"] = "1"
        self.action("install", success=False)
        self.assertTrue((self.local / "registration/pending").is_file())
        self.assertFalse((self.local / "current").exists())
        self.assertEqual(self.log.read_text(), "registered\n")
        del self.environment["KQ_TEST_REGISTER_FAIL"]
        self.action("install", success=False)
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_cli_partial_env_preserves_pending_and_never_allocates_second_identity(self):
        self.publish(1)
        self.environment["KQ_TEST_REGISTER_PARTIAL"] = "1"
        self.action("install", success=False)
        registration = self.local / "registration"
        self.assertEqual((registration / "agent.env").read_text(), "")
        self.assertTrue((registration / "pending").is_file())
        del self.environment["KQ_TEST_REGISTER_PARTIAL"]
        self.action("install", success=False)
        self.assertTrue((registration / "pending").is_file())
        self.assertFalse((self.local / "current").exists())
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_partial_registered_identity_cannot_replace_active_release(self):
        first, _ = self.publish(1)
        self.action("install")
        self.publish(2, "v2")
        self.action("stage")
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        registration = self.local / "registration"
        original = (registration / "agent.env").read_text()
        for name in ("empty-env", "truncated-env", "missing-cert", "wrong-key"):
            with self.subTest(name=name):
                (registration / "agent.env").write_text(original)
                for artifact in ("client.crt", "client.key", "ca.crt"):
                    shutil.copyfile(self.root / "certificate-source" / artifact, registration / "certs" / artifact)
                (registration / "pending").write_text("uncertain")
                if name == "empty-env":
                    (registration / "agent.env").write_text("")
                elif name == "truncated-env":
                    (registration / "agent.env").write_text('AGENT_ID="fixture-agent"\n')
                elif name == "missing-cert":
                    (registration / "certs/client.crt").unlink()
                else:
                    shutil.copyfile(self.root / "tls.key", registration / "certs/client.key")
                self.action("activate", success=False)
                self.assertEqual((self.local / "current").resolve().name, first)
                self.assertTrue((registration / "pending").is_file())
                self.assertEqual(self.log.read_text(), "registered\n")

    def test_stage_interruption_commits_atomic_high_water_before_pointer(self):
        first, _ = self.publish(1)
        self.action("install")
        second, _ = self.publish(2, "v2")
        self.environment["KQ_TEST_FAIL_BEFORE_STAGED"] = "1"
        self.action("stage", success=False)
        del self.environment["KQ_TEST_FAIL_BEFORE_STAGED"]
        self.assertEqual((self.local / "staged").read_text().strip(), first)
        self.assertEqual(json.loads((self.local / "highest.json").read_text()), {"sequence": 2, "release": second})
        self.publish(1)
        self.action("stage", success=False)
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        self.action("activate", success=False)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.publish(2, "v2")
        self.action("stage")
        self.action("activate")
        self.assertEqual(self.run_agent()["version"], "v2")

    def test_legacy_crash_record_is_reconciled_with_verified_active_release(self):
        first, _ = self.publish(1)
        self.action("install")
        second, _ = self.publish(2, "v2")
        self.action("stage")
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        self.action("activate")
        (self.local / "highest.json").unlink()
        (self.local / "highest-sequence").write_text("1")
        (self.local / "highest-release").write_text(first)
        self.publish(1)
        self.action("stage", success=False)
        self.assertEqual(json.loads((self.local / "highest.json").read_text()), {"sequence": 2, "release": second})
        self.assertEqual(self.run_agent()["version"], "v2")
        (self.local / "highest.json").unlink()
        (self.local / "highest-sequence").write_text("2")
        self.action("stage", success=False)
        self.assertFalse((self.local / "highest.json").exists())

    def test_stdin_token_survives_uploaded_python_heredoc(self):
        self.publish(1)
        self.write_environment(KQ_REGISTRATION_TOKEN_FILE="-")
        self.action("install", stdin="fixture-registration-secret\n")
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_signed_checkpoint_name_collision_is_rejected_before_artifacts(self):
        release, base = self.publish(1, extra={"agent.part": b"checkpoint-name"})
        self.action("stage", success=False)
        self.assertNotIn((base + "/agent", None), self.requests)
        self.assertFalse((self.local / "staged").exists())

    def test_update_timer_contender_does_not_overwrite_in_progress_status(self):
        self.publish(1)
        self.action("install")
        status = (self.local / "status.json").read_bytes()
        with (self.local / "bootstrap.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.action("stage", success=False)
            self.assertEqual(result.returncode, 75)
        self.assertEqual((self.local / "status.json").read_bytes(), status)

    def test_same_size_digest_failure_and_corrupted_staged_artifact_keep_old_agent(self):
        first, _ = self.publish(1)
        self.action("install")
        second, base = self.publish(2, "v2")
        original = self.responses[base + "/agent"]
        self.responses[base + "/agent"] = bytes([original[0] ^ 1]) + original[1:]
        failed = self.action("stage", success=False)
        self.assertIn("Release artifact integrity mismatch", failed.stderr)
        self.assertEqual((self.local / "current").resolve().name, first)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(json.loads((self.local / "highest.json").read_text())["sequence"], 1)
        self.assertEqual((self.local / "staged").read_text().strip(), first)
        partial = self.local / "releases" / second / "agent.part"
        partial.unlink(missing_ok=True)
        self.responses[base + "/agent"] = original
        self.action("stage")
        agent = self.local / "releases" / second / "agent"
        agent.chmod(0o700)
        agent.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        self.action("activate", success=False)
        self.assertEqual((self.local / "current").resolve().name, first)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_signed_incompatible_release_cannot_activate_or_be_rollback_target(self):
        first, _ = self.publish(1)
        self.action("install")
        second, _ = self.publish(2, "v2", state_format="incompatible")
        self.action("stage")
        self.assertEqual((self.local / "staged").read_text().strip(), second)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        failed = self.action("activate", success=False)
        self.assertIn("State format migration", failed.stderr)
        # Seed only the local rollback selector to exercise the signed target's format gate.
        (self.local / "previous").write_text(second + "\n")
        failed = self.action("rollback", success=False)
        self.assertIn("State format migration", failed.stderr)
        self.assertEqual((self.local / "current").resolve().name, first)
        self.assertEqual(self.run_agent()["version"], "v1")
        self.assertEqual(self.log.read_text(), "registered\n")

    def test_changed_staged_manifest_cannot_bypass_state_format_gate(self):
        self.publish(1)
        self.action("install")
        second, _ = self.publish(2, "v2", state_format="incompatible")
        self.action("stage")
        manifest = self.local / "releases" / second / "manifest.json"
        manifest.chmod(0o600)
        value = json.loads(manifest.read_text())
        value["stateFormat"] = "site-v1"
        manifest.write_text(json.dumps(value))
        self.write_environment(KQ_MAINTENANCE_WINDOW="1")
        self.action("activate", success=False)
        self.assertEqual(self.run_agent()["version"], "v1")


if __name__ == "__main__":
    unittest.main()
