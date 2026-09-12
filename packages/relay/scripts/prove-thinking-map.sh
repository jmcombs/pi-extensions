#!/usr/bin/env bash
# Prove the UNRELEASED relay on this worktree — catalog + Pi-thinking → CLI argv.
# Does not merge, does not load npm:@jmcombs/pi-relay (uses --no-extensions -e).
#
#   ./packages/relay/scripts/prove-thinking-map.sh catalog
#   ./packages/relay/scripts/prove-thinking-map.sh argv
#   ./packages/relay/scripts/prove-thinking-map.sh all
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELAY_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(cd "$RELAY_DIR/../.." && pwd)
RELAY_ENTRY="$RELAY_DIR/index.ts"
LOG=${RELAY_ARGV_LOG:-/tmp/relay-argv.log}
WRAP_DIR=${RELAY_WRAP_DIR:-/tmp/relay-bin}
TOKEN=RELAY_OK
PI_TIMEOUT_SECS=${RELAY_PI_TIMEOUT_SECS:-180}

die() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

ok() {
  printf 'OK    %s\n' "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

pi_relay() {
  # -ne is mandatory so a published npm:@jmcombs/pi-relay in settings.json does not win.
  pi --no-extensions -e "$RELAY_ENTRY" "$@"
}

expect_catalog_row() {
  local provider=$1 model=$2 ctx=$3 max=$4 thinking=$5
  local line
  line=$(printf '%s\n' "$CATALOG" | awk -v p="$provider" -v m="$model" '$1==p && $2==m {print; found=1} END{if(!found) exit 1}') \
    || die "catalog missing ${provider}/${model}"
  # columns: provider model context max thinking images
  local got_ctx got_max got_thinking
  got_ctx=$(awk '{print $3}' <<<"$line")
  got_max=$(awk '{print $4}' <<<"$line")
  got_thinking=$(awk '{print $5}' <<<"$line")
  [[ "$got_ctx" == "$ctx" && "$got_max" == "$max" && "$got_thinking" == "$thinking" ]] \
    || die "${provider}/${model}: expected ${ctx}/${max} thinking=${thinking}, got ${got_ctx}/${got_max} thinking=${got_thinking}"
  ok "${provider}/${model}  ${got_ctx}  ${got_max}  thinking=${got_thinking}"
}

cmd_catalog() {
  need_cmd pi
  printf '== catalog (unreleased %s) ==\n' "$RELAY_ENTRY"
  CATALOG=$(pi_relay --list-models 2>/dev/null | awk '$1 ~ /^relay-/')
  [[ -n "$CATALOG" ]] || die "no relay-* rows from pi --list-models (published 1.2.1 still loaded?)"
  printf '%s\n' "$CATALOG"
  printf '\n'
  expect_catalog_row relay-claude opus 1M 64K yes
  expect_catalog_row relay-claude sonnet 1M 64K yes
  expect_catalog_row relay-claude haiku 200K 32K yes
  expect_catalog_row relay-grok grok-4.5 500K 500K yes
  expect_catalog_row relay-cursor opus 1M 128K yes
  expect_catalog_row relay-cursor auto 200K 64K yes
  expect_catalog_row relay-grok grok-composer-2.5-fast 200K 64K yes
  if printf '%s\n' "$CATALOG" | awk '$5=="no"{exit 0} END{exit 1}'; then
    die "a relay model still has thinking=no (old 1.2.1 catalog)"
  fi
  ok "catalog matches empirical / agreed numbers"
}

# First executable on PATH that is not this script's wrapper and not a cmux shim.
# cmux's claude shim `exec claude "$@"` after only stripping cmux-cli-shims from
# PATH; wrapping that shim recurses into us and starves JSON stdout.
resolve_real() {
  local name=$1 entry
  local oldifs=$IFS
  IFS=:
  for entry in $PATH; do
    IFS=$oldifs
    [[ -z "$entry" ]] && continue
    [[ "$entry" == "$WRAP_DIR" ]] && continue
    [[ "$entry" == *cmux-cli-shims* ]] && continue
    if [[ -x "$entry/$name" && ! -d "$entry/$name" ]]; then
      printf '%s\n' "$entry/$name"
      return 0
    fi
    IFS=:
  done
  IFS=$oldifs
  return 1
}

install_wrappers() {
  local name real wrap_q log_q real_q
  mkdir -p "$WRAP_DIR"
  : >"$LOG"
  wrap_q=$(printf '%q' "$WRAP_DIR")
  log_q=$(printf '%q' "$LOG")
  for name in claude grok cursor-agent; do
    real=$(resolve_real "$name") || die "missing real $name on PATH (needed for argv proof)"
    real_q=$(printf '%q' "$real")
    cat >"$WRAP_DIR/$name" <<EOF
#!/usr/bin/env bash
printf '%s ARGV: %s\n' "$name" "\$*" >>$log_q
# Drop WRAP_DIR from PATH so a nested exec of this binary cannot re-enter.
PATH_WITHOUT_WRAP=""
IFS=:
for e in \$PATH; do
  [[ "\$e" == $wrap_q ]] && continue
  if [[ -z "\$PATH_WITHOUT_WRAP" ]]; then
    PATH_WITHOUT_WRAP="\$e"
  else
    PATH_WITHOUT_WRAP="\$PATH_WITHOUT_WRAP:\$e"
  fi
done
export PATH="\$PATH_WITHOUT_WRAP"
exec $real_q "\$@"
EOF
    chmod +x "$WRAP_DIR/$name"
    ok "wrapper $name -> $real"
  done
}

run_one() {
  local model=$1
  local tag="=== ${model} ==="
  printf '\n%s\n' "$tag" | tee -a "$LOG"
  printf 'running pi -p --model %s (timeout %ss)\n' "$model" "$PI_TIMEOUT_SECS"
  local out
  if ! out=$(PATH="$WRAP_DIR:$PATH" \
    pi --no-extensions -e "$RELAY_ENTRY" --no-session -p --model "$model" \
    "Reply with exactly the token ${TOKEN} and nothing else." \
    2>&1); then
    printf '%s\n' "$out" | tail -n 20
    printf 'WARN  pi -p non-zero for %s (argv still logged; assertions run at the end)\n' "$model"
    return 0
  fi
  printf '%s\n' "$out" | tail -n 5
}

# First ARGV line after the model tag. Do not scan the inlined system prompt:
# it contains newlines and `=== ` headings that break section slicing / grep -E.
argv_line() {
  local model=$1
  awk -v tag="=== ${model} ===" '
    $0==tag {p=1; next}
    p && / ARGV:/ {print; exit}
  ' "$LOG"
}

must_have() {
  local model=$1 needle=$2 line
  line=$(argv_line "$model")
  [[ -n "$line" ]] || die "$model: no ARGV line in $LOG"
  printf '%s\n' "$line" | grep -aF -q -- "$needle" \
    || die "$model argv missing /$needle/ — ${line:0:200}"
  ok "$model has $needle"
}

must_not() {
  local model=$1 needle=$2 line
  line=$(argv_line "$model")
  [[ -n "$line" ]] || die "$model: no ARGV line in $LOG"
  if printf '%s\n' "$line" | grep -aF -q -- "$needle"; then
    die "$model argv unexpectedly has /$needle/ — ${line:0:200}"
  fi
  ok "$model lacks $needle"
}

cmd_argv() {
  need_cmd pi
  need_cmd claude
  need_cmd grok
  need_cmd cursor-agent
  install_wrappers
  export PATH="$WRAP_DIR:$PATH"

  run_one "relay-claude/opus:high"
  run_one "relay-claude/opus:off"
  run_one "relay-grok/grok-4.5:high"
  run_one "relay-cursor/opus:high"
  run_one "relay-cursor/opus:off"
  run_one "relay-cursor/auto:high"

  cmd_assert
  ok "argv map matches the thinking-map spec"
}

cmd_assert() {
  [[ -f "$LOG" ]] || die "no log at $LOG — run argv first"
  printf '\n== argv assertions (from %s) ==\n' "$LOG"
  must_have "relay-claude/opus:high" '--model opus'
  must_have "relay-claude/opus:high" '--effort high'
  must_have "relay-claude/opus:off" '--model opus'
  must_not "relay-claude/opus:off" '--effort'
  must_have "relay-grok/grok-4.5:high" '--reasoning-effort high'
  must_have "relay-cursor/opus:high" '--model claude-opus-4-8-thinking-high'
  must_not "relay-cursor/opus:high" '--model claude-opus-4-8-high'
  must_have "relay-cursor/opus:off" '--model claude-opus-4-8-high'
  must_not "relay-cursor/opus:off" 'thinking-high'
  must_have "relay-cursor/auto:high" '--model auto'
  must_not "relay-cursor/auto:high" 'thinking-high'
  printf '\n== ARGV lines ==\n'
  awk '/ ARGV:/ {print substr($0,1,220)}' "$LOG"
}

usage() {
  cat <<EOF
usage: $0 catalog|argv|assert|all

  catalog  pi --list-models through the worktree package (no backend spend)
  argv     wrap claude/grok/cursor-agent, run six -p completions, assert flags
  assert   re-check /tmp/relay-argv.log from a previous argv run (no backends)
  all      catalog then argv

Loads this worktree via --no-extensions -e ./packages/relay (not the published npm package).
Requires pi plus authenticated claude, grok, and cursor-agent on PATH for argv.
EOF
}

cd "$REPO_DIR"
printf 'repo=%s branch=%s HEAD=%s\n' \
  "$REPO_DIR" "$(git branch --show-current)" "$(git rev-parse --short HEAD)"

case "${1:-}" in
  catalog) cmd_catalog ;;
  argv) cmd_argv ;;
  assert) cmd_assert ;;
  all)
    cmd_catalog
    printf '\n'
    cmd_argv
    ;;
  *)
    usage
    exit 2
    ;;
esac
