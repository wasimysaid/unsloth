#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Collect real app profiles and compare an optimized app with the pinned control."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import statistics
import subprocess
import sys
import time

parser=argparse.ArgumentParser()
parser.add_argument('--target',required=True)
parser.add_argument('--control',required=True)
parser.add_argument('--out',required=True)
parser.add_argument('--opt-level',choices=['3','s'],default='3')
args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[2]
crate=root/'studio/src-tauri'
out=pathlib.Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
control=pathlib.Path(args.control).resolve();control.chmod(0o755)
env=dict(os.environ,CARGO_INCREMENTAL='0',CARGO_PROFILE_RELEASE_LTO='fat',
         CARGO_PROFILE_RELEASE_CODEGEN_UNITS='1',CARGO_PROFILE_RELEASE_OPT_LEVEL=args.opt_level,
         CARGO_TERM_COLOR='never')
env.pop('RUSTFLAGS',None)
host=next(line.split(': ',1)[1] for line in subprocess.check_output(['rustc','-Vv'],text=True).splitlines() if line.startswith('host: '))
sdk=pathlib.Path(subprocess.check_output(['rustc','--print','sysroot'],text=True).strip())
profdata=sdk/'lib/rustlib'/host/'bin/llvm-profdata'
raw=out/'raw';raw.mkdir(exist_ok=True)
result={'target':args.target,'opt_level':args.opt_level,'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
        'control_sha256':hashlib.sha256(control.read_bytes()).hexdigest(),'builds':{},'measurements':[]}
def save():(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
def build(name,flags):
    target=out/f'target-{name}'
    runenv=dict(env,CARGO_TARGET_DIR=str(target),RUSTFLAGS=flags)
    command=['cargo','build','--locked','--release','--bin','unsloth-studio','--target',args.target]
    started=time.monotonic()
    with (out/f'{name}-build.log').open('w') as log:
        subprocess.run(command,cwd=crate,env=runenv,stdout=log,stderr=subprocess.STDOUT,check=True)
    binary=target/args.target/'release/unsloth-studio'
    result['builds'][name]={'seconds':time.monotonic()-started,'bytes':binary.stat().st_size,
                          'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
    save();return binary
def workload(binary,folder,phase,reps,profile=False):
    runenv=dict(env,BENCH_REPO=str(root))
    if profile:runenv['LLVM_PROFILE_FILE']=str(raw/'%m-%p.profraw')
    command=['xvfb-run','-a','--server-args=-screen 0 1440x900x24',sys.executable,
             str(root/'.github/scripts/benchmark-native-workload.py'),'--binary',str(binary),
             '--out',str(folder),'--phase',phase,'--reps',str(reps)]
    with (out/'workload.log').open('a') as log:
        subprocess.run(command,cwd=root,env=runenv,stdout=log,stderr=subprocess.STDOUT,check=True)
    return json.loads((folder/'result.json').read_text())
instrumented=build('generate',f'-Cprofile-generate={raw}')
for i in range(3):workload(instrumented,out/f'train-{i}','train',10,True)
profiles=list(raw.glob('*.profraw'));assert len(profiles)>=3,'The app did not flush its LLVM profiles'
merged=out/'training.profdata'
subprocess.run([str(profdata),'merge','-sparse',str(raw),'-o',str(merged)],check=True)
with (out/'profile-summary.txt').open('w') as log:subprocess.run([str(profdata),'show',str(merged)],stdout=log,check=True)
optimized=build('use',f'-Cprofile-use={merged} -Cllvm-args=-pgo-warn-missing-function')
shutil.copy2(optimized,out/'unsloth-studio-pgo')
for round_id in range(4):
    order=['control','pgo'] if round_id%2==0 else ['pgo','control']
    for label in order:
        row=workload(control if label=='control' else optimized,out/f'eval-{round_id}-{label}','eval',8)
        row.update(label=label,round=round_id);result['measurements'].append(row);save()
testenv=dict(env,CARGO_TARGET_DIR=str(out/'target-use'),RUSTFLAGS=f'-Cprofile-use={merged} -Cllvm-args=-pgo-warn-missing-function')
testenv.pop('UNSLOTH_DESKTOP_BACKEND_VERSION',None);testenv.pop('UNSLOTH_DESKTOP_SOURCE_BACKEND',None)
started=time.monotonic()
with (out/'tests.log').open('w') as log:
    test=subprocess.run(['cargo','test','--locked','--release','--bin','unsloth-studio','--target',args.target],cwd=crate,env=testenv,stdout=log,stderr=subprocess.STDOUT)
result['tests']={'exit_code':test.returncode,'seconds':time.monotonic()-started};save()
if test.returncode:raise SystemExit(test.returncode)
# Do not upload full Cargo targets or instrumented apps.
for path in [out/'target-generate',out/'target-use']:shutil.rmtree(path)
print(json.dumps(result),flush=True)
