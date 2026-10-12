"""Serialized, recoverable paired PR transactions. GitHub is reconciled before writes."""
from __future__ import annotations

import json
from pathlib import Path
import re
import time
from urllib.parse import quote, urlsplit

from .common import RunnerError, atomic_json, digest, git, read_json
from .github import GitHub
from . import verification, workspaces

PROTECTED = ('scripts/mimir_ticket_runner/', 'tests/ticket_runner/', 'docs/agents/mimir-ticket-runner')


def commit(config, store, number, name, label):
    """Receipt the exact commit before moving its local ref; a crash cannot duplicate it."""
    row = store.get(number)
    workspace = row['workspace']
    path = workspace['paths'][name]
    parent = git(path, 'rev-parse', 'HEAD')
    intent_key = f'{name}:{label}'
    intents = row.get('commit_intents', {})
    old = intents.get(intent_key)
    if old:
        if parent == old['parent']:
            git(path, 'update-ref', 'HEAD', old['sha'], old['parent'])
        elif parent != old['sha']:
            raise RunnerError('Local commit intent conflicts with the current branch')
        return old['sha']
    files = set(git(path, 'diff', '--name-only', 'HEAD').splitlines())
    files.update(git(path, 'ls-files', '--others', '--exclude-standard').splitlines())
    files.discard('.mimir/settings.json')
    if any(x.startswith(PROTECTED) for x in files):
        raise RunnerError('Worker changed protected runner policy/implementation/tests')
    if not files:
        return parent
    git(path, 'add', '--all', '--', '.', ':!.mimir/settings.json')
    tree = git(path, 'write-tree')
    sha = git(path, 'commit-tree', tree, '-p', parent, '-m', f'Mimir ticket #{number}: {label}')
    intents[intent_key] = {'parent': parent, 'sha': sha, 'tree': tree}
    store.update(number, row['state'], commit_intents=intents)
    git(path, 'update-ref', 'HEAD', sha, parent)
    return sha


def assert_history(store, number):
    row = store.get(number)
    workspace = row['workspace']
    for name, path in workspace['paths'].items():
        actual = git(path, 'rev-parse', 'HEAD')
        known = {workspace['bases'][name]}
        known.update(x['sha'] for key, x in row.get('commit_intents', {}).items() if key.startswith(name + ':'))
        for field in ('prepared_candidate', 'refreshed_heads'):
            known.add(row.get(field, {}).get(name))
        transaction = row.get('integration') or {}
        for field in ('candidate', 'merged'):
            known.add(transaction.get(field, {}).get(name))
        if actual in known:
            continue
        # Recover a merge that completed after its durable intent but before the
        # local-head receipt. Exact parent identities distinguish it from edits.
        intent = row.get('refresh_intents', {}).get(name)
        if intent:
            parents = git(path, 'show', '-s', '--format=%P', actual).split()
            if parents == [intent['candidate'], intent['base']] or (
                    actual == intent['base'] and git(path, 'merge-base', actual, intent['candidate']) == intent['candidate']):
                refreshed = {**row.get('refreshed_heads', {}), name: actual}
                store.update(number, row['state'], refreshed_heads=refreshed)
                row = store.get(number)
                continue
        raise RunnerError('Worker changed its branch history (or an external process did); inspect before proceeding')


def refresh(config, store, number, names=('mimir', 'studio')):
    row = store.get(number)
    workspace = row['workspace']
    for name in names:
        current = workspaces.head(config, name)
        path = workspace['paths'][name]
        candidate = git(path, 'rev-parse', 'HEAD')
        if git(path, 'merge-base', candidate, current) != current:
            row = store.get(number)
            intent = {'repo': name, 'candidate': candidate, 'base': current}
            intents = {**row.get('refresh_intents', {}), name: intent}
            store.update(number, row['state'], refresh_intent=intent, refresh_intents=intents)
            git(path, 'merge', '--no-edit', current)
            store.update(number, row['state'], refreshed_heads={**row.get('refreshed_heads', {}), name: git(path, 'rev-parse', 'HEAD')})
    return verification.pair(workspace)


