#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Compare clean-target builds on the same CPU, balancing order across targets."""
import json
import os
import pathlib
import subprocess
import sys

root=pathlib.Path(__file__).resolve().parents[2]
target=os.environ['EXPERIMENT_TARGET'];label=os.environ['EXPERIMENT_LABEL']
candidate=os.environ['EXPERIMENT_VARIANT']
out=root/'experiment-results';out.mkdir(exist_ok=True)
order=[candidate,'baseline'] if label in {'linux-arm64','windows-x64'} else ['baseline',candidate]
result={'target':target,'candidate':candidate,'order':order,'builds':{}}
for variant in order:
 for filename in ['Cargo.toml','Cargo.lock']:
  path=f'studio/src-tauri/{filename}'
  (root/path).write_bytes(subprocess.check_output(['git','show',f'HEAD:{path}'],cwd=root))
 env=dict(os.environ,CARGO_TARGET_DIR=str(root/'paired-targets'/variant))
 dest=out/variant
 subprocess.run([sys.executable,str(root/'.github/scripts/desktop-size-speed.py'),
                 '--variant',variant,'--target',target,'--output',str(dest)],env=env,check=True)
 item=json.loads((dest/'result.json').read_text())
 result['builds'][variant]=item['builds'][0]
 # Binaries are already archived by the candidate matrix; keep this artifact small.
 for name in ['unsloth-studio','unsloth-studio.exe']:
  binary=dest/name
  if binary.exists():binary.unlink()
 (out/'paired-result.json').write_text(json.dumps(result,indent=2)+'\n')
base=result['builds']['baseline'];new=result['builds'][candidate]
result['compile_change_percent']=100*(new['seconds']/base['seconds']-1)
result['size_change_percent']=100*(new['size_bytes']/base['size_bytes']-1)
(out/'paired-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
