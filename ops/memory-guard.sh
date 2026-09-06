#!/bin/bash
# שומר זיכרון — restart a bot before the kernel does it for us.
#
# Two WhatsApp instances share a 3.8GB box and each drags a Chromium behind
# it. dmesg records the failure mode twice: the renderer grew to 1.9GB, then
# 3.3GB, and the OOM killer took it — which on this box means the bot is
# simply gone until someone notices it stopped answering.
#
# pm2's own max_memory_restart cannot see this. pm2 measures the node process
# it spawned (about 2MB here) while the memory lives in Chromium children it
# never launched. So measure the children directly, matched to their instance
# by the path Chromium was started with, and restart one instance while the
# other keeps serving.
#
# Runs from cron every 2 minutes.

PER_INSTANCE_MB=1400       # one instance's own Chromium footprint
MIN_FREE_MB=400            # machine-wide floor, whoever is responsible
LOG=/var/log/bot-memory-guard.log

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# PSS, not RSS. Chromium's processes share a great deal of memory, so summing
# RSS counts shared pages once per process: it read 3,033MB for two instances
# at a moment the whole machine was using 2,204MB. A threshold set against
# that inflated figure restarts a healthy bot, repeatedly. PSS splits each
# shared page between the processes holding it, so the sum is the real cost.
usage_mb() {
  local marker="$1" mb=0 pid pss
  for pid in $(pgrep -f "chrome.*$marker" 2>/dev/null); do
    pss=$(awk '/^Pss:/ {s+=$2} END {print s+0}' "/proc/$pid/smaps_rollup" 2>/dev/null)
    mb=$(( mb + ${pss:-0} / 1024 ))
  done
  echo "$mb"
}

restart() {
  log "RESTART $1 — $2"
  pm2 restart "$1" --update-env >/dev/null 2>&1
  # Settle before anything else is considered, so the two are never down together.
  sleep 60
  exit 0
}

MOSHIKO=$(usage_mb /opt/whatsapp-ai-bot)
WIFE=$(usage_mb /opt/wife-bot)
AVAIL=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)

log "ok moshiko=${MOSHIKO}MB wife=${WIFE}MB available=${AVAIL}MB"

# 1. Machine-wide floor first. This is the check that actually prevents an OOM
#    kill, because it fires no matter which instance is responsible — or when
#    something outside these two is eating the memory.
if [ "$AVAIL" -lt "$MIN_FREE_MB" ]; then
  if [ "$MOSHIKO" -ge "$WIFE" ]; then
    restart whatsapp-bot "only ${AVAIL}MB available machine-wide; largest instance"
  else
    restart wife-bot "only ${AVAIL}MB available machine-wide; largest instance"
  fi
fi

# 2. Then the per-instance ceiling, to catch one instance leaking while the
#    machine still looks healthy.
[ "$MOSHIKO" -gt "$PER_INSTANCE_MB" ] && restart whatsapp-bot "chromium at ${MOSHIKO}MB (limit ${PER_INSTANCE_MB}MB)"
[ "$WIFE"    -gt "$PER_INSTANCE_MB" ] && restart wife-bot     "chromium at ${WIFE}MB (limit ${PER_INSTANCE_MB}MB)"

# Keep the log from becoming its own disk problem.
tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