def pr(config, name, number, branch, expected):
    repo = config.repositories[name]
    gh = GitHub(repo['github'])
    endpoint = f'repos/{gh.repo}/pulls'
    matches = gh.pages(endpoint + '?state=all&head=' + quote(gh.repo.split('/')[0] + ':' + branch, safe=''))
    matches = [x for x in matches if x['head']['ref'] == branch and x['base']['ref'] == repo['branch']]
    if len(matches) > 1:
        raise RunnerError('Multiple PRs match a single durable ticket branch')
    if matches:
        value = gh.request(endpoint + '/' + str(matches[0]['number']))
        if value['head']['sha'] != expected:
            raise RunnerError('Remote PR head differs from the verified candidate')
        if value['state'] == 'closed' and not value.get('merged'):
            raise RunnerError('Ticket PR was closed without merging')
        return value
    # Never retry this POST blindly. On transport loss, resume discovers by branch.
    return gh.request(endpoint, 'POST', {'title': f'Mimir ticket #{number}: verified {name} integration',
        'head': branch, 'base': repo['branch'],
        'body': f'Controller-verified candidate for wasimysaid/unsloth#{number}.\n\nPrivate traces remain local. This PR does not close the ticket; the coordinator closes it only after paired integration verification.'})


def publish(config, store, number, name):
    require_authority(config, store, number)
    row = store.get(number)
    workspace = row['workspace']
    sha = git(workspace['paths'][name], 'rev-parse', 'HEAD')
    root = workspaces.repository(config, name)
    branch = workspace['branch']
    # Ordinary fast-forward push only: no force and no default-branch inference.
    git(root, 'push', 'origin', f'{sha}:refs/heads/{branch}')
    value = pr(config, name, number, branch, sha)
    prs = row.get('prs', {})
    prs[name] = {'number': value['number'], 'url': value['html_url'], 'head': sha}
    store.update(number, 'pr_open', prs=prs)
    return value


def required_contexts(gh, branch):
    details = gh.request(f'repos/{gh.repo}/branches/{quote(branch, safe="")}')
    required = set()
    if details.get('protected'):
        protection = gh.request(f'repos/{gh.repo}/branches/{quote(branch, safe="")}/protection')
        checks = protection.get('required_status_checks') or {}
        required.update(checks.get('contexts', []))
        required.update(x['context'] for x in checks.get('checks', []))
    # Rulesets may apply without classic branch protection. Unknown/access errors
    # are not interpreted as an unprotected branch.
    rules = gh.pages(f'repos/{gh.repo}/rules/branches/{quote(branch, safe="")}')
    for rule in rules:
        if rule.get('type') == 'required_status_checks':
            required.update(x['context'] for x in rule['parameters']['required_status_checks'])
    return required


def checks_ready(gh, sha, required):
    combined = gh.request(f'repos/{gh.repo}/commits/{sha}/status')
    statuses = combined.get('statuses')
    if not isinstance(statuses, list):
        raise RunnerError('Commit status metadata is missing')
    # Combined status is most recent per context; never let an older success win.
    contexts = {}
    for item in statuses:
        contexts.setdefault(item['context'], item['state'])
    runs = gh.request(f'repos/{gh.repo}/commits/{sha}/check-runs?per_page=100')
    if not isinstance(runs.get('check_runs'), list) or runs.get('total_count', 0) > len(runs['check_runs']):
        raise RunnerError('Check-run metadata is missing or exceeds the checked page')
    pending = False
    for item in runs['check_runs']:
        result = item.get('conclusion') if item.get('status') == 'completed' else 'pending'
        # Skipped/neutral cannot satisfy a required context.
        mapped = 'success' if result == 'success' else ('pending' if result is None or result == 'pending' else result)
        contexts.setdefault(item['name'], mapped)
        if mapped not in ('success', 'neutral', 'skipped', 'pending'):
            raise RunnerError('A GitHub check failed')
        pending |= mapped == 'pending'
    if any(x not in ('success', 'pending') for x in contexts.values() if x not in ('neutral', 'skipped')):
        raise RunnerError('A GitHub status failed')
    if any(name not in contexts for name in required):
        raise RunnerError('Required GitHub checks are absent; refusing merge')
    if any(contexts[name] not in ('success', 'pending') for name in required):
        raise RunnerError('A required GitHub check did not pass')
    return not pending and all(value != 'pending' for value in contexts.values())


