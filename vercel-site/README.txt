Deploy this whole folder to Vercel.
Structure must stay:
  index.html
  package.json
  api/visit.js
Then: Vercel -> Storage -> connect Upstash Redis -> Redeploy.
Check: https://YOUR-SITE.vercel.app/api/visit?debug=1  (should say "redis": "OK (connected)")
