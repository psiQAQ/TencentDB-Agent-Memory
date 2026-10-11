"""Exercise export in a standalone source tree and a contaminated destination."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
CLIENT = Path(__file__).resolve().parents[1]
ROOT = CLIENT.parents[1]
CACHE = ROOT / 'workspace/pi-tests'
CACHE.mkdir(parents=True, exist_ok=True)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='export-', dir=CACHE)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'source'
        shutil.copytree(CLIENT, self.root / 'clients/pi', ignore=shutil.ignore_patterns('__pycache__'))
        (self.root / 'MemoryCore/pi-plugin').mkdir(parents=True)
        shutil.copyfile(ROOT / 'MemoryCore/pi-plugin/index.ts', self.root / 'MemoryCore/pi-plugin/index.ts')
        shutil.copyfile(ROOT / 'LICENSE', self.root / 'LICENSE')
        for args in [
            ['init', '-q'], ['add', '.'],
            ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test fixture'],
        ]:
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        self.output = Path(self.temporary.name) / 'output'
        self.output.mkdir()
        spec = importlib.util.spec_from_file_location('pi_export', self.root / 'clients/pi/export.py')
        self.exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.exporter)

    def export(self, **kwargs):
        args = dict(proxy_url='https://memory.example.com:9443/prefix/proxy/', panel_url='https://panel.example.com/console/',
                    instance_id='default', output=self.output)
        args.update(kwargs)
        return self.exporter.export_bundle(**args)

    def certificate(self):
        ca = Path(self.temporary.name) / 'root.crt'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca.with_suffix('.key')),
                        '-out', str(ca), '-days', '1', '-subj', '/CN=export-test', '-addext', 'basicConstraints=critical,CA:TRUE'],
                       check=True, capture_output=True)
        return ca

    def test_standalone_cli_default_trust_and_manifest(self):
        result = subprocess.run([sys.executable, str(self.root / 'clients/pi/export.py'), '--proxy-url', 'https://memory.example.com/proxy',
                                 '--instance-id', 'default', '--output', str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads((self.output / 'download.json').read_text())
        self.assertEqual(metadata['panelUrl'], 'https://memory.example.com')
        self.assertEqual(metadata['piVersion'], '1.1.0')
        self.assertNotIn('expectedCaSha256', metadata)
        self.assertEqual(metadata['archiveSha256'], hashlib.sha256((self.output / 'pi-client-bundle.zip').read_bytes()).hexdigest())
        with zipfile.ZipFile(self.output / 'pi-client-bundle.zip') as archive:
            self.assertEqual(set(archive.namelist()), {'pi-client-bundle/' + name for name in self.exporter.PUBLIC_FILES})
            manifest = json.loads(archive.read('pi-client-bundle/manifest.json'))
            self.assertFalse(manifest['sourceWorktreeDirty'])
            for name, digest in manifest['fileSha256'].items():
                self.assertEqual(digest, hashlib.sha256(archive.read('pi-client-bundle/' + name)).hexdigest())

    def test_custom_ca_allowlist_and_switch_to_default(self):
        for name in ('pi-user.key', '.admin-key', 'root.key', 'pi-client.jsonc'):
            (self.output / name).write_text('never-package-this')
        self.export(ca_file=self.certificate())
        config = json.loads((self.output / 'pi-client.jsonc.example').read_text())
        self.assertEqual(config['panelUrl'], 'https://panel.example.com/console')
        self.assertEqual(config['caFile'], './root.crt')
        self.assertRegex(config['expectedCaSha256'], r'^[A-F0-9]{64}$')
        with zipfile.ZipFile(self.output / 'pi-client-bundle.zip') as archive:
            self.assertEqual(len(archive.namelist()), 7)
            self.assertFalse(any(b'never-package-this' in archive.read(name) for name in archive.namelist()))
        self.export()
        self.assertFalse((self.output / 'root.crt').exists())
        self.assertEqual((self.output / 'pi-user.key').read_text(), 'never-package-this')

    def test_invalid_inputs_leave_previous_bundle_unchanged(self):
        self.export()
        previous = {name: (self.output / name).read_bytes() for name in ('download.json', 'pi-client-bundle.zip')}
        for changes in ({'proxy_url': 'http://example.com'}, {'panel_url': 'https://user:pass@example.com'},
                        {'proxy_url': 'https://example.com?query=1'}, {'ca_file': self.output / 'missing'}, {'instance_id': '../bad'}):
            with self.assertRaises((ValueError, OSError)):
                self.export(**changes)
        ca = self.certificate()
        ca.write_text(ca.read_text() + ca.with_suffix('.key').read_text())
        with self.assertRaises(ValueError):
            self.export(ca_file=ca)
        for name, content in previous.items():
            self.assertEqual((self.output / name).read_bytes(), content)

    def test_rejects_symlinks_and_missing_sources(self):
        source = self.root / 'clients/pi/pi-client.js'
        original = source.read_bytes()
        source.unlink()
        with self.assertRaises(ValueError):
            self.export()
        target = Path(self.temporary.name) / 'launcher'
        target.write_bytes(original)
        source.symlink_to(target)
        with self.assertRaises(ValueError):
            self.export()
        source.unlink()
        source.write_bytes(original)
        (self.output / 'README.md').symlink_to(target)
        with self.assertRaises(ValueError):
            self.export()
        self.assertEqual(target.read_bytes(), original)

    def test_write_failure_rolls_back_publication(self):
        self.export()
        old = {name: file.read_bytes() for name in self.exporter.OUTPUT_FILES if (file := self.output / name).exists()}
        replace = self.exporter.os.replace
        failed = False

        def fail_once(source, destination):
            nonlocal failed
            if Path(destination).name == 'download.json' and not failed:
                failed = True
                raise OSError('synthetic publication failure')
            return replace(source, destination)

        with patch.object(self.exporter.os, 'replace', side_effect=fail_once):
            with self.assertRaises(OSError):
                self.export(proxy_url='https://different.example.com/proxy')
        for name, content in old.items():
            self.assertEqual((self.output / name).read_bytes(), content)
        self.assertFalse((self.output / '.pi-export.lock').exists())


if __name__ == '__main__':
    unittest.main()
