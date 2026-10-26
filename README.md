# CATFISH

> **Do the smallest web job that can possibly solve the problem.**
>
> 必要なのが「検索して、1ページ読む」だけなら、巨大なブラウザも、Visionも、LLMも、最初から起こさなくていい。

CATFISH は、AI agent のための **軽量なWeb実行基盤** です。

ブラウザを全部抱え込むのではなく、仕事を小さく分けます。

```text
URLが分かっている        → Fetch
URLを探す必要がある      → Search
画面操作が必要            → Local Browser
曖昧な判断まで必要        → Planner / LLM
```

**必要になるまで、高価で壊れやすい仕事を発生させない。**  
それがCATFISHの中心思想です。

---

## これは誰のためのもの？

CATFISHは、こんな人のために作っています。

- AI agent にWebを使わせたいが、毎回フルブラウザを起動したくない開発者
- 古いPC、小型端末、限られたRAM/CPUでもWeb能力を持たせたい人
- 回線、電力、計算資源、API料金をできるだけ無駄にしたくない人
- ChatGPT / Codex / Claude / 自作Workerから、まず安全な「検索と読む」を使いたい人
- 「できることを増やす」より **不要な仕事を消して速くしたい** 人

CATFISHは巨大な万能エージェントをもう一つ作るプロジェクトではありません。

**既に世界にある能力を、必要な瞬間だけ、最短経路で結ぶための薄い層**です。

---

## なぜ作るのか

想像してください。

午前2時。  
古いノートPCが1台。スマートフォンのテザリングは不安定。バッテリーも少ない。

必要なのは、自治体が公開した最新の給水所情報を探して、住所と時間を確認することだけ。

普通のWeb agentなら、ブラウザを起動し、ページを描画し、DOMを読み、場合によってはスクリーンショットを撮り、画像をモデルへ送り、そこからようやく数行の文字を取り出すかもしれません。

CATFISHなら、まず検索する。  
候補が見つかったら、そのページだけ読む。

それで答えが取れたなら、**そこで終わり**です。

CATFISH自身は救急サービスではないし、「これで命を救った」という実績を主張するものでもありません。

でも、切迫した状況ほど、

- 起動待ち
- 不要な通信
- 無駄な推論
- メモリ不足
- 壊れやすい自動操作

のような **本来なくてもよかった仕事** が邪魔になります。

CATFISHが目指しているのは、**人と必要な公開情報の間から、その無駄を一つずつ消すこと**です。

もしそれによって、誰かが必要な情報へ数秒でも早く、少ない電力で、弱い端末から到達できるなら、この設計には意味があります。

---

## いま何が使える？

CATFISHには2つの顔があります。

### 1. CATFISH Public — 誰でも使える読み取り専用MCP

公開エンドポイント:

```text
https://catfish-public.vercel.app/mcp
```

公開版が提供するのは、意図的にこの3つだけです。

| Tool | 役割 |
|---|---|
| `catfish_search` | 公開Webを検索し、正規化したURLを返す |
| `catfish_fetch` | 公開URLを読み、agent向けの軽量テキストへ変換する |
| `catfish_about` | CATFISHの能力と安全境界を説明する |

Searchは現在、providerを固定の前提にしません。  
ある検索経路が失敗すれば別経路へfallbackします。

Public版は **read-only** です。

### 2. CATFISH Local — 自分のマシンで使う強力版

Local版では、Public版に加えて以下が使えます。

- isolated browser sessions
- snapshot / click / fill / type / press / scroll
- screenshot
- persistent named profiles
- page-context JavaScript `eval`
- local CDP endpoint
- run evidence (`runs/<run-id>/events.jsonl`)

CDPやpersistent profileは強力すぎるため、Public版には出していません。

---

## 30秒で試す

### Public MCP

MCP clientにはこのendpointを登録します。

```json
{
  "mcpServers": {
    "catfish": {
      "type": "streamable-http",
      "url": "https://catfish-public.vercel.app/mcp"
    }
  }
}
```

基本の使い方は非常に単純です。

```text
1. URLを既に知っている → catfish_fetch
2. URLが分からない     → catfish_search
3. 上位数件だけ選ぶ     → 必要なものだけ catfish_fetch
```

**検索結果を全部Fetchしない** のもCATFISHの設計思想です。

### Local

```bash
git clone https://github.com/hopeless-t/catfish.git
cd catfish
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
```

HTTP service:

```bash
catfish --host 127.0.0.1 --port 28765
```

health check:

