# ABEL Photo Editor

A vanilla JavaScript, WebGL photo editor. Editing runs in the browser. Optional photo critique uses **Azure OpenAI**, **Gemini cloud**, **local Qwen vision through Ollama**, or **ChatGPT — Manual import**. All use a **resized JPEG of the current rendered edit**, current lighting/color slider values, and your intent. Azure forwards these to your Microsoft Azure OpenAI deployment; Gemini forwards them to Google; local mode sends them only to the loopback companion and its local Ollama runtime. Manual mode only prepares downloads: you upload to ChatGPT yourself. There is no automatic provider fallback.

## Three AI editing intensities, one review

Every review produces **Refine**, **Balanced** (default), and **Expressive**, each with independent **Global** and **Adaptive** recipes: six model-authored alternatives in one response, sharing one critique and rating of the reviewed image.

- **Refine:** conservative, preserve-first finishing.
- **Balanced:** perceptible, image-justified improvement that preserves the photograph's character.
- **Expressive:** a stronger, intentional interpretation of light and color—not multiplied slider values or random exaggeration.

All three protect artistic choices such as fog, haze, silhouettes and muted color; empty or identical recipes remain valid when changes are unwarranted. No intensity applies cropping, content manipulation, curves or destructive edits.

Choose an intensity before Review & apply, or inspect the saved suggestions before Apply in review-only/local/manual workflows. After application, tap **Refine | Balanced | Expressive** beside the photo. On mobile, **View photo · switch intensities** dismisses the drawer; **Review** brings it back. The photo controls also switch Global/Adaptive and strength. These actions make **no new model requests**. Hold the photo to compare against the same complete pre-review baseline and release to return; the intensity buttons never start comparison.

Switching replaces one AI history transaction, never stacks edits. Each choice starts from the frozen reviewed state and original masks; only that choice's new masks are added. **Undo restores the baseline; Redo restores the latest choice**, without flooding history. A no-change/0% selection retains a reversible baseline transaction so other saved choices remain available. Manual edits, mask modifications, a new source, an applied crop, changed intent/connection or provider clear the saved alternatives rather than overwrite your work. Already-applied edits remain. Alternatives live only in this tab's memory, not browser storage; reload needs another review.

The response shape now requires `variants: {refine, balanced, expressive}`. Old two-recipe responses are deliberately rejected with an update/re-export instruction, never expanded into invented intensities. Update/restart the backend with the frontend, then refresh open tabs and re-export older manual prompts.

## Azure OpenAI premium review

Select **Azure OpenAI — Premium cloud** in Review. This uses the same intent-first photographic critique and detailed image/region audit as Gemini, with independent Global and Adaptive recipes, adjustable strength, review-only or one-click application, full validation, one-step undo and comparison. The model proposes permitted lighting/color settings and approximate soft geometry; it does **not** generate replacement pixels or perform subject segmentation.

**Provisioned and verified September 17, 2026:** Azure uses the HTTPS backend at **https://abel-review-66c1d915.azurewebsites.net**, independently of your Mac. Select Azure, open its connection settings, paste the separate backend access token, and check the connection. Optionally enable Remember on a trusted browser; explicitly consent before requesting a review. The public default is configurable through the `abel-azure-review-endpoint` meta tag in `index.html`; it never contains a credential. A connection check reads configuration/authentication status only and makes no model request.

Resources are isolated in `abel-photo-review`:

| Resource | Configuration |
| --- | --- |
| `abel-photo-review-66c1d915` | Azure OpenAI S0, East US 2; `https://abel-photo-review-66c1d915.openai.azure.com/` |
| `abel-premium-gpt55` | GPT-5.5 `2026-04-24`, GlobalStandard, capacity 20 (20,000 TPM), no automatic version upgrade |
| `abel-review-66c1d915` | Linux Node 22 App Service, East US, HTTPS only, Azure-only credentials |
| `abel-review-free-windows` | **Linux F1 Free**, despite its historical name; one worker, no Always On |

