#!/usr/bin/env python3
"""Export a deployment-specific public Pi bundle from this repository."""

import argparse
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

CLIENT = Path(__file__).resolve().parent
ROOT = CLIENT.parents[1]
PUBLIC_FILES = ('tdai-memory.ts', 'pi-client.js', 'pi-client.jsonc.example', 'README.md', 'LICENSE', 'manifest.json')
OUTPUT_FILES = (*PUBLIC_FILES, 'root.crt', 'pi-client-bundle.zip', 'download.json')
INSPECT = """
const fs = require('node:fs');
const { normalizeHttpsUrl, publicCertificate } = require(process.argv[1]);
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const proxyUrl = normalizeHttpsUrl(input.proxyUrl, 'proxyUrl');
  const panelUrl = normalizeHttpsUrl(input.panelUrl ?? new URL(proxyUrl).origin, 'panelUrl');
  const certificate = input.caFile ? publicCertificate(input.caFile) : undefined;
  process.stdout.write(JSON.stringify({proxyUrl, panelUrl, expectedCaSha256: certificate?.fingerprint}));
} catch (error) { console.error(error.message); process.exit(1); }
"""


def read_regular(file):
    if file.is_symlink() or not file.is_file():
        raise ValueError(f'Public bundle input must be a regular file: {file.name}')
    return file.read_bytes()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def publish(output, files):
    """Stage every file before publication; restore the old bundle on errors."""
    output.mkdir(parents=True, exist_ok=True)
    for name in OUTPUT_FILES:
        target = output / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f'Output must be a regular file: {name}')
    lock = output / '.pi-export.lock'
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with tempfile.TemporaryDirectory(prefix='.pi-export-', dir=output) as temporary:
            stage = Path(temporary)
            backup = stage / 'previous'
            backup.mkdir()
            for name, content in files.items():
                (stage / name).write_bytes(content)
            for name in OUTPUT_FILES:
                if (output / name).exists():
                    shutil.copyfile(output / name, backup / name)
            changed = []
            try:
                # download.json is the publication marker and is replaced last.
                for name in OUTPUT_FILES:
                    changed.append(name)
                    if name in files:
                        os.replace(stage / name, output / name)
                    elif (output / name).exists():
                        (output / name).unlink()
            except OSError:
                for name in reversed(changed):
                    if (backup / name).exists():
                        os.replace(backup / name, output / name)
                    elif (output / name).exists():
                        (output / name).unlink()
                raise
    finally:
        lock.unlink()


def export_bundle(proxy_url, panel_url, instance_id, output, ca_file=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', instance_id) or instance_id.startswith('replace-with-'):
        raise ValueError('instance-id must be a concrete service identity')
    output = Path(output).absolute()
    if output.resolve() in {ROOT, CLIENT, ROOT / 'MemoryCore/pi-plugin'}:
        raise ValueError('Output must not overwrite a source directory')
    sources = {
        'tdai-memory.ts': ROOT / 'MemoryCore/pi-plugin/index.ts',
        'pi-client.js': CLIENT / 'pi-client.js',
        'README.md': CLIENT / 'README.md',
        'LICENSE': ROOT / 'LICENSE',
    }
    files = {name: read_regular(file) for name, file in sources.items()}
    config = json.loads(read_regular(CLIENT / 'pi-client.jsonc.example'))
    compatibility = json.loads(read_regular(CLIENT / 'compatibility.json'))
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', compatibility['piVersion']):
        raise ValueError('Invalid recommended Pi version')
    if ca_file is not None:
        ca_file = Path(ca_file).absolute()
        files['root.crt'] = read_regular(ca_file)
    result = subprocess.run(
        ['node', '-e', INSPECT, str(CLIENT / 'pi-client.js')],
        input=json.dumps({'proxyUrl': proxy_url, 'panelUrl': panel_url, 'caFile': str(ca_file) if ca_file else None}),
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError(result.stderr.strip())
    deployment = json.loads(result.stdout)
    config.update(proxyUrl=deployment['proxyUrl'], panelUrl=deployment['panelUrl'], spaceId=instance_id)
    if ca_file:
        config.update(caFile='./root.crt', expectedCaSha256=deployment['expectedCaSha256'])
    files['pi-client.jsonc.example'] = encoded(config)
    revision = git('rev-parse', 'HEAD')
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Source revision must be a 40-character Git SHA')
    manifest = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sourceRevision': revision,
        'sourceWorktreeDirty': bool(git('status', '--porcelain')),
        'pluginDirty': bool(git('status', '--porcelain', '--', 'MemoryCore/pi-plugin')),
        'pluginSha256': digest(files['tdai-memory.ts']),
        'files': sorted(files),
        'fileSha256': {name: digest(content) for name, content in sorted(files.items())},
    }
    files['manifest.json'] = encoded(manifest)
    # Use an in-memory archive; never enumerate the destination directory.
    stream = BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in (*PUBLIC_FILES, *(('root.crt',) if ca_file else ())):
            archive.writestr('pi-client-bundle/' + name, files[name])
    files['pi-client-bundle.zip'] = stream.getvalue()
    if len(files['pi-client-bundle.zip']) > 2 * 1024 * 1024:
        raise ValueError('Pi bundle exceeds the Panel 2 MiB limit')
    files['download.json'] = encoded({
        'instanceId': instance_id, **deployment,
        'sourceRevision': revision,
        'pluginSha256': manifest['pluginSha256'],
        'archiveSha256': digest(files['pi-client-bundle.zip']),
        'piVersion': compatibility['piVersion'],
    })
    publish(output, files)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proxy-url', required=True)
    parser.add_argument('--panel-url')
    parser.add_argument('--instance-id', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ca-file', type=Path)
    args = parser.parse_args()
    try:
        output = export_bundle(args.proxy_url, args.panel_url, args.instance_id, args.output, args.ca_file)
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as error:
        parser.exit(1, f'ERROR: {error}\n')
    print(f'PASS: Pi public client bundle exported to {output}')


if __name__ == '__main__':
    main()
