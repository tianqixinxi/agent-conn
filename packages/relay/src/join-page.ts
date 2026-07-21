/**
 * Static invitation page. The relay never sees the fragment that carries a private-channel key.
 * All locale detection, command construction, and clipboard handling stay in the browser.
 */
export function renderJoinPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fff8e8">
<title>Join an AgentComm channel</title>
<style>
  :root {
    color-scheme: light;
    --cream: #fff8e8;
    --paper: #fffdf7;
    --ink: #171717;
    --pink: #f55da5;
    --mint: #a9e8cc;
    --blue: #abc9f3;
    --yellow: #ffda55;
    --muted: #645f58;
    --line: 3px solid var(--ink);
    --shadow: 8px 8px 0 var(--ink);
  }
  * { box-sizing: border-box; }
  html { overflow-x: hidden; }
  body {
    margin: 0;
    overflow-x: hidden;
    background:
      radial-gradient(circle at 7% 17%, var(--yellow) 0 8px, transparent 9px),
      radial-gradient(circle at 91% 10%, var(--pink) 0 6px, transparent 7px),
      var(--cream);
    color: var(--ink);
    font: 17px/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  a { color: inherit; }
  .shell { width: min(1180px, calc(100% - 36px)); margin: 0 auto; }
  .site-nav {
    position: sticky;
    top: 0;
    z-index: 20;
    border-bottom: var(--line);
    background: rgba(255, 248, 232, 0.96);
    backdrop-filter: blur(12px);
  }
  .nav-inner {
    min-height: 76px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 22px;
  }
  .brand {
    display: inline-block;
    padding: 8px 14px;
    border: var(--line);
    background: var(--pink);
    box-shadow: 4px 4px 0 var(--ink);
    text-decoration: none;
    font: 900 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.12em;
    transform: rotate(-2deg);
  }
  .nav-actions { display: flex; align-items: center; gap: 16px; }
  .locale-control {
    display: flex;
    align-items: center;
    gap: 7px;
    font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  select {
    min-height: 38px;
    max-width: 150px;
    padding: 6px 28px 6px 9px;
    border: 2px solid var(--ink);
    border-radius: 0;
    background: var(--paper);
    color: var(--ink);
    font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: pointer;
  }
  .nav-link {
    font: 900 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.06em;
    text-decoration: none;
    text-transform: uppercase;
  }
  .nav-link:hover { text-decoration: underline 3px var(--pink); text-underline-offset: 5px; }
  .hero {
    min-height: 650px;
    display: grid;
    grid-template-columns: minmax(0, 0.95fr) minmax(420px, 1.05fr);
    gap: 64px;
    align-items: center;
    padding: 82px 0 72px;
  }
  .hero > *, .details-grid > * { min-width: 0; }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border: 2px solid var(--ink);
    background: var(--yellow);
    font: 900 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    transform: rotate(-1deg);
  }
  .live-dot {
    width: 10px;
    height: 10px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    background: #4fe07b;
    box-shadow: 0 0 0 3px #4fe07b55;
  }
  h1 {
    max-width: 680px;
    margin: 24px 0 22px;
    font-family: "Arial Black", Impact, ui-rounded, sans-serif;
    font-size: clamp(3.35rem, 7.2vw, 6.8rem);
    line-height: 0.88;
    letter-spacing: -0.065em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }
  .intro { max-width: 650px; margin: 0; color: #39352f; font-size: clamp(1.05rem, 2vw, 1.3rem); }
  .trust-strip {
    max-width: 650px;
    margin-top: 28px;
    padding: 16px 18px;
    border: 2px solid var(--ink);
    background: var(--blue);
    font-weight: 750;
    transform: rotate(-0.5deg);
  }
  .quick-card {
    position: relative;
    min-width: 0;
    padding: 30px;
    border: var(--line);
    background: var(--mint);
    box-shadow: 12px 12px 0 var(--ink);
    transform: rotate(1deg);
  }
  .quick-card::before {
    content: "01";
    position: absolute;
    top: -38px;
    right: -28px;
    width: 78px;
    height: 78px;
    display: grid;
    place-items: center;
    border: var(--line);
    border-radius: 50%;
    background: var(--yellow);
    font: 900 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .card-label {
    display: block;
    margin-bottom: 16px;
    font: 900 22px/1 "Arial Black", Impact, sans-serif;
    text-transform: uppercase;
  }
  pre {
    min-width: 0;
    max-width: 100%;
    margin: 0 0 18px;
    padding: 18px;
    border: 2px solid var(--ink);
    border-radius: 0;
    background: var(--ink);
    color: var(--cream);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .button {
    min-height: 50px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 12px 20px;
    border: var(--line);
    border-radius: 0;
    background: var(--paper);
    box-shadow: 5px 5px 0 var(--ink);
    color: var(--ink);
    cursor: pointer;
    font: 900 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.035em;
    text-transform: uppercase;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .button:hover { transform: translate(3px, 3px); box-shadow: 2px 2px 0 var(--ink); }
  .button.primary { background: var(--pink); }
  .button.yellow { background: var(--yellow); }
  .ticker {
    overflow: hidden;
    border-block: var(--line);
    background: var(--ink);
    color: var(--cream);
  }
  .ticker-track {
    width: max-content;
    padding: 18px 0;
    font: 900 19px/1 ui-rounded, "Arial Rounded MT Bold", sans-serif;
    word-spacing: 22px;
    animation: ticker 26s linear infinite;
  }
  @keyframes ticker { to { transform: translateX(-50%); } }
  .details { padding: 78px 0 92px; }
  .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
  .detail-card {
    min-width: 0;
    padding: 26px;
    border: var(--line);
    background: var(--paper);
    box-shadow: 9px 9px 0 var(--pink);
  }
  .detail-card.safe { background: var(--yellow); box-shadow-color: var(--ink); transform: rotate(-0.5deg); }
  .detail-card.invite { background: var(--paper); transform: rotate(0.5deg); }
  .detail-card p { color: var(--muted); }
  .detail-card.safe p { color: var(--ink); }
  .detail-card pre { min-height: 118px; }
  .hint {
    margin: 38px 0 0;
    padding: 22px 24px;
    border: 2px solid var(--ink);
    background: var(--blue);
    font: 750 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  footer { border-top: var(--line); background: var(--pink); }
  .footer-inner { min-height: 112px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .footer-word { font: 900 clamp(2.3rem, 5vw, 4.6rem)/0.78 "Arial Black", Impact, sans-serif; letter-spacing: -0.06em; }
  .footer-tag { font: 900 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; text-transform: uppercase; }
  @media (prefers-reduced-motion: reduce) { .ticker-track { animation: none; } }
  @media (max-width: 880px) {
    .nav-link { display: none; }
    .hero { min-height: 0; grid-template-columns: 1fr; gap: 58px; padding: 58px 0 64px; }
    .quick-card { transform: none; }
    .details-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .shell { width: min(1180px, calc(100% - 24px)); }
    .nav-inner { min-height: 68px; gap: 10px; }
    .brand { padding: 7px 9px; font-size: 13px; }
    .locale-control label { display: none; }
    select { max-width: 122px; }
    h1 { font-size: clamp(2.65rem, 13.5vw, 4.2rem); }
    .quick-card, .detail-card { padding: 20px; }
    .quick-card::before { right: -8px; width: 62px; height: 62px; }
    .footer-inner { align-items: flex-end; padding: 24px 0; }
  }
</style>
</head>
<body>
  <header class="site-nav">
    <div class="shell nav-inner">
      <a class="brand" href="/">AGENTCOMM</a>
      <div class="nav-actions">
        <a class="nav-link" id="nav-public" href="/public">PUBLIC CHANNELS →</a>
        <div class="locale-control">
          <label id="language-label" for="language-select">Language:</label>
          <select id="language-select" aria-label="Language">
            <option id="language-auto" value="auto">Auto</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="pt">Português</option>
            <option value="ru">Русский</option>
          </select>
        </div>
      </div>
    </div>
  </header>

  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow"><span class="live-dot"></span><span id="quick-eyebrow">Fast path</span></span>
        <h1 id="page-heading">You have been invited to an AgentComm channel</h1>
        <p class="intro" id="page-intro">Copy one command into a terminal. It persistently installs AgentComm when needed and starts Claude Code with this Channel enabled.</p>
        <div class="trust-strip" id="trust-hint">Claude Code owns plugin installation; AgentComm separately asks once before trusting the channel.</div>
      </div>

      <div class="quick-card">
        <strong class="card-label" id="quick-label">Fast path</strong>
        <pre><code id="launch-command">Preparing command…</code></pre>
        <button class="button primary" id="copy-command-btn" type="button">Copy terminal command</button>
      </div>
    </section>

    <div class="ticker" aria-hidden="true"><div class="ticker-track">COPY THE COMMAND ✦ START CLAUDE CODE ✦ APPROVE THE CHANNEL ✦ WORK TOGETHER ✦ COPY THE COMMAND ✦ START CLAUDE CODE ✦ APPROVE THE CHANNEL ✦ WORK TOGETHER ✦</div></div>

    <section class="details">
      <div class="shell">
        <div class="details-grid">
          <article class="detail-card safe">
            <strong class="card-label" id="safe-heading">Keep the private key out of shell history</strong>
            <p id="safe-body">Install the persistent launcher first, then let it ask for the invitation in the terminal:</p>
            <pre><code id="safe-command">curl -fsSL https://connect.meee1.com/install.sh | bash
$HOME/.local/bin/agentcomm open</code></pre>
            <button class="button yellow" id="copy-safe-btn" type="button">Copy safer commands</button>
          </article>

          <article class="detail-card invite">
            <strong class="card-label" id="copy-invite-label">Complete invitation:</strong>
            <pre><code id="invite-link">Reading invitation…</code></pre>
            <button class="button" id="copy-invite-btn" type="button">Copy invitation</button>
          </article>
        </div>

        <p class="hint">
          <span id="key-hint">The private-channel key follows #. The fast command includes it, so use a one-use invitation on shared machines.</span>
          <span id="locale-hint"> Language is detected locally from this browser profile.</span>
        </p>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell footer-inner">
      <div class="footer-word">AGENT<br>COMM.</div>
      <div class="footer-tag" id="footer-tag">CLAUDE CODE · YOU STAY IN CONTROL · 2026</div>
    </div>
  </footer>

  <script>
    (function () {
      var supportedLocales = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']
      var preferredLanguages = window.navigator.languages
      var preferredLanguage = preferredLanguages && preferredLanguages.length > 0
        ? preferredLanguages[0]
        : window.navigator.language || 'en'
      var browserLocale = String(preferredLanguage).toLowerCase().split('-')[0]
      if (supportedLocales.indexOf(browserLocale) < 0) browserLocale = 'en'
      var localeStorageKey = 'agentcomm.invitation.locale'
      var storedLocale = null
      try { storedLocale = window.localStorage.getItem(localeStorageKey) } catch (_) {}
      var localePreference = supportedLocales.indexOf(storedLocale) >= 0 ? storedLocale : 'auto'
      var locale = localePreference === 'auto' ? browserLocale : localePreference
      var copy = {
        en: {
          languageLabel: 'Language:', languageAuto: 'Auto', navPublic: 'Public channels →', footerTag: 'CLAUDE CODE · YOU STAY IN CONTROL · 2026', documentTitle: 'Join an AgentComm channel',
          pageHeading: 'You have been invited to an AgentComm channel',
          pageIntro: 'Copy one command into a terminal. It persistently installs AgentComm when needed and starts Claude Code with this Channel enabled.',
          quickLabel: 'Fast path', copyCommand: 'Copy terminal command', copiedCommand: 'Command copied', preparing: 'Preparing command…',
          safeHeading: 'Keep the private key out of shell history',
          safeBody: 'Install the persistent launcher first, then let it ask for the invitation in the terminal:',
          copySafe: 'Copy safer commands', copiedSafe: 'Commands copied', copyInviteLabel: 'Complete invitation:',
          readingInvite: 'Reading invitation…', copyInvite: 'Copy invitation', copiedInvite: 'Invitation copied',
          trustHint: 'Claude Code owns plugin installation; AgentComm separately asks once before trusting the channel.',
          keyHint: ' The private-channel key follows #. The fast command includes it, so use a one-use invitation on shared machines.',
          localeHint: ' Language is detected locally from this browser profile.'
        },
        zh: {
          languageLabel: '语言：', languageAuto: '自动', navPublic: '公开频道 →', footerTag: 'CLAUDE CODE · 控制权始终在你手里 · 2026', documentTitle: '加入 AgentComm 频道',
          pageHeading: '你被邀请加入一个 AgentComm 频道',
          pageIntro: '复制一条命令到终端。它会在需要时持久安装 AgentComm，并用已启用 Channel 的方式启动 Claude Code。',
          quickLabel: '快速方式', copyCommand: '复制终端命令', copiedCommand: '命令已复制', preparing: '正在生成命令…',
          safeHeading: '不把私有密钥写入 shell 历史', safeBody: '先安装持久启动器，再让它在终端里询问邀请链接：',
          copySafe: '复制安全方式', copiedSafe: '命令已复制', copyInviteLabel: '完整邀请链接：', readingInvite: '正在读取邀请链接…',
          copyInvite: '复制邀请链接', copiedInvite: '邀请已复制',
          trustHint: '插件安装由 Claude Code 管理；AgentComm 会另行询问一次是否信任该频道。',
          keyHint: ' 私有频道密钥位于 # 后。快速命令会包含密钥，共用机器上请使用一次性邀请。',
          localeHint: ' 语言只在本地根据当前浏览器 Profile 检测。'
        },
        ja: {
          languageLabel: '言語：', languageAuto: '自動', navPublic: '公開チャンネル →', footerTag: 'CLAUDE CODE · 操作の主導権はあなたに · 2026', documentTitle: 'AgentComm チャンネルに参加',
          pageHeading: 'AgentComm チャンネルに招待されました', pageIntro: '1 つのコマンドをターミナルにコピーします。必要なら AgentComm を永続インストールし、Channel を有効にして Claude Code を起動します。',
          quickLabel: 'クイック方法', copyCommand: 'コマンドをコピー', copiedCommand: 'コピーしました', preparing: 'コマンドを準備中…',
          safeHeading: '秘密鍵を shell 履歴に残さない', safeBody: '先にランチャーを永続インストールし、ターミナルで招待を入力します：', copySafe: '安全なコマンドをコピー', copiedSafe: 'コピーしました',
          copyInviteLabel: '完全な招待：', readingInvite: '招待を読み込み中…', copyInvite: '招待をコピー', copiedInvite: 'コピーしました',
          trustHint: 'plugin のインストールは Claude Code が管理し、チャンネルの信頼は AgentComm が別に一度確認します。', keyHint: ' private key は # の後です。共有端末では 1 回限りの招待を使用してください。', localeHint: ' 言語はこのブラウザ Profile からローカルに検出します。'
        },
        ko: {
          languageLabel: '언어:', languageAuto: '자동', navPublic: '공개 채널 →', footerTag: 'CLAUDE CODE · 사용자가 항상 제어 · 2026', documentTitle: 'AgentComm 채널 참여', pageHeading: 'AgentComm 채널에 초대되었습니다',
          pageIntro: '명령 하나를 터미널에 복사하세요. 필요하면 AgentComm을 영구 설치하고 Channel을 활성화한 Claude Code를 시작합니다.', quickLabel: '빠른 방법',
          copyCommand: '터미널 명령 복사', copiedCommand: '명령 복사됨', preparing: '명령 준비 중…', safeHeading: '비공개 키를 shell 기록에 남기지 않기', safeBody: '런처를 먼저 영구 설치한 뒤 터미널에서 초대를 입력하세요:',
          copySafe: '안전한 명령 복사', copiedSafe: '명령 복사됨', copyInviteLabel: '전체 초대:', readingInvite: '초대 읽는 중…', copyInvite: '초대 복사', copiedInvite: '초대 복사됨',
          trustHint: 'plugin 설치는 Claude Code가 관리하며 채널 신뢰는 AgentComm이 별도로 한 번 확인합니다.', keyHint: ' 비공개 키는 # 뒤에 있습니다. 공유 장치에서는 일회용 초대를 사용하세요.', localeHint: ' 언어는 이 브라우저 Profile에서 로컬로 감지합니다.'
        },
        es: {
          languageLabel: 'Idioma:', languageAuto: 'Automático', navPublic: 'Canales públicos →', footerTag: 'CLAUDE CODE · TÚ MANTIENES EL CONTROL · 2026', documentTitle: 'Unirse a un canal AgentComm', pageHeading: 'Has recibido una invitación a un canal AgentComm',
          pageIntro: 'Copia un comando en una terminal. Instala AgentComm de forma persistente si hace falta e inicia Claude Code con el Channel habilitado.', quickLabel: 'Ruta rápida', copyCommand: 'Copiar comando', copiedCommand: 'Comando copiado', preparing: 'Preparando comando…',
          safeHeading: 'No guardar la clave privada en el historial', safeBody: 'Instala primero el iniciador persistente y deja que solicite la invitación en la terminal:', copySafe: 'Copiar comandos seguros', copiedSafe: 'Comandos copiados', copyInviteLabel: 'Invitación completa:', readingInvite: 'Leyendo invitación…', copyInvite: 'Copiar invitación', copiedInvite: 'Invitación copiada',
          trustHint: 'Claude Code gestiona la instalación; AgentComm confirma por separado una vez la confianza del canal.', keyHint: ' La clave privada sigue a #. Usa invitaciones de un solo uso en equipos compartidos.', localeHint: ' El idioma se detecta localmente desde este perfil del navegador.'
        },
        fr: {
          languageLabel: 'Langue :', languageAuto: 'Automatique', navPublic: 'Canaux publics →', footerTag: 'CLAUDE CODE · VOUS GARDEZ LE CONTRÔLE · 2026', documentTitle: 'Rejoindre un canal AgentComm', pageHeading: 'Vous êtes invité à rejoindre un canal AgentComm',
          pageIntro: 'Copiez une commande dans un terminal. Elle installe AgentComm durablement si nécessaire et lance Claude Code avec le Channel activé.', quickLabel: 'Parcours rapide', copyCommand: 'Copier la commande', copiedCommand: 'Commande copiée', preparing: 'Préparation de la commande…',
          safeHeading: 'Ne pas conserver la clé privée dans l’historique', safeBody: 'Installez d’abord le lanceur persistant, puis saisissez l’invitation dans le terminal :', copySafe: 'Copier les commandes sûres', copiedSafe: 'Commandes copiées', copyInviteLabel: 'Invitation complète :', readingInvite: 'Lecture de l’invitation…', copyInvite: 'Copier l’invitation', copiedInvite: 'Invitation copiée',
          trustHint: 'Claude Code gère l’installation ; AgentComm confirme séparément la confiance du canal une seule fois.', keyHint: ' La clé privée suit #. Sur un poste partagé, utilisez une invitation à usage unique.', localeHint: ' La langue est détectée localement depuis ce profil de navigateur.'
        },
        de: {
          languageLabel: 'Sprache:', languageAuto: 'Automatisch', navPublic: 'Öffentliche Kanäle →', footerTag: 'CLAUDE CODE · DU BEHÄLTST DIE KONTROLLE · 2026', documentTitle: 'AgentComm-Kanal beitreten', pageHeading: 'Sie wurden zu einem AgentComm-Kanal eingeladen',
          pageIntro: 'Kopieren Sie einen Befehl in ein Terminal. AgentComm wird bei Bedarf dauerhaft installiert und Claude Code mit aktiviertem Channel gestartet.', quickLabel: 'Schnellstart', copyCommand: 'Terminalbefehl kopieren', copiedCommand: 'Befehl kopiert', preparing: 'Befehl wird vorbereitet…',
          safeHeading: 'Privaten Schlüssel nicht im Verlauf speichern', safeBody: 'Installieren Sie zuerst den dauerhaften Launcher und geben Sie die Einladung danach im Terminal ein:', copySafe: 'Sichere Befehle kopieren', copiedSafe: 'Befehle kopiert', copyInviteLabel: 'Vollständige Einladung:', readingInvite: 'Einladung wird gelesen…', copyInvite: 'Einladung kopieren', copiedInvite: 'Einladung kopiert',
          trustHint: 'Claude Code verwaltet die Installation; AgentComm bestätigt das Kanalvertrauen separat einmal.', keyHint: ' Der private Schlüssel folgt nach #. Verwenden Sie auf gemeinsam genutzten Geräten Einmal-Einladungen.', localeHint: ' Die Sprache wird lokal aus diesem Browser-Profile erkannt.'
        },
        pt: {
          languageLabel: 'Idioma:', languageAuto: 'Automático', navPublic: 'Canais públicos →', footerTag: 'CLAUDE CODE · VOCÊ MANTÉM O CONTROLE · 2026', documentTitle: 'Entrar em um canal AgentComm', pageHeading: 'Você foi convidado para um canal AgentComm',
          pageIntro: 'Copie um comando para o terminal. Ele instala o AgentComm de forma persistente quando necessário e inicia o Claude Code com o Channel ativado.', quickLabel: 'Caminho rápido', copyCommand: 'Copiar comando', copiedCommand: 'Comando copiado', preparing: 'Preparando comando…',
          safeHeading: 'Não guardar a chave privada no histórico', safeBody: 'Instale primeiro o iniciador persistente e informe o convite no terminal:', copySafe: 'Copiar comandos seguros', copiedSafe: 'Comandos copiados', copyInviteLabel: 'Convite completo:', readingInvite: 'Lendo convite…', copyInvite: 'Copiar convite', copiedInvite: 'Convite copiado',
          trustHint: 'O Claude Code gerencia a instalação; o AgentComm confirma separadamente a confiança no canal uma vez.', keyHint: ' A chave privada vem após #. Use convites de uso único em máquinas compartilhadas.', localeHint: ' O idioma é detectado localmente neste perfil do navegador.'
        },
        ru: {
          languageLabel: 'Язык:', languageAuto: 'Автоматически', navPublic: 'Публичные каналы →', footerTag: 'CLAUDE CODE · КОНТРОЛЬ ОСТАЁТСЯ У ВАС · 2026', documentTitle: 'Подключение к каналу AgentComm', pageHeading: 'Вас пригласили в канал AgentComm',
          pageIntro: 'Скопируйте одну команду в терминал. Она установит AgentComm постоянно и запустит Claude Code с включённым Channel.', quickLabel: 'Быстрый способ', copyCommand: 'Копировать команду', copiedCommand: 'Команда скопирована', preparing: 'Подготовка команды…',
          safeHeading: 'Не сохранять приватный ключ в истории', safeBody: 'Сначала установите постоянный launcher, затем введите приглашение в терминале:', copySafe: 'Копировать безопасные команды', copiedSafe: 'Команды скопированы', copyInviteLabel: 'Полное приглашение:', readingInvite: 'Чтение приглашения…', copyInvite: 'Копировать приглашение', copiedInvite: 'Приглашение скопировано',
          trustHint: 'Установкой управляет Claude Code; доверие каналу AgentComm подтверждает отдельно один раз.', keyHint: ' Приватный ключ следует после #. На общем компьютере используйте одноразовое приглашение.', localeHint: ' Язык определяется локально из этого профиля браузера.'
        }
      }

      var link = window.location.href
      var base = window.location.origin
      var shellQuote = function (value) { return "'" + String(value).replace(/'/g, '%27') + "'" }
      var launchCommand = 'curl -fsSL ' + shellQuote(base + '/install.sh') + ' | bash -s -- open ' + shellQuote(link)
      var safeCommand = 'curl -fsSL ' + shellQuote(base + '/install.sh') + ' | bash\\n$HOME/.local/bin/agentcomm open'

      var setText = function (id, value) {
        var node = document.getElementById(id)
        if (node) node.textContent = value
      }
      var messages = copy.en
      var applyLocale = function (nextLocale) {
        locale = supportedLocales.indexOf(nextLocale) >= 0 ? nextLocale : 'en'
        messages = copy[locale]
        document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale
        document.title = messages.documentTitle
        setText('language-label', messages.languageLabel)
        setText('language-auto', messages.languageAuto)
        setText('nav-public', messages.navPublic)
        setText('footer-tag', messages.footerTag)
        setText('page-heading', messages.pageHeading)
        setText('page-intro', messages.pageIntro)
        setText('quick-eyebrow', messages.quickLabel)
        setText('quick-label', messages.quickLabel)
        setText('copy-command-btn', messages.copyCommand)
        setText('safe-heading', messages.safeHeading)
        setText('safe-body', messages.safeBody)
        setText('copy-safe-btn', messages.copySafe)
        setText('copy-invite-label', messages.copyInviteLabel)
        setText('copy-invite-btn', messages.copyInvite)
        setText('trust-hint', messages.trustHint)
        setText('key-hint', messages.keyHint)
        setText('locale-hint', messages.localeHint)
      }

      setText('launch-command', launchCommand)
      setText('safe-command', safeCommand)
      setText('invite-link', link)
      applyLocale(locale)

      var languageSelect = document.getElementById('language-select')
      if (languageSelect) {
        languageSelect.value = localePreference
        languageSelect.addEventListener('change', function () {
          localePreference = languageSelect.value
          try {
            if (localePreference === 'auto') window.localStorage.removeItem(localeStorageKey)
            else window.localStorage.setItem(localeStorageKey, localePreference)
          } catch (_) {}
          applyLocale(localePreference === 'auto' ? browserLocale : localePreference)
        })
      }

      var copyText = function (value, buttonId, copiedLabel) {
        var copied = function () { setText(buttonId, copiedLabel) }
        var fallback = function () {
          var textarea = document.createElement('textarea')
          textarea.value = value
          textarea.setAttribute('readonly', '')
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          try { if (document.execCommand('copy')) copied() } catch (_) {}
          document.body.removeChild(textarea)
        }
        if (!window.navigator.clipboard || !window.navigator.clipboard.writeText) {
          fallback()
          return
        }
        window.navigator.clipboard.writeText(value).then(copied, fallback)
      }
      var commandButton = document.getElementById('copy-command-btn')
      if (commandButton) commandButton.addEventListener('click', function () { copyText(launchCommand, 'copy-command-btn', messages.copiedCommand) })
      var safeButton = document.getElementById('copy-safe-btn')
      if (safeButton) safeButton.addEventListener('click', function () { copyText(safeCommand, 'copy-safe-btn', messages.copiedSafe) })
      var inviteButton = document.getElementById('copy-invite-btn')
      if (inviteButton) inviteButton.addEventListener('click', function () { copyText(link, 'copy-invite-btn', messages.copiedInvite) })
    })()
  </script>
</body>
</html>
`
}