GPT-5.5 was selected as a practical premium general vision/reasoning model after querying this subscription's actual GA catalog and unused quota, not as a measured universal “best.” Its image input, low reasoning and strict Chat Completions schema were verified with **one synthetic 640 × 400 JPEG**: HTTP 200, full contract validation, two adaptive regions, about 15 seconds. Azure metrics reported 6,010 prompt and 1,097 generated tokens. [Azure's retail meter API](https://prices.azure.com/api/retail/prices) reported East US 2 **5.5 ShortCo inp Gl** at **$5/M input**, **5.5 ShortCo opt Gl** at **$30/M output**, and cached input at **$0.50/M** (USD). That synthetic call is approximately **$0.063** at uncached retail rates, not an invoice or a typical-photo guarantee.

The active subscription reports `quotaId=MSDN_2014-09-01` and `spendingLimit=On`. This confirms an MSDN/Visual Studio offer, **not the exact $150 entitlement, remaining credit or every service's eligibility**. Visual Studio benefits are development/test only; do not use this as a production-service entitlement. Existing unrelated Azure resources also consume the subscription allowance. No payment method, offer upgrade or spending-limit removal was performed.

The model has no PTU/GPU reservation; this app's host is F1 Free, with cold starts, shared CPU/daily quotas and no uptime SLA. The ledger lives at persistent `/home/abel-azure-budget`, outside deployed files; restart persistence was checked. The hosted server limits requests to two/minute, one concurrent review and 100 dispatched attempts/UTC month. The six-recipe update uses a 12,000-token completion ceiling including reasoning: at most **$36 of output tokens per 100 attempts**, **plus input tokens and any other charges** at the verified rates. This is not a dollar or subscription-wide cap. Local direct Azure credentials are disabled in this installation to avoid a second independent allowance; the local editor selects the same hosted Azure default. Gemini, local Qwen and manual review remain separate.

### Reproducing or updating this deployment

`infra/azure.json` is the resource-group ARM template, including the pinned model, free Linux plan, HTTPS/TLS, disabled FTP/SCM basic authentication, Azure-only settings, server-side resource key lookup and persistent allowance. It never outputs credentials. It is not a code deployment and does not authenticate you or change your offer. Before using it elsewhere, authenticate Azure CLI, inspect the subscription/credit/model quota, and change globally unique names/regions as needed; do not upgrade to paid hosting if free-tier quota fails without reviewing costs.

For this existing installation, `.env.azure-hosted` is a gitignored, mode-0600 JSON settings file containing the **private backend access token and Azure key**. Never print it, upload it as public content, or include it in an archive. To reapply infrastructure without putting a secret in command arguments:

```sh
mkdir -p .azure-tools
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(".env.azure-hosted")); fs.writeFileSync(".azure-tools/deployment-parameters.json",JSON.stringify({reviewAccessToken:{value:c.REVIEW_ACCESS_TOKEN}}),{mode:0o600})'
az deployment group create -g abel-photo-review -n abel-review-infrastructure --mode Incremental \
  --template-file infra/azure.json --parameters @.azure-tools/deployment-parameters.json -o none
rm .azure-tools/deployment-parameters.json
git archive --format=zip --output=.azure-tools/abel-backend.zip HEAD package.json server js css index.html manifest.json
az webapp deploy -g abel-photo-review -n abel-review-66c1d915 \
  --src-path .azure-tools/abel-backend.zip --type zip --clean true --restart true -o none
```

Keep the same token when reapplying; rotate it deliberately if compromised and reconnect trusted browsers. On this Mac, copy only the backend token without printing it:

```sh
node -e 'const fs=require("fs"),cp=require("child_process");cp.execFileSync("pbcopy",{input:JSON.parse(fs.readFileSync(".env.azure-hosted")).REVIEW_ACCESS_TOKEN})'
```

Never delete `/home/abel-azure-budget` to reset usage, move it into `wwwroot`, run independently budgeted replicas/slots, or share the Azure resource key with browser clients. A stale guard lock fails closed and requires operator investigation, not automatic deletion. For a fresh deployment, generate a fresh random token and use the secure ARM parameter; the template retrieves the Azure resource key internally.

For a premium deployment, choose an actually available, generally available model with **image input, Chat Completions and strict structured outputs**. Microsoft’s [current model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure) documents GPT-5.4/5.5 and newer families, but published catalog presence is not subscription quota. Newest models may require higher quota tiers or approval. Confirm the deployment against [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/), not OpenAI's separate API prices or a guessed rate. The public pricing page can show `$-` without a resolved region/offer; that is **not free**. No universal “best” model or verified dollar rate is hardcoded.

Use only **Standard or GlobalStandard pay-per-token** capacity with low TPM, never PTU/provisioned capacity, dedicated GPUs or auto-upgrades. Verify whether your [$150 Visual Studio benefit](https://azure.microsoft.com/en-us/pricing/member-offers/credit-for-visual-studio-subscribers/) is the active offer: such credits have service exclusions and development/test restrictions. Do not remove the subscription spending limit, attach payment, or assume production eligibility.

Configure all four `AZURE_OPENAI_*` settings in the private server `.env` (see `.env.example`): resource endpoint, exact deployment name, actual model name and resource API key. The stable `/openai/v1/chat/completions` API is fixed in the server; no arbitrary client upstream URLs or preview API version are used. The endpoint must be an HTTPS `*.openai.azure.com` resource origin without credentials, paths, queries or redirects. Keys never enter public JavaScript, responses or browser storage. Keep `.env` owner-readable only (`chmod 600 .env`).

Set a strong random `REVIEW_ACCESS_TOKEN` even for localhost Azure use. The browser receives only the backend URL and this separate access token, **not** the Azure resource key. Cloud connection preferences are stored separately as `abel.azure-connection.v1` and `abel.gemini-connection.v1`; switching providers never copies credentials. Remember is opt-in and unencrypted browser storage is readable by site scripts. Changing connections, forgetting in another tab, cancelling, switching providers or withdrawing consent invalidates pending results.

### Budget and hosting safeguards

- Azure defaults to **100 dispatched attempts per UTC calendar month** and **12,000 maximum completion tokens including reasoning** (configurable ceiling 16,000). GPT-5 models request low reasoning; unsupported temperature/max_tokens parameters are not sent. Compact six-recipe instructions target at most 6,000 visible output tokens, leaving reasoning headroom. A fixed system prompt, 600-character intent, 34 allowed current controls and a single EXIF-stripped JPEG capped at 1280 × 1280 bound the input. The Azure timeout is 120 seconds. Raising this ceiling increases the worst-case cost; it does not raise the monthly attempt guard.
- The existing authenticated backend has process-wide rate/concurrency controls shared by both cloud providers. For a personal credit deployment, set `REVIEW_RATE_LIMIT=3`, `REVIEW_RATE_WINDOW_MS=60000` and `REVIEW_CONCURRENCY=1`. Spoofed forwarding/IP headers do not bypass these controls. For multiple users, put real per-user authentication and shared rate enforcement in front of the server; do not publish a shared access token.
- The private `.azure-budget` ledger reserves an attempt **before** dispatch and retains it after failures, cancellation or restart. It uses an exclusive cross-process lock and atomic file replacement; unavailable/corrupt storage or an occupied lock rejects the request. A crash can leave a stale `lock` directory: stop every instance and inspect/reconcile the monthly ledger before removing **only the stale lock**. Never delete/reset the ledger to bypass the allowance.
- All instances must share the **same persistent private budget directory**. Do not deploy this file-backed guard on ephemeral Functions/Container Apps storage or separately scaled replicas. A suitable single-instance persistent CPU host or transactional shared budget store is required before cloud hosting. No GPU, monitoring service, hosting resource or public unsecured endpoint is created by this code.
- This is a hard **application attempt limit**, **not a $150 Azure account-wide spending cap**. Calculate the allowance from the actual model's input/output/image/reasoning rates, leave room for hosting and other services, and retain Azure's credit spending limit. Alerts alone do not stop charges. Other applications or direct API calls can bypass ABEL's allowance.

`GET /api/review/azure/status` returns only `provider`, configured model, key-configured flag, authorization status, token requirement and monthly request allowance. `POST /api/review/azure` requires the backend token, exact allowed origin, bounded JSON and a valid preview. Refusals, truncation, tool calls, duplicate JSON keys, unsupported edits and out-of-range masks are rejected without applying changes or contacting another provider.

For Pages, connect the **actual HTTPS backend base URL** and allow exactly `https://abrahamyesgat.github.io` (no `/lumiedit` path) in `ALLOWED_ORIGINS`. Pages itself cannot host this Node backend. A desktop companion can also be connected explicitly; phones cannot reach your Mac through `localhost`. Upload consent explicitly identifies Microsoft Azure and links its processing/retention terms.

Validation requires no Azure key or paid calls:

```sh
node --test test/review-azure.test.js test/review-ui.test.js test/review-server.test.js test/review-prompt.test.js
# With an existing Playwright/Chromium installation:
REVIEW_PROVIDER=azure PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-gemini-review.cjs
```

The browser check uses only synthetic canvas pixels and intercepted responses on desktop/mobile, including consent, isolated restoration, adaptive pixel placement, crop coordinates, mask caps, undo and comparison. Before marking a real deployment ready, run one small synthetic JPEG + strict-schema request against the selected deployment and verify its usage/meter; mocked tests do not prove Azure access.

## ChatGPT manual review (no backend or API)

Works on the static website (including GitHub Pages), on phones, and locally. No Node server, Ollama, API key, API credits, or ABEL account connection is needed for this path.

1. Load/edit a photo, open **Review**, select **ChatGPT — Manual import**, and optionally describe your aesthetic intent.
2. Click **Export for ChatGPT**. Save the source-named `_ChatGPT.jpg`: a JPEG of the **current rendered composite**, including curves and existing masks, resized to at most 1280 pixels per axis and re-encoded without original EXIF. It is not the untouched original. **Download preview again** retries a blocked download.
3. **Copy prompt** or **Download prompt** (`_ChatGPT_prompt.txt`). The complete selectable prompt remains visible if clipboard access is unavailable/denied. It contains the shared intent-first critique, current slider values/intent, exact required JSON schema, control bounds, and independent Global/Adaptive rules. Regional coordinates refer to the current displayed image: top-left `(0,0)`, x rightward, y downward.
4. Open ChatGPT yourself with your existing account. Attach the matching JPEG and paste the complete prompt (or attach the prompt text file). Ask it to return the structured JSON review, **not to generate/edit an image**. ABEL never opens a session, reads login cookies, automates ChatGPT, uploads files, or makes an API call in manual mode.
5. Keep the ABEL tab and edit unchanged. Paste ChatGPT's **complete JSON response** and click **Import review JSON**. A single complete Markdown JSON code fence is accepted, but surrounding prose, partial JSON, duplicate members (including escaped aliases), unsupported keys, missing fields, nonfinite/out-of-range numbers, and invalid regions are rejected. Input is capped at 256 KiB before parsing. Errors never apply edits; correct the full response and retry against the same unchanged export.
6. Choose **Global** or **Adaptive**, inspect suggestions and strength, then **Apply changes**. Import does not auto-select or auto-apply. The same normal strength, one-step undo/redo, and before-review comparison controls are used. Empty recipes are valid.

Every export clears the previous proposal. Changing source, dimensions, sliders, curves, masks, intent, or provider invalidates the export; refreshing the page requires re-export. Switching providers cancels pending work but does not undo edits already applied. Use only ChatGPT's response for the matching files: ABEL can enforce an unchanged export baseline but cannot attest which image an external conversation reviewed.

If mobile pasting replaced JSON string delimiters with paired directional **“smart quotes”**, use **Fix smart quotes & import**. This explicit, local-only option converts structural pairs outside straight-quoted strings, preserving balanced nested smart-quoted prose, apostrophes and JSON escapes. It never guesses mixed/unpaired quote boundaries or repairs other syntax, missing fields or unsupported recipes. The complete result must pass the same 256 KiB limit, duplicate-member checks and recipe validation before replacing the textarea with corrected JSON and importing. Failed repair leaves the pasted text unchanged. Standard Import remains strict; both require the unchanged exported photo and never automatically Apply.

Your ChatGPT plan/model must support image input. Upload, message, model-access and file limits vary and may interrupt this workflow; an existing paid subscription is **not unlimited and does not include API credits**. No particular tier or quota is promised. Only your deliberate manual upload sends the image, intent and prompt to ChatGPT, under your account's data controls and service terms. Downloaded filenames may identify the source; review files before sharing. ABEL retains manual review context only in tab memory, never localStorage or the server; downloaded files and ChatGPT conversations have their own lifetime. Applied edits still follow the editor's normal library persistence behavior.

## Local development

Use **Node.js 22 or newer for supported production hosting**. Local development and tests also work on Node.js **20.17+**. There are no npm dependencies or build steps; the server loads `.env` if present using Node's built-in environment loader.

```sh
cp -n .env.example .env
# For cloud review only, set GEMINI_API_KEY to your own server-side Gemini API key.
npm start
```

Open `http://localhost:3000`. The server binds to `127.0.0.1` by default and serves only explicitly allowlisted app assets. Without a Google key, editing and configured local Qwen review still work; cloud review returns an honest “not configured” error, never a simulated critique.

For Gemini, open **Photo review**. The backend URL fills with this server's origin (blank still means this server), the editable intent defaults to preserving the scene's existing mood, and the action defaults to **Review & apply Global**, at 100% strength. These are convenience defaults, not an inference about the photographer's intent. Choose **Global** or **Adaptive** and strength **before** requesting. After explicit upload consent, a single **Review & apply** click gets the critique and applies only that validated alternative as one undoable edit. There is no second Apply click and the alternatives never stack. Choose **Review only — inspect before applying** for the optional older inspect/Apply workflow. Local Qwen and manual ChatGPT still require separate selection and Apply.

**Connection autofill:** **Check Gemini connection** reads only the backend's safe status: configured model, whether a server key exists, and whether this request satisfies backend authentication. It sends no photo and makes no Google call; it does not prove quota or generation access. Check **Remember Gemini connection on this browser** to save the verified URL and optional backend access token after a successful check or validated review. It is **off by default**. Reload restores that connection with the token hidden, but never restores upload consent, sends a request, or applies edits. **Forget / change Gemini connection** removes it; unchecking Remember removes persistence while keeping credentials available for this tab. Browser-storage failures are reported. Like the local connection feature, the token is unencrypted and readable by scripts on this website origin: avoid shared devices. No image, intent, review, API key, action preference or consent is saved by this connection feature.

GitHub Pages cannot discover or run a Gemini backend. On first use there, enter your **actual** HTTPS backend URL and its `REVIEW_ACCESS_TOKEN`, or explicitly configure a running desktop companion. ABEL does not guess a remote URL or probe a local machine on page load. A Gemini API key stays on the server and is never returned to or stored by the browser; the separate Qwen token cannot substitute for the Gemini backend token. On the same-origin companion, no token is needed unless `REVIEW_ACCESS_TOKEN` is configured. Upload consent always remains an explicit checkbox, even with saved credentials.

The **Review** tab is available on desktop and in the mobile bottom navigation. Review is subjective advice, not an objective image-quality measurement. Global slider values are **absolute targets**, not deltas. Each intensity's Adaptive has its own global base plus up to three soft regional masks. Crop is advice only; no crop, retouching, objects, curves or detail controls are changed. Pending slider edits are retained before the transaction. **Undo review** or toolbar undo restores prior global settings and mask pixels/count; toolbar redo restores the latest selected recipe. Changed source, dimensions, sliders, curves, masks, intent, action, intensity, strength or connection invalidate pending work. Cancel, revoked consent, provider switching, stale responses, errors and invalid JSON never trigger automatic application. Empty/zero-strength choices never substitute another recipe. There is no provider fallback or automatic request on reload/provider switch.

**Adaptive limitations:** these are model-positioned, feathered radial ellipses and linear gradients, **not semantic segmentation** or precise subject outlines. Placement/quality is not guaranteed; spill and overlap are possible. The prompt now requires actual image landmarks, extent checks, image-left/right orientation, radii (not bounding-box dimensions), gradient direction and spill checks, and omission of uncertain or outline-dependent regions. Gemini receives an additional detailed image audit within the existing schema/response budget, without a second model call or stronger edits. This improves instructions, not a measured guarantee of model localization accuracy. Rendered pixel tests verify the geometry mapping across portrait, landscape, cropped images and the 4096-pixel mask cap. Each proposed region has a thumbnail map on the reviewed image: ellipse center and zero-effect edge, or gradient 0%/100% endpoints. Existing masks remain unchanged. New regions add their lighting/color difference to the existing composite. Inspect the maps, reasons, offsets and result. The **Masks** panel exposes names, reasons, sliders, overlay and deletion; drag on the image to redraw geometry.

Strength can be chosen before applying and changed afterward beside the photo: 0% changes nothing and creates no new masks; 50% interpolates global targets from the frozen review baseline and halves regional offsets; 100% uses the full selected recipe. It does not shrink or harden masks. Changing intensity, Global/Adaptive or strength replaces the previous AI transaction without requesting a review. Hold the photo or **Hold to see before review** to compare against the complete pre-review composite (including old masks); release to return. Comparison also works after redo unless another edit invalidates it. PNG/JPEG/WebP and scaled export include the mask composite and never export the held comparison. Library sidecars/IndexedDB retain region names, reasons, blending and bitmap masks. Cropping still clears masks because dimensions change; undoing the crop restores its prior masks. Crop redo remains unsupported.

Touch and hold the photo for 350 ms to see **Before review** immediately after applying; release to return to the edit, including when releasing outside the control. At other times, holding shows the original lighting/color of the current source (not uncropped framing). The desktop Compare button and backslash key also show original lighting/color. Movement, scrolling, cancellation, switching tools, or leaving the window ends comparison. Crop and mask gestures take priority. On mobile, the review drawer leaves the photo visible above it; swipe only its top handle to dismiss, not the scrollable feedback. Adjustment strength and Apply scroll naturally with the review content; they never float over the feedback.

```sh
npm test
curl http://localhost:3000/api/review/status
# {"configured":true,"model":"gemini-3.6-flash","authorized":true,"tokenRequired":false}
```

Tests use `node:test` and mocked Gemini/Ollama responses: **no API key, running Ollama, network access to providers, or paid requests required**.

With an already-installed Playwright/Chromium, run `PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-gemini-review.cjs` for desktop/mobile UI and pixel checks. It starts an isolated loopback server, intercepts synthetic Gemini responses, blocks outside requests, and verifies autofill/privacy, one-click adaptive application, region maps, actual targeted pixels, cropped coordinates, mask caps, undo and comparison. It does not use `.env`, real photos, API keys or provider quota.

Run `PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-intensity-review.cjs` for one-request/six-recipe desktop/mobile regression: exact repeat pixels, frozen existing masks/curves, independent global targets, strength, Undo/Redo, outside-drawer controls, genuine hold/release and manual-edit invalidation. `BASE_URL` can check deployed static assets; all inference responses remain intercepted.

## Local Qwen vision (Ollama)

Install a current [Ollama](https://ollama.com/download) release supporting Qwen3-VL, image input, `think:false`, and structured JSON output. Run the runtime **on this computer**, with cloud disabled and one parallel generation. Quit any existing Ollama service before starting an independently configured instance; setting variables on Node does not reconfigure an already-running Ollama process.

```sh
OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_HOST=127.0.0.1:11434 ollama serve
# In another terminal, explicitly download the local model once:
ollama pull qwen3-vl:2b-instruct
# Start the companion in this repository (or persist these settings in your .env):
QWEN_MODEL=qwen3-vl:2b-instruct PORT=4178 npm start
curl http://127.0.0.1:4178/api/review/local/status
# {"provider":"ollama","model":"qwen3-vl:2b-instruct","ready":true,"localOnly":true}
```

The general default is `qwen3-vl:4b-instruct`, but **choose `qwen3-vl:2b-instruct` on an Intel x86_64 Mac with 8 GB RAM and constrained disk space**. Use the explicit Instruct tag: the plain `:2b` tag resolves to a Thinking variant and may spend its output budget on reasoning before producing a critique. CPU-only inference can be very slow, especially the first request; allow several minutes and close memory-heavy applications. Even the smaller model is not a guarantee of sufficient free memory. Larger allowed models (`:8b-instruct`, `:30b-instruct`, `:32b-instruct`) require substantially more memory; an allowed name does not guarantee availability. Bare size tags remain supported for existing configurations. No cloud tags, arbitrary aliases, or upstream URLs are accepted.

The six-recipe response increases local `num_ctx` to **16,384** and `num_predict` to **6,144**, with thinking disabled and compact shared critique/recipe instructions. The former 8k-context/4k-output budget is insufficient for reliable six-recipe completion. This costs more memory and CPU time; a small CPU model may still fail or time out. Truncated, missing-intensity or out-of-bounds responses are rejected, never completed with guessed/scaled recipes or retried on a cloud provider. Gemini retains its 8,192 output-token ceiling; Azure separately reserves reasoning headroom as documented above.

Select local Qwen mode in Photo review and grant local-mode consent. When the app is served from loopback, its local endpoint defaults to that origin; from a deployed website, it defaults to `http://127.0.0.1:4178`. Match the companion's `PORT` to the URL, or enter its actual loopback URL explicitly (the server's general port default is still `3000`). The companion uses **only** `http://127.0.0.1:11434`; it never forwards a Gemini key or either access token to Ollama. Reviews do not auto-pull models. Status and each review inspect `/api/tags` and `/api/show` for the exact installed model, Qwen3-VL architecture, vision capability, and remote/cloud metadata. Cloud-backed aliases are rejected before sending the image. Keep `OLLAMA_NO_CLOUD=1` set on the runtime as defense in depth; metadata checks cannot attest that an operator-controlled runtime has not been modified.

Local routes require a loopback configured host, actual loopback listener/address, and loopback requester socket (including IPv4-mapped IPv6). Forwarding headers cannot override this. **Do not publish or reverse-proxy the local routes**. A non-loopback companion cannot be enabled with `LOCAL_REVIEW_ENABLED=true`.

### From a deployed desktop website

GitHub Pages can use local review **directly from the desktop browser to a running companion on that same desktop**. Neither Pages nor a hosted backend proxies the image to your Mac. Ollama and the Node companion must both be running. Configure the companion:

```dotenv
HOST=127.0.0.1
PORT=4178
LOCAL_REVIEW_ENABLED=true
QWEN_MODEL=qwen3-vl:2b-instruct
LOCAL_REVIEW_ACCESS_TOKEN=your-separate-long-random-local-token
ALLOWED_ORIGINS=https://your-name.github.io
```

Generate a strong random token, restart the companion after configuration changes, and enter that token in the **local** token field, not the cloud token field. Use the website's exact origin, without a repository path or trailing slash. Any other loopback port is also cross-origin and needs both an exact allowed origin and a configured local token. Both local status and review require the bearer token cross-origin; a cloud `REVIEW_ACCESS_TOKEN` never substitutes for it. Trusted same-companion-origin browser calls work without entering a token even when one is configured; the token is never embedded in HTML or returned by status. Same-origin browser GETs that omit Origin are recognized by browser-controlled `Sec-Fetch-Site: same-origin`; `same-site` is not sufficient. Originless clients without that browser metadata require the token when configured, and work without it when absent. This origin-based usability exemption is not authentication against other local programs, which can forge an Origin header; it protects cross-origin browser access, not a compromised desktop.

**Remember the local connection:** leave **Remember on this browser** checked, paste the local access token once, and choose **Check local connection** (no photo is sent). Only a successful ready-companion check or valid local review saves the loopback endpoint and local token in this website origin's `localStorage`. The token field then disappears behind **Saved on this browser**, and refreshes/new tabs restore Local Qwen without granting consent or sending requests. Uncheck to use credentials in this tab only. **Forget / change connection** clears the stored and in-memory local token without changing your photo, applied edits, or masks; changing the local URL also clears it so a saved token cannot silently move to another port. Re-enter a rotated token using this action. Browser-storage failures are shown explicitly; use browser site-data settings if clearing is blocked.

This convenience stores the local token unencrypted in browser storage, accessible to scripts on this website origin. Use only a trusted personal browser, not a shared device. Clearing site data or private-browsing storage removes the connection. No image, editing intent, recipe, Gemini key, or cloud access token is saved by this feature. Local authentication and exact-origin/loopback restrictions remain required; a remembered token does not enable automatic review, upload, or cloud fallback. Same-origin companion use still needs no local token. Any other loopback port is also cross-origin and needs both an exact allowed origin and a configured local token. Both local status and review require the bearer token cross-origin; a cloud `REVIEW_ACCESS_TOKEN` never substitutes for it. Trusted same-companion-origin browser calls work without entering a token even when one is configured; the token is never embedded in HTML or returned by status. Same-origin browser GETs that omit Origin are recognized by browser-controlled `Sec-Fetch-Site: same-origin`; `same-site` is not sufficient. Originless clients without that browser metadata require the token when configured, and work without it when absent. This origin-based usability exemption is not authentication against other local programs, which can forge an Origin header; it protects cross-origin browser access, not a compromised desktop.

Your browser may prompt for **local-network access**, and browser/OS policies may block HTTPS-to-loopback requests. Allow access only for a trusted site. The companion permits exact-origin CORS preflights and, when requested, Private Network Access preflights **only for the local routes**; preflights cannot send a bearer token. Actual calls still require authentication. This does not bypass browser permissions, mixed-content restrictions, enterprise policy, or CORS. If the browser blocks it, use the app served by the local companion rather than disabling security.

On iOS/iPhone, `localhost` is **the phone**, not your Mac. A Pages app on a phone cannot reach the Mac through this loopback-only provider. Do not expose Ollama/companion on the LAN to work around that restriction. For Gemini access without a running desktop companion (including normal phone use), deploy a separate HTTPS Node backend.

On the same desktop, Gemini can also use this running companion: explicitly enter its loopback URL in the **cloud** backend field and configure its server-side Gemini key, exact allowed website origin and **`REVIEW_ACCESS_TOKEN` (required for cross-origin Gemini use)**. Enter that token in the Gemini connection field, not the local token. Browser local-network permission may be required; private-network preflight is permitted for an allowed origin only when the companion has a configured Gemini token. This still sends review data to Google and requires cloud consent; it is not local inference. A local Qwen token never substitutes for the cloud token.

## Hosting and GitHub Pages

GitHub Pages serves static files; **it cannot run this Node server or keep an API key secret**. The existing Pages deployment continues to publish the browser app, not a functioning review API. For cloud review independent of a desktop companion, run `server/index.js` on a separate Node-capable host and enter its HTTPS base URL in the review panel. The UI also accepts a URL ending in `/api/review`; desktop users may instead connect a loopback companion as described above.

Example backend environment (set through your host's secret/environment settings, not a committed file):

```dotenv
HOST=0.0.0.0
PORT=3000
GEMINI_API_KEY=your-private-google-key
GEMINI_MODEL=gemini-3.6-flash
REVIEW_ACCESS_TOKEN=your-long-random-private-access-token
ALLOWED_ORIGINS=https://your-name.github.io
```

- Put the backend behind **HTTPS/TLS**. The built-in server is HTTP; use your hosting platform or a TLS reverse proxy. Never expose the bare HTTP port publicly.
- A non-loopback `HOST` **requires** `REVIEW_ACCESS_TOKEN` at startup. Use a strong random secret (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). Also set it when a public reverse proxy forwards to a loopback listener.
- Share this access token only with authorized users and enter it in the review panel. It travels as `Authorization: Bearer …`, is not a Gemini key, and stays in tab memory unless the user explicitly opts in to **Remember Gemini connection on this browser**. Never place either credential in a URL, HTML/JS, Pages configuration, or a GitHub Actions build artifact.
- `ALLOWED_ORIGINS` is a comma-separated **exact** origin list, including scheme and nondefault port when needed. No `*`, paths, trailing slashes, `null`, or wildcard subdomains. For a project Pages URL, use `https://your-name.github.io`, not `https://your-name.github.io/repository`.
- CORS is not authentication. Non-browser callers can omit `Origin`; the access token remains mandatory when configured. Cloud preflights and cloud status do not require the token. **Local status is separately authenticated**, as described above. Unallowed origins are rejected before provider work.
- Loopback servers additionally accept the actual bound port on `localhost`, `127.0.0.1`, and `[::1]`. Production/public browser origins must be explicitly listed. Host and forwarding headers are never trusted to authorize an origin.
- Deploy only public app assets to a static host. The Pages workflow stages only `index.html`, `manifest.json`, `css/`, and `js/`; backend files, tests, and environment files are excluded. **Never commit credentials or generate them into public assets**. `.gitignore` is not a substitute for deployment secret management.
- The minimal shared-token service is suited to private/small deployments. For a public multi-user product, add proper user authentication, per-user quotas, shared rate limiting across instances, billing controls, abuse monitoring, and applicable privacy/consent policies.
- At the reverse proxy, also cap request bodies and connection counts, enforce request timeouts, and disable request/response-body and authorization-header logging. Keep API responses uncached.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Server-only provider secret; missing disables cloud review only. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Operator-selected Gemini image + structured-JSON model. Clients cannot choose a model. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP bind address and port. |
| `REVIEW_ACCESS_TOKEN` | empty | Required for non-loopback hosting and cross-origin Gemini on a loopback companion; optional same-origin local bearer authentication. |
| `ALLOWED_ORIGINS` | empty | Exact additional browser origins. |
| `REVIEW_RATE_LIMIT` | `10` | Review attempts per process-wide fixed window. |
| `REVIEW_RATE_WINDOW_MS` | `60000` | Window duration in milliseconds. |
| `REVIEW_CONCURRENCY` | `2` | Maximum simultaneous request-body/provider operations. |
| `REVIEW_TIMEOUT_MS` | `30000` | Provider deadline, including reading its response; aborts on timeout. |
| `LOCAL_REVIEW_ENABLED` | automatic | `true` on loopback, `false` on public bind; explicit `true` on a public bind is rejected. |
| `QWEN_MODEL` | `qwen3-vl:4b-instruct` | Local `qwen3-vl` sizes `2b`, `4b`, `8b`, `30b`, `32b`, with optional `-instruct` suffix (recommended). |
| `LOCAL_REVIEW_ACCESS_TOKEN` | empty | Separate local bearer token; required cross-origin, including status. Trusted companion-origin browser calls are exempt; originless clients need it when configured. |
| `LOCAL_REVIEW_TIMEOUT_MS` | `600000` | Local deadline in milliseconds, including upload, metadata, generation, and response reading; maximum `900000`. |

The browser resizes Qwen previews to at most **768 pixels** on either axis, versus **1280 pixels** for Gemini. This reduces local image processing load without changing the shared server contract. The browser's local deadline is 910 seconds so the server's configurable deadline (600 seconds by default, at most 900) normally supplies the actionable timeout error first.

Cloud rate limits apply globally, not by spoofable IP headers; invalid admitted cloud requests also consume an attempt. They reset on process restart and are not shared across replicas. Local work has an independent single slot (including status); it does not consume Gemini request quota or cloud concurrency. Set `OLLAMA_NUM_PARALLEL=1` on Ollama itself. Local generation uses temperature `0.2`, context `8192`, output limit `4096`, `stream:true`, and `think:false`. The companion uses native HTTP only for the fixed loopback Ollama endpoint, without following redirects. Its abort signal enforces `LOCAL_REVIEW_TIMEOUT_MS` across both waiting for headers and reading the stream; Node fetch's separate five-minute headers/idle limit does not apply. Streaming alone cannot avoid that limit because CPU prompt/image processing may exceed five minutes before the first token. This is separate from Ollama's model-loading timeout and does not make inference faster or guarantee completion on low-memory hardware. The browser still receives only a complete, validated JSON review, never partial adjustments.

The server accepts at most 2 MiB of request JSON, at most 1,400,000 decoded image bytes, and a JPEG frame no larger than 1280 pixels on either axis. JPEG encoding, segment/frame/scan structure and dimensions are validated; this is not a full image decompressor. Gemini responses and local metadata are capped at 256 KiB. The local NDJSON transport allows 2 MiB including per-token envelopes, with individual lines and assembled review content capped at 256 KiB. Truncated streams and unexpected data after completion are rejected. There are no automatic provider retries.

The application server does not write image, intent, response, key, or token logs or persist uploads. Bodies exist in memory during processing; Google and your hosting/proxy infrastructure have their own processing and retention policies. Canceling aborts an in-progress provider request where possible but cannot retract content already received by Google or guarantee no quota usage.

## API and shared contract

`js/review-prompt.js` is the single public, secret-free critique prompt shared by browser/manual, Gemini and Qwen (`server/prompt.js` re-exports it). `js/review-json.js` similarly supplies duplicate-member rejection to both browser and server (`server/json.js` re-exports it). `js/review-manual.js` builds the complete manual bundle and parses bounded pasted JSON through the existing contract; it has no network or storage code. These public modules are served by the local static allowlist and included by Pages' `js/` staging.

`js/review-contract.js` exposes the same `ReviewContract` UMD object in browsers and CommonJS:

- `controls`: 34 `{label,min,max,step}` definitions: exposure (−5…5, step 0.01); contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation (−100…100, step 1); and `hslHue_0…7`, `hslSat_0…7`, `hslLum_0…7` (−100…100, step 1).
- `maskControls` retains the seven Refine control definitions; `regionalControls(intensity)` returns the applicable bounds. Refine: exposure ±0.75, tonal ±20, color ±15. Balanced: ±1.25 / ±30 / ±25. Expressive: ±2 / ±45 / ±35. Tonal means contrast/highlights/shadows; color means temperature/tint/saturation. **For each key the sum of absolute offsets across that recipe's regions is bounded by the same maximum**, limiting overlap as well as each mask. Global+regional values for additive AI masks are clamped to renderer slider limits. HSL, clarity, dehaze, sharpening and detail are forbidden in regions. `MAX_REGIONS` is 3 per Adaptive recipe.
- `readAdjustments(state)`: reads the basic fields and nested `hslHue`, `hslSat`, `hslLum` arrays into a complete flat allowlisted map. HSL order is red, orange, yellow, green, aqua, blue, purple, magenta.
- `validateRequest(value)` / `validateReview(value)`: return independent validated data or throw `Error`. No silent clamps or numeric coercion. Slider values must be finite and within range; step sizes guide recommendations/UI rather than rejecting interpolated current values.
- `reviewSchema`: full closed JSON schema. `server/schema.js` derives the Gemini-compatible version: required fields, closed objects, key enums, and numeric bounds remain; string/array size limits become descriptions to avoid provider schema-complexity rejection. Both runtime validators still enforce every size limit, key-specific range, and duplicate check.

`GET /api/review/status` returns exactly `{configured:boolean, model:string, authorized:boolean, tokenRequired:boolean}` under the existing origin checks. `configured` means a server key is present, not that a live provider call has verified it. `authorized` checks the supplied Gemini backend bearer token and cross-origin token requirement; it never grants consent. `tokenRequired` identifies first-time setup needs without disclosing a token. No API key, token, remote URL or provider response is disclosed, and this endpoint does not call Google or consume generation quota.

`GET /api/review/local/status` returns exactly `{provider:"ollama", model:"qwen3-vl:4b-instruct", ready:true, localOnly:true}` after live installed-model checks (the model reflects configuration). Failure returns only `{error:string, code:string}`, never a misleading ready result or secret. `POST /api/review/local` uses the **same request and successful response contracts** as cloud review below, but authenticates with `LOCAL_REVIEW_ACCESS_TOKEN`, uses the full `ReviewContract.reviewSchema`, and has no fallback. Ollama output must have `done:true`, `done_reason:"stop"`, strict JSON content and no tool calls; truncation and invalid output are rejected before any adjustments can be applied.

`POST /api/review` accepts `Content-Type: application/json`, with exactly:

```js
{
  image: "canonical base64 JPEG, without a data: prefix",
  adjustments: ReviewContract.readAdjustments(currentState),
  intent: "optional aesthetic intent, at most 600 characters"
}
```

All three fields are required; empty intent is allowed. All 34 current adjustments are required. There are no URL, model, crop, tool, or arbitrary settings fields.

Successful responses have exactly:

```js
{
  rating: 8,
  summary: "A warm scene with gentle contrast.",
  inferredIntent: {
    genre: "Environmental portrait",
    interpretation: "The image appears intended to feel intimate. Warm light and quiet surroundings support that reading.",
    intentionalTraits: ["Warm palette", "Dark background"]
  },
  categories: [
    { name: "Composition", score: 8, feedback: "The surrounding space gives the subject context." },
    { name: "Light / exposure", score: 8, feedback: "Gentle directional light keeps the subject readable." },
    { name: "Color / tone", score: 8, feedback: "Warm tones support the mood." },
    { name: "Technical execution", score: 8, feedback: "No materially harmful defect is visible at this preview size." },
    { name: "Moment / story / impact", score: 8, feedback: "The quiet presentation supports an intimate mood." }
  ],
  strengths: ["Gentle contrast."],
  improvements: [],
  cropFeedback: "The current framing works.",
  portfolioVerdict: { label: "Portfolio worthy", reason: "Light, color, and framing support a coherent intent." },
  variants: {
    refine: {
      adjustments: [], // Global; a valid preserve-first no-change recipe
      adaptive: { adjustments: [], regions: [] }
    },
    balanced: {
      adjustments: [{ key: "hslSat_1", value: -5, reason: "Keep orange tones subtle." }],
      adaptive: {
        adjustments: [], // OWN global base, never added to the Global alternative
        regions: [{
          name: "Soft central light",
          reason: "A broad lift around the center; may spill beyond the subject.",
          geometry: { type: "radial", x: 0.5, y: 0.5, width: 0.3, height: 0.4, endX: 0, endY: 0, feather: 1 },
          adjustments: [{ key: "exposure", value: 0.25, reason: "Gently lift the center." }]
        }]
      }
    },
    expressive: {
      adjustments: [{ key: "temperature", value: 12, reason: "Interpret the scene as warmer evening light." }],
      adaptive: {
        adjustments: [{ key: "temperature", value: 8, reason: "Lean into the warm atmosphere." }],
        regions: []
      }
    }
  }
}
```

Ratings/scores range from 0 to 10. Summary is at most 1,200 characters. All five category names above are required exactly once; feedback is at most 600 characters each, and validation restores the canonical display order. `inferredIntent` requires a genre up to 80 characters, an interpretation up to 600, and up to six distinct intentional traits of 160 characters. Strengths/improvements each have at most three distinct strings of 400 characters. Crop feedback is a nonempty string up to 600 characters. `portfolioVerdict` requires a label from `Portfolio standout`, `Portfolio worthy`, `Borderline`, or `Not portfolio-ready`, plus a reason up to 400 characters.

`variants` has exactly the required keys `refine`, `balanced`, `expressive`, each containing exactly `adjustments` and `adaptive`. Each global array has at most six unique allowed keys, absolute in-range targets, and nonempty reasons up to 400 characters. Required `adaptive` contains its own global `adjustments` and `regions` arrays (both may be empty). Each region requires a distinct name (up to 80 characters), reason (up to 400), geometry, and 1–4 unique regional adjustments. Regional values are offsets from zero, bounded by intensity both individually and in aggregate. Prompt writing limits are intentionally shorter than validation maxima to fit six complete recipes in one response. No existing-mask IDs or arbitrary actions are accepted.

All geometry numbers are finite in [0,1], measured against the **current displayed image**, origin top-left. `radial`: `x,y` are the center, `width,height` are radii relative to image width/height (each at least 0.05), `feather` is 0.5–1, and `endX=endY=0`. `gradient`: `x,y` mark the black/no-effect end, `endX,endY` the white/full-effect end, normalized endpoint distance is at least 0.2, `width=height=0`, and `feather=1`. The transition spans the entire endpoint distance. Browser code maps these to the actual mask canvas dimensions (capped at 4096 pixels on the longest side), not preview pixels. There are no polygons, hard subject outlines, or model-controlled canvas sizes.

Empty alternatives mean “no major lighting or color edit needed”; empty improvements displays “No major issue identified.” Unknown fields, missing intensities, duplicate JSON members/adjustments/categories/list entries, invalid numbers, degenerate/hard geometry, unsupported controls, excessive masks, malformed output, refusal, and truncation are rejected by the server and again in the browser, including before application. Providers share the base prompt/schema; Gemini and Azure additionally receive the bounded detailed audit. An explicit cloud **Review & apply** click authorizes the captured selection after validation. Manual ChatGPT imports and local Qwen reviews remain review-first. Refresh an already-open editor after updates; older two-recipe responses are deliberately rejected with an update/re-export instruction, not silently converted.

Errors return `{error:string, code:string}`, never raw Google/Ollama responses. `error` is a safe user-facing message. Expected statuses include 400 invalid request, 401 missing/wrong access token, 403 origin denied or local disabled, 408 request-body timeout, 413 oversized request, 415 wrong media type, 422 provider refusal, 429 capacity/provider quota, 502 invalid output/provider/network failure, 503 missing/unavailable configuration or Ollama runtime/model problems, and 504 provider timeout. Rate-limit errors include `Retry-After`. Local-specific codes include `local_token_required`, `local_unauthorized`, `local_disabled`, `local_unavailable`, `local_runtime_error`, `local_model_missing` (with the exact `ollama pull` command), `local_model_invalid`, `local_model_remote`, `local_model_no_vision`, `local_busy`, and `local_timeout`. Cancellation or deadline aborts local upstream work and releases the slot; a runtime may take time to stop already-running inference.

The prompt treats image text and user intent as untrusted, preserves photographic intent rather than always brightening, and acknowledges this custom renderer is not identical to Lightroom. Refine retains conservative guidance (normally ≤0.75 exposure, ≤20 tonal controls, ≤15 basic color, ≤10 HSL hue, ≤15 HSL saturation/luminance). Balanced and Expressive independently consider stronger image-justified directions, normally within 1.25/30/25 and 2/45/35 exposure/tonal/color changes respectively, without forced minimums. Runtime validators enforce absolute global slider bounds and intensity-specific regional/overlap bounds; global relative-change guidance and visual quality are not guaranteed.

### Fixed intent-first critique rubric

`server/prompt.js` hardcodes the critique instructions, not canned feedback or fixed scores. Both providers first identify a likely genre, tentative visual intent, and potentially intentional traits. They then assess composition, light/exposure, color/tone, technical execution, and moment/story/impact against that intent. Fog, snow, haze, silhouettes, negative space, motion blur, unusual perspective, and non-neutral color/exposure are not automatic defects. A technical criticism must identify visible, material harm; focus, noise, clipping, and print-detail claims must respect preview limitations.

The score anchors are 9-10 exceptional/strong portfolio, 8-8.9 very strong/portfolio candidate, 7-7.9 good, 6-6.9 competent but limited, 5-5.9 average/unresolved, and below 5 significant photographic failure. Subtle or unconventional styles do not alone justify a score below 5. Scores and portfolio judgments remain subjective: there is no forced grade distribution or deterministic score-to-verdict conversion. The label `Not portfolio-ready` avoids calling every unsuccessful image “good.” Genre and intent are hypotheses, not excuses for unsuccessful choices.

The rubric asks for up to three genuine strengths, three prioritized improvements with tradeoffs, and normally no more than six justified lighting/color changes. Crop advice must name the problem it solves and the useful context it would lose, not merely enlarge a subject. An internal consistency check asks the model not to praise an artistic choice and then undo it without justification. Crop remains advice only; no-change outcomes are encouraged when appropriate. Server and browser validation enforce the editing allowlist independently of the critique text. Changing the rubric requires a server restart; it does not change either configured provider model.

## Gemini model, free tier, and privacy

The default is [`gemini-3.6-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash). In September 2026, Gemini's generation endpoint rejected `gemini-2.5-flash` for new users and recommended this replacement, even though metadata lookup for the older model still succeeded. If an existing `.env` specifies the old model, update `GEMINI_MODEL` and restart the server. A successful metadata/status request does not prove generation access. The UI distinguishes model unavailability from API-key authentication and permission errors, without exposing raw provider responses.

Availability and model lifetimes can change; operators should recheck [model capabilities](https://ai.google.dev/gemini-api/docs/models), [structured output](https://ai.google.dev/gemini-api/docs/structured-output), and [pricing](https://ai.google.dev/gemini-api/docs/pricing) before deployment. Select an image-input, structured-JSON-compatible model available to your account.

“Free tier” does **not** mean unlimited or guaranteed free operation: quotas vary by model, account/project, tier and region, and change over time. Review current [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and your AI Studio project limits. Quota exhaustion returns 429. An active billing project may incur charges; set appropriate budgets/quotas and do not enable billing assuming every call will remain free.

Under Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms), unpaid-service inputs and outputs may be used to improve Google products and may be reviewed by humans. **Do not send sensitive, confidential, or personal information to unpaid services**, including private photos, identifiable people, or embedded private text. Obtain all necessary rights and consent. Paid-service handling differs and still includes limited retention for safety/legal purposes; review the actual terms rather than assuming zero retention.

Check [available regions](https://ai.google.dev/gemini-api/docs/available-regions) and age/use restrictions. Current terms require users to be 18+, describe professional/business rather than consumer use, and require **Paid Services when making API clients available to users in the EEA, Switzerland, or UK**. Separate regional data-use rules also apply. Do not assume that a model's advertised free tier authorizes every deployment or audience.
