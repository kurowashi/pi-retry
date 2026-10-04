# AGENTS.md — pi-retry で作業するエージェント向けの指示

読者は pi-retry を変更する AI エージェントと開発者です。利用者向けの仕様は [README](README.md) に、
設計の判断基準は [DESIGN.md](DESIGN.md) と [PHILOSOPHY.md](PHILOSOPHY.md)(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、
自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所であり、
自動検証はすべて `verify` に含まれます。

## 制約

### フック面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 登録はプロバイダ上書き1件だけ(`google` / `google-generative-ai`) | `test/contract/surface.test.ts` | `src/index.ts` の `RETRY_TARGET` |
| ツール・コマンドを登録しない | `test/contract/surface.test.ts` | `src/index.ts` |
| `session_start` ハンドラは1つだけ | `test/contract/surface.test.ts` | `src/index.ts` の `registerRetryExtension` |
| 上書きはホストの `googleGenerativeAIApi()` に委譲する | `test/integration/extension.test.ts` | `src/index.ts` の `googleRetryExtension` |

### 再試行の判断

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| サーバーの再試行指示があるときだけ再試行する | `test/unit/retry.test.ts` | `src/retry.ts` の `RETRY_INSTRUCTION` |
| `"retryDelay": "Ns"` と `Please retry in Ns` の両方を読む | `test/unit/retry.test.ts` | `src/retry.ts` の `serverRetryDelayMs` |
| 文字列以外の `errorMessage` は JSON 化して読む | `test/unit/retry.test.ts` | `src/retry.ts` の `errorText` |
| 出力開始後の失敗は再試行しない | `test/unit/retry.test.ts` | `src/retry.ts` の `finishAttempt` |
| 待ち時間は指示 + マージン、`maxDelayMs` で上限を取る | `test/unit/retry.test.ts` | `src/retry.ts` の `serverRetryDelayMs` |
| 試行は初回 + `maxRetries`。超過後は最後のエラーを報告する | `test/unit/retry.test.ts` | `src/retry.ts` の `forwardAttempts` |
| 既定ポリシーは `maxRetries: 3` / `marginMs: 1000` / `maxDelayMs: 120000` | `test/unit/retry.test.ts` | `src/retry.ts` の `DEFAULT_RETRY_POLICY` |

### ストリーム契約

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 再試行する試行のイベント(`start` を含む)は転送しない | `test/unit/retry.test.ts` | `src/retry.ts` の `forwardAttempt` |
| 正常試行は start・本文・終端をそのまま転送する | `test/unit/retry.test.ts` | `src/retry.ts` の `forwardAttempt` |
| 終端イベントは1つだけ。失敗は error で閉じる | `test/unit/retry.test.ts` | `src/retry.ts` の `finishAttempt` |
| 待機中の中断は aborted として閉じ、再試行しない | `test/unit/retry.test.ts` | `src/retry.ts` の `sleep` / `endWithAborted` |
| 同期 throw は error イベントにして閉じる | `test/unit/retry.test.ts` | `src/retry.ts` の `forwardAttempt` |
| 終端イベント無しで終わる実装は `result()` の値で閉じる | `test/unit/retry.test.ts` | `src/retry.ts` の `forwardAttempt` |

### 設定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定ファイルは `~/.pi/agent/retry.json` と信頼済み `<cwd>/.pi/retry.json` の2箇所で、プロジェクトが上書きする | `test/unit/config.test.ts` + `test/integration/extension.test.ts` | `src/config.ts` の `loadRetryConfig` |
| 未信頼のプロジェクトのファイルは読まない | `test/unit/config.test.ts` + `test/integration/extension.test.ts` | `src/config.ts` の `loadRetryConfig` |
| 設定できるのは `maxRetries`(0〜10の整数)だけ。待ち時間は固定 | `test/unit/config.test.ts` | `src/config.ts` の `resolveMaxRetries`、`src/retry.ts` の `DEFAULT_RETRY_POLICY` |
| 不正な値・壊れた JSON・非オブジェクトは警告して既定値3で動く | `test/unit/config.test.ts` | `src/config.ts` の `readObject` / `resolveMaxRetries` |
| 未知のキーは無視する | `test/unit/config.test.ts` | `src/config.ts` の `mergeFile` |
| 読み込みは `session_start` ごとに行い、次のリクエストから反映する | `test/integration/extension.test.ts` | `src/index.ts` の `registerRetryExtension` |
| 警告は UI にだけ出し、セッションを止めない | `test/integration/extension.test.ts` | `src/index.ts` の `registerRetryExtension` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `dependencies` フィールドは空(実行時依存を同梱しない) | `test/contract/dependencies.test.ts` | `package.json` |
| peerDependency は Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| `src` の import は node builtin・相対 `.ts`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_DEV_DEPENDENCIES` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `pi.extensions` のエントリが配布物に含まれる | `test/ci/package-contents.test.ts` | `package.json` の `pi.extensions` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

## 変更時の手順

- 対象プロバイダを増やす場合は `test/contract/surface.test.ts` の期待値を先に更新する。
  契約が変更の入口になる。
- 再試行の条件・待ち時間・試行回数を変える場合は `test/unit/retry.test.ts` を先に更新し、
  対応する [docs/adr/](docs/adr/) を同じコミットで更新する。
- 設定キーを増やす場合は `test/unit/config.test.ts` を先に更新し、ADR と README の設定表を同じコミットで更新する。
  待ち時間は ADR 0002 のとおり固定に保つ。
- 依存を追加できるのは devDependency と、Pi が提供する peerDependency(`ALLOWED_PEER_DEPENDENCIES`)のみ。
  devDependency は `ALLOWED_DEV_DEPENDENCIES` を更新し、コミットメッセージに理由を残す。
  実行時依存(`dependencies`)の追加は不可。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、
  却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受けません。計測対象は `test/unit` と `test/integration` です。
- ドキュメントの段落内の改行は、文末(。！？)・読点(、)・コロン(:)の直後に置く。

## 手動確認項目(自動検証の対象外)

前提: 実際の `google` プロバイダと、無料枠のレート制限を使います。

1. 無料枠の `google/gemma-4-31b-it` で上限を超えるリクエストを送り、
   429 の後にサーバー指定時間 + 1秒(上限120秒)待って成功すること。
2. `RetryInfo` を含まない恒久的なクォータ枯渇では、待たずに失敗すること。
3. 待機中に Esc で中断すると `aborted` で終わり、再試行しないこと。
4. コンパクションが走る長いセッションで 429 が出ても、要約が同じ待ち・再試行で完了すること。
5. `retry.json` の `maxRetries` を変えて `/reload` し、次のリクエストから新しい回数で再試行されること。
6. 不正な値や壊れた JSON を書いても警告だけでセッションが続き、既定値で動くこと。
