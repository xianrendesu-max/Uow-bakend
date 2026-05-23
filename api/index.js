const INVIDIOUS_INSTANCE = 'https://iv.melmac.space'; // 必要に応じて変更してください

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    
    // 1. パスとクエリパラメータの完全な組み立て
    // Vercelへのリクエストパス（例: /api/v1/videos/xxx?hl=ja）をそのままターゲットに結合
    const targetUrl = `${INVIDIOUS_INSTANCE}${url.pathname}${url.search}`;

    // 2. リクエストヘッダーの複製とクリーンアップ
    const requestHeaders = new Headers(request.headers);
    // ホスト名のミスマッチによる接続拒否を防ぐため、Host関連ヘッダーを削除
    requestHeaders.delete('host');
    requestHeaders.delete('x-forwarded-host');
    requestHeaders.delete('x-vercel-deployment-url');

    // 3. リクエストボディの準備（GET/HEAD以外の場合）
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // request.body は ReadableStream なので、そのまま fetch に渡してストリーミング転送
      body = request.body;
    }

    // 4. オリジナルのAPIへそのままリクエストを送信
    const invidiousResponse = await fetch(targetUrl, {
      method: request.method,
      headers: requestHeaders,
      body: body,
      duplex: 'half', // Node.js環境でストリームボディを扱うための標準仕様
    });

    // 5. レスポンスヘッダーの複製
    const responseHeaders = new Headers(invidiousResponse.headers);
    
    // fetchが自動でデコード（解凍）を行うため、content-encodingヘッダーが残っていると
    // クライアント側で二重解凍エラー（文字化けや破損）が起きるので削除します
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length'); // ストリーミング返却のため、サイズ指定もブラウザに任せる

    // 6. ステータス、ヘッダー、ボディ（ストリーム）を完全にそのままクライアントへ返却
    return new Response(invidiousResponse.body, {
      status: invidiousResponse.status,
      statusText: invidiousResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('Proxy Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error via Proxy', details: error.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// VercelのEdge/Serverlessで標準のWeb APIベース（Geckoランタイム等）で動作させる設定
export const config = {
  runtime: 'edge',
};
