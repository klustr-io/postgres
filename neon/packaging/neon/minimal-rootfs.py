#!/usr/bin/env python3
"""Collect actual ELF dependencies and their package records for minimal runtimes.

The distroless base retains its own package metadata. Additional Debian library
files retain the exact installed source-package versions and copyrights. Native
libraries have an explicit upstream SBOM; they are never relabelled as Debian
packages or made invisible by deleting vulnerability database entries.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

base = Path('/minimal-base')
output = Path('/rootfs')
native = json.loads(Path('/out/qualification/native-dependencies.lock.json').read_text())
roles = {'compute': 'compute_ctl', 'pageserver': 'pageserver', 'safekeeper': 'safekeeper',
         'storage-controller': 'storage_controller', 'storage-broker': 'storage_broker'}
selected_role = os.environ.get('NEON_RUNTIME_ROLE')
if selected_role:
    supported = {**roles, 'proxy': 'proxy'}
    assert selected_role in supported or selected_role == 'all'
    roles = supported if selected_role == 'all' else {selected_role: supported[selected_role]}
dependency_cache = {}
package_cache = {}
status_cache = {}


def base_file(absolute):
    """Resolve image symlinks within the image, not the builder's host root."""
    pending = absolute.lstrip('/').split('/')
    current = base
    for _ in range(100):
        if not pending:
            return current if current.is_file() else None
        name = pending.pop(0)
        if name in ('', '.'):
            continue
        if name == '..':
            assert current != base
            current = current.parent
            continue
        candidate = current / name
        if candidate.is_symlink():
            target = os.readlink(candidate)
            if target.startswith('/'):
                current = base
            pending = target.lstrip('/').split('/') + pending
        else:
            current = candidate
    raise AssertionError('Image symlink recursion limit')


def owner(file):
    if str(file).startswith(('/opt/', '/out/', '/minimal-base/')):
        return None
    original = str(file)
    if original in package_cache:
        return package_cache[original]
    candidates = [str(file.resolve()), original]
    for candidate in list(candidates):
        if candidate.startswith('/usr/lib/'):
            candidates.append(candidate.removeprefix('/usr'))
        elif candidate.startswith('/lib/'):
            candidates.append('/usr' + candidate)
        elif candidate.startswith('/usr/bin/') or candidate.startswith('/usr/sbin/'):
            candidates.append(candidate.removeprefix('/usr'))
        elif candidate.startswith('/bin/') or candidate.startswith('/sbin/'):
            candidates.append('/usr' + candidate)
    for candidate in candidates:
        result = subprocess.run(['dpkg-query', '-S', candidate], capture_output=True, text=True)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                name = line.split(': ', 1)[0]
                if re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?', name):
                    package_cache[original] = name
                    return name
    raise AssertionError(f'No package provenance for system file {original}')


def package_status(name):
    if name not in status_cache:
        status_cache[name] = subprocess.check_output(['dpkg-query', '-s', name], text=True)
    return status_cache[name]


def is_elf(file):
    with file.open('rb') as data:
        return data.read(4) == b'\x7fELF'


def dependencies(file):
    real = str(file.resolve())
    if real not in dependency_cache:
        result = subprocess.run(['ldd', real], capture_output=True, text=True)
        assert result.returncode == 0 and 'not found' not in result.stdout, (real, result.stdout)
        dependency_cache[real] = re.findall(r'(?:=>\s+|^\s*)(/[^\s(]+)', result.stdout, re.M)
    return dependency_cache[real]


