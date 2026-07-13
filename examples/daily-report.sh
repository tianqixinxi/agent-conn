#!/usr/bin/env bash
# M1 验收(DESIGN §5,S2-lite):同机 3 个 profile 经 local hub 跑通「团队日报」流。
# 覆盖:init 身份 → 建频道 → 邀请/兑换 → 定向发送 + 广播 → 收件消费 → intercept 人工放行 → 审计。
# 隔离:全程使用一次性 AGENT_COMM_ROOT,不触碰 ~/.agent-comm;结束自动清理。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export AGENT_COMM_ROOT="$(mktemp -d)"
trap 'rm -rf "$AGENT_COMM_ROOT"' EXIT

ac() {
  local profile="$1"
  shift
  AGENT_COMM_PROFILE="$profile" node --disable-warning=ExperimentalWarning --import tsx \
    "$ROOT_DIR/packages/agent-comm/src/main.ts" "$@"
}

# 从 stdin 的 JSON 里取字段(避免依赖 jq)
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s)$1;if(v===undefined)process.exit(3);console.log(typeof v==='string'?v:JSON.stringify(v))})"; }

pass=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; pass=$((pass + 1)); }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

step "1. 三个 profile 初始化身份(一机多号,D1 的 --profile 分身)"
ac lead init >/dev/null
ac alice init >/dev/null
ac bob init >/dev/null
ok "lead / alice / bob 身份就绪"

step "2. lead 建频道 daily,铸两条一次性邀请链接"
ac lead channels create daily lead >/dev/null
LINK_A=$(ac lead invite daily --json | jget ".link")
LINK_B=$(ac lead invite daily --json | jget ".link")
ok "两条邀请链接已生成(agentcomm-local:,不出网)"

step "3. alice / bob 凭链接入频道(connect-by-link,R2)"
ac alice join "$LINK_A" --alias alice >/dev/null
ac bob join "$LINK_B" --alias bob >/dev/null
PEERS=$(ac lead peers daily --json)
echo "$PEERS" | grep -q '"alice"' && echo "$PEERS" | grep -q '"bob"' || fail "peers 里应有 alice 和 bob"
ok "alice、bob 已入频道,lead 可见成员"

step "4. 成员提交日报:alice 定向发 lead,bob 广播 '*'"
ac alice send daily lead "日报:完成 protocol 契约与 34 个单测" >/dev/null
ac bob send daily '*' "日报:relay 端点全部落地,24 用例绿" >/dev/null
INBOX=$(ac lead inbox --consume --json)
COUNT=$(echo "$INBOX" | jget ".length")
[ "$COUNT" = "2" ] || fail "lead 应收到 2 条(实际 $COUNT)"
echo "$INBOX" | grep -q "protocol 契约" || fail "缺 alice 的定向日报"
echo "$INBOX" | grep -q "relay 端点" || fail "缺 bob 的广播日报"
ok "lead 收到 2 条日报并已消费(R3 收件箱)"

step "5. 广播不回流:bob 自己收不到自己的广播;alice 能收到"
BOB_INBOX=$(ac bob inbox --json)
echo "$BOB_INBOX" | grep -q "relay 端点" && fail "bob 不应收到自己的广播" || true
ALICE_INBOX=$(ac alice inbox --consume --json)
echo "$ALICE_INBOX" | grep -q "relay 端点" || fail "alice 应收到 bob 的广播"
ok "广播语义正确"

step "6. intercept 人工门(R6/C3):lead 把频道切到 intercept,bob 的消息被扣住"
ac lead channels mode daily intercept >/dev/null
ac bob send daily lead "补报:想直接改生产配置" >/dev/null
HELD_BEFORE=$(ac lead inbox --json)
echo "$HELD_BEFORE" | grep -q "生产配置" && fail "intercept 下消息不应直达" || true
HELD_ID=$(ac lead held --json | jget "[0].message.messageId")
ok "消息已被家扣住(held: $HELD_ID)"

step "7. 人类(lead 的 CLI,actor=human)放行,消息才送达"
ac lead deliver "$HELD_ID" >/dev/null
ac lead inbox --consume --json | grep -q "生产配置" || fail "放行后应可收到"
ok "人工放行生效(T3 治理,agent 无法自我放行)"

step "8. 审计链完整(R9):每个 store 的账本反映自己节点的视角"
LEAD_AUDIT=$(ac lead audit --json)
for ev in connected delivered; do
  echo "$LEAD_AUDIT" | grep -q "\"$ev\"" || fail "lead audit 缺事件 $ev(建连/放行)"
done
# CLI 发送 = 人工注入 → 'injected'(agent 经 MCP 发送才是 'created');intercept 命中再记 'held'
BOB_AUDIT=$(ac bob audit --json)
for ev in injected held; do
  echo "$BOB_AUDIT" | grep -q "\"$ev\"" || fail "bob audit 缺事件 $ev(注入/被扣)"
done
ok "append-only 审计覆盖全程(发送方可见自己被扣,治理方可见自己放行)"

printf '\n\033[1;32mM1 验收通过:%d 项检查全部成立(store=%s)\033[0m\n' "$pass" "$AGENT_COMM_ROOT"
