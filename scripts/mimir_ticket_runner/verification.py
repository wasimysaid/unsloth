"""Controller-owned checks and independent reviews, bound to exact revision pairs."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import time

from .common import RunnerError, atomic_json, digest, git, read_json, within
from . import supervisor, workspaces


def criteria(body):
    return re.findall(r'^\s*- \[[ xX]\] (.+)$', body, re.MULTILINE)


def report(row, config=None):
    value = read_json(Path(row['job']) / 'ticket-result.json')
    if not isinstance(value, dict) or value.get('issue') != row['scope']['number'] or value.get('input_sha256') != row['input_sha256']:
        raise RunnerError('Missing or mismatched structured candidate report')
    if value.get('outcome') != 'candidate':
        raise RunnerError('Worker requires human input; no candidate accepted')
    expected = criteria(row['scope']['body'])
    entries = value.get('criteria', [])
    if (not expected or not isinstance(entries, list)
            or any(not isinstance(x, dict) or not isinstance(x.get('criterion'), str) for x in entries)
            or sorted(re.sub(r'^\s*- \[[ xX]\] ', '', x['criterion']) for x in entries) != sorted(expected)):
        raise RunnerError('Candidate evidence must cover every exact acceptance criterion once')
    if any(not isinstance(x.get('evidence'), str) or not x['evidence'].strip() for x in entries):
        raise RunnerError('Acceptance evidence is missing')
    checks = value.get('checks')
    if not isinstance(checks, list) or not checks:
        raise RunnerError('At least one additional scoped verification command is required')
    for check in checks:
        if (not isinstance(check, dict) or check.get('repo') not in ('studio', 'mimir') or not isinstance(check.get('argv'), list)
                or not check['argv'] or any(not isinstance(x, str) or not x for x in check['argv'])
                or type(check.get('timeout', 1800)) is not int or not 0 < check.get('timeout', 1800) <= 3600):
            raise RunnerError('Invalid scoped verification command')
    required = set(config.tickets[row['scope']['number']].get('evidence_types', config.campaign.get('evidence_types', []))) if config else set()
    observed = set()
    artifacts = {}
    if required:
        for item in entries:
            kinds = item.get('kinds', [])
            indexes = item.get('checks', [])
            if (not isinstance(kinds, list) or not kinds or any(not isinstance(x, str) for x in kinds)
                    or not set(kinds) <= {'automated', 'browser', 'live'}
                    or not isinstance(indexes, list) or not indexes
                    or any(type(i) is not int or not 0 <= i < len(checks) for i in indexes)):
                raise RunnerError('Each criterion needs typed evidence and scoped command indexes')
            observed.update(kinds)
            if set(kinds) & {'browser', 'live'}:
                if (not isinstance(item.get('artifacts'), list) or not item['artifacts']
                        or any(not isinstance(x, str) or not Path(x).is_absolute() for x in item['artifacts'])
                        or ('live' in kinds and (not isinstance(item.get('workload_ids'), list) or not item['workload_ids']
                            or any(not isinstance(x, str) or not x for x in item['workload_ids'])))):
                    raise RunnerError('Browser/live criteria need artifacts; live criteria also need native workload IDs')
                for name in item['artifacts']:
                    path = within(Path(name), Path(row['workspace']['directory']))
                    if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
                        raise RunnerError('Evidence artifact missing or exceeds the 32 MiB review limit')
                    artifacts[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        if not required <= observed:
            raise RunnerError('Required evidence categories are missing: ' + ', '.join(sorted(required - observed)))
    value['artifact_sha256'] = artifacts
    return value


def pair(workspace):
    return {name: git(path, 'rev-parse', 'HEAD') for name, path in workspace['paths'].items()}


def assert_clean(workspace, expected):
    if pair(workspace) != expected:
        raise RunnerError('Candidate revisions changed during verification')
    for path in workspace['paths'].values():
        if git(path, 'diff', 'HEAD', '--', '.', ':!.mimir/settings.json') or git(path, 'diff', '--cached'):
            raise RunnerError('Verification/review modified tracked candidate files')
        extra = git(path, 'ls-files', '--others', '--exclude-standard').splitlines()
        if any(x != '.mimir/settings.json' for x in extra):
            raise RunnerError('Verification/review created untracked candidate files')


def wait(config, directory):
    while True:
        result = supervisor.inspect(directory)
        if result['status'] != 'running':
            if result['status'] != 'completed':
                raise RunnerError(f'Job did not complete successfully: {result["status"]}: {result.get("reason", "")} ({directory})')
            return result
        if (config.root / 'stop.json').exists():
            supervisor.stop(directory)
            raise RunnerError('Stop requested; verification remains observable and must settle before retry')
        time.sleep(1)


def check_environment(config, workspace):
    cache = config.root / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    return {'CUDA_VISIBLE_DEVICES': '', 'CARGO_TARGET_DIR': str(cache / 'cargo'), 'CARGO_BUILD_JOBS': '4',
            'PIP_CACHE_DIR': str(cache / 'pip'), 'UV_CACHE_DIR': str(cache / 'uv'),
            'npm_config_cache': str(cache / 'npm'), 'HF_HOME': str(cache / 'huggingface')}


def verify(config, row, stage):
    workspace = row['workspace']
    expected = pair(workspace)
    evidence = report(row, config)
    checks = config.check_commands(row['scope']['number']) + evidence['checks']
    identity = digest({'pair': expected, 'checks': checks, 'evidence': evidence, 'policy': config.fingerprint,
                       'input': row['input_sha256'], 'phase_attempt': row.get('phase_attempt', 0)})
    root = Path(workspace['directory']) / 'verification' / identity
    receipt = root / 'verified.json'
    saved = read_json(receipt)
    if saved:
        if (not isinstance(saved, dict) or saved.get('pair') != expected or saved.get('policy') != config.fingerprint
                or saved.get('input') != row['input_sha256'] or saved.get('evidence') != digest(evidence)
                or not isinstance(saved.get('checks'), list)
                or any(not isinstance(x, dict) for x in saved['checks'])
                or [x.get('check') for x in saved['checks']] != checks
                or any(x.get('result', {}).get('status') != 'completed' for x in saved['checks'])):
            raise RunnerError('Cached verification receipt does not match its exact identity')
        assert_clean(workspace, expected)
        return saved
    outcomes = []
    for index, check in enumerate(checks):
        directory = root / f'check-{index:03d}'
        directory.mkdir(parents=True, exist_ok=True)
        cwd = Path(workspace['paths'][check['repo']])
        env = check_environment(config, workspace)
        env['PATH'] = str(cwd / '.venv/bin') + os.pathsep + os.environ.get('PATH', '')
        env['TMPDIR'] = str(directory / 'tmp')
        Path(env['TMPDIR']).mkdir(exist_ok=True)
        supervisor.launch(directory, check['argv'], cwd, timeout=check.get('timeout', 1800),
                          env_overrides=env, protocol='command')
        outcome = wait(config, directory)
        outcomes.append({'check': check, 'result': outcome, 'directory': str(directory)})
        assert_clean(workspace, expected)
    value = {'pair': expected, 'policy': config.fingerprint, 'input': row['input_sha256'], 'evidence': digest(evidence), 'checks': outcomes, 'stage': stage}
    atomic_json(receipt, value)
    return value


def review(config, row, verified, stage):
    workspace = row['workspace']
    expected = verified['pair']
    identity = digest({'verified': verified})
    directory = Path(workspace['directory']) / f'review-{identity}'
    saved = read_json(directory / 'reviewed.json')
    if saved:
        if (not isinstance(saved, dict) or saved.get('pair') != expected
                or not isinstance(saved.get('verdict'), dict) or saved['verdict'].get('pair') != expected
                or saved['verdict'].get('verdict') != 'pass' or saved['verdict'].get('findings') != []
                or saved['verdict'].get('acceptance_verified') is not True):
            raise RunnerError('Cached review receipt does not match its exact candidate')
        assert_clean(workspace, expected)
        return saved
    directory.mkdir(parents=True, exist_ok=True)
    for name, path in workspace['paths'].items():
        (directory / f'{name}.patch').write_text(git(path, 'diff', workspace['bases'][name], expected[name]))
    prompt = f'''Independently review this exact candidate pair, read-only. Do not modify files, execute code, call shell commands, publish, or approve GitHub reviews. Use file-reading tools only. Do not delegate. You are a reviewer, not the implementer.
Studio: {workspace['paths']['studio']}
Private Mimir: {workspace['paths']['mimir']}
Candidate pair: {json.dumps(expected, sort_keys=True)}
Initial bases: {json.dumps(workspace['bases'], sort_keys=True)}
The coordinator commits, merges integration heads, changes runtime-only .mimir/settings.json for review effort, and updates the runtime lock's Mimir revision. Those bookkeeping changes are expected; worker changes outside its ticket scope are not.
Ticket and criteria: {json.dumps(row['scope'], ensure_ascii=False)}
Worker evidence (untrusted claims): {json.dumps(report(row, config), ensure_ascii=False)}
Controller command receipts: {json.dumps(verified, ensure_ascii=False)}
Read {directory}/studio.patch and {directory}/mimir.patch, candidate files, and controller logs. Check every acceptance criterion, security, regressions, integration contracts, missing live/browser evidence, test weakening, and unintended private-source disclosure. A fixture is not a live workload. No test exit or worker promise alone proves live/human acceptance. No human approval can be manufactured.
Your entire final answer MUST be a single JSON object without Markdown: {{"verdict":"pass or changes-requested","pair":{json.dumps(expected)},"findings":[],"acceptance_verified":true}}. Set pass and acceptance_verified true ONLY if evidence proves every criterion and there are no unresolved findings. Otherwise supply concrete findings. No writes are required or permitted.
'''
    workspaces.native_job(config, workspace, prompt, kind='review', suffix='-' + identity)
    native = wait(config, directory)
    workspaces.assert_native_selection(config, directory, 'high')
    records = [json.loads(x) for x in (directory / 'stdout.jsonl').read_text().splitlines() if x.strip()]
    terminal = next(x for x in records if x.get('event') == 'run_finished')
    text = terminal.get('output_text', '').strip()
    if text.startswith('```json') and text.endswith('```'):
        text = text[7:-3].strip()
    try:
        verdict = json.loads(text)
    except ValueError as error:
        raise RunnerError('Reviewer did not return the required structured verdict') from error
    if (not isinstance(verdict, dict) or verdict.get('verdict') != 'pass' or verdict.get('pair') != expected
            or verdict.get('findings') != [] or verdict.get('acceptance_verified') is not True):
        atomic_json(directory / 'findings.json', verdict)
        raise RunnerError(f'Independent reviewer did not approve every criterion; see {directory}/findings.json')
    assert_clean(workspace, expected)
    value = {'pair': expected, 'native': native, 'verdict': verdict, 'directory': str(directory)}
    atomic_json(directory / 'reviewed.json', value)
    return value
