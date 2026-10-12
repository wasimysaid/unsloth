"""Crash-safe campaign receipts and a single-host coordination lock."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import time

from .common import RunnerError, atomic_json

STATES = {'claiming', 'claimed', 'running', 'candidate', 'verifying', 'pr_open', 'merging',
          'completed', 'failed', 'needs-human', 'interrupted', 'blocked'}


@contextmanager
def campaign_lock(config):
    # Stable across campaign IDs/config paths for this parent, so aliases cannot
    # create a second local coordinator for the same GitHub queue.
    lock_root = config.root.parent / '.locks'
    lock_root.mkdir(parents=True, exist_ok=True)
    path = lock_root / f'{config.campaign["repo"].replace("/", "-")}-{config.campaign["parent"]}.lock'
    with path.open('a+') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RunnerError('Another local coordinator owns this queue') from error
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


class Store:
    def __init__(self, config, readonly=False):
        self.config = config
        self.readonly = readonly
        path = config.root / 'state.sqlite3'
        if readonly:
            self.db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        else:
            config.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            if config.root.stat().st_uid != os.getuid():
                raise RunnerError('Campaign storage is not owned by the current user')
            config.root.chmod(0o700)  # Raw prompts/traces may contain private source.
            self.db = sqlite3.connect(path)
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tickets (number INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at REAL NOT NULL, number INTEGER, event TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS waves (id INTEGER PRIMARY KEY, numbers TEXT NOT NULL, state TEXT NOT NULL);
            ''')
            previous = self.meta('policy_sha256')
            if previous != config.fingerprint:
                # The operator may tune this runner between invocations. Receipts
                # retain their old policy hashes, so affected checks rerun normally.
                self.set_meta('policy_sha256', config.fingerprint)
                if previous is None:
                    self.set_meta('created_at', time.time())
                else:
                    with self.db:
                        self.db.execute('INSERT INTO events(at,number,event,data) VALUES (?,?,?,?)',
                                        (time.time(), None, 'policy_updated', json.dumps({'previous': previous, 'current': config.fingerprint})))
                atomic_json(config.root / 'policy.json', config.data)
        self.db.row_factory = sqlite3.Row

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.db.close()

    def meta(self, key, default=None):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        with self.db:
            self.db.execute('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                            (key, json.dumps(value)))

    def tickets(self):
        return {row['number']: {'state': row['state'], **json.loads(row['data'])}
                for row in self.db.execute('SELECT * FROM tickets ORDER BY number')}

    def get(self, number):
        return self.tickets().get(number)

    def update(self, number, state, **values):
        if state not in STATES:
            raise RunnerError(f'Unknown ticket state: {state}')
        old = self.get(number) or {}
        if old.get('state') == 'completed' and state != 'completed':
            raise RunnerError('Integrated completion cannot be undone implicitly')
        old.pop('state', None)
        old.update(values)
        with self.db:
            self.db.execute('INSERT INTO tickets VALUES (?,?,?) ON CONFLICT(number) DO UPDATE SET state=excluded.state,data=excluded.data',
                            (number, state, json.dumps(old, sort_keys=True)))
            self.db.execute('INSERT INTO events(at,number,event,data) VALUES (?,?,?,?)',
                            (time.time(), number, state, json.dumps(values, sort_keys=True)))

    def completed(self):
        return {n for n, row in self.tickets().items() if row['state'] == 'completed'}

    def wave(self):
        row = self.db.execute("SELECT * FROM waves WHERE state='active' ORDER BY id LIMIT 1").fetchone()
        return {'id': row['id'], 'numbers': json.loads(row['numbers'])} if row else None

    def begin_wave(self, numbers):
        if self.wave():
            raise RunnerError('An active wave must settle before dispatching another')
        if list(numbers) != sorted(set(numbers)) or not numbers:
            raise RunnerError('Wave members must be a nonempty sorted unique list')
        with self.db:
            self.db.execute('INSERT INTO waves(numbers,state) VALUES (?,?)', (json.dumps(numbers), 'active'))
        return self.wave()

    def finish_wave(self):
        with self.db:
            self.db.execute("UPDATE waves SET state='settled' WHERE state='active'")

    def status(self):
        return {'campaign': self.config.campaign['id'], 'wave': self.wave(),
                'tickets': {str(n): {k: v for k, v in row.items() if k in ('state', 'attempt', 'title', 'reason', 'prs', 'integration')}
                            for n, row in self.tickets().items()},
                'completed': sorted(self.completed()), 'policy_sha256': self.meta('policy_sha256')}
