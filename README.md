# App Store Net Proceeds Calculator

A single static page that shows what you receive from an App Store purchase in each of Apple's 175 storefronts, after the taxes contained in the customer price and Apple's commission.

Everything is in `index.html`: no build step, no backend, no dependencies.

## 1. Open it

Double-click `index.html`, or:

```sh
open index.html
```

It works offline. With a network connection it also refreshes the exchange rates used for the USD column.

## 2. Load the full Apple price data

Out of the box the page contains Apple's localized prices for five US price points ($3.99, $5.99, $9.99, $29.99, $39.99), taken from public copies of App Store Connect API responses. Every other price point shows the US price only and marks the other storefronts as unavailable.

Apple publishes the full price matrix only through the App Store Connect API, so loading it needs your own API key. The script sends read-only `GET` requests and writes nothing to your account.

### Create an API key (once)

1. Open [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** → **App Store Connect API**.
2. Under **Team Keys**, click **+**, name it, and give it the **App Manager** role.
3. Download the `AuthKey_XXXXXXXXXX.p8` file. Apple lets you download it once. Keep it outside this folder, for example in `~/.appstoreconnect/private_keys/`.
4. Note the **Key ID** (next to the key) and the **Issuer ID** (above the key list).

The account needs at least one app. For subscription prices it needs one subscription, and for In-App Purchase prices one In-App Purchase; if there is no In-App Purchase the script uses the paid-app price points, which share the same ladder.

### Run the script

Needs Node 18 or newer (`node -v`).

```sh
cd appstore-proceeds-calculator

export ASC_ISSUER_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export ASC_KEY_ID="XXXXXXXXXX"
export ASC_PRIVATE_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8"

# quick check first: two price points, nothing written
node scripts/fetch-apple-prices.mjs --only=9.99,39.99 --dry-run

# full run: about 1,500 requests, 15 to 25 minutes
node scripts/fetch-apple-prices.mjs --update-tax
```

The full run rewrites the data blocks inside `index.html` (the file grows to roughly 2 MB) and prints how many price points were loaded. Reload the page afterwards.

Responses are cached in `.asc-cache/`, so an interrupted run continues where it stopped. If some price points fail, the script keeps going, writes what it has, and tells you how many are missing; run the same command again to fetch only those. Delete the cache folder before a later refresh, otherwise the cached prices are reused.

`--update-tax` matters because a few tax rules depend on your own developer account. Vietnam is the known case: Apple deducts a different amount for individual and organization developers, so the rule shipped in the page may not match your account until the script refits it from your proceeds.

### Options

| Option | Effect |
|---|---|
| `--model=subscription` or `--model=iap` | Fetch one ladder only (default: both) |
| `--only=9.99,39.99` | Fetch only these US price points |
| `--max-usd=200` | Skip US price points above this amount |
| `--app=ID`, `--subscription=ID`, `--iap=ID` | Use these products instead of auto-discovery |
| `--update-tax` | Rewrite tax rules that no longer match the proceeds Apple reports |
| `--dry-run` | Fetch and report, but leave `index.html` untouched |
| `--out=path`, `--cache=dir`, `--concurrency=2` | Output file, cache folder, parallel requests |

At the end the script compares the page's tax rules with the proceeds Apple just reported and lists every storefront that no longer matches. That list is how you find out about a tax change. Re-run with `--update-tax` to rewrite the simple cases, or edit the `data-tax` block by hand.

### If it fails

- **401**: wrong Issuer ID, Key ID or key file, or the key was revoked.
- **403 on the first requests**: the key's role cannot read pricing. Use App Manager or Admin.
- **403 partway through a run** ("The API key in use does not allow this request" after hundreds of successful requests): Apple is throttling the key. The script retries each request for about two minutes, skips what still fails and stops asking after six failures in a row. Wait a few minutes and run the same command again, with `--concurrency=1` if it repeats.
- **404 on a price-point request**: pass the product explicitly with `--subscription=ID` or `--iap=ID` (the numeric Apple ID shown in App Store Connect).
- **429**: rate limit. The script waits and retries by itself; lower `--concurrency` if it keeps happening.

Start with the `--dry-run` command above; it makes about 16 requests and writes nothing.

## 3. Publish on GitHub Pages

GitHub Pages on a free account needs a public repository. The page contains no secrets, and `.gitignore` already excludes `.p8` keys and the cache.

```sh
cd appstore-proceeds-calculator
git init -b main
git add .
git commit -m "App Store Net Proceeds Calculator"

gh repo create appstore-proceeds-calculator --public --source=. --push
gh api -X POST "repos/{owner}/appstore-proceeds-calculator/pages" \
  -f "source[branch]=main" -f "source[path]=/"
```

The last command turns Pages on. You can do the same in the browser: repository **Settings** → **Pages** → **Deploy from a branch** → `main`, folder `/ (root)` → **Save**.

After a minute the page is live at:

```
https://<your-github-username>.github.io/appstore-proceeds-calculator/
```

To publish new data later:

```sh
rm -rf .asc-cache
node scripts/fetch-apple-prices.mjs
git commit -am "Refresh Apple price data" && git push
```

## 4. Where the numbers come from

The data lives in five JSON blocks near the end of `index.html`, separate from the calculation code and the UI:

| Block | Contents | Updated by |
|---|---|---|
| `data-storefronts` | 175 storefronts: name, region, currency, decimals | script (currency) |
| `data-prices` | US price points and Apple's localized price for each | script |
| `data-tax` | Tax contained in the customer price, per storefront | by hand, or `--update-tax` |
| `data-commission` | Standard and reduced commission, plus regional rates | by hand |
| `data-fx` | Fallback exchange rates for the USD column | by hand; refreshed live in the browser |

The calculation for one purchase:

```
tax-exclusive amount = customer price / (1 + tax contained in the price)
Apple commission     = tax-exclusive amount × commission rate
developer proceeds   = tax-exclusive amount × (1 − commission rate)
```

A few storefronts (United Kingdom, Italy, Spain, Kenya, Uruguay, China mainland) carry an extra levy tied to Apple's commission. In the United States and Canada sales tax is added at checkout, so nothing is removed from the price.

The tax rules were derived from the per-unit proceeds Apple's API reported on 2026-06-17 and reproduce all 2,284 values in that snapshot. They were then updated with Apple's tax announcement of 2026-08-27 (Morocco, Republic of the Congo, Tanzania).

Commission rates as of 2026-10-01: 30% standard and 15% reduced worldwide; 26% and 15% in the European Union and Japan; 25% and 12% in China mainland.

Limits worth knowing:

- Results are estimates of per-unit proceeds. Apple's Financial Reports are the authority for settled amounts.
- Tax rules assume the default "App Store software" tax category and a developer based outside the storefront country.
- The USD column uses current market exchange rates from [ExchangeRate-API](https://www.exchangerate-api.com), not Apple's settlement rate.
- The price snapshots for Israel, Indonesia, Morocco and the Republic of the Congo predate Apple's 2026-09-14 price update; the page tags those rows "check" until you run the script.
