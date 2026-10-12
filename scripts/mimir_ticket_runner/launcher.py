"""Build a locked runtime in campaign storage and serve Studio in the foreground.

``studio/mimir-runtime.lock.json`` in the configured Studio source uses schema:
    {"version": 1, "mimir": {"repository": "wasimysaid/mimir", "revision": SHA},
     "frontend": null | {
         "plugin_id": "actual.manifest.id",
         "build": [{"repo": "studio" | "mimir", "cwd": "relative/path/or/.",
                    "argv": ["executable", "argument"], "timeout": 1800}],
         "package": {"repo": "studio" | "mimir", "path": "relative/package"},
         "artifacts": {"mimir-plugin.toml": SHA256, "plugin.wasm": SHA256},
         "environment": {"UNSLOTH_IMPLEMENTED_BINARY_SETTING": "{mimir_binary}",
                         "UNSLOTH_IMPLEMENTED_PACKAGE_SETTING": "{plugin_package}"}}}

Artifact paths are relative to a staged package; every package file must be
hashed, including assets. Build commands run without a shell in isolated clones.
Argument/environment templates can reference mimir_source, studio_source,
mimir_sdk, cargo_target, mimir_binary, plugin_package and plugin_id. Environment
keys must be actual MIMIR_/UNSLOTH_ bridge settings, not invented by the launcher.
The backend owns frontend process supervision; this module neither installs a
plugin globally nor launches a model request. Shared Mimir settings/auth/history
are not copied or rewritten. A null frontend deliberately refuses launch.
"""
from __future__ import annotations

import fcntl
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import socket
import subprocess
import sys
import tomllib

from .common import RunnerError, atomic_json, command, digest, read_json, within
from .github import GitHub, GitHubError

MIMIR_REPOSITORY = 'wasimysaid/mimir'
MIMIR_URL = f'https://github.com/{MIMIR_REPOSITORY}.git'
LOCK_PATH = Path('studio/mimir-runtime.lock.json')
NOT_IMPLEMENTED = ('Studio coding frontend is not implemented: complete ticket #234 with the actual '
                   'SDK frontend plugin and populate studio/mimir-runtime.lock.json.frontend with '
                   'its build, staged package, SHA-256 artifacts and backend environment bindings. '
                   'No plugin fixture, installed ambient binary or branch tip will be substituted.')
VARIABLES = {'mimir_source', 'studio_source', 'mimir_sdk', 'cargo_target',
             'mimir_binary', 'plugin_package', 'plugin_id'}
GIT_PLUMBING = ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
                'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES')


def _relative(value, *, cwd=False):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise RunnerError('Descriptor paths must be relative POSIX paths')
    path = PurePosixPath(value)
    if path.is_absolute() or re.match(r'^[a-zA-Z]:', value) or '..' in path.parts or (str(path) == '.' and not cwd):
        raise RunnerError(f'Descriptor path escapes its root: {value}')
    if str(path) != value:
        raise RunnerError(f'Descriptor path must be canonical: {value}')
    return Path(value)


def _keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise RunnerError(f'{label} must contain exactly: {", ".join(sorted(expected))}')


def _template(value, variables):
    if not isinstance(value, str) or '\x00' in value:
        raise RunnerError('Build arguments and environment values must be strings without NUL')
    unknown = set(re.findall(r'\{([a-z_]+)\}', value)) - VARIABLES
    if unknown:
        raise RunnerError(f'Unknown descriptor template variables: {sorted(unknown)}')
    for name, replacement in variables.items():
        value = value.replace('{' + name + '}', str(replacement))
    return value


