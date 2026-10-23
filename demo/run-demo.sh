#!/usr/bin/env bash
# KalKaro demo — runs the whole pipeline end to end on a COPY of the messy
# folder and saves the real transcript (plus before/after trees) to
# DEMO-OUTPUT.txt. The originals in mess/ are never touched, so you can
# re-run this as often as you like.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf mess-run out
cp -r mess mess-run

{
  echo "================================================================"
  echo "KalKaro demo — a real run, nothing staged"
  echo "Date: $(date)"
  echo "Machine: the shared VM this was developed on (contended CPU —"
  echo "         a normal laptop runs the same model noticeably faster)"
  echo "Model: llama3.2:1b-instruct-q4_K_M via Ollama, 100% local"
  echo "================================================================"
  echo
  echo "## The dreaded list (demo/tasks.txt)"
  echo
  cat tasks.txt
  echo
  echo "## BEFORE — the messy folder (demo/mess-run)"
  echo
  find mess-run | sort
  echo
  echo "## The run"
  echo
  node ../kalkaro.mjs tasks.txt --folder mess-run --notes notes.txt --apply --out out
  echo
  echo "## The report KalKaro wrote (demo/out/report.md)"
  echo
  cat out/report.md
  echo
  echo "## AFTER — the folder, filed"
  echo
  find mess-run | sort
} 2>&1 | tee DEMO-OUTPUT.txt
