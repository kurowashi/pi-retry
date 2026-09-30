# ADR 0001: Google プロバイダのストリームを置き換えて再試行する

- 状態: 採用
- 日付: 2026-10-01
- 対象: `google` プロバイダのストリームと、再試行した試行の履歴への影響

## 背景

Google の無料枠の 429 は `quota exceeded` を含むため、Pi のエージェント層はこれを恒久的なクォータ枯渇とみなして停止します。
実際には毎分の上限で、応答本文の `google.rpc.RetryInfo` に再試行可能時刻が入っています。
Pi のプロバイダ再試行は `Retry-After` ヘッダ前提で、Google はヘッダを返さないため 55 秒の窓を待ち切れません。

## 決定

`pi.registerProvider("google", { api: "google-generative-ai", streamSimple })` で `google` プロバイダのストリームをラップし、
サーバー指定の待ち時間で同じリクエストを再送します。
ラップする実装はホストの `@earendil-works/pi-ai` が公開する `googleGenerativeAIApi()` です。
再試行する試行のイベントは転送せず、セッション履歴に入れません。

## 理由

- 全モデル呼び出しが合成プロバイダを通るため、エージェントのターンだけでなくコンパクションや要約にも同じように効きます。
- 失敗した試行のイベントを転送しなければ、セッション履歴に残らず、`context_edit` のような後始末も要りません。
- `registerProvider` は公開 API で、API id を指定した上書きは合成側でサポートされています。

## 却下した代替

- `agent_before_settle` で失敗メッセージを `context_edit` で外し `continue: true` を返す案。
  公開 API だけで完結し実装も小さいが、エージェントのターンしか対象にできず、
  コンパクションの要約は別経路のため直りません。失敗した試行も履歴に残ります。
- 設定 `retry.provider.maxRetries` と `retry.provider.maxRetryDelayMs` の変更。
  Google が `Retry-After` を返さないため、フォールバックのバックオフは最大 8 秒刻みで 55 秒を待てません。
- `message_end` でエラー文言から `quota exceeded` を消して Pi 本体の再試行に載せる案。
  分類は通るようになるが、待ち時間は Pi の指数バックオフで決まり、サーバー指定の窓を待てません。