def descriptor(config):
    path = Path(config.repositories['studio']['source']) / LOCK_PATH
    try:
        lock = read_json(path)
    except (OSError, ValueError) as error:
        raise RunnerError(f'Cannot read runtime lock {path}: {error}') from error
    if lock is None:
        raise RunnerError(f'Missing runtime lock at {path}. {NOT_IMPLEMENTED}')
    _keys(lock, {'version', 'mimir', 'frontend'}, 'Runtime lock')
    if type(lock['version']) is not int or lock['version'] != 1:
        raise RunnerError('Unsupported runtime lock version; expected 1')
    _keys(lock['mimir'], {'repository', 'revision'}, 'Mimir pin')
    if (lock['mimir']['repository'] != MIMIR_REPOSITORY
            or config.repositories['mimir']['github'] != MIMIR_REPOSITORY):
        raise RunnerError(f'The runtime must pin the private {MIMIR_REPOSITORY} repository')
    revision = lock['mimir']['revision']
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise RunnerError('Mimir revision must be an exact lowercase 40-character commit SHA, not a branch')
    frontend = lock['frontend']
    if frontend is None:
        raise RunnerError(NOT_IMPLEMENTED)
    _keys(frontend, {'plugin_id', 'build', 'package', 'artifacts', 'environment'}, 'Frontend descriptor')
    if not isinstance(frontend['plugin_id'], str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', frontend['plugin_id']):
        raise RunnerError('Frontend plugin_id must name the actual manifest plugin')
    _keys(frontend['package'], {'repo', 'path'}, 'Frontend package')
    if not isinstance(frontend['package']['repo'], str) or frontend['package']['repo'] not in {'studio', 'mimir'}:
        raise RunnerError('Frontend package must belong to studio or mimir')
    _relative(frontend['package']['path'])
    steps = frontend['build']
    if not isinstance(steps, list) or not steps:
        raise RunnerError('Frontend requires actual build steps')
    for step in steps:
        _keys(step, {'repo', 'cwd', 'argv', 'timeout'}, 'Frontend build step')
        if not isinstance(step['repo'], str) or step['repo'] not in {'studio', 'mimir'}:
            raise RunnerError('Build steps must belong to studio or mimir')
        _relative(step['cwd'], cwd=True)
        if type(step['timeout']) is not int or not 0 < step['timeout'] <= 3600:
            raise RunnerError('Build step timeout must be between 1 and 3600 seconds')
        if not isinstance(step['argv'], list) or not step['argv'] or not all(isinstance(x, str) and x for x in step['argv']):
            raise RunnerError('Build argv must be a nonempty string argument array')
        for arg in step['argv']:
            _template(arg, {})
    artifacts = frontend['artifacts']
    if not isinstance(artifacts, dict) or 'mimir-plugin.toml' not in artifacts:
        raise RunnerError('Frontend artifacts must hash the staged mimir-plugin.toml and all package files')
    for path, sha in artifacts.items():
        _relative(path)
        if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{64}', sha):
            raise RunnerError(f'Artifact requires an exact SHA-256: {path}')
    environment = frontend['environment']
    if not isinstance(environment, dict):
        raise RunnerError('Frontend environment must be an object of implemented backend bindings')
    for key, value in environment.items():
        if (not re.fullmatch(r'(MIMIR|UNSLOTH)_[A-Z0-9_]+', key)
                or key == 'MIMIR_CODING_AGENT_DIR'):
            raise RunnerError(f'Descriptor cannot override shared configuration or host environment: {key}')
        _template(value, {})
    for required in ('{mimir_binary}', '{plugin_package}'):
        if not any(required in value for value in environment.values()):
            raise RunnerError(f'Backend environment must bind {required} to the actual bridge setting')
    return lock


def _git(path, *args, env=None, timeout=120):
    env = dict(os.environ if env is None else env)
    # Ambient Git plumbing must not redirect a pinned clone to another checkout.
    for key in GIT_PLUMBING:
        env.pop(key, None)
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-C', path, *args], env=env, timeout=timeout)


def _owned_directory(path, root):
    path = Path(path)
    within(path, root)
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise RunnerError(f'Runtime storage cannot traverse a symlink: {parent}')
        if parent.exists() and parent.stat().st_uid != os.getuid():
            raise RunnerError(f'Runtime storage is not owned by this user: {parent}')
        if parent == root:
            break
    path.mkdir(parents=True, exist_ok=True)
    return path


def _inside(root, value, *, cwd=False):
    relative = _relative(value, cwd=cwd)
    path = root / relative
    for part in (path, *path.parents):
        if part.is_symlink():
            raise RunnerError(f'Runtime paths cannot traverse symlinks: {part}')
        if part == root:
            break
    if path.resolve() != root.resolve() and not path.resolve().is_relative_to(root.resolve()):
        raise RunnerError(f'Runtime path escapes repository: {value}')
    return path


def private_access(config):
    source = Path(config.repositories['mimir']['source'])
    origin = _git(source, 'remote', 'get-url', 'origin')
    allowed = {MIMIR_URL, MIMIR_URL.removesuffix('.git'),
               f'git@github.com:{MIMIR_REPOSITORY}.git', f'git@github.com:{MIMIR_REPOSITORY}',
               f'ssh://git@github.com/{MIMIR_REPOSITORY}.git'}
    if origin not in allowed:
        raise RunnerError(f'Mimir source origin must identify {MIMIR_REPOSITORY} using a canonical '
                          'GitHub HTTPS/SSH URL; the configured origin is refused')
    try:
        info = GitHub(MIMIR_REPOSITORY).request(f'repos/{MIMIR_REPOSITORY}')
    except GitHubError as error:
        raise RunnerError(f'Private Mimir access unavailable. Run gh auth status and confirm read access '
                          f'to {MIMIR_REPOSITORY}; no public fallback is permitted.') from error
    if (not isinstance(info, dict) or info.get('full_name') != MIMIR_REPOSITORY
            or info.get('private') is not True or not isinstance(info.get('permissions'), dict)
            or info['permissions'].get('pull') is not True):
        raise RunnerError(f'Private Mimir access unavailable: require readable private {MIMIR_REPOSITORY}')


def pinned_clone(config, name, destination, revision, env):
    """Independent clone, exact detached commit, no source worktree/config edits."""
    source = Path(config.repositories[name]['source'])
    if not destination.exists():
        _git(source, 'clone', '--no-hardlinks', '--no-checkout', str(source), str(destination), env=env, timeout=180)
        _git(destination, 'remote', 'set-url', 'origin', f'https://github.com/{config.repositories[name]["github"]}.git', env=env)
        try:
            resolved = _git(destination, 'rev-parse', '--verify', revision + '^{commit}', env=env)
        except RunnerError:
            try:
                _git(destination, '-c', 'credential.helper=', '-c',
                     'credential.https://github.com.helper=!gh auth git-credential',
                     'fetch', '--no-tags', '--depth=1', 'origin', revision, env=env, timeout=180)
                resolved = _git(destination, 'rev-parse', '--verify', revision + '^{commit}', env=env)
            except RunnerError as error:
                raise RunnerError(f'Cannot resolve exact {name} pin {revision}; confirm private access '
                                  'and that this commit is available. No branch fallback is permitted.') from error
        if resolved != revision:
            raise RunnerError(f'{name} pin resolved to a different commit')
        _git(destination, 'checkout', '--detach', revision, env=env)
    _owned_directory(destination, config.root)
    metadata = destination / '.git'
    if (not metadata.is_dir() or metadata.is_symlink() or metadata.stat().st_uid != os.getuid()
            or (metadata / 'objects/info/alternates').exists()):
        raise RunnerError('Runtime repository must be an independent owned clone')
    common = Path(_git(destination, 'rev-parse', '--path-format=absolute', '--git-common-dir', env=env))
    if common != metadata.resolve():
        raise RunnerError('Runtime clone metadata escapes its owned directory')
    expected_origin = f'https://github.com/{config.repositories[name]["github"]}.git'
    if _git(destination, 'remote', 'get-url', 'origin', env=env) != expected_origin:
        raise RunnerError('Runtime clone origin changed')
    if _git(destination, 'rev-parse', 'HEAD', env=env) != revision:
        raise RunnerError(f'Runtime {name} HEAD does not match its exact pin')
    if _git(destination, 'status', '--porcelain', '--untracked-files=no', env=env):
        raise RunnerError(f'Runtime {name} tracked source was changed; inspect the owned clone')
    return destination


def _environment(base, config):
    env = os.environ.copy()
    for key in GIT_PLUMBING:
        env.pop(key, None)
    cache = _owned_directory(config.root / 'launch' / 'cache', config.root)
    paths = {'XDG_CACHE_HOME': cache / 'xdg', 'CARGO_HOME': cache / 'cargo',
             'CARGO_TARGET_DIR': base / 'target', 'npm_config_cache': cache / 'npm',
             'PIP_CACHE_DIR': cache / 'pip', 'UV_CACHE_DIR': cache / 'uv',
             'HF_HOME': cache / 'huggingface', 'TORCH_HOME': cache / 'torch',
             'TMPDIR': base / 'tmp', 'PYTHONPYCACHEPREFIX': base / 'pycache'}
    for key, path in paths.items():
        env[key] = str(_owned_directory(path, config.root))
    env.update(TMP=env['TMPDIR'], TEMP=env['TMPDIR'], CARGO_BUILD_JOBS='4',
               GIT_TERMINAL_PROMPT='0', CUDA_VISIBLE_DEVICES='')
    return env


def _hash(path):
    if not path.is_file() or path.is_symlink():
        raise RunnerError(f'Missing or unsafe runtime artifact: {path}')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _tree(path):
    if not path.is_dir() or path.is_symlink():
        raise RunnerError(f'Missing runtime artifact directory: {path}')
    result = {}
    for item in sorted(path.rglob('*')):
        if item.is_symlink():
            raise RunnerError(f'Runtime artifact symlink is not permitted: {item}')
        if not item.is_dir():
            result[item.relative_to(path).as_posix()] = _hash(item)
    return result


def _package(frontend, package):
    actual = _tree(package)
    if actual != frontend['artifacts']:
        raise RunnerError('Frontend package artifact SHA-256 mismatch or unlisted/missing package files')
    try:
        manifest = tomllib.loads((package / 'mimir-plugin.toml').read_text())
    except (OSError, ValueError) as error:
        raise RunnerError(f'Invalid staged frontend manifest: {error}') from error
    artifact = manifest.get('artifact')
    _relative(artifact)
    frontends = manifest.get('frontends', ['headless'])
    if (type(manifest.get('manifest_version')) is not int or manifest['manifest_version'] != 1
            or manifest.get('id') != frontend['plugin_id'] or manifest.get('lifetime') != 'runtime'
            or not isinstance(frontends, list) or 'headless' not in frontends or artifact not in actual):
        raise RunnerError('Staged package must be the declared runtime/headless frontend plugin')
    assets = manifest.get('assets', [])
    if not isinstance(assets, list):
        raise RunnerError('Staged frontend assets must be relative package paths')
    for asset in assets:
        path = _inside(package, asset)
        if not path.exists():
            raise RunnerError(f'Missing declared frontend asset: {asset}')
    return actual


def _port_available(port):
    if type(port) is not int or not 1 <= port <= 65535:
        raise RunnerError('Localhost port must be an integer between 1 and 65535')
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(('127.0.0.1', port))
    except OSError as error:
        raise RunnerError(f'Localhost port {port} is unavailable; choose another --port') from error


def launch(config, port):
    """Select the integrated feature branch without switching the user's checkout."""
    if 'branch' in config.repositories['studio']:
        from copy import deepcopy
        from types import SimpleNamespace
        from . import workspaces
        revision = workspaces.head(config, 'studio')
        repository = workspaces.repository(config, 'studio')
        source = config.root / 'launch' / 'sources' / revision
        if not source.exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            _git(repository, 'worktree', 'add', '--detach', str(source), revision)
        if _git(source, 'rev-parse', 'HEAD') != revision:
            raise RunnerError('Integrated Studio source does not match its resolved revision')
        repositories = deepcopy(config.repositories)
        repositories['studio']['source'] = str(source)
        config = SimpleNamespace(root=config.root, repositories=repositories)
    return _launch_checkout(config, port)


def _launch_checkout(config, port):
    lock = descriptor(config)  # Refuse an absent product before any clone/build/startup.
    _port_available(port)
    private_access(config)
    studio_source = Path(config.repositories['studio']['source'])
    studio_revision = _git(studio_source, 'rev-parse', 'HEAD')
    if not re.fullmatch(r'[0-9a-f]{40}', studio_revision):
        raise RunnerError('Studio source HEAD is not an exact commit')
    if _git(studio_source, 'show', f'{studio_revision}:{LOCK_PATH.as_posix()}') != (studio_source / LOCK_PATH).read_text().strip():
        raise RunnerError('Runtime lock has uncommitted changes; commit the actual descriptor before launch')
    identity = {'lock_sha256': digest(lock), 'mimir_revision': lock['mimir']['revision'],
                'studio_revision': studio_revision}
    base = _owned_directory(config.root / 'launch' / digest(identity), config.root)
    with _inside(base, '.lock').open('a') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RunnerError('This pinned runtime is already being built or served') from error
        receipt_path = _inside(base, 'artifacts.json')
        receipt = read_json(receipt_path)
        intent_path = _inside(base, 'build-intent.json')
        if receipt is None:
            if intent_path.exists():
                raise RunnerError(f'Incomplete unreceipted runtime build at {base}; inspect its clones/outputs '
                                  'and confirm ownership before removing only this launcher-created build directory '
                                  'and retrying. Campaign state and original checkouts must be preserved.')
            atomic_json(intent_path, identity)
        env = _environment(base, config)
        repos = {name: pinned_clone(config, name, base / name, revision, env)
                 for name, revision in [('mimir', identity['mimir_revision']), ('studio', studio_revision)]}
        frontend = lock['frontend']
        package = _inside(repos[frontend['package']['repo']], frontend['package']['path'])
        binary = _inside(base, 'target/release/mimir')
        dist = _inside(repos['studio'], 'studio/frontend/dist')
        variables = {**{name + '_source': path for name, path in repos.items()},
                     'mimir_sdk': repos['mimir'] / 'crates/mimir-plugin-sdk',
                     'cargo_target': base / 'target', 'mimir_binary': binary,
                     'plugin_package': package, 'plugin_id': frontend['plugin_id']}
        if receipt is None:
            # A descriptor may use native packaging/check/install commands while
            # building. Those must not touch the user's shared Mimir state.
            build_env = {**env, 'MIMIR_CODING_AGENT_DIR': str(_owned_directory(base / 'build-mimir-state', config.root))}
            command(['cargo', 'build', '--locked', '--release', '-p', 'mimir-cli', '--bin', 'mimir'],
                    cwd=repos['mimir'], env=build_env, timeout=None)
            for step in frontend['build']:
                cwd = _inside(repos[step['repo']], step['cwd'], cwd=True)
                command([_template(x, variables) for x in step['argv']], cwd=cwd, env=build_env, timeout=None)
            frontend_cwd = _inside(repos['studio'], 'studio/frontend')
            command(['npm', 'ci', '--no-audit', '--no-fund'], cwd=frontend_cwd, env=build_env, timeout=None)
            command(['npm', 'run', 'build'], cwd=frontend_cwd, env=build_env, timeout=None)
        # Build steps can create paths; validate their containment again afterward.
        package = _inside(repos[frontend['package']['repo']], frontend['package']['path'])
        binary = _inside(base, 'target/release/mimir')
        dist = _inside(repos['studio'], 'studio/frontend/dist')
        package_hashes = _package(frontend, package)
        files = {binary.relative_to(base).as_posix(): _hash(binary)}
        if not os.access(binary, os.X_OK):
            raise RunnerError('Built Mimir binary is not executable')
        dist_hashes = _tree(dist)
        if 'index.html' not in dist_hashes:
            raise RunnerError('Studio frontend build did not produce dist/index.html')
        for root, hashes in ((package, package_hashes), (dist, dist_hashes)):
            files.update({(root / path).relative_to(base).as_posix(): sha for path, sha in hashes.items()})
        for name, revision in [('mimir', identity['mimir_revision']), ('studio', studio_revision)]:
            pinned_clone(config, name, repos[name], revision, env)
        expected = {'version': 1, **identity, 'files': files}
        if receipt is not None and receipt != expected:
            raise RunnerError('Pinned runtime artifact receipt mismatch; inspect the owned build before retry')
        if receipt is None:
            atomic_json(receipt_path, expected)
        env.update({key: _template(value, variables) for key, value in frontend['environment'].items()})
        _port_available(port)  # Long builds must not hide a newly occupied port.
        argv = [sys.executable, str(repos['studio'] / 'studio/backend/run.py'),
                '--host', '127.0.0.1', '--port', str(port), '--no-cloudflare']
        try:
            result = subprocess.run(argv, cwd=repos['studio'], env=env, stdin=subprocess.DEVNULL, check=False)
        except OSError as error:
            raise RunnerError(f'Cannot start Studio backend with the pinned runtime: {error}') from error
        if result.returncode:
            raise RunnerError(f'Studio backend exited {result.returncode}; check the foreground startup logs '
                              'and installed backend dependencies. No fallback server was started.')
        return {'status': 'stopped', 'exit_code': 0, 'url': f'http://127.0.0.1:{port}',
                'runtime': str(base), **identity}
