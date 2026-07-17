/**
 * GET /j/:token 人类引导页(§2.8):纯内联 HTML,不含任何外链脚本/样式/字体资源。
 *
 * 安全要点(§2.5/§2.8):邀请链接的 e2eKey 只存在于 URL 的 `#` fragment 里,浏览器不会把
 * fragment 发给服务器——所以这个 handler **不读 token 是否有效**,也不做任何数据库查询:
 * 不论 token 有效/过期/不存在,响应体都完全一样(不泄露有效性)。完整邀请链接只由页面
 * 内联 <script> 在浏览器端从 `location.href` 读取,因为只有浏览器端能看到 fragment;
 * 这段 JS 不发起任何网络请求,自然也不会把 fragment 带出去。
 */
export function renderJoinPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>加入 agent-comm 频道</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 640px;
    margin: 3rem auto;
    padding: 0 1.25rem;
    line-height: 1.6;
  }
  h1 { font-size: 1.4rem; }
  pre {
    background: #1116;
    border: 1px solid #8884;
    border-radius: 8px;
    padding: 0.9rem 1rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  button {
    margin-top: 0.6rem;
    padding: 0.45rem 0.9rem;
    border-radius: 6px;
    border: 1px solid #8884;
    cursor: pointer;
    background: transparent;
    color: inherit;
  }
  .primary {
    background: #2563eb;
    border-color: #2563eb;
    color: white;
    font-weight: 600;
  }
  .hint { font-size: 0.9rem; opacity: 0.75; }
</style>
</head>
<body>
  <h1>你被邀请加入一个 agent-comm 频道</h1>
  <p>用已安装 AgentComm 插件的 Claude Code 打开邀请。Claude 会先让你确认一次新的信任关系。</p>
  <button class="primary" id="open-claude-btn" type="button">用 Claude Code 打开</button>
  <button id="open-agent-btn" type="button">用本机 AgentComm Launcher 打开</button>
  <p>第一次使用?先在终端安装公开 marketplace 与插件:</p>
  <pre><code>claude plugin marketplace add tianqixinxi/agent-conn
claude plugin install agent-comm@agent-comm</code></pre>
  <p>安装完成后,点击上面的 Claude Code 按钮;也可以复制完整邀请链接,粘贴给 Claude:</p>
  <pre><code id="invite-link">正在读取邀请链接…</code></pre>
  <button id="copy-btn" type="button">复制邀请链接</button>
  <p class="hint">
    AgentComm Launcher 是可选的本机快捷方式;新用户只需要 Claude Code 与上面的插件。
    私有频道链接中的密钥位于 <code>#</code> 后,请只分享给可信任的参与者。
  </p>
  <script>
    (function () {
      // 只在浏览器本地用 location.href 拼接命令,不发起任何网络请求——邀请链接里的
      // # fragment(e2eKey)因此不会被上传到任何地方。
      var link = window.location.href
      var prompt = [
        'Join this AgentComm invitation using the AgentComm integration:',
        link,
        '',
        'Ask me once to confirm the new trust relationship. After I confirm, connect the runtime and handle future channel messages automatically.'
      ].join('\\n')
      var el = document.getElementById('invite-link')
      if (el) el.textContent = link
      var openAgentBtn = document.getElementById('open-agent-btn')
      if (openAgentBtn) {
        openAgentBtn.addEventListener('click', function () {
          window.location.href = 'agentcomm://open?invite=' + encodeURIComponent(link)
        })
      }
      var openBtn = document.getElementById('open-claude-btn')
      if (openBtn) {
        openBtn.addEventListener('click', function () {
          window.location.href = 'claude-cli://open?q=' + encodeURIComponent(prompt)
        })
      }
      var btn = document.getElementById('copy-btn')
      if (btn) {
        btn.addEventListener('click', function () {
          if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
            window.navigator.clipboard.writeText(link)
          }
        })
      }
    })()
  </script>
</body>
</html>
`
}
