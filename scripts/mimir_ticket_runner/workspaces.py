"""Task-owned clone/worktree management; never switch the user's checkout."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess

from .common import RunnerError, atomic_json, command, git, read_json, within


def repository(config, name):
    repo = config.repositories[name]
    root = within(config.root / 'repositories' / name, config.root)
    url = f'https://github.com/{repo["github"]}.git'
    if not root.exists():
        root.parent.mkdir(parents=True, exist_ok=True)
        command(['git', 'clone', '--shared', '--no-checkout', repo['source'], root], timeout=180)
        git(root, 'remote', 'set-url', 'origin', url)
    if git(root, 'remote', 'get-url', 'origin') != url:
        raise RunnerError('Owned repository origin changed')
    # A clone does not inherit repository-local author settings. Use the user's
    # established Studio identity only in these owned repositories, never globally.
    identity = git(config.repositories['studio']['source'], 'var', 'GIT_AUTHOR_IDENT')
    name, email = identity.rsplit(' <', 1)
    git(root, 'config', 'user.name', name)
    git(root, 'config', 'user.email', email.split('>', 1)[0])
    return root


def head(config, name):
    root = repository(config, name)
    branch = config.repositories[name]['branch']
    git(root, 'fetch', '--no-tags', 'origin', f'refs/heads/{branch}:refs/remotes/origin/{branch}')
    return git(root, 'rev-parse', f'refs/remotes/origin/{branch}')


def _carry_changes(source, target, base):
    # Git selects source files (including tracked files now ignored), rather than
    # copying a checkout with its environments, caches, and runtime settings.
    generated = {'.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv',
                 '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
                 '.tox', '.next', '.nuxt', '.svelte-kit'}
    paths = ['.', ':(exclude).mimir/settings.json']
    paths.extend(f':(glob,exclude)**/{name}/**' for name in sorted(generated))
    diff = ['git', '-C', str(source), 'diff', '--no-ext-diff', '--no-textconv', '--no-renames']
    patch = subprocess.check_output([*diff, '--binary', base, '--', *paths], timeout=120)
    if patch:
        applied = subprocess.run(['git', '-C', str(target), 'apply', '--3way', '--binary', '-'],
                                 input=patch, capture_output=True, timeout=120)
        if applied.returncode:
            # Only this freshly prepared worktree is reset. A conflicting replay
            # must not strand the retry: retain saved candidate file contents,
            # without conflict markers, atop the new base for the agent to repair.
            git(target, 'reset', '--hard', 'HEAD')
            changed = subprocess.check_output([*diff, '--name-only', '-z', base, '--', *paths], timeout=120)
            for name in changed.split(b'\0'):
                if name:
                    _copy_saved_path(source / os.fsdecode(name), target / os.fsdecode(name))
    untracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '--others',
                                         '--exclude-standard', '-z', '--', *paths], timeout=120)
    for name in untracked.split(b'\0'):
        if name:
            _copy_saved_path(source / os.fsdecode(name), target / os.fsdecode(name))


def _copy_saved_path(source, target):
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    if source.exists() or source.is_symlink():
        parents = []
        parent = target.parent
        while not parent.is_dir() or parent.is_symlink():
            parents.append(parent)
            parent = parent.parent
        for parent in reversed(parents):
            if parent.is_symlink() or parent.is_file():
                parent.unlink()
            parent.mkdir()
        shutil.copy2(source, target, follow_symlinks=False)


def prepare(config, number, attempt, previous=None):
    """Prepare current-base worktrees, optionally carrying a prior candidate's code.

    Carried commits become working/index changes, not inherited branch history.
    Existing receipts are returned unchanged, without replaying the old attempt.
    """
    directory = within(config.root / 'attempts' / str(number) / str(attempt), config.root)
    directory.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / 'workspace.json'
    existing = read_json(receipt_path)
    if existing:
        validate(config, existing)
        return existing
    if previous:
        validate(config, previous)
    branch = f'mimir-ticket-{config.campaign["id"]}-{number}-a{attempt}'
    result = {'directory': str(directory), 'branch': branch, 'paths': {}, 'bases': {}, 'number': number}
    # Persist intent before worktree creation. Ambiguous partial preparation is
    # recovered by exact registered branch/path validation, never by deletion.
    atomic_json(directory / 'workspace-intent.json', result)
    for name in sorted(config.repositories):
        repo = repository(config, name)
        base = head(config, name)
        path = within(directory / name, config.root)
        if path.exists():
            if git(path, 'branch', '--show-current') != branch:
                raise RunnerError('Existing attempt path has another branch')
            base = git(path, 'rev-parse', 'HEAD')
            if git(path, 'status', '--porcelain'):
                raise RunnerError('Partial workspace preparation contains unreceipted work')
        else:
            git(repo, 'worktree', 'add', '-b', branch, str(path), base)
        result['paths'][name] = str(path)
        result['bases'][name] = base
        if previous and name in previous['paths']:
            _carry_changes(Path(previous['paths'][name]), path, previous['bases'][name])
    atomic_json(receipt_path, result)
    return result


def validate(config, workspace):
    for name, value in workspace['paths'].items():
        path = within(Path(value), config.root)
        if git(path, 'branch', '--show-current') != workspace['branch']:
            raise RunnerError(f'Attempt branch was changed in {name}')
        common = Path(git(path, 'rev-parse', '--git-common-dir')).resolve()
        expected = (config.root / 'repositories' / name / '.git').resolve()
        if common != expected:
            raise RunnerError('Worktree no longer belongs to this campaign')


def freeze_binary(config):
    source = Path(shutil.which(config.campaign['mimir'])).resolve()
    with source.open('rb') as stream:
        header = stream.read(4)
    if header != b'\x7fELF':
        # This host's known pstack entry point execs a Python launcher and then
        # the native binary. Freeze the actual executable, not that mutable chain.
        text = source.read_text()
        if '# mimir-pstack launcher; normal invocations pass through.' not in text:
            raise RunnerError('Configure the native Mimir executable, not a shell wrapper')
        tokens = shlex.split(text, comments=True)
        source = Path(tokens[tokens.index('--mimir') + 1]).resolve()
        with source.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                raise RunnerError('Mimir wrapper does not identify a native ELF executable')
    target = config.root / 'runtime' / 'native' / 'mimir'
    manifest = target.parent / 'mimir.json'
    if manifest.exists():
        expected = read_json(manifest)
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != expected['sha256']:
            raise RunnerError('Frozen Mimir executable was changed')
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise RunnerError('Unreceipted frozen binary exists; inspect before retry')
    shutil.copy2(source, target)
    atomic_json(manifest, {'source': str(source), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                          'version': command([target, '--version'])})
    return target


def configure_model(config, workspace, effort, model=None):
    path = Path(workspace['paths']['studio']) / '.mimir/settings.json'
    # Only task-owned worktrees are touched. Never overwrite an existing tracked
    # project setting; preserve every unrelated key in a valid document.
    settings = read_json(path, {})
    if not isinstance(settings, dict):
        raise RunnerError('Project model settings must be a JSON object')
    settings.update(defaultProvider=config.campaign['provider'], defaultModel=model or config.campaign['model'])
    settings['model'] = {**settings.get('model', {}), 'thinkingEffort': effort}
    atomic_json(path, settings)
    # These runtime-only settings are never staged; commit checks exclude them.


def assert_native_selection(config, directory, effort, model=None):
    records = [json.loads(line) for line in (Path(directory) / 'stdout.jsonl').read_text().splitlines() if line.strip()]
    requests = [x for x in records if x.get('event') == 'model_request_start']
    model = model or config.campaign['model']
    expected = {model, config.campaign.get('provider', 'chatgpt') + '/' + model}
    if not requests or any(x.get('model') not in expected or x.get('reasoning_effort') != effort for x in requests):
        raise RunnerError('Native run did not use the exact required model and effort; no fallback is accepted')


def native_job(config, workspace, prompt, kind='worker', suffix=''):
    from . import supervisor
    directory = Path(workspace['directory']) / f'{kind}{suffix}'
    directory.mkdir(parents=True, exist_ok=True)
    prompt_path = directory / 'prompt.txt'
    grant = read_json(config.root / 'gpu-grant.json', {})
    from .engine import resource_ready
    gpu = kind == 'worker' and config.tickets[workspace['number']].get('resource') == 'gpu'
    if gpu:
        if not resource_ready(config, workspace['number']):
            raise RunnerError('GPU coordination grant is absent, unsafe, or expired')
        prompt += '\nOperator-coordinated GPU grant (check current usage before workload; finish GPU use before expires, even if this session has no deadline): ' + json.dumps(grant, sort_keys=True)
    if not prompt_path.exists():
        prompt_path.write_text(prompt)
    elif prompt_path.read_text() != prompt:
        raise RunnerError('An existing job cannot be retargeted to a different prompt')
    effort = config.campaign.get('reasoning_effort', 'xhigh') if kind == 'worker' else 'high'
    model = config.campaign['model'] if kind == 'worker' else config.campaign.get('review_model', config.campaign['model'])
    configure_model(config, workspace, effort, model=model)
    binary = freeze_binary(config)
    timeout = config.campaign['worker_timeout' if kind == 'worker' else 'review_timeout'] or None
    cache = config.root / 'cache'
    cache.mkdir(exist_ok=True)
    env = {'CARGO_TARGET_DIR': str(cache / 'cargo'), 'CARGO_BUILD_JOBS': '4',
           'TMPDIR': str(directory / 'tmp'), 'CUDA_VISIBLE_DEVICES': ''}
    Path(env['TMPDIR']).mkdir(exist_ok=True)
    env.update(PIP_CACHE_DIR=str(cache / 'pip'), UV_CACHE_DIR=str(cache / 'uv'),
               npm_config_cache=str(cache / 'npm'), HF_HOME=str(cache / 'huggingface'))
    if gpu:
        env['CUDA_VISIBLE_DEVICES'] = ','.join(map(str, grant['devices']))
    argv = [str(binary), 'run', '--approve', '--mode', 'build' if kind == 'worker' else 'plan',
            '--output', 'jsonl', '--trace-dir', str(directory / 'traces')]
    if timeout is not None:
        argv.extend(['--run-timeout-seconds', str(timeout)])
    argv.append('-')
    supervisor.launch(directory, argv, Path(workspace['paths']['studio']), timeout=timeout, env_overrides=env)
    return directory
