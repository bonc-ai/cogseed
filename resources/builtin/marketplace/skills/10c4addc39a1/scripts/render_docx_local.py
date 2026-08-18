#!/usr/bin/env python3
from __future__ import annotations
import argparse, subprocess, sys
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('docx'); ap.add_argument('--output-dir',required=True); ap.add_argument('--emit-pdf',action='store_true'); args=ap.parse_args()
    renderer=Path('/home/oai/skills/docx/render_docx.py')
    if not renderer.exists():
        print('Canonical renderer unavailable: /home/oai/skills/docx/render_docx.py',file=sys.stderr); return 2
    cmd=[sys.executable,str(renderer),args.docx,'--output_dir',args.output_dir]
    if args.emit_pdf: cmd.append('--emit_pdf')
    print('RUN:', ' '.join(cmd)); return subprocess.call(cmd)
if __name__=='__main__': raise SystemExit(main())
