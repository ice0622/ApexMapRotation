// Discord Webhook への送信。
//
// Webhook URL は秘密情報として扱い、ログへ出力しない。

const HTTP_TIMEOUT_MS = 10_000;

export async function sendDiscordNotification(webhook, content) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
