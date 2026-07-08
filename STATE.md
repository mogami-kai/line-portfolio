# STATE — line-portfolio

更新: 2026-07-08

## 現在地

- 本番運用中。**remote側で開発が活発に先行**（#28〜#41: 請求書内税化・3段階ロール再編・集計の職人別内訳・LINE投稿失敗の検知/再投稿など）。ローカルは45コミット遅れていた → 2026-07-08 rebaseで同期し、CLAUDE.md と app/richmenu.html を保全コミット＋push済み
- 既知問題: Vercel の GitHub webhook がデプロイを取りこぼすことがある（対処= ops/redeploy.md）

## 次の一手

1. **作業開始時は必ず `git fetch`**（このリポジトリは特にremoteが先行する）
2. リッチメニューの適用状況を確認: remote側の進行と app/richmenu.html / app/scripts/setup-richmenu.ts を突き合わせ、未適用なら 2500x843 画像書き出し→適用
3. 運用フィードバックの吸い上げ→改善バックログ整理

## 参照

- CLAUDE.md / REQUIREMENTS.md / ops/redeploy.md
