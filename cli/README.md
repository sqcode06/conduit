# @sqcode/conduit

The command-line client for [CONDUIT](https://github.com/sqcode06/conduit) — upload
a file and hand someone a single-use download link, straight from your terminal.

```
$ conduit push report.pdf --expires 24h
✓ report.pdf (2.1 MB) → link ready

  https://conduit.example.com/d/9f3c…b21a
  max 1  ·  expires in 24h

✓ copied to clipboard
```

## Install

```bash
npm install -g @sqcode/conduit
# or run without installing:
npx @sqcode/conduit --help
```

Requires Node ≥ 20.

## Setup

CONDUIT's admin API sits behind Cloudflare Access, so the CLI authenticates with a
**Cloudflare Access service token** (the headless-friendly method):

1. In **Zero Trust → Access → Service Auth → Service Tokens**, create a token. Copy
   the **Client ID** and **Client Secret**.
2. On the CONDUIT Access application, add a policy: **Action: Service Auth**,
   include that service token.
3. Log in:

   ```bash
   conduit login
   # or non-interactively:
   conduit login --endpoint https://conduit.example.com \
     --client-id <id>.access --client-secret <secret>
   ```

4. Verify:

   ```bash
   conduit doctor
   ```

Credentials are stored at `~/.config/conduit/config.json` (mode `0600`). You can also
supply them via environment variables (handy for CI):

```
CONDUIT_ENDPOINT, CONDUIT_ACCESS_CLIENT_ID, CONDUIT_ACCESS_CLIENT_SECRET
```

## Commands

| Command | What it does |
| --- | --- |
| `conduit push <file>` | Upload a file and mint a link in one step |
| `conduit ls` | List uploaded files |
| `conduit link <file>` | Mint a link for an existing file (by id or name) |
| `conduit pulls` | Show recent downloads (`--watch` to live-tail) |
| `conduit qr [url]` | QR-code a URL, or the last minted link |
| `conduit rm <file>` | Delete a file and revoke its links |
| `conduit doctor` | Check config, connectivity, and auth |
| `conduit login` | Configure endpoint + service token |
| `conduit` | Interactive menu |

**Link options** (on `push` and `link`):

```
-e, --expires <dur>   TTL: 30m, 24h, 7d, or none   (default 24h)
-m, --max <n>         max downloads                (default 1)
-g, --grace <sec>     resume grace window          (default 0 = strict single-use)
    --qr              also print a QR code
    --no-copy         don't copy the link to the clipboard
    --no-link         (push) upload only, mint later
    --json            machine-readable output
```

## Scripting

Every read/write command supports `--json`, and exit codes are stable:

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | usage / bad argument |
| `2` | runtime / network error |
| `3` | missing or invalid config / auth |

```bash
# grab the URL of a freshly pushed file
url=$(conduit push build.zip --json | jq -r '.link.url')
```

## License

MIT © sqcode
