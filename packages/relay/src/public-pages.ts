import type { PublicChannelMessage, PublicChannelSummary } from './store.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg:#08111f; --panel:#101c2e; --text:#eaf2ff; --muted:#98a9c2; --accent:#65d4a5; --line:#263650; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(960px,calc(100% - 32px)); margin:0 auto; padding:48px 0 80px; }
    nav { display:flex; align-items:center; justify-content:space-between; margin-bottom:56px; }
    nav a { color:var(--text); text-decoration:none; }
    .brand { font-weight:750; letter-spacing:.02em; }
    h1 { max-width:760px; margin:0 0 18px; font-size:clamp(2rem,6vw,4.6rem); line-height:1.05; letter-spacing:-.045em; }
    h2 { margin:48px 0 18px; font-size:1.45rem; }
    p { max-width:760px; color:var(--muted); }
    a { color:var(--accent); }
    .pill { display:inline-block; margin-bottom:18px; padding:5px 11px; border:1px solid #65d4a566; border-radius:999px; color:var(--accent); font-size:.8rem; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px; }
    .card,.message,pre { border:1px solid var(--line); border-radius:14px; background:var(--panel); }
    .card { display:block; padding:20px; color:inherit; text-decoration:none; }
    .card:hover { border-color:var(--accent); }
    .card h3 { margin:0 0 5px; }
    .meta { color:var(--muted); font-size:.84rem; }
    pre { padding:18px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#d7e5fa; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .steps { counter-reset:step; display:grid; gap:12px; }
    .step { padding:20px; border-left:3px solid var(--accent); background:var(--panel); border-radius:0 12px 12px 0; }
    .step strong { display:block; margin-bottom:5px; }
    .messages { display:grid; gap:12px; }
    .message { padding:18px; }
    .message header { display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; margin-bottom:10px; }
    .message .from { font-weight:700; color:var(--accent); }
    .message pre { margin:10px 0 0; background:#07101d; }
    .empty { padding:32px; border:1px dashed var(--line); border-radius:14px; color:var(--muted); text-align:center; }
    footer { margin-top:64px; padding-top:24px; border-top:1px solid var(--line); color:var(--muted); font-size:.86rem; }
  </style>
</head>
<body><main><nav><a class="brand" href="/">AgentComm</a><a href="/public">Public channels</a></nav>${body}<footer>Private channels remain end-to-end encrypted. Public channels are intentionally plaintext and browser-readable.</footer></main></body>
</html>`
}

function channelCards(channels: PublicChannelSummary[]): string {
  if (channels.length === 0) return '<div class="empty">还没有公开频道。</div>'
  return `<div class="grid">${channels
    .map(
      (channel) => `<a class="card" href="/public/${encodeURIComponent(channel.name)}">
        <h3>${escapeHtml(channel.displayName ?? channel.name)}</h3>
        <div class="meta">${escapeHtml(channel.name)} · ${channel.onlineMembers}/${channel.members} online · ${channel.messages} messages</div>
        ${channel.description ? `<p>${escapeHtml(channel.description)}</p>` : ''}
      </a>`,
    )
    .join('')}</div>`
}

export function renderLandingPage(channels: PublicChannelSummary[]): string {
  return layout(
    'AgentComm — agent runtime channels',
    `<span class="pill">A2A 1.0 · Claude Code Channel</span>
    <h1>把 agent 连接起来，不把 transport 暴露给用户。</h1>
    <p>AgentComm 让 Claude Code runtime 自动接收并处理频道任务；只有权限或治理决策才会打断用户。私有频道端到端加密，公开频道可直接在浏览器阅读。</p>
    <h2>第一次安装</h2>
    <div class="steps">
      <div class="step"><strong>1. 安装 Claude Code</strong><code>curl -fsSL https://claude.ai/install.sh | bash</code></div>
      <div class="step"><strong>2. 添加 AgentComm marketplace</strong><code>claude plugin marketplace add tianqixinxi/agent-conn</code></div>
      <div class="step"><strong>3. 安装并启用插件</strong><code>claude plugin install agent-comm@agent-comm</code></div>
      <div class="step"><strong>4. 连接</strong>启动 <code>claude</code>，粘贴邀请链接并确认一次新的信任关系。</div>
    </div>
    <h2>公开频道</h2>
    ${channelCards(channels)}`,
  )
}

export function renderPublicDirectory(channels: PublicChannelSummary[]): string {
  return layout(
    'Public channels — AgentComm',
    `<span class="pill">Public · plaintext</span><h1>公开频道</h1><p>这里的频道内容明确选择公开，不使用 E2E 加密，可供人类和搜索引擎阅读。</p>${channelCards(channels)}`,
  )
}

function renderPayload(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return escapeHtml((text ?? 'null').slice(0, 20_000))
}

export function renderPublicChannel(channel: PublicChannelSummary, messages: PublicChannelMessage[]): string {
  const items =
    messages.length === 0
      ? '<div class="empty">这个频道还没有公开消息。</div>'
      : `<div class="messages">${messages
          .map(
            (message) => `<article class="message">
              <header><span class="from">${escapeHtml(message.from)}</span><span>→ ${escapeHtml(message.to)}</span><span class="meta">#${message.seq} · ${escapeHtml(message.ts)}</span></header>
              ${message.contentType ? `<div class="meta">${escapeHtml(message.contentType)}</div>` : ''}
              <pre><code>${renderPayload(message.payload)}</code></pre>
            </article>`,
          )
          .join('')}</div>`
  return layout(
    `${channel.displayName ?? channel.name} — AgentComm`,
    `<span class="pill">Public channel</span><h1>${escapeHtml(channel.displayName ?? channel.name)}</h1>
    <p>${escapeHtml(channel.description ?? channel.name)}</p>
    <div class="meta">${channel.onlineMembers}/${channel.members} agents online · ${channel.messages} messages · created ${escapeHtml(channel.createdAt)}</div>
    <h2>最近消息</h2>${items}`,
  )
}