def require_authority(config, store, number):
    from .engine import reconcile_scope, scope
    snapshot = GitHub(config.campaign['repo']).snapshot(config.campaign['parent'])
    reconcile_scope(config, store, snapshot)
    reconcile_completed(config, store, snapshot)
    row = store.get(number)
    if digest(scope(snapshot, number)) != row['input_sha256']:
        raise RunnerError('Ticket/dependency scope changed after candidate verification')
    issue = next(x for x in snapshot['issues'] if x['number'] == number)
    closed_after_verification = (issue.get('state') == 'closed' and issue.get('state_reason') == 'completed'
                                 and (row.get('integrated_verification') or row.get('human_evidence')))
    if issue.get('state') != 'open' and not closed_after_verification:
        raise RunnerError('Ticket was closed/cancelled before integration verification')
    labels = {x['name'] if isinstance(x, dict) else x for x in issue.get('labels', [])}
    if 'ready-for-agent' not in labels:
        raise RunnerError('Ticket authorization label was removed')
    if not config.tickets[number].get('human') and {x['login'] for x in issue.get('assignees', [])} != {'wasimysaid'}:
        raise RunnerError('Ticket ownership changed before integration')
    if (config.root / 'stop.json').exists():
        raise RunnerError('Stop requested; no new integration side effects are authorized')


def merge(config, store, number, name):
    row = store.get(number)
    record = row['prs'][name]
    repo = config.repositories[name]
    gh = GitHub(repo['github'])
    endpoint = f'repos/{gh.repo}/pulls/{record["number"]}'
    deadline = time.monotonic() + config.campaign['review_timeout']
    while True:
        if (config.root / 'stop.json').exists():
            raise RunnerError('Stop requested; no new merge will be submitted')
        value = gh.request(endpoint)
        if (value['head']['sha'] != record['head'] or value['base']['ref'] != repo['branch']
                or value['base']['repo']['full_name'] != repo['github']):
            raise RunnerError('PR identity/head/base changed after verification')
        if value.get('merged'):
            sha = value.get('merge_commit_sha')
            if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
                raise RunnerError('Merged PR has no authoritative merge revision')
            txn = store.get(number)['integration']
            txn.setdefault('merged', {})[name] = sha
            store.update(number, 'merging', integration=txn)
            return sha
        if value.get('state') != 'open':
            raise RunnerError('PR closed without merge')
        base = workspaces.head(config, name)
        candidate = row['workspace']['paths'][name]
        if git(candidate, 'merge-base', base, record['head']) != base:
            raise RunnerError('Integration base moved; refresh/reverify before merge')
        ready = checks_ready(gh, record['head'], required_contexts(gh, repo['branch']))
        if ready and value.get('mergeable') is True and value.get('mergeable_state') not in ('blocked', 'dirty', 'draft', 'behind', 'unknown'):
            # GitHub enforces required reviews/protections. No admin bypass.
            require_authority(config, store, number)
            store.update(number, 'merging')
            result = gh.request(endpoint + '/merge', 'PUT', {'sha': record['head'], 'merge_method': 'merge'})
            if not result.get('merged'):
                raise RunnerError('GitHub refused the expected-head merge')
            continue  # Always obtain and persist the authoritative merged PR.
        if value.get('mergeable') is False or value.get('mergeable_state') in ('dirty', 'draft'):
            raise RunnerError('PR conflicts or is draft')
        if (config.root / 'stop.json').exists() or time.monotonic() >= deadline:
            raise RunnerError('Checks/reviews are still pending; resume this recorded transaction later')
        time.sleep(5)