for role, executable in roles.items():
    root = output / role
    root.mkdir(parents=True)
    installed = {}
    copied = {}
    queue = []

    def copy(file, destination=None):
        file = Path(file)
        destination = destination or str(file)
        assert destination.startswith('/') and '..' not in Path(destination).parts
        if base_file(destination):
            return
        target = root / destination.lstrip('/')
        if target.exists():
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target, follow_symlinks=True)
        package = owner(file)
        copied[destination] = {'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'source_package': package}
        if package:
            installed[package] = package_status(package)
        if is_elf(file):
            queue.append(file)

    # These small tools support diagnostics and pg_ctl's POSIX shell invocation.
    for tool in ('/usr/bin/cat', '/usr/bin/sha256sum', '/bin/sh'):
        copy(tool)
    copy('/out/bin/' + executable, '/usr/local/bin/' + executable)
    if role in ('compute', 'pageserver'):
        prefix = Path('/opt/postgres/v18')
        for file in prefix.rglob('*'):
            if not file.is_file():
                continue
            relative = file.relative_to(prefix).as_posix()
            if relative.startswith(('include/', 'lib/pgxs/', 'lib/pkgconfig/', 'share/man/')) or file.suffix in ('.a', '.la'):
                continue
            copy(file)
        for file in Path('/opt/neon-native/lib').glob('*.so*'):
            if file.is_file():
                copy(file)
        for file in Path('/usr/lib/x86_64-linux-gnu/ossl-modules').glob('*.so'):
            copy(file)
        copy('/etc/ssl/openssl.cnf')
        copy('/etc/ssl/openssl.cnf', '/usr/lib/ssl/openssl.cnf')
        certificate = base_file('/etc/ssl/certs/ca-certificates.crt')
        assert certificate
        copy(certificate, '/usr/lib/ssl/cert.pem')
        for file in Path('/usr/lib/locale/C.utf8').rglob('*'):
            if file.is_file():
                copy(file)
    while queue:
        file = queue.pop()
        for dependency in dependencies(file):
            copy(dependency)

    metadata = root / 'usr/local/share/neon'
    shutil.copytree('/out/qualification', metadata / 'qualification', dirs_exist_ok=True)
    dependencies_dir = metadata / 'qualification/source-dependencies'
    dependencies_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2('/source/Cargo.lock', dependencies_dir / 'Cargo.lock')
    licenses = metadata / 'licenses'
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copy2('/source/LICENSE', licenses / 'runtime-LICENSE')
    shutil.copy2('/source/NOTICE', licenses / 'runtime-NOTICE')
    shutil.copy2('/pgsource/v18/COPYRIGHT', licenses / 'postgresql-COPYRIGHT')
    shutil.copytree('/out/licenses/native', licenses / 'native', dirs_exist_ok=True)
    shutil.copytree('/out/licenses/extensions', licenses / 'extensions', dirs_exist_ok=True)

    status_dir = root / 'var/lib/dpkg/status.d'
    status_dir.mkdir(parents=True, exist_ok=True)
    for package, stanza in installed.items():
        name = re.search(r'^Package: (.+)$', stanza, re.M)[1]
        existing = base / 'var/lib/dpkg/status.d' / name
        if existing.exists():
            before = re.search(r'^Version: (.+)$', existing.read_text(), re.M)[1]
            after = re.search(r'^Version: (.+)$', stanza, re.M)[1]
            assert before == after, f'Review mixed base package versions: {name}'
        else:
            (status_dir / name).write_text(stanza + '\n')
        copyright_file = Path('/usr/share/doc') / name / 'copyright'
        if copyright_file.is_file():
            shutil.copy2(copyright_file, licenses / (name + '-copyright'))

    etc = root / 'etc'
    etc.mkdir(exist_ok=True)
    (etc / 'passwd').write_text('root:x:0:0:root:/root:/bin/sh\nneon:x:10001:10001:Neon:/var/lib/neon:/bin/sh\nnonroot:x:65532:65532:nonroot:/home/nonroot:/bin/sh\n')
    (etc / 'group').write_text('root:x:0:\nneon:x:10001:\nnonroot:x:65532:\n')
    for directory, mode in [('var/lib/neon', 0o750), ('tmp', 0o1777)]:
        folder = root / directory
        folder.mkdir(parents=True, exist_ok=True)
        folder.chmod(mode)
    os.chown(root / 'var/lib/neon', 10001, 10001)
    (metadata / 'qualification/runtime-file-inventory.json').write_text(json.dumps(copied, indent=2) + '\n')
    base_records = [file.read_text() for file in (base / 'var/lib/dpkg/status.d').iterdir()
                    if file.is_file() and not file.name.endswith('.md5sums')]
    (metadata / 'qualification/runtime-packages.txt').write_text('\n'.join(base_records + list(installed.values())))

    native_components = []
    if role in ('compute', 'pageserver'):
        vendors = {'zlib': 'zlib', 'libxml2': 'xmlsoft', 'libxslt': 'xmlsoft', 'curl': 'haxx'}
        for source in native['sources']:
            name, version = source['name'], source['version']
            native_components.append({'type': 'library', 'name': name, 'version': version,
                'bom-ref': f'native:{name}@{version}', 'purl': f'pkg:generic/{name}@{version}',
                'cpe': f'cpe:2.3:a:{vendors[name]}:{name}:{version}:*:*:*:*:*:*:*',
                'hashes': [{'alg': 'SHA-256', 'content': source['sha256']}],
                'externalReferences': [{'type': 'distribution', 'url': source['url']}]})
    sbom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1,
        'serialNumber': 'urn:uuid:' + str(uuid.uuid5(uuid.NAMESPACE_URL, role + json.dumps(native, sort_keys=True))),
        'components': native_components}
    (metadata / 'qualification/native-libraries.cdx.json').write_text(json.dumps(sbom, indent=2) + '\n')
    extensions = json.loads(Path('/out/qualification/extensions/extensions.lock.json').read_text())
    extension_sbom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1,
        'components': [{'type': 'library', 'name': source['name'], 'version': source['version'],
            'purl': f"pkg:generic/{source['name']}@{source['version']}",
            'licenses': [{'license': {'id': source['license']}}],
            'hashes': [{'alg': 'SHA-256', 'content': source['sha256']}],
            'externalReferences': [{'type': 'distribution', 'url': source.get('url', source.get('repository'))}]}
            for source in extensions['sources']] if role in ('compute', 'pageserver') else []}
    (metadata / 'qualification/extensions.cdx.json').write_text(json.dumps(extension_sbom, indent=2) + '\n')
    assert not (root / 'usr/bin/infocmp').exists() and not base_file('/usr/bin/infocmp'), \
        'An affected ncurses CLI must not enter the minimal runtime'
    print(f'Collected {role}: {len(copied)} additional files and {len(installed)} Debian library/tool packages', flush=True)

Path('/empty-data').mkdir()
Path('/empty-data/.keep').write_text('')
os.chown('/empty-data', 10001, 10001)
os.chown('/empty-data/.keep', 10001, 10001)
