## gstack (lazy install)

gstack is auto-installed the first time you invoke a gstack skill
(/qa, /ship, /review, /investigate, /browse) in a session. The install is
handled transparently by `.claude/hooks/check-gstack.sh` and takes ~20s
the first time only.

**Do NOT check for gstack before starting work.** Normal coding (Edit, Write,
Bash, tests, builds, non-gstack skills like /verify, /code-review, /run)
does not require gstack and proceeds without overhead.

Use /browse for all web browsing once gstack is loaded.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

If the auto-install fails, install manually:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```