```bash
curl -s http://127.0.0.1:28765/health
```

MCP stdio server:

```bash
catfish-mcp
```

> Local HTTP service は意図的に `127.0.0.1` へbindします。  
> raw CDPはブラウザ全権限に近いため、そのまま外部公開しないでください。

---

## 渋川ルーティング — 仕事を増やさず、消す

CATFISHの判断順序はこうです。

```text
                 ┌─────────────┐
                 │ user / agent │
                 └──────┬──────┘
                        │
              URL already known?
                 ┌──────┴──────┐
                yes            no
                 │              │
               Fetch          Search
                 │              │
                 └──────┬───────┘
                        │
                 answer complete?
                 ┌──────┴──────┐
                yes            no
                 │              │
                END     deterministic browser
                                │
                         still ambiguous?
                                │
                              Planner
```

大事なのは、下へ行くほど「高機能」なのではなく、**仕事が重くなる**ということです。

だから常に一番上で終われる道を探します。

### CATFISHが消したいもの

- 読むだけなのにブラウザを起動する仕事
- DOMだけで足りるのにVisionへ画像を送る仕事
- deterministicに決められるのにLLMへ質問する仕事
- 同じページを何度も取得する仕事
- side effectを失敗したからといって無条件で再実行する仕事
- provider固有仕様をシステム全体の前提にしてしまう仕事

成功指標は「機能数」ではありません。

> **同じWebタスクを、より少ないCPU・RAM・通信量・token・待ち時間で、正しく完了できるか。**

---

## Failure policy

CATFISHは「とにかくリトライすれば成功」という思想を取りません。

- Search provider failure → 別providerへfallback可能
- Fetch / snapshot / get のようなsafe read → 条件付きretry可能
- click / fill / type / press のようなside effect → **自動再実行しない**

注文ボタンを2回押すより、「1回目が成功したか分からない」と正直に返す方を選びます。

失敗は隠さず、次の判断材料として残します。

---

## Safety boundary

Public版では次を禁止しています。

- localhost / private networkへのfetch
- persistent login profile
- JavaScript `eval`
- raw CDP
- browser click / form submission
- credentialの受け渡し

さらに、redirect先も再検証し、response size / redirect depth / timeoutに上限を設けています。

Public CATFISHは、CAPTCHAやログイン制限を回避するための仕組みではありません。

---

## Architecture

CATFISHはモデルを内蔵しません。

```text
ChatGPT / Codex / Claude / custom planner
                    │
                    │ MCP
                    ▼
                 CATFISH
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
        Search     Fetch    Local Browser
```

PlannerとExecutorを分けることで、Web能力を特定LLMへ固定しません。

Search providerもBrowser backendも、**交換可能なadapter** として扱います。

---

## Current status

### Local v0.3

- Search + provider fallback
- Fetch fast-path
- Browser sessions
- Browser actions
- persistent profiles
- CDP introspection
- evidence logs
- MCP stdio integration
- safe/non-safe retry separation

### Public v0.1

- Streamable HTTP MCP
- Search
- Fetch
- About
- private/local destination rejection
- redirect revalidation
- response-size limit
- timeout

CIとDependabotも有効です。

---

## What CATFISH is **not**

CATFISHは、

- 検索エンジンそのものではありません
- 巨大クラウドブラウザを再発明するものでもありません
- 万能AI agentでもありません
- 医療・救急・防災情報の正しさを保証するサービスでもありません

CATFISHは、**既存のWeb能力を、必要十分な仕事量で呼び出すための基盤**です。

---

## Development rule

CATFISHは実際に使いながら育てます。

```text
observe
  ↓
find the largest bottleneck / waste / bug
  ↓
ask whether that work is necessary at all
  ↓
remove / shorten / repair it
  ↓
measure again
```

「速くする」前に、**その仕事を0にできないか**を考えます。

ベンチマークで勝ったという主張は、測って再現できる数字が出てから書きます。

---

## A note for contributors

CATFISHへ機能を追加するときは、最初にこの質問をしてください。

> **それ、本当にCATFISH自身がやる必要がありますか？**

既存のOS、browser、network、MCP clientが既に上手くできるなら、CATFISHはそれを所有せず、薄くhandshakeする方を選びます。

小さく、交換可能で、観測可能であることを優先します。

---

## License

MIT License.  
Copyright (c) 2026 hopeless-t.

---

## One sentence

**CATFISHは、AIがWebで働くときに「やらなくていい仕事」をできるだけ発生させないためのWeb Workerです。**