def pin(config, store, number, revision):
    row = store.get(number)
    path = Path(row['workspace']['paths']['studio']) / 'studio/mimir-runtime.lock.json'
    lock = read_json(path)
    if not isinstance(lock, dict) or lock.get('mimir', {}).get('repository') != 'wasimysaid/mimir':
        raise RunnerError('Studio must include the versioned private runtime lock')
    label = 'runtime-pin-' + revision
    intent = row.get('commit_intents', {}).get('studio:' + label)
    head = git(row['workspace']['paths']['studio'], 'rev-parse', 'HEAD')
    if intent and head == intent['parent']:
        return commit(config, store, number, 'studio', label)
    if lock['mimir'].get('revision') == revision:
        # A later, receipted base refresh may descend from the prior pin commit.
        # Its exact pair is verified/reviewed below; do not replay the old ref move.
        if not git(row['workspace']['paths']['studio'], 'diff', 'HEAD', '--', 'studio/mimir-runtime.lock.json'):
            return head
    lock['mimir']['revision'] = revision
    atomic_json(path, lock)
    return commit(config, store, number, 'studio', label)


def finish(config, store, number, pair):
    require_authority(config, store, number)
    gh = GitHub(config.campaign['repo'])
    row = store.get(number)
    endpoint = f'repos/{gh.repo}/issues/{number}'
    marker = f'<!-- mimir-runner:{config.campaign["id"]}:{number}:completed -->'
    comments = gh.pages(endpoint + '/comments')
    if not any(marker in x.get('body', '') for x in comments):
        public = row.get('prs', {}).get('studio', {}).get('url', 'Human-reviewed integrated branch')
        gh.request(endpoint + '/comments', 'POST', {'body': f'Integrated and verified on the approved feature branches.\n\nStudio: `{pair["studio"]}`\nRuntime pin: `{pair["mimir"]}`\n{public}\n\nController check and independent-review receipts retained locally; no private traces published.\n\n{marker}'})
    issue = gh.request(endpoint)
    if issue.get('state') != 'closed' or issue.get('state_reason') != 'completed':
        require_authority(config, store, number)
        gh.request(endpoint, 'PATCH', {'state': 'closed', 'state_reason': 'completed'})
    issue = gh.request(endpoint)
    if issue.get('state') != 'closed' or issue.get('state_reason') != 'completed':
        raise RunnerError('Issue closure not confirmed')
    store.update(number, 'completed', completed_pair=pair, completed_scope=row['input_sha256'])


def integrate(config, store, number, snapshot):
    row = store.get(number)
    workspaces.validate(config, row['workspace'])
    verification.report(row, config)
    assert_history(store, number)
    txn = row.get('integration')
    if not txn:
        store.update(number, 'verifying')
        if not row.get('prepared_candidate'):
            for name in ('mimir', 'studio'):
                commit(config, store, number, name, 'candidate')
            store.update(number, 'verifying', prepared_candidate=verification.pair(row['workspace']))
        candidate = refresh(config, store, number)
        row = store.get(number)
        verified = verification.verify(config, row, 'candidate')
        reviewed = verification.review(config, row, verified, 'candidate')
        bases = {name: workspaces.head(config, name) for name in ('mimir', 'studio')}
        txn = {'candidate': candidate, 'bases': bases, 'merged': {}, 'verification': verified, 'review': reviewed}
        store.update(number, 'merging', integration=txn)
    row = store.get(number)
    workspace = row['workspace']
    if 'mimir' not in txn['merged']:
        if txn['candidate']['mimir'] != txn['bases']['mimir']:
            publish(config, store, number, 'mimir')
            runtime = merge(config, store, number, 'mimir')
        else:
            runtime = txn['bases']['mimir']
            txn['merged']['mimir'] = runtime
            store.update(number, 'merging', integration=txn)
    runtime = store.get(number)['integration']['merged']['mimir']
    # Bring the actual merged runtime (not the premerge candidate) into the pair.
    if workspaces.head(config, 'mimir') != runtime:
        raise RunnerError('Private integration advanced during a paired transaction')
    if git(workspace['paths']['mimir'], 'rev-parse', 'HEAD') != runtime:
        git(workspace['paths']['mimir'], 'merge', '--ff-only', runtime)
    txn = store.get(number)['integration']
    if 'studio' not in txn['merged']:
        # If a prior merge succeeded but its response was lost, reconcile first.
        existing = store.get(number).get('prs', {}).get('studio')
        already_merged = False
        if existing:
            value = GitHub(config.repositories['studio']['github']).request(
                f'repos/{config.repositories["studio"]["github"]}/pulls/{existing["number"]}')
            already_merged = value.get('merged', False)
        if not already_merged:
            refresh(config, store, number, names=('studio',))
            pin(config, store, number, runtime)
            row = store.get(number)
            verified = verification.verify(config, row, 'pinned')
            reviewed = verification.review(config, row, verified, 'pinned')
            store.update(number, 'merging', final_verification=verified, final_review=reviewed)
            publish(config, store, number, 'studio')
        merge(config, store, number, 'studio')
    integrated = store.get(number)['integration']['merged']
    actual = {name: workspaces.head(config, name) for name in ('mimir', 'studio')}
    if actual != integrated:
        raise RunnerError('Integration heads changed before final verification')
    for name, sha in actual.items():
        git(workspace['paths'][name], 'merge', '--ff-only', sha)
    row = store.get(number)
    verified = verification.verify(config, row, 'integrated')
    # Merges must preserve the reviewed trees, not silently introduce other edits.
    reviewed_pair = row['final_review']['pair']
    for name, sha in actual.items():
        if git(workspace['paths'][name], 'rev-parse', sha + '^{tree}') != git(workspace['paths'][name], 'rev-parse', reviewed_pair[name] + '^{tree}'):
            raise RunnerError('Integrated tree differs from the independently reviewed candidate')
    store.update(number, 'merging', integrated_verification=verified)
    finish(config, store, number, actual)


