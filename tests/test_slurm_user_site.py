import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


KIT = Path(__file__).resolve().parents[1] / 'examples/slurm-user-site'


class SlurmUserSiteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.init = self.root / 'modules.sh'
        self.init.write_text('module() { return 0; }\n')
        self.config = self.root / 'site.env'
        self.config.write_text((KIT / 'site.env.example').read_text())
        self.env = {
            **os.environ,
            'KQ_MODULE_INIT': str(self.init),
            'KQ_SHARED': str(self.root),
            'KQ_SMOKE_SLEEP_SEC': '0',
            'SLURM_JOB_ID': '12345',
            'KQ_SSH_HOST': 'kq-service',
            'KQ_TUNNEL_FORWARDS': '18443:127.0.0.1:443\n19443:agent.internal:9443',
            'KQ_HTTP_LOCAL_PORT': '18443',
            'KQ_TLS_CA_FILE': '',
        }

    def smoke(self, env=None):
        return subprocess.run(
            ['bash', str(KIT / 'modules-smoke.sh'), str(self.config)],
            cwd=self.root, env=env or self.env, capture_output=True, text=True,
            timeout=10,
        )

    def test_smoke_and_no_overwrite(self):
        result = self.smoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'result.json'
        original = output.read_bytes()
        report = json.loads(original)
        self.assertEqual(report['sum'], 4950)
        self.assertEqual(report['schemaVersion'], 1)
        self.assertEqual(report['kind'], 'kq-compute-inventory')
        self.assertEqual(report['compiler']['status'], 'not-tested')
        self.assertEqual(report['mpi']['status'], 'not-tested')
        self.assertEqual(report['python']['status'], 'passed')
        self.assertEqual(report['shared']['writeReadDelete'], 'passed')
        self.assertEqual(report['managedCapabilities']['isolation']['status'], 'not-tested')
        self.assertEqual(report['managedCapabilities']['scratch']['status'], 'not-tested')
        self.assertNotIn('hostname', report)
        self.assertNotIn('slurmJobId', report)
        self.assertNotIn(str(self.root), original.decode())
        self.assertNotIn('12345', original.decode())
        self.assertIn('KQ_SMOKE_STARTED', result.stdout)
        self.assertNotEqual(self.smoke().returncode, 0)
        self.assertEqual(output.read_bytes(), original)

    def test_selected_tool_versions_and_failed_modules_are_honest(self):
        fake_bin = self.root / 'tools'
        fake_bin.mkdir()
        for name in ('cc', 'mpirun'):
            tool = fake_bin / name
            tool.write_text('#!/bin/bash\necho "version 12.3.4 private-host 10.2.3.4 /private/path"\n')
            tool.chmod(0o755)
        env = {**self.env, 'PATH': str(fake_bin) + ':' + os.environ['PATH'],
               'KQ_SMOKE_COMPILER_MODULE': 'compiler/12', 'KQ_SMOKE_MPI_MODULE': 'mpi/4'}
        result = self.smoke(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(report['compiler']['version'], '12.3.4')
        self.assertEqual(report['mpi']['version'], '12.3.4')
        self.assertNotIn('private-host', json.dumps(report))
        (self.root / 'result.json').unlink()
        self.init.write_text('module() { [[ "$2" == bio-python/* ]]; }\n')
        result = self.smoke(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(report['compiler']['status'], 'failed')
        self.assertEqual(report['mpi']['status'], 'failed')

    def test_managed_scratch_capacity_is_measured_and_runtime_failure_is_reported(self):
        from unittest.mock import patch
        import io
        from contextlib import redirect_stdout
        script = (KIT / 'modules-smoke.sh').read_text().split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        image = self.root / 'fixture.sif'
        image.write_bytes(b'fixture')
        original_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, {**self.env, 'KQ_PYTHON_MODULE': 'python/3', 'KQ_SMOKE_COMPILER_STATUS': 'not-tested', 'KQ_SMOKE_MPI_STATUS': 'not-tested', 'KQ_COMPUTE_SCRATCH': str(self.root), 'KQ_SPACK_SCRATCH_MIN_MIB': '20', 'KQ_CAPABILITY_SIF_PATH': str(image), 'KQ_SPACK_MANAGED_MEMORY_MIB': '32768'}), patch('shutil.disk_usage', return_value=type('Usage', (), {'free': 19 * 1024**2})()), patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1)), redirect_stdout(io.StringIO()):
                exec(compile(script, str(KIT / 'modules-smoke.sh'), 'exec'), {})
        finally:
            os.chdir(original_cwd)
        capabilities = json.loads((self.root / 'result.json').read_text())['managedCapabilities']
        self.assertEqual(capabilities['scratch']['status'], 'failed')
        self.assertEqual(capabilities['scratch']['availableMib'], 19)
        self.assertEqual(capabilities['isolation']['status'], 'failed')
        self.assertEqual(capabilities['memoryMib'], 32768)
        self.assertEqual(len(capabilities['runtimeSifSha256']), 64)

    def test_smoke_refuses_unshared_working_directory(self):
        self.assertNotEqual(self.smoke({**self.env, 'KQ_SHARED': str(self.root / 'other')}).returncode, 0)
        self.assertFalse((self.root / 'result.json').exists())

    def test_inventory_cpu_flags_follow_observed_intersection(self):
        import builtins
        from contextlib import redirect_stdout
        import io
        from unittest.mock import patch
        script = (KIT / 'modules-smoke.sh').read_text().split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        actual_open = builtins.open
        def fixture_open(path, *args, **kwargs):
            if str(path) == '/proc/cpuinfo':
                return io.StringIO('flags : sse2 ssse3 popcnt sse4_2 cx16 lahf_lm avx2 unknown_flag\nflags : sse2 ssse3 popcnt sse4_2 cx16 lahf_lm\n')
            return actual_open(path, *args, **kwargs)
        original_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, {**self.env, 'KQ_PYTHON_MODULE': 'python/3',
                                        'KQ_SMOKE_COMPILER_STATUS': 'not-tested', 'KQ_SMOKE_MPI_STATUS': 'not-tested'}), patch('builtins.open', side_effect=fixture_open), redirect_stdout(io.StringIO()):
                exec(compile(script, str(KIT / 'modules-smoke.sh'), 'exec'), {})
        finally:
            os.chdir(original_cwd)
        report = json.loads((self.root / 'result.json').read_text())
        self.assertEqual(report['cpu']['supportedFlags'], ['cx16', 'lahf_lm', 'popcnt', 'sse2', 'sse4_2', 'ssse3'])

    def test_module_failure_stops_before_output(self):
        self.init.write_text('module() { return 9; }\n')
        self.assertNotEqual(self.smoke().returncode, 0)
        self.assertFalse((self.root / 'result.json').exists())

    def test_login_node_and_invalid_delay_rejected(self):
        env = {key: value for key, value in self.env.items() if key != 'SLURM_JOB_ID'}
        self.assertNotEqual(self.smoke(env).returncode, 0)
        env = {**self.env, 'KQ_SMOKE_SLEEP_SEC': '-1'}
        self.assertNotEqual(self.smoke(env).returncode, 0)
        self.assertFalse((self.root / 'result.json').exists())

    def test_preflight_does_not_contact_cloud_by_default(self):
        fake_bin = self.root / 'bin'
        fake_bin.mkdir()
        for name in ('sbatch', 'sinfo', 'systemctl', 'loginctl', 'lscpu', 'apptainer'):
            command = fake_bin / name
            command.write_text('#!/bin/bash\nexit 1\n')
            command.chmod(0o755)
        marker = self.root / 'network-called'
        curl = fake_bin / 'curl'
        curl.write_text('#!/bin/bash\ntouch "$NETWORK_MARKER"\nexit 99\n')
        curl.chmod(0o755)
        env = {**self.env, 'PATH': str(fake_bin) + ':' + os.environ['PATH'],
               'NETWORK_MARKER': str(marker), 'KQ_ORIGIN': 'https://example.invalid'}
        result = subprocess.run(
            ['bash', str(KIT / 'preflight.sh'), str(self.config)],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())
        self.assertIn('未执行任何云端网络请求', result.stdout)

        # 显式网络检查也必须只通过回环转发，保留原始 URL/Host。
        curl.write_text('#!/bin/bash\nprintf "%s\\0" "$@" > "$NETWORK_MARKER"\nprintf 200\n')
        env['SERVER_HTTP_URL'] = 'https://example.invalid/platform'
        result = subprocess.run(
            ['bash', str(KIT / 'preflight.sh'), str(self.config), '--network'],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = marker.read_bytes().decode().split('\0')[:-1]
        self.assertEqual(args[args.index('--connect-to') + 1], '::127.0.0.1:18443')
        self.assertEqual(args[args.index('--noproxy') + 1], '*')
        self.assertEqual(args[-1], 'https://example.invalid/platform/api/agent-binaries')
        self.assertNotIn('-k', args)

    def tunnel(self, overrides=None, check=False):
        fake_bin = self.root / 'ssh-bin'
        fake_bin.mkdir(exist_ok=True)
        ssh = fake_bin / 'ssh'
        ssh.write_text('#!/bin/bash\nprintf "%s\\0" "$@" > "$SSH_ARGV"\nexit "${SSH_EXIT_CODE:-0}"\n')
        ssh.chmod(0o755)
        env = {**self.env, 'PATH': str(fake_bin) + ':' + os.environ['PATH'],
               'SSH_ARGV': str(self.root / 'ssh-argv'), **(overrides or {})}
        command = ['bash', str(KIT / 'tunnel.sh'), str(self.config)]
        if check:
            command.append('--check')
        return subprocess.run(command, cwd=self.root, env=env, capture_output=True,
                              text=True, timeout=10)

    def test_tunnel_forwards_loopback_and_propagates_failure(self):
        result = self.tunnel({'SSH_EXIT_CODE': '255'})
        self.assertEqual(result.returncode, 255, result.stderr)
        args = (self.root / 'ssh-argv').read_bytes().decode().split('\0')[:-1]
        forwards = [args[i+1] for i, arg in enumerate(args) if arg == '-L']
        self.assertEqual(forwards, ['127.0.0.1:18443:127.0.0.1:443',
                                    '127.0.0.1:19443:agent.internal:9443'])
        self.assertEqual(args[-1], 'kq-service')
        for option in ('BatchMode=yes', 'StrictHostKeyChecking=yes',
                       'ExitOnForwardFailure=yes', 'ForwardAgent=no',
                       'ServerAliveInterval=30', 'ServerAliveCountMax=3'):
            self.assertIn(option, args)
        self.assertNotIn('-f', args)

    def test_tunnel_check_and_invalid_config_never_connect(self):
        result = self.tunnel(check=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'ssh-argv').exists())
        for mappings in ('', '443:localhost:443', '18443:localhost:0',
                         '18443:localhost:443\n18443:localhost:9443',
                         '18443:localhost:443;touch injected'):
            with self.subTest(mappings=mappings):
                result = self.tunnel({'KQ_TUNNEL_FORWARDS': mappings})
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((self.root / 'ssh-argv').exists())
        result = self.tunnel({'KQ_SSH_HOST': '-oProxyCommand=bad'})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((self.root / 'ssh-argv').exists())


if __name__ == '__main__':
    unittest.main()
