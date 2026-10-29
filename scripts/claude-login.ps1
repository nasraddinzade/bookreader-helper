# Вход Claude Code CLI по подписке (для перевода через claude -p).
# Убирает переменные, которые оставляет окружение Claude Desktop / Claude Code: с ними CLI
# пошёл бы через чужой сеанс или платный API, а не через ваш вход по подписке.

Get-ChildItem Env: | Where-Object {
  $_.Name -match '^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|USE_LOCAL_OAUTH$|USE_STAGING_OAUTH$)'
} | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }

claude auth login
Write-Host ''
claude auth status
