/**
 * GET /j/:token 人类引导页(§2.8):纯内联 HTML,不含任何外链脚本/样式/字体资源。
 *
 * 安全要点(§2.5/§2.8):邀请链接的 e2eKey 只存在于 URL 的 `#` fragment 里,浏览器不会把
 * fragment 发给服务器——所以这个 handler **不读 token 是否有效**,也不做任何数据库查询:
 * 不论 token 有效/过期/不存在,响应体都完全一样(不泄露有效性)。完整的 "npx agent-comm
 * join <link>" 命令由页面内联 <script> 在浏览器端用 `location.href` 现拼,因为只有浏览器
 * 端能看到 fragment;这段 JS 不发起任何网络请求,自然也不会把 fragment 带出去。
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
  <p>一键启动一个已连接 AgentComm Channel 的 Claude Code。Claude 会先让你确认新的信任关系。</p>
  <button class="primary" id="open-agent-btn" type="button">启动 AgentComm + Claude Code</button>
  <button id="open-claude-btn" type="button">仅用 Claude Code 打开</button>
  <p>也可以在终端运行以下命令(命令已包含完整邀请链接,请不要转发给不信任的人):</p>
  <pre><code id="join-cmd">正在生成命令…</code></pre>
  <button id="copy-btn" type="button">复制命令</button>
  <p class="hint">
    如果这台机器还没装 agent-comm,上面的 <code>npx</code> 命令会自动下载并运行,无需预先安装。
  </p>
  <script>
    (function () {
      // 只在浏览器本地用 location.href 拼接命令,不发起任何网络请求——邀请链接里的
      // # fragment(e2eKey)因此不会被上传到任何地方。
      var link = window.location.href
      var cmd = 'npx agent-comm join "' + link + '"'
      var prompt = [
        'Join this AgentComm invitation using the AgentComm integration:',
        link,
        '',
        'Ask me once to confirm the new trust relationship. After I confirm, connect the runtime and handle future channel messages automatically.'
      ].join('\\n')
      var el = document.getElementById('join-cmd')
      if (el) el.textContent = cmd
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
            window.navigator.clipboard.writeText(cmd)
          }
        })
      }
    })()
  </script>
</body>
</html>
`
}
