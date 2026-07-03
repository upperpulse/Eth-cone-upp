#!/bin/bash
cd /root/eth-bot
git add donchian_trades.csv donchian_state.json donchian_signals.csv turtle_ml.jsonl donchian_equity.csv 2>/dev/null
git commit -m "auto-backup $(date +%Y%m%d-%H%M)" 2>/dev/null && git push 2>/dev/null && echo "backed up"