def reconcile_completed(config, store, snapshot):
    from .engine import scope
    issues = {x['number']: x for x in snapshot['issues']}
    completed = store.completed()
    heads = {name: workspaces.head(config, name) for name in ('mimir', 'studio')} if completed else {}
    for number in completed:
        row = store.get(number)
        issue = issues.get(number, {})
        if issue.get('state') != 'closed' or issue.get('state_reason') != 'completed':
            raise RunnerError('Completed ticket reopened/cancelled; reconciliation required')
        if digest(scope(snapshot, number)) != row['completed_scope']:
            raise RunnerError('Integrated ticket scope/dependencies changed')
        for name, revision in row['completed_pair'].items():
            root = workspaces.repository(config, name)
            if git(root, 'merge-base', revision, heads[name]) != revision:
                raise RunnerError('A completed integration is no longer in branch history')


def approve(config, store, number, evidence_url):
    from .engine import active_login, scope
    from .graph import plan
    if not config.tickets[number].get('human'):
        raise RunnerError('Only explicitly human-gated tickets accept operator approval')
    gh = GitHub(config.campaign['repo'])
    snapshot = gh.snapshot(config.campaign['parent'])
    existing = store.get(number) or {}
    if existing.get('state') == 'completed' and existing.get('human_evidence') == evidence_url:
        return store.status()
    recovering = existing.get('state') == 'merging' and existing.get('human_evidence') == evidence_url
    ready = plan(snapshot, config.approved, completed=store.completed())['ready']
    if number not in {x['number'] for x in ready} and not recovering:
        raise RunnerError('Human ticket prerequisites are not integrated or it has another owner')
    match = re.fullmatch(r'https://github\.com/wasimysaid/unsloth/issues/' + str(number) + r'#issuecomment-(\d+)', evidence_url)
    if not match:
        raise RunnerError('Human evidence must be a comment on this exact issue')
    comment = gh.request(f'repos/{gh.repo}/issues/comments/{match[1]}')
    pair = {name: workspaces.head(config, name) for name in ('mimir', 'studio')}
    required = f'HUMAN-REVIEW approved studio={pair["studio"]} mimir={pair["mimir"]}'
    if comment.get('user', {}).get('login') != active_login() or required not in comment.get('body', ''):
        raise RunnerError('Operator comment must explicitly approve the exact current integration pair')
    item = scope(snapshot, number)
    frozen = store.meta('approved_scope')
    if frozen is not None:
        store.set_meta('approved_scope', {**frozen, str(number): digest(item)})
    store.update(number, 'merging', title=item['title'], scope=item, input_sha256=digest(item),
                 human_evidence=evidence_url, integration={'merged': pair})
    finish(config, store, number, pair)
    return store.status()
