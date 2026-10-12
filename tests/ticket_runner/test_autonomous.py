"""Autonomous scheduling fixtures: no remote writes or model workloads."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from scripts.mimir_ticket_runner import engine, integration, supervisor, workspaces
from scripts.mimir_ticket_runner.common import RunnerError, digest
from scripts.mimir_ticket_runner.state import Store


class AutonomousRunner(TestCase):
    def exercise(self, failures=0, preexisting=False):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = SimpleNamespace(root=root/'campaign', fingerprint='test', data={},
                campaign={'id':'fixture','repo':'fixture/test','parent':99,'budget_seconds':0,
                          'max_attempts':0,'worker_timeout':0,'reasoning_effort':'medium'},
                approved={1,2,3}, tickets={1:{},2:{},3:{}}, repositories={})
            issues={n:{'number':n,'title':str(n),'body':'- [ ] Implement', 'state':'open',
                       'labels':['ready-for-agent'],'assignees':[]} for n in (1,2,3)}
            events=[]; remaining=[failures]
            def snapshot(*args):
                return deepcopy({'parent':{'number':99,'body':'spec'}, 'issues':list(issues.values()),
                    'comments':{}, 'blockers':{'1':[],'2':[],'3':[issues[1]]}})
            def claim(c,store,s,n,login):
                item=engine.scope(s,n)
                store.update(n,'claimed',attempt=(store.get(n) or {}).get('attempt',1),
                             scope=item,input_sha256=digest(item))
            def prepare(c,n,attempt,previous=None):
                events.append(('prepare',n,attempt,previous))
                return {'directory':str(root/f'{n}-{attempt}'),'number':n,'paths':{},'bases':{}}
            def launch(c,w,*args,**kwargs):
                events.append(('launch',w['number']))
            def inspect(path):
                number=int(path.parent.name.split('-')[0])
                if number==2 and ('launch',3) not in events:
                    return {'status':'running','exit_code':None,'identity':{'child_state':'running'}}
                return {'status':'completed','exit_code':0,'identity':{'child_state':'gone','unsettled':[]}}
            def integrate(c,store,n,s):
                events.append(('integrate',n))
                if n==1 and remaining[0]:
                    remaining[0]-=1
                    raise RunnerError('ordinary test failure; repair required')
                issues[n].update(state='closed',state_reason='completed')
                store.update(n,'completed')
            if preexisting:
                workspace=prepare(config,1,1)
                item=engine.scope(snapshot(),1)
                with Store(config) as store:
                    store.update(1,'running',attempt=1,workspace=workspace,
                                 job=str(Path(workspace['directory'])/'worker'),scope=item,input_sha256=digest(item))
                    store.begin_wave([1])
            with patch.object(engine.GitHub,'snapshot',side_effect=snapshot), patch.object(
                    engine,'active_login',return_value='wasimysaid'), patch.object(engine,'claim',side_effect=claim), patch.object(
                    engine,'worker_prompt',return_value='fixture'), patch.object(workspaces,'prepare',side_effect=prepare), patch.object(
                    workspaces,'native_job',side_effect=launch), patch.object(workspaces,'assert_native_selection'), patch.object(
                    supervisor,'inspect',side_effect=inspect), patch.object(integration,'reconcile_completed'), patch.object(
                    integration,'integrate',side_effect=integrate), patch.object(engine.time,'sleep'):
                result=engine.run(config)
            return result,events

    def test_dependent_launches_before_unrelated_slow_worker_finishes(self):
        result,events=self.exercise()
        self.assertEqual(result['completed'],[1,2,3])
        self.assertLess(events.index(('launch',3)),events.index(('integrate',2)))

    def test_repairs_continue_past_two_attempts_and_receive_prior_workspace(self):
        result,events=self.exercise(failures=3)
        self.assertEqual(result['completed'],[1,2,3])
        repairs=[e for e in events if e[:2]==('prepare',1)]
        self.assertEqual([e[2] for e in repairs],[1,2,3,4])
        self.assertIsNone(repairs[0][3])
        self.assertTrue(all(e[3] is not None for e in repairs[1:]))

    def test_restart_adopts_existing_worker_without_duplicate_launch(self):
        result,events=self.exercise(preexisting=True)
        self.assertEqual(result['completed'],[1,2,3])
        self.assertNotIn(('launch',1),events)

    def test_only_explicit_external_blockers_pause_automatic_repair(self):
        with TemporaryDirectory() as directory:
            c=SimpleNamespace(root=Path(directory)/'campaign',fingerprint='test',data={},
                              campaign={'max_attempts':0},tickets={1:{}},repositories={})
            job=c.root/'worker';job.mkdir(parents=True)
            with Store(c) as store, patch.object(supervisor,'inspect',return_value={'status':'completed'}):
                store.update(1,'failed',attempt=1,job=str(job))
                (job/'ticket-result.json').write_text('{"blocker_kind":"access","summary":"Credentials unavailable"}')
                engine.recover_failures(c,store)
                self.assertTrue(store.get(1)['awaiting_human'])
                self.assertEqual(store.get(1)['attempt'],1)
                store.update(1,'failed',awaiting_human=False)
                (job/'ticket-result.json').write_text('malformed output')
                engine.recover_failures(c,store)
                self.assertEqual(store.get(1)['state'],'claimed')
                self.assertEqual(store.get(1)['attempt'],2)

    def test_partial_merge_receipts_survive_automatic_repair(self):
        with TemporaryDirectory() as directory:
            c=SimpleNamespace(root=Path(directory)/'campaign', fingerprint='test', data={},
                campaign={'max_attempts':0}, repositories={'mimir':{'github':'private/mimir'},'studio':{'github':'public/studio'}})
            calls=[]
            class GitHub:
                def __init__(self,repo): self.repo=repo
                def request(self,endpoint,method='GET',payload=None):
                    calls.append((endpoint,method,payload))
                    return {'merged':True,'merge_commit_sha':'merged-sha'} if self.repo=='private/mimir' else {'state':'open','merged':False}
            with Store(c) as store:
                store.update(1,'failed',attempt=5,workspace={'directory':str(c.root/'attempt')},
                             integration={'merged':{}},prs={'mimir':{'number':1},'studio':{'number':2}})
                with patch.object(engine,'GitHub',GitHub): engine.retry_ticket(c,store,1)
                row=store.get(1)
                self.assertEqual(row['attempt'],6)
                self.assertEqual(row['previous_integration']['merged'],{'mimir':'merged-sha'})
                self.assertTrue(row['repair_integration'])
                self.assertEqual([x for x in calls if x[1]=='PATCH'],[('repos/public/studio/pulls/2','PATCH',{'state':'closed'})])

    def test_policy_edits_are_adopted_on_restart_without_losing_tickets(self):
        with TemporaryDirectory() as directory:
            c=SimpleNamespace(root=Path(directory)/'campaign', fingerprint='old',data={'campaign':{}},campaign={})
            with Store(c) as store: store.update(234,'running',attempt=2,job='/owned/worker')
            c.fingerprint='new';c.data={'campaign':{'max_attempts':0}}
            with Store(c) as store:
                self.assertEqual(store.meta('policy_sha256'),'new')
                self.assertEqual(store.get(234)['job'],'/owned/worker')
                self.assertEqual(store.get(234)['attempt'],2)
