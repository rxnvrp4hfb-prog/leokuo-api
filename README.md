# leokuo-api

Cloudflare Worker，正式網址預計 `https://api.leokuo.com`。

## API
- GET `/cpbl/health`
- GET `/cpbl/games`
- GET `/cpbl/games?date=2026-08-07`
- GET `/cpbl/games?first=0`
- GET `/cpbl/game?year=2026&kindCode=A&gameSno=222&status=2`
- GET/POST `/cpbl/reminders`
- POST `/cpbl/reminders/delete`
- POST `/cpbl/reminders/sent`

## Cloudflare
建立 Worker 並連 GitHub Repository `leokuo-api`。
Build command 留空；Deploy command `npx wrangler deploy`；Root directory 留空。
部署後先測試 `/cpbl/health`，再測 `/cpbl/games`。
最後在 Domains & Routes 新增 Custom Domain：`api.leokuo.com`。

## Reminder KV
若要永久保存提醒，建立 KV Namespace 並綁定 Variable name `CPBL_REMINDERS`。
不要把原本的 `reminders.json` 公開上傳到 GitHub。

## PDF
舊 Python 版用 pypdf 做 PDF 文字抽取；本 Worker 版目前不提供伺服器端 PDF 解析。CSV/TXT/JSON 匯入仍可用。


## Debug 版測試
部署後依序測試：
1. `https://api.leokuo.com/cpbl/health`
2. `https://api.leokuo.com/cpbl/debug`
3. `https://api.leokuo.com/cpbl/games`

`/cpbl/debug` 不會回傳 token 或 cookie 值，只顯示是否取得、cookie 名稱、HTTP 狀態與短版回應預覽。
